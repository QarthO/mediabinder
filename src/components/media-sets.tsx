import { useRef, useState } from "react"
import { Popover } from "radix-ui"
import { Plus, X } from "lucide-react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { action } from "@/lib/api"
import type { Media, MediaSet } from "@/lib/types"
import { Command, CommandInput, CommandItem, CommandList } from "./ui/command"

export function MediaSets({ media, sets }: { media: Media; sets: MediaSet[] }) {
  const [search, setSearch] = useState("")
  const input = useRef<HTMLInputElement>(null)
  const busy = useRef(false)
  const client = useQueryClient()
  const update = useMutation({
    mutationFn: (value: {
      setId?: string
      displayName?: string
      remove?: boolean
    }) => action("set-membership", { id: media.id, ...value }),
    onSuccess: async () => {
      setSearch("")
      await client.invalidateQueries({ queryKey: ["library"] })
      input.current?.focus()
    },
    onError: (error) => toast.error(error.message),
    onSettled: () => {
      busy.current = false
    },
  })
  const mutate = (value: {
    setId?: string
    displayName?: string
    remove?: boolean
  }) => {
    if (busy.current) return
    busy.current = true
    update.mutate(value)
  }
  const term = search.trim()
  const options = sets.filter(
    (s) =>
      !media.set_ids.includes(s.id) &&
      s.display_name.toLowerCase().includes(term.toLowerCase())
  )
  const create =
    term &&
    !sets.some((s) => s.display_name.toLowerCase() === term.toLowerCase())
  return (
    <div className="table-tags">
      <Popover.Root
        onOpenChange={(open) => {
          if (open) setSearch("")
        }}
      >
        <Popover.Trigger asChild>
          <button
            type="button"
            className="tag-add"
            aria-label={`Add sets to ${media.display_name}`}
          >
            <Plus size={15} />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className="tag-popover"
            sideOffset={8}
            align="start"
            collisionPadding={12}
          >
            <h3>Add to sets</h3>
            <Command shouldFilter={false} loop>
              <CommandInput
                ref={input}
                placeholder="Find or create a set…"
                aria-label="Find or create a set"
                maxLength={255}
                value={search}
                onValueChange={setSearch}
              />
              <CommandList className="tag-options">
                {options.map((set) => (
                  <CommandItem
                    key={set.id}
                    value={set.id}
                    disabled={update.isPending}
                    onSelect={() => mutate({ setId: set.id })}
                  >
                    {set.display_name}
                  </CommandItem>
                ))}
                {create && (
                  <CommandItem
                    value="create"
                    disabled={update.isPending}
                    onSelect={() => mutate({ displayName: term })}
                  >
                    <Plus size={15} />
                    Create “{term}”
                  </CommandItem>
                )}
                {!options.length && !create && (
                  <p>
                    {term
                      ? "This set is already added."
                      : "Type a name to create a set."}
                  </p>
                )}
              </CommandList>
            </Command>
            <div className="tag-popover-hint">↑ ↓ to choose · Enter to add</div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <div className="tag-chips">
        {media.set_ids.length ? (
          sets
            .filter((s) => media.set_ids.includes(s.id))
            .map((set) => (
              <span className="tag" key={set.id}>
                <span title={set.display_name}>{set.display_name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${media.display_name} from ${set.display_name}`}
                  disabled={update.isPending}
                  onClick={() => mutate({ setId: set.id, remove: true })}
                >
                  <X size={12} />
                </button>
              </span>
            ))
        ) : (
          <span className="no-tags">None</span>
        )}
      </div>
    </div>
  )
}
