import { readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"

import { Result } from "effect"
import { defineConfig, loadEnv } from "vite-plus"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import react from "@vitejs/plugin-react"
import tailwind from "@tailwindcss/vite"

const reactScanShim = resolve(
  import.meta.dirname,
  "node_modules/react-scan/dist/rsc-shim.mjs"
)

export default defineConfig(({ command, mode }) => {
  const sourceCommit = resolveBuildCommit()
  // Release builds report the same commit twice. Dev serve has no build.
  const buildCommit = command === "serve" ? "" : sourceCommit
  const reactScanEnabled =
    command === "serve" &&
    (process.env.VITE_REACT_SCAN ??
      loadEnv(mode, import.meta.dirname, "VITE_REACT_SCAN").VITE_REACT_SCAN) ===
      "true"

  return {
    define: {
      "import.meta.env.VITE_REACT_SCAN": JSON.stringify(reactScanEnabled),
      "import.meta.env.VITE_MEDIABINDER_BUILD_SHA": JSON.stringify(buildCommit),
      "import.meta.env.VITE_MEDIABINDER_SOURCE_SHA":
        JSON.stringify(sourceCommit),
    },
    plugins: [
      // Dev-only; the plugin does nothing in production builds.
      devtools(),
      tailwind(),
      tanstackStart({ router: { tmpDir: "./src/.tanstack/tmp" } }),
      react(),
    ],
    resolve: {
      // The toolbar still loads and instruments React with enabled: false.
      // Keep it off the startup path unless explicitly profiling in dev.
      alias: reactScanEnabled
        ? []
        : [{ find: /^react-scan$/, replacement: reactScanShim }],
      tsconfigPaths: true,
    },
    server: {
      // Browser errors remain available in devtools. Forwarding them back
      // through Vite can recursively re-forward its own output.
      forwardConsole: false,
      allowedHosts: ["mediabinder.localhost", ".orb.local"],
      host: "0.0.0.0",
      port: 3100,
    },
    test: {
      include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
      globalSetup: ["src/test/global-setup.ts"],
      setupFiles: ["src/test/setup.ts"],
      // Worker threads start faster than forked processes.
      pool: "threads",
      // These only catch hangs. Tests share the machine with every other
      // stack and test run, so the same test can take many times as long
      // while they're busy.
      testTimeout: 60_000,
      hookTimeout: 300_000,
    },
    lint: {
      jsPlugins: [
        { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
        "./scripts/oxlint-plugin.mjs",
      ],
      ignorePatterns: [
        "dist/",
        "node_modules/",
        "artifacts/",
        "src/routeTree.gen.ts",
      ],
      rules: {
        "vite-plus/prefer-vite-plus-imports": "error",
        "typescript/no-base-to-string": "off",
        "typescript/no-meaningless-void-operator": "off",
        "typescript/no-misused-spread": "off",
        "typescript/restrict-template-expressions": "off",
        "typescript/unbound-method": "off",
        "unicorn/no-new-array": "off",
        "unicorn/prefer-string-starts-ends-with": "off",
      },
      overrides: [
        {
          // Server and Effect code recovers errors through Effect/Result so
          // failures keep their types and interruption. Warn-only for now.
          files: ["src/**/*.server.ts", "src/effect/**", "src/lib/**"],
          rules: { "mediabinder/effect-recovery": "warn" },
        },
        {
          files: ["**/*.test.{ts,tsx}", "scripts/**"],
          rules: { "mediabinder/effect-recovery": "off" },
        },
      ],
      options: { typeAware: true },
    },
    fmt: {
      endOfLine: "lf",
      semi: false,
      singleQuote: false,
      tabWidth: 2,
      trailingComma: "es5",
      printWidth: 80,
      sortPackageJson: false,
      ignorePatterns: [
        "dist/",
        "node_modules/",
        "artifacts/",
        "src/routeTree.gen.ts",
        "pnpm-lock.yaml",
      ],
    },
  }
})

// The commit being built: a CI or Coolify variable first, then the checkout.
function resolveBuildCommit(): string {
  const configured = [
    process.env.SOURCE_COMMIT,
    process.env.GITHUB_SHA,
    process.env.COMMIT_SHA,
  ]
    .find((value) => value?.trim())
    ?.trim()
  if (configured) return configured

  return Result.getOrElse(
    Result.try(() => {
      const { gitDir, commonDir } = resolveGitDirectories(import.meta.dirname)
      const head = readFileSync(resolve(gitDir, "HEAD"), "utf8").trim()
      if (!head.startsWith("ref: ")) return head

      const reference = head.slice(5)
      return Result.getOrElse(
        Result.try(() =>
          readFileSync(resolve(commonDir, reference), "utf8").trim()
        ),
        () =>
          readFileSync(resolve(commonDir, "packed-refs"), "utf8")
            .split("\n")
            .find((line) => line.endsWith(` ${reference}`))
            ?.split(" ")[0] ?? ""
      )
    }),
    () => ""
  )
}

// `.git` is a file ("gitdir: <path>") in a worktree. HEAD lives in that
// directory, but branch refs live in the common one named by `commondir`.
function resolveGitDirectories(root: string): {
  gitDir: string
  commonDir: string
} {
  const dotGit = resolve(root, ".git")
  const gitDir = statSync(dotGit).isDirectory()
    ? dotGit
    : resolve(
        root,
        readFileSync(dotGit, "utf8")
          .trim()
          .replace(/^gitdir: /, "")
      )
  const commonDir = Result.getOrElse(
    Result.try(() =>
      resolve(gitDir, readFileSync(resolve(gitDir, "commondir"), "utf8").trim())
    ),
    () => gitDir
  )
  return { gitDir, commonDir }
}
