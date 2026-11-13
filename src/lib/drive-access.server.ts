import { createSign } from "node:crypto"
import { readFileSync } from "node:fs"
import { Cache, Duration, Effect, Exit, Result, Schedule, Schema } from "effect"
import { HttpClientRequest } from "effect/http"
import {
  DRIVE_API,
  driveJsonRequest,
  driveOperation,
} from "@/effect/drive-http.server"
import {
  DriveApiError,
  DriveAccessError,
  ValidationError,
} from "@/effect/errors"

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
  const value: Partial<ServiceAccount> & { type?: string } =
    Result.getOrThrowWith(
      Result.try(() => JSON.parse(text)),
      () =>
        new Error(
          "GOOGLE_SERVICE_ACCOUNT_KEY must be a service account JSON key (raw or base64)."
        )
    )
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
// Optional Google Group (e.g. sync@rien.cloud) whose only member is the service
// account. Users share with this friendlier address; the account reads through
// its group membership.
export function shareGroup(env: Environment = process.env) {
  return env.GOOGLE_DRIVE_SHARE_GROUP?.trim().toLowerCase() || null
}
// The address users share folders with.
export const shareAddress = () => shareGroup() ?? serviceAccountEmail()

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

// Tokens are cached process-wide and refreshed a minute before expiry. The
// cache also shares one in-flight sign-in between concurrent callers.
const requestServiceAccountToken = Effect.fnUntraced(function* () {
  const sa = serviceAccount()
  if (!sa) return yield* new DriveApiError({ operation: "oauth2.token" })
  const request = HttpClientRequest.post(sa.token_uri).pipe(
    HttpClientRequest.bodyUrlParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signAssertion(sa),
    })
  )
  const { status, body } = yield* driveJsonRequest("oauth2.token", request, {
    timeout: "15 seconds",
  })
  const token = Schema.decodeUnknownOption(TokenResponse)(body)
  if (status < 200 || status >= 300 || token._tag === "None")
    return yield* new DriveApiError({ operation: "oauth2.token", status })
  return {
    token: token.value.access_token,
    expires: Date.now() + (token.value.expires_in ?? 3600) * 1000,
  }
})
const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  expires_in: Schema.optionalKey(Schema.Number),
})
const tokenCache = Effect.runSync(
  Cache.makeWith(requestServiceAccountToken, {
    capacity: 1,
    timeToLive: (exit) =>
      Exit.isSuccess(exit)
        ? Duration.millis(Math.max(0, exit.value.expires - Date.now() - 60_000))
        : Duration.zero,
  })
)
export function resetServiceAccountCache() {
  account = undefined
  Effect.runSync(Cache.invalidateAll(tokenCache))
}
export const serviceAccountToken = Effect.fn("DriveAccess.serviceAccountToken")(
  function* () {
    if (!serviceAccount())
      return yield* new DriveApiError({ operation: "oauth2.token" })
    return (yield* Cache.get(tokenCache, "service-account")).token
  }
)

const GoogleError = Schema.Struct({
  error: Schema.optionalKey(
    Schema.Struct({
      errors: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({ reason: Schema.optionalKey(Schema.String) })
        )
      ),
      details: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({ reason: Schema.optionalKey(Schema.String) })
        )
      ),
    })
  ),
})
const decodeGoogleError = Schema.decodeUnknownOption(GoogleError)

// What Google's refusal means for the person, in words they can act on.
function refusal(status: number, payload: unknown) {
  const error = decodeGoogleError(payload)
  const reasons =
    error._tag === "Some"
      ? [
          ...(error.value.error?.errors ?? []),
          ...(error.value.error?.details ?? []),
        ].map((item) => item.reason ?? "")
      : []
  if (
    status === 401 ||
    reasons.some((reason) =>
      /insufficientPermissions|SCOPE_INSUFFICIENT|authError/i.test(reason)
    )
  )
    return new DriveAccessError({
      code: "scope",
      message:
        "Reconnect Google so MediaBinder can share the folders you choose.",
    })
  // drive.file may only share a folder when the app can also write every file
  // inside it, so existing folders must be shared by the user in Drive.
  if (reasons.includes("appNotAuthorizedToChild"))
    return new DriveAccessError({
      code: "not-allowed",
      message:
        "Google only lets you add MediaBinder to a folder that already has files.",
    })
  if (status === 404)
    return new DriveAccessError({
      code: "not-found",
      message: "Google Drive can't find that folder.",
    })
  if (status === 403)
    return new DriveAccessError({
      code: "not-allowed",
      message: "Google Drive didn't allow MediaBinder to share this folder.",
    })
  return new DriveAccessError({
    code: "unavailable",
    message: `Google Drive is unavailable (${status}). Try again.`,
  })
}

