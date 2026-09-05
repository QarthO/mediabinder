import {
  createRootRouteWithContext,
  HeadContent,
  Scripts,
  Outlet,
} from "@tanstack/react-router"
import type { QueryClient } from "@tanstack/react-query"
import { Toaster } from "sonner"
import css from "../styles.css?url"
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
  {
    head: () => ({
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { title: "MediaBinder" },
        { name: "robots", content: "noindex, nofollow" },
      ],
      links: [
        { rel: "stylesheet", href: css },
        { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      ],
    }),
    shellComponent: ({ children }) => (
      <html lang="en" className="dark">
        <head>
          <HeadContent />
        </head>
        <body>
          {children}
          <Toaster theme="dark" position="bottom-right" richColors />
          <Scripts />
        </body>
      </html>
    ),
    component: Outlet,
    notFoundComponent: () => (
      <main className="login">
        <h1>Page not found</h1>
        <a href="/">Back to your library</a>
      </main>
    ),
    errorComponent: ({ reset }) => (
      <main className="login">
        <h1>Could not load MediaBinder</h1>
        <p>Please try again.</p>
        <button onClick={reset}>Retry</button>
      </main>
    ),
  }
)
