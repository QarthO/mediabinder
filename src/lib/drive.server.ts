import { Cause, Clock, Deferred, Effect, Exit, Metric } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import { randomUUID } from "node:crypto"
import type { DatabaseSession, LockedSession } from "@/effect/database"
import * as Drive from "@/effect/drive-api.server"
import {
  DriveAccessError,
  LockBusyError,
  ValidationError,
  type DatabaseError,
  type DriveApiError,
  type DriveReconnectError,
} from "@/effect/errors"
import type { AppServices } from "@/effect/runtime.server"
import { isExpectedAppError } from "@/observability/error-policy"
import * as Telemetry from "@/telemetry"
import { resolve, transaction, withUserLock } from "./catalog.server"
import { sharedFolderMode } from "./drive-access.server"
import {
  claim,
  start as startSyncRun,
  status as syncRunStatus,
  type SyncProgress,
} from "./sync-progress.server"
import type { SyncRun } from "./types"
import {
  detectCodecs,
  saveCodecs,
  type CodecUpdates,
} from "./video-codecs.server"

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  createdTime: string
  size?: string
  imageMediaMetadata?: { width?: number; height?: number; time?: string }
  videoMediaMetadata?: {
    width?: number
    height?: number
    durationMillis?: string
  }
  parents?: string[]
  sha256Checksum?: string
  thumbnailLink?: string
  // Limited-access folder: it doesn't inherit its parent's sharing.
  inheritedPermissionsDisabled?: boolean
}
// The sync is one unit of work, so it has a span; pages and files are
// numerous, so they are counted instead. Attributes never carry folder or
// file names.
const syncedFiles = Metric.counter("mediabinder.sync.files", {
  description:
    "Files seen by Drive syncs: `found` while scanning (once per distinct file), `saved` once the catalog commit succeeded",
  attributes: { unit: "{file}" },
  incremental: true,
})

const syncDuration = Metric.histogram("mediabinder.sync.duration", {
  description:
    "Time a Drive sync ran, by outcome: succeeded, failed, busy (another sync held the user's lock) or interrupted",
  attributes: { unit: "s" },
  boundaries: [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800],
})

const folderSets = Metric.counter("mediabinder.sync.folder_sets", {
  description:
    "Sets driven by Drive subfolders during syncs: `created` or `adopted` sets, and `joined` file memberships added",
  attributes: { unit: "{set}" },
  incremental: true,
})

const countFolderSets = (
  outcome: "created" | "adopted" | "joined",
  count: number
) =>
  count > 0
    ? Metric.update(Metric.withAttributes(folderSets, { outcome }), count)
    : Effect.void

const countFiles = (state: "found" | "saved", count: number) =>
  Metric.update(Metric.withAttributes(syncedFiles, { state }), count)

const isUserLockBusy = (error: unknown): error is LockBusyError =>
  error instanceof LockBusyError && error.lock.startsWith("drive:")

const syncOutcome = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return "succeeded"
  if (Cause.hasInterruptsOnly(exit.cause)) return "interrupted"
  return isUserLockBusy(Cause.squash(exit.cause)) ? "busy" : "failed"
}

export type SyncFailure =
  | DatabaseError
  | LockBusyError
  | ValidationError
  | DriveAccessError
  | DriveApiError
  | DriveReconnectError

export type SyncOptions = {
  headers?: Headers
  token?: string
  origin?: SyncRun["origin"]
  // Runs once the Drive lock is held and the progress row exists.
  onStarted?: (run: SyncRun) => Effect.Effect<void>
}

/**
 * Syncs one user's Drive folders into the catalog while holding that user's
 * Drive lock. Scanning Google takes no catalog lock; the catalog is only
 * reconciled once every page was read, so a failed scan keeps what the
 * catalog already holds. The run row records the outcome with the same
 * user-facing text as ever.
 */
