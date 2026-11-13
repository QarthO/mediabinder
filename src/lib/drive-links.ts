// Links into Google Drive's own web UI. `authuser` is the signed-in person's
// email, so Drive picks the right Google account when the browser has several.
// The email goes to Google in these URLs and nowhere else.

const fileUrl = (driveId: string, view: "view" | "preview", email: string) =>
  `https://drive.google.com/file/d/${encodeURIComponent(driveId)}/${view}?authuser=${encodeURIComponent(email)}`

/** Drive's embeddable player for a file. */
export const drivePreviewUrl = (driveId: string, email: string) =>
  fileUrl(driveId, "preview", email)

/** The file's page in Drive. */
export const driveViewUrl = (driveId: string, email: string) =>
  fileUrl(driveId, "view", email)
