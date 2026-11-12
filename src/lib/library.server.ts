import { driveWebhookUrl } from "./config"
import { z } from "zod"
import { ensureTags } from "./tags.server"
import { randomUUID } from "node:crypto"
import { rows } from "./database.server"
import {
  catalogTransaction,
  accessible,
  markCataloged,
  withDriveLock,
} from "./catalog.server"
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
import {
  DriveAccessError,
  createFolder,
  getFolder,
  pickerConfig,
  removeAppShare,
  shareAddress,
  shareFolderWithApp,
  sharedFolderMode,
  waitForAppAccess,
} from "./drive-access.server"
import {
  driveJson,
  driveToken,
  listFolders,
  startDriveSync,
} from "./drive.server"
import { syncStatus } from "./sync-progress.server"
import type { RowDataPacket } from "mysql2/promise"

export async function library(
  user: Library["user"] & { id: string }
): Promise<Library> {
  const [
    copies,
    sets,
    posts,
    sources,
    membership,
    definitions,
    watches,
    syncStatus,
    sourceMembership,
  ] = await Promise.all([
    rows<Media & { physical_id: string }>(
      `SELECT m.*,m.id AS physical_id,c.id,c.display_name,c.tags,c.created_at,c.cataloged_at,c.sha256,
      COALESCE(l.parent_ids,JSON_ARRAY()) AS parent_ids,
      (SELECT COUNT(*) FROM post p WHERE p.catalog_id=c.id) AS post_count
      FROM media m JOIN catalog c ON c.id=m.catalog_id LEFT JOIN media_location l ON l.media_id=m.id
      WHERE m.user_id=? AND m.available=TRUE ORDER BY m.uploaded_at DESC,m.id ASC`,
      [user.id]
    ),
    rows<MediaSet>(
      `SELECT s.* FROM media_set s WHERE s.user_id=? OR EXISTS(
      SELECT 1 FROM catalog_set_member sm JOIN media m ON m.catalog_id=sm.catalog_id
      WHERE sm.set_id=s.id AND m.user_id=? AND m.available=TRUE) ORDER BY s.created_at DESC,s.id`,
      [user.id, user.id]
    ),
    rows<Post>(
      `SELECT p.id,p.catalog_id AS media_id,p.set_id,p.platform,p.url,p.external_id,p.created_at FROM post p
      WHERE EXISTS(SELECT 1 FROM media m WHERE m.catalog_id=p.catalog_id AND m.user_id=? AND m.available=TRUE)
      OR EXISTS(SELECT 1 FROM media_set s WHERE s.id=p.set_id AND (s.user_id=? OR EXISTS(
        SELECT 1 FROM catalog_set_member sm JOIN media m ON m.catalog_id=sm.catalog_id WHERE sm.set_id=s.id AND m.user_id=? AND m.available=TRUE)))
      ORDER BY p.created_at DESC,p.id`,
      [user.id, user.id, user.id]
    ),
    rows<DriveSource>(
      "SELECT folder_id,folder_name,last_synced_at,share_permission_id IS NOT NULL AS shared_by_app FROM drive_folder WHERE user_id=? ORDER BY folder_name",
      [user.id]
    ),
    rows<{ set_id: string; catalog_id: string }>(
      "SELECT sm.* FROM catalog_set_member sm WHERE EXISTS(SELECT 1 FROM media m WHERE m.catalog_id=sm.catalog_id AND m.user_id=? AND m.available=TRUE)",
      [user.id]
    ),
    rows<{ name: string; color: string }>("SELECT name,color FROM catalog_tag"),
    rows<{ count: number }>(
      "SELECT COUNT(*) AS count FROM drive_watch WHERE user_id=? AND resource_id IS NOT NULL AND expires_at>NOW(3)",
      [user.id]
    ),
    rows<{ watch_error: string | null; last_error: string | null }>(
      "SELECT watch_error,last_error FROM drive_sync_state WHERE user_id=?",
      [user.id]
    ),
    rows<{ media_id: string; folder_id: string }>(
      "SELECT media_id,folder_id FROM media_source WHERE user_id=?",
      [user.id]
    ),
  ])
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
        error: syncStatus[0]?.watch_error ?? syncStatus[0]?.last_error ?? null,
      },
      last_synced_at:
        sources
          .map((s) => s.last_synced_at)
          .filter((d): d is string => Boolean(d))
          .sort()
          .at(-1) ?? null,
    },
  }
}

