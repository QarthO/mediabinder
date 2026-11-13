// Development stacks: one Docker Compose project per worktree, all reading one
// shared env file (the primary checkout's .env). See docs/development.md.
//
//   pnpm dev:setup               create / complete the shared env file
//   pnpm dev:docker              build and start this worktree's stack
//   pnpm dev:docker:down         stop it, keeping its database volume
//   pnpm dev:docker:destroy --yes  remove it and its volume
//   pnpm dev:docker:url          print its URL
//   pnpm dev:docker:logs         follow its logs
//
// Every project this script touches is named `mediabinder-dev-<worktree>`. It
// never runs against `mediabinder`, `mediabinder-sharing` or anything else.
import { createHash, randomBytes } from "node:crypto"
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:net"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const PREFIX = "mediabinder-dev-"
const FIRST_PORT = 3101
const PORT_COUNT = 99 // 3101-3199
const WEB_PORT = "3100"
const HEALTH_TIMEOUT_SECONDS = "420"

const command = process.argv[2] ?? "start"
const flags = process.argv.slice(3)

const worktreeRoot = capture("git", ["rev-parse", "--show-toplevel"])
const commonGitDirectory = resolve(
  worktreeRoot,
  capture("git", ["rev-parse", "--git-common-dir"])
)
const primaryRoot = dirname(commonGitDirectory)
// MEDIABINDER_DEV_ENV_FILE points the stack at another env file; tests of
// this script use it so they never touch the real one.
const environmentFile = process.env.MEDIABINDER_DEV_ENV_FILE?.trim()
  ? resolve(process.env.MEDIABINDER_DEV_ENV_FILE.trim())
  : join(primaryRoot, ".env")

// What dev:setup keeps in the shared env file. `value` is written only when
// the key is absent (active or commented out); existing values are never
// changed. Entries without a value are commented placeholders.
const ENTRIES = [
  {
    key: "MEDIABINDER_ENVIRONMENT",
    value: "dev",
    comment: "Turns on Skip login for development. Ignored by production.",
  },
  {
    key: "BETTER_AUTH_SECRET",
    value: () => randomBytes(32).toString("hex"),
    comment: "Generated.",
  },
  {
    key: "MYSQL_PASSWORD",
    value: () => randomBytes(24).toString("hex"),
    comment: "Generated.",
  },
  {
    key: "MYSQL_ROOT_PASSWORD",
    value: () => randomBytes(24).toString("hex"),
    comment: "Generated.",
  },
  {
    key: "GOOGLE_CLIENT_ID",
    comment: "Google OAuth client, for signing in with a real Google account.",
  },
  { key: "GOOGLE_CLIENT_SECRET" },
  {
    key: "GOOGLE_SERVICE_ACCOUNT_KEY_HOST_FILE",
    placeholder: "/absolute/path/to/service-account.json",
    comment:
      "Service account key, as a path on THIS machine. The stack mounts it read-only into the containers.",
  },
  {
    key: "GOOGLE_PICKER_API_KEY",
    comment: "Browser key restricted to the Google Picker API.",
  },
  { key: "GOOGLE_CLOUD_PROJECT_NUMBER" },
  {
    key: "MEDIABINDER_DEV_FOLDER_ID",
    placeholder: "drive-folder-id",
    comment:
      "A Drive folder shared with the service account. Linked for the developer, with one initial sync.",
  },
]
const REQUIRED = ["BETTER_AUTH_SECRET", "MYSQL_PASSWORD", "MYSQL_ROOT_PASSWORD"]

switch (command) {
  case "setup":
    setup()
    break
  case "start":
  case "up":
    await start()
    break
  case "down":
    down()
    break
  case "destroy":
    destroy()
    break
  case "url":
    url()
    break
  case "logs":
    logs()
    break
  default:
    fail(
      `Unknown command ${command}. Use setup, start, down, destroy, url or logs.`
    )
}

