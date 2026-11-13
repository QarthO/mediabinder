import { Predicate } from "effect"

// This module also runs in the browser's telemetry chunk, so it names Better
// Auth's and Zod's errors by `name` instead of importing their classes.

// Tagged errors that describe a request the app refused or couldn't satisfy,
// so they are answered but not reported.
const EXPECTED_ERROR_TAGS: ReadonlySet<string> = new Set([
  "AuthenticationError",
  "DriveReconnectError",
  "LockBusyError",
  "NotFoundError",
  "UnknownActionError",
  "ValidationError",
])

// Tagged errors that carry an HTTP status. Below 500 they describe a request
// the app refused or couldn't satisfy, such as a missing thumbnail.
const STATUS_ERROR_TAGS = new Set([
  "DriveApiError",
  "NetworkError",
  "ThumbnailError",
])

/** Outcomes the app handles on purpose, so they are not reported as errors. */
export function isExpectedAppError(value: unknown): boolean {
  if (value instanceof Response) return value.status < 500
  if (!Predicate.isObject(value)) return false
  if ("name" in value && value.name === "ZodError") return true
  if ("name" in value && value.name === "APIError") {
    return !("statusCode" in value) || isClientStatus(value.statusCode)
  }
  if ("name" in value && value.name === "AbortError") return true
  if (!("_tag" in value) || !Predicate.isString(value._tag)) return false
  if (EXPECTED_ERROR_TAGS.has(value._tag)) return true
  // A preview too large to buffer has no status: its caller falls back to
  // streaming the original.
  // Google refusing a share or lookup is the person's to fix, except when it
  // answered with something other than a refusal.
  if (value._tag === "DriveAccessError") {
    return !("code" in value) || value.code !== "unavailable"
  }
  if (value._tag === "PreviewError") {
    return !("status" in value) || isClientStatus(value.status)
  }
  return STATUS_ERROR_TAGS.has(value._tag) && "status" in value
    ? isClientStatus(value.status)
    : false
}

const isClientStatus = (status: unknown) =>
  Predicate.isNumber(status) && status < 500
