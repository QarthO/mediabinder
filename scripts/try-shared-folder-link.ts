// Manual end-to-end check of shared-folder mode against real Google APIs.
// Usage (inside the web container): pnpm exec tsx scripts/try-shared-folder-link.ts
// Creates a folder with the signed-in user's drive.file token (app-created files
// are visible to that token, like a folder chosen in the picker), then runs the
// same link flow the settings page uses: share with the service account, link, sync.
import { rows, pool } from "../src/lib/database.server"
import * as Drive from "../src/effect/drive-api.server"
import { syncDrive } from "../src/lib/drive.server"
import { runTracedAppEffect } from "../src/effect/runtime.server"
import { mutate } from "../src/lib/library.server"

const [user] = await rows<{ id: string; email: string }>(
  "SELECT u.id,u.email FROM user u JOIN account a ON a.userId=u.id AND a.providerId='google' ORDER BY u.createdAt LIMIT 1"
)
if (!user) throw new Error("Sign in with Google first.")
const headers = new Headers() // no browser session: tokens are looked up by user ID
const token = await runTracedAppEffect(Drive.token(undefined, user.id))
const folder = (await (
  await fetch("https://www.googleapis.com/drive/v3/files?fields=id,name", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "MediaBinder picker-path test",
      mimeType: "application/vnd.google-apps.folder",
    }),
  })
).json()) as { id: string; name: string }
console.log("created folder with user token:", folder.name)
const result = await runTracedAppEffect(
  mutate("source", { folderId: folder.id, share: true }, user.id, headers)
)
console.log("link result:", JSON.stringify(result))
const [linked] = await rows<{ share_permission_id: string | null }>(
  "SELECT share_permission_id FROM drive_folder WHERE user_id=? AND folder_id=?",
  [user.id, folder.id]
)
console.log("stored share permission:", Boolean(linked?.share_permission_id))
console.log("sync:", JSON.stringify(await syncDrive(user.id)))
await runTracedAppEffect(
  mutate("remove-source", { folderId: folder.id }, user.id, headers)
)
const perms = (await (
  await fetch(
    `https://www.googleapis.com/drive/v3/files/${folder.id}/permissions?fields=permissions(emailAddress,role)`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
).json()) as { permissions?: { emailAddress?: string; role: string }[] }
console.log(
  "after unlink, service account still shared:",
  perms.permissions?.some((p) =>
    p.emailAddress?.endsWith("gserviceaccount.com")
  ) ?? "unknown"
)
await fetch(`https://www.googleapis.com/drive/v3/files/${folder.id}`, {
  method: "DELETE",
  headers: { Authorization: `Bearer ${token}` },
})
console.log("deleted test folder")
await pool.end()
