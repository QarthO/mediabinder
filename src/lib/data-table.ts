import {
  createSortedRowModel,
  createTableHook,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  tableFeatures,
  type SortingState,
} from "@tanstack/react-table"
import type { useMediaPreviewIntent } from "./media-preview"
import type { Media, MediaSet } from "./types"

export type MediaTableMeta = {
  previewIntent: ReturnType<typeof useMediaPreviewIntent>
  onOpen: (media: Media) => void
  allTags: string[]
  tagColors: Record<string, string>
  sets: MediaSet[]
  selectionMode: boolean
}

// Names, dates and sizes use the sort functions v8 picked automatically for
// them: alphanumeric for the name and the date string, basic for the size.
// They are named per column in data-table.tsx.
export const mediaTableFeatures = tableFeatures({
  rowSelectionFeature,
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic },
  tableMeta: {} as MediaTableMeta,
})

export const { createAppColumnHelper, useAppTable } = createTableHook({
  features: mediaTableFeatures,
})

// Passed to `useAppTable` so the component that owns the table does not
// render when table state changes. Rows, headers and the selection toolbar
// subscribe to the sorting and rowSelection atoms they read.
export function selectNoTableState() {
  return undefined
}

// A search matches the name, the original file name, or any tag.
export function filterMediaBySearch(items: Media[], search: string): Media[] {
  if (!search) return items
  const query = search.toLowerCase()
  return items.filter((media) =>
    [media.display_name, media.raw_name, ...media.tags].some((text) =>
      text.toLowerCase().includes(query)
    )
  )
}

export function sortingKey(sorting: SortingState): string {
  return sorting
    .map(({ desc, id }) => `${id}:${desc ? "desc" : "asc"}`)
    .join("|")
}
