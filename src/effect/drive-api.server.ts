import { Effect } from "effect"
import { HttpClientRequest } from "effect/http"
import { auth } from "@/lib/auth.server"
import {
  serviceAccountToken,
  sharedFolderMode,
} from "@/lib/drive-access.server"
import {
  DRIVE_API,
  driveJsonRequest,
  driveOperation,
} from "./drive-http.server"
import { DriveApiError, DriveReconnectError, ValidationError } from "./errors"

// Reading Google Drive for a signed-in person, as the `Drive` area. This module
// must not import the app runtime: the runtime builds the thumbnail source from
// it, so the Promise facades for unconverted callers live in lib/drive.server.ts.

/** The person's own Google access token, refreshed by Better Auth. */
export const token = Effect.fn("Drive.token")(function* (
  headers?: Headers,
  userId?: string
) {
  const result = yield* Effect.tryPromise({
    try: () =>
      auth.api.getAccessToken({
        ...(headers ? { headers } : {}),
        body: { providerId: "google", ...(userId ? { userId } : {}) },
      }),
    catch: (cause) => new DriveReconnectError({ cause }),
  })
  if (!result.accessToken) return yield* new DriveReconnectError()
  return result.accessToken
})

/**
 * Token used to read Drive content. In shared-folder mode that is MediaBinder's
 * service account (routes check ownership first); otherwise the user's token.
 */
export const readToken = (
  userId?: string,
  headers?: Headers
): Effect.Effect<string, DriveApiError | DriveReconnectError> =>
  sharedFolderMode() ? serviceAccountToken() : token(headers, userId)

const statusMessage = (status: number) =>
  status === 401
    ? "Google access expired. Reconnect Google Drive in settings."
    : status === 403
      ? "Google Drive denied access. Check the Drive API and folder permissions."
      : status === 404
        ? "This file or folder is no longer available in Google Drive."
        : `Google Drive is unavailable (${status}). Try again.`

/**
 * A Drive v3 GET, decoded as JSON. The failure carries a message written for
 * the person. The result is only as typed as the caller's `T`: callers ask
 * Drive for `fields` they then read.
 *
 * Not a span: a sync calls this once per page of files. The request is counted
 * in the Drive request metrics instead.
 */
export const json = Effect.fnUntraced(function* <T>(
  token: string,
  path: string,
  params: Record<string, string> = {}
): Effect.fn.Return<T, DriveApiError> {
  const request = HttpClientRequest.get(`${DRIVE_API}/${path}`, {
    urlParams: params,
    headers: { Authorization: `Bearer ${token}` },
  })
  const operation = driveOperation("GET", path)
  const { status, body } = yield* driveJsonRequest(operation, request, {
    timeout: "30 seconds",
  }).pipe(
    Effect.mapError(
      (error) =>
        new DriveApiError({
          operation,
          ...(error.status === undefined ? {} : { status: error.status }),
          // Only a request that got no usable answer fails here; Google's
          // refusals are answered below.
          userMessage: "Network request failed. Please retry.",
          cause: error.cause,
        })
    )
  )
  if (status < 200 || status >= 300)
    return yield* new DriveApiError({
      operation,
      status,
      userMessage: statusMessage(status),
    })
  return body as T
})

/** Every folder the person's own token can see, by name. */
export const listFolders = Effect.fn("Drive.listFolders")(function* (
  headers: Headers
) {
  // The service account can see every user's shared folders, so browsing is
  // only offered with full-Drive user tokens. Shared-folder mode uses Google's picker.
  if (sharedFolderMode())
    return yield* new ValidationError({
      message: "Choose folders with the Google Drive picker.",
    })
  const accessToken = yield* token(headers)
  const folders: { id: string; name: string }[] = []
  let pageToken = ""
  do {
    const page = yield* json<{
      files: { id: string; name: string }[]
      nextPageToken?: string
    }>(accessToken, "files", {
      q: "trashed = false and mimeType = 'application/vnd.google-apps.folder'",
      fields: "nextPageToken,files(id,name)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      ...(pageToken ? { pageToken } : {}),
    })
    folders.push(...page.files)
    pageToken = page.nextPageToken ?? ""
  } while (pageToken)
  return folders.sort((a, b) => a.name.localeCompare(b.name))
})
