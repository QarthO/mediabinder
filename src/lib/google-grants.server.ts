import type { RowDataPacket } from "mysql2/promise"
import { Effect, Option } from "effect"
import { Database } from "@/effect/database"
import { DriveApiError } from "@/effect/errors"
import { runTracedAppEffect } from "@/effect/runtime.server"
import { sharedFolderMode } from "./drive-access.server"
import { driveToken } from "./drive.server"

const LEGACY_SCOPE = "https://www.googleapis.com/auth/drive.readonly"

// People who signed in before shared-folder mode granted MediaBinder full
// read access to their Drive (drive.readonly). Google adds earlier grants to
// every later sign-in (Better Auth always sends include_granted_scopes), so
// their consent screen keeps listing that restricted scope with Google's
// "unverified app" warning. Revoking the old grant once means their next
// Google sign-in asks only for drive.file, with no warning.
//
// MediaBinder keeps working in the meantime: the service account reads their
// shared folders. Only the folder picker needs their own Google token again,
// and Settings asks them to reconnect when it does.
export const revokeLegacy = Effect.fn("GoogleGrants.revokeLegacy")(
  function* () {
    if (!sharedFolderMode()) return 0
    const database = yield* Database
    const accounts = yield* database.queryRows<
      { id: string; userId: string } & RowDataPacket
    >(
      "googleGrants.accounts",
      "SELECT id,userId FROM account WHERE providerId='google' AND scope LIKE ?",
      [`%${LEGACY_SCOPE}%`]
    )
    let revoked = 0
    for (const account of accounts) {
      yield* revokeGrant(account.userId).pipe(
        // Forget the revoked tokens so MediaBinder asks for a fresh sign-in
        // instead of using them.
        Effect.andThen(
          database.execute(
            "googleGrants.forget",
            `UPDATE account SET accessToken=NULL,refreshToken=NULL,idToken=NULL,
        accessTokenExpiresAt=NULL,refreshTokenExpiresAt=NULL,scope=NULL,updatedAt=NOW(3)
        WHERE id=? AND scope LIKE ?`,
            [account.id, `%${LEGACY_SCOPE}%`]
          )
        ),
        Effect.andThen(
          Effect.sync(() => {
            revoked++
          })
        ),
        // One account failing must not stop the others.
        Effect.catch((error) =>
          Effect.logWarning(
            "Could not revoke an old full-Drive Google grant",
            error.message
          )
        )
      )
    }
    return revoked
  }
)

const revokeGrant = Effect.fn("GoogleGrants.revokeGrant")(function* (
  userId: string
) {
  const token = yield* Effect.tryPromise(() =>
    driveToken(undefined, userId)
  ).pipe(Effect.option)
  // No usable token: Google already dropped the grant (revoked, expired or
  // the user removed MediaBinder), so there is nothing left to revoke.
  if (Option.isNone(token)) return
  // Revoking an access token also revokes its refresh token: the whole grant.
  const response = yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: token.value }),
        signal,
      })
      await response.body?.cancel()
      return response
    },
    catch: (cause) => new DriveApiError({ operation: "revoke", cause }),
  })
  // 400 means Google no longer recognises the token, so the grant is gone.
  if (!response.ok && response.status !== 400)
    return yield* new DriveApiError({
      operation: "revoke",
      status: response.status,
    })
})

// For the Drive worker and tests, which still call it as a Promise.
export const revokeLegacyDriveGrants = () => runTracedAppEffect(revokeLegacy())
