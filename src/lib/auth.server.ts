import { betterAuth } from "better-auth"
import { APIError } from "better-auth/api"
import { Effect } from "effect"
import { AuthenticationError } from "@/effect/errors"
import mysql from "mysql2/promise"
import type { RowDataPacket } from "mysql2/promise"
import { appUrl, databaseOptions } from "./config"
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
  user: {
    additionalFields: {
      role: { type: "string", defaultValue: "user", input: false },
    },
  },
  rateLimit: { enabled: true, window: 60, max: 60 },
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

/**
 * The signed-in session for a request, or an `AuthenticationError` (401).
 * Better Auth rejecting the lookup itself, for instance because MySQL is
 * down, is a defect rather than a missing session, so it never reads as the
 * user being signed out.
 */
export const requireSession = Effect.fn("Auth.requireSession")(function* (
  headers: Headers
) {
  const session = yield* Effect.promise(() => auth.api.getSession({ headers }))
  if (!session) return yield* new AuthenticationError()
  return session
})
