import { describe, expect, it } from "vite-plus/test"
import {
  applySelectionClick,
  type SelectionAnchor,
  type SelectionModifiers,
  type SelectionRows,
} from "./range-selection"

const ids = ["a", "b", "c", "d", "e", "f", "g"]

function click(
  target: string,
  modifiers: SelectionModifiers,
  state: { rows: SelectionRows; anchor: SelectionAnchor | null },
  order: readonly string[] = ids
) {
  return applySelectionClick({
    ids: order,
    anchor: state.anchor,
    target,
    selection: state.rows,
    modifiers,
  })
}
const start = { rows: {}, anchor: null }
const keys = (rows: SelectionRows) => Object.keys(rows).sort()

describe("applySelectionClick", () => {
  it("toggles an item and anchors it", () => {
    const on = click("c", { toggle: true }, start)
    expect(keys(on.rows)).toEqual(["c"])
    expect(on.anchor.id).toBe("c")
    expect(keys(click("c", { toggle: true }, on).rows)).toEqual([])
  })

  it("selects a forward and a backward range, inclusive", () => {
    const anchored = click("b", { toggle: true }, start)
    expect(keys(click("e", { range: true }, anchored).rows)).toEqual([
      "b",
      "c",
      "d",
      "e",
    ])
    const back = click("e", { toggle: true }, start)
    expect(keys(click("b", { range: true }, back).rows)).toEqual([
      "b",
      "c",
      "d",
      "e",
    ])
  })

  it("selects just the item when there is no anchor", () => {
    const state = { rows: { a: true as const }, anchor: null }
    expect(keys(click("d", { range: true }, state).rows)).toEqual(["d"])
    const added = click("d", { range: true, toggle: true }, state)
    expect(keys(added.rows)).toEqual(["a", "d"])
    expect(added.anchor.id).toBe("d")
  })

  it("replaces the previous shift range from the same anchor", () => {
    let state = click("b", { toggle: true }, start)
    state = click("e", { range: true }, state)
    state = click("c", { range: true }, state)
    expect(keys(state.rows)).toEqual(["b", "c"])
    state = click("a", { range: true }, state)
    expect(keys(state.rows)).toEqual(["a", "b"])
    expect(state.anchor.id).toBe("b")
  })

  it("keeps items selected another way when the range is replaced", () => {
    let state = click("g", { toggle: true }, start)
    state = click("b", { toggle: true }, state)
    state = click("d", { range: true }, state)
    state = click("c", { range: true }, state)
    expect(keys(state.rows)).toEqual(["b", "c", "g"])
  })

  it("adds a range with Cmd/Ctrl and commits it", () => {
    let state = click("a", { toggle: true }, start)
    state = click("g", { toggle: true }, state)
    state = click("d", { toggle: true }, state)
    state = click("f", { range: true, toggle: true }, state)
    expect(keys(state.rows)).toEqual(["a", "d", "e", "f", "g"])
    state = click("d", { range: true }, state)
    expect(keys(state.rows)).toEqual(["a", "d", "e", "f", "g"])
  })

  it("treats an anchor that is no longer listed as no anchor", () => {
    const state = { rows: { x: true as const }, anchor: { id: "x", range: [] } }
    const next = click("c", { range: true }, state)
    expect(keys(next.rows)).toEqual(["c"])
    expect(next.anchor.id).toBe("c")
  })

  it("follows the displayed order, not the original one", () => {
    const order = ["g", "f", "e", "d", "c", "b", "a"]
    const anchored = click("f", { toggle: true }, start, order)
    expect(keys(click("d", { range: true }, anchored, order).rows)).toEqual([
      "d",
      "e",
      "f",
    ])
  })
})
