import { Effect, Option, Tracer } from "effect"
import { Headers, HttpTraceContext } from "effect/http"
import { auth } from "@/lib/auth.server"
import { keepBrowserTrace } from "@/lib/browser-trace-sampling"
import { appUrl } from "@/lib/config"
import { sampleRatio } from "@/telemetry"

/**
 * True when a browser made the request from this app's own pages. `Origin`
 * is sent with POSTs; same-origin GETs omit it but carry `Sec-Fetch-Site`,
 * which a page's script cannot set.
 */
export function isSameOriginRequest(request: Request, origin: string) {
  const sent = request.headers.get("origin")
  return sent === null
    ? request.headers.get("sec-fetch-site") === "same-origin"
    : sent === origin
}

/**
 * The browser span to continue, from a `traceparent` header. Only a request
 * from this app's own pages with a valid session may name the parent of a
 * server span; anyone else's header is ignored, so a stranger cannot put
 * spans into a trace of their choosing. The sampled flag the browser sent is
 * ignored too: the decision is `keepBrowserTrace`, the same one the proxy
 * applies to the browser's half, so the two halves are kept or dropped
 * together. A failed session lookup counts as no session and never fails the
 * request.
 */
export const incomingTraceParent = Effect.fnUntraced(function* (
  request: Request
) {
  const traceparent = request.headers.get("traceparent")
  if (traceparent === null) return undefined
  if (!isSameOriginRequest(request, appUrl())) return undefined
  const parent = HttpTraceContext.fromHeaders(
    Headers.fromInput({ traceparent })
  )
  if (Option.isNone(parent)) return undefined
  const session = yield* Effect.tryPromise(() =>
    auth.api.getSession({ headers: request.headers })
  ).pipe(Effect.option)
  if (Option.isNone(session) || !session.value) return undefined
  const ratio = yield* sampleRatio
  return Tracer.externalSpan({
    traceId: parent.value.traceId,
    spanId: parent.value.spanId,
    sampled: keepBrowserTrace(parent.value.traceId, ratio),
  })
})
