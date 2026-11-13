import { describe, expect, test } from "vite-plus/test"
import { ZodError } from "zod"
import {
  AuthenticationError,
  DatabaseError,
  DriveApiError,
  NotFoundError,
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

  test("known outcomes keep their status and message", async () => {
    const signedOut = errorResponse(new AuthenticationError(), fallback)
    expect(signedOut.status).toBe(401)
    expect(await body(signedOut)).toBe("Sign in to continue.")

    const missing = errorResponse(new NotFoundError({ resource: "Tag" }))
    expect(missing.status).toBe(404)
    expect(await body(missing)).toBe("Tag not found.")

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
      new ValidationError({ message: "x" }),
    ])
      expect(isHandledError(error)).toBe(true)
  })

  test("a thrown Response from an unconverted module is passed through", () => {
    const refused = new Response("Tag not found.", { status: 404 })
    expect(errorResponse(refused, fallback)).toBe(refused)
    expect(isHandledError(refused)).toBe(true)
  })
})
