import { startTransition } from "react"
import { hydrateRoot } from "react-dom/client"
import { StartClient } from "@tanstack/react-start/client"

if (import.meta.env.DEV) {
  const { startRenderAudit } = await import("./lib/render-audit")
  startRenderAudit()
}

performance.mark("mediabinder-hydration-start")
startTransition(() => {
  hydrateRoot(document, <StartClient />)
})
