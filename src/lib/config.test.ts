import { describe, expect, it } from "vite-plus/test"
import {
  appEnvironment,
  appUrl,
  developmentBypassEnabled,
  databaseOptions,
  driveWebhookUrl,
  validateRuntimeConfig,
} from "./config"

const env = {
  MEDIABINDER_URL: "https://media.example.com/",
  DB_HOST: "mysql",
  DB_NAME: "media",
  DB_USER: "media",
  DB_PASS: "special:@/#?% password",
  BETTER_AUTH_SECRET: "x".repeat(32),
  GOOGLE_CLIENT_ID: "id",
  GOOGLE_CLIENT_SECRET: "secret",
}

describe("runtime configuration", () => {
  it("accepts the standalone variables and literal database passwords", () => {
    validateRuntimeConfig(env)
    expect(appUrl(env)).toBe("https://media.example.com")
    expect(appUrl({ ...env, BETTER_AUTH_URL: "https://old.example.com" })).toBe(
      "https://media.example.com"
    )
    expect(databaseOptions(env)).toEqual({
      host: "mysql",
      database: "media",
      user: "media",
      password: env.DB_PASS,
      port: 3306,
    })
    expect(databaseOptions({ ...env, DB_PORT: "3307" }).port).toBe(3307)
  })

  it("keeps legacy configuration working and rejects invalid values", () => {
    expect(appUrl({ BETTER_AUTH_URL: "http://localhost:3100" })).toBe(
      "http://localhost:3100"
    )
    expect(databaseOptions({ DATABASE_URL: "mysql://legacy" })).toEqual({
      uri: "mysql://legacy",
    })
    expect(() =>
      databaseOptions({ DATABASE_URL: "mysql://legacy", DB_HOST: "mysql" })
    ).toThrow(/DB_NAME/)
    expect(() => databaseOptions({ ...env, DB_PORT: "invalid" })).toThrow(
      /DB_PORT/
    )
    expect(() =>
      appUrl({ MEDIABINDER_URL: "https://user:secret@example.com" })
    ).toThrow(/without a path or credentials/)
    expect(() =>
      validateRuntimeConfig({ ...env, BETTER_AUTH_SECRET: "short" })
    ).toThrow(/BETTER_AUTH_SECRET/)
    expect(() =>
      validateRuntimeConfig({ ...env, GOOGLE_CLIENT_ID: "" })
    ).toThrow(/GOOGLE_CLIENT_ID/)
  })

  it("defaults Drive callbacks to the origin and disables them locally", () => {
    expect(driveWebhookUrl(env)).toBe(
      "https://media.example.com/api/drive/webhook"
    )
    expect(
      driveWebhookUrl({ BETTER_AUTH_URL: "https://legacy.example.com" })
    ).toBe("https://legacy.example.com/api/drive/webhook")
    for (const origin of [
      "http://localhost:3100",
      "https://localhost",
      "https://127.0.0.1",
      "https://[::1]",
      "http://media.example.com",
    ])
      expect(driveWebhookUrl({ MEDIABINDER_URL: origin })).toBeNull()
    expect(
      driveWebhookUrl({
        ...env,
        DRIVE_WEBHOOK_URL: "https://tunnel.example.com/api/drive/webhook",
      })
    ).toBe("https://tunnel.example.com/api/drive/webhook")
    for (const callback of [
      "invalid",
      "http://example.com",
      "https://localhost",
      "https://user:secret@example.com",
      "https://example.com?secret=value",
    ])
      expect(() =>
        validateRuntimeConfig({ ...env, DRIVE_WEBHOOK_URL: callback })
      ).toThrow(/DRIVE_WEBHOOK_URL/)
  })

  it("takes MEDIABINDER_ENVIRONMENT as dev or prod, and prod by default", () => {
    expect(appEnvironment(env)).toBe("prod")
    expect(appEnvironment({ ...env, MEDIABINDER_ENVIRONMENT: "dev" })).toBe(
      "dev"
    )
    for (const value of ["development", "production", "DEV"])
      expect(() =>
        validateRuntimeConfig({ ...env, MEDIABINDER_ENVIRONMENT: value })
      ).toThrow("MEDIABINDER_ENVIRONMENT must be dev or prod")
  })

  it("enables the development bypass only for dev outside production", () => {
    const dev = { ...env, MEDIABINDER_ENVIRONMENT: "dev" }
    expect(developmentBypassEnabled(env)).toBe(false)
    expect(developmentBypassEnabled({ ...dev, NODE_ENV: "development" })).toBe(
      true
    )
    expect(developmentBypassEnabled({ ...dev, NODE_ENV: "production" })).toBe(
      false
    )
  })
})
