import { Cause, Effect, Exit } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"
import {
  DEV_BYPASS_COOKIE,
  developmentLoginCookie,
  developmentUser,
  mayHaveSession,
} from "./development-bypass"

// The skip-login cookie is a security boundary: it must mean "the developer"
// only on a dev stack, and never on a production build.
const cookie = `${DEV_BYPASS_COOKIE}=enabled`
const headers = new Headers({ cookie })

describe("development login bypass", () => {
  beforeEach(() => {
    vi.stubEnv("MEDIABINDER_URL", "http://localhost:3100")
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  async function session(headers: Headers) {
    const { auth, requireSession } = await import("./auth.server")
    // Anything but the bypass falls through to Better Auth: no session.
    vi.spyOn(auth.api, "getSession").mockResolvedValue(null as never)
    return Effect.runPromiseExit(requireSession(headers))
  }
  const refused = (exit: Exit.Exit<unknown, unknown>) =>
    Exit.isFailure(exit) &&
    String(Cause.squash(exit.cause)).includes("AuthenticationError")

  it("is ignored unless MEDIABINDER_ENVIRONMENT is dev", async () => {
    expect(refused(await session(headers))).toBe(true)
    vi.stubEnv("MEDIABINDER_ENVIRONMENT", "prod")
    expect(refused(await session(headers))).toBe(true)
    expect(developmentLoginCookie()).toBeNull()
    expect(mayHaveSession(cookie)).toBe(false)
  })

  it("is ignored in a production build even when dev is set", async () => {
    vi.stubEnv("MEDIABINDER_ENVIRONMENT", "dev")
    vi.stubEnv("NODE_ENV", "production")
    expect(refused(await session(headers))).toBe(true)
    expect(developmentLoginCookie()).toBeNull()
    expect(mayHaveSession(cookie)).toBe(false)
  })

  it("signs in the developer on a dev stack, and nobody else", async () => {
    vi.stubEnv("MEDIABINDER_ENVIRONMENT", "dev")
    const exit = await session(headers)
    expect(Exit.isSuccess(exit) && exit.value.user.id).toBe(developmentUser.id)
    expect(mayHaveSession(cookie)).toBe(true)
    expect(developmentLoginCookie()).toMatchObject({
      name: DEV_BYPASS_COOKIE,
      value: "enabled",
      options: { httpOnly: true, sameSite: "lax", path: "/", maxAge: 43200 },
    })
    // Only the exact cookie value counts.
    expect(
      refused(await session(new Headers({ cookie: `${DEV_BYPASS_COOKIE}=1` })))
    ).toBe(true)
  })
})
