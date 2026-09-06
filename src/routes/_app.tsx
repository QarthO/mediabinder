import {
  createFileRoute,
  redirect,
  stripSearchParams,
} from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { Workspace } from "@/components/workspace"
const sessionCheck = createServerFn({ method: "GET" }).handler(async () => {
  const { getRequestHeaders } = await import("@tanstack/react-start/server")
  const { auth } = await import("@/lib/auth.server")
  return !!(await auth.api.getSession({ headers: getRequestHeaders() }))
})
export const Route = createFileRoute("/_app")({
  validateSearch: (search: Record<string, unknown>) => ({
    folders: Array.isArray(search.folders)
      ? search.folders.filter((id): id is string => typeof id === "string")
      : ([] as string[]),
  }),
  search: { middlewares: [stripSearchParams({ folders: [] })] },
  beforeLoad: async () => {
    if (!(await sessionCheck())) throw redirect({ to: "/" })
  },
  component: Workspace,
})
