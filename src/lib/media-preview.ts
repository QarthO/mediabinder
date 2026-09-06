import { useEffect, useMemo, useState } from "react"
import {
  queryOptions,
  QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { Effect, Semaphore } from "effect"
import {
  isPreviewType,
  MAX_PREVIEW_BYTES,
  readMediaPreview,
} from "@/effect/media-preview"
import type { Media } from "./types"

export const MAX_CACHED_PREVIEWS = 6
const PREVIEW_KEY = "media-preview"
const semaphores = new WeakMap<QueryClient, Semaphore.Semaphore>()
const previewKey = (media: Media) =>
  [PREVIEW_KEY, media.id, media.drive_id, media.sha256, media.uploaded_at] as const

export function canPreview(media: Media) {
  return (
    media.available &&
    isPreviewType(media.mime_type) &&
    media.size > 0 &&
    media.size <= MAX_PREVIEW_BYTES
  )
}

export function previewQuery(client: QueryClient, media: Media) {
  let semaphore = semaphores.get(client)
  if (!semaphore) {
    semaphore = Effect.runSync(Semaphore.make(2))
    semaphores.set(client, semaphore)
  }
  return queryOptions({
    queryKey: previewKey(media),
    queryFn: ({ signal }) => {
      makePreviewRoom(client, media)
      return Effect.runPromise(
        readMediaPreview(`/api/media/${encodeURIComponent(media.id)}`).pipe(
          Semaphore.withPermits(semaphore, 1)
        ),
        { signal }
      )
    },
    staleTime: 60_000,
    gcTime: 60_000,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
}

// Query owns the Blob and pending request. Reusing its key on click avoids a
// second Google download even though original media responses are no-store.
export function prefetchMediaPreview(client: QueryClient, media: Media) {
  if (!canPreview(media)) return
  const options = previewQuery(client, media)
  const existing = client.getQueryCache().find({ queryKey: options.queryKey })
  // Keep failed speculation from turning repeated hover into repeated requests.
  if (existing?.state.status === "error") return
  if (!existing && !makePreviewRoom(client)) return
  void client.prefetchQuery(options)
}

function makePreviewRoom(client: QueryClient, current?: Media) {
  const previews = client.getQueryCache().findAll({ queryKey: [PREVIEW_KEY] })
  const count = previews.length - MAX_CACHED_PREVIEWS + (current ? 0 : 1)
  if (count <= 0) return true
  const protectedQuery = current
    ? client.getQueryCache().find({ queryKey: previewKey(current), exact: true })
    : undefined
  const unused = previews
    .filter((query) => query !== protectedQuery && query.getObserversCount() === 0)
    .sort((a, b) => a.state.dataUpdatedAt - b.state.dataUpdatedAt)
  if (unused.length < count) return false
  for (const query of unused.slice(0, count))
    client.removeQueries({ queryKey: query.queryKey, exact: true })
  return true
}

export function allowsPreviewPrefetch() {
  if (typeof navigator === "undefined") return false
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string }
  }).connection
  return (
    !connection?.saveData &&
    !["slow-2g", "2g", "3g"].includes(connection?.effectiveType ?? "")
  )
}

export function createMediaPreviewIntent(client: QueryClient, dwell = 180) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => {
    clearTimeout(timer)
    timer = undefined
  }
  const start = (media: Media) => {
    cancel()
    if (!canPreview(media) || !allowsPreviewPrefetch()) return
    timer = setTimeout(() => {
      timer = undefined
      prefetchMediaPreview(client, media)
    }, dwell)
  }
  return {
    cancel,
    handlers: (media: Media) => ({
      onPointerEnter: (event: { pointerType: string }) => {
        if (event.pointerType === "mouse") start(media)
      },
      onPointerLeave: cancel,
      onFocus: () => start(media),
      onBlur: cancel,
    }),
  }
}

export function useMediaPreviewIntent() {
  const client = useQueryClient()
  const intent = useMemo(() => createMediaPreviewIntent(client), [client])
  useEffect(() => intent.cancel, [intent])
  return intent.handlers
}

export function useMediaPreview(media: Media) {
  const client = useQueryClient()
  const options = previewQuery(client, media)
  const preview = useQuery(options)
  const [objectUrl, setObjectUrl] = useState<{ blob: Blob; url: string }>()
  useEffect(() => {
    if (!preview.data) return
    const url = URL.createObjectURL(preview.data)
    setObjectUrl({ blob: preview.data, url })
    return () => URL.revokeObjectURL(url)
  }, [preview.data])
  if (preview.isError) return `/api/media/${encodeURIComponent(media.id)}`
  return objectUrl?.blob === preview.data ? objectUrl?.url : undefined
}
