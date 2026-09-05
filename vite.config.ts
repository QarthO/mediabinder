import { defineConfig } from "vite"
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
})
