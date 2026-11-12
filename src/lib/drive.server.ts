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
import type { PoolConnection } from "mysql2/promise"
import type { SyncRun } from "./types"
import {
  claimSyncRun,
  startSyncRun,
  syncStatus,
  type SyncProgress,
} from "./sync-progress.server"
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
type SyncOptions = {
  headers?: Headers
  token?: string
  origin?: SyncRun["origin"]
  // Called once the Drive lock is held and the progress row exists.
  onStarted?: (runId: string) => void
}

export async function syncDrive(userId: string, options: SyncOptions = {}) {
  const token = options.token ?? (await driveToken(options.headers, userId))
  return withDriveLock(userId, async (connection) => {
    const [sources] = await connection.query<import("mysql2").RowDataPacket[]>(
      "SELECT folder_id FROM drive_folder WHERE user_id = ?",
      [userId]
    )
    if (!sources.length)
      throw new Error("Choose a Google Drive folder in settings first.")
    const run = await startSyncRun(
      connection,
      userId,
      options.origin ?? "automatic"
    )
    options.onStarted?.(run.runId)
    try {
      const result = await reconcileDrive(
        connection,
        userId,
        token,
        sources.map((source) => source.folder_id as string),
        run.report
      )
      await run.succeed(result.count)
      return result
    } catch (error) {
      await run.fail(error)
      throw error
    }
  })
}

// Manual sync returns as soon as the run starts; the browser follows its
// progress row. Joining an in-flight run (for example a webhook sync) is not
// an error: the caller simply watches that run instead.
export async function startDriveSync(userId: string, headers: Headers) {
  const token = await driveToken(headers, userId)
  return new Promise<SyncRun | null>((resolve, reject) => {
    let started = false
    syncDrive(userId, {
      token,
      origin: "manual",
      onStarted: () => {
        started = true
        syncStatus(userId).then(resolve, reject)
      },
    }).catch(async (error: unknown) => {
      // The run row already holds the user-facing error; log for operators.
      if (started)
        return console.error(
          "Background Drive sync failed:",
          error instanceof Error ? error.message : "Unknown error"
        )
      if (error instanceof Error && error.message.startsWith("A sync")) {
        await claimSyncRun(userId).catch(() => undefined)
        const current = await syncStatus(userId).catch(() => null)
        if (current?.status === "running") return resolve(current)
      }
      reject(error)
    })
  })
}

async function reconcileDrive(
  connection: PoolConnection,
  userId: string,
  token: string,
  folderIds: string[],
  report: (progress: Partial<SyncProgress>) => void
) {
  const sourceFiles = new Map<string, DriveFile[]>()
  const found = new Set<string>()
  let foldersScanned = 0
  for (const folderId of folderIds) {
    const pending = [folderId],
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
          else {
            files.push(file)
            found.add(file.id)
          }
        }
        pageToken = page.nextPageToken ?? ""
        report({ files_found: found.size })
      } while (pageToken)
      report({ folders_scanned: ++foldersScanned })
    }
    sourceFiles.set(folderId, files)
  }
  const files = [
    ...new Map(
      [...sourceFiles.values()].flat().map((file) => [file.id, file])
    ).values(),
  ]
  report({ phase: "saving", files_total: files.length, files_saved: 0 })
  // Only reconcile after every Drive page succeeds; failures preserve the catalog.
  await catalogTransaction(async (connection) => {
    const [current] = await connection.query<any[]>(
      "SELECT folder_id FROM drive_folder WHERE user_id = ? FOR UPDATE",
      [userId]
    )
    if (
      current.length !== folderIds.length ||
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
    let saved = 0
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
      report({ files_saved: ++saved })
    }
    // Locations and folder membership are written in batches rather than one
    // statement per file.
    const [owned] = await connection.query<any[]>(
      "SELECT id,drive_id FROM media WHERE user_id=?",
      [userId]
    )
    const mediaIds = new Map<string, string>(
      owned.map((row) => [row.drive_id as string, row.id as string])
    )
    const locations = files.flatMap((file) => {
      const mediaId = mediaIds.get(file.id)
      return mediaId ? [[mediaId, JSON.stringify(file.parents ?? [])]] : []
    })
    for (const chunk of chunks(locations, 500))
      await connection.query(
        "INSERT INTO media_location(media_id,parent_ids) VALUES ? ON DUPLICATE KEY UPDATE parent_ids=VALUES(parent_ids)",
        [chunk]
      )
    const memberships = [...sourceFiles].flatMap(([folderId, members]) =>
      members.flatMap((file) => {
        const mediaId = mediaIds.get(file.id)
        return mediaId ? [[userId, folderId, mediaId]] : []
      })
    )
    for (const chunk of chunks(memberships, 500))
      await connection.query(
        "INSERT IGNORE INTO media_source (user_id,folder_id,media_id) VALUES ?",
        [chunk]
      )
    await connection.execute(
      "UPDATE drive_folder SET last_synced_at = NOW(3) WHERE user_id = ?",
      [userId]
    )
  }, connection)
  return { count: files.length }
}

function chunks<T>(items: T[], size: number) {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size)
    result.push(items.slice(index, index + size))
  return result
}
