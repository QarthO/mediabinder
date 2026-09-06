import { test } from "node:test"
import assert from "node:assert/strict"
import { Effect } from "effect"
import { libraryPost } from "./library-http"

test("production POST accepts MEDIABINDER_URL alone, rejects foreign origins, and handles failures", async () => {
  const original = process.env.MEDIABINDER_URL,
    legacy = process.env.BETTER_AUTH_URL
  process.env.MEDIABINDER_URL = "https://rien.cloud/"
  delete process.env.BETTER_AUTH_URL
  let calls = 0
  const dependencies = {
    session: async () => ({ user: { id: "owner" } }),
    mutate: async (action: string) => {
      calls++
      assert.equal(action, "folders")
      return [{ id: "folder" }]
    },
  }
  const request = (origin: string) =>
    new Request("http://container:3100/api/library", {
      method: "POST",
      headers: { origin, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "folders" }),
    })
  await Effect.runPromise(
    Effect.tryPromise(async () => {
      const success = await Effect.runPromise(
        libraryPost(request("https://rien.cloud"), dependencies)
      )
      assert.equal(success.status, 200)
      assert.deepEqual(await success.json(), [{ id: "folder" }])
      assert.equal(
        (
          await Effect.runPromise(
            libraryPost(request("https://evil.example"), dependencies)
          )
        ).status,
        403
      )
      assert.equal(calls, 1)
      assert.equal(
        (
          await Effect.runPromise(
            libraryPost(request("https://rien.cloud"), {
              ...dependencies,
              session: async () => {
                throw new Response("Sign in", { status: 401 })
              },
            })
          )
        ).status,
        401
      )
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (original === undefined) delete process.env.MEDIABINDER_URL
          else process.env.MEDIABINDER_URL = original
          if (legacy === undefined) delete process.env.BETTER_AUTH_URL
          else process.env.BETTER_AUTH_URL = legacy
        })
      )
    )
  )
})
