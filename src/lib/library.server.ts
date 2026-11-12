import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import type { RowDataPacket } from "mysql2/promise"
import { z } from "zod"
import { Database, QUERY_POOL_SIZE } from "@/effect/database"
import type { DatabaseSession } from "@/effect/database"
import * as Drive from "@/effect/drive-api.server"
import { UnknownActionError, ValidationError } from "@/effect/errors"
import { mutation, parseInput } from "@/effect/operation"
import type { MutationContext, MutationHandler } from "@/effect/operation"
import { driveWebhookUrl } from "./config"
import {
  accessible,
  catalogTransaction,
  markCataloged,
  transaction,
  withUserLock,
} from "./catalog.server"
import * as DriveAccess from "./drive-access.server"
import {
  pickerConfig,
  shareAddress,
  sharedFolderMode,
} from "./drive-access.server"
import { startSync } from "./drive.server"
import { status as syncStatus } from "./sync-progress.server"
import { ensureTags } from "./tags.server"
import type { Library, Media, MediaSet, Post, DriveSource } from "./types"
import {
  metadata,
  newPost,
  newSet,
  setName,
  addMediaSets,
  folder,
  id,
  addMediaTags,
  removeMediaTag,
  tags,
  linkFolder,
} from "./validation"

/**
 * The signed-in user's whole library. The nine reads run side by side, as many
 * at a time as the Database service's query pool has connections, so one load
 * never queues behind itself.
 */
