import { generateKeyPairSync, randomUUID } from "node:crypto"
import { test, after, mock } from "node:test"
import assert from "node:assert/strict"

// Run only against a disposable, migrated test database.
// Shared-folder mode is switched on by a service account key; set it before the
// auth and library modules read it.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
process.env.GOOGLE_SERVICE_ACCOUNT_KEY = JSON.stringify({
  type: "service_account",
  client_email: "sync@mediabinder-test.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
})
const { pool, rows } = await import("../src/lib/database.server")
const { auth } = await import("../src/lib/auth.server")
const { mutate } = await import("../src/lib/library.server")
const { syncDrive } = await import("../src/lib/drive.server")
after(() => pool.end())

const FOLDER = "application/vnd.google-apps.folder"
type Call = { method: string; url: URL; token: string }
let calls: Call[] = []
// Per-test Drive behaviour, keyed by who asks: the user's token or the service account's.
let drive: (call: Call) => Response
mock.method(auth.api, "getAccessToken", async () => ({
  accessToken: "user-token",
}))
mock.method(
  globalThis,
  "fetch",
  async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    if (url.hostname === "oauth2.googleapis.com")
      return Response.json({ access_token: "sa-token", expires_in: 3600 })
    const token = String(
      (init.headers as Record<string, string>)?.Authorization ?? ""
    ).replace("Bearer ", "")
    const call = { method: init.method ?? "GET", url, token }
    calls.push(call)
    return drive(call)
  }
)
const folderJson = (id: string, owner = "someone@example.com") =>
  Response.json({
    id,
    name: `Folder ${id.slice(-4)}`,
    mimeType: FOLDER,
    owners: [{ emailAddress: owner }],
  })
const denied = (status: number, reason: string) =>
  Response.json({ error: { errors: [{ reason }] } }, { status })

async function withUser(run: (userId: string, email: string) => Promise<void>) {
  const userId = randomUUID(),
    email = `${userId}@example.com`
  await pool.execute(
    "INSERT INTO user(id,name,email,emailVerified,role,createdAt,updatedAt) VALUES (?,?,?,?,?,NOW(),NOW())",
    [userId, "Shared folder test", email, true, "user"]
  )
  try {
    calls = []
    await run(userId, email)
  } finally {
    await pool.execute("DELETE FROM drive_folder WHERE user_id=?", [userId])
    await pool.execute("DELETE FROM drive_sync_state WHERE user_id=?", [userId])
    await pool.execute("DELETE FROM user WHERE id=?", [userId])
  }
}
const linkedFolder = (userId: string, folderId: string) =>
  rows<{ share_permission_id: string | null }>(
    "SELECT share_permission_id FROM drive_folder WHERE user_id=? AND folder_id=?",
    [userId, folderId]
  )

test("a picked folder is shared with the service account and linked", async () => {
  await withUser(async (userId) => {
    const id = `${userId}-picked`
    drive = ({ method, url }) =>
      method === "POST" && url.pathname.endsWith("/permissions")
        ? Response.json({ id: "perm-1" })
        : folderJson(id)
    const result = await mutate(
      "source",
      { folderId: id, share: true },
      userId,
      new Headers()
    )
    assert.equal((result as { status: string }).status, "linked")
    const share = calls.find((c) => c.method === "POST")!
    assert.equal(share.token, "user-token")
    assert.equal(share.url.searchParams.get("sendNotificationEmail"), "false")
    // The service account confirms access before the folder is linked.
    assert.ok(calls.some((c) => c.token === "sa-token"))
    assert.deepEqual(await linkedFolder(userId, id), [
      { share_permission_id: "perm-1" },
    ])
  })
})

test("someone else's folder cannot be linked even when MediaBinder can read it", async () => {
  await withUser(async (userId) => {
    const id = `${userId}-foreign`
    // The user's token cannot see it (not picked); the service account can,
    // because another user shared it, and the owner is someone else.
    drive = ({ token }) =>
      token === "user-token" ? denied(404, "notFound") : folderJson(id)
    await assert.rejects(
      mutate("source", { folderId: id }, userId, new Headers()),
      /Google Drive picker/
    )
    assert.deepEqual(await linkedFolder(userId, id), [])
  })
})

