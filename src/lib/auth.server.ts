import { betterAuth } from "better-auth"
import { APIError } from "better-auth/api"
import { pool, rows } from "./database.server"
import { appUrl } from "./config"
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
      scope: ["https://www.googleapis.com/auth/drive.readonly"],
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
          const [workspace] = await rows<{ owner_id: string | null }>(
            "SELECT owner_id FROM workspace WHERE id = 1"
          )
          if (workspace.owner_id && process.env.ALLOW_SIGNUPS !== "true")
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
          const [workspace] = await rows<{ owner_id: string }>(
            "SELECT owner_id FROM workspace WHERE id = 1"
          )
          if (workspace.owner_id === user.id)
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
export async function requireSession(headers: Headers) {
  const session = await auth.api.getSession({ headers })
  if (!session) throw new Response("Sign in to continue.", { status: 401 })
  return session
}
