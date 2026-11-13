import { randomUUID } from "node:crypto"
import { afterEach, expect, test, vi } from "vite-plus/test"

import { describeMysql, useTestDatabase } from "@/test/database"
import {
  count,
  insertFolder,
  newUser,
  routeHandler,
  stubAccessToken,
  stubGoogle,
} from "@/test/fixtures"
import { runAppEffect } from "@/effect/runtime.server"
import { Route } from "@/routes/api.drive.webhook"
import { pool, rows } from "./database.server"
import * as DriveWebhook from "./drive-webhook.server"

// The module is Effects; these run them on the app runtime like the worker.
const receiveDriveNotification = (headers: Headers) =>
  runAppEffect("test", DriveWebhook.receive(headers))
const maintainWatches = (userId: string) =>
  runAppEffect("test", DriveWebhook.maintainWatches(userId))
const processSyncJobs = (userId?: string) =>
  runAppEffect("test", DriveWebhook.processSyncJobs(userId))
const queueDriveSync = (userId: string) =>
  runAppEffect("test", DriveWebhook.queueSync(userId))

type Channel = { id: string; token: string }

const notification = (
  channel: Channel,
  options: { state?: string; message?: string; resource?: string } = {}
) =>
  new Headers({
    "x-goog-channel-id": channel.id,
    "x-goog-channel-token": channel.token,
    "x-goog-resource-id": options.resource ?? "test-resource",
    "x-goog-resource-state": options.state ?? "change",
    "x-goog-message-number": options.message ?? "2",
  })

