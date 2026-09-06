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
  folder,
  id,
  addMediaTags,
  removeMediaTag,
  tags,
} from "./validation"
import { driveJson, driveToken, listFolders, syncDrive } from "./drive.server"
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
      "SELECT folder_id,folder_name,last_synced_at FROM drive_folder WHERE user_id=? ORDER BY folder_name",
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
  ])
  const sourceMembership = await rows<{ media_id: string; folder_id: string }>(
    "SELECT media_id,folder_id FROM media_source WHERE user_id=?",
    [user.id]
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
  return {
    user: { name: user.name, email: user.email, role: user.role },
    media,
    tag_colors: Object.fromEntries(
      definitions
        .filter(
          (t) =>
            media.some((m) => m.tags.includes(t.name)) ||
            sets.some((s) => s.tags.includes(t.name))
        )
        .map((t) => [t.name, t.color])
    ),
    sets: sets.map((s) => {
      const members = media.filter((m) => m.set_ids.includes(s.id))
      return {
        ...s,
        media_count: members.length,
        cover_id: members[0]?.id ?? null,
        post_count: posts.filter((p) => p.set_id === s.id).length,
      }
    }),
    posts,
    workspace: {
      sources,
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
  if (action === "sync") return syncDrive(userId, headers)
  if (action === "folders") return listFolders(headers)
  if (action === "source") {
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
    return { ok: true }
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
    if (action === "set-membership") {
      const value = z
        .object({
          id,
          setId: id.optional(),
          displayName: z.string().trim().min(1).max(255).optional(),
          remove: z.boolean().default(false),
        })
        .refine(
          (v) =>
            Boolean(v.setId) !== Boolean(v.displayName) &&
            (!v.remove || Boolean(v.setId))
        )
        .parse(input)
      await accessible(connection, userId, "media", value.id)
      const setId = value.setId ?? randomUUID()
      if (value.setId) await accessible(connection, userId, "set", setId)
      else
        await connection.execute(
          "INSERT INTO media_set(id,user_id,display_name,raw_name,tags,created_at) VALUES (?,?,?,?,?,NOW(3))",
          [setId, userId, value.displayName!, value.displayName!, "[]"]
        )
      if (value.remove)
        await connection.execute(
          "DELETE FROM catalog_set_member WHERE set_id=? AND catalog_id=?",
          [setId, value.id]
        )
      else
        await connection.execute(
          "INSERT IGNORE INTO catalog_set_member VALUES (?,?)",
          [setId, value.id]
        )
      await markCataloged(connection, value.id)
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
