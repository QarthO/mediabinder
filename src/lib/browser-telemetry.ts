// Browser traces and errors, sent as OTLP JSON to MediaBinder's own
// `/api/telemetry/v1/*` proxy, which authenticates them, drops unsampled
// traces and forwards the rest to the configured OTLP backend. The browser
// holds no backend credentials.
//
// This module is in the initial bundle, so it imports nothing heavy: the
// OpenTelemetry runtime (`browser-telemetry-runtime.ts`) is a separate chunk
// that loads, after hydration, only when the server rendered the sample-ratio
// `<meta>`, which it does only when an OTLP endpoint is configured. Without
// that meta nothing here does anything and no request is made. Until the chunk
// arrives, spans and errors are queued (briefly and boundedly) and replayed,
// so the hydration milestone and early errors are not lost.
//
// Effect-based helpers (`runBrowserEffect`, `currentBrowserTraceparent`) live
// in `browser-telemetry-effect.ts` so this module stays free of `effect`.
import type { Effect } from "effect"

import { browserTraceSampleRatioMeta } from "./browser-trace-sampling"
import { routeTemplate } from "./browser-privacy"

export interface BrowserSpan {
  readonly setAttribute: (key: string, value: unknown) => void
  /**
   * Ends the span once; later calls are ignored. `endedAt` is a
   * `performance.now()` time for work that finished before the call.
   */
  readonly end: (error?: unknown, endedAt?: number) => void
}

export interface StartBrowserSpanOptions {
  readonly attributes?: Record<string, unknown>
  readonly parent?: BrowserSpan | undefined
  // A `performance.now()` time the span began at, for work that started
  // before anything could start a span, such as a navigation.
  readonly startedAt?: number
}

/** What the lazily loaded OpenTelemetry chunk provides. */
export interface BrowserTelemetryRuntime {
  readonly runPromise: <A, E>(
    effect: Effect.Effect<A, E>,
    options?: { signal?: AbortSignal }
  ) => Promise<A>
  readonly startSpan: (
    name: string,
    options?: StartBrowserSpanOptions
  ) => BrowserSpan
  readonly report: (cause: unknown, context: { operation: string }) => void
}

interface PendingSpan {
  readonly name: string
  readonly attributes: Record<string, unknown>
  readonly parent: BrowserSpan | undefined
  readonly startedAt: number
  real?: BrowserSpan
  ended?: { error: unknown; at: number }
}

const maxQueued = 50
const noopSpan: BrowserSpan = { setAttribute: () => {}, end: () => {} }

let state: "off" | "waiting" | "running" = "off"
let runtime: BrowserTelemetryRuntime | undefined
const pendingSpans = new Map<BrowserSpan, PendingSpan>()
const pendingErrors: { cause: unknown; operation: string }[] = []
const reported = new WeakSet<object>()

/** The running telemetry, or undefined while it is off or still loading. */
export const browserTelemetryRuntime = () => runtime

/**
 * The server's trace sample ratio, which is also the signal that browser
 * telemetry is on. Undefined when the server rendered no meta.
 */
export function browserTraceSampleRatio(): number | undefined {
  if (typeof document === "undefined") return undefined
  const content = document
    .querySelector(`meta[name="${browserTraceSampleRatioMeta}"]`)
    ?.getAttribute("content")
  if (content === null || content === undefined || content === "")
    return undefined
  const ratio = Number(content)
  return Number.isFinite(ratio) ? ratio : undefined
}

/**
 * Starts reporting uncaught errors now and loads the exporter once the page
 * is idle after hydration. Does nothing unless the server turned telemetry on.
 */
export function startBrowserTelemetry(): void {
  if (state !== "off" || typeof window === "undefined") return
  if (browserTraceSampleRatio() === undefined) return
  state = "waiting"
  window.addEventListener("error", (event) => {
    reportBrowserError(event.error ?? event.message, {
      operation: "window.error",
    })
  })
  window.addEventListener("unhandledrejection", (event) => {
    reportBrowserError(event.reason, {
      operation: "window.unhandledrejection",
    })
  })
  // allSettled turns a chunk that cannot load (offline, a stale deploy) into
  // a result instead of a rejection.
  const load = async () => {
    const [result] = await Promise.allSettled([
      import("./browser-telemetry-runtime").then((module) =>
        module.createBrowserTelemetry()
      ),
    ])
    activate(result.status === "fulfilled" ? result.value : undefined)
  }
  if ("requestIdleCallback" in window)
    window.requestIdleCallback(() => void load(), { timeout: 4000 })
  else setTimeout(() => void load(), 1500)
}

function activate(created: BrowserTelemetryRuntime | undefined) {
  if (!created) {
    // The chunk could not load: give up and drop what was queued.
    state = "off"
    pendingSpans.clear()
    pendingErrors.length = 0
    return
  }
  runtime = created
  state = "running"
  for (const pending of pendingSpans.values()) {
    const real = created.startSpan(pending.name, {
      attributes: pending.attributes,
      parent: pending.parent && pendingSpans.get(pending.parent)?.real,
      startedAt: pending.startedAt,
    })
    pending.real = real
    if (pending.ended) real.end(pending.ended.error, pending.ended.at)
  }
  pendingSpans.clear()
  for (const { cause, operation } of pendingErrors.splice(0))
    created.report(cause, { operation })
}

/**
 * Reports an unexpected error: its type, fingerprint and stack frames, never
 * its message (see browser-privacy.ts). Each error object is reported once,
 * however many handlers see it. Expected outcomes such as a failed sign-in
 * are skipped by the runtime's policy.
 */
export function reportBrowserError(
  cause: unknown,
  context: { operation: string }
): void {
  if (state === "off") return
  if (typeof cause === "object" && cause !== null) {
    if (reported.has(cause)) return
    reported.add(cause)
  }
  if (runtime) runtime.report(cause, context)
  else if (pendingErrors.length < 10)
    pendingErrors.push({ cause, operation: context.operation })
}

/** Starts a span that the caller ends; children name it as their parent. */
export function startBrowserSpan(
  name: string,
  options?: StartBrowserSpanOptions
): BrowserSpan {
  if (runtime) return runtime.startSpan(name, options)
  if (state !== "waiting" || pendingSpans.size >= maxQueued) return noopSpan
  const pending: PendingSpan = {
    name,
    attributes: { ...options?.attributes },
    parent: options?.parent,
    startedAt: options?.startedAt ?? performance.now(),
  }
  const handle: BrowserSpan = {
    setAttribute: (key, value) => {
      if (pending.real) pending.real.setAttribute(key, value)
      else pending.attributes[key] = value
    },
    end: (error, endedAt) => {
      if (pending.real) pending.real.end(error, endedAt)
      else pending.ended ??= { error, at: endedAt ?? performance.now() }
    },
  }
  pendingSpans.set(handle, pending)
  return handle
}

let libraryOpen: BrowserSpan | undefined

/**
 * The "Library open" milestone runs from navigation start to the first
 * library render. Started once, before hydration.
 */
export function beginLibraryOpen(): void {
  libraryOpen ??= startBrowserSpan("Library open", {
    startedAt: 0,
    attributes: { "url.path": routeTemplate(window.location.pathname) },
  })
}

/** Ends "Library open" on the first library render; later calls do nothing. */
export function endLibraryOpen(): void {
  libraryOpen?.end()
  libraryOpen = undefined
}
