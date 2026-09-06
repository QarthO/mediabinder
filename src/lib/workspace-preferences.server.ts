import { z } from "zod"
import {
  preferencesCookieName,
  type WorkspacePreferences,
} from "./workspace-preferences"

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
