import { createRouter } from "@tanstack/react-router"
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query"
import {
  AppNotFoundPage,
  AppRouterErrorBoundary,
} from "./components/app-error-page"
import { createAppQueryClient } from "./lib/query-client"
import { routeTree } from "./routeTree.gen"
export function getRouter() {
  const queryClient = createAppQueryClient()
  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultStructuralSharing: true,
    defaultNotFoundComponent: AppNotFoundPage,
    // AppRouterErrorBoundary is the single catch outside route matches.
    disableGlobalCatchBoundary: true,
    InnerWrap: AppRouterErrorBoundary,
  })
  // Provides the QueryClientProvider and carries every query the server
  // fetched, with its dataUpdatedAt, to the browser.
  setupRouterSsrQueryIntegration({ queryClient, router })
  return router
}
declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
