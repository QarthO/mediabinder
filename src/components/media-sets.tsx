import { ChipOverflow } from "./chip-overflow"
import { useRef, useState } from "react"
import { useMobile } from "@/hooks/use-mobile"
import { MetadataPicker, MembershipCheckbox } from "./metadata-picker"
import { Plus, X, FolderOpen } from "lucide-react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { action } from "@/lib/api"
import type { Media, MediaSet } from "@/lib/types"
import { Command, CommandInput, CommandItem, CommandList } from "./ui/command"

export function MediaSets({
  media,
  sets,
  compact = false,
  iconOnly = false,
}: {
  media: Media
  sets: MediaSet[]
  compact?: boolean
  iconOnly?: boolean
}) {
  const mobile = useMobile()
  const [open, setOpen] = useState(false)
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
      await client.invalidateQueries({ queryKey: ["library"] })
      if (!mobile) input.current?.focus()
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
  const options = sets.filter((s) =>
    s.display_name.toLowerCase().includes(term.toLowerCase())
  )
  const create =
    term &&
    !sets.some((s) => s.display_name.toLowerCase() === term.toLowerCase())
  const chips = sets
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
  const selector = (
    <MetadataPicker
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        if (value) setSearch("")
      }}
      title="Sets"
      media={[media]}
      trigger={
        <button
          type="button"
          className={iconOnly ? "icon-button" : "tag-add"}
          aria-label={`${iconOnly ? "Manage" : "Add"} sets ${iconOnly ? "for" : "to"} ${media.display_name}`}
          data-populated={(iconOnly && media.set_ids.length > 0) || undefined}
        >
          {iconOnly ? <FolderOpen size={18} /> : <Plus size={15} />}
        </button>
      }
    >
      <Command shouldFilter={false} loop>
        <div className="picker-search">
          <CommandInput
            ref={input}
            placeholder="Find or create a set…"
            aria-label="Find or create a set"
            maxLength={255}
            value={search}
            onValueChange={setSearch}
          />
        </div>
        <CommandList className="tag-options">
          {options.map((set) => (
            <CommandItem
              key={set.id}
              value={set.id}
              disabled={update.isPending}
              onSelect={() =>
                mutate({
                  setId: set.id,
                  remove: media.set_ids.includes(set.id),
                })
              }
            >
              <MembershipCheckbox
                checked={media.set_ids.includes(set.id)}
                label={set.display_name}
              />
              <span>{set.display_name}</span>
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
            <p>{term ? "No matching sets." : "Type a name to create a set."}</p>
          )}
        </CommandList>
      </Command>
    </MetadataPicker>
  )
  if (iconOnly) return selector
  return (
    <div className="table-tags">
      {selector}
      <div className="tag-chips">
        {media.set_ids.length ? (
          compact ? (
            <ChipOverflow label="sets">{chips}</ChipOverflow>
          ) : (
            chips
          )
        ) : (
          <span className="no-tags">None</span>
        )}
      </div>
    </div>
  )
}
