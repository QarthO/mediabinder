import * as React from "react"
import { useRouter } from "@tanstack/react-router"
import type { AnyRouter } from "@tanstack/react-router"
import { reportBrowserError } from "@/lib/browser-telemetry"
import { Button } from "@/components/ui/button"

interface AppErrorPageProps {
  error: unknown
  reset: () => void
}

export function AppErrorPage({ error, reset }: AppErrorPageProps) {
  React.useEffect(() => {
    // reportBrowserError reports each error object once, so a re-render or a
    // window error event for the same error is not counted twice.
    reportBrowserError(error, { operation: "app.error_page" })
  }, [error])

  return (
    <main className="login">
      <section className="login-card">
        <h1>Could not load MediaBinder</h1>
        <p>Please try again.</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {/* A route's loader error stays on its match, so clearing the
              boundary alone would show the same error again. */}
          <Button
            onClick={() => {
              reset()
              window.location.reload()
            }}
          >
            Retry
          </Button>
          <Button variant="outline" asChild>
            <a href="/">Back to your library</a>
          </Button>
        </div>
        {import.meta.env.DEV && (
          <pre className="mt-5 max-h-32 overflow-auto p-3 text-left text-xs whitespace-pre-wrap text-destructive">
            {error instanceof Error ? error.message : String(error)}
          </pre>
        )}
      </section>
    </main>
  )
}

export function AppNotFoundPage() {
  return (
    <main className="login">
      <section className="login-card">
        <h1>Page not found</h1>
        <div className="mt-6 flex justify-center">
          <Button asChild>
            <a href="/">Back to your library</a>
          </Button>
        </div>
      </section>
    </main>
  )
}

// Catches render errors outside any route match and clears itself on the next
// navigation. The router's global catch boundary is disabled in favor of it.
export function AppRouterErrorBoundary({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()
  return (
    <AppRouterErrorBoundaryImpl router={router}>
      {children}
    </AppRouterErrorBoundaryImpl>
  )
}

class AppRouterErrorBoundaryImpl extends React.Component<
  { children: React.ReactNode; router: AnyRouter },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }
  unsubscribeFromNavigation: (() => void) | null = null

  static getDerivedStateFromError(error: unknown) {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }

  componentDidMount() {
    this.unsubscribeFromNavigation = this.props.router.subscribe(
      "onBeforeNavigate",
      () => {
        if (this.state.error) this.setState({ error: null })
      }
    )
  }

  componentWillUnmount() {
    this.unsubscribeFromNavigation?.()
  }

  render() {
    return this.state.error ? (
      <AppErrorPage
        error={this.state.error}
        reset={() => this.setState({ error: null })}
      />
    ) : (
      this.props.children
    )
  }
}
