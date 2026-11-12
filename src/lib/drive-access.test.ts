import assert from "node:assert/strict"
import { generateKeyPairSync, createVerify } from "node:crypto"
import { afterEach, test, mock } from "node:test"
import {
  DriveAccessError,
  parseServiceAccount,
  pickerConfig,
  resetServiceAccountCache,
  serviceAccountToken,
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
  mock.restoreAll()
  delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  resetServiceAccountCache()
})

test("service account keys are read raw or base64-encoded", () => {
  assert.equal(parseServiceAccount({}), null)
  for (const value of [json, Buffer.from(json).toString("base64")])
    assert.equal(
      parseServiceAccount({ GOOGLE_SERVICE_ACCOUNT_KEY: value })?.client_email,
      key.client_email
    )
  assert.throws(
    () => parseServiceAccount({ GOOGLE_SERVICE_ACCOUNT_KEY: "{nope" }),
    /service account JSON key/
  )
  assert.throws(
    () =>
      parseServiceAccount({
        GOOGLE_SERVICE_ACCOUNT_KEY: JSON.stringify({ ...key, type: "user" }),
      }),
    /not a valid service account/
  )
})

test("the picker needs both an API key and the project number", () => {
  assert.equal(pickerConfig({ GOOGLE_PICKER_API_KEY: "k" }), null)
  assert.deepEqual(
    pickerConfig({
      GOOGLE_PICKER_API_KEY: "k",
      GOOGLE_CLOUD_PROJECT_NUMBER: "123",
    }),
    { apiKey: "k", appId: "123" }
  )
})

test("assertions are RS256-signed for read-only Drive access", () => {
  const sa = parseServiceAccount({ GOOGLE_SERVICE_ACCOUNT_KEY: json })!
  const [header, claims, signature] = signAssertion(sa, 1000).split(".")
  const verify = createVerify("RSA-SHA256")
  verify.update(`${header}.${claims}`)
  assert.ok(verify.verify(publicKey, Buffer.from(signature, "base64url")))
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url").toString()), {
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: key.token_uri,
    iat: 1000,
    exp: 4600,
  })
})

test("service account tokens are cached and requests are shared", async () => {
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY = json
  const fetch = mock.method(globalThis, "fetch", async () =>
    Response.json({ access_token: "sa-token", expires_in: 3600 })
  )
  const tokens = await Promise.all([
    serviceAccountToken(),
    serviceAccountToken(),
  ])
  assert.deepEqual(tokens, ["sa-token", "sa-token"])
  assert.equal(await serviceAccountToken(), "sa-token")
  assert.equal(fetch.mock.callCount(), 1)
  const body = fetch.mock.calls[0].arguments[1]?.body as URLSearchParams
  assert.equal(
    body.get("grant_type"),
    "urn:ietf:params:oauth:grant-type:jwt-bearer"
  )
})

test("sharing adds the service account as a silent viewer", async () => {
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY = json
  const fetch = mock.method(globalThis, "fetch", async () =>
    Response.json({ id: "perm-1" })
  )
  assert.equal(await shareFolderWithApp("user-token", "folder-1"), "perm-1")
  const [url, init] = fetch.mock.calls[0].arguments as [string, RequestInit]
  const parsed = new URL(url)
  assert.equal(parsed.pathname, "/drive/v3/files/folder-1/permissions")
  assert.equal(parsed.searchParams.get("sendNotificationEmail"), "false")
  assert.equal(init.method, "POST")
  assert.deepEqual(JSON.parse(String(init.body)), {
    type: "user",
    role: "reader",
    emailAddress: key.client_email,
  })
  assert.equal(
    (init.headers as Record<string, string>).Authorization,
    "Bearer user-token"
  )
})

test("Drive errors map to actionable codes", async () => {
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
    mock.method(globalThis, "fetch", async () => response)
    await assert.rejects(
      shareFolderWithApp("user-token", "folder-1"),
      (thrown) => thrown instanceof DriveAccessError && thrown.code === code
    )
    mock.restoreAll()
  }
})

test("waiting for access retries until the share propagates", async () => {
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY = json
  let lookups = 0
  mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("oauth2")) return Response.json({ access_token: "t" })
    return ++lookups < 3
      ? Response.json({ error: {} }, { status: 404 })
      : Response.json({
          id: "f",
          name: "Folder",
          mimeType: "application/vnd.google-apps.folder",
        })
  })
  const folder = await waitForAppAccess("f", 5, 1)
  assert.equal(folder.name, "Folder")
  assert.equal(lookups, 3)
})
