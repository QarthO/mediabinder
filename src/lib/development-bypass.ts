import { developmentBypassEnabled } from "./config"

// What the development login bypass is made of. No server imports: the login
// page and tests read these too. Whether the bypass is on is
// `developmentBypassEnabled()` in ./config.

export const DEV_BYPASS_COOKIE = "mediabinder-dev-auth-bypass"
export const DEV_BYPASS_MAX_AGE = 60 * 60 * 12

export const developmentUser = {
  id: "mediabinder-dev-user",
  name: "MediaBinder Developer",
  email: "developer@mediabinder.local",
  image: null,
} as const

export function hasBypassCookie(cookieHeader: string | null | undefined) {
  return (cookieHeader ?? "")
    .split(";")
    .some((cookie) => cookie.trim() === `${DEV_BYPASS_COOKIE}=enabled`)
}

/**
 * A cheap pre-check, before any session lookup: whether the cookies could
 * belong to a signed-in visitor, by a Better Auth session or the bypass.
 */
export function mayHaveSession(cookieHeader: string | null | undefined) {
  return (
    (cookieHeader ?? "").includes("better-auth.session_token") ||
    (developmentBypassEnabled() && hasBypassCookie(cookieHeader))
  )
}

/**
 * The cookie "Skip login for development" sets, or null when the bypass is
 * off. The server function that sets it sends nothing in that case.
 */
export function developmentLoginCookie() {
  if (!developmentBypassEnabled()) return null
  return {
    name: DEV_BYPASS_COOKIE,
    value: "enabled",
    options: {
      httpOnly: true,
      maxAge: DEV_BYPASS_MAX_AGE,
      path: "/",
      sameSite: "lax",
      secure: false,
    },
  } as const
}
