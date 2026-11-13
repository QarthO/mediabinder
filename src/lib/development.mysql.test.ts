import { generateKeyPairSync } from "node:crypto"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vite-plus/test"

import { runAppEffect } from "@/effect/runtime.server"
import { Route } from "@/routes/api.library"
import { describeMysql, useTestDatabase } from "@/test/database"
import { count, execute, rows, routeHandler, stubGoogle } from "@/test/fixtures"
import { DEV_BYPASS_COOKIE, developmentUser } from "./development-bypass"
import { resetServiceAccountCache } from "./drive-access.server"
import { prepare } from "./development.server"

const FOLDER_ID = "dev-folder-id-0123456789"

// A dev stack's developer: a real user row, a prelinked folder, and one
// initial sync that is queued once.
describeMysql("development stack", () => {
  useTestDatabase()
  const google = stubGoogle()
  beforeAll(() => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = JSON.stringify({
      type: "service_account",
      client_email: "sync@mediabinder-test.iam.gserviceaccount.com",
      private_key: privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
    })
    resetServiceAccountCache()
  })
  afterAll(() => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY
    resetServiceAccountCache()
  })
  afterEach(() => vi.unstubAllEnvs())
  // The reset between tests empties the workspace row the migrations seed.
  beforeEach(() => execute("INSERT IGNORE INTO workspace(id) VALUES (1)"))

  const dev = { MEDIABINDER_ENVIRONMENT: "dev", NODE_ENV: "development" }
  const run = (env: Record<string, string | undefined>) =>
    runAppEffect("test", prepare(env))
  const driveAnswers = (reachable: boolean) =>
    google((url) => {
      if (url.hostname === "oauth2.googleapis.com")
        return Response.json({ access_token: "sa-token", expires_in: 3600 })
      return reachable
        ? Response.json({
            id: FOLDER_ID,
            name: "Some folder",
            mimeType: "application/vnd.google-apps.folder",
          })
        : new Response("down", { status: 503 })
    })

  test("creates the developer once, as owner, and links the folder with one sync", async () => {
    driveAnswers(true)
    const env = { ...dev, MEDIABINDER_DEV_FOLDER_ID: FOLDER_ID }
    await run(env)
    await run(env)

    expect(
      await rows("SELECT role FROM user WHERE id=?", [developmentUser.id])
    ).toEqual([{ role: "superuser" }])
    expect(await rows("SELECT owner_id FROM workspace WHERE id=1")).toEqual([
      { owner_id: developmentUser.id },
    ])
    expect(
      await count("drive_folder WHERE user_id=?", [developmentUser.id])
    ).toBe(1)
    expect(
      await rows(
        "SELECT requested,completed FROM drive_sync_state WHERE user_id=?",
        [developmentUser.id]
      )
    ).toEqual([{ requested: 1, completed: 0 }])
  })

  test("does not queue another sync once one has completed", async () => {
    driveAnswers(true)
    const env = { ...dev, MEDIABINDER_DEV_FOLDER_ID: FOLDER_ID }
    await run(env)
    await execute("UPDATE drive_sync_state SET completed=requested")
    await run(env)
    expect(
      await rows("SELECT requested,completed FROM drive_sync_state")
    ).toEqual([{ requested: 1, completed: 1 }])
  })

  test("falls back to a neutral folder name when Drive is unreachable", async () => {
    driveAnswers(false)
    await run({ ...dev, MEDIABINDER_DEV_FOLDER_ID: FOLDER_ID })
    expect(
      await rows<{ folder_name: string }>(
        "SELECT folder_name FROM drive_folder"
      )
    ).toEqual([{ folder_name: "Development folder" }])
  })

  test("does nothing outside dev, or in a production build", async () => {
    driveAnswers(true)
    await run({ MEDIABINDER_DEV_FOLDER_ID: FOLDER_ID })
    await run({
      ...dev,
      NODE_ENV: "production",
      MEDIABINDER_DEV_FOLDER_ID: FOLDER_ID,
    })
    expect(await count("user")).toBe(0)
    expect(await count("drive_folder")).toBe(0)
  })

  test("a route that needs a session accepts the developer's cookie", async () => {
    vi.stubEnv("MEDIABINDER_ENVIRONMENT", "dev")
    await run(dev)
    const request = new Request("http://localhost:3100/api/library", {
      headers: { cookie: `${DEV_BYPASS_COOKIE}=enabled` },
    })
    const handler = routeHandler<{ request: Request }>(Route, "GET")
    const response = await handler({ request })
    expect(response.status).toBe(200)
    expect(
      ((await response.json()) as { user: { email: string } }).user.email
    ).toBe(developmentUser.email)
  })
})
