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
