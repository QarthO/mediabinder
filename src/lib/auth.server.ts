import { betterAuth } from "better-auth"
import { tanstackStartCookies } from "better-auth/tanstack-start"
import { APIError } from "better-auth/api"
import { Effect } from "effect"
import { AuthenticationError } from "@/effect/errors"
import mysql from "mysql2/promise"
import type { RowDataPacket } from "mysql2/promise"
import { appEnvironment, appUrl, databaseOptions } from "./config"
import { developmentBypassEnabled } from "./config"
import { developmentUser, hasBypassCookie } from "./development-bypass"
import { sharedFolderMode } from "./drive-access.server"
/**
 * Better Auth's connections, and nothing else's: it takes a mysql2 pool, so
 * this is the one place MediaBinder still has one. Everything else goes
 * through the Database service. Better Auth makes a handful of short queries
 * per request (session lookup, token reads, the sign-up hooks below), so four
 * connections, opened on demand, are plenty. `src/effect/database.ts` has the
 * per-process connection total.
 */
export const AUTH_POOL_SIZE = 4
// A bad MEDIABINDER_ENVIRONMENT fails here, at startup, with a clear error.
appEnvironment()
const pool = mysql.createPool({
  ...databaseOptions(),
  connectionLimit: AUTH_POOL_SIZE,
  timezone: "Z",
  dateStrings: true,
})
if (import.meta.hot) import.meta.hot.dispose(() => pool.end())

/** Closes Better Auth's connections, for a process that is shutting down. */
export const closeAuthPool = () => pool.end()

const ownerOf = async () => {
  const [result] = await pool.execute<RowDataPacket[]>(
    "SELECT owner_id FROM workspace WHERE id = 1"
  )
  return (result[0] as { owner_id: string | null }).owner_id
}

export const auth = betterAuth({
  appName: "MediaBinder",
  baseURL: appUrl(),
  secret: process.env.BETTER_AUTH_SECRET,
  database: pool,
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      accessType: "offline",
      // Refresh the name and profile picture from Google on every sign-in, so a
      // changed Google picture shows up here. MediaBinder has no way to edit
      // either, so nothing a user set is overwritten.
      overrideUserInfoOnSignIn: true,
      prompt: "select_account consent",
      // Shared-folder mode only needs per-file access for the picker and sharing.
      scope: [
        sharedFolderMode()
          ? "https://www.googleapis.com/auth/drive.file"
          : "https://www.googleapis.com/auth/drive.readonly",
      ],
    },
  },
  account: { encryptOAuthTokens: true },
  // Every request checks the session, and a library view makes dozens of
  // thumbnail requests at once. A signed cookie caches the session so most
  // checks skip MySQL; it is refreshed from the database once it is older
  // than maxAge. A session ended elsewhere (signing out on another device,
  // a deleted account) can keep working here for up to that long.
  session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
  user: {
    additionalFields: {
      role: { type: "string", defaultValue: "user", input: false },
    },
  },
  rateLimit: { enabled: true, window: 60, max: 60 },
  // Lets session checks in route handlers and server functions set the
  // refreshed cache cookie on their response. Must stay the last plugin.
  plugins: [tanstackStartCookies()],
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (!user.emailVerified)
            throw new APIError("FORBIDDEN", {
              message: "A verified Google account is required.",
            })
          if ((await ownerOf()) && process.env.ALLOW_SIGNUPS !== "true")
            throw new APIError("FORBIDDEN", {
              message: "New account registration is disabled.",
            })
          return { data: { ...user, role: "user" } }
        },
        after: async (user) => {
          // The atomic claim means concurrent first logins cannot both become superusers.
          await pool.execute(
            "UPDATE workspace SET owner_id = ? WHERE id = 1 AND owner_id IS NULL",
            [user.id]
          )
          if ((await ownerOf()) === user.id)
            await pool.execute("UPDATE user SET role = ? WHERE id = ?", [
              "superuser",
              user.id,
            ])
          else if (process.env.ALLOW_SIGNUPS !== "true") {
            await pool.execute("DELETE FROM user WHERE id = ?", [user.id])
            throw new APIError("FORBIDDEN", {
              message: "New account registration is disabled.",
            })
          }
        },
      },
    },
  },
})

type Session = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>

// The developer the bypass cookie stands for. Their `user` row is made when a
// dev stack starts (src/lib/development.server.ts).
function developmentSession(): Session {
  const now = new Date()
  return {
    session: {
      id: `development:${developmentUser.id}`,
      userId: developmentUser.id,
      token: "",
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      createdAt: now,
      updatedAt: now,
      ipAddress: null,
      userAgent: null,
    },
    user: {
      ...developmentUser,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
      role: "superuser",
    },
  } as unknown as Session
}

/**
 * The one session lookup. Everything that asks who is signed in goes through
 * this, never `auth.api.getSession` directly, so the development bypass
 * cookie resolves to the developer identity everywhere. The cookie counts only
 * when `developmentBypassEnabled()`: `MEDIABINDER_ENVIRONMENT=dev` and a
 * `NODE_ENV` other than production.
 */
export async function getSession(headers: Headers): Promise<Session | null> {
  if (developmentBypassEnabled() && hasBypassCookie(headers.get("cookie")))
    return developmentSession()
  return auth.api.getSession({ headers })
}

/**
 * The signed-in session for a request, or an `AuthenticationError` (401).
 * Better Auth rejecting the lookup itself, for instance because MySQL is
 * down, is a defect rather than a missing session, so it never reads as the
 * user being signed out.
 */
export const requireSession = Effect.fn("Auth.requireSession")(function* (
  headers: Headers
) {
  const session = yield* Effect.promise(() => getSession(headers))
  if (!session) return yield* new AuthenticationError()
  return session
})
