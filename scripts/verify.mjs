import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const [stage = "all"] = process.argv.slice(2)

const stages = {
  static() {
    vp("run", "typecheck")
    vp("check")
  },
  tests() {
    vp("test", "run")
  },
  // TODO(database): a later layer adds a `database` stage here that runs the
  // MySQL-backed tests against a real server. Until then it must not exist, so
  // `pnpm verify all` never reports a skipped database run as a pass.
  build() {
    vp("build")
    // A route added without committing the regenerated tree fails here.
    run("git", ["diff", "--exit-code", "--", "src/routeTree.gen.ts"])
  },
}

const usage = "Usage: pnpm verify [all|static|tests|build]"

if (stage === "--help" || stage === "-h") {
  console.log(`${usage}

Runs the same stages as the Code checks workflow, stopping on failure.`)
} else if (
  process.argv.length > 3 ||
  (stage !== "all" && !Object.hasOwn(stages, stage))
) {
  console.error(usage)
  process.exitCode = 1
} else {
  for (const name of stage === "all" ? Object.keys(stages) : [stage]) {
    console.log(`\nVerifying: ${name}`)
    stages[name]()
  }
  console.log(`\nVerification passed: ${stage}`)
}

function vp(...args) {
  run(process.execPath, [
    fileURLToPath(import.meta.resolve("vite-plus/bin")),
    ...args,
  ])
}

function run(executable, args) {
  const result = spawnSync(executable, args, { cwd: root, stdio: "inherit" })
  if (result.error) console.error(result.error.message)
  if (result.signal) process.kill(process.pid, result.signal)
  if (result.status !== 0) process.exit(result.status ?? 1)
}
