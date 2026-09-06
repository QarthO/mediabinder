import { z } from "zod"
import type { SortingState } from "@tanstack/react-table"

export const preferencesCookieName = "mediabinder_preferences"
export type WorkspacePreferences = {
  censored: boolean
  sorting: SortingState
}
const preferenceSchema = z.object({
  censored: z.boolean().catch(false),
  sorting: z
    .array(
      z.object({
        id: z.enum(["display_name", "uploaded_at", "size"]),
        desc: z.boolean(),
      })
    )
    .min(1)
    .max(3)
    .refine(
      (sorting) =>
        new Set(sorting.map((column) => column.id)).size === sorting.length
    )
    .catch([{ id: "uploaded_at", desc: true }]),
})

export function readWorkspacePreferences(
  cookieHeader: string | null
): WorkspacePreferences {
  const value = cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${preferencesCookieName}=`))
    ?.slice(preferencesCookieName.length + 1)
  try {
    return preferenceSchema.parse(
      value ? JSON.parse(decodeURIComponent(value)) : {}
    )
  } catch {
    return preferenceSchema.parse({})
  }
}

export function workspacePreferencesCookie(
  preferences: WorkspacePreferences,
  secure: boolean
): string {
  const value = encodeURIComponent(
    JSON.stringify(preferenceSchema.parse(preferences))
  )
  return `${preferencesCookieName}=${value}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`
}
