import { driveWebhookUrl } from "./config"
import { z } from "zod"
import { ensureTags } from "./tags.server"
import { randomUUID } from "node:crypto"
import { pool, rows } from "./database.server"
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
export async function library(
  user: Library["user"] & { id: string }
): Promise<Library> {
  const [
    media,
    sets,
    posts,
    sources,
    membership,
    locations,
    sourceMembership,
    definitions,
    watches,
    syncStatus,
  ] = await Promise.all([
    // React Table uses input order to break sort ties. Keep it stable across metadata edits.
    rows<Media>(
      "SELECT m.*, (SELECT COUNT(*) FROM post p WHERE p.media_id=m.id) AS post_count FROM media m WHERE user_id=? AND available=TRUE ORDER BY m.uploaded_at DESC, m.id ASC",
      [user.id]
    ),
    rows<MediaSet>(
      `SELECT s.*, (SELECT COUNT(*) FROM set_member sm JOIN media m ON m.id=sm.media_id WHERE sm.set_id=s.id AND m.available=TRUE) AS media_count, (SELECT sm.media_id FROM set_member sm JOIN media m ON m.id=sm.media_id WHERE sm.set_id=s.id AND m.available=TRUE LIMIT 1) AS cover_id, (SELECT COUNT(*) FROM post p WHERE p.set_id=s.id) AS post_count FROM media_set s WHERE user_id=? ORDER BY created_at DESC`,
      [user.id]
    ),
    rows<Post>(
      "SELECT p.* FROM post p LEFT JOIN media m ON m.id=p.media_id WHERE p.user_id=? AND (p.set_id IS NOT NULL OR m.available=TRUE) ORDER BY p.created_at DESC",
      [user.id]
    ),
    rows<DriveSource>(
      "SELECT folder_id,folder_name,last_synced_at FROM drive_folder WHERE user_id=? ORDER BY folder_name",
      [user.id]
    ),
    rows<{ set_id: string; media_id: string }>(
      "SELECT sm.* FROM set_member sm JOIN media m ON m.id=sm.media_id WHERE m.user_id=?",
      [user.id]
    ),
    rows<{ media_id: string; parent_ids: string[] }>(
      "SELECT l.* FROM media_location l JOIN media m ON m.id=l.media_id WHERE m.user_id=?",
      [user.id]
    ),
    rows<{ media_id: string; folder_id: string }>(
      "SELECT media_id,folder_id FROM media_source WHERE user_id=?",
      [user.id]
    ),
    rows<{ name: string; color: string }>(
      "SELECT name,color FROM tag_definition WHERE user_id=?",
      [user.id]
    ),
    rows<{ count: number }>(
      "SELECT COUNT(*) AS count FROM drive_watch WHERE user_id=? AND resource_id IS NOT NULL AND expires_at>NOW(3)",
      [user.id]
    ),
    rows<{ watch_error: string | null; last_error: string | null }>(
      "SELECT watch_error,last_error FROM drive_sync_state WHERE user_id=?",
      [user.id]
    ),
  ])
  const memberships = new Map<string, string[]>()
  for (const row of membership)
    memberships.set(row.media_id, [
      ...(memberships.get(row.media_id) ?? []),
      row.set_id,
    ])
  return {
    user: { name: user.name, email: user.email, role: user.role },
    media: media.map((m) => ({
      ...m,
      size: Number(m.size),
      available: Boolean(m.available),
      set_ids: memberships.get(m.id) ?? [],
      source_ids: sourceMembership
        .filter((s) => s.media_id === m.id)
        .map((s) => s.folder_id),
      parent_ids: locations.find((l) => l.media_id === m.id)?.parent_ids ?? [],
    })),
    tag_colors: Object.fromEntries(
      definitions.map((tag) => [tag.name, tag.color])
    ),
    sets,
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
          .map((source) => source.last_synced_at)
          .filter((date): date is string => Boolean(date))
          .sort()
          .at(-1) ?? null,
    },
  }
}
async function owned(userId: string, kind: "media" | "set", target: string) {
  const [item] = await rows<{ id: string }>(
    `SELECT id FROM ${kind === "media" ? "media" : "media_set"} WHERE id=? AND user_id=?`,
    [target, userId]
  )
  if (!item) throw new Response("Item not found.", { status: 404 })
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
        "INSERT INTO drive_folder (user_id,folder_id,folder_name) VALUES (?,?,?) ON DUPLICATE KEY UPDATE folder_name=VALUES(folder_name)",
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
  if (action === "tag-color") {
    const value = z
      .object({
        name: z.string().trim().min(1).max(50),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      })
      .parse(input)
    await pool.execute(
      "UPDATE tag_definition SET color=? WHERE user_id=? AND name=?",
      [value.color, userId, value.name]
    )
    return { ok: true }
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
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const [media] = await connection.query<import("mysql2").RowDataPacket[]>(
        "SELECT id FROM media WHERE id=? AND user_id=? AND available=TRUE FOR UPDATE",
        [value.id, userId]
      )
      if (!media.length) throw new Error("This media is no longer available.")
      const setId = value.setId ?? randomUUID()
      if (value.setId) {
        const [sets] = await connection.query<import("mysql2").RowDataPacket[]>(
          "SELECT id FROM media_set WHERE id=? AND user_id=? FOR UPDATE",
          [setId, userId]
        )
        if (!sets.length) throw new Error("This set is no longer available.")
      } else {
        await connection.execute(
          "INSERT INTO media_set (id,user_id,display_name,raw_name,tags,created_at) VALUES (?,?,?,?,?,NOW(3))",
          [setId, userId, value.displayName!, value.displayName!, "[]"]
        )
      }
      if (value.remove)
        await connection.execute(
          "DELETE FROM set_member WHERE set_id=? AND media_id=?",
          [setId, value.id]
        )
      else
        await connection.execute(
          "INSERT IGNORE INTO set_member (set_id,media_id) VALUES (?,?)",
          [setId, value.id]
        )
      await connection.commit()
      return { id: setId }
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }
  if (action === "create-set") {
    const value = newSet.parse(input),
      setId = randomUUID()
    await pool.execute(
      "INSERT INTO media_set (id,user_id,display_name,raw_name,tags,created_at) VALUES (?,?,?,?,?,NOW(3))",
      [
        setId,
        userId,
        value.displayName,
        value.displayName,
        JSON.stringify(value.tags),
      ]
    )
    await ensureTags(userId, value.tags)
    return { id: setId }
  }
  if (action === "add-tags") {
    const value = addMediaTags.parse(input)
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const [media] = await connection.query<import("mysql2").RowDataPacket[]>(
        `SELECT id,tags FROM media WHERE user_id=? AND available=TRUE AND id IN (${value.ids.map(() => "?").join(",")}) ORDER BY id FOR UPDATE`,
        [userId, ...value.ids]
      )
      if (media.length !== value.ids.length)
        throw new Error(
          "Some selected media is no longer available. Refresh and try again."
        )
      await ensureTags(userId, value.tags, connection)
      for (const item of media) {
        const merged = tags.parse([...new Set([...item.tags, ...value.tags])])
        await connection.execute(
          "UPDATE media SET tags=? WHERE id=? AND user_id=?",
          [JSON.stringify(merged), item.id, userId]
        )
      }
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
    return { count: value.ids.length }
  }
  if (action === "remove-tag") {
    const value = removeMediaTag.parse(input)
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const [media] = await connection.query<import("mysql2").RowDataPacket[]>(
        "SELECT tags FROM media WHERE user_id=? AND id=? AND available=TRUE FOR UPDATE",
        [userId, value.id]
      )
      if (!media.length) throw new Error("This media is no longer available.")
      await connection.execute(
        "UPDATE media SET tags=? WHERE id=? AND user_id=?",
        [
          JSON.stringify(
            media[0].tags.filter((tag: string) => tag !== value.tag)
          ),
          value.id,
          userId,
        ]
      )
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
    return { ok: true }
  }
  if (action === "metadata") {
    const value = metadata.parse(input)
    await owned(userId, value.kind, value.id)
    if (value.kind === "media" && value.setIds)
      for (const setId of value.setIds) await owned(userId, "set", setId)
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.execute(
        `UPDATE ${value.kind === "media" ? "media" : "media_set"} SET display_name=?,${value.tags ? "tags=?," : ""}created_at=? WHERE id=? AND user_id=?`,
        [
          value.displayName,
          ...(value.tags ? [JSON.stringify(value.tags)] : []),
          new Date(value.createdAt),
          value.id,
          userId,
        ]
      )
      if (value.tags) await ensureTags(userId, value.tags, connection)
      if (value.kind === "media" && value.setIds) {
        await connection.execute("DELETE FROM set_member WHERE media_id=?", [
          value.id,
        ])
        for (const setId of new Set(value.setIds))
          await connection.execute(
            "INSERT INTO set_member (set_id,media_id) VALUES (?,?)",
            [setId, value.id]
          )
      }
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
    return { ok: true }
  }
  if (action === "create-post") {
    const value = newPost.parse(input)
    await owned(userId, value.kind, value.targetId)
    await pool.execute(
      "INSERT INTO post (id,user_id,media_id,set_id,platform,url,external_id,created_at) VALUES (?,?,?,?,?,?,?,?)",
      [
        randomUUID(),
        userId,
        value.kind === "media" ? value.targetId : null,
        value.kind === "set" ? value.targetId : null,
        value.platform,
        value.url,
        value.externalId,
        new Date(value.createdAt),
      ]
    )
    return { ok: true }
  }
  if (action === "delete-post") {
    const target = id.parse((input as { id: unknown }).id)
    await pool.execute("DELETE FROM post WHERE id=? AND user_id=?", [
      target,
      userId,
    ])
    return { ok: true }
  }
  if (action === "delete-set") {
    const target = id.parse((input as { id: unknown }).id)
    await pool.execute("DELETE FROM media_set WHERE id=? AND user_id=?", [
      target,
      userId,
    ])
    return { ok: true }
  }
  throw new Response("Unknown action.", { status: 404 })
}

// Source edits share the sync lock, so an in-flight scan cannot restore an unlinked folder.
async function editSources(
  userId: string,
  edit: (connection: import("mysql2/promise").PoolConnection) => Promise<void>
) {
  const connection = await pool.getConnection()
  try {
    const [lock] = await connection.query<any[]>(
      "SELECT GET_LOCK(?, 0) AS acquired",
      [`drive:${userId}`]
    )
    if (lock[0].acquired !== 1)
      throw new Error("Drive is syncing. Try again when it finishes.")
    await connection.beginTransaction()
    try {
      await edit(connection)
      await connection.execute(
        "INSERT INTO drive_sync_state(user_id) VALUES (?) ON DUPLICATE KEY UPDATE watch_next_check=NOW(3)",
        [userId]
      )
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    }
  } finally {
    await connection.query("SELECT RELEASE_LOCK(?)", [`drive:${userId}`])
    connection.release()
  }
}
