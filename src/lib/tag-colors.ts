import type { CSSProperties } from "react"
export function tagStyle(color = "#7dd3fc"): CSSProperties {
  return { "--tag-color": color } as CSSProperties
}