export async function mutate(
  action: string,
  input: unknown,
  userId: string,
  headers: Headers
) {
  if (action === "sync") return startDriveSync(userId, headers)
  if (action === "sync-status") return syncStatus(userId)
  if (action === "folders") return listFolders(headers)
  if (action === "picker-session") {
    const picker = pickerConfig()
    if (!sharedFolderMode() || !picker)
      throw new Error("The Google Drive picker isn't set up.")
    // The user's own drive.file token: it can only reach files they pick.
    return { ...picker, token: await driveToken(undefined, userId) }
  }
  if (action === "create-folder") {
    if (!sharedFolderMode())
      throw new Error("Create folders from Google Drive instead.")
    const { name } = z
      .object({ name: z.string().trim().min(1).max(100) })
      .parse(input)
    const created = await createFolder(
      await driveToken(undefined, userId),
      name
    )
    return linkSharedFolder(userId, headers, {
      folderId: created.id,
      share: true,
    })
  }
  if (action === "source") {
    if (sharedFolderMode()) return linkSharedFolder(userId, headers, input)
    const value = folder.parse(input),
      token = await driveToken(headers)
    const source = await driveJson<{
      id: string
      name: string
      mimeType: string
    }>(token, `files/${value.folderId}`, {
      fields: "id,name,mimeType",
      supportsAllDrives: "true",
    })
    if (source.mimeType !== "application/vnd.google-apps.folder")
      throw new Error("Choose a Google Drive folder.")
    await editSources(userId, async (connection) => {
      await connection.execute(
        "INSERT INTO drive_folder(user_id,folder_id,folder_name) VALUES (?,?,?) ON DUPLICATE KEY UPDATE folder_name=VALUES(folder_name)",
        [userId, source.id, source.name]
      )
    })
    return { ok: true }
  }
  if (action === "remove-source") {
    const value = folder.parse(input)
    const [linked] = await rows<{ share_permission_id: string | null }>(
      "SELECT share_permission_id FROM drive_folder WHERE user_id=? AND folder_id=?",
      [userId, value.folderId]
    )
    await editSources(userId, async (connection) => {
      await connection.execute(
        "DELETE FROM drive_folder WHERE user_id=? AND folder_id=?",
        [userId, value.folderId]
      )
      await connection.execute(
        "UPDATE media m SET available=EXISTS(SELECT 1 FROM media_source s WHERE s.media_id=m.id AND s.user_id=m.user_id) WHERE m.user_id=?",
        [userId]
      )
    })
    if (!sharedFolderMode()) return { ok: true }
    // Whether MediaBinder's service account lost access to the folder. Google
    // only lets MediaBinder remove the share while it can write everything
    // inside, so the user may need to remove it in Drive.
    const access_removed = linked?.share_permission_id
      ? await removeShareIfUnused(
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
  }
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
    throw new Response("Unknown action.", { status: 404 })
  })
}

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
async function linkSharedFolder(
  userId: string,
  headers: Headers,
  input: unknown
): Promise<LinkResult> {
  const value = linkFolder.parse(input)
  const address = shareAddress()!
  const [user] = await rows<{ email: string }>(
    "SELECT email FROM user WHERE id=?",
    [userId]
  )
  let picked: { name: string } | null = null
  try {
    picked = await getFolder(
      await driveToken(undefined, userId),
      value.folderId
    )
  } catch (error) {
    if (!(error instanceof DriveAccessError)) throw error
  }
  let permissionId: string | null = null
  if (value.share) {
    if (!picked)
      throw new Error(
        "Choose the folder with the Google Drive picker so MediaBinder can share it."
      )
    try {
      permissionId = await shareFolderWithApp(
        await driveToken(undefined, userId),
        value.folderId
      )
    } catch (error) {
      if (!(error instanceof DriveAccessError)) throw error
      if (error.code === "scope") throw error
      return {
        ok: false,
        status: "needs-share",
        folder_id: value.folderId,
        folder_name: picked.name,
        share_address: address,
        reason: error.message,
      }
    }
  }
  let source
  try {
    source = await waitForAppAccess(value.folderId, value.share ? 6 : 2)
  } catch (error) {
    if (!(error instanceof DriveAccessError) || error.code === "unavailable")
      throw error
    return {
      ok: false,
      status: "needs-share",
      folder_id: value.folderId,
      folder_name: picked?.name ?? null,
      share_address: address,
      reason: "MediaBinder can't see this folder yet.",
    }
  }
  const owner = source.owners?.some(
    (owner) => owner.emailAddress?.toLowerCase() === user?.email.toLowerCase()
  )
  if (!picked && !owner)
    throw new Error(
      "Choose this folder with the Google Drive picker to confirm you have access to it."
    )
  await editSources(userId, async (connection) => {
    await connection.execute(
      `INSERT INTO drive_folder(user_id,folder_id,folder_name,share_permission_id) VALUES (?,?,?,?)
      ON DUPLICATE KEY UPDATE folder_name=VALUES(folder_name),share_permission_id=COALESCE(VALUES(share_permission_id),share_permission_id)`,
      [userId, source.id, source.name, permissionId]
    )
  })
  return {
    ok: true,
    status: "linked",
    folder_name: source.name,
    shared: Boolean(permissionId),
  }
}

// Remove MediaBinder's viewer access once no MediaBinder user links the folder.
// Best effort: unlinking succeeds even if Google refuses (the user can remove
// the share in Drive), and the service account then simply stops reading it.
async function removeShareIfUnused(
  userId: string,
  folderId: string,
  permissionId: string
) {
  const [others] = await rows<{ count: number }>(
    "SELECT COUNT(*) AS count FROM drive_folder WHERE folder_id=?",
    [folderId]
  )
  // Another MediaBinder user still syncs this folder; keep the share.
  if (Number(others?.count) > 0) return false
  try {
    await removeAppShare(
      await driveToken(undefined, userId),
      folderId,
      permissionId
    )
    return true
  } catch (error) {
    console.warn(
      "Could not remove MediaBinder's folder share:",
      error instanceof Error ? error.message : "Unknown error"
    )
    return false
  }
}

async function editSources(
  userId: string,
  edit: (connection: import("mysql2/promise").PoolConnection) => Promise<void>
) {
  return withDriveLock(userId, (connection) =>
    catalogTransaction(async (connection) => {
      await edit(connection)
      await connection.execute(
        "INSERT INTO drive_sync_state(user_id) VALUES (?) ON DUPLICATE KEY UPDATE watch_next_check=NOW(3)",
        [userId]
      )
    }, connection)
  )
}