function setup() {
  const created = !existsSync(environmentFile)
  let contents = created
    ? "# MediaBinder development stacks. Shared by every worktree's `pnpm dev:docker`.\n# See .env.dev.example. Never commit this file.\n"
    : readFileSync(environmentFile, "utf8")
  const present = new Set(
    [...contents.matchAll(/^\s*#?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/gmu)].map(
      (match) => match[1]
    )
  )
  const added = []
  for (const entry of ENTRIES) {
    if (present.has(entry.key)) continue
    const value =
      typeof entry.value === "function" ? entry.value() : entry.value
    const lines = []
    if (entry.comment) lines.push(`# ${entry.comment}`)
    lines.push(
      value === undefined
        ? `# ${entry.key}=${entry.placeholder ?? ""}`
        : `${entry.key}=${value}`
    )
    contents = `${contents.replace(/\s*$/u, "")}\n\n${lines.join("\n")}\n`
    added.push(entry.key)
  }
  if (created || added.length > 0)
    writeFileSync(environmentFile, contents, { mode: 0o600 })
  chmodSync(environmentFile, 0o600)
  console.log(
    `${created ? "Created" : "Checked"} ${environmentFile}${added.length ? `; added ${added.join(", ")}` : "; nothing to add"}.`
  )
  const values = parseEnvironment(contents)
  const todo = ENTRIES.filter(
    (entry) => entry.value === undefined && !values.get(entry.key)
  ).map((entry) => entry.key)
  if (todo.length)
    console.log(`Fill in when you need them: ${todo.join(", ")}.`)
}

async function start() {
  const values = requireEnvironment()
  const stack = projectName()
  requireOwnership(stack)
  const port = currentPort(stack) ?? (await freePort())
  const environment = composeEnvironment(values, port)
  writeFileSync(projectFile(), `${stack}\n`)
  console.log(`Stack: ${stack}`)
  const workerWasRunning = Boolean(
    capture("docker", composeArguments(stack, values, ["ps", "-q", "worker"]), {
      env: environment,
    })
  )
  const up = run(
    "docker",
    composeArguments(stack, values, [
      "up",
      "--detach",
      "--build",
      "--wait",
      "--wait-timeout",
      HEALTH_TIMEOUT_SECONDS,
    ]),
    environment
  )
  if (!up) {
    run(
      "docker",
      composeArguments(stack, values, ["logs", "--tail", "60", "web"]),
      environment
    )
    fail(`${stack} did not become ready.`)
  }
  // The worker has no hot reload; pick up changed server modules.
  if (workerWasRunning)
    run(
      "docker",
      composeArguments(stack, values, ["restart", "worker"]),
      environment
    )
  console.log(`\nReady: http://localhost:${port}`)
}

function down() {
  const values = requireEnvironment()
  const stack = projectName()
  requireOwnership(stack)
  const port = currentPort(stack) ?? FIRST_PORT
  if (
    !run(
      "docker",
      composeArguments(stack, values, ["down", "--remove-orphans"]),
      composeEnvironment(values, port)
    )
  )
    fail(`Could not stop ${stack}.`)
}

function destroy() {
  const values = requireEnvironment()
  const stack = projectName()
  requireOwnership(stack)
  if (!flags.includes("--yes")) {
    fail(
      `This removes ${stack}'s containers and its MySQL volume (${stack}_mysql-data). Run pnpm dev:docker:destroy --yes to confirm.`
    )
  }
  const port = currentPort(stack) ?? FIRST_PORT
  if (
    !run(
      "docker",
      composeArguments(stack, values, [
        "down",
        "--volumes",
        "--remove-orphans",
      ]),
      composeEnvironment(values, port)
    )
  )
    fail(`Could not remove ${stack}.`)
  rmSync(projectFile(), { force: true })
  console.log(`Removed ${stack}.`)
}

function url() {
  const stack = projectName()
  const port = currentPort(stack)
  if (!port) fail(`${stack} is not running. Start it with pnpm dev:docker.`)
  console.log(`http://localhost:${port}`)
}

function logs() {
  const values = requireEnvironment()
  const stack = projectName()
  requireOwnership(stack)
  const port = currentPort(stack) ?? FIRST_PORT
  run(
    "docker",
    composeArguments(stack, values, [
      "logs",
      "--follow",
      "--tail",
      "100",
      "web",
      "worker",
    ]),
    composeEnvironment(values, port)
  )
}

function composeFiles(values) {
  const files = ["compose.yaml", "compose.dev.yaml"]
  if (values.get("GOOGLE_SERVICE_ACCOUNT_KEY_HOST_FILE"))
    files.push("compose.dev-key.yaml")
  return files
}

function composeArguments(stack, values, extra) {
  return [
    "compose",
    "--env-file",
    environmentFile,
    "--project-name",
    stack,
    ...composeFiles(values).flatMap((file) => ["--file", file]),
    ...extra,
  ]
}

function composeEnvironment(values, port) {
  const keyFile = values.get("GOOGLE_SERVICE_ACCOUNT_KEY_HOST_FILE")
  return {
    ...process.env,
    MEDIABINDER_DEV_ENV_FILE: environmentFile,
    MEDIABINDER_DEV_PORT: String(port),
    ...(keyFile ? { GOOGLE_SERVICE_ACCOUNT_KEY_HOST_FILE: keyFile } : {}),
  }
}

function requireEnvironment() {
  if (!existsSync(environmentFile))
    fail(`Missing ${environmentFile}. Run pnpm dev:setup once.`)
  const values = parseEnvironment(readFileSync(environmentFile, "utf8"))
  const missing = REQUIRED.filter((key) => !values.get(key))
  if (missing.length)
    fail(
      `Missing ${missing.join(", ")} in ${environmentFile}. Run pnpm dev:setup.`
    )
  const keyFile = values.get("GOOGLE_SERVICE_ACCOUNT_KEY_HOST_FILE")
  if (keyFile && (!isAbsolute(keyFile) || !existsSync(keyFile)))
    fail(
      "GOOGLE_SERVICE_ACCOUNT_KEY_HOST_FILE must be the absolute path of an existing file on this machine."
    )
  return values
}

function parseEnvironment(contents) {
  const values = new Map()
  for (const line of contents.split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/u)
    if (!match) continue
    let value = match[2].trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    )
      value = value.slice(1, -1)
    values.set(match[1], value)
  }
  return values
}

