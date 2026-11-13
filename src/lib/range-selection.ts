// File-explorer selection for a list of items in display order. Pure: the
// table owner keeps the anchor and the selection, and calls this on a click.
//
// - Plain click or Cmd/Ctrl-click toggles the item and makes it the anchor.
// - Shift-click selects the anchor..item range (inclusive) in display order.
//   A plain shift-click first drops the range the previous shift-click added
//   from the same anchor, so the range follows the pointer like Finder and
//   Explorer. Items selected another way stay selected.
// - Shift+Cmd/Ctrl-click adds the range to the selection and commits it: the
//   anchor stays, but a later plain shift-click no longer removes it.
// - Without an anchor, or when the anchor is not in the list, shift-click
//   selects just that item and anchors it.

export type SelectionRows = Record<string, true>

export type SelectionAnchor = {
  id: string
  // Items the last plain shift-click added, removed again by the next one.
  range: readonly string[]
}

export type SelectionModifiers = {
  // Cmd on macOS, Ctrl elsewhere.
  toggle?: boolean
  range?: boolean
}

export type SelectionClick = {
  ids: readonly string[]
  anchor: SelectionAnchor | null
  target: string
  selection: SelectionRows
  modifiers: SelectionModifiers
}

export function modifiersOf(event: {
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
}): SelectionModifiers {
  return { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey }
}

export function hasModifier(modifiers: SelectionModifiers) {
  return Boolean(modifiers.toggle || modifiers.range)
}

export function applySelectionClick({
  ids,
  anchor,
  target,
  selection,
  modifiers,
}: SelectionClick): { rows: SelectionRows; anchor: SelectionAnchor } {
  if (modifiers.range) {
    const from = anchor ? ids.indexOf(anchor.id) : -1
    const to = ids.indexOf(target)
    if (from >= 0 && to >= 0 && anchor) {
      const span = ids.slice(Math.min(from, to), Math.max(from, to) + 1)
      const rows = { ...selection }
      if (!modifiers.toggle) for (const id of anchor.range) delete rows[id]
      const added: string[] = []
      for (const id of span) {
        if (!rows[id]) added.push(id)
        rows[id] = true
      }
      return {
        rows,
        anchor: { id: anchor.id, range: modifiers.toggle ? [] : added },
      }
    }
    return {
      rows: modifiers.toggle
        ? { ...selection, [target]: true }
        : { [target]: true },
      anchor: { id: target, range: [] },
    }
  }
  const rows = { ...selection }
  if (rows[target]) delete rows[target]
  else rows[target] = true
  return { rows, anchor: { id: target, range: [] } }
}
