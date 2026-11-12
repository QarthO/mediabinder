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
  database() {
    // The MySQL suites skip themselves without a server, so a pass is only
    // meaningful when they ran.
    if (process.env.MEDIABINDER_TEST_MYSQL !== "1" || !process.env.DB_HOST) {
      console.error(
        "Database verification requires MEDIABINDER_TEST_MYSQL=1 and DB_* " +
          "pointing at a MySQL server whose DB_NAME ends in _test. Start one " +
          "with: docker run -d --rm -p 127.0.0.1:3306:3306 " +
          "-e MYSQL_ROOT_PASSWORD=root mysql:8.4, then set DB_HOST=127.0.0.1 " +
          "DB_NAME=mediabinder_test DB_USER=root DB_PASS=root."
      )
      // Refuse in CI and locally alike: a skipped run must never read as a pass.
      process.exit(1)
    }
    // Suites that need a server are named *.mysql.test.ts; `tests` skips them.
    vp("test", "run", "--reporter", "verbose", ".mysql.test.ts")
  },
  build() {
    vp("build")
    // A route added without committing the regenerated tree fails here.
    run("git", ["diff", "--exit-code", "--", "src/routeTree.gen.ts"])
  },
}

const usage = "Usage: pnpm verify [all|static|tests|database|build]"

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
