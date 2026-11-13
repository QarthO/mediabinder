// Tracks whether the last input was the keyboard or a pointer, as a
// `data-input` attribute on <html>. CSS shows focus rings only under
// `keyboard` (see base.css). Browsers' own `:focus-visible` heuristic treats
// any keydown, even a bare Shift or Escape, as keyboard use, so a mouse click
// made while Shift or Cmd is held got a ring. Only keys that move focus or
// activate a focused control count here.
//
// A DOM attribute and not React state: nothing re-renders on a key or click.

const NAVIGATION_KEYS = new Set([
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
])

const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "radio",
  "submit",
  "reset",
  "range",
])

function isTextEntry(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target instanceof HTMLTextAreaElement) return true
  if (target instanceof HTMLInputElement)
    return !NON_TEXT_INPUTS.has(target.type)
  return false
}

export function isKeyboardNavigation(event: KeyboardEvent) {
  if (event.key === "Tab") return true
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  if (NAVIGATION_KEYS.has(event.key)) return true
  // Space and Enter only activate a focused control; in a text field they type.
  return (
    (event.key === " " || event.key === "Enter") && !isTextEntry(event.target)
  )
}

let started = false

export function startInputModality() {
  if (started || typeof document === "undefined") return
  started = true
  const root = document.documentElement
  const set = (value: "keyboard" | "pointer") => {
    if (root.dataset.input !== value) root.dataset.input = value
  }
  document.addEventListener(
    "keydown",
    (event) => {
      if (isKeyboardNavigation(event)) set("keyboard")
    },
    true
  )
  document.addEventListener("pointerdown", () => set("pointer"), true)
}

export function isKeyboardModality() {
  return document.documentElement.dataset.input === "keyboard"
}
