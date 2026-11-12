import { describe, expect, test } from "vite-plus/test"
import { ZodError } from "zod"
import {
  AuthenticationError,
  DatabaseError,
  DriveAccessError,
  DriveApiError,
  DriveReconnectError,
  LockBusyError,
  NotFoundError,
  UnknownActionError,
  ValidationError,
} from "@/effect/errors"
import { errorResponse, isHandledError } from "./http-errors"

const fallback = "Could not save this change. Please try again."
const body = async (response: Response) => response.text()

// The response is all a client ever learns about a failure, so internal
// details must not get through.
describe("error responses", () => {
  test("unexpected errors become the fallback, whatever they say", async () => {
    const internal = [
      new Error("connect ECONNREFUSED 10.0.0.5:3306"),
      new DatabaseError({
        operation: "catalog.resolve",
        cause: new Error("SELECT secret FROM user"),
      }),
      new DriveApiError({ operation: "revoke", status: 500 }),
      "a string",
      undefined,
    ]
    for (const error of internal) {
      const response = errorResponse(error, fallback)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: fallback })
      expect(isHandledError(error)).toBe(false)
    }
  })

  test("only the listed user-facing messages pass through", async () => {
    const response = errorResponse(
      new Error("Reconnect Google Drive in settings."),
      fallback
    )
    expect(await response.json()).toEqual({
      error: "Reconnect Google Drive in settings.",
    })
  })

  test("a Drive failure shows only the message its caller wrote", async () => {
    const shown = new DriveApiError({
      operation: "files.get",
      status: 404,
      userMessage:
        "This file or folder is no longer available in Google Drive.",
      cause: new Error("Bearer ya29.secret"),
    })
    expect(await errorResponse(shown, fallback).json()).toEqual({
      error: "This file or folder is no longer available in Google Drive.",
    })
    // The message is what sync runs and worker logs store as well.
    expect(shown.message).toBe(
      "This file or folder is no longer available in Google Drive."
    )
  })

  test("Drive refusals and reconnects keep their user-facing text", async () => {
    for (const [error, message] of [
      [
        new DriveAccessError({
          code: "scope",
          message:
            "Reconnect Google so MediaBinder can share the folders you choose.",
        }),
        "Reconnect Google so MediaBinder can share the folders you choose.",
      ],
      [new DriveReconnectError(), "Reconnect Google Drive in settings."],
    ] as const) {
      expect(await errorResponse(error, fallback).json()).toEqual({
        error: message,
      })
    }
    // Not on the public list before, so still the fallback.
    const hidden = new DriveAccessError({
      code: "not-allowed",
      message: "MediaBinder can't open this folder's contents.",
    })
    expect(await errorResponse(hidden, fallback).json()).toEqual({
      error: fallback,
    })
  })

  test("known outcomes keep their status and message", async () => {
    const signedOut = errorResponse(new AuthenticationError(), fallback)
    expect(signedOut.status).toBe(401)
    expect(await body(signedOut)).toBe("Sign in to continue.")

    const missing = errorResponse(new NotFoundError({ resource: "Tag" }))
    expect(missing.status).toBe(404)
    expect(await body(missing)).toBe("Tag not found.")

    const unknown = errorResponse(new UnknownActionError(), fallback)
    expect(unknown.status).toBe(404)
    expect(await body(unknown)).toBe("Unknown action.")

    const invalid = errorResponse(new ValidationError({ message: "Too long." }))
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: "Too long." })

    const zod = errorResponse(
      new ZodError([{ code: "custom", path: [], message: "Bad color." }])
    )
    expect(zod.status).toBe(400)
    expect(await zod.json()).toEqual({ error: "Bad color." })

    for (const error of [
      new AuthenticationError(),
      new NotFoundError({ resource: "Tag" }),
      new UnknownActionError(),
      new ValidationError({ message: "x" }),
    ])
      expect(isHandledError(error)).toBe(true)
  })

  test("a busy sync lock keeps its message and a busy catalog lock gets the fallback", async () => {
    const sync = new LockBusyError({
      operation: "drive.withUserLock",
      lock: "drive:user-1",
    })
    const busySync = errorResponse(sync, fallback)
    expect(busySync.status).toBe(400)
    expect(await busySync.json()).toEqual({
      error: "A sync is already running. Try again shortly.",
    })
    const catalog = new LockBusyError({
      operation: "catalog.transaction",
      lock: "mediabinder-catalog",
    })
    const busyCatalog = errorResponse(catalog, fallback)
    expect(busyCatalog.status).toBe(400)
    expect(await busyCatalog.json()).toEqual({ error: fallback })
    expect(isHandledError(sync) && isHandledError(catalog)).toBe(true)
  })

  test("a thrown Response from an unconverted module is passed through", () => {
    const refused = new Response("Tag not found.", { status: 404 })
    expect(errorResponse(refused, fallback)).toBe(refused)
    expect(isHandledError(refused)).toBe(true)
  })
})