export const sync = Effect.fn("Drive.sync")(function* (
  userId: string,
  options: SyncOptions = {}
): Effect.fn.Return<{ count: number }, SyncFailure, AppServices> {
  yield* Effect.annotateCurrentSpan("mediabinder.user_id", userId)
  const startedAt = yield* Clock.currentTimeMillis
  return yield* Effect.gen(function* () {
    const token =
      options.token ?? (yield* Drive.readToken(userId, options.headers))
    return yield* withUserLock(userId, (session) =>
      Effect.gen(function* () {
        const sources = yield* session.queryRows<RowDataPacket>(
          "SELECT folder_id FROM drive_folder WHERE user_id = ?",
          [userId]
        )
        if (!sources.length)
          return yield* new ValidationError({
            message: "Choose a Google Drive folder in settings first.",
          })
        const run = yield* startSyncRun(
          session,
          userId,
          options.origin ?? "automatic"
        )
        if (options.onStarted) yield* options.onStarted(run.started)
        const folderIds = sources.map((source) => source.folder_id as string)
        return yield* Effect.gen(function* () {
          const scan = yield* scanFolders(
            session,
            userId,
            token,
            folderIds,
            run.report
          )
          // Video codecs are read from Drive here, before the catalog
          // transaction opens, so it never waits on Google.
          const codecs = yield* detectCodecs(session, userId, token, [
            ...new Map(
              [...scan.sourceFiles.values()].flat().map((f) => [f.id, f])
            ).values(),
          ])
          const result = yield* reconcile(
            session,
            userId,
            folderIds,
            scan,
            codecs,
            run.report
          )
          yield* run.succeed(result.count)
          return result
        }).pipe(
          // An interrupt is the process stopping, not a failed run: the row
          // stays "running" and SyncProgress.status reports it as interrupted
          // once the Drive lock is gone.
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : run.fail(Cause.squash(cause))
          )
        )
      })
    )
  }).pipe(
    Effect.onExit((exit) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((finished) =>
          Metric.update(
            Metric.withAttributes(syncDuration, { outcome: syncOutcome(exit) }),
            (finished - startedAt) / 1000
          )
        )
      )
    )
  )
})

/**
 * Manual sync: resolves once the run has started and keeps syncing in the
 * background, in this request's trace. Joining an in-flight run (for example a
 * webhook sync) is not an error: the caller simply watches that run instead.
 */
export const startSync = Effect.fn("Drive.startSync")(function* (
  userId: string,
  headers: Headers
) {
  yield* Effect.annotateCurrentSpan("mediabinder.user_id", userId)
  const token = yield* Drive.readToken(userId, headers)
  const started = yield* Deferred.make<SyncRun, SyncFailure>()
  // Detached: the sync outlives this request. It keeps the request's trace
  // through the context it inherits, and `ensuring` makes sure the caller is
  // never left waiting if the sync stops before it started.
  yield* sync(userId, {
    token,
    origin: "manual",
    // Completed from the sync's own session: waiting for another pool
    // connection here could stall while every connection runs a sync.
    onStarted: (run) => Effect.asVoid(Deferred.succeed(started, run)),
  }).pipe(
    Effect.asVoid,
    Effect.catchCause((cause) =>
      Deferred.isDone(started).pipe(
        Effect.flatMap((begun) =>
          begun
            ? reportBackgroundFailure(userId, cause)
            : Deferred.failCause(started, cause)
        ),
        Effect.asVoid
      )
    ),
    Effect.ensuring(Deferred.interrupt(started)),
    Effect.forkDetach
  )
  return yield* Deferred.await(started).pipe(
    Effect.catch((error: SyncFailure) =>
      isUserLockBusy(error)
        ? joinRunningSync(userId, error)
        : Effect.fail(error)
    )
  )
})

// The run row already holds the user-facing error; this is for operators.
const reportBackgroundFailure = (
  userId: string,
  cause: Cause.Cause<unknown>
) => {
  const error = Cause.squash(cause)
  return isExpectedAppError(error)
    ? Effect.logWarning("Background Drive sync failed").pipe(
        Effect.annotateLogs({
          "mediabinder.user_id": userId,
          "error.type": error instanceof Error ? error.name : typeof error,
        })
      )
    : Telemetry.logException(cause, {
        operation: "Drive.sync",
        attributes: { "mediabinder.user_id": userId },
      })
}

// Another sync holds the lock. If its run is still going the caller watches
// it, and the run now belongs to them.
const joinRunningSync = Effect.fnUntraced(function* (
  userId: string,
  busy: LockBusyError
): Effect.fn.Return<SyncRun, SyncFailure, AppServices> {
  yield* Effect.ignore(claim(userId))
  const current = yield* syncRunStatus(userId).pipe(
    Effect.orElseSucceed(() => null)
  )
  if (current?.status === "running") return current
  return yield* busy
})

const unopenable = () =>
  new DriveAccessError({
    code: "not-allowed",
    message:
      "MediaBinder can't open a linked folder. Share it with MediaBinder's sync account in Google Drive, then sync again.",
  })

