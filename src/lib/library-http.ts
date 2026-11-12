import { Effect, Option, Schema } from "effect"
import type { AuthenticationError } from "@/effect/errors"
import { appUrl } from "./config"
import { errorResponse, isHandledError } from "./http-errors"

type Dependencies = {
  session: (
    headers: Headers
  ) => Effect.Effect<{ user: { id: string } }, AuthenticationError>
  mutate: (
    action: string,
    data: unknown,
    userId: string,
    headers: Headers
  ) => Promise<unknown>
  // Exports unexpected failures; injected so this module stays server-free.
  report: (cause: unknown, context: { operation: string }) => void
}

export const libraryPost = Effect.fnUntraced(
  function* (request: Request, dependencies: Dependencies) {
    const origin = yield* Effect.try({
      try: () => appUrl(),
      catch: (error) => error,
    })
    if (request.headers.get("origin") !== origin)
      return new Response("Invalid origin.", { status: 403 })
    const session = yield* dependencies.session(request.headers)
    if (Number(request.headers.get("content-length")) > 65536)
      return new Response("Request too large.", { status: 413 })
    const payload = yield* Effect.tryPromise(() => request.json()).pipe(
      Effect.option
    )
    if (Option.isNone(payload))
      return new Response("Invalid JSON.", { status: 400 })
    const input = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        action: Schema.String,
        data: Schema.optional(Schema.Unknown),
      })
    )(payload.value).pipe(Effect.option)
    if (Option.isNone(input))
      return new Response("Invalid action payload.", { status: 400 })
    // Only the action name, never its data: the request span is shared by
    // every library action.
    yield* Effect.annotateCurrentSpan("mediabinder.action", input.value.action)
    yield* Effect.currentSpan.pipe(
      Effect.tap((span) => {
        const parent = Option.getOrUndefined(span.parent)
        return parent?._tag === "Span"
          ? Effect.sync(() =>
              parent.attribute("mediabinder.action", input.value.action)
            )
          : Effect.void
      }),
      Effect.ignore
    )
    const result = yield* Effect.tryPromise({
      try: () =>
        dependencies.mutate(
          input.value.action,
          input.value.data,
          session.user.id,
          request.headers
        ),
      catch: (error) => error,
    })
    return Response.json(result, { headers: { "Cache-Control": "no-store" } })
  },
  (self, _request, dependencies) => {
    const respond = (error: unknown) =>
      Effect.sync(() => {
        // Only the mapped response goes to the client; the cause is reported.
        if (!isHandledError(error))
          dependencies.report(error, { operation: "Library.post" })
        return errorResponse(
          error,
          "Could not save this change. Please try again."
        )
      })
    // Defects too: `mutate` still throws whatever its callees throw.
    return self.pipe(Effect.catch(respond), Effect.catchDefect(respond))
  }
)
