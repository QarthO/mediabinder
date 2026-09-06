import { useMobile } from "@/hooks/use-mobile"
import type { Media } from "@/lib/types"
import { useRef, useState } from "react"
import { Plus, Tags } from "lucide-react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { action } from "@/lib/api"
import { Command, CommandInput, CommandItem, CommandList } from "./ui/command"
import { MetadataPicker, MembershipCheckbox } from "./metadata-picker"

export function TagPopover({
  ids,
  allTags,
  existing = [],
  label,
  bulk = false,
  media,
  mediaItems,
  iconOnly = false,
}: {
  media?: Media
  mediaItems?: Media[]
  ids: string[]
  allTags: string[]
  existing?: string[]
  label: string
  bulk?: boolean
  iconOnly?: boolean
}) {
  const mobile = useMobile()
  const items = mediaItems ?? (media ? [media] : [])
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [knownTags, setKnownTags] = useState<string[]>([])
  const input = useRef<HTMLInputElement>(null)
  const busy = useRef(false)
  const client = useQueryClient()
  const save = useMutation({
    mutationFn: ({ tag, remove }: { tag: string; remove: boolean }) =>
      action(remove ? "remove-tags" : "add-tags", { ids, tags: [tag] }),
    onSuccess: (_result, { tag }) =>
      setKnownTags((tags) => [...new Set([...tags, tag])]),
    onError: (error) => toast.error(error.message),
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: ["library"] })
      busy.current = false
      if (!mobile) input.current?.focus()
    },
  })
  const term = search.trim().toLowerCase()
  const options = [
    ...new Set([
      ...allTags,
      ...knownTags,
      ...existing,
      ...items.flatMap((item) => item.tags),
    ]),
  ]
    .filter((tag) => tag.toLowerCase().includes(term))
    .sort((a, b) => a.localeCompare(b))
  const state = (tag: string): boolean | "mixed" => {
    const count = items.length
      ? items.filter((item) => item.tags.includes(tag)).length
      : existing.includes(tag)
        ? ids.length
        : 0
    return count === ids.length ? true : count ? "mixed" : false
  }
  const create = !!term && !options.includes(term)
  const toggle = (tag: string) => {
    if (busy.current) return
    busy.current = true
    save.mutate({ tag, remove: state(tag) === true })
  }
  return (
    <MetadataPicker
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        if (value) {
          setSearch("")
          setKnownTags([...allTags])
        }
      }}
      title="Tags"
      media={items}
      bulk={bulk}
      trigger={
        <button
          type="button"
          className={
            iconOnly ? "icon-button" : bulk ? "bulk-tag-trigger" : "tag-add"
          }
          aria-label={label}
          disabled={!ids.length}
          data-populated={(iconOnly && existing.length > 0) || undefined}
        >
          {iconOnly ? <Tags size={18} /> : <Plus size={15} />}
          {bulk && "Add tags"}
        </button>
      }
    >
      <Command shouldFilter={false} loop>
        <div className="picker-search">
          <CommandInput
            ref={input}
            aria-label="Find or create a tag"
            placeholder="Find or create a tag…"
            maxLength={50}
            value={search}
            onValueChange={setSearch}
          />
        </div>
        <CommandList className="tag-options" aria-busy={save.isPending}>
          {options.map((tag) => (
            <CommandItem
              key={tag}
              value={tag}
              disabled={save.isPending}
              onSelect={() => toggle(tag)}
            >
              <MembershipCheckbox checked={state(tag)} label={tag} />
              <span>{tag}</span>
            </CommandItem>
          ))}
          {create && (
            <CommandItem
              value={`create:${term}`}
              disabled={save.isPending}
              onSelect={() => toggle(term)}
            >
              <Plus size={15} />
              Create “{term}”
            </CommandItem>
          )}
          {!options.length && !create && <p>Type a name to create a tag.</p>}
        </CommandList>
      </Command>
      <span className="sr-only" role="status">
        {save.isPending ? "Saving tags…" : ""}
      </span>
    </MetadataPicker>
  )
}