// A file's outermost subfolder under one linked folder. Files directly in the
// linked folder have none.
type Placement = { folderId: string; folderName: string; fileId: string }
// A subfolder seen under a linked folder, with the folder it was listed in.
type FolderNode = { id: string; parentId: string; name: string }
type Scan = {
  sourceFiles: Map<string, DriveFile[]>
  // By linked folder: every subfolder the scan listed, so a file's parent
  // folder can be shown as a path from its linked folder.
  nodes: Map<string, FolderNode[]>
  // By linked folder. Each linked folder is computed on its own, so a subfolder
  // that is also linked, or reachable from two linked folders, pairs
  // independently under each.
  placements: Map<string, Placement[]>
}

type Page = { files: DriveFile[]; nextPageToken?: string }

/**
 * Lists every linked folder's media, following subfolders and result pages,
 * and returns the files by linked folder. Pages and folders are counted in
 * the run's progress and the sync metrics, not as spans.
 */
const scanFolders = Effect.fn("Drive.scanFolders")(function* (
  session: DatabaseSession,
  userId: string,
  token: string,
  folderIds: string[],
  report: (progress: Partial<SyncProgress>) => Effect.Effect<void>
) {
  yield* Effect.annotateCurrentSpan(
    "mediabinder.sync.folders",
    folderIds.length
  )
  const sourceFiles = new Map<string, DriveFile[]>()
  const placements = new Map<string, Placement[]>()
  const nodes = new Map<string, FolderNode[]>()
  const found = new Set<string>()
  let foldersScanned = 0
  const shared = sharedFolderMode()
  // In shared-folder mode the service account reads for every user, and a
  // user's access was only checked on the linked folder. A limited-access
  // subfolder (one that doesn't inherit the parent's sharing) may be readable
  // by MediaBinder through a separate share while this user can't open it in
  // Drive, so only its owner syncs it through the parent; anyone else links it
  // directly.
  let email: string | null | undefined
  const ownsFolder = Effect.fnUntraced(function* (id: string) {
    if (email === undefined) {
      const [user] = yield* session.queryRows<RowDataPacket>(
        "SELECT email FROM user WHERE id=?",
        [userId]
      )
      email = user?.email?.toLowerCase() ?? null
    }
    if (!email) return false
    const folder = yield* Drive.json<{ owners?: { emailAddress?: string }[] }>(
      token,
      `files/${id}`,
      { fields: "owners(emailAddress)", supportsAllDrives: "true" }
    )
    return Boolean(
      folder.owners?.some(
        (owner) => owner.emailAddress?.toLowerCase() === email
      )
    )
  })
  for (const folderId of folderIds) {
    // Drive lists an unshared folder as empty rather than failing, and shows a
    // limited-access folder's metadata without its contents. In shared-folder
    // mode, check that MediaBinder can list it first so the run fails
    // (preserving the catalog) instead of hiding its media.
    if (shared) {
      const root = yield* Drive.json<{
        capabilities?: { canListChildren?: boolean }
      }>(token, `files/${folderId}`, {
        fields: "id,capabilities(canListChildren)",
        supportsAllDrives: "true",
      }).pipe(Effect.mapError(unopenable))
      if (root.capabilities?.canListChildren !== true)
        return yield* unopenable()
    }
    // Each pending folder carries the first-level subfolder it sits under.
    const pending: { id: string; top?: { id: string; name: string } }[] = [
        { id: folderId },
      ],
      visited = new Set<string>(),
      files: DriveFile[] = [],
      placed: Placement[] = [],
      tree = new Map<string, FolderNode>()
    while (pending.length) {
      const { id: parent, top } = pending.shift()!
      if (visited.has(parent)) continue
      visited.add(parent)
      let pageToken = ""
      do {
        const page: Page = yield* Drive.json<Page>(token, "files", {
          q: `'${parent}' in parents and trashed = false and (mimeType contains 'image/' or mimeType contains 'video/' or mimeType = 'application/vnd.google-apps.folder')`,
          fields: `nextPageToken,files(id,name,mimeType,createdTime,size,parents,sha256Checksum,imageMediaMetadata,videoMediaMetadata${shared ? ",inheritedPermissionsDisabled" : ""})`,
          pageSize: "1000",
          supportsAllDrives: "true",
          includeItemsFromAllDrives: "true",
          ...(pageToken ? { pageToken } : {}),
        })
        const before = found.size
        for (const file of page.files) {
          if (file.mimeType === "application/vnd.google-apps.folder") {
            if (
              !shared ||
              !file.inheritedPermissionsDisabled ||
              (yield* ownsFolder(file.id))
            ) {
              pending.push({
                id: file.id,
                top: top ?? { id: file.id, name: file.name },
              })
              if (!tree.has(file.id))
                tree.set(file.id, {
                  id: file.id,
                  parentId: parent,
                  name: file.name,
                })
            }
          } else {
            files.push(file)
            if (top)
              placed.push({
                folderId: top.id,
                folderName: top.name,
                fileId: file.id,
              })
            found.add(file.id)
          }
        }
        pageToken = page.nextPageToken ?? ""
        yield* countFiles("found", found.size - before)
        yield* report({ files_found: found.size })
      } while (pageToken)
      yield* report({ folders_scanned: ++foldersScanned })
    }
    sourceFiles.set(folderId, files)
    placements.set(folderId, placed)
    nodes.set(folderId, [...tree.values()])
  }
  return { sourceFiles, placements, nodes } satisfies Scan
})

