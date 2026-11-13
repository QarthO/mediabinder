import { describe, expect, it } from "vite-plus/test"
import { filterMediaBySearch } from "./data-table"
import type { Media } from "./types"

const media = (overrides: Partial<Media>) =>
  ({
    id: "id",
    display_name: "Name",
    raw_name: "raw.png",
    tags: [],
    ...overrides,
  }) as Media

describe("filterMediaBySearch", () => {
  const items = [
    media({ id: "a", display_name: "Harbor Sunrise", raw_name: "IMG_1.png" }),
    media({
      id: "b",
      display_name: "Plain",
      raw_name: "DSC_2.jpg",
      tags: ["Travel"],
    }),
    media({ id: "c", display_name: "Other", raw_name: "clip.mov" }),
  ]

  it("matches the name, the original file name, or a tag, ignoring case", () => {
    expect(filterMediaBySearch(items, "sunrise").map((m) => m.id)).toEqual([
      "a",
    ])
    expect(filterMediaBySearch(items, "dsc_2").map((m) => m.id)).toEqual(["b"])
    expect(filterMediaBySearch(items, "TRAV").map((m) => m.id)).toEqual(["b"])
  })

  it("returns the same array when the search is empty", () => {
    expect(filterMediaBySearch(items, "")).toBe(items)
  })

  it("does not match other fields", () => {
    expect(filterMediaBySearch(items, "other-id")).toEqual([])
    expect(filterMediaBySearch(items, "png")).toHaveLength(1)
  })
})
