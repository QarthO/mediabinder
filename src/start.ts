import { isNotFound, isRedirect } from "@tanstack/react-router"
import { createMiddleware, createStart } from "@tanstack/react-start"

import { tapPromiseError } from "./effect/promise"
import {
  reportAppError,
  runTracedAppEffect,
  traceAppPromise,
} from "./effect/runtime.server"
import { incomingTraceParent } from "./observability/incoming-trace.server"
import {
  isUntracedRequest,
  requestSpanName,
} from "./observability/request-span"

// One trace per request; effects run while handling it become its children.
// A signed-in browser's same-origin request that carries a `traceparent`
// continues the browser's trace instead (see incomingTraceParent).
// Server function failures are reported by errorMiddleware, because TanStack
// serializes them into the response before they reach this middleware.
// The span covers producing the response, not streaming its body, and the
// body is never read here, so Range requests and aborts reach the handler as
// they would without it.
const tracingMiddleware = createMiddleware().server(
  ({ request, pathname, serverFnMeta, next }) => {
    if (isUntracedRequest(new URL(request.url))) return next()
    const name = requestSpanName(request.method, pathname, serverFnMeta)
    const parentSpan = request.headers.has("traceparent")
      ? runTracedAppEffect(incomingTraceParent(request))
      : Promise.resolve(undefined)
    return parentSpan.then((parent) =>
      traceAppPromise(
        name,
        async (span) => {
          const result = await tapPromiseError(
            async () => next(),
            (cause) => {
              // The browser hung up, as when it leaves a page mid-stream:
              // Node ends the request with a connection reset.
              if (request.signal.aborted && isConnectionReset(cause)) return
              reportRequestError(cause, name)
            }
          )
          span.attribute("http.response.status_code", result.response.status)
          return result
        },
        { "http.request.method": request.method },
        parent
      )
    )
  }
)

const errorMiddleware = createMiddleware({ type: "function" }).server(
  ({ method, serverFnMeta, next }) =>
    tapPromiseError(next, (cause) =>
      reportRequestError(cause, requestSpanName(method, "", serverFnMeta))
    )
)

function reportRequestError(cause: unknown, operation: string): void {
  // Redirects, not-found results and thrown responses are control flow.
  if (isRedirect(cause) || isNotFound(cause) || cause instanceof Response)
    return
  reportAppError(cause, { operation })
}

function isConnectionReset(cause: unknown): boolean {
  return (
    cause instanceof Error && "code" in cause && cause.code === "ECONNRESET"
  )
}

// No CSRF middleware: every server function is a GET, and libraryPost checks
// the Origin of the one mutating endpoint itself.
export const startInstance = createStart(() => ({
  requestMiddleware: [tracingMiddleware],
  functionMiddleware: [errorMiddleware],
}))
