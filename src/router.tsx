import { createRouter } from "@tanstack/react-router"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { libraryQuery } from "./lib/api"
import { routeTree } from "./routeTree.gen"
export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
  })
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
    dehydrate: () => {
      const state = queryClient.getQueryState(libraryQuery.queryKey)
      return {
        library: state?.data,
        libraryUpdatedAt: state?.dataUpdatedAt,
      }
    },
    hydrate: (dehydrated) => {
      if (dehydrated.library)
        queryClient.setQueryData(libraryQuery.queryKey, dehydrated.library, {
          updatedAt: dehydrated.libraryUpdatedAt,
        })
    },
    Wrap: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  })
}
declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