// One Drive v3 call that must succeed. A refusal becomes a DriveAccessError;
// a call that never got an answer is a DriveApiError.
const driveCall = Effect.fnUntraced(function* (
  token: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string>,
  body?: unknown
) {
  const operation = driveOperation(method, path)
  const request = HttpClientRequest.make(method)(`${DRIVE_API}/${path}`, {
    urlParams: params,
    headers: { Authorization: `Bearer ${token}` },
  })
  const { status, body: payload } = yield* driveJsonRequest(
    operation,
    body ? HttpClientRequest.bodyJsonUnsafe(request, body) : request,
    { timeout: "20 seconds" }
  )
  if (status >= 200 && status < 300) return payload
  return yield* refusal(status, payload)
})

const decodeResponse = <S extends Schema.Constraint>(
  operation: string,
  schema: S,
  payload: unknown
) =>
  Schema.decodeUnknownEffect(schema)(payload).pipe(
    Effect.mapError((cause) => new DriveApiError({ operation, cause }))
  )

const Folder = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  owners: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ emailAddress: Schema.optionalKey(Schema.String) })
    )
  ),
  capabilities: Schema.optionalKey(
    Schema.Struct({ canListChildren: Schema.optionalKey(Schema.Boolean) })
  ),
})
export type DriveFolder = typeof Folder.Type

export const getFolder = Effect.fn("DriveAccess.getFolder")(function* (
  token: string,
  folderId: string
) {
  const payload = yield* driveCall(token, "GET", `files/${folderId}`, {
    fields:
      "id,name,mimeType,owners(emailAddress),capabilities(canListChildren)",
    supportsAllDrives: "true",
  })
  const folder = yield* decodeResponse("files.get", Folder, payload)
  if (folder.mimeType !== FOLDER_MIME)
    return yield* new ValidationError({
      message: "Choose a Google Drive folder.",
    })
  return folder
})

const CreatedFolder = Schema.Struct({ id: Schema.String, name: Schema.String })

// A new, empty folder created by MediaBinder: drive.file can share it, and
// everything the user later adds to it inherits the share.
export const createFolder = Effect.fn("DriveAccess.createFolder")(function* (
  userToken: string,
  name: string
) {
  const payload = yield* driveCall(
    userToken,
    "POST",
    "files",
    { fields: "id,name", supportsAllDrives: "true" },
    { name, mimeType: FOLDER_MIME }
  )
  return yield* decodeResponse("files.create", CreatedFolder, payload)
})

const Permission = Schema.Struct({ id: Schema.String })

// Adds the service account as a viewer. Drive returns the existing permission
// when the account already has access, so repeating this is harmless.
export const shareFolderWithApp = Effect.fn("DriveAccess.shareFolderWithApp")(
  function* (userToken: string, folderId: string) {
    const email = shareAddress()
    if (!email)
      return yield* new DriveApiError({ operation: "permissions.create" })
    const payload = yield* driveCall(
      userToken,
      "POST",
      `files/${folderId}/permissions`,
      {
        sendNotificationEmail: "false",
        supportsAllDrives: "true",
        fields: "id",
      },
      {
        type: shareGroup() ? "group" : "user",
        role: "reader",
        emailAddress: email,
      }
    )
    return (yield* decodeResponse("permissions.create", Permission, payload)).id
  }
)

export const removeAppShare = Effect.fn("DriveAccess.removeAppShare")(
  function* (userToken: string, folderId: string, permissionId: string) {
    yield* driveCall(
      userToken,
      "DELETE",
      `files/${folderId}/permissions/${encodeURIComponent(permissionId)}`,
      { supportsAllDrives: "true" }
    )
  }
)

// Sharing can take a moment to reach the service account. Seeing a folder is
// not enough: inside a limited-access folder, Drive shows the folder to anyone
// with access to its parent but lists its contents as empty. Only "can't see
// it yet" answers are tried again, `delay` apart, up to `attempts` in all.
export const waitForAppAccess = Effect.fn("DriveAccess.waitForAppAccess")(
  function* (folderId: string, attempts = 5, delay = 800) {
    return yield* Effect.gen(function* () {
      const folder = yield* getFolder(yield* serviceAccountToken(), folderId)
      if (folder.capabilities?.canListChildren !== true)
        return yield* new DriveAccessError({
          code: "not-allowed",
          message: "MediaBinder can't open this folder's contents.",
        })
      return folder
    }).pipe(
      Effect.retry({
        schedule: Schedule.spaced(Duration.millis(delay)),
        times: attempts - 1,
        while: (error) =>
          error._tag === "DriveAccessError" &&
          (error.code === "not-found" || error.code === "not-allowed"),
      })
    )
  }
)
