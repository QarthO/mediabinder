import type { QueryClient } from "@tanstack/react-query"
import { Effect, Semaphore } from "effect"
import { readMediaPreview } from "@/effect/media-preview"

const semaphores = new WeakMap<QueryClient, Semaphore.Semaphore>()

export function downloadMediaPreview(
  client: QueryClient,
  id: string,
  signal: AbortSignal
): Promise<Blob> {
  signal.throwIfAborted()
  let semaphore = semaphores.get(client)
  if (!semaphore) {
    semaphore = Effect.runSync(Semaphore.make(2))
    semaphores.set(client, semaphore)
  }
  return Effect.runPromise(
    readMediaPreview(`/api/media/${encodeURIComponent(id)}`).pipe(
      Semaphore.withPermits(semaphore, 1)
    ),
    { signal }
  )
}