export const load = Effect.fn("Library.load")(function* (
  user: Library["user"] & { id: string }
) {
  yield* Effect.annotateCurrentSpan("mediabinder.user_id", user.id)
  const database = yield* Database
  const query = <T>(
    operation: string,
    sql: string,
    values: Array<string> = []
  ) =>
    database
      .queryRows<T & RowDataPacket>(operation, sql, values)
      .pipe(Effect.map((result) => result as unknown as T[]))
  const [
    copies,
    sets,
    posts,
    sources,
    membership,
    definitions,
    watches,
    syncState,
    sourceMembership,
  ] = yield* Effect.all(
    [
      query<Media & { physical_id: string }>(
        "library.copies",
        `SELECT m.*,m.id AS physical_id,c.id,c.display_name,c.tags,c.created_at,c.cataloged_at,c.sha256,
      COALESCE(l.parent_ids,JSON_ARRAY()) AS parent_ids,
      (SELECT COUNT(*) FROM post p WHERE p.catalog_id=c.id) AS post_count
      FROM media m JOIN catalog c ON c.id=m.catalog_id LEFT JOIN media_location l ON l.media_id=m.id
      WHERE m.user_id=? AND m.available=TRUE ORDER BY m.uploaded_at DESC,m.id ASC`,
        [user.id]
      ),
      query<MediaSet>(
        "library.sets",
        `SELECT s.* FROM media_set s WHERE s.user_id=? OR EXISTS(
      SELECT 1 FROM catalog_set_member sm JOIN media m ON m.catalog_id=sm.catalog_id
      WHERE sm.set_id=s.id AND m.user_id=? AND m.available=TRUE) ORDER BY s.created_at DESC,s.id`,
        [user.id, user.id]
      ),
      query<Post>(
        "library.posts",
        `SELECT p.id,p.catalog_id AS media_id,p.set_id,p.platform,p.url,p.external_id,p.created_at FROM post p
      WHERE EXISTS(SELECT 1 FROM media m WHERE m.catalog_id=p.catalog_id AND m.user_id=? AND m.available=TRUE)
      OR EXISTS(SELECT 1 FROM media_set s WHERE s.id=p.set_id AND (s.user_id=? OR EXISTS(
        SELECT 1 FROM catalog_set_member sm JOIN media m ON m.catalog_id=sm.catalog_id WHERE sm.set_id=s.id AND m.user_id=? AND m.available=TRUE)))
      ORDER BY p.created_at DESC,p.id`,
        [user.id, user.id, user.id]
      ),
      query<DriveSource>(
        "library.sources",
        "SELECT folder_id,folder_name,last_synced_at,share_permission_id IS NOT NULL AS shared_by_app FROM drive_folder WHERE user_id=? ORDER BY folder_name",
        [user.id]
      ),
      query<{ set_id: string; catalog_id: string }>(
        "library.membership",
        "SELECT sm.* FROM catalog_set_member sm WHERE EXISTS(SELECT 1 FROM media m WHERE m.catalog_id=sm.catalog_id AND m.user_id=? AND m.available=TRUE)",
        [user.id]
      ),
      query<{ name: string; color: string }>(
        "library.tagColors",
        "SELECT name,color FROM catalog_tag"
      ),
      query<{ count: number }>(
        "library.watches",
        "SELECT COUNT(*) AS count FROM drive_watch WHERE user_id=? AND resource_id IS NOT NULL AND expires_at>NOW(3)",
        [user.id]
      ),
      query<{ watch_error: string | null; last_error: string | null }>(
        "library.syncState",
        "SELECT watch_error,last_error FROM drive_sync_state WHERE user_id=?",
        [user.id]
      ),
      query<{ media_id: string; folder_id: string }>(
        "library.sourceMembership",
        "SELECT media_id,folder_id FROM media_source WHERE user_id=?",
        [user.id]
      ),
    ],
    { concurrency: QUERY_POOL_SIZE }
  )
  const foldersByCopy = new Map<string, string[]>()
  for (const source of sourceMembership)
    foldersByCopy.set(source.media_id, [
      ...(foldersByCopy.get(source.media_id) ?? []),
      source.folder_id,
    ])
  const setsByCatalog = new Map<string, string[]>()
  for (const member of membership)
    setsByCatalog.set(member.catalog_id, [
      ...(setsByCatalog.get(member.catalog_id) ?? []),
      member.set_id,
    ])
  const grouped = new Map<string, Media>()
  for (const copy of copies) {
    const sourceIds = foldersByCopy.get(copy.physical_id) ?? []
    const existing = grouped.get(copy.id)
    if (existing) {
      existing.source_ids = [...new Set([...existing.source_ids, ...sourceIds])]
      existing.parent_ids = [
        ...new Set([...existing.parent_ids, ...copy.parent_ids]),
      ]
      existing.copy_count++
    } else
      grouped.set(copy.id, {
        ...copy,
        size: Number(copy.size),
        available: true,
        cataloged: Boolean(copy.cataloged_at),
        copy_count: 1,
        source_ids: sourceIds,
        set_ids: setsByCatalog.get(copy.id) ?? [],
      })
  }
  const media = [...grouped.values()].sort(
    (a, b) =>
      b.uploaded_at.localeCompare(a.uploaded_at) || a.id.localeCompare(b.id)
  )
  const visibleTags = new Set([...media, ...sets].flatMap((item) => item.tags))
  const setSummaries = new Map<
    string,
    { media_count: number; cover_id: string }
  >()
  for (const item of media)
    for (const setId of item.set_ids) {
      const summary = setSummaries.get(setId)
      if (summary) summary.media_count++
      else setSummaries.set(setId, { media_count: 1, cover_id: item.id })
    }
  const postCounts = new Map<string, number>()
  for (const post of posts)
    if (post.set_id)
      postCounts.set(post.set_id, (postCounts.get(post.set_id) ?? 0) + 1)
  return {
    user: { name: user.name, email: user.email, role: user.role },
    media,
    tag_colors: Object.fromEntries(
      definitions
        .filter((t) => visibleTags.has(t.name))
        .map((t) => [t.name, t.color])
    ),
    sets: sets.map((s) => ({
      ...s,
      media_count: setSummaries.get(s.id)?.media_count ?? 0,
      cover_id: setSummaries.get(s.id)?.cover_id ?? null,
      post_count: postCounts.get(s.id) ?? 0,
    })),
    posts,
    workspace: {
      sources,
      drive_access: sharedFolderMode()
        ? {
            mode: "shared-folder",
            share_address: shareAddress(),
            picker: Boolean(pickerConfig()),
          }
        : { mode: "full-drive", share_address: null, picker: false },
      webhook: {
        configured: Boolean(driveWebhookUrl()),
        active: watches[0]?.count ?? 0,
        error: syncState[0]?.watch_error ?? syncState[0]?.last_error ?? null,
      },
      last_synced_at:
        sources
          .map((s) => s.last_synced_at)
          .filter((d): d is string => Boolean(d))
          .sort()
          .at(-1) ?? null,
    },
  } satisfies Library
})

