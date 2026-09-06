import { test } from "node:test"
import assert from "node:assert/strict"
import { parseNameList, formatNameList } from "./name-list"
import { tags, newSet, metadata, addMediaSets } from "./validation"

const id = "a6507f20-de60-48a4-a04d-e911c64f5f9e"

test("copied names round-trip with spaces inside names intact", () => {
  const names = ["Travel", "New York", "Behind the scenes"]
  assert.equal(formatNameList(names), "Travel, New York, Behind the scenes")
  assert.deepEqual(parseNameList(formatNameList(names)), names)
})

test("pasted lists trim separator whitespace, ignore blanks, and deduplicate casing", () => {
  const names = parseNameList(
    " Travel ,  New York,,\nTRAVEL,\t new york , Blue  sky, "
  )
  assert.deepEqual(names, ["Travel", "New York", "Blue  sky"])
  assert.deepEqual(tags.parse(names), ["travel", "new york", "blue  sky"])
  assert.deepEqual(parseNameList(", , \n"), [])
})

test("name limits apply to individual names and list counts", () => {
  const names = parseNameList(`${"a".repeat(50)}, ${"b".repeat(50)}`)
  assert.equal(tags.safeParse(names).success, true)
  assert.equal(tags.safeParse(["a".repeat(51)]).success, false)
  assert.equal(
    tags.safeParse(Array.from({ length: 51 }, (_, i) => `tag${i}`)).success,
    false
  )
  assert.equal(addMediaSets.safeParse({ ids: [id], names: [] }).success, false)
  assert.equal(
    addMediaSets.safeParse({ ids: [id], names: ["a".repeat(256)] }).success,
    false
  )
})

test("commas cannot enter tag names or set names through create or rename", () => {
  assert.equal(tags.safeParse(["one,two"]).success, false)
  assert.equal(newSet.safeParse({ displayName: "one, two" }).success, false)
  assert.equal(
    addMediaSets.safeParse({ ids: [id], names: ["one, two"] }).success,
    false
  )
  const input = {
    id,
    displayName: "one, two",
    createdAt: "2026-09-05T00:00:00Z",
  }
  assert.equal(metadata.safeParse({ ...input, kind: "set" }).success, false)
  assert.equal(metadata.safeParse({ ...input, kind: "media" }).success, true)
  assert.deepEqual(
    addMediaSets.parse({ ids: [id, id], names: [" Travel ", "travel"] }),
    { ids: [id], names: ["travel"] }
  )
})
