import { Effect } from "effect"
import { Database } from "@/effect/database"
import * as DriveAccess from "./drive-access.server"
import { developmentBypassEnabled } from "./config"
import { developmentUser } from "./development-bypass"

// Development stacks only (MEDIABINDER_ENVIRONMENT=dev, NODE_ENV not
// production). scripts/migrate.ts runs `prepare` after the migrations, and
// only then; nothing on a production path calls it.
//
// The developer is the workspace owner and a superuser when nobody owns the
// workspace yet, as the first Google sign-in would be. A real Google account
// can still sign in on the same stack as a regular user, because the dev
// env sets ALLOW_SIGNUPS=true (without it, an owned workspace refuses new
// accounts). The `user` row exists because every table references user.id.

const FALLBACK_FOLDER_NAME = "Development folder"
const FOLDER_ID = /^[A-Za-z0-9_-]{10,128}$/

export const ensureUser = Effect.fn("Development.ensureUser")(function* () {
  const database = yield* Database
  yield* database.transaction("development.ensureUser", (tx) =>
    Effect.gen(function* () {
      yield* tx.execute(
        `INSERT INTO user(id,name,email,emailVerified,image,createdAt,updatedAt,role)
         VALUES (?,?,?,TRUE,NULL,NOW(3),NOW(3),'user')
         ON DUPLICATE KEY UPDATE name=VALUES(name),email=VALUES(email)`,
        [developmentUser.id, developmentUser.name, developmentUser.email]
      )
      yield* tx.execute(
        "UPDATE workspace SET owner_id=? WHERE id=1 AND owner_id IS NULL",
        [developmentUser.id]
      )
      yield* tx.execute(
        "UPDATE user SET role='superuser' WHERE id=? AND EXISTS (SELECT 1 FROM workspace WHERE id=1 AND owner_id=?)",
        [developmentUser.id, developmentUser.id]
      )
    })
  )
})

/**
 * Links `folderId` for the developer through the service account, and queues
 * one initial sync. Safe to repeat: the link is an upsert, and the sync is
 * queued only while this user has never had one requested. The folder's name
 * is never logged or put on a span.
 */
export const linkFolder = Effect.fn("Development.linkFolder")(function* (
  folderId: string
) {
  const database = yield* Database
  const name = yield* DriveAccess.serviceAccountToken().pipe(
    Effect.flatMap((token) => DriveAccess.getFolder(token, folderId)),
    Effect.map((folder) => folder.name),
    Effect.catch(() =>
      Effect.logWarning(
        "Could not read the development folder from Drive; using a neutral name"
      ).pipe(Effect.as(FALLBACK_FOLDER_NAME))
    )
  )
  yield* database.execute(
    "development.linkFolder",
    "INSERT INTO drive_folder(user_id,folder_id,folder_name) VALUES (?,?,?) ON DUPLICATE KEY UPDATE folder_name=VALUES(folder_name)",
    [developmentUser.id, folderId, name]
  )
  // The one initial sync: the claim is atomic, so a worker and a web
  // container preparing at once, or a later restart, queue it only once. The
  // worker picks the job up from drive_sync_state like any other.
  yield* database.execute(
    "development.syncState",
    "INSERT INTO drive_sync_state(user_id) VALUES (?) ON DUPLICATE KEY UPDATE user_id=user_id",
    [developmentUser.id]
  )
  const claim = yield* database.execute(
    "development.queueInitialSync",
    "UPDATE drive_sync_state SET requested=1,next_attempt=NOW(3) WHERE user_id=? AND requested=0",
    [developmentUser.id]
  )
  const queued = claim.affectedRows === 1
  yield* Effect.annotateCurrentSpan("mediabinder.sync_queued", queued)
})

/** What a dev stack needs once the schema exists. A no-op outside dev. */
export const prepare = Effect.fn("Development.prepare")(function* (
  env: Record<string, string | undefined> = process.env
) {
  if (!developmentBypassEnabled(env)) return
  yield* Effect.logWarning(
    "MEDIABINDER_ENVIRONMENT=dev: Skip login for development is enabled. Never use this for a deployment."
  )
  yield* ensureUser()
  const folderId = env.MEDIABINDER_DEV_FOLDER_ID?.trim()
  if (!folderId) return
  if (!FOLDER_ID.test(folderId))
    return yield* Effect.logWarning(
      "MEDIABINDER_DEV_FOLDER_ID is not a Drive folder ID; no folder linked"
    )
  if (!DriveAccess.sharedFolderMode())
    return yield* Effect.logWarning(
      "MEDIABINDER_DEV_FOLDER_ID needs a Drive service account key; no folder linked"
    )
  yield* linkFolder(folderId)
})
