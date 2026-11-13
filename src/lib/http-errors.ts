import { ZodError } from "zod"
import {
  AuthenticationError,
  LockBusyError,
  NotFoundError,
  ValidationError,
} from "@/effect/errors"

// Tagged errors that describe a request the app refused or couldn't satisfy,
// so they are answered but not reported. error-policy.ts shares this list.
export const EXPECTED_ERROR_TAGS: ReadonlySet<string> = new Set([
  "AuthenticationError",
  "LockBusyError",
  "NotFoundError",
  "ValidationError",
])

export const SYNC_BUSY_MESSAGE = "A sync is already running. Try again shortly."

/**
 * Only known user-facing messages leave the server; others become the
 * fallback. This is a security boundary: a database error, a stack, a path
 * or a Google response must never reach a client.
 */
export function publicErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error &&
    /^(Google |Reconnect |Choose |A sync |The source |This file|Drive watch|Network request)/.test(
      error.message
    )
    ? error.message
    : fallback
}

/** True for errors that are answered on purpose and need no error report. */
export function isHandledError(error: unknown) {
  return (
    error instanceof Response ||
    error instanceof ZodError ||
    error instanceof AuthenticationError ||
    error instanceof LockBusyError ||
    error instanceof NotFoundError ||
    error instanceof ValidationError
  )
}

/**
 * The one mapping from a failure to the response the client sees. Known
 * outcomes keep their status and message. Anything else becomes a 400 with
 * `fallback` unless its message is on the public list, so internal details
 * never leave the server.
 *
 * A `Response` is passed through: modules that haven't been converted yet
 * still throw them.
 */
export function errorResponse(
  error: unknown,
  fallback = "Something went wrong. Please try again."
): Response {
  if (error instanceof Response) return error
  if (error instanceof ZodError)
    return Response.json(
      { error: error.issues[0]?.message ?? "Check the entered values." },
      { status: 400 }
    )
  if (error instanceof AuthenticationError)
    return new Response(error.message, { status: 401 })
  if (error instanceof NotFoundError)
    return new Response(error.message, { status: 404 })
  // A user's sync lock is the only busy lock with a message of its own; a
  // busy catalog lock gets the caller's fallback, as it always has.
  if (error instanceof LockBusyError && error.lock.startsWith("drive:"))
    return Response.json({ error: SYNC_BUSY_MESSAGE }, { status: 400 })
  if (error instanceof ValidationError)
    return Response.json({ error: error.message }, { status: 400 })
  return Response.json(
    { error: publicErrorMessage(error, fallback) },
    { status: 400 }
  )
}
