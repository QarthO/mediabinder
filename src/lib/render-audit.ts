import { scan } from "react-scan"

// Development only. Keep summaries, not props or media contents.
export function startRenderAudit() {
  const counts = new Map<string, { renders: number; ms: number }>()
  const audit = {
    reset: () => counts.clear(),
    snapshot: () => Object.fromEntries(counts),
  }
  Object.assign(window, { __mediaBinderRenderAudit: audit })
  scan({
    enabled: true,
    showToolbar: true,
    onRender: (_fiber, renders) => {
      for (const render of renders) {
        const name = render.componentName ?? "anonymous"
        const previous = counts.get(name) ?? { renders: 0, ms: 0 }
        counts.set(name, {
          renders: previous.renders + render.count,
          ms: previous.ms + (render.time ?? 0),
        })
      }
    },
  })
}
