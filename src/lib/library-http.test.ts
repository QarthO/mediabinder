import { afterEach, describe, expect, vi } from "vite-plus/test"
import { it } from "@effect/vitest"
import { Effect, Tracer } from "effect"
import { AuthenticationError } from "@/effect/errors"
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
          session: () => Effect.succeed({ user: { id: "owner" } }),
          mutate: (action: string) =>
            Effect.sync(() => {
              calls++
              expect(action).toBe("folders")
              return [{ id: "folder" }]
            }),
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
          session: () => Effect.fail(new AuthenticationError()),
        })
        expect(signedOut.status).toBe(401)
        expect(reported).toEqual([])

        // The response carries only the sanitized message; the cause is reported.
        const cause = new Error("database exploded at 10.0.0.5")
        const failed = yield* libraryPost(request("https://rien.cloud"), {
          ...dependencies,
          mutate: () => Effect.fail(cause),
        })
        expect(failed.status).toBe(400)
        expect(yield* Effect.promise(() => failed.json())).toEqual({
          error: "Could not save this change. Please try again.",
        })
        expect(reported).toEqual([cause])
      })
  )

  it.effect("tags the request span with the action name only", () =>
    Effect.gen(function* () {
      vi.stubEnv("MEDIABINDER_URL", "https://rien.cloud/")
      const spans: Array<Tracer.NativeSpan> = []
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })
      const request = new Request("http://container:3100/api/library", {
        method: "POST",
        headers: {
          origin: "https://rien.cloud",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "tags", data: { name: "secret tag" } }),
      })
      yield* libraryPost(request, {
        session: () => Effect.succeed({ user: { id: "owner" } }),
        mutate: () => Effect.succeed([]),
        report: () => undefined,
      }).pipe(
        Effect.withSpan("Library.post"),
        Effect.withSpan("POST /api/library"),
        Effect.withTracer(tracer)
      )
      for (const name of ["POST /api/library", "Library.post"]) {
        const span = spans.find((candidate) => candidate.name === name)
        expect(span?.attributes.get("mediabinder.action")).toBe("tags")
        expect(JSON.stringify([...span!.attributes])).not.toContain("secret")
      }
    })
  )
})
