import { z } from "zod"
export const id = z.string().uuid()
export const tags = z
  .array(z.string().trim().min(1).max(50))
  .max(50)
  .transform((v) => [...new Set(v.map((t) => t.toLowerCase()))])
const date = z.iso.datetime({ offset: true })
export const metadata = z.object({
  id,
  kind: z.enum(["media", "set"]),
  displayName: z.string().trim().min(1).max(255),
  tags,
  createdAt: date,
  setIds: z.array(id).max(200).optional(),
})
export const newSet = z.object({
  displayName: z.string().trim().min(1).max(255),
  tags: tags.default([]),
})
export const newPost = z.object({
  targetId: id,
  kind: z.enum(["media", "set"]),
  platform: z.string().trim().min(1).max(100),
  url: z
    .url()
    .max(2048)
    .refine(
      (value) => ["http:", "https:"].includes(new URL(value).protocol),
      "Use an http or https link"
    ),
  externalId: z.string().trim().max(255).default(""),
  createdAt: date,
})
export const folder = z.object({
  folderId: z
    .string()
    .trim()
    .regex(/^[\w-]{1,255}$/, "Choose a Drive folder or paste its ID"),
})
export function folderIdFromInput(value: string) {
  return value.match(/\/folders\/([\w-]+)/)?.[1] ?? value.trim()
}

export const addMediaTags = z.object({
  ids: z
    .array(id)
    .min(1)
    .max(1000)
    .transform((ids) => [...new Set(ids)]),
  tags: tags.refine((tags) => tags.length > 0, "Choose at least one tag"),
})
