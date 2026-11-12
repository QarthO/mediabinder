import { afterEach, describe, expect, vi } from "vite-plus/test"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { libraryPost } from "./library-http"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("library POST", () => {
  it.effect(
    "accepts MEDIABINDER_URL alone, rejects foreign origins and maps failures",
    () =>
      Effect.gen(function* () {
        vi.stubEnv("MEDIABINDER_URL", "https://rien.cloud/")
        vi.stubEnv("BETTER_AUTH_URL", undefined)
        let calls = 0
        const reported: unknown[] = []
        const dependencies = {
          session: async () => ({ user: { id: "owner" } }),
          mutate: async (action: string) => {
            calls++
            expect(action).toBe("folders")
            return [{ id: "folder" }]
          },
          report: (cause: unknown) => {
            reported.push(cause)
          },
        }
        const request = (origin: string) =>
          new Request("http://container:3100/api/library", {
            method: "POST",
            headers: { origin, "Content-Type": "application/json" },
            body: JSON.stringify({ action: "folders" }),
          })

        const success = yield* libraryPost(
          request("https://rien.cloud"),
          dependencies
        )
        expect(success.status).toBe(200)
        expect(yield* Effect.promise(() => success.json())).toEqual([
          { id: "folder" },
        ])

        const foreign = yield* libraryPost(
          request("https://evil.example"),
          dependencies
        )
        expect(foreign.status).toBe(403)
        expect(calls).toBe(1)

        const signedOut = yield* libraryPost(request("https://rien.cloud"), {
          ...dependencies,
          session: async () => {
            throw new Response("Sign in", { status: 401 })
          },
        })
        expect(signedOut.status).toBe(401)
        expect(reported).toEqual([])

        // The response carries only the sanitized message; the cause is reported.
        const cause = new Error("database exploded at 10.0.0.5")
        const failed = yield* libraryPost(request("https://rien.cloud"), {
          ...dependencies,
          mutate: async () => {
            throw cause
          },
        })
        expect(failed.status).toBe(400)
        expect(yield* Effect.promise(() => failed.json())).toEqual({
          error: "Could not save this change. Please try again.",
        })
        expect(reported).toEqual([cause])
      })
  )
})
