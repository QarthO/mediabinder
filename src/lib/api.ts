import { queryOptions } from "@tanstack/react-query"
import { createServerFn } from "@tanstack/react-start"
import { Effect } from "effect"
import { jsonRequest } from "@/effect/http"
import type { Library } from "./types"

const loadLibrary = createServerFn({ method: "GET" }).handler(async () => {
  const { getRequestHeaders } = await import("@tanstack/react-start/server")
  const { requireSession } = await import("./auth.server")
  const { library } = await import("./library.server")
  const session = await requireSession(getRequestHeaders())
  return library(session.user)
})

const signedIn = <A>(
  effect: Effect.Effect<A, import("@/effect/http").NetworkError>
) =>
  effect.pipe(
    Effect.tapError((error) =>
      Effect.sync(() => {
        if (error.status === 401) window.location.assign("/")
      })
    )
  )

export const libraryQuery = queryOptions({
  queryKey: ["library"],
  queryFn: ({ signal }): Promise<Library> =>
    typeof window === "undefined"
      ? loadLibrary({ signal })
      : Effect.runPromise(
          signedIn(
            jsonRequest<Library>(
              new URL("/api/library", window.location.origin).href,
              {
                errorMessage: (status) =>
                  status === 401
                    ? "Sign in to continue."
                    : "Could not load your library. Please retry.",
              }
            )
          ),
          { signal }
        ),
  staleTime: 30_000,
  refetchOnWindowFocus: true,
})
export function action<T = { ok: boolean }>(
  action: string,
  data: unknown = {}
): Promise<T> {
  return Effect.runPromise(
    signedIn(
      jsonRequest<T>(new URL("/api/library", window.location.origin).href, {
        method: "POST",
        body: { action, data },
        serverMessage: true,
        errorMessage: (status) =>
          status === 401
            ? "Sign in to continue."
            : "Could not save this change. Please retry.",
      })
    )
  )
}