// The ownership file lives in the worktree's own git directory, so it
// survives a branch switch and cleanup still finds the stack the first
// branch started.
function projectFile() {
  return resolve(
    worktreeRoot,
    capture("git", ["rev-parse", "--git-path", "mediabinder-dev-project"])
  )
}

function projectName() {
  const override = process.env.MEDIABINDER_DEV_PROJECT?.trim()
  const saved = existsSync(projectFile())
    ? readFileSync(projectFile(), "utf8").trim()
    : ""
  const branch =
    capture("git", ["branch", "--show-current"]) ||
    `detached-${capture("git", ["rev-parse", "--short", "HEAD"])}`
  const slug =
    branch
      .replace(/^[^/]+\//u, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 40)
      .replace(/-+$/u, "") || "worktree"
  const name = override || saved || `${PREFIX}${slug}`
  if (!/^mediabinder-dev-[a-z0-9][a-z0-9-]{0,45}$/u.test(name))
    fail(
      `The project name must look like ${PREFIX}<name> (lowercase letters, digits, hyphens). Got ${name}.`
    )
  if (override && saved && override !== saved)
    fail(
      `This worktree already uses ${saved}. Run pnpm dev:docker:destroy --yes and remove ${projectFile()} before choosing another project.`
    )
  return name
}

// Refuses to touch a project whose containers were made from another
// checkout (two worktrees whose branches slug to the same name).
function requireOwnership(stack) {
  const owners = capture("docker", [
    "container",
    "ls",
    "--all",
    "--filter",
    `label=com.docker.compose.project=${stack}`,
    "--format",
    '{{.Label "com.docker.compose.project.working_dir"}}',
  ])
    .split("\n")
    .filter(Boolean)
  if (owners.some((owner) => resolve(owner) !== resolve(worktreeRoot)))
    fail(
      `Docker project ${stack} belongs to another checkout. Set MEDIABINDER_DEV_PROJECT=${PREFIX}<unique-name> to give this worktree its own.`
    )
}

// The host port the stack's web container already publishes, so a restart
// keeps its URL.
function currentPort(stack) {
  const published = capture("docker", [
    "container",
    "ls",
    "--filter",
    `label=com.docker.compose.project=${stack}`,
    "--filter",
    "label=com.docker.compose.service=web",
    "--format",
    "{{.Ports}}",
  ])
  const match = published.match(new RegExp(`:(\\d+)->${WEB_PORT}/tcp`, "u"))
  return match ? Number(match[1]) : null
}

// A per-worktree default in 3101-3199, then the next free one after it.
async function freePort() {
  const requested = process.env.MEDIABINDER_DEV_PORT?.trim()
  if (requested) {
    if (!(await portIsFree(Number(requested))))
      fail(`Port ${requested} is busy.`)
    return Number(requested)
  }
  const offset =
    Number.parseInt(
      createHash("sha256")
        .update(resolve(worktreeRoot))
        .digest("hex")
        .slice(0, 8),
      16
    ) % PORT_COUNT
  for (let step = 0; step < PORT_COUNT; step += 1) {
    const port = FIRST_PORT + ((offset + step) % PORT_COUNT)
    if (await portIsFree(port)) return port
  }
  fail(`No free port between ${FIRST_PORT} and ${FIRST_PORT + PORT_COUNT - 1}.`)
}

function portIsFree(port) {
  return Promise.all(
    ["127.0.0.1", "0.0.0.0"].map(
      (host) =>
        new Promise((done) => {
          const server = createServer()
          server.once("error", () => done(false))
          server.listen(port, host, () => server.close(() => done(true)))
        })
    )
  ).then((results) => results.every(Boolean))
}

function capture(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    env: options.env ?? process.env,
  })
  if (result.error || result.status !== 0) {
    if (options.optional) return ""
    // `docker compose ps` of a project that doesn't exist yet is not an error
    // worth stopping for.
    if (executable === "docker" && args[0] === "compose") return ""
    fail(
      `${executable} ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || result.error?.message || "").trim()}`
    )
  }
  return result.stdout.trim()
}

function run(executable, args, environment) {
  const result = spawnSync(executable, args, {
    cwd: worktreeRoot,
    env: environment,
    stdio: "inherit",
  })
  return result.status === 0
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
