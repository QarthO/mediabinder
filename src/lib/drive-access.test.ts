import { generateKeyPairSync, createVerify } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import {
  DriveAccessError,
  parseServiceAccount,
  pickerConfig,
  resetServiceAccountCache,
  serviceAccountToken,
  shareAddress,
  shareFolderWithApp,
  signAssertion,
  waitForAppAccess,
} from "./drive-access.server"

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
})
const key = {
  type: "service_account",
  client_email: "sync@mediabinder-test.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  token_uri: "https://oauth2.googleapis.com/token",
}
const json = JSON.stringify(key)

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  delete process.env.GOOGLE_DRIVE_SHARE_GROUP
  resetServiceAccountCache()
})

const fetchMock = (implementation: (...args: any[]) => Promise<Response>) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(implementation as never)

describe("Drive access", () => {
  it("reads service account keys raw or base64-encoded", () => {
    expect(parseServiceAccount({})).toBeNull()
    for (const value of [json, Buffer.from(json).toString("base64")])
      expect(
        parseServiceAccount({ GOOGLE_SERVICE_ACCOUNT_KEY: value })?.client_email
      ).toBe(key.client_email)
    expect(() =>
      parseServiceAccount({ GOOGLE_SERVICE_ACCOUNT_KEY: "{nope" })
    ).toThrow(/service account JSON key/)
    expect(() =>
      parseServiceAccount({
        GOOGLE_SERVICE_ACCOUNT_KEY: JSON.stringify({ ...key, type: "user" }),
      })
    ).toThrow(/not a valid service account/)
  })

  it("needs both an API key and the project number for the picker", () => {
    expect(pickerConfig({ GOOGLE_PICKER_API_KEY: "k" })).toBeNull()
    expect(
      pickerConfig({
        GOOGLE_PICKER_API_KEY: "k",
        GOOGLE_CLOUD_PROJECT_NUMBER: "123",
      })
    ).toEqual({ apiKey: "k", appId: "123" })
  })

  it("signs assertions RS256 for read-only Drive access", () => {
    const sa = parseServiceAccount({ GOOGLE_SERVICE_ACCOUNT_KEY: json })!
    const [header, claims, signature] = signAssertion(sa, 1000).split(".")
    const verify = createVerify("RSA-SHA256")
    verify.update(`${header}.${claims}`)
    expect(verify.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(
      true
    )
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
      iss: key.client_email,
      scope: "https://www.googleapis.com/auth/drive.readonly",
      aud: key.token_uri,
      iat: 1000,
      exp: 4600,
    })
  })

  it("caches service account tokens and shares in-flight requests", async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = json
    const fetch = fetchMock(async () =>
      Response.json({ access_token: "sa-token", expires_in: 3600 })
    )
    const tokens = await Promise.all([
      serviceAccountToken(),
      serviceAccountToken(),
    ])
    expect(tokens).toEqual(["sa-token", "sa-token"])
    expect(await serviceAccountToken()).toBe("sa-token")
    expect(fetch).toHaveBeenCalledTimes(1)
    const body = fetch.mock.calls[0][1]?.body as URLSearchParams
    expect(body.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer"
    )
  })

  it("shares a folder by adding the service account as a silent viewer", async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = json
    const fetch = fetchMock(async () => Response.json({ id: "perm-1" }))
    expect(await shareFolderWithApp("user-token", "folder-1")).toBe("perm-1")
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
    const parsed = new URL(url)
    expect(parsed.pathname).toBe("/drive/v3/files/folder-1/permissions")
    expect(parsed.searchParams.get("sendNotificationEmail")).toBe("false")
    expect(init.method).toBe("POST")
    expect(JSON.parse(String(init.body))).toEqual({
      type: "user",
      role: "reader",
      emailAddress: key.client_email,
    })
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer user-token"
    )
  })

  it("uses a configured Google Group as the share address", async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = json
    process.env.GOOGLE_DRIVE_SHARE_GROUP = " Sync@Rien.Cloud "
    expect(shareAddress()).toBe("sync@rien.cloud")
    const fetch = fetchMock(async () => Response.json({ id: "perm-2" }))
    await shareFolderWithApp("user-token", "folder-1")
    const init = fetch.mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(init.body))).toEqual({
      type: "group",
      role: "reader",
      emailAddress: "sync@rien.cloud",
    })
    delete process.env.GOOGLE_DRIVE_SHARE_GROUP
    expect(shareAddress()).toBe(key.client_email)
  })

  it("maps Drive errors to actionable codes", async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = json
    const error = (status: number, reason: string) =>
      Response.json({ error: { errors: [{ reason }] } }, { status })
    for (const [response, code] of [
      [error(403, "insufficientPermissions"), "scope"],
      [error(403, "publishOutNotPermitted"), "not-allowed"],
      [error(403, "appNotAuthorizedToChild"), "not-allowed"],
      [error(404, "notFound"), "not-found"],
      [error(500, "backendError"), "unavailable"],
    ] as const) {
      fetchMock(async () => response)
      await expect(
        shareFolderWithApp("user-token", "folder-1")
      ).rejects.toSatisfy(
        (thrown) => thrown instanceof DriveAccessError && thrown.code === code
      )
      vi.restoreAllMocks()
    }
  })

  it("retries waiting for access until the share propagates", async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = json
    let lookups = 0
    fetchMock(async (url: string) => {
      if (url.includes("oauth2")) return Response.json({ access_token: "t" })
      return ++lookups < 3
        ? Response.json({ error: {} }, { status: 404 })
        : Response.json({
            id: "f",
            name: "Folder",
            mimeType: "application/vnd.google-apps.folder",
            capabilities: { canListChildren: true },
          })
    })
    const folder = await waitForAppAccess("f", 5, 1)
    expect(folder.name).toBe("Folder")
    expect(lookups).toBe(3)
  })
})
