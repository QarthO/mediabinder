import { createServerFn } from "@tanstack/react-start"

// Skip login for development. Both functions are public on purpose, and
// neither can matter outside a dev stack: the cookie is only honoured when
// `developmentBypassEnabled()` (see src/lib/development-bypass.ts).

/** Sets the bypass cookie, but only on a dev stack; otherwise does nothing. */
export const enableDevelopmentLogin = createServerFn({
  method: "POST",
}).handler(async () => {
  const { developmentLoginCookie } = await import("./development-bypass")
  const cookie = developmentLoginCookie()
  if (!cookie)
    return { enabled: false, reason: "Development login is not enabled." }
  const { setCookie } = await import("@tanstack/react-start/server")
  setCookie(cookie.name, cookie.value, cookie.options)
  return { enabled: true, reason: null }
})

/** Clears the bypass cookie; says whether the visitor had it. */
export const clearDevelopmentLogin = createServerFn({
  method: "POST",
}).handler(async () => {
  const { getRequestHeaders, deleteCookie } =
    await import("@tanstack/react-start/server")
  const { DEV_BYPASS_COOKIE, hasBypassCookie } =
    await import("./development-bypass")
  const had = hasBypassCookie(getRequestHeaders().get("cookie"))
  if (had) deleteCookie(DEV_BYPASS_COOKIE, { path: "/" })
  return { cleared: had }
})