test("a folder the user owns and shared manually links by ID", async () => {
  await withUser(async (userId, email) => {
    const id = `${userId}-owned`
    drive = ({ token }) =>
      token === "user-token" ? denied(404, "notFound") : folderJson(id, email)
    const result = await mutate(
      "source",
      { folderId: id },
      userId,
      new Headers()
    )
    assert.equal((result as { status: string }).status, "linked")
    assert.deepEqual(await linkedFolder(userId, id), [
      { share_permission_id: null },
    ])
  })
})

test("existing folders Google won't let MediaBinder share ask the user to share them", async () => {
  await withUser(async (userId) => {
    const id = `${userId}-existing`
    drive = ({ method, token }) =>
      method === "POST"
        ? denied(403, "appNotAuthorizedToChild")
        : token === "user-token"
          ? folderJson(id)
          : denied(404, "notFound")
    const result = (await mutate(
      "source",
      { folderId: id, share: true },
      userId,
      new Headers()
    )) as { ok: boolean; status: string; reason: string }
    assert.equal(result.ok, false)
    assert.equal(result.status, "needs-share")
    assert.match(result.reason, /already has files/)
    assert.deepEqual(await linkedFolder(userId, id), [])
  })
})

test("unlinking removes MediaBinder's share unless another user still syncs the folder", async () => {
  await withUser(async (userId) => {
    const id = `${userId}-unlink`,
      other = randomUUID()
    await pool.execute(
      "INSERT INTO drive_folder(user_id,folder_id,folder_name,share_permission_id) VALUES (?,?,?,?),(?,?,?,?)",
      [userId, id, "Shared", "perm-9", other, id, "Shared", null]
    )
    drive = () => new Response(null, { status: 204 })
    try {
      const kept = (await mutate(
        "remove-source",
        { folderId: id },
        userId,
        new Headers()
      )) as { access_removed: boolean }
      assert.equal(kept.access_removed, false)
      assert.equal(calls.filter((c) => c.method === "DELETE").length, 0)

      await pool.execute(
        "INSERT INTO drive_folder(user_id,folder_id,folder_name,share_permission_id) VALUES (?,?,?,?)",
        [userId, id, "Shared", "perm-9"]
      )
      await pool.execute("DELETE FROM drive_folder WHERE user_id=?", [other])
      const removed = (await mutate(
        "remove-source",
        { folderId: id },
        userId,
        new Headers()
      )) as { access_removed: boolean }
      assert.equal(removed.access_removed, true)
      const deletion = calls.find((c) => c.method === "DELETE")!
      assert.match(deletion.url.pathname, /\/permissions\/perm-9$/)
    } finally {
      await pool.execute("DELETE FROM drive_folder WHERE user_id=?", [other])
    }
  })
})

test("syncing a folder MediaBinder can no longer open fails instead of hiding its media", async () => {
  await withUser(async (userId) => {
    const id = `${userId}-unshared`,
      mediaId = randomUUID()
    await pool.execute(
      "INSERT INTO drive_folder(user_id,folder_id,folder_name) VALUES (?,?,?)",
      [userId, id, "Unshared"]
    )
    await pool.execute(
      "INSERT INTO media (id,user_id,drive_id,display_name,raw_name,mime_type,tags,created_at,uploaded_at,size,available,synced_at) VALUES (?,?,'fixture','Kept','kept.jpg','image/jpeg','[]',NOW(3),NOW(3),42,TRUE,NOW(3))",
      [mediaId, userId]
    )
    // Drive would list the unshared folder as empty; the access check fails first.
    drive = ({ url }) =>
      url.pathname.endsWith(`/files/${id}`)
        ? denied(404, "notFound")
        : Response.json({ files: [] })
    try {
      await assert.rejects(syncDrive(userId), /Share it with MediaBinder/)
      assert.deepEqual(
        await rows("SELECT available FROM media WHERE id=?", [mediaId]),
        [{ available: 1 }]
      )
    } finally {
      await pool.execute("DELETE FROM drive_sync_run WHERE user_id=?", [userId])
      await pool.execute("DELETE FROM media WHERE id=?", [mediaId])
    }
  })
})
