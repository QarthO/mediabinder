import { scan } from "react-scan"

import { startTransition } from "react"
import { hydrateRoot } from "react-dom/client"
import { StartClient } from "@tanstack/react-start/client"

import { createRenderAudit } from "./lib/render-audit"

// Profiling only: `VITE_REACT_SCAN=true pnpm dev`. Otherwise `react-scan`
// is aliased to a no-op shim in vite.config.ts and never instruments React.
// The flag is a build-time false in production, so this block and the
// import are removed from the bundle.
if (import.meta.env.DEV && import.meta.env.VITE_REACT_SCAN) {
  const { audit, onRender } = createRenderAudit()
  window.__mediaBinderRenderAudit = audit
  scan({ enabled: true, showToolbar: true, onRender })
}

performance.mark("mediabinder-hydration-start")
startTransition(() => {
  hydrateRoot(document, <StartClient />)
})
