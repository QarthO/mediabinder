import { parseNameList } from "@/lib/name-list"
import { ChipOverflow } from "./chip-overflow"
import { memo, useRef, useState } from "react"
import { useMobile } from "@/hooks/use-mobile"
import { MetadataPicker, MembershipCheckbox } from "./metadata-picker"
import { Plus, X, FolderOpen } from "lucide-react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { action } from "@/lib/api"
import type { Media, MediaSet } from "@/lib/types"
import { Command, CommandInput, CommandItem, CommandList } from "./ui/command"

export const MediaSets = memo(
  function MediaSets({
    media,
    mediaItems,
    bulk = false,
    sets,
    compact = false,
    iconOnly = false,
  }: {
    media?: Media
    mediaItems?: Media[]
    bulk?: boolean
    sets: MediaSet[]
    compact?: boolean
    iconOnly?: boolean
  }) {
    const items = mediaItems ?? (media ? [media] : [])
    const state = (setId: string): boolean | "mixed" => {
      const count = items.filter((item) => item.set_ids.includes(setId)).length
      return count === items.length ? true : count ? "mixed" : false
    }
    const mobile = useMobile()
    const [open, setOpen] = useState(false)
    const [search, setSearch] = useState("")
    const [pasted, setPasted] = useState(false)
    const input = useRef<HTMLInputElement>(null)
    const busy = useRef(false)
    const client = useQueryClient()
    const update = useMutation({
      mutationFn: (value: {
        names?: string[]
        setId?: string
        displayName?: string
        remove?: boolean
      }) =>
        action(value.names ? "add-sets" : "set-membership", {
          ids: items.map((item) => item.id),
          ...value,
        }),
      onSuccess: async (_result, value) => {
        if (value.names) {
          setSearch("")
          setPasted(false)
        }
        await client.invalidateQueries({ queryKey: ["library"] })
        if (!mobile) input.current?.focus()
      },
      onError: (error) => toast.error(error.message),
      onSettled: () => {
        busy.current = false
      },
    })
    const mutate = (value: {
      names?: string[]
      setId?: string
      displayName?: string
      remove?: boolean
    }) => {
      if (busy.current) return
      busy.current = true
      update.mutate(value)
    }
    const listMode = pasted || search.includes(",")
    const names = parseNameList(search)
    const addList = () => {
      if (busy.current || !names.length) return
      mutate({ names })
    }
    const term = search.trim()
    const options = !open
      ? []
      : sets.filter((s) =>
          s.display_name.toLowerCase().includes(term.toLowerCase())
        )
    const create =
      !listMode &&
      term &&
      !sets.some((s) => s.display_name.toLowerCase() === term.toLowerCase())
    const chips = (bulk || iconOnly ? [] : sets)
      .filter((s) => media?.set_ids.includes(s.id))
      .map((set) => (
        <span className="tag" key={set.id}>
          <span title={set.display_name}>{set.display_name}</span>
          <button
            type="button"
            aria-label={`Remove ${media?.display_name} from ${set.display_name}`}
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
          if (value) {
            setSearch("")
            setPasted(false)
          }
        }}
        title="Sets"
        media={items}
        bulk={bulk}
        trigger={
          <button
            type="button"
            className={
              bulk ? "bulk-tag-trigger" : iconOnly ? "icon-button" : "tag-add"
            }
            aria-label={
              bulk
                ? "Add sets to selected media"
                : `${iconOnly ? "Manage" : "Add"} sets ${iconOnly ? "for" : "to"} ${media?.display_name}`
            }
            disabled={!items.length}
            data-populated={
              (iconOnly && (media?.set_ids.length ?? 0) > 0) || undefined
            }
          >
            {iconOnly ? <FolderOpen size={18} /> : <Plus size={15} />}
            {bulk && "Add sets"}
          </button>
        }
      >
        {open && (
          <Command shouldFilter={false} loop>
            <div className="picker-search">
              <CommandInput
                ref={input}
                placeholder="Find, create, or paste sets…"
                aria-label="Find or create a set"
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
            <CommandList className="tag-options">
              {listMode && names.length > 0 && (
                <CommandItem
                  value="add-list"
                  disabled={update.isPending}
                  onSelect={addList}
                >
                  <Plus size={15} />
                  Add {names.length} {names.length === 1 ? "set" : "sets"}
                </CommandItem>
              )}
              {!listMode &&
                options.map((set) => (
                  <CommandItem
                    key={set.id}
                    value={set.id}
                    disabled={update.isPending}
                    onSelect={() =>
                      mutate({
                        setId: set.id,
                        remove: state(set.id) === true,
                      })
                    }
                  >
                    <MembershipCheckbox
                      checked={state(set.id)}
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
              {((listMode && !names.length) ||
                (!listMode && !options.length && !create)) && (
                <p>
                  {term ? "No matching sets." : "Type a name to create a set."}
                </p>
              )}
            </CommandList>
          </Command>
        )}
      </MetadataPicker>
    )
    if (iconOnly || bulk) return selector
    return (
      <div className="table-tags">
        {selector}
        <div className="tag-chips">
          {media?.set_ids.length ? (
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
  },
  (previous, next) =>
    previous.bulk === next.bulk &&
    previous.compact === next.compact &&
    previous.iconOnly === next.iconOnly &&
    previous.sets === next.sets &&
    previous.mediaItems === next.mediaItems &&
    previous.media?.id === next.media?.id &&
    previous.media?.display_name === next.media?.display_name &&
    previous.media?.mime_type === next.media?.mime_type &&
    previous.media?.set_ids === next.media?.set_ids
)
