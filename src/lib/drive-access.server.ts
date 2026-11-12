import { createSign } from "node:crypto"
import { readFileSync } from "node:fs"

// Shared-folder mode: users share a folder with MediaBinder's service account,
// which reads Drive on their behalf. Users only grant the non-sensitive
// drive.file scope, used by the folder picker and to add/remove that share.
type Environment = Record<string, string | undefined>
export interface ServiceAccount {
  client_email: string
  private_key: string
  token_uri: string
}
const DRIVE_READONLY = "https://www.googleapis.com/auth/drive.readonly"
const FOLDER_MIME = "application/vnd.google-apps.folder"

export function parseServiceAccount(
  env: Environment = process.env
): ServiceAccount | null {
  let raw = env.GOOGLE_SERVICE_ACCOUNT_KEY?.trim()
  const file = env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE?.trim()
  if (!raw && file) raw = readFileSync(file, "utf8")
  if (!raw) return null
  // Accept the downloaded JSON key either verbatim or base64-encoded (env-friendly).
  const text = raw.startsWith("{")
    ? raw
    : Buffer.from(raw, "base64").toString("utf8")
  let value: Partial<ServiceAccount> & { type?: string }
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_KEY must be a service account JSON key (raw or base64)."
    )
  }
  if (
    value.type !== "service_account" ||
    !value.client_email ||
    !value.private_key?.includes("PRIVATE KEY")
  )
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_KEY is not a valid service account JSON key."
    )
  return {
    client_email: value.client_email,
    private_key: value.private_key,
    token_uri: value.token_uri || "https://oauth2.googleapis.com/token",
  }
}

let account: ServiceAccount | null | undefined
export function serviceAccount() {
  if (account === undefined) account = parseServiceAccount()
  return account
}
export const sharedFolderMode = () => serviceAccount() !== null
export const serviceAccountEmail = () => serviceAccount()?.client_email ?? null

export function pickerConfig(env: Environment = process.env) {
  const apiKey = env.GOOGLE_PICKER_API_KEY?.trim(),
    appId = env.GOOGLE_CLOUD_PROJECT_NUMBER?.trim()
  return apiKey && appId ? { apiKey, appId } : null
}

const base64url = (value: string | Buffer) =>
  Buffer.from(value).toString("base64url")
export function signAssertion(
  sa: ServiceAccount,
  now = Math.floor(Date.now() / 1000)
) {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const claims = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: DRIVE_READONLY,
      aud: sa.token_uri,
      iat: now,
      exp: now + 3600,
    })
  )
  const signer = createSign("RSA-SHA256")
  signer.update(`${header}.${claims}`)
  return `${header}.${claims}.${base64url(signer.sign(sa.private_key))}`
}

let cached: { token: string; expires: number } | null = null
let pending: Promise<string> | null = null
export function resetServiceAccountCache() {
  account = undefined
  cached = null
  pending = null
}
// Tokens are cached process-wide and refreshed a minute before expiry.
export async function serviceAccountToken() {
  const sa = serviceAccount()
  if (!sa) throw new Error("MediaBinder's Drive service account is not set up.")
  if (cached && cached.expires > Date.now() + 60_000) return cached.token
  pending ??= (async () => {
    try {
      const response = await fetch(sa.token_uri, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: signAssertion(sa),
        }),
        signal: AbortSignal.timeout(15_000),
      })
      const body = (await response.json().catch(() => ({}))) as {
        access_token?: string
        expires_in?: number
      }
      if (!response.ok || !body.access_token)
        throw new Error(
          `MediaBinder's Drive service account could not sign in (${response.status}).`
        )
      cached = {
        token: body.access_token,
        expires: Date.now() + (body.expires_in ?? 3600) * 1000,
      }
      return body.access_token
    } finally {
      pending = null
    }
  })()
  return pending
}

export class DriveAccessError extends Error {
  constructor(
    message: string,
    readonly code: "scope" | "not-allowed" | "not-found" | "unavailable"
  ) {
    super(message)
  }
}
async function driveCall(
  token: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string>,
  body?: unknown
) {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/${path}?${new URLSearchParams(params)}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    }
  )
  if (response.ok)
    return response.status === 204 ? null : ((await response.json()) as any)
  const error = (await response.json().catch(() => null)) as {
    error?: { errors?: { reason?: string }[]; details?: { reason?: string }[] }
  } | null
  const reasons = [
    ...(error?.error?.errors ?? []),
    ...(error?.error?.details ?? []),
  ].map((item) => item.reason ?? "")
  if (
    response.status === 401 ||
    reasons.some((reason) =>
      /insufficientPermissions|SCOPE_INSUFFICIENT|authError/i.test(reason)
    )
  )
    throw new DriveAccessError(
      "Reconnect Google so MediaBinder can share the folders you choose.",
      "scope"
    )
  // drive.file may only share a folder when the app can also write every file
  // inside it, so existing folders must be shared by the user in Drive.
  if (reasons.includes("appNotAuthorizedToChild"))
    throw new DriveAccessError(
      "Google only lets you add MediaBinder to a folder that already has files.",
      "not-allowed"
    )
  if (response.status === 404)
    throw new DriveAccessError(
      "Google Drive can't find that folder.",
      "not-found"
    )
  if (response.status === 403)
    throw new DriveAccessError(
      "Google Drive didn't allow MediaBinder to share this folder.",
      "not-allowed"
    )
  throw new DriveAccessError(
    `Google Drive is unavailable (${response.status}). Try again.`,
    "unavailable"
  )
}

export interface DriveFolder {
  id: string
  name: string
  mimeType: string
  owners?: { emailAddress?: string }[]
}
export async function getFolder(token: string, folderId: string) {
  const folder = (await driveCall(token, "GET", `files/${folderId}`, {
    fields: "id,name,mimeType,owners(emailAddress)",
    supportsAllDrives: "true",
  })) as DriveFolder
  if (folder.mimeType !== FOLDER_MIME)
    throw new Error("Choose a Google Drive folder.")
  return folder
}

// A new, empty folder created by MediaBinder: drive.file can share it, and
// everything the user later adds to it inherits the share.
export async function createFolder(userToken: string, name: string) {
  return (await driveCall(
    userToken,
    "POST",
    "files",
    { fields: "id,name", supportsAllDrives: "true" },
    { name, mimeType: FOLDER_MIME }
  )) as { id: string; name: string }
}

// Adds the service account as a viewer. Drive returns the existing permission
// when the account already has access, so repeating this is harmless.
export async function shareFolderWithApp(userToken: string, folderId: string) {
  const email = serviceAccountEmail()
  if (!email)
    throw new Error("MediaBinder's Drive service account is not set up.")
  const permission = (await driveCall(
    userToken,
    "POST",
    `files/${folderId}/permissions`,
    { sendNotificationEmail: "false", supportsAllDrives: "true", fields: "id" },
    { type: "user", role: "reader", emailAddress: email }
  )) as { id: string }
  return permission.id
}

export async function removeAppShare(
  userToken: string,
  folderId: string,
  permissionId: string
) {
  await driveCall(
    userToken,
    "DELETE",
    `files/${folderId}/permissions/${encodeURIComponent(permissionId)}`,
    { supportsAllDrives: "true" }
  )
}

// Sharing can take a moment to reach the service account.
export async function waitForAppAccess(
  folderId: string,
  attempts = 5,
  delay = 800
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await getFolder(await serviceAccountToken(), folderId)
    } catch (error) {
      if (
        attempt >= attempts ||
        !(error instanceof DriveAccessError) ||
        !["not-found", "not-allowed"].includes(error.code)
      )
        throw error
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}
