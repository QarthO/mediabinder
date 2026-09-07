import {
  createFileRoute,
  redirect,
  stripSearchParams,
} from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { Workspace } from "@/components/workspace"
import { libraryQuery } from "@/lib/api"
const sessionCheck = createServerFn({ method: "GET" }).handler(async () => {
  const { getRequestHeaders } = await import("@tanstack/react-start/server")
  const { auth } = await import("@/lib/auth.server")
  const { readWorkspacePreferences } = await import(
    "@/lib/workspace-preferences.server"
  )
  const headers = getRequestHeaders()
  return {
    signedIn: !!(await auth.api.getSession({ headers })),
    preferences: readWorkspacePreferences(headers.get("cookie")),
    view: /(?:^|;\s*)mediabinder_view=list(?:;|$)/.test(
      headers.get("cookie") ?? ""
    )
      ? ("list" as const)
      : ("grid" as const),
  }
})
export const Route = createFileRoute("/_app")({
  validateSearch: (search: Record<string, unknown>) => ({
    folders: Array.isArray(search.folders)
      ? search.folders.filter((id): id is string => typeof id === "string")
      : ([] as string[]),
  }),
  search: { middlewares: [stripSearchParams({ folders: [] })] },
  beforeLoad: async () => {
    const status = await sessionCheck()
    if (!status.signedIn) throw redirect({ to: "/" })
    return { preferences: status.preferences, view: status.view }
  },
  loaderDeps: ({ search }) => ({ folders: search.folders }),
  loader: async ({ context, location, deps }) => {
    const data = await context.queryClient.ensureQueryData({
      ...libraryQuery,
      revalidateIfStale: true,
    })
    const setId = location.pathname.startsWith("/sets/")
      ? decodeURIComponent(location.pathname.slice(6))
      : null
    if (setId && !data.sets.some((set) => set.id === setId))
      throw redirect({
        to: "/sets",
        search: { folders: deps.folders },
        replace: true,
      })
    const folders = deps.folders.filter((id) =>
      data.workspace.sources.some((source) => source.folder_id === id)
    )
    if (folders.length !== deps.folders.length)
      throw redirect({
        to: location.pathname as "/media",
        search: { folders },
        replace: true,
      })
  },
  headers: () => ({ "Cache-Control": "private, no-store", Vary: "Cookie" }),
  component: Workspace,
})
