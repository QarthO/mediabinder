import { queryOptions } from "@tanstack/react-query"
import { createServerFn } from "@tanstack/react-start"
import type { Library } from "./types"

const loadLibrary = createServerFn({ method: "GET" }).handler(async () => {
  const { getRequestHeaders } = await import("@tanstack/react-start/server")
  const { requireSession } = await import("./auth.server")
  const { library } = await import("./library.server")
  const session = await requireSession(getRequestHeaders())
  return library(session.user)
})

export const libraryQuery = queryOptions({
  queryKey: ["library"],
  queryFn: ({ signal }): Promise<Library> =>
    typeof window === "undefined"
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
    requestLibrary<T>({ method: "POST", body: { action, data } })
  )
}
