/**
 * Names a request span by its server function, or by its path with
 * identifier segments replaced, so span names stay a small, stable set.
 * Ported from Kiln.
 */
export function requestSpanName(
  method: string,
  pathname: string,
  serverFn?: { readonly filename: string; readonly name: string }
): string {
  if (serverFn) {
    return `${serverFn.filename.split("/").at(-1)}:${serverFn.name}`
  }
  const path = pathname
    .split("/")
    .map((segment) => (isIdentifierSegment(segment) ? ":id" : segment))
    .join("/")
  return `${method} ${path}`
}

/**
 * Requests that get no trace: Docker's health probe runs every 30 seconds
 * and would bury real requests, and built assets carry nothing worth timing.
 */
export function isUntracedRequest(pathname: string): boolean {
  return pathname === "/api/health" || pathname.startsWith("/assets/")
}

// Digits, long mixed IDs (catalog and set IDs) and anything very long. Plain
// words such as `callback` or `google` in Better Auth paths stay readable.
function isIdentifierSegment(segment: string): boolean {
  return (
    /^\d+$/u.test(segment) ||
    (segment.length >= 8 && /\d/u.test(segment)) ||
    segment.length > 32
  )
}
