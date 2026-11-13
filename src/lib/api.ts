import { environmentManager, queryOptions } from "@tanstack/react-query"
import { createServerFn } from "@tanstack/react-start"
import type { Library } from "./types"

const loadLibrary = createServerFn({ method: "GET" }).handler(async () => {
  const { getRequestHeaders } = await import("@tanstack/react-start/server")
  const { requireSession } = await import("./auth.server")
  const { load } = await import("./library.server")
  const { Effect } = await import("effect")
  const { errorResponse } = await import("./http-errors")
  const { runAppEffect } = await import("@/effect/runtime.server")
  const headers = getRequestHeaders()
  return runAppEffect(
    "Library.hydrate",
    Effect.gen(function* () {
      const session = yield* requireSession(headers)
      return yield* load(session.user)
    }).pipe(
      // Thrown, as before: the framework turns a Response into the reply.
      Effect.catchTag("AuthenticationError", (error) =>
        Effect.die(errorResponse(error))
      )
    )
  )
})

export const libraryQuery = queryOptions({
  queryKey: ["library"],
  queryFn: ({ signal }): Promise<Library> =>
    environmentManager.isServer()
      ? loadLibrary({ signal })
      : import("./api-request").then(({ requestLibrary }) =>
          requestLibrary<Library>({ signal })
        ),
  staleTime: 30_000,
  refetchOnWindowFocus: true,
})
export function action<T = { ok: boolean }>(
  action: string,
  data: unknown = {}
): Promise<T> {
  return import("./api-request").then(({ requestLibrary }) =>
    requestLibrary<T>({ method: "POST", body: { action, data }, action })
  )
}
