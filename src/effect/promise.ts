import { Effect } from "effect"

/**
 * Runs promise code and lets `onError` observe a rejection before it is
 * rethrown unchanged. An error thrown by `onError` replaces nothing: it is
 * ignored.
 */
export function tapPromiseError<TResult>(
  run: () => PromiseLike<TResult>,
  onError: (cause: unknown) => void
): Promise<TResult> {
  return Effect.runPromise(
    Effect.tryPromise({ try: run, catch: (cause) => cause }).pipe(
      Effect.tapError((cause) =>
        Effect.try({ try: () => onError(cause), catch: (error) => error }).pipe(
          Effect.ignore
        )
      )
    )
  )
}
