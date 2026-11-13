import { generateKeyPairSync, randomUUID } from "node:crypto"
import { afterAll, beforeAll, expect, test } from "vite-plus/test"

import { runTracedAppEffect } from "@/effect/runtime.server"
import { describeMysql, useTestDatabase } from "@/test/database"
import {
  act,
  insertFolder,
  insertMedia,
  insertUser,
  stubAccessToken,
  stubGoogle,
} from "@/test/fixtures"
import { pool, rows } from "./database.server"
import { resetServiceAccountCache } from "./drive-access.server"
import { syncDrive } from "./drive.server"
import { revokeLegacy } from "./google-grants.server"

const FOLDER = "application/vnd.google-apps.folder"

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

type Call = { method: string; url: URL; token: string }

// Linking folders in shared-folder mode: MediaBinder reads Drive as a service
// account, so a user may only link folders they own or picked themselves.
describeMysql("shared folders", () => {
  useTestDatabase()
  const google = stubGoogle()
  stubAccessToken(() => "user-token")

  // Shared-folder mode is switched on by a service account key.
  beforeAll(() => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = JSON.stringify({
      type: "service_account",
      client_email: "sync@mediabinder-test.iam.gserviceaccount.com",
      private_key: privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
    })
    resetServiceAccountCache()
  })
  afterAll(() => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY
    resetServiceAccountCache()
  })

  // Answers Drive per request, keyed by who asks: the user or the service
  // account. Other Google endpoints answer as the real ones do.
  function drive(answer: (call: Call) => Response) {
    const calls: Call[] = []
    const revocations: string[] = []
    google((url, init) => {
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
        new Headers(init.headers).get("authorization") ?? ""
      ).replace("Bearer ", "")
      const call = { method: init.method ?? "GET", url, token }
      calls.push(call)
      return answer(call)
    })
    return { calls, revocations }
  }
  const linked = (userId: string, folderId: string) =>
    rows<{ share_permission_id: string | null }>(
      "SELECT share_permission_id FROM drive_folder WHERE user_id=? AND folder_id=?",
      [userId, folderId]
    )

  test("a picked folder is shared with the service account and linked", async () => {
    const user = await insertUser()
    const id = `${user.id}-picked`
    const { calls } = drive(({ method, url }) =>
      method === "POST" && url.pathname.endsWith("/permissions")
        ? Response.json({ id: "perm-1" })
        : folderJson(id)
    )

    const result = await act(user, "source", { folderId: id, share: true })

    expect(result).toMatchObject({ status: "linked" })
    // The share is made with the user's own token, without emailing anyone.
    const share = calls.find((call) => call.method === "POST")!
    expect(share.token).toBe("user-token")
    expect(share.url.searchParams.get("sendNotificationEmail")).toBe("false")
    expect(await linked(user.id, id)).toEqual([
      { share_permission_id: "perm-1" },
    ])
  })

  test("someone else's folder cannot be linked even when MediaBinder can read it", async () => {
    const user = await insertUser()
    const id = `${user.id}-foreign`
    // The user's token cannot see it (not picked); the service account can,
    // because another user shared it, and the owner is someone else.
    drive(({ token }) =>
      token === "user-token" ? denied(404, "notFound") : folderJson(id)
    )

    await expect(act(user, "source", { folderId: id })).rejects.toThrow(
      /Google Drive picker/
    )
    expect(await linked(user.id, id)).toEqual([])
  })

  test("a folder the user owns and shared manually links by ID", async () => {
    const user = await insertUser()
    const id = `${user.id}-owned`
    drive(({ token }) =>
      token === "user-token"
        ? denied(404, "notFound")
        : folderJson(id, user.email)
    )

    expect(await act(user, "source", { folderId: id })).toMatchObject({
      status: "linked",
    })
    expect(await linked(user.id, id)).toEqual([{ share_permission_id: null }])
  })

  test("existing folders Google won't let MediaBinder share ask the user to share them", async () => {
    const user = await insertUser()
    const id = `${user.id}-existing`
    drive(({ method, token }) =>
      method === "POST"
        ? denied(403, "appNotAuthorizedToChild")
        : token === "user-token"
          ? folderJson(id)
          : denied(404, "notFound")
    )

    const result = (await act(user, "source", {
      folderId: id,
      share: true,
    })) as { ok: boolean; status: string; reason: string }

    expect(result).toMatchObject({ ok: false, status: "needs-share" })
    expect(result.reason).toMatch(/already has files/)
    expect(await linked(user.id, id)).toEqual([])
  })

  test("a folder MediaBinder sees but can't list isn't linked", async () => {
    const user = await insertUser()
    const id = `${user.id}-metadata-only`
    // Inside a limited-access folder, Drive shows the folder to anyone with
    // access to its parent but lists its contents as empty.
    drive(({ token }) =>
      token === "user-token"
        ? folderJson(id)
        : Response.json({
            id,
            name: "Limited",
            mimeType: FOLDER,
            capabilities: { canListChildren: false },
          })
    )

    expect(await act(user, "source", { folderId: id })).toMatchObject({
      status: "needs-share",
    })
    expect(await linked(user.id, id)).toEqual([])
  })

  test("unlinking removes MediaBinder's share unless another user still syncs the folder", async () => {
    const user = await insertUser()
    const other = await insertUser()
    const id = `${user.id}-unlink`
    await pool.execute(
      "INSERT INTO drive_folder(user_id,folder_id,folder_name,share_permission_id) VALUES (?,?,?,?),(?,?,?,?)",
      [user.id, id, "Shared", "perm-9", other.id, id, "Shared", null]
    )
    const { calls } = drive(() => new Response(null, { status: 204 }))

    const kept = await act(user, "remove-source", { folderId: id })
    expect(kept).toMatchObject({ access_removed: false })
    expect(calls.filter((call) => call.method === "DELETE")).toEqual([])

    // Now the only syncing user: the share is deleted at Google.
    await insertFolder(user.id, id, "Shared")
    await pool.execute(
      "UPDATE drive_folder SET share_permission_id='perm-9' WHERE user_id=?",
      [user.id]
    )
    await pool.execute("DELETE FROM drive_folder WHERE user_id=?", [other.id])
    const removed = await act(user, "remove-source", { folderId: id })
    expect(removed).toMatchObject({ access_removed: true })
    expect(
      calls.find((call) => call.method === "DELETE")!.url.pathname
    ).toMatch(/\/permissions\/perm-9$/)
  })

  test("syncing a folder MediaBinder can no longer open fails instead of hiding its media", async () => {
    const user = await insertUser()
    const id = `${user.id}-unshared`
    await insertFolder(user.id, id, "Unshared")
    const media = await insertMedia({ userId: user.id, folder: id })
    // Drive would list the unshared folder as empty; the access check fails first.
    drive(({ url }) =>
      url.pathname.endsWith(`/files/${id}`)
        ? denied(404, "notFound")
        : Response.json({ files: [] })
    )

    await expect(syncDrive(user.id)).rejects.toThrow(
      /Share it with MediaBinder/
    )
    expect(
      await rows("SELECT available FROM media WHERE id=?", [media])
    ).toEqual([{ available: 1 }])
  })

  test("syncing a linked folder MediaBinder can't list fails instead of hiding its media", async () => {
    const user = await insertUser()
    const id = `${user.id}-unlistable`
    await insertFolder(user.id, id, "Limited")
    const media = await insertMedia({ userId: user.id, folder: id })
    drive(({ url }) =>
      url.pathname.endsWith(`/files/${id}`)
        ? Response.json({ id, capabilities: { canListChildren: false } })
        : Response.json({ files: [] })
    )

    await expect(syncDrive(user.id)).rejects.toThrow(
      /Share it with MediaBinder/
    )
    expect(
      await rows("SELECT available FROM media WHERE id=?", [media])
    ).toEqual([{ available: 1 }])
  })

  test("limited-access subfolders sync only for their owner", async () => {
    const user = await insertUser()
    const root = `${user.id}-root`,
      foreign = `${user.id}-limited-foreign`,
      owned = `${user.id}-limited-owned`,
      open = `${user.id}-open`
    await insertFolder(user.id, root, "Root")
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
    const { calls } = drive(({ url }) => {
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
          { emailAddress: id === owned ? user.email : "someone@example.com" },
        ],
      })
    })

    await syncDrive(user.id)

    const synced = await rows<{ drive_id: string }>(
      "SELECT drive_id FROM media WHERE user_id=? AND available=TRUE ORDER BY drive_id",
      [user.id]
    )
    expect(synced.map((media) => media.drive_id)).toEqual(
      [`${open}-photo`, `${owned}-photo`, `${root}-photo`].sort()
    )
    // The other user's limited-access folder is never even listed.
    expect(
      calls.some((call) =>
        call.url.searchParams.get("q")?.includes(`'${foreign}' in parents`)
      )
    ).toBe(false)
  })

  test("old full-Drive grants are revoked once so sign-in asks only for drive.file", async () => {
    const user = await insertUser()
    const legacy = randomUUID(),
      current = randomUUID()
    await pool.execute(
      `INSERT INTO account(id,accountId,providerId,userId,accessToken,refreshToken,scope,createdAt,updatedAt)
      VALUES (?,?,'google',?,'old-access','old-refresh',?,NOW(3),NOW(3)),(?,?,'credential',?,NULL,NULL,?,NOW(3),NOW(3))`,
      [
        legacy,
        `${user.id}-google`,
        user.id,
        "https://www.googleapis.com/auth/drive.readonly,openid,https://www.googleapis.com/auth/drive.file",
        current,
        `${user.id}-other`,
        user.id,
        "https://www.googleapis.com/auth/drive.readonly",
      ]
    )
    const { revocations } = drive(() => new Response(null, { status: 500 }))

    expect(await runTracedAppEffect(revokeLegacy())).toBe(1)
    // The user's token is revoked at Google, which drops the whole grant.
    expect(revocations).toEqual(["token=user-token"])
    expect(
      await rows(
        "SELECT accessToken,refreshToken,scope FROM account WHERE id=?",
        [legacy]
      )
    ).toEqual([{ accessToken: null, refreshToken: null, scope: null }])
    // Only Google sign-ins are touched, and only once.
    expect(
      (
        await rows<{ scope: string }>("SELECT scope FROM account WHERE id=?", [
          current,
        ])
      )[0].scope
    ).toBe("https://www.googleapis.com/auth/drive.readonly")
    expect(await runTracedAppEffect(revokeLegacy())).toBe(0)
    expect(revocations).toHaveLength(1)
  })
})
