import { Clock, Effect, Exit, Metric, Cause } from "effect"
import type { z } from "zod"
import type { AppServices } from "./runtime.server"
import { isExpectedAppError } from "@/observability/error-policy"

/** Who a library action runs for. Every action gets one, from the session. */
export interface MutationContext {
  readonly userId: string
  readonly headers: Headers
}

/** What the library action table holds: raw request data in, a result out. */
export type MutationHandler = (
  data: unknown,
  context: MutationContext
) => Effect.Effect<unknown, unknown, AppServices>

// Hot enough for a metric and unit-of-work enough for a span. The attributes
// are the action name from the table and its outcome, never request data.
const mutationDuration = Metric.histogram("mediabinder.mutation.duration", {
  description:
    "Time a library action ran, by action and outcome: succeeded, rejected (an answered refusal such as bad input or a missing item), failed or interrupted",
  attributes: { unit: "s" },
  boundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
})

const outcome = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return "succeeded"
  if (Cause.hasInterruptsOnly(exit.cause)) return "interrupted"
  return isExpectedAppError(Cause.squash(exit.cause)) ? "rejected" : "failed"
}

/** Parses request data; a failure is a `ZodError`, answered as a 400. */
export const parseInput = <Output>(schema: z.ZodType<Output>, data: unknown) =>
  Effect.suspend(() => {
    const parsed = schema.safeParse(data)
    return parsed.success
      ? Effect.succeed(parsed.data)
      : Effect.fail(parsed.error)
  })

/** `create-set` becomes `createSet`. */
export const camelCase = (action: string) =>
  action.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())

/**
 * One library action: a `Library.<action>` span and the duration metric
 * around parsing `data` with `input` and running `run`. Actions without an
 * `input` schema take no data. A schema failure is a `ZodError`, answered as
 * a 400 like any other bad input.
 */
export const mutation = <Input, Result, Failure, Services extends AppServices>(
  action: string,
  options: {
    readonly input?: z.ZodType<Input>
    readonly run: (
      input: Input,
      context: MutationContext
    ) => Effect.Effect<Result, Failure, Services>
  }
): MutationHandler =>
  Effect.fn(`Library.${camelCase(action)}`)(function* (
    data: unknown,
    context: MutationContext
  ) {
    yield* Effect.annotateCurrentSpan({
      "mediabinder.action": action,
      "mediabinder.user_id": context.userId,
    })
    const startedAt = yield* Clock.currentTimeMillis
    return yield* Effect.gen(function* () {
      const input = options.input
        ? yield* parseInput(options.input, data)
        : (data as Input)
      return yield* options.run(input, context)
    }).pipe(
      Effect.onExit((exit) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((finishedAt) =>
            Metric.update(
              Metric.withAttributes(mutationDuration, {
                action,
                outcome: outcome(exit),
              }),
              (finishedAt - startedAt) / 1000
            )
          )
        )
      )
    )
  })
