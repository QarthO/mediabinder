import {
  createFileRoute,
  redirect,
  stripSearchParams,
} from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { readWorkspacePreferences } from "@/lib/workspace-preferences"
import { Workspace } from "@/components/workspace"
const sessionCheck = createServerFn({ method: "GET" }).handler(async () => {
  const { getRequestHeaders } = await import("@tanstack/react-start/server")
  const { auth } = await import("@/lib/auth.server")
  const headers = getRequestHeaders()
  return {
    signedIn: !!(await auth.api.getSession({ headers })),
    preferences: readWorkspacePreferences(headers.get("cookie")),
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
    return { preferences: status.preferences }
  },
  component: Workspace,
})
