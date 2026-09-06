import { test, after, mock } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { auth } from "../src/lib/auth.server"
import { pool, rows } from "../src/lib/database.server"
import {
  maintainWatches,
  receiveDriveNotification,
  processSyncJobs,
  queueDriveSync,
} from "../src/lib/drive-webhook.server"
after(() => pool.end())
test("Drive webhooks handle early handshakes, validation, duplicates, renewal and retry without losing media", async () => {
  const userId = randomUUID(),
    connection = await pool.getConnection()
  const originalUrl = process.env.DRIVE_WEBHOOK_URL
  const registrations: { id: string; token: string }[] = []
  let failScan = false,
    stops = 0
  const headers = (
    channel: { id: string; token: string },
    state = "change",
    message = "2"
  ) =>
    new Headers({
      "x-goog-channel-id": channel.id,
      "x-goog-channel-token": channel.token,
      "x-goog-resource-id": "test-resource",
      "x-goog-resource-state": state,
      "x-goog-message-number": message,
    })
  await connection.query("SELECT GET_LOCK('mediabinder-drive-worker',30)")
  process.env.DRIVE_WEBHOOK_URL = "https://example.com/api/drive/webhook"
  mock.method(auth.api, "getAccessToken", async () => ({
    accessToken: "test-access-token",
  }))
  mock.method(
    globalThis,
    "fetch",
    async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      assert.equal(url.hostname, "www.googleapis.com")
      if (url.pathname.endsWith("/changes/startPageToken"))
        return Response.json({ startPageToken: "start" })
      if (url.pathname.endsWith("/changes/watch")) {
        const channel = JSON.parse(String(init?.body))
        assert.equal(channel.address, process.env.DRIVE_WEBHOOK_URL)
        assert.equal(url.searchParams.get("pageToken"), "start")
        assert.equal(
          await receiveDriveNotification(headers(channel, "sync", "1")),
          204
        )
        registrations.push(channel)
        return Response.json({
          resourceId: "test-resource",
          expiration: String(Date.now() + 7 * 86400000),
        })
      }
      if (url.pathname.endsWith("/channels/stop")) {
        stops++
        return new Response(null, { status: 204 })
      }
      if (url.pathname.endsWith("/files/root")) return Response.json({})
      if (url.pathname.endsWith("/files"))
        return failScan
          ? new Response(null, { status: 503 })
          : Response.json({
              files: [
                {
                  id: "fixture",
                  name: "fixture.jpg",
                  mimeType: "image/jpeg",
                  createdTime: "2026-09-06T00:00:00Z",
                  parents: ["root"],
                },
              ],
            })
      throw new Error(`Unexpected test URL: ${url.pathname}`)
    }
  )
  try {
    await pool.execute(
      "INSERT INTO drive_folder(user_id,folder_id,folder_name) VALUES (?,'root','Root')",
      [userId]
    )
    await maintainWatches(userId)
    assert.equal(registrations.length, 1)
    const channel = registrations[0]
    assert.equal(
      await receiveDriveNotification(headers({ ...channel, token: "forged" })),
      403
    )
    const wrongResource = headers(channel)
    wrongResource.set("x-goog-resource-id", "wrong")
    assert.equal(await receiveDriveNotification(wrongResource), 403)
    assert.equal(await receiveDriveNotification(headers(channel)), 204)
    assert.equal(await receiveDriveNotification(headers(channel)), 204)
    const [state] = await rows<{ requested: number }>(
      "SELECT requested FROM drive_sync_state WHERE user_id=?",
      [userId]
    )
    assert.equal(state.requested, 2)
    await processSyncJobs(userId)
    const [media] = await rows<{ id: string; available: number }>(
      "SELECT id,available FROM media WHERE user_id=?",
      [userId]
    )
    assert.equal(media.available, 1)
    await queueDriveSync(userId)
    failScan = true
    await processSyncJobs(userId)
    const [retry] = await rows<{
      attempts: number
      requested: number
      completed: number
    }>(
      "SELECT attempts,requested,completed FROM drive_sync_state WHERE user_id=?",
      [userId]
    )
    assert.equal(retry.attempts, 1)
    assert.ok(retry.requested > retry.completed)
    assert.equal(
      (
        await rows<{ available: number }>(
          "SELECT available FROM media WHERE id=?",
          [media.id]
        )
      )[0].available,
      1
    )
    await pool.execute(
      "UPDATE drive_watch SET expires_at=DATE_ADD(NOW(3),INTERVAL 1 HOUR) WHERE user_id=?",
      [userId]
    )
    await maintainWatches(userId)
    assert.equal(registrations.length, 2)
    assert.equal(stops, 1)
    assert.equal(
      await receiveDriveNotification(headers(channel, "change", "3")),
      403
    )
    await pool.execute("DELETE FROM drive_folder WHERE user_id=?", [userId])
    await maintainWatches(userId)
    assert.equal(stops, 2)
  } finally {
    mock.restoreAll()
    if (originalUrl === undefined) delete process.env.DRIVE_WEBHOOK_URL
    else process.env.DRIVE_WEBHOOK_URL = originalUrl
    await pool.execute("DELETE FROM drive_watch WHERE user_id=?", [userId])
    await pool.execute("DELETE FROM drive_folder WHERE user_id=?", [userId])
    await pool.execute("DELETE FROM media WHERE user_id=?", [userId])
    await pool.execute("DELETE FROM drive_sync_state WHERE user_id=?", [userId])
    await connection.query("SELECT RELEASE_LOCK('mediabinder-drive-worker')")
    connection.release()
  }
})