// Source edits share the sync lock, so an in-flight scan cannot restore an unlinked folder.
export type LinkResult =
  | { ok: true; status: "linked"; folder_name: string; shared: boolean }
  | {
      ok: false
      status: "needs-share"
      folder_id: string
      folder_name: string | null
      share_address: string
      reason: string
    }

// Shared-folder linking. The service account can read every folder any user
// shared with it, so a user may only link a folder they can prove they reach:
// either their drive.file token sees it (they chose it in Google's picker) or
// Google lists them as its owner.
const linkSharedFolder = Effect.fn("Library.linkSharedFolder")(function* (
  userId: string,
  input: unknown
) {
  yield* Effect.annotateCurrentSpan("mediabinder.user_id", userId)
  const value = yield* parseInput(linkFolder, input)
  const address = shareAddress()!
  const database = yield* Database
  const [user] = yield* database.queryRows<{ email: string } & RowDataPacket>(
    "library.userEmail",
    "SELECT email FROM user WHERE id=?",
    [userId]
  )
  // A folder the user's own token can't see isn't one they picked.
  const picked = yield* Drive.token(undefined, userId).pipe(
    Effect.flatMap((token) => DriveAccess.getFolder(token, value.folderId)),
    Effect.catchTag("DriveAccessError", () => Effect.succeed(null))
  )
  let permissionId: string | null = null
  if (value.share) {
    if (!picked)
      return yield* new ValidationError({
        message:
          "Choose the folder with the Google Drive picker so MediaBinder can share it.",
      })
    const shared = yield* Drive.token(undefined, userId).pipe(
      Effect.flatMap((token) =>
        DriveAccess.shareFolderWithApp(token, value.folderId)
      ),
      Effect.map((id) => ({ refused: null, id })),
      Effect.catchTag("DriveAccessError", (error) =>
        error.code === "scope"
          ? Effect.fail(error)
          : Effect.succeed({ refused: error.message, id: null })
      )
    )
    if (shared.refused !== null)
      return {
        ok: false,
        status: "needs-share",
        folder_id: value.folderId,
        folder_name: picked.name,
        share_address: address,
        reason: shared.refused,
      } satisfies LinkResult
    permissionId = shared.id
  }
  const source = yield* DriveAccess.waitForAppAccess(
    value.folderId,
    value.share ? 6 : 2
  ).pipe(
    Effect.catchTag("DriveAccessError", (error) =>
      error.code === "unavailable" ? Effect.fail(error) : Effect.succeed(null)
    )
  )
  if (!source)
    return {
      ok: false,
      status: "needs-share",
      folder_id: value.folderId,
      folder_name: picked?.name ?? null,
      share_address: address,
      reason: "MediaBinder can't see this folder yet.",
    } satisfies LinkResult
  const owner = source.owners?.some(
    (owner) => owner.emailAddress?.toLowerCase() === user?.email.toLowerCase()
  )
  if (!picked && !owner)
    return yield* new ValidationError({
      message:
        "Choose this folder with the Google Drive picker to confirm you have access to it.",
    })
  yield* editSources(userId, (session) =>
    Effect.asVoid(
      session.execute(
        `INSERT INTO drive_folder(user_id,folder_id,folder_name,share_permission_id) VALUES (?,?,?,?)
      ON DUPLICATE KEY UPDATE folder_name=VALUES(folder_name),share_permission_id=COALESCE(VALUES(share_permission_id),share_permission_id)`,
        [userId, source.id, source.name, permissionId]
      )
    )
  )
  return {
    ok: true,
    status: "linked",
    folder_name: source.name,
    shared: Boolean(permissionId),
  } satisfies LinkResult
})

