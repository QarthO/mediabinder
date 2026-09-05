import { randomUUID } from "node:crypto"
import { pool, rows } from "./database.server"
import type { Library, Media, MediaSet, Post } from "./types"
import { metadata, newPost, newSet, folder, id } from "./validation"
import { driveJson, driveToken, listFolders, syncDrive } from "./drive.server"
export async function library(
  user: Library["user"] & { id: string }
): Promise<Library> {
  const [media, sets, posts, sources, membership] = await Promise.all([
    rows<Media>(
      "SELECT m.*, (SELECT COUNT(*) FROM post p WHERE p.media_id=m.id) AS post_count FROM media m WHERE user_id=? ORDER BY uploaded_at DESC",
      [user.id]
    ),
    rows<MediaSet>(
      `SELECT s.*, (SELECT COUNT(*) FROM set_member sm WHERE sm.set_id=s.id) AS media_count, (SELECT sm.media_id FROM set_member sm JOIN media m ON m.id=sm.media_id WHERE sm.set_id=s.id AND m.available=TRUE LIMIT 1) AS cover_id, (SELECT COUNT(*) FROM post p WHERE p.set_id=s.id) AS post_count FROM media_set s WHERE user_id=? ORDER BY created_at DESC`,
      [user.id]
    ),
    rows<Post>("SELECT * FROM post WHERE user_id=? ORDER BY created_at DESC", [
      user.id,
    ]),
    rows<Library["workspace"]>(
      "SELECT folder_id,folder_name,last_synced_at FROM drive_source WHERE user_id=?",
      [user.id]
    ),
    rows<{ set_id: string; media_id: string }>(
      "SELECT sm.* FROM set_member sm JOIN media m ON m.id=sm.media_id WHERE m.user_id=?",
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
    })),
    sets,
    posts,
    workspace: sources[0] ?? {
      folder_id: null,
      folder_name: null,
      last_synced_at: null,
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
    await pool.execute(
      "INSERT INTO drive_source (user_id,folder_id,folder_name) VALUES (?,?,?) ON DUPLICATE KEY UPDATE folder_id=VALUES(folder_id),folder_name=VALUES(folder_name),last_synced_at=NULL",
      [userId, source.id, source.name]
    )
    return { ok: true }
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
    return { id: setId }
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
        `UPDATE ${value.kind === "media" ? "media" : "media_set"} SET display_name=?,tags=?,created_at=? WHERE id=? AND user_id=?`,
        [
          value.displayName,
          JSON.stringify(value.tags),
          new Date(value.createdAt),
          value.id,
          userId,
        ]
      )
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
