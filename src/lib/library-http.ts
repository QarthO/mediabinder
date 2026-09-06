import { Effect, Schema } from "effect"
import { ZodError } from "zod"
import { appUrl } from "./config"

type Dependencies = {
  session: (headers: Headers) => Promise<{ user: { id: string } }>
  mutate: (
    action: string,
    data: unknown,
    userId: string,
    headers: Headers
  ) => Promise<unknown>
}

export const libraryPost = Effect.fn("library.post")(
  function* (request: Request, dependencies: Dependencies) {
    const origin = yield* Effect.try({
      try: () => appUrl(),
      catch: (error) => error,
    })
    if (request.headers.get("origin") !== origin)
      return new Response("Invalid origin.", { status: 403 })
    const session = yield* Effect.tryPromise({
      try: () => dependencies.session(request.headers),
      catch: (error) => error,
    })
    if (Number(request.headers.get("content-length")) > 65536)
      return new Response("Request too large.", { status: 413 })
    const payload = yield* Effect.tryPromise({
      try: () => request.json(),
      catch: () => new Response("Invalid JSON.", { status: 400 }),
    })
    const input = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        action: Schema.String,
        data: Schema.optional(Schema.Unknown),
      })
    )(payload).pipe(
      Effect.mapError(
        () => new Response("Invalid action payload.", { status: 400 })
      )
    )
    const result = yield* Effect.tryPromise({
      try: () =>
        dependencies.mutate(
          input.action,
          input.data,
          session.user.id,
          request.headers
        ),
      catch: (error) => error,
    })
    return Response.json(result, { headers: { "Cache-Control": "no-store" } })
  },
  Effect.catch((error) => {
    if (error instanceof Response) return Effect.succeed(error)
    if (error instanceof ZodError)
      return Effect.succeed(
        Response.json(
          { error: error.issues[0]?.message ?? "Check the entered values." },
          { status: 400 }
        )
      )
    const message =
      error instanceof Error &&
      /^(Google |Reconnect |Choose |A sync |The source |This file|Drive watch|Network request)/.test(
        error.message
      )
        ? error.message
        : "Could not save this change. Please try again."
    return Effect.logError("Library action failed", { message }).pipe(
      Effect.as(Response.json({ error: message }, { status: 400 }))
    )
  })
)
