import type { Options as ReactScanOptions } from "react-scan"

type ReactScanRenderHandler = NonNullable<ReactScanOptions["onRender"]>

export interface ComponentRenderSummary {
  /** React commits that included this component's renders. */
  commits: number
  /** Raw React Scan render events. */
  events: number
  mounts: number
  unmounts: number
  updates: number
  /** Renders React Scan flagged as having identical props and state. */
  unnecessary: number
  /** Milliseconds spent rendering. */
  time: number
}

export interface RenderAudit {
  /** Clears the counts and keeps the current window state. */
  reset: () => void
  /** Per component summaries, keyed by component name. */
  snapshot: () => Record<string, ComponentRenderSummary>
  /** Clears and starts recording. Recording is on until `stop`. */
  start: () => void
  /** Stops recording and returns the snapshot. */
  stop: () => Record<string, ComponentRenderSummary>
}

declare global {
  interface Window {
    __mediaBinderRenderAudit?: RenderAudit
  }
}

function emptySummary(): ComponentRenderSummary {
  return {
    commits: 0,
    events: 0,
    mounts: 0,
    unmounts: 0,
    updates: 0,
    unnecessary: 0,
    time: 0,
  }
}

// Development only. Records counts and timings by component name, never
// props, state, or media contents.
export function createRenderAudit(): {
  audit: RenderAudit
  onRender: ReactScanRenderHandler
} {
  let active = true
  const summaries = new Map<string, ComponentRenderSummary>()

  const snapshot = () =>
    Object.fromEntries(
      [...summaries].map(([name, summary]) => [name, { ...summary }])
    )

  const audit: RenderAudit = {
    reset: () => summaries.clear(),
    snapshot,
    start: () => {
      summaries.clear()
      active = true
    },
    stop: () => {
      active = false
      return snapshot()
    },
  }

  return {
    audit,
    onRender: (_fiber, renders) => {
      if (!active) return
      for (const render of renders) {
        const name = render.componentName ?? "(anonymous)"
        const summary = summaries.get(name) ?? emptySummary()
        summary.events += 1
        summary.commits += render.didCommit ? 1 : 0
        summary.time += render.time ?? 0
        summary.unnecessary += render.unnecessary ? render.count : 0
        // Scan phases: 1 mount, 2 update, 4 unmount.
        if (render.phase === 1) summary.mounts += render.count
        else if (render.phase === 2) summary.updates += render.count
        else if (render.phase === 4) summary.unmounts += render.count
        summaries.set(name, summary)
      }
    },
  }
}
