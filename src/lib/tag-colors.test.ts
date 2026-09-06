import assert from "node:assert/strict"
import { test } from "node:test"
import { tagColorChoices, tagPalette } from "./tag-colors"

test("new catalogs can start with any vibrant palette color", () => {
  assert.deepEqual(tagColorChoices([]), [...tagPalette])
})

test("palette colors do not repeat until exhausted, then favor least used", () => {
  const used: string[] = []
  for (let i = 0; i < tagPalette.length; i++) {
    const choices = tagColorChoices(used)
    assert.ok(choices.length)
    assert.ok(choices.every((color) => !used.includes(color)))
    used.push(choices[0])
  }
  assert.deepEqual(tagColorChoices(used), [...tagPalette])
  assert.ok(!tagColorChoices([...used, used[0]]).includes(used[0]))
})

test("custom colors influence separation and hex casing does not affect reuse", () => {
  assert.ok(!tagColorChoices(["#FF5252"]).includes("#ff5252"))
  assert.ok(!tagColorChoices(["#ff5253"]).includes("#ff5252"))
})
