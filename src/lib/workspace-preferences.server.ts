import { Result } from "effect"
import { z } from "zod"
import {
  censorSteps,
  defaultCensorStep,
  preferencesCookieName,
  type WorkspacePreferences,
} from "./workspace-preferences"

const defaultSorting: WorkspacePreferences["sorting"] = [
  { id: "uploaded_at", desc: true },
]

const sortingSchema = z
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

// What a cookie may hold; each field is checked on its own below.
const storedSchema = z.object({
  censored: z.unknown().optional(),
  censorStep: z.unknown().optional(),
  sorting: z.unknown().optional(),
})

export function readWorkspacePreferences(
  cookieHeader: string | null
): WorkspacePreferences {
  const value = cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${preferencesCookieName}=`))
    ?.slice(preferencesCookieName.length + 1)
  const stored = value
    ? Result.getOrElse(
        Result.try(() => JSON.parse(decodeURIComponent(value))),
        () => ({})
      )
    : {}
  // Each field falls back to its default on its own when the cookie's value
  // for it is missing or invalid.
  const fields = storedSchema.safeParse(stored)
  const input = fields.success ? fields.data : {}
  const sorting = sortingSchema.safeParse(input.sorting)
  return {
    censored: input.censored === true,
    censorStep:
      typeof input.censorStep === "number" && Number.isFinite(input.censorStep)
        ? Math.round(Math.min(censorSteps, Math.max(1, input.censorStep)))
        : defaultCensorStep,
    sorting: sorting.success ? sorting.data : defaultSorting,
  }
}
