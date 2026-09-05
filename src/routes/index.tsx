import { createFileRoute, redirect } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { Workspace } from "@/components/workspace"
const sessionCheck = createServerFn({ method: "GET" }).handler(async () => {
  const { getRequestHeaders } = await import("@tanstack/react-start/server")
  const { auth } = await import("@/lib/auth.server")
  return !!(await auth.api.getSession({ headers: getRequestHeaders() }))
})
export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    if (!(await sessionCheck())) throw redirect({ to: "/login" })
  },
  component: Workspace,
})
