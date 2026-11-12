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
const { revokeLegacyDriveGrants } =
  await import("../src/lib/google-grants.server")
after(() => pool.end())

const FOLDER = "application/vnd.google-apps.folder"
type Call = { method: string; url: URL; token: string }
let calls: Call[] = []
let revocations: string[] = []
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
    if (
      url.hostname === "oauth2.googleapis.com" &&
      url.pathname === "/revoke"
    ) {
      revocations.push(String(init.body))
      return new Response(null, { status: 200 })
    }
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
    capabilities: { canListChildren: true },
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

test("a folder MediaBinder sees but can't list isn't linked", async () => {
  await withUser(async (userId) => {
    const id = `${userId}-metadata-only`
    // Inside a limited-access folder, Drive shows the folder to anyone with
    // access to its parent but lists its contents as empty.
    drive = ({ token }) =>
      token === "user-token"
        ? folderJson(id)
        : Response.json({
            id,
            name: "Limited",
            mimeType: FOLDER,
            capabilities: { canListChildren: false },
          })
    const result = (await mutate(
      "source",
      { folderId: id },
      userId,
      new Headers()
    )) as { ok: boolean; status: string }
    assert.equal(result.status, "needs-share")
    assert.deepEqual(await linkedFolder(userId, id), [])
  })
})

test("syncing a linked folder MediaBinder can't list fails instead of hiding its media", async () => {
  await withUser(async (userId) => {
    const id = `${userId}-unlistable`,
      mediaId = randomUUID()
    await pool.execute(
      "INSERT INTO drive_folder(user_id,folder_id,folder_name) VALUES (?,?,?)",
      [userId, id, "Limited"]
    )
    await pool.execute(
      "INSERT INTO media (id,user_id,drive_id,display_name,raw_name,mime_type,tags,created_at,uploaded_at,size,available,synced_at) VALUES (?,?,'fixture','Kept','kept.jpg','image/jpeg','[]',NOW(3),NOW(3),42,TRUE,NOW(3))",
      [mediaId, userId]
    )
    drive = ({ url }) =>
      url.pathname.endsWith(`/files/${id}`)
        ? Response.json({ id, capabilities: { canListChildren: false } })
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

test("limited-access subfolders sync only for their owner", async () => {
  await withUser(async (userId, email) => {
    const root = `${userId}-root`,
      foreign = `${userId}-limited-foreign`,
      owned = `${userId}-limited-owned`,
      open = `${userId}-open`
    await pool.execute(
      "INSERT INTO drive_folder(user_id,folder_id,folder_name) VALUES (?,?,?)",
      [userId, root, "Root"]
    )
    const photo = (parent: string) => ({
      id: `${parent}-photo`,
      name: "IMG.jpg",
      mimeType: "image/jpeg",
      createdTime: "2026-09-01T00:00:00Z",
      size: "42",
      parents: [parent],
    })
    const subfolder = (id: string, limited: boolean) => ({
      id,
      name: id,
      mimeType: FOLDER,
      inheritedPermissionsDisabled: limited,
    })
    // MediaBinder can read every subfolder (each could be shared with it
    // separately); this user owns only one of the two limited-access ones.
    drive = ({ url }) => {
      const parent = /'([^']+)' in parents/.exec(
        url.searchParams.get("q") ?? ""
      )?.[1]
      if (parent === root)
        return Response.json({
          files: [
            subfolder(foreign, true),
            subfolder(owned, true),
            subfolder(open, false),
            photo(root),
          ],
        })
      if (parent) return Response.json({ files: [photo(parent)] })
      const id = url.pathname.split("/").pop()!
      return Response.json({
        id,
        capabilities: { canListChildren: true },
        owners: [
          { emailAddress: id === owned ? email : "someone@example.com" },
        ],
      })
    }
    try {
      await syncDrive(userId)
      const synced = await rows<{ drive_id: string }>(
        "SELECT drive_id FROM media WHERE user_id=? AND available=TRUE ORDER BY drive_id",
        [userId]
      )
      assert.deepEqual(
        synced.map((m) => m.drive_id),
        [`${open}-photo`, `${owned}-photo`, `${root}-photo`].sort()
      )
      // The other user's limited-access folder is never listed.
      assert.ok(
        !calls.some((c) =>
          c.url.searchParams.get("q")?.includes(`'${foreign}' in parents`)
        )
      )
    } finally {
      await pool.execute("DELETE FROM drive_sync_run WHERE user_id=?", [userId])
      await pool.execute("DELETE FROM media_source WHERE user_id=?", [userId])
      await pool.execute(
        "DELETE FROM media_location WHERE media_id IN (SELECT id FROM media WHERE user_id=?)",
        [userId]
      )
      await pool.execute("DELETE FROM media WHERE user_id=?", [userId])
    }
  })
})

test("old full-Drive grants are revoked once so sign-in asks only for drive.file", async () => {
  await withUser(async (userId) => {
    const legacy = randomUUID(),
      current = randomUUID()
    await pool.execute(
      `INSERT INTO account(id,accountId,providerId,userId,accessToken,refreshToken,scope,createdAt,updatedAt)
      VALUES (?,?,'google',?,'old-access','old-refresh',?,NOW(3),NOW(3)),(?,?,'credential',?,NULL,NULL,?,NOW(3),NOW(3))`,
      [
        legacy,
        `${userId}-google`,
        userId,
        "https://www.googleapis.com/auth/drive.readonly,openid,https://www.googleapis.com/auth/drive.file",
        current,
        `${userId}-other`,
        userId,
        "https://www.googleapis.com/auth/drive.readonly",
      ]
    )
    revocations = []
    try {
      assert.equal(await revokeLegacyDriveGrants(), 1)
      // The user's token is revoked at Google, which drops the whole grant.
      assert.deepEqual(revocations, ["token=user-token"])
      assert.deepEqual(
        await rows(
          "SELECT accessToken,refreshToken,scope FROM account WHERE id=?",
          [legacy]
        ),
        [{ accessToken: null, refreshToken: null, scope: null }]
      )
      // Only Google sign-ins are touched, and only once.
      assert.equal(
        (
          await rows<{ scope: string }>(
            "SELECT scope FROM account WHERE id=?",
            [current]
          )
        )[0].scope,
        "https://www.googleapis.com/auth/drive.readonly"
      )
      assert.equal(await revokeLegacyDriveGrants(), 0)
      assert.equal(revocations.length, 1)
    } finally {
      await pool.execute("DELETE FROM account WHERE userId=?", [userId])
    }
  })
})
