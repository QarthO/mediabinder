import type { SortingState } from "@tanstack/react-table"

export const preferencesCookieName = "mediabinder_preferences"
export type WorkspacePreferences = {
  censored: boolean
  // 0 is the lightest blur, 100 the strongest (the original blur).
  censorStrength: number
  sorting: SortingState
}
export function workspacePreferencesCookie(
  preferences: WorkspacePreferences,
  secure: boolean
): string {
  const value = encodeURIComponent(JSON.stringify(preferences))
  return `${preferencesCookieName}=${value}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`
}

export const maxCensorStrength = 100
// The smallest blur is still visible: 4% of the strongest.
const minBlurScale = 0.04
export function censorBlurScale(strength: number): number {
  return minBlurScale + (1 - minBlurScale) * (strength / maxCensorStrength)
}
