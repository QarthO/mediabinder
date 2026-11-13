import { describe, expect, it } from "vite-plus/test"
import { parseNameList, formatNameList } from "./name-list"
import { tags, newSet, metadata, addMediaSets } from "./validation"

const id = "a6507f20-de60-48a4-a04d-e911c64f5f9e"

describe("name lists", () => {
  it("round-trips copied names with spaces inside names intact", () => {
    const names = ["Travel", "New York", "Behind the scenes"]
    expect(formatNameList(names)).toBe("Travel, New York, Behind the scenes")
    expect(parseNameList(formatNameList(names))).toEqual(names)
  })

  it("trims pasted separators, ignores blanks and deduplicates casing", () => {
    const names = parseNameList(
      " Travel ,  New York,,\nTRAVEL,\t new york , Blue  sky, "
    )
    expect(names).toEqual(["Travel", "New York", "Blue  sky"])
    expect(tags.parse(names)).toEqual(["travel", "new york", "blue  sky"])
    expect(parseNameList(", , \n")).toEqual([])
  })

  it("applies limits to individual names and list counts", () => {
    const names = parseNameList(`${"a".repeat(50)}, ${"b".repeat(50)}`)
    expect(tags.safeParse(names).success).toBe(true)
    expect(tags.safeParse(["a".repeat(51)]).success).toBe(false)
    expect(
      tags.safeParse(Array.from({ length: 51 }, (_, i) => `tag${i}`)).success
    ).toBe(false)
    expect(addMediaSets.safeParse({ ids: [id], names: [] }).success).toBe(false)
    expect(
      addMediaSets.safeParse({ ids: [id], names: ["a".repeat(256)] }).success
    ).toBe(false)
  })

  it("keeps commas out of tag and set names on create and rename", () => {
    expect(tags.safeParse(["one,two"]).success).toBe(false)
    expect(newSet.safeParse({ displayName: "one, two" }).success).toBe(false)
    expect(
      addMediaSets.safeParse({ ids: [id], names: ["one, two"] }).success
    ).toBe(false)
    const input = {
      id,
      displayName: "one, two",
      createdAt: "2026-09-05T00:00:00Z",
    }
    expect(metadata.safeParse({ ...input, kind: "set" }).success).toBe(false)
    expect(metadata.safeParse({ ...input, kind: "media" }).success).toBe(true)
    expect(
      addMediaSets.parse({ ids: [id, id], names: [" Travel ", "travel"] })
    ).toEqual({ ids: [id], names: ["travel"] })
  })
})
