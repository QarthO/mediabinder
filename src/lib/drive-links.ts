// Links into Google Drive's own web UI. `authuser` is the signed-in person's
// email, so Drive picks the right Google account when the browser has several.
// The email goes to Google in these URLs and nowhere else.

const fileUrl = (driveId: string, view: "view" | "preview", email: string) =>
  `https://drive.google.com/file/d/${encodeURIComponent(driveId)}/${view}?authuser=${encodeURIComponent(email)}`

/**
 * Drive's embeddable player for a file. `vq=hd1080` asks it to start at
 * 1080p instead of choosing a low quality for the frame. It's an undocumented
 * hint, the same one YouTube's player takes, so Drive may ignore it; the player
 * still lets the viewer pick a quality either way.
 */
export const drivePreviewUrl = (driveId: string, email: string) =>
  `${fileUrl(driveId, "preview", email)}&vq=hd1080`

/** The file's page in Drive. */
export const driveViewUrl = (driveId: string, email: string) =>
  fileUrl(driveId, "view", email)