// Remove MediaBinder's viewer access once no MediaBinder user links the folder.
// Best effort: unlinking succeeds even if Google refuses (the user can remove
// the share in Drive), and the service account then simply stops reading it.
const removeShareIfUnused = Effect.fn("Library.removeShareIfUnused")(function* (
  userId: string,
  folderId: string,
  permissionId: string
) {
  yield* Effect.annotateCurrentSpan("mediabinder.user_id", userId)
  const database = yield* Database
  const [others] = yield* database.queryRows<{ count: number } & RowDataPacket>(
    "library.folderLinks",
    "SELECT COUNT(*) AS count FROM drive_folder WHERE folder_id=?",
    [folderId]
  )
  // Another MediaBinder user still syncs this folder; keep the share.
  if (Number(others?.count) > 0) return false
  return yield* Drive.token(undefined, userId).pipe(
    Effect.flatMap((token) =>
      DriveAccess.removeAppShare(token, folderId, permissionId)
    ),
    Effect.as(true),
    Effect.catch((error) =>
      Effect.logWarning("Could not remove MediaBinder's folder share").pipe(
        Effect.annotateLogs({
          "mediabinder.user_id": userId,
          "error.type": error._tag,
        }),
        Effect.as(false)
      )
    )
  )
})

const editSources = Effect.fn("Library.editSources")(function* <
  TError,
  TRequirements,
>(
  userId: string,
  edit: (session: DatabaseSession) => Effect.Effect<void, TError, TRequirements>
) {
  yield* Effect.annotateCurrentSpan("mediabinder.user_id", userId)
  return yield* withUserLock(userId, (locked) =>
    transaction(
      (session) =>
        Effect.gen(function* () {
          yield* edit(session)
          yield* session.execute(
            "INSERT INTO drive_sync_state(user_id) VALUES (?) ON DUPLICATE KEY UPDATE watch_next_check=NOW(3)",
            [userId]
          )
        }),
      locked
    )
  )
})

const sourceActions = {
  sync: mutation("sync", {
    run: (_, { userId, headers }) => startSync(userId, headers),
  }),
  "sync-status": mutation("sync-status", {
    run: (_, { userId }) => syncStatus(userId),
  }),
  folders: mutation("folders", {
    run: (_, { headers }) => Drive.listFolders(headers),
  }),
  "picker-session": mutation("picker-session", {
    run: (_, { userId }) =>
      Effect.gen(function* () {
        const picker = pickerConfig()
        if (!sharedFolderMode() || !picker)
          return yield* new ValidationError({
            message: "The Google Drive picker isn't set up.",
          })
        // The user's own drive.file token: it can only reach files they pick.
        return { ...picker, token: yield* Drive.token(undefined, userId) }
      }),
  }),
  "create-folder": mutation("create-folder", {
    input: z.object({ name: z.string().trim().min(1).max(100) }),
    run: ({ name }, { userId }) =>
      Effect.gen(function* () {
        if (!sharedFolderMode())
          return yield* new ValidationError({
            message: "Create folders from Google Drive instead.",
          })
        const created = yield* Drive.token(undefined, userId).pipe(
          Effect.flatMap((token) => DriveAccess.createFolder(token, name))
        )
        return yield* linkSharedFolder(userId, {
          folderId: created.id,
          share: true,
        })
      }),
  }),
  source: mutation("source", {
    run: (data, { userId, headers }) =>
      Effect.gen(function* () {
        if (sharedFolderMode()) return yield* linkSharedFolder(userId, data)
        const value = yield* parseInput(folder, data)
        const token = yield* Drive.token(headers)
        const source = yield* Drive.json<{
          id: string
          name: string
          mimeType: string
        }>(token, `files/${value.folderId}`, {
          fields: "id,name,mimeType",
          supportsAllDrives: "true",
        })
        if (source.mimeType !== "application/vnd.google-apps.folder")
          return yield* new ValidationError({
            message: "Choose a Google Drive folder.",
          })
        yield* editSources(userId, (session) =>
          Effect.asVoid(
            session.execute(
              "INSERT INTO drive_folder(user_id,folder_id,folder_name) VALUES (?,?,?) ON DUPLICATE KEY UPDATE folder_name=VALUES(folder_name)",
              [userId, source.id, source.name]
            )
          )
        )
        return { ok: true }
      }),
  }),
  "remove-source": mutation("remove-source", {
    input: folder,
    run: (value, { userId }) =>
      Effect.gen(function* () {
        const database = yield* Database
        const [linked] = yield* database.queryRows<
          { share_permission_id: string | null } & RowDataPacket
        >(
          "library.linkedFolder",
          "SELECT share_permission_id FROM drive_folder WHERE user_id=? AND folder_id=?",
          [userId, value.folderId]
        )
        yield* editSources(userId, (session) =>
          Effect.gen(function* () {
            yield* session.execute(
              "DELETE FROM drive_folder WHERE user_id=? AND folder_id=?",
              [userId, value.folderId]
            )
            yield* session.execute(
              "UPDATE media m SET available=EXISTS(SELECT 1 FROM media_source s WHERE s.media_id=m.id AND s.user_id=m.user_id) WHERE m.user_id=?",
              [userId]
            )
          })
        )
        if (!sharedFolderMode()) return { ok: true }
        // Whether MediaBinder's service account lost access to the folder. Google
        // only lets MediaBinder remove the share while it can write everything
        // inside, so the user may need to remove it in Drive.
        const access_removed = linked?.share_permission_id
          ? yield* removeShareIfUnused(
              userId,
              value.folderId,
              linked.share_permission_id
            )
          : false
        return {
          ok: true,
          access_removed,
          share_address: shareAddress(),
        }
      }),
  }),
}

