import type { CSSProperties } from "react"
export function tagStyle(color = "#7dd3fc"): CSSProperties {
  return { "--tag-color": color } as CSSProperties
}

// Saturated, widely spaced hues; reuse only after every color has been used.
export const tagPalette = [
  "#ff5252",
  "#ff9f1c",
  "#f4df25",
  "#83df32",
  "#20d68c",
  "#22d3ee",
  "#4385ff",
  "#9855ff",
  "#f044cf",
] as const

export function tagColorChoices(existing: string[]): string[] {
  const colors = existing.map((color) => color.toLowerCase())
  const uses = tagPalette.map(
    (color) => colors.filter((used) => used === color).length
  )
  const leastUsed = Math.min(...uses)
  const candidates = tagPalette.filter((_, index) => uses[index] === leastUsed)
  if (!colors.length || leastUsed > 0) return [...candidates]

  const rgb = (color: string) =>
    [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16))
  const distance = (a: string, b: string) => {
    const first = rgb(a),
      second = rgb(b)
    return first.reduce(
      (sum, channel, index) => sum + (channel - second[index]) ** 2,
      0
    )
  }
  const scores = candidates.map((color) =>
    Math.min(...colors.map((used) => distance(color, used)))
  )
  const best = Math.max(...scores)
  return candidates.filter((_, index) => scores[index] === best)
}
