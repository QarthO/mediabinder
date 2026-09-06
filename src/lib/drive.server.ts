import {
  catalogTransaction,
  resolveCatalog,
  withDriveLock,
} from "./catalog.server"
import { runServer } from "@/effect/runtime.server"
import { Effect } from "effect"
import { jsonRequest } from "@/effect/http"
import { randomUUID } from "node:crypto"
import { auth } from "./auth.server"
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
}
export async function driveToken(headers?: Headers, userId?: string) {
  return runServer(
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: () =>
          auth.api.getAccessToken({
            ...(headers ? { headers } : {}),
            body: { providerId: "google", ...(userId ? { userId } : {}) },
          }),
        catch: () => new Error("Reconnect Google Drive in settings."),
      })
      if (!result.accessToken)
        return yield* Effect.fail(
          new Error("Reconnect Google Drive in settings.")
        )
      return result.accessToken
    }).pipe(Effect.withSpan("drive.token"))
  )
}

export async function driveJson<T>(
  token: string,
  path: string,
  params: Record<string, string> = {}
): Promise<T> {
  return runServer(
    jsonRequest<T>(
      `https://www.googleapis.com/drive/v3/${path}?${new URLSearchParams(params)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        errorMessage: (status) =>
          status === 401
            ? "Google access expired. Reconnect Google Drive in settings."
            : status === 403
              ? "Google Drive denied access. Check the Drive API and folder permissions."
              : status === 404
                ? "This file or folder is no longer available in Google Drive."
                : `Google Drive is unavailable (${status}). Try again.`,
      }
    )
  )
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
export async function syncDrive(userId: string, headers?: Headers) {
  const token = await driveToken(headers, userId)
  return withDriveLock(userId, async (connection) => {
    const [sources] = await connection.query<import("mysql2").RowDataPacket[]>(
      "SELECT folder_id FROM drive_folder WHERE user_id = ?",
      [userId]
    )
    if (!sources.length)
      throw new Error("Choose a Google Drive folder in settings first.")
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
              "nextPageToken,files(id,name,mimeType,createdTime,size,parents,sha256Checksum,imageMediaMetadata,videoMediaMetadata)",
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
    await catalogTransaction(async (connection) => {
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
        const catalogId = await resolveCatalog(connection, file)
        const captured = file.imageMediaMetadata?.time
          ?.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3")
          .replace(" ", "T")
        const created =
          captured && !Number.isNaN(Date.parse(captured))
            ? new Date(captured)
            : new Date(file.createdTime)
        const dimensions = file.imageMediaMetadata ?? file.videoMediaMetadata
        await connection.execute(
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
      }
      for (const file of files) {
        await connection.execute(
          "INSERT INTO media_location(media_id,parent_ids) SELECT id,? FROM media WHERE user_id=? AND drive_id=? ON DUPLICATE KEY UPDATE parent_ids=VALUES(parent_ids)",
          [JSON.stringify(file.parents ?? []), userId, file.id]
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
    }, connection)
    return { count: files.length }
  })
}