// Google's push notifications: only a registered channel with its secret may
// queue a sync, and a failing sync must never hide media.
describeMysql("drive webhooks", () => {
  useTestDatabase()
  const google = stubGoogle()
  stubAccessToken(() => "test-access-token")
  afterEach(() => vi.unstubAllEnvs())

  // A fake Drive that accepts watch registrations (sending Google's early
  // "sync" handshake before the registration returns, as it does), lists one
  // photo, and can be made to fail scans.
  function drive() {
    vi.stubEnv("DRIVE_WEBHOOK_URL", "")
    vi.stubEnv("MEDIABINDER_URL", "https://example.com")
    const state = {
      channels: [] as Channel[],
      stopped: [] as string[],
      failScan: false,
    }
    google(async (url, init) => {
      expect(url.hostname).toBe("www.googleapis.com")
      if (url.pathname.endsWith("/changes/startPageToken"))
        return Response.json({ startPageToken: "start" })
      if (url.pathname.endsWith("/changes/watch")) {
        const channel = JSON.parse(String(init.body)) as Channel & {
          address: string
        }
        expect(channel.address).toBe("https://example.com/api/drive/webhook")
        const handshake = await receiveDriveNotification(
          notification(channel, { state: "sync", message: "1" })
        )
        expect(handshake).toBe(204)
        state.channels.push(channel)
        return Response.json({
          resourceId: "test-resource",
          expiration: String(Date.now() + 7 * 86400000),
        })
      }
      if (url.pathname.endsWith("/channels/stop")) {
        state.stopped.push(JSON.parse(String(init.body)).id)
        return new Response(null, { status: 204 })
      }
      if (url.pathname.endsWith("/files/root")) return Response.json({})
      if (url.pathname.endsWith("/files"))
        return state.failScan
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
      throw new Error(`Unexpected URL: ${url.pathname}`)
    })
    return state
  }

  async function watched() {
    const user = newUser()
    const state = drive()
    await insertFolder(user.id, "root", "Root")
    await maintainWatches(user.id)
    return { user, state, channel: state.channels[0] }
  }
  const requested = async (userId: string) =>
    (
      await rows<{ requested: number }>(
        "SELECT requested FROM drive_sync_state WHERE user_id=?",
        [userId]
      )
    )[0]?.requested

  test("a forged token, a wrong resource and an unknown channel are refused", async () => {
    const { user, channel } = await watched()

    expect(
      await receiveDriveNotification(
        notification({ ...channel, token: "forged" })
      )
    ).toBe(403)
    expect(
      await receiveDriveNotification(
        notification(channel, { resource: "wrong" })
      )
    ).toBe(403)
    expect(
      await receiveDriveNotification(
        notification({ id: randomUUID(), token: channel.token })
      )
    ).toBe(403)
    // Nothing was queued by any of them.
    expect(await requested(user.id)).toBe(1)
  })

  test("the webhook route answers with the notification's status", async () => {
    const { channel } = await watched()
    const handler = routeHandler<{ request: Request }>(Route, "POST")
    const post = (headers: Headers) =>
      handler({
        request: new Request("https://example.com/api/drive/webhook", {
          method: "POST",
          headers,
        }),
      })

    expect((await post(notification(channel))).status).toBe(204)
    expect(
      (await post(notification({ ...channel, token: "forged" }))).status
    ).toBe(403)
  })

  test("malformed notifications are rejected as bad requests", async () => {
    const { channel } = await watched()

    expect(
      await receiveDriveNotification(notification(channel, { state: "bogus" }))
    ).toBe(400)
    expect(
      await receiveDriveNotification(notification(channel, { message: "x" }))
    ).toBe(400)
    expect(
      await receiveDriveNotification(
        notification({ ...channel, token: "t".repeat(257) })
      )
    ).toBe(400)
  })

  test("a changed notification queues one sync, and a repeat of the same message adds nothing", async () => {
    const { user, channel } = await watched()
    const before = (await requested(user.id)) ?? 0

    expect(await receiveDriveNotification(notification(channel))).toBe(204)
    expect(await receiveDriveNotification(notification(channel))).toBe(204)

    expect(await requested(user.id)).toBe(before + 1)
  })

  test("a queued sync makes the media available", async () => {
    const { user, channel } = await watched()
    await receiveDriveNotification(notification(channel))

    await processSyncJobs(user.id)

    expect(
      await rows("SELECT available FROM media WHERE user_id=?", [user.id])
    ).toEqual([{ available: 1 }])
    const [job] = await rows<{ requested: number; completed: number }>(
      "SELECT requested,completed FROM drive_sync_state WHERE user_id=?",
      [user.id]
    )
    expect(job.completed).toBe(job.requested)
  })

  test("a failing sync is retried later and keeps the media it already has", async () => {
    const { user, state } = await watched()
    await processSyncJobs(user.id)
    await queueDriveSync(user.id)
    state.failScan = true

    await processSyncJobs(user.id)

    const [job] = await rows<{
      attempts: number
      requested: number
      completed: number
    }>(
      "SELECT attempts,requested,completed FROM drive_sync_state WHERE user_id=?",
      [user.id]
    )
    expect(job.attempts).toBe(1)
    expect(job.requested).toBeGreaterThan(job.completed)
    expect(
      await rows("SELECT available FROM media WHERE user_id=?", [user.id])
    ).toEqual([{ available: 1 }])
  })

  test("renewal replaces an expiring channel, and the old one stops being accepted", async () => {
    const { user, state, channel } = await watched()
    await pool.execute(
      "UPDATE drive_watch SET expires_at=DATE_ADD(NOW(3),INTERVAL 1 HOUR) WHERE user_id=?",
      [user.id]
    )

    await maintainWatches(user.id)

    expect(state.channels).toHaveLength(2)
    expect(state.stopped).toEqual([channel.id])
    expect(
      await receiveDriveNotification(notification(channel, { message: "3" }))
    ).toBe(403)
    expect(
      await receiveDriveNotification(
        notification(state.channels[1], { message: "3" })
      )
    ).toBe(204)
  })

  test("unlinking every folder stops the channel", async () => {
    const { user, state, channel } = await watched()
    await pool.execute("DELETE FROM drive_folder WHERE user_id=?", [user.id])

    await maintainWatches(user.id)

    expect(state.stopped).toEqual([channel.id])
    expect(await count("drive_watch WHERE user_id=?", [user.id])).toBe(0)
  })

  // Only one worker may work at a time, across containers: a pass that can't
  // take the lock must leave the queue alone.
  test("a worker pass works through due syncs, and does nothing while another worker holds the lock", async () => {
    const { user, channel } = await watched()
    await receiveDriveNotification(notification(channel))
    const pass = () => runAppEffect("test", DriveWebhook.pass)

    const other = await pool.getConnection()
    try {
      await other.query("SELECT GET_LOCK(?, 0)", [
        DriveWebhook.DRIVE_WORKER_LOCK,
      ])
      expect(await pass()).toBe("idle")
      expect(await count("media WHERE user_id=?", [user.id])).toBe(0)
    } finally {
      await other.query("SELECT RELEASE_LOCK(?)", [
        DriveWebhook.DRIVE_WORKER_LOCK,
      ])
      other.release()
    }

    expect(await pass()).toBe("worked")
    expect(await count("media WHERE user_id=?", [user.id])).toBe(1)
    expect(await pass()).toBe("idle")
  })
})
