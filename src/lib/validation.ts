import { z } from "zod"
export const id = z.string().uuid()
export const setName = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((name) => !name.includes(","), "Set names cannot contain commas")
export const tagName = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .refine((name) => !name.includes(","), "Tag names cannot contain commas")
export const tags = z
  .array(tagName)
  .max(50)
  .transform((v) => [...new Set(v.map((t) => t.toLowerCase()))])
const date = z.iso.datetime({ offset: true })
export const metadata = z
  .object({
    id,
    kind: z.enum(["media", "set"]),
    displayName: z.string().trim().min(1).max(255),
    tags: tags.optional(),
    createdAt: date,
    setIds: z.array(id).max(200).optional(),
  })
  .refine((value) => value.kind !== "set" || !value.displayName.includes(","), {
    message: "Set names cannot contain commas",
    path: ["displayName"],
  })
export const newSet = z.object({
  displayName: setName,
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

export const removeMediaTag = z.object({
  id,
  tag: z.string().trim().min(1).max(50),
})

export const addMediaSets = z.object({
  ids: addMediaTags.shape.ids,
  names: z
    .array(setName)
    .min(1, "Choose at least one set")
    .max(200)
    .transform((names) => [
      ...new Map(names.map((name) => [name.toLowerCase(), name])).values(),
    ]),
})
