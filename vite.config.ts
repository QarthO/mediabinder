import { defineConfig } from "vite-plus"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import react from "@vitejs/plugin-react"
import tailwind from "@tailwindcss/vite"

export default defineConfig({
  plugins: [
    tailwind(),
    tanstackStart({ router: { tmpDir: "./src/.tanstack/tmp" } }),
    react(),
  ],
  resolve: { tsconfigPaths: true },
  server: {
    allowedHosts: ["mediabinder.localhost", ".orb.local"],
    host: "0.0.0.0",
    port: 3100,
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
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
})
