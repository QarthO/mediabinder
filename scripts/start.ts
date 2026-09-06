import { spawn, type ChildProcess } from "node:child_process"
import { validateRuntimeConfig } from "../src/lib/config"

try {
  validateRuntimeConfig()
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Invalid runtime configuration."
  )
  process.exit(1)
}

const children = new Set<ChildProcess>()
let stopping = false
let exitCode = 0
let deadline: ReturnType<typeof setTimeout> | undefined
function finish() {
  if (stopping && children.size === 0) {
    if (deadline) clearTimeout(deadline)
    process.exit(exitCode)
  }
}
function stop(code: number) {
  if (stopping) return
  stopping = true
  exitCode = code
  for (const child of children) child.kill("SIGTERM")
  deadline = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL")
  }, 25_000)
  finish()
}
process.on("SIGTERM", () => stop(0))
process.on("SIGINT", () => stop(0))

function launch(args: string[], service: string) {
  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    env: process.env,
  })
  children.add(child)
  child.on("error", () => {
    console.error(`Could not start ${service}.`)
    stop(1)
  })
  child.on("close", (code) => {
    children.delete(child)
    if (service !== "migrations" && !stopping) {
      console.error(
        `${service} exited unexpectedly (${code ?? "signal"}); stopping container.`
      )
      stop(1)
    }
    finish()
  })
  return child
}

// Migrations complete before either service starts. Their existing lock protects rolling deploys.
const migration = launch(
  ["--import", "tsx", "scripts/migrate.ts"],
  "migrations"
)
const migrated = await new Promise<boolean>((resolve) => {
  migration.once("error", () => resolve(false))
  migration.once("close", (code) => resolve(code === 0))
})
if (!migrated) stop(1)
if (!stopping) {
  launch(["scripts/serve.mjs"], "web server")
  if (process.env.DRIVE_WORKER_ENABLED !== "false")
    launch(["--import", "tsx", "scripts/drive-worker.ts"], "Drive worker")
}
