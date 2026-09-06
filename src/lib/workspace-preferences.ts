import type { SortingState } from "@tanstack/react-table"

export const preferencesCookieName = "mediabinder_preferences"
export type WorkspacePreferences = {
  censored: boolean
  sorting: SortingState
}
export function workspacePreferencesCookie(
  preferences: WorkspacePreferences,
  secure: boolean
): string {
  const value = encodeURIComponent(JSON.stringify(preferences))
  return `${preferencesCookieName}=${value}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`
}
