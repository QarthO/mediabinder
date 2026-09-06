import { parseNameList } from "@/lib/name-list"
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
  const [pasted, setPasted] = useState(false)
  const [knownTags, setKnownTags] = useState<string[]>([])
  const input = useRef<HTMLInputElement>(null)
  const busy = useRef(false)
  const client = useQueryClient()
  const save = useMutation({
    mutationFn: ({
      tags,
      remove,
    }: {
      tags: string[]
      remove?: boolean
      list?: boolean
    }) => action(remove ? "remove-tags" : "add-tags", { ids, tags }),
    onSuccess: (_result, value) => {
      setKnownTags((tags) => [...new Set([...tags, ...value.tags])])
      if (value.list) {
        setSearch("")
        setPasted(false)
      }
    },
    onError: (error) => toast.error(error.message),
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: ["library"] })
      busy.current = false
      if (!mobile) input.current?.focus()
    },
  })
  const term = search.trim().toLowerCase()
  const options = !open
    ? []
    : [
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
  const listMode = pasted || search.includes(",")
  const names = parseNameList(search.toLowerCase())
  const create = !listMode && !!term && !options.includes(term)
  const addList = () => {
    if (busy.current || !names.length) return
    busy.current = true
    save.mutate({ tags: names, list: true })
  }
  const toggle = (tag: string) => {
    if (busy.current) return
    busy.current = true
    save.mutate({ tags: [tag], remove: state(tag) === true })
  }
  return (
    <MetadataPicker
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        if (value) {
          setSearch("")
          setPasted(false)
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
      {open && (
        <Command shouldFilter={false} loop>
          <div className="picker-search">
            <CommandInput
              ref={input}
              aria-label="Find or create a tag"
              placeholder="Find, create, or paste tags…"
              onPaste={() => setPasted(true)}
              onKeyDown={(event) => {
                if (
                  listMode &&
                  event.key === "Enter" &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault()
                  event.stopPropagation()
                  addList()
                }
              }}
              value={search}
              onValueChange={setSearch}
            />
          </div>
          <CommandList className="tag-options" aria-busy={save.isPending}>
            {listMode && names.length > 0 && (
              <CommandItem
                value="add-list"
                disabled={save.isPending}
                onSelect={addList}
              >
                <Plus size={15} />
                Add {names.length} {names.length === 1 ? "tag" : "tags"}
              </CommandItem>
            )}
            {!listMode &&
              options.map((tag) => (
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
            {((listMode && !names.length) ||
              (!listMode && !options.length && !create)) && (
              <p>Type a name or paste comma-separated tags.</p>
            )}
          </CommandList>
        </Command>
      )}
      <span className="sr-only" role="status">
        {save.isPending ? "Saving tags…" : ""}
      </span>
    </MetadataPicker>
  )
}
