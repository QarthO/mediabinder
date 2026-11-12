import { randomBytes, randomUUID } from "node:crypto"
import { test, after, mock } from "node:test"
import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import { pool } from "../src/lib/database.server"
import { auth } from "../src/lib/auth.server"
import { startDriveSync, syncDrive } from "../src/lib/drive.server"
import { syncStatus } from "../src/lib/sync-progress.server"

// Run only against a disposable, migrated test database.
after(() => pool.end())
// Effect's fetch client keeps the first fetch it sees, so mock it once and
// swap the Drive behaviour per test.
let drive: (parent: string, url: URL) => Promise<Response>
mock.method(auth.api, "getAccessToken", async () => ({ accessToken: "t" }))
mock.method(globalThis, "fetch", async (input: string | URL) => {
  const url = new URL(String(input))
  assert.equal(url.hostname, "www.googleapis.com")
  return drive(
    url.searchParams.get("q")!.match(/'([^']+)' in parents/)![1],
    url
  )
})
test("manual sync runs in the background and reports progress", async () => {
  const user = randomUUID(),
    root = `${user}-root`
  const subfolders = Array.from({ length: 4 }, (_, i) => `${user}-sub${i}`)
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
  drive = async (parent, url) => {
    await sleep(100)
    if (parent !== root) return Response.json({ files: files(parent, 50) })
    const all = [
      ...subfolders.map((id) => ({
        id,
        name: id,
        mimeType: "application/vnd.google-apps.folder",
      })),
      ...files(root, 300),
    ]
    return Response.json(
      url.searchParams.get("pageToken")
        ? { files: all.slice(200) }
        : { files: all.slice(0, 200), nextPageToken: "next" }
    )
  }
  await pool.execute(
    "INSERT INTO drive_folder(user_id,folder_id,folder_name) VALUES (?,?,'Big')",
    [user, root]
  )

  const run = await startDriveSync(user, new Headers())
  assert.equal(run?.status, "running")
  assert.equal(run?.origin, "manual")
  // A second request joins the in-flight run instead of failing.
  const joined = await startDriveSync(user, new Headers())
  assert.equal(joined?.run_id, run?.run_id)

  const seen = new Set<string>()
  let status = run!
  while (status.status === "running") {
    await sleep(50)
    status = (await syncStatus(user))!
    seen.add(status.phase)
    assert.ok(status.files_saved <= status.files_total)
  }
  assert.ok(seen.has("scanning") || seen.has("saving"))
  assert.equal(status.status, "succeeded")
  assert.equal(status.item_count, 500)
  assert.equal(status.folders_scanned, 5)
  assert.equal(status.files_saved, 500)
  const [[counts]] = await pool.query<any[]>(
    `SELECT COUNT(*) AS media,SUM(m.available) AS available,
    (SELECT COUNT(*) FROM media_source s WHERE s.user_id=?) AS sources,
    (SELECT COUNT(*) FROM media_location l JOIN media x ON x.id=l.media_id WHERE x.user_id=?) AS locations
    FROM media m WHERE m.user_id=?`,
    [user, user, user]
  )
  assert.deepEqual(
    [counts.media, Number(counts.available), counts.sources, counts.locations],
    [500, 500, 500, 500]
  )

  // A running row whose process released the Drive lock was interrupted.
  await pool.execute(
    "UPDATE drive_sync_run SET status='running',phase='saving' WHERE user_id=?",
    [user]
  )
  const interrupted = await syncStatus(user)
  assert.equal(interrupted?.status, "failed")
  assert.match(interrupted?.error ?? "", /interrupted/)
})

test("concurrent syncs finish even when they hold every pool connection", async () => {
  // The main pool has eight connections; each running sync holds one.
  const users = Array.from({ length: 10 }, () => randomUUID())
  drive = async (parent) => {
    await sleep(300)
    return Response.json({
      files: Array.from({ length: 20 }, (_, i) => ({
        id: `${parent}-f${i}`,
        name: `IMG_${i}.jpg`,
        mimeType: "image/jpeg",
        createdTime: "2026-09-01T00:00:00Z",
        size: "42",
        parents: [parent],
        sha256Checksum: randomBytes(32).toString("hex"),
      })),
    })
  }
  for (const user of users)
    await pool.execute(
      "INSERT INTO drive_folder(user_id,folder_id,folder_name) VALUES (?,?,'Folder')",
      [user, `${user}-root`]
    )
  const guard = new AbortController()
  const results = await Promise.race([
    Promise.allSettled(users.map((user) => syncDrive(user))),
    sleep(60_000, undefined, { signal: guard.signal }).then(() => {
      throw new Error("Concurrent syncs did not finish")
    }),
  ]).finally(() => guard.abort())
  // More syncs than connections: some may fail on the busy catalog lock, but
  // every one must settle and record a final status.
  for (const [index, result] of results.entries()) {
    const status = await syncStatus(users[index])
    assert.notEqual(status?.status, "running")
    if (result.status === "fulfilled") {
      assert.equal(status?.status, "succeeded")
      assert.equal(status?.item_count, 20)
    }
  }
  assert.ok(results.some((result) => result.status === "fulfilled"))
})