/**
 * Replaces the user's availability and folder membership with what the scan
 * found, in one catalog transaction on the Drive lock's connection. Only runs
 * after every Drive page succeeded; failures preserve the catalog.
 */
const reconcile = Effect.fn("Drive.reconcile")(function* (
  session: LockedSession,
  userId: string,
  folderIds: string[],
  { sourceFiles, placements, nodes }: Scan,
  codecs: CodecUpdates,
  report: (progress: Partial<SyncProgress>) => Effect.Effect<void>
) {
  yield* Effect.annotateCurrentSpan("mediabinder.user_id", userId)
  const files = [
    ...new Map(
      [...sourceFiles.values()].flat().map((file) => [file.id, file])
    ).values(),
  ]
  yield* Effect.annotateCurrentSpan("mediabinder.sync.files", files.length)
  yield* report({ phase: "saving", files_total: files.length, files_saved: 0 })
  yield* transaction(
    (tx) =>
      Effect.gen(function* () {
        const current = yield* tx.queryRows<RowDataPacket>(
          "SELECT folder_id FROM drive_folder WHERE user_id = ? FOR UPDATE",
          [userId]
        )
        if (
          current.length !== folderIds.length ||
          current.some((row) => !sourceFiles.has(row.folder_id))
        )
          return yield* new ValidationError({
            message: "The source folder changed. Run sync again.",
          })
        yield* tx.execute(
          "UPDATE media SET available = FALSE WHERE user_id = ?",
          [userId]
        )
        yield* tx.execute("DELETE FROM media_source WHERE user_id=?", [userId])
        let saved = 0
        for (const file of files) {
          const catalogId = yield* resolve(tx, file)
          const captured = file.imageMediaMetadata?.time
            ?.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3")
            .replace(" ", "T")
          const created =
            captured && !Number.isNaN(Date.parse(captured))
              ? new Date(captured)
              : new Date(file.createdTime)
          const dimensions = file.imageMediaMetadata ?? file.videoMediaMetadata
          yield* tx.execute(
            `INSERT INTO media (id,user_id,drive_id,display_name,raw_name,mime_type,tags,created_at,uploaded_at,size,width,height,duration_ms,available,synced_at,catalog_id)
        VALUES (?,?,?,?,?,?,?, ?,?,?,?,?,?,TRUE,NOW(3),?) ON DUPLICATE KEY UPDATE catalog_id=VALUES(catalog_id), raw_name=VALUES(raw_name),mime_type=VALUES(mime_type),size=VALUES(size),width=VALUES(width),height=VALUES(height),duration_ms=VALUES(duration_ms),available=TRUE,synced_at=NOW(3)`,
            [
              randomUUID(),
              userId,
              file.id,
              file.name.replace(/\.[^.]+$/, ""),
              file.name,
              file.mimeType,
              "[]",
              created,
              new Date(file.createdTime),
              Number(file.size ?? 0),
              dimensions?.width ?? null,
              dimensions?.height ?? null,
              Number(file.videoMediaMetadata?.durationMillis) || null,
              catalogId,
            ]
          )
          yield* report({ files_saved: ++saved })
        }
        yield* saveCodecs(tx, userId, codecs)
        // Locations and folder membership are written in batches rather than one
        // statement per file.
        const owned = yield* tx.queryRows<RowDataPacket>(
          "SELECT id,drive_id,catalog_id FROM media WHERE user_id=?",
          [userId]
        )
        const mediaIds = new Map<string, string>(
          owned.map((row) => [row.drive_id as string, row.id as string])
        )
        const locations = files.flatMap((file) => {
          const mediaId = mediaIds.get(file.id)
          return mediaId ? [[mediaId, JSON.stringify(file.parents ?? [])]] : []
        })
        yield* insertInChunks(
          tx,
          "INSERT INTO media_location(media_id,parent_ids) VALUES",
          "(?,?)",
          locations,
          "ON DUPLICATE KEY UPDATE parent_ids=VALUES(parent_ids)"
        )
        const memberships = [...sourceFiles].flatMap(([folderId, members]) =>
          members.flatMap((file) => {
            const mediaId = mediaIds.get(file.id)
            return mediaId ? [[userId, folderId, mediaId]] : []
          })
        )
        yield* insertInChunks(
          tx,
          "INSERT IGNORE INTO media_source (user_id,folder_id,media_id) VALUES",
          "(?,?,?)",
          memberships
        )
        yield* applyFolderSets(tx, userId, placements, owned)
        // The tree is replaced as a whole, so folders that are gone from Drive
        // leave with this commit and a failed scan never reaches it.
        yield* tx.execute("DELETE FROM drive_folder_node WHERE user_id=?", [
          userId,
        ])
        yield* insertInChunks(
          tx,
          "INSERT INTO drive_folder_node(user_id,root_folder_id,folder_id,parent_id,name,synced_at) VALUES",
          "(?,?,?,?,?,NOW(3))",
          [...nodes].flatMap(([rootId, list]) =>
            list.map((node) => [
              userId,
              rootId,
              node.id,
              node.parentId,
              node.name.slice(0, 1024),
            ])
          )
        )
        yield* tx.execute(
          "UPDATE drive_folder SET last_synced_at = NOW(3) WHERE user_id = ?",
          [userId]
        )
      }),
    session
  )
  yield* countFiles("saved", files.length)
  return { count: files.length }
})

