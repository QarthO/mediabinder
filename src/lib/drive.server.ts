import { randomUUID } from "node:crypto"
import { auth } from "./auth.server"
import { pool, rows } from "./database.server"
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
  thumbnailLink?: string
}
export async function driveToken(headers: Headers) {
  const result = await auth.api.getAccessToken({
    headers,
    body: { providerId: "google" },
  })
  if (!result.accessToken)
    throw new Error("Reconnect Google Drive in settings.")
  return result.accessToken
}
export async function driveJson<T>(
  token: string,
  path: string,
  params: Record<string, string> = {}
): Promise<T> {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/${path}?${new URLSearchParams(params)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    }
  )
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? "Google access expired. Reconnect Google Drive in settings."
        : response.status === 403
          ? "Google Drive denied access. Check the Drive API and folder permissions."
          : response.status === 404
            ? "This file or folder is no longer available in Google Drive."
            : `Google Drive is unavailable (${response.status}). Try again.`
    )
  return response.json()
}
export async function listFolders(headers: Headers) {
  const token = await driveToken(headers)
  const folders: { id: string; name: string }[] = []
  let pageToken = ""
  do {
    const page = await driveJson<{
      files: { id: string; name: string }[]
      nextPageToken?: string
    }>(token, "files", {
      q: "trashed = false and mimeType = 'application/vnd.google-apps.folder'",
      fields: "nextPageToken,files(id,name)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      ...(pageToken ? { pageToken } : {}),
    })
    folders.push(...page.files)
    pageToken = page.nextPageToken ?? ""
  } while (pageToken)
  return folders.sort((a, b) => a.name.localeCompare(b.name))
}
export async function syncDrive(userId: string, headers: Headers) {
  const connection = await pool.getConnection()
  const lockName = `drive:${userId}`
  try {
    const [lock] = await connection.query<any[]>(
      "SELECT GET_LOCK(?, 0) AS acquired",
      [lockName]
    )
    if (lock[0].acquired !== 1)
      throw new Error("A sync is already running. Try again shortly.")
    const sources = await rows<{ folder_id: string }>(
      "SELECT folder_id FROM drive_folder WHERE user_id = ?",
      [userId]
    )
    if (!sources.length)
      throw new Error("Choose a Google Drive folder in settings first.")
    const token = await driveToken(headers)
    const sourceFiles = new Map<string, DriveFile[]>()
    for (const source of sources) {
      const pending = [source.folder_id],
        visited = new Set<string>(),
        files: DriveFile[] = []
      while (pending.length) {
        const parent = pending.shift()!
        if (visited.has(parent)) continue
        visited.add(parent)
        let pageToken = ""
        do {
          const page = await driveJson<{
            files: DriveFile[]
            nextPageToken?: string
          }>(token, "files", {
            q: `'${parent}' in parents and trashed = false and (mimeType contains 'image/' or mimeType contains 'video/' or mimeType = 'application/vnd.google-apps.folder')`,
            fields:
              "nextPageToken,files(id,name,mimeType,createdTime,size,imageMediaMetadata,videoMediaMetadata)",
            pageSize: "1000",
            supportsAllDrives: "true",
            includeItemsFromAllDrives: "true",
            ...(pageToken ? { pageToken } : {}),
          })
          for (const file of page.files) {
            if (file.mimeType === "application/vnd.google-apps.folder")
              pending.push(file.id)
            else files.push(file)
          }
          pageToken = page.nextPageToken ?? ""
        } while (pageToken)
      }
      sourceFiles.set(source.folder_id, files)
    }
    const files = [
      ...new Map(
        [...sourceFiles.values()].flat().map((file) => [file.id, file])
      ).values(),
    ]
    // Only reconcile after every Drive page succeeds; failures preserve the catalog.
    await connection.beginTransaction()
    try {
      const [current] = await connection.query<any[]>(
        "SELECT folder_id FROM drive_folder WHERE user_id = ? FOR UPDATE",
        [userId]
      )
      if (
        current.length !== sources.length ||
        current.some((row) => !sourceFiles.has(row.folder_id))
      )
        throw new Error("The source folder changed. Run sync again.")
      await connection.execute(
        "UPDATE media SET available = FALSE WHERE user_id = ?",
        [userId]
      )
      await connection.execute("DELETE FROM media_source WHERE user_id=?", [
        userId,
      ])
      for (const file of files) {
        const captured = file.imageMediaMetadata?.time
          ?.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3")
          .replace(" ", "T")
        const created =
          captured && !Number.isNaN(Date.parse(captured))
            ? new Date(captured)
            : new Date(file.createdTime)
        const dimensions = file.imageMediaMetadata ?? file.videoMediaMetadata
        await connection.execute(
          `INSERT INTO media (id,user_id,drive_id,display_name,raw_name,mime_type,tags,created_at,uploaded_at,size,width,height,duration_ms,available,synced_at)
          VALUES (?,?,?,?,?,?,?, ?,?,?,?,?,?,TRUE,NOW(3)) ON DUPLICATE KEY UPDATE raw_name=VALUES(raw_name),mime_type=VALUES(mime_type),size=VALUES(size),width=VALUES(width),height=VALUES(height),duration_ms=VALUES(duration_ms),available=TRUE,synced_at=NOW(3)`,
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
          ]
        )
      }
      for (const [folderId, members] of sourceFiles) {
        for (const file of members) {
          await connection.execute(
            "INSERT IGNORE INTO media_source (user_id,folder_id,media_id) SELECT user_id,?,id FROM media WHERE user_id=? AND drive_id=?",
            [folderId, userId, file.id]
          )
        }
      }
      await connection.execute(
        "UPDATE drive_folder SET last_synced_at = NOW(3) WHERE user_id = ?",
        [userId]
      )
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    }
    return { count: files.length }
  } finally {
    await connection.query("SELECT RELEASE_LOCK(?)", [lockName])
    connection.release()
  }
}
