import assert from "node:assert/strict"
import { test } from "node:test"
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

test("unfiltered sets include empty sets and sort newest first without mutating query data", () => {
  assert.deepEqual(ids(filterSets(sets, [], options)), [
    "clips",
    "shoot",
    "empty",
  ])
  assert.deepEqual(ids(sets), ["empty", "shoot", "clips"])
})
test("set search finds names, original names and tags ignoring case and whitespace", () => {
  for (const search of [" summer ", "ORIGINAL", "outdoor"])
    assert.deepEqual(ids(filterSets(sets, [], { ...options, search })), [
      "shoot",
    ])
})
test("media filters restrict sets by matching members only when active", () => {
  const media = [{ set_ids: ["shoot"] }]
  // Only membership is read: the caller has already applied media/folder filters.
  assert.deepEqual(
    ids(
      filterSets(sets, media, {
        ...options,
        filterByMedia: true,
      })
    ),
    ["shoot"]
  )
  assert.deepEqual(
    filterSets(sets, [], { ...options, filterByMedia: true }),
    []
  )
})
test("set picker composes with search and sorting supports oldest and name", () => {
  assert.deepEqual(
    ids(filterSets(sets, [], { ...options, setFilter: "shoot" })),
    ["shoot"]
  )
  assert.deepEqual(
    filterSets(sets, [], { ...options, setFilter: "shoot", search: "clips" }),
    []
  )
  assert.deepEqual(
    ids(
      filterSets(sets, [], {
        ...options,
        sorting: [{ id: "uploaded_at", desc: false }],
      })
    ),
    ["empty", "shoot", "clips"]
  )
  assert.deepEqual(
    ids(
      filterSets(sets, [], {
        ...options,
        sorting: [{ id: "display_name", desc: false }],
      })
    ),
    ["clips", "empty", "shoot"]
  )
})
