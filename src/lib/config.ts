type Environment = Record<string, string | undefined>

export function appUrl(env: Environment = process.env) {
  const value = env.MEDIABINDER_URL || env.BETTER_AUTH_URL
  if (!value)
    throw new Error("Set MEDIABINDER_URL to the public application URL.")
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("MEDIABINDER_URL must be an absolute http or https URL.")
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "MEDIABINDER_URL must be an http or https origin, without a path or credentials."
    )
  return url.origin
}

// Google requires an externally reachable HTTPS callback. Local development
// keeps manual/fresh-load syncing without attempting watch registration.
export function driveWebhookUrl(env: Environment = process.env) {
  const override = env.DRIVE_WEBHOOK_URL
  let url: URL
  try {
    url = new URL(override || `${appUrl(env)}/api/drive/webhook`)
  } catch (error) {
    if (!override) throw error
    throw new Error("DRIVE_WEBHOOK_URL must be a public HTTPS URL.")
  }
  const local = /^(localhost$|.*\.localhost$|127\.|\[::1\]$)/.test(url.hostname)
  if (!override && (url.protocol !== "https:" || local)) return null
  if (
    url.protocol !== "https:" ||
    local ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "DRIVE_WEBHOOK_URL must be a public HTTPS URL without credentials or query parameters."
    )
  return url.href
}

export function databaseOptions(env: Environment = process.env) {
  if (
    [env.DB_HOST, env.DB_NAME, env.DB_USER, env.DB_PASS, env.DB_PORT].some(
      (value) => value !== undefined
    )
  ) {
    for (const name of ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASS"])
      if (!env[name])
        throw new Error(`Set ${name} when using DB_* configuration.`)
    const port = Number(env.DB_PORT || 3306)
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("DB_PORT must be a port between 1 and 65535.")
    return {
      host: env.DB_HOST!,
      database: env.DB_NAME!,
      user: env.DB_USER!,
      password: env.DB_PASS!,
      port,
    }
  }
  if (!env.DATABASE_URL)
    throw new Error(
      "Set DB_HOST, DB_NAME, DB_USER and DB_PASS (or DATABASE_URL)."
    )
  return { uri: env.DATABASE_URL }
}

export function validateRuntimeConfig(env: Environment = process.env) {
  appUrl(env)
  driveWebhookUrl(env)
  databaseOptions(env)
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32)
    throw new Error(
      "Set BETTER_AUTH_SECRET to a random secret of at least 32 characters."
    )
  for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"])
    if (!env[name]) throw new Error(`Set ${name} for Google sign-in.`)
  if (
    env.DRIVE_WORKER_ENABLED &&
    !["true", "false"].includes(env.DRIVE_WORKER_ENABLED)
  )
    throw new Error("DRIVE_WORKER_ENABLED must be true or false.")
}
