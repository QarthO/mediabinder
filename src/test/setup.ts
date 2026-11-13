import { expect } from "vite-plus/test"

// Modules such as `@/lib/auth.server` and the database pool read these when
// imported but never reach MySQL or Google until used, so placeholders keep
// tests that don't need them offline. Application URLs are left unset: the
// config tests pass their own environment and must not inherit one.
process.env.DB_HOST ??= "127.0.0.1"
process.env.DB_PORT ??= "3306"
process.env.DB_NAME ??= "mediabinder_test"
process.env.DB_USER ??= "mediabinder"
process.env.DB_PASS ??= "mediabinder"
process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret-0"
process.env.GOOGLE_CLIENT_ID ??= "test-client-id"
process.env.GOOGLE_CLIENT_SECRET ??= "test-client-secret"

// The MySQL suites import modules that load Better Auth, which needs the
// application's URL even when the suite is skipped. Other tests leave it unset.
if (expect.getState().testPath?.endsWith(".mysql.test.ts"))
  process.env.MEDIABINDER_URL ??= "http://localhost:3100"

// With MEDIABINDER_TEST_MYSQL=1, each Vitest worker gets its own database so
// files running in parallel never see each other's rows. This file runs once
// per test file, and a worker's environment outlives a file, so the suffix is
// added only once.
if (process.env.MEDIABINDER_TEST_MYSQL === "1") {
  process.env.MEDIABINDER_URL ??= "http://localhost:3100"
  const suffix = `_${process.env.VITEST_POOL_ID ?? "1"}`
  if (!process.env.DB_NAME.endsWith(`_test${suffix}`)) {
    if (!process.env.DB_NAME.endsWith("_test")) {
      throw new Error(
        "MEDIABINDER_TEST_MYSQL needs a disposable DB_NAME ending in _test"
      )
    }
    process.env.DB_NAME = `${process.env.DB_NAME}${suffix}`
  }
}
