import { randomBytes } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { expect, test } from "vite-plus/test"

import { describeMysql, useTestDatabase } from "@/test/database"
import {
  insertFolder,
  newUser,
  stubAccessToken,
  stubGoogle,
} from "@/test/fixtures"
import { pool } from "./database.server"
import { startDriveSync, syncDrive } from "./drive.server"
import { syncStatus } from "./sync-progress.server"

const FOLDER = "application/vnd.google-apps.folder"
const files = (parent: string, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `${parent}-f${i}`,
    name: `IMG_${i}.jpg`,
    mimeType: "image/jpeg",
    createdTime: "2026-09-01T00:00:00Z",
    size: "42",
    parents: [parent],
    sha256Checksum: randomBytes(32).toString("hex"),
  }))

// Background syncs: one run per user, visible progress, and a run whose
// process died is reported as failed rather than running forever.
describeMysql("sync progress", () => {
  useTestDatabase()
  const google = stubGoogle()
  stubAccessToken()

  const parentOf = (url: URL) =>
    /'([^']+)' in parents/.exec(url.searchParams.get("q") ?? "")![1]

  test("a manual sync runs in the background and reports its progress", async () => {
    const user = newUser()
    const root = `${user.id}-root`
    const subfolders = Array.from({ length: 4 }, (_, i) => `${user.id}-sub${i}`)
    // 500 files over two pages of the root and four subfolders.
    google(async (url) => {
      await sleep(100)
      const parent = parentOf(url)
      if (parent !== root) return Response.json({ files: files(parent, 50) })
      const all = [
        ...subfolders.map((id) => ({ id, name: id, mimeType: FOLDER })),
        ...files(root, 300),
      ]
      return Response.json(
        url.searchParams.get("pageToken")
          ? { files: all.slice(200) }
          : { files: all.slice(0, 200), nextPageToken: "next" }
      )
    })
    await insertFolder(user.id, root, "Big")

    const run = await startDriveSync(user.id, new Headers())
    expect(run).toMatchObject({ status: "running", origin: "manual" })
    // A second request joins the in-flight run instead of failing.
    const joined = await startDriveSync(user.id, new Headers())
    expect(joined?.run_id).toBe(run?.run_id)

    const phases = new Set<string>()
    let status = run!
    while (status.status === "running") {
      await sleep(50)
      status = (await syncStatus(user.id))!
      phases.add(status.phase)
      expect(status.files_saved).toBeLessThanOrEqual(status.files_total)
    }
    expect(phases.has("scanning") || phases.has("saving")).toBe(true)
    expect(status).toMatchObject({
      status: "succeeded",
      item_count: 500,
      folders_scanned: 5,
      files_saved: 500,
    })
    const [[counts]] = await pool.query<any[]>(
      `SELECT COUNT(*) AS media,SUM(m.available) AS available,
      (SELECT COUNT(*) FROM media_source s WHERE s.user_id=?) AS sources,
      (SELECT COUNT(*) FROM media_location l JOIN media x ON x.id=l.media_id WHERE x.user_id=?) AS locations
      FROM media m WHERE m.user_id=?`,
      [user.id, user.id, user.id]
    )
    expect([
      counts.media,
      Number(counts.available),
      counts.sources,
      counts.locations,
    ]).toEqual([500, 500, 500, 500])

    // A "running" row whose process released the Drive lock was interrupted.
    await pool.execute(
      "UPDATE drive_sync_run SET status='running',phase='saving' WHERE user_id=?",
      [user.id]
    )
    const interrupted = await syncStatus(user.id)
    expect(interrupted?.status).toBe("failed")
    expect(interrupted?.error).toMatch(/interrupted/)
  })

  test("concurrent syncs finish even when they hold every pool connection", async () => {
    // The main pool has eight connections, and each running sync holds one.
    const users = Array.from({ length: 10 }, () => newUser())
    google(async (url) => {
      await sleep(300)
      return Response.json({ files: files(parentOf(url), 20) })
    })
    for (const user of users)
      await insertFolder(user.id, `${user.id}-root`, "Folder")

    const guard = new AbortController()
    const results = await Promise.race([
      Promise.allSettled(users.map((user) => syncDrive(user.id))),
      sleep(60_000, undefined, { signal: guard.signal }).then(() => {
        throw new Error("Concurrent syncs did not finish")
      }),
    ]).finally(() => guard.abort())

    // More syncs than connections: some may fail on the busy catalog lock, but
    // every one must settle and record a final status.
    for (const [index, result] of results.entries()) {
      const status = await syncStatus(users[index].id)
      expect(status?.status).not.toBe("running")
      if (result.status === "fulfilled")
        expect(status).toMatchObject({ status: "succeeded", item_count: 20 })
    }
    expect(results.some((result) => result.status === "fulfilled")).toBe(true)
  })
})
