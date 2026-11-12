import { pool, rows } from "./database.server"
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
export async function revokeLegacyDriveGrants() {
  if (!sharedFolderMode()) return 0
  const accounts = await rows<{ id: string; userId: string }>(
    "SELECT id,userId FROM account WHERE providerId='google' AND scope LIKE ?",
    [`%${LEGACY_SCOPE}%`]
  )
  let revoked = 0
  for (const account of accounts) {
    try {
      await revokeGrant(account.userId)
      // Forget the revoked tokens so MediaBinder asks for a fresh sign-in
      // instead of using them.
      await pool.execute(
        `UPDATE account SET accessToken=NULL,refreshToken=NULL,idToken=NULL,
        accessTokenExpiresAt=NULL,refreshTokenExpiresAt=NULL,scope=NULL,updatedAt=NOW(3)
        WHERE id=? AND scope LIKE ?`,
        [account.id, `%${LEGACY_SCOPE}%`]
      )
      revoked++
    } catch (error) {
      console.warn(
        "Could not revoke an old full-Drive Google grant:",
        error instanceof Error ? error.message : "Unknown error"
      )
    }
  }
  return revoked
}

async function revokeGrant(userId: string) {
  let token: string
  try {
    token = await driveToken(undefined, userId)
  } catch {
    // No usable token: Google already dropped the grant (revoked, expired or
    // the user removed MediaBinder), so there is nothing left to revoke.
    return
  }
  // Revoking an access token also revokes its refresh token: the whole grant.
  const response = await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  })
  await response.body?.cancel()
  // 400 means Google no longer recognises the token, so the grant is gone.
  if (!response.ok && response.status !== 400)
    throw new Error(`Google refused the revocation (${response.status}).`)
}
