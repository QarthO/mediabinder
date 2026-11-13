// What browser telemetry may carry. MediaBinder's rule is that no media
// contents or user data leave the browser in spans or logs, so everything
// here reduces a value to a route template, a type name, a status or a
// stack frame. Pure and dependency-free, so it stays in the initial bundle
// if it is ever needed there and is easy to test.

const staticRoutes = new Set([
  "/",
  "/login",
  "/privacy",
  "/media",
  "/sets",
  "/settings",
  "/api/library",
])

/**
 * A pathname as its route template: set and media IDs collapse to `:id`, and
 * anything that is not a known route becomes `/:other`, so an unexpected
 * path (which could embed a name) is never exported.
 */
export function routeTemplate(pathname: string): string {
  const path =
    pathname.length > 1 ? pathname.replace(/\/+$/u, "") : pathname || "/"
  if (staticRoutes.has(path)) return path
  if (/^\/sets\/[^/]+$/u.test(path)) return "/sets/:id"
  if (/^\/api\/media\/[^/]+$/u.test(path)) return "/api/media/:id"
  return "/:other"
}

export interface ScrubbedException {
  readonly type: string
  readonly message: string
  readonly stacktrace: string
  readonly status?: number
}

const maxFrames = 12

/**
 * An error reduced to what is safe to export. The message is never kept:
 * errors can quote what the person typed or a media name ("Could not rename
 * 'holiday.jpg'"), and JSON parse errors quote the text they choke on. What
 * remains is the error type (class name or tag), an HTTP status when there
 * is one, and the stack frames, which hold bundle URLs and line numbers.
 * Frames are filtered line by line, so a multi-line message cannot ride
 * along on its own lines.
 */
export function scrubException(cause: unknown): ScrubbedException {
  const type = safeType(cause)
  const status =
    typeof cause === "object" &&
    cause !== null &&
    "status" in cause &&
    typeof cause.status === "number" &&
    Number.isInteger(cause.status)
      ? cause.status
      : undefined
  const stack =
    cause instanceof Error && typeof cause.stack === "string" ? cause.stack : ""
  const frames = stack
    .split("\n")
    .filter((line) => /:\d+:\d+\)?$/u.test(line.trim()))
    .slice(0, maxFrames)
    .map((line) => line.trim().slice(0, 300))
  return {
    type,
    message: status === undefined ? type : `${type} (status ${status})`,
    stacktrace: frames.join("\n"),
    ...(status === undefined ? {} : { status }),
  }
}

function safeType(cause: unknown): string {
  const raw =
    typeof cause === "object" && cause !== null
      ? "_tag" in cause && typeof cause._tag === "string"
        ? cause._tag
        : cause instanceof Error
          ? cause.name
          : "Error"
      : typeof cause === "string"
        ? "Error"
        : typeof cause
  // A class name or tag, never free text.
  return /^[A-Za-z][A-Za-z0-9_.]{0,63}$/u.test(raw) ? raw : "Error"
}
