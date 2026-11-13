import type { Media } from "@/lib/types"

export const hasDuplicates = (media: Pick<Media, "copy_count">) =>
  media.copy_count > 1

// What deleting every extra copy would free: each item's size once per copy
// beyond the first.
export function reclaimableBytes(items: Pick<Media, "copy_count" | "size">[]) {
  let total = 0
  for (const item of items)
    if (item.copy_count > 1) total += (item.copy_count - 1) * item.size
  return total
}
