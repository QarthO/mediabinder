import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto"
import { pool, rows } from "./database.server"
import { driveJson, driveToken, syncDrive } from "./drive.server"

export function webhookUrl() {
  if (!process.env.DRIVE_WEBHOOK_URL) return null
  const url = new URL(process.env.DRIVE_WEBHOOK_URL)
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /^(localhost|127\.|\[::1\])/.test(url.hostname)
  )
    throw new Error(
      "DRIVE_WEBHOOK_URL must be a public HTTPS URL without credentials or query parameters."
    )
  return url.href
}
export async function queueDriveSync(userId: string) {
  await pool.execute(
    `INSERT INTO drive_sync_state(user_id,requested) VALUES (?,1) ON DUPLICATE KEY UPDATE requested=requested+1,next_attempt=LEAST(next_attempt,NOW(3))`,
    [userId]
  )
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
export async function receiveDriveNotification(headers: Headers) {
  const id = headers.get("x-goog-channel-id") ?? ""
  const token = headers.get("x-goog-channel-token") ?? ""
  const message = headers.get("x-goog-message-number") ?? ""
  const resource = headers.get("x-goog-resource-id") ?? ""
  const state = headers.get("x-goog-resource-state") ?? ""
  if (
    id.length > 64 ||
    token.length > 256 ||
    !/^\d{1,65}$/.test(message) ||
    !resource ||
    ![
      "sync",
      "change",
      "update",
      "add",
      "remove",
      "trash",
      "untrash",
      "exists",
      "not_exists",
    ].includes(state)
  )
    return 400
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [channels] = await connection.query<import("mysql2").RowDataPacket[]>(
      "SELECT * FROM drive_watch WHERE id=? AND expires_at>NOW(3) FOR UPDATE",
      [id]
    )
    const channel = channels[0]
    if (
      !channel ||
      !timingSafeEqual(
        Buffer.from(hash(token)),
        Buffer.from(channel.token_hash)
      ) ||
      (channel.resource_id && channel.resource_id !== resource)
    ) {
      await connection.rollback()
      return 403
    }
    // Google's initial handshake may arrive before the watch request returns its resource ID.
    if (state === "sync") {
      await connection.commit()
      return 204
    }
    if (!channel.resource_id) {
      await connection.rollback()
      return 503
    }
    if (BigInt(message) <= BigInt(channel.last_message)) {
      await connection.commit()
      return 204
    }
    await connection.execute(
      "UPDATE drive_watch SET last_message=? WHERE id=?",
      [message, id]
    )
    await connection.execute(
      "INSERT INTO drive_sync_state(user_id,requested) VALUES (?,1) ON DUPLICATE KEY UPDATE requested=requested+1,next_attempt=LEAST(next_attempt,NOW(3))",
      [channel.user_id]
    )
    await connection.commit()
    return 204
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}
async function drivePost<T>(
  token: string,
  path: string,
  body: unknown,
  params: Record<string, string> = {}
): Promise<T> {
  const result = await fetch(
    `https://www.googleapis.com/drive/v3/${path}?${new URLSearchParams(params)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    }
  )
  if (!result.ok)
    throw new Error(
      `Drive watch request failed (${result.status}). Check OAuth access, Drive permissions, and the public webhook URL.`
    )
  return result.status === 204 ? (undefined as T) : result.json()
}
async function stopWatch(
  token: string,
  channel: { id: string; resource_id: string | null }
) {
  if (channel.resource_id) {
    try {
      await drivePost(token, "channels/stop", {
        id: channel.id,
        resourceId: channel.resource_id,
      })
    } catch {
      /* Expired channels may already be gone; local validation rejects retired IDs. */
    }
  }
  await pool.execute("DELETE FROM drive_watch WHERE id=?", [channel.id])
}
export async function maintainWatches(userId: string) {
  const callback = webhookUrl()
  const sources = await rows<{ folder_id: string }>(
    "SELECT folder_id FROM drive_folder WHERE user_id=?",
    [userId]
  )
  if (!callback) return
  const token = await driveToken(undefined, userId)
  const scopes = new Set<string>()
  if (sources.length) scopes.add("")
  for (const source of sources) {
    const folder = await driveJson<{ driveId?: string }>(
      token,
      `files/${source.folder_id}`,
      { fields: "driveId", supportsAllDrives: "true" }
    )
    if (folder.driveId) scopes.add(folder.driveId)
  }
  const channels = await rows<{
    id: string
    scope: string
    resource_id: string | null
    callback_url: string
    expires_at: string
  }>(
    "SELECT id,scope,resource_id,callback_url,expires_at FROM drive_watch WHERE user_id=?",
    [userId]
  )
  for (const scope of scopes) {
    if (
      channels.some(
        (channel) =>
          channel.scope === scope &&
          channel.resource_id &&
          channel.callback_url === callback &&
          Date.parse(channel.expires_at.replace(" ", "T") + "Z") >
            Date.now() + 86400000
      )
    )
      continue
    const params = {
      supportsAllDrives: "true",
      ...(scope ? { driveId: scope } : {}),
    }
    const start = await driveJson<{ startPageToken: string }>(
      token,
      "changes/startPageToken",
      params
    )
    const id = randomUUID(),
      secret = randomBytes(32).toString("hex")
    await pool.execute(
      "INSERT INTO drive_watch(id,user_id,scope,token_hash,callback_url,expires_at) VALUES (?,?,?,?,?,?)",
      [
        id,
        userId,
        scope,
        hash(secret),
        callback,
        new Date(Date.now() + 7 * 86400000),
      ]
    )
    try {
      const result = await drivePost<{
        resourceId: string
        expiration: string
      }>(
        token,
        "changes/watch",
        {
          id,
          type: "web_hook",
          address: callback,
          token: secret,
          expiration: String(Date.now() + 7 * 86400000),
        },
        {
          ...params,
          includeItemsFromAllDrives: "true",
          pageToken: start.startPageToken,
        }
      )
      if (!result.resourceId || !Number.isFinite(Number(result.expiration)))
        throw new Error("Google returned an invalid watch registration.")
      await pool.execute(
        "UPDATE drive_watch SET resource_id=?,expires_at=? WHERE id=?",
        [result.resourceId, new Date(Number(result.expiration)), id]
      )
      // A full reconciliation after registration covers the gap around the initial handshake.
      await queueDriveSync(userId)
      for (const old of channels.filter((channel) => channel.scope === scope))
        await stopWatch(token, old)
    } catch (error) {
      await pool.execute("DELETE FROM drive_watch WHERE id=?", [id])
      throw error
    }
  }
  for (const old of channels.filter((channel) => !scopes.has(channel.scope)))
    await stopWatch(token, old)
}
export async function processSyncJobs(userId?: string) {
  const jobs = await rows<{
    user_id: string
    requested: number
    attempts: number
  }>(
    "SELECT user_id,requested,attempts FROM drive_sync_state WHERE requested>completed AND next_attempt<=NOW(3)" +
      (userId ? " AND user_id=?" : "") +
      " LIMIT 20",
    userId ? [userId] : []
  )
  for (const job of jobs) {
    try {
      const sources = await rows(
        "SELECT folder_id FROM drive_folder WHERE user_id=?",
        [job.user_id]
      )
      if (sources.length) await syncDrive(job.user_id)
      await pool.execute(
        "UPDATE drive_sync_state SET completed=?,attempts=0,last_error=NULL WHERE user_id=?",
        [job.requested, job.user_id]
      )
    } catch (error) {
      const delay = Math.min(3600, 10 * 2 ** Math.min(job.attempts, 9))
      await pool.execute(
        "UPDATE drive_sync_state SET attempts=attempts+1,last_error=?,next_attempt=DATE_ADD(NOW(3),INTERVAL ? SECOND) WHERE user_id=?",
        [
          error instanceof Error ? error.message.slice(0, 1000) : "Sync failed",
          delay,
          job.user_id,
        ]
      )
    }
  }
}
export async function processWatchRenewals() {
  if (!process.env.DRIVE_WEBHOOK_URL) return
  await pool.execute(
    "INSERT IGNORE INTO drive_sync_state(user_id) SELECT DISTINCT user_id FROM drive_folder"
  )
  const users = await rows<{ user_id: string }>(
    "SELECT user_id FROM drive_sync_state WHERE watch_next_check<=NOW(3) LIMIT 20"
  )
  for (const user of users) {
    try {
      await maintainWatches(user.user_id)
      await pool.execute(
        "UPDATE drive_sync_state SET watch_next_check=DATE_ADD(NOW(3),INTERVAL 6 HOUR),watch_error=NULL WHERE user_id=?",
        [user.user_id]
      )
    } catch (error) {
      await pool.execute(
        "UPDATE drive_sync_state SET watch_next_check=DATE_ADD(NOW(3),INTERVAL 10 MINUTE),watch_error=? WHERE user_id=?",
        [
          error instanceof Error
            ? error.message.slice(0, 1000)
            : "Watch registration failed",
          user.user_id,
        ]
      )
    }
  }
}
