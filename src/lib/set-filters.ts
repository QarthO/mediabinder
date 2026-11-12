import type { SortingState } from "@tanstack/react-table"
import type { Media, MediaSet } from "./types"

export function filterSets(
  sets: MediaSet[],
  media: Pick<Media, "set_ids">[],
  options: {
    search: string
    setFilter: string
    filterByMedia: boolean
    sorting: SortingState
  }
) {
  const matchingIds = new Set(media.flatMap((item) => item.set_ids))
  const search = options.search.trim().toLowerCase()
  const filtered = sets.filter(
    (set) =>
      (!options.setFilter || set.id === options.setFilter) &&
      (!options.filterByMedia || matchingIds.has(set.id)) &&
      (!search ||
        [set.display_name, set.raw_name, ...set.tags].some((value) =>
          value.toLowerCase().includes(search)
        ))
  )
  return filtered.sort((a, b) => {
    for (const { id, desc } of options.sorting) {
      const left =
        id === "uploaded_at"
          ? (a.uploaded_at ?? a.created_at)
          : a[id as keyof MediaSet]
      const right =
        id === "uploaded_at"
          ? (b.uploaded_at ?? b.created_at)
          : b[id as keyof MediaSet]
      const result =
        typeof left === "number" && typeof right === "number"
          ? left - right
          : String(left ?? "").localeCompare(String(right ?? ""), undefined, {
              numeric: true,
            })
      if (result) return desc ? -result : result
    }
    return 0
  })
}
