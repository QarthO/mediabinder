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
