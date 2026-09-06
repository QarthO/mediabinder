import { test } from "node:test"
import assert from "node:assert/strict"
import {
  appUrl,
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
test("standalone configuration accepts eight runtime variables and literal database passwords", () => {
  validateRuntimeConfig(env)
  assert.equal(appUrl(env), "https://media.example.com")
  assert.equal(
    appUrl({ ...env, BETTER_AUTH_URL: "https://old.example.com" }),
    "https://media.example.com"
  )
  assert.deepEqual(databaseOptions(env), {
    host: "mysql",
    database: "media",
    user: "media",
    password: env.DB_PASS,
    port: 3306,
  })
  assert.equal(databaseOptions({ ...env, DB_PORT: "3307" }).port, 3307)
})
test("legacy configuration remains supported and invalid values fail without exposing secrets", () => {
  assert.equal(
    appUrl({ BETTER_AUTH_URL: "http://localhost:3100" }),
    "http://localhost:3100"
  )
  assert.deepEqual(databaseOptions({ DATABASE_URL: "mysql://legacy" }), {
    uri: "mysql://legacy",
  })
  assert.throws(
    () => databaseOptions({ DATABASE_URL: "mysql://legacy", DB_HOST: "mysql" }),
    /DB_NAME/
  )
  assert.throws(
    () => databaseOptions({ ...env, DB_PORT: "invalid" }),
    /DB_PORT/
  )
  assert.throws(
    () => appUrl({ MEDIABINDER_URL: "https://user:secret@example.com" }),
    /without a path or credentials/
  )
  assert.throws(
    () => validateRuntimeConfig({ ...env, BETTER_AUTH_SECRET: "short" }),
    /BETTER_AUTH_SECRET/
  )
  assert.throws(
    () => validateRuntimeConfig({ ...env, GOOGLE_CLIENT_ID: "" }),
    /GOOGLE_CLIENT_ID/
  )
})

test("Drive callbacks default to the application origin and stay disabled locally", () => {
  assert.equal(
    driveWebhookUrl(env),
    "https://media.example.com/api/drive/webhook"
  )
  assert.equal(
    driveWebhookUrl({ BETTER_AUTH_URL: "https://legacy.example.com" }),
    "https://legacy.example.com/api/drive/webhook"
  )
  for (const origin of [
    "http://localhost:3100",
    "https://localhost",
    "https://127.0.0.1",
    "https://[::1]",
    "http://media.example.com",
  ])
    assert.equal(driveWebhookUrl({ MEDIABINDER_URL: origin }), null)
  assert.equal(
    driveWebhookUrl({
      ...env,
      DRIVE_WEBHOOK_URL: "https://tunnel.example.com/api/drive/webhook",
    }),
    "https://tunnel.example.com/api/drive/webhook"
  )
  for (const callback of [
    "invalid",
    "http://example.com",
    "https://localhost",
    "https://user:secret@example.com",
    "https://example.com?secret=value",
  ])
    assert.throws(
      () => validateRuntimeConfig({ ...env, DRIVE_WEBHOOK_URL: callback }),
      /DRIVE_WEBHOOK_URL/
    )
})
