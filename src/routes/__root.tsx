import {
  createRootRouteWithContext,
  HeadContent,
  Scripts,
  Outlet,
} from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import type { QueryClient } from "@tanstack/react-query"
import { AppErrorPage, AppNotFoundPage } from "@/components/app-error-page"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import geist from "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url"
import mono from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url"
import css from "../styles.css?url"
import { browserTraceSampleRatioMeta } from "@/lib/browser-trace-sampling"

// Whether the browser should send telemetry, and its sample ratio. Null (no
// meta, no telemetry code, no requests) unless an OTLP endpoint is configured
// and the visitor has a session cookie: the proxy takes signed-in users only,
// so the login page has nothing to report to.
const browserTelemetryConfig = createServerFn({ method: "GET" }).handler(
  async () => {
    const { getRequestHeaders } = await import("@tanstack/react-start/server")
    const { Option } = await import("effect")
    const { runTracedAppEffect } = await import("@/effect/runtime.server")
    const { browserTraceSampleRatio } =
      await import("@/lib/browser-telemetry.server")
    const cookie = getRequestHeaders().get("cookie") ?? ""
    if (!cookie.includes("better-auth.session_token"))
      return { browserTraceSampleRatio: null }
    const ratio = await runTracedAppEffect(browserTraceSampleRatio())
    return { browserTraceSampleRatio: Option.getOrNull(ratio) }
  }
)
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
  {
    loader: () => browserTelemetryConfig(),
    staleTime: Infinity,
    head: ({ loaderData }) => ({
      meta: [
        { charSet: "utf-8" },
        ...(loaderData?.browserTraceSampleRatio == null
          ? []
          : [
              {
                name: browserTraceSampleRatioMeta,
                content: String(loaderData.browserTraceSampleRatio),
              },
            ]),
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { title: "MediaBinder" },
        { name: "robots", content: "noindex, nofollow" },
        { name: "theme-color", content: "#111316" },
      ],
      links: [
        {
          rel: "preload",
          href: geist,
          as: "font",
          type: "font/woff2",
          crossOrigin: "anonymous",
        },
        {
          rel: "preload",
          href: mono,
          as: "font",
          type: "font/woff2",
          crossOrigin: "anonymous",
        },
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
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster />
          <Scripts />
        </body>
      </html>
    ),
    component: Outlet,
    notFoundComponent: AppNotFoundPage,
    errorComponent: AppErrorPage,
  }
)
