import { describe, expect } from "vite-plus/test"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { UnknownActionError } from "@/effect/errors"

describe("library actions", () => {
  // The action name comes from the request body, so names that exist on every
  // object must not reach the table's lookup.
  it.effect("refuse names that are not actions, including inherited ones", () =>
    Effect.gen(function* () {
      // Loading the table loads Better Auth, which needs the app's URL.
      process.env.MEDIABINDER_URL ??= "http://localhost:3100"
      const { mutate } = yield* Effect.promise(() => import("./library.server"))
      for (const action of ["nope", "constructor", "__proto__", "toString"]) {
        // Refused before any service is touched.
        const refused = mutate(
          action,
          {},
          "user",
          new Headers()
        ) as Effect.Effect<never, UnknownActionError>
        const error = yield* Effect.flip(refused)
        expect(error).toBeInstanceOf(UnknownActionError)
      }
    })
  )
})
