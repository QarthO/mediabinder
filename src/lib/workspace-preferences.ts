import type { SortingState } from "@tanstack/react-table"

export const preferencesCookieName = "mediabinder_preferences"
export type WorkspacePreferences = {
  censored: boolean
  // Blur strength, 1 (lightest) to `censorSteps` (the original blur).
  censorStep: number
  sorting: SortingState
}
export function workspacePreferencesCookie(
  preferences: WorkspacePreferences,
  secure: boolean
): string {
  const value = encodeURIComponent(JSON.stringify(preferences))
  return `${preferencesCookieName}=${value}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`
}

export const censorSteps = 7
export const defaultCensorStep = 2
// Step 1 is a tenth of the original blur and the last step is all of it, with
// the steps evenly spaced between.
const minBlurScale = 0.1
export function censorBlurScale(step: number): number {
  return minBlurScale + ((1 - minBlurScale) * (step - 1)) / (censorSteps - 1)
}
