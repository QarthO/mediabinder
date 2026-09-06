import { createFileRoute, redirect } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { useState } from "react"
import { authClient } from "@/lib/auth-client"
import { Brand } from "@/components/brand"
import { Button } from "@/components/ui/button"
import { LockKeyhole, ArrowUpRight } from "lucide-react"
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
        <Button
          className="google-button"
          disabled={busy || !configured}
          onClick={async () => {
            setBusy(true)
            setError("")
            try {
              const result = await authClient.signIn.social({
                provider: "google",
                callbackURL: "/media",
                errorCallbackURL: "/?error=signin",
              })
              if (result.error) throw new Error(result.error.message)
            } catch (e) {
              setError(
                e instanceof Error ? e.message : "Could not sign in. Try again."
              )
              setBusy(false)
            }
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="currentColor"
              d="M21.6 12.2c0-.7-.1-1.5-.2-2.2H12v4.3h5.4a4.7 4.7 0 0 1-2 3v2.6h3.3c1.9-1.8 2.9-4.4 2.9-7.7ZM12 22c2.7 0 5-1 6.7-2.5l-3.3-2.6c-.9.6-2 1-3.4 1a6 6 0 0 1-5.6-4.1H3v2.7A10 10 0 0 0 12 22ZM6.4 13.8a6 6 0 0 1 0-3.6V7.5H3a10 10 0 0 0 0 9l3.4-2.7ZM12 6.1c1.5 0 2.8.5 3.8 1.5L18.7 4A10 10 0 0 0 3 7.5l3.4 2.7A6 6 0 0 1 12 6.1Z"
            />
          </svg>
          {busy ? "Opening Google…" : "Continue with Google"}
          <ArrowUpRight size={16} />
        </Button>
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
        <span>MediaBinder</span>
      </footer>
    </main>
  )
}
