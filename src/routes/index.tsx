import { createFileRoute, redirect } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { useState } from "react"
import { authClient } from "@/lib/auth-client"
import { Brand } from "@/components/brand"
import { Effect } from "effect"
import { LockKeyhole } from "lucide-react"
const loginStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { getRequestHeaders } = await import("@tanstack/react-start/server")
  const { auth } = await import("@/lib/auth.server")
  const session = await auth.api.getSession({ headers: getRequestHeaders() })
  return { signedIn: !!session, configured: !!process.env.GOOGLE_CLIENT_ID }
})
export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const status = await loginStatus()
    if (status.signedIn)
      throw redirect({ to: "/media", search: { folders: [] } })
    return status
  },
  component: Login,
})
function Login() {
  const { configured } = Route.useRouteContext(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("")
  return (
    <main className="login">
      <div className="login-top">
        <Brand />
        <span className="eyebrow">YOUR PRIVATE MEDIA LIBRARY</span>
      </div>
      <section className="login-card">
        <div className="login-emblem">
          <Brand compact />
        </div>
        <h1>A place for every frame.</h1>
        <p>
          Your media, thoughtfully organized.
          <br />
          Sign in to open your binder.
        </p>
        <button
          type="button"
          aria-label="Sign in with Google"
          aria-busy={busy}
          className="google-button"
          disabled={busy || !configured}
          onClick={async () => {
            setBusy(true)
            setError("")
            await Effect.runPromise(
              Effect.tryPromise(() =>
                authClient.signIn.social({
                  provider: "google",
                  callbackURL: "/media",
                  errorCallbackURL: "/?error=signin",
                })
              ).pipe(
                Effect.flatMap((result) =>
                  result.error
                    ? Effect.fail(new Error(result.error.message))
                    : Effect.void
                ),
                Effect.catch(() =>
                  Effect.sync(() => {
                    setError("Could not sign in. Try again.")
                    setBusy(false)
                  })
                ),
                Effect.withSpan("auth.google.signIn")
              )
            )
          }}
        >
          <img src="/google-signin-dark.png" alt="" width="180" height="40" />
        </button>
        {busy && (
          <span className="sr-only" role="status">
            Opening Google…
          </span>
        )}
        {!configured && (
          <p className="form-error">
            Configure Google OAuth in the server environment to sign in.
          </p>
        )}
        {(error ||
          (typeof window !== "undefined" &&
            new URLSearchParams(window.location.search).has("error"))) && (
          <p className="form-error" role="alert">
            {error || "Sign-in was not completed. Check access and try again."}
          </p>
        )}
        <div className="login-private">
          <LockKeyhole size={13} />
          Private by design. Access is restricted.
        </div>
      </section>
      <footer className="login-footer">
        <span>STORED IN DRIVE. ORGANIZED HERE.</span>
        <a href="/privacy">Privacy</a>
      </footer>
    </main>
  )
}