// Layer 19 converts these. Until then each runs the Promise code below as it
// always has, in the one catalog transaction, behind the same table.
type LegacyAction =
  | "tag-color"
  | "create-set"
  | "add-sets"
  | "set-membership"
  | "add-tags"
  | "remove-tags"
  | "remove-tag"
  | "metadata"
  | "create-post"
  | "delete-post"
  | "delete-set"

const legacy = (action: LegacyAction) =>
  mutation(action, {
    run: (data, { userId }) =>
      Effect.tryPromise({
        try: () => legacyMutate(action, data, userId),
        catch: (error) => error,
      }),
  })

/**
 * Every library action, by the name the client posts. This is the one place
 * that lists them: the route dispatches through it and nothing else mutates
 * the library. Each handler runs for `context.userId`, the signed-in user.
 */
export type ActionName = LegacyAction | keyof typeof sourceActions

export const actions: Record<ActionName, MutationHandler> = {
  ...sourceActions,
  "tag-color": legacy("tag-color"),
  "create-set": legacy("create-set"),
  "add-sets": legacy("add-sets"),
  "set-membership": legacy("set-membership"),
  "add-tags": legacy("add-tags"),
  "remove-tags": legacy("remove-tags"),
  "remove-tag": legacy("remove-tag"),
  metadata: legacy("metadata"),
  "create-post": legacy("create-post"),
  "delete-post": legacy("delete-post"),
  "delete-set": legacy("delete-set"),
}

/** Runs one library action for a user; an unknown name is a 404. */
export const mutate = (
  action: string,
  data: unknown,
  userId: string,
  headers: Headers
) => {
  const context: MutationContext = { userId, headers }
  return Object.hasOwn(actions, action)
    ? actions[action as ActionName](data, context)
    : Effect.fail(new UnknownActionError())
}

