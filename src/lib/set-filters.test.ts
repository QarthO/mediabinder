import { describe, expect, it } from "vite-plus/test"
import { filterSets } from "./set-filters"
import type { MediaSet } from "./types"

const sets: MediaSet[] = [
  {
    id: "empty",
    display_name: "Empty",
    raw_name: "empty",
    tags: [],
    created_at: "2026-01-01",
    uploaded_at: null,
    media_count: 0,
    cover_id: null,
    post_count: 0,
  },
  {
    id: "shoot",
    display_name: "Summer shoot",
    raw_name: "original",
    tags: ["Outdoor"],
    created_at: "2026-02-01",
    uploaded_at: "2026-03-01",
    media_count: 2,
    cover_id: null,
    post_count: 0,
  },
  {
    id: "clips",
    display_name: "Clips",
    raw_name: "clips",
    tags: [],
    created_at: "2026-04-01",
    uploaded_at: null,
    media_count: 1,
    cover_id: null,
    post_count: 0,
  },
]
const options = {
  search: "",
  setFilter: "",
  filterByMedia: false,
  sorting: [{ id: "uploaded_at", desc: true }],
}
const ids = (result: MediaSet[]) => result.map((set) => set.id)

describe("filterSets", () => {
  it("includes empty sets and sorts newest first without mutating query data", () => {
    expect(ids(filterSets(sets, [], options))).toEqual([
      "clips",
      "shoot",
      "empty",
    ])
    expect(ids(sets)).toEqual(["empty", "shoot", "clips"])
  })

  it("searches names, original names and tags ignoring case and whitespace", () => {
    for (const search of [" summer ", "ORIGINAL", "outdoor"])
      expect(ids(filterSets(sets, [], { ...options, search }))).toEqual([
        "shoot",
      ])
  })

  it("restricts sets by matching members only when media filters are active", () => {
    const media = [{ set_ids: ["shoot"] }]
    // Only membership is read: the caller has already applied media/folder filters.
    expect(
      ids(filterSets(sets, media, { ...options, filterByMedia: true }))
    ).toEqual(["shoot"])
    expect(filterSets(sets, [], { ...options, filterByMedia: true })).toEqual(
      []
    )
  })

  it("composes the set picker with search and sorts by date or name", () => {
    expect(
      ids(filterSets(sets, [], { ...options, setFilter: "shoot" }))
    ).toEqual(["shoot"])
    expect(
      filterSets(sets, [], { ...options, setFilter: "shoot", search: "clips" })
    ).toEqual([])
    expect(
      ids(
        filterSets(sets, [], {
          ...options,
          sorting: [{ id: "uploaded_at", desc: false }],
        })
      )
    ).toEqual(["empty", "shoot", "clips"])
    expect(
      ids(
        filterSets(sets, [], {
          ...options,
          sorting: [{ id: "display_name", desc: false }],
        })
      )
    ).toEqual(["clips", "empty", "shoot"])
  })
})
