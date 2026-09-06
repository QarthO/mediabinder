import { useRef, useState } from "react"
import { Popover } from "radix-ui"
import { Plus } from "lucide-react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { action } from "@/lib/api"
import { Command, CommandInput, CommandItem, CommandList } from "./ui/command"

export function TagPopover({
  ids,
  allTags,
  existing = [],
  label,
  bulk = false,
}: {
  ids: string[]
  allTags: string[]
  existing?: string[]
  label: string
  bulk?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [added, setAdded] = useState<string[]>([])
  const input = useRef<HTMLInputElement>(null)
  const busy = useRef(false)
  const client = useQueryClient()
  const save = useMutation({
    mutationFn: (tag: string) => action("add-tags", { ids, tags: [tag] }),
    onSuccess: async (_result, tag) => {
      setAdded((tags) => [...tags, tag])
      await client.invalidateQueries({ queryKey: ["library"] })
      input.current?.focus()
    },
    onError: (error) => toast.error(error.message),
    onSettled: () => {
      busy.current = false
    },
  })
  const term = search.trim().toLowerCase()
  const options = allTags
    .filter(
      (tag) =>
        !existing.includes(tag) && !added.includes(tag) && tag.includes(term)
    )
    .sort(
      (a, b) => Number(b === term) - Number(a === term) || a.localeCompare(b)
    )
  const create = Boolean(
    term &&
    !allTags.includes(term) &&
    !existing.includes(term) &&
    !added.includes(term)
  )
  const add = (tag: string) => {
    if (!busy.current) {
      busy.current = true
      setSearch("")
      save.mutate(tag)
    }
  }
  return (
    <Popover.Root
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        if (value) {
          setSearch("")
          setAdded([])
        }
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className={bulk ? "bulk-tag-trigger" : "tag-add"}
          aria-label={label}
          disabled={!ids.length}
        >
          <Plus size={15} />
          {bulk && "Add tags"}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="tag-popover"
          sideOffset={8}
          align="start"
          collisionPadding={12}
          aria-label={bulk ? "Add tags to selected media" : "Add media tags"}
        >
          <h3>{bulk ? `Add tags to ${ids.length} items` : "Add tags"}</h3>
          <Command shouldFilter={false} loop>
            <CommandInput
              ref={input}
              aria-label="Find or create a tag"
              placeholder="Find or create a tag…"
              maxLength={50}
              value={search}
              onValueChange={setSearch}
            />
            <CommandList className="tag-options" aria-busy={save.isPending}>
              {options.map((tag) => (
                <CommandItem
                  key={tag}
                  value={tag}
                  disabled={save.isPending}
                  onSelect={() => add(tag)}
                >
                  {tag}
                </CommandItem>
              ))}
              {create && (
                <CommandItem
                  value={term}
                  disabled={save.isPending}
                  onSelect={() => add(term)}
                >
                  <Plus size={15} />
                  Create “{term}”
                </CommandItem>
              )}
              {!options.length && !create && (
                <p>
                  {term
                    ? "This tag is already added."
                    : "Type a name to create a tag."}
                </p>
              )}
            </CommandList>
          </Command>
          <div className="tag-popover-hint" role="status">
            {save.isPending ? "Adding tag…" : "↑ ↓ to choose · Enter to add"}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