async function legacyMutate(
  action: LegacyAction,
  input: unknown,
  userId: string
) {
  return catalogTransaction(async (connection) => {
    if (action === "tag-color") {
      const value = z
        .object({
          name: z.string().trim().min(1).max(50),
          color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        })
        .parse(input)
      const [visible] = await connection.query<RowDataPacket[]>(
        `SELECT name FROM catalog_tag t WHERE name=? AND (
        EXISTS(SELECT 1 FROM catalog c JOIN media m ON m.catalog_id=c.id WHERE m.user_id=? AND m.available=TRUE AND JSON_CONTAINS(c.tags,JSON_QUOTE(t.name))) OR
        EXISTS(SELECT 1 FROM media_set s WHERE JSON_CONTAINS(s.tags,JSON_QUOTE(t.name)) AND (s.user_id=? OR EXISTS(
          SELECT 1 FROM catalog_set_member sm JOIN media m ON m.catalog_id=sm.catalog_id WHERE sm.set_id=s.id AND m.user_id=? AND m.available=TRUE))))`,
        [value.name, userId, userId, userId]
      )
      if (!visible.length) throw new Response("Tag not found.", { status: 404 })
      await connection.execute("UPDATE catalog_tag SET color=? WHERE name=?", [
        value.color,
        value.name,
      ])
      return { ok: true }
    }
    if (action === "create-set") {
      const value = newSet.parse(input),
        setId = randomUUID()
      await connection.execute(
        "INSERT INTO media_set(id,user_id,display_name,raw_name,tags,created_at) VALUES (?,?,?,?,?,NOW(3))",
        [
          setId,
          userId,
          value.displayName,
          value.displayName,
          JSON.stringify(value.tags),
        ]
      )
      await ensureTags(userId, value.tags, connection)
      return { id: setId }
    }
    if (action === "add-sets") {
      const value = addMediaSets.parse(input)
      for (const target of value.ids)
        await accessible(connection, userId, "media", target)
      const [visible] = await connection.query<RowDataPacket[]>(
        `SELECT s.id,s.display_name FROM media_set s WHERE s.user_id=? OR EXISTS(
          SELECT 1 FROM catalog_set_member sm JOIN media m ON m.catalog_id=sm.catalog_id
          WHERE sm.set_id=s.id AND m.user_id=? AND m.available=TRUE)`,
        [userId, userId]
      )
      for (const name of value.names) {
        const matches = visible.filter(
          (set) => set.display_name.toLowerCase() === name.toLowerCase()
        )
        if (matches.length > 1)
          throw new Response(
            `Multiple sets named “${name}”. Choose one individually.`,
            { status: 400 }
          )
        const setId = matches[0]?.id ?? randomUUID()
        if (!matches.length) {
          await connection.execute(
            "INSERT INTO media_set(id,user_id,display_name,raw_name,tags,created_at) VALUES (?,?,?,?,?,NOW(3))",
            [setId, userId, name, name, "[]"]
          )
        }
        for (const target of value.ids)
          await connection.execute(
            "INSERT IGNORE INTO catalog_set_member VALUES (?,?)",
            [setId, target]
          )
      }
      for (const target of value.ids) await markCataloged(connection, target)
      return { count: value.ids.length }
    }
    if (action === "set-membership") {
      const value = z
        .object({
          id: id.optional(),
          ids: addMediaTags.shape.ids.optional(),
          setId: id.optional(),
          displayName: setName.optional(),
          remove: z.boolean().default(false),
        })
        .refine(
          (v) => Boolean(v.id) !== Boolean(v.ids),
          "Provide a media ID or media IDs"
        )
        .refine(
          (v) =>
            Boolean(v.setId) !== Boolean(v.displayName) &&
            (!v.remove || Boolean(v.setId))
        )
        .parse(input)
      const targets = value.ids ?? [value.id!]
      for (const target of targets)
        await accessible(connection, userId, "media", target)
      const setId = value.setId ?? randomUUID()
      if (value.setId) await accessible(connection, userId, "set", setId)
      else
        await connection.execute(
          "INSERT INTO media_set(id,user_id,display_name,raw_name,tags,created_at) VALUES (?,?,?,?,?,NOW(3))",
          [setId, userId, value.displayName!, value.displayName!, "[]"]
        )
      for (const target of targets) {
        if (value.remove)
          await connection.execute(
            "DELETE FROM catalog_set_member WHERE set_id=? AND catalog_id=?",
            [setId, target]
          )
        else
          await connection.execute(
            "INSERT IGNORE INTO catalog_set_member VALUES (?,?)",
            [setId, target]
          )
        await markCataloged(connection, target)
      }
      return { id: setId }
    }
    if (action === "add-tags" || action === "remove-tags") {
      const value = addMediaTags.parse(input)
      for (const target of value.ids)
        await accessible(connection, userId, "media", target)
      if (action === "add-tags")
        await ensureTags(userId, value.tags, connection)
      for (const target of value.ids) {
        const [items] = await connection.query<RowDataPacket[]>(
          "SELECT tags FROM catalog WHERE id=?",
          [target]
        )
        const merged = tags.parse(
          action === "remove-tags"
            ? items[0].tags.filter((tag: string) => !value.tags.includes(tag))
            : [...new Set([...items[0].tags, ...value.tags])]
        )
        await connection.execute("UPDATE catalog SET tags=? WHERE id=?", [
          JSON.stringify(merged),
          target,
        ])
        await markCataloged(connection, target)
      }
      return { count: value.ids.length }
    }
    if (action === "remove-tag") {
      const value = removeMediaTag.parse(input)
      await accessible(connection, userId, "media", value.id)
      const [items] = await connection.query<RowDataPacket[]>(
        "SELECT tags FROM catalog WHERE id=?",
        [value.id]
      )
      await connection.execute("UPDATE catalog SET tags=? WHERE id=?", [
        JSON.stringify(items[0].tags.filter((t: string) => t !== value.tag)),
        value.id,
      ])
      await markCataloged(connection, value.id)
      return { ok: true }
    }
    if (action === "metadata") {
      const value = metadata.parse(input)
      await accessible(connection, userId, value.kind, value.id)
      if (value.kind === "media" && value.setIds)
        for (const setId of value.setIds)
          await accessible(connection, userId, "set", setId)
      await connection.execute(
        `UPDATE ${value.kind === "media" ? "catalog" : "media_set"} SET display_name=?,${value.tags ? "tags=?," : ""}created_at=? WHERE id=?`,
        [
          value.displayName,
          ...(value.tags ? [JSON.stringify(value.tags)] : []),
          new Date(value.createdAt),
          value.id,
        ]
      )
      if (value.tags) await ensureTags(userId, value.tags, connection)
      if (value.kind === "media") {
        if (value.setIds) {
          await connection.execute(
            "DELETE FROM catalog_set_member WHERE catalog_id=?",
            [value.id]
          )
          for (const setId of new Set(value.setIds))
            await connection.execute(
              "INSERT INTO catalog_set_member VALUES (?,?)",
              [setId, value.id]
            )
        }
        await markCataloged(connection, value.id)
      }
      return { ok: true }
    }
    if (action === "create-post") {
      const value = newPost.parse(input)
      await accessible(connection, userId, value.kind, value.targetId)
      const [physical] =
        value.kind === "media"
          ? await connection.query<RowDataPacket[]>(
              "SELECT id FROM media WHERE catalog_id=? AND user_id=? AND available=TRUE LIMIT 1",
              [value.targetId, userId]
            )
          : [[]]
      await connection.execute(
        "INSERT INTO post(id,user_id,media_id,catalog_id,set_id,platform,url,external_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        [
          randomUUID(),
          userId,
          value.kind === "media" ? physical[0].id : null,
          value.kind === "media" ? value.targetId : null,
          value.kind === "set" ? value.targetId : null,
          value.platform,
          value.url,
          value.externalId,
          new Date(value.createdAt),
        ]
      )
      if (value.kind === "media")
        await markCataloged(connection, value.targetId)
      return { ok: true }
    }
    if (action === "delete-post") {
      const target = id.parse((input as { id: unknown }).id)
      const [items] = await connection.query<RowDataPacket[]>(
        "SELECT catalog_id,set_id FROM post WHERE id=?",
        [target]
      )
      if (!items.length) throw new Response("Post not found.", { status: 404 })
      await accessible(
        connection,
        userId,
        items[0].catalog_id ? "media" : "set",
        items[0].catalog_id ?? items[0].set_id
      )
      await connection.execute("DELETE FROM post WHERE id=?", [target])
      return { ok: true }
    }
    if (action === "delete-set") {
      const target = id.parse((input as { id: unknown }).id)
      await accessible(connection, userId, "set", target)
      await connection.execute("DELETE FROM media_set WHERE id=?", [target])
      return { ok: true }
    }
  })
}