const inList = (values: unknown[]) => values.map(() => "?").join(",")

/**
 * Files inside a first-level subfolder of a linked folder join a set for that
 * subfolder. Runs in the reconcile transaction, so it only happens once the
 * whole scan succeeded and rolls back with it. It only ever adds:
 * - Each (subfolder, media) pairing is applied once and recorded, so a photo
 *   the user removed from the set stays out, and a file moved to another
 *   subfolder joins that subfolder's set while keeping the old membership.
 * - The set is the user's one tied to the subfolder's Drive ID. Without one,
 *   the user's single unassociated set with the same name (case-insensitive,
 *   among the sets they can see, like add-sets) is adopted; otherwise a set is
 *   created. Renames on either side never create a duplicate.
 * - A subfolder whose pairings were applied before but has no set now had its
 *   set deleted: it isn't recreated, but a set the user makes with that name
 *   is adopted.
 * - Subfolders are taken per linked folder, and the pairing key ignores which
 *   linked folder reached the file, so overlapping links never duplicate.
 * Names are only used as data here, never in telemetry.
 */
const applyFolderSets = Effect.fn("Drive.applyFolderSets")(function* (
  tx: DatabaseSession,
  userId: string,
  placements: Map<string, Placement[]>,
  owned: ReadonlyArray<RowDataPacket>
) {
  const media = new Map<string, { id: string; catalogId: string }>(
    owned.map((row) => [
      row.drive_id as string,
      { id: row.id as string, catalogId: row.catalog_id as string },
    ])
  )
  const pairs = new Map<
    string,
    { folderId: string; mediaId: string; catalogId: string }
  >()
  const names = new Map<string, string>()
  for (const list of placements.values())
    for (const placement of list) {
      const item = media.get(placement.fileId)
      if (!item) continue
      names.set(placement.folderId, placement.folderName)
      pairs.set(`${placement.folderId}\u0000${item.id}`, {
        folderId: placement.folderId,
        mediaId: item.id,
        catalogId: item.catalogId,
      })
    }
  yield* Effect.annotateCurrentSpan("mediabinder.sync.folder_pairs", pairs.size)
  if (!pairs.size) return
  const folders = [...names.keys()]
  const applied = new Set<string>()
  const handled = new Set<string>()
  for (let index = 0; index < folders.length; index += 500) {
    const chunk = folders.slice(index, index + 500)
    const rows = yield* tx.queryRows<RowDataPacket>(
      `SELECT folder_id,media_id FROM drive_folder_set_applied WHERE user_id=? AND folder_id IN (${inList(chunk)})`,
      [userId, ...chunk]
    )
    for (const row of rows) {
      applied.add(`${row.folder_id}\u0000${row.media_id}`)
      handled.add(row.folder_id as string)
    }
  }
  const fresh = [...pairs.entries()].filter(([key]) => !applied.has(key))
  if (!fresh.length) return
  const pendingFolders = [...new Set(fresh.map(([, pair]) => pair.folderId))]
  const setByFolder = new Map<string, string>()
  for (let index = 0; index < pendingFolders.length; index += 500) {
    const chunk = pendingFolders.slice(index, index + 500)
    const rows = yield* tx.queryRows<RowDataPacket>(
      `SELECT id,drive_folder_id FROM media_set WHERE user_id=? AND drive_folder_id IN (${inList(chunk)})`,
      [userId, ...chunk]
    )
    for (const row of rows)
      setByFolder.set(row.drive_folder_id as string, row.id as string)
  }
  let visible:
    | { id: string; name: string; own: boolean; linked: boolean }[]
    | undefined
  let created = 0,
    adopted = 0
  for (const folderId of pendingFolders) {
    if (setByFolder.has(folderId)) continue
    if (!visible) {
      const sets = yield* tx.queryRows<RowDataPacket>(
        `SELECT s.id,s.display_name,s.user_id,s.drive_folder_id FROM media_set s WHERE s.user_id=? OR EXISTS(
          SELECT 1 FROM catalog_set_member sm JOIN media m ON m.catalog_id=sm.catalog_id
          WHERE sm.set_id=s.id AND m.user_id=? AND m.available=TRUE)`,
        [userId, userId]
      )
      visible = sets.map((set) => ({
        id: set.id as string,
        name: (set.display_name as string).toLowerCase(),
        own: set.user_id === userId,
        linked: set.drive_folder_id !== null,
      }))
    }
    const name = names.get(folderId)!.trim().slice(0, 255)
    const matches = visible.filter((set) => set.name === name.toLowerCase())
    const [match] = matches
    if (matches.length === 1 && match.own && !match.linked) {
      yield* tx.execute(
        "UPDATE media_set SET drive_folder_id=? WHERE id=? AND user_id=? AND drive_folder_id IS NULL",
        [folderId, match.id, userId]
      )
      match.linked = true
      setByFolder.set(folderId, match.id)
      adopted++
    } else if (!handled.has(folderId) && name) {
      const id = randomUUID()
      yield* tx.execute(
        "INSERT INTO media_set(id,user_id,display_name,raw_name,tags,created_at,drive_folder_id) VALUES (?,?,?,?,'[]',NOW(3),?)",
        [id, userId, name, name, folderId]
      )
      visible.push({ id, name: name.toLowerCase(), own: true, linked: true })
      setByFolder.set(folderId, id)
      created++
    }
  }
  let joined = 0
  const members = fresh.flatMap(([, pair]) => {
    const setId = setByFolder.get(pair.folderId)
    return setId ? [[setId, pair.catalogId]] : []
  })
  for (let index = 0; index < members.length; index += 500) {
    const chunk = members.slice(index, index + 500)
    const result = yield* tx.execute(
      `INSERT IGNORE INTO catalog_set_member(set_id,catalog_id) VALUES ${chunk.map(() => "(?,?)").join(",")}`,
      chunk.flat()
    )
    joined += result.affectedRows
  }
  yield* insertInChunks(
    tx,
    "INSERT IGNORE INTO drive_folder_set_applied(user_id,folder_id,media_id) VALUES",
    "(?,?,?)",
    fresh.map(([, pair]) => [userId, pair.folderId, pair.mediaId])
  )
  yield* countFolderSets("created", created)
  yield* countFolderSets("adopted", adopted)
  yield* countFolderSets("joined", joined)
})

const insertInChunks = Effect.fnUntraced(function* (
  session: DatabaseSession,
  prefix: string,
  tuple: string,
  rows: string[][],
  suffix = ""
) {
  for (let index = 0; index < rows.length; index += 500) {
    const chunk = rows.slice(index, index + 500)
    yield* session.execute(
      `${prefix} ${chunk.map(() => tuple).join(",")} ${suffix}`,
      chunk.flat()
    )
  }
})
