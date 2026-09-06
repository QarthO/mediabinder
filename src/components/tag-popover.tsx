import { useMobile } from "@/hooks/use-mobile"
import type { Media } from "@/lib/types"
import { Thumbnail } from "./thumbnail"
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog"
import { useEffect, useRef, useState } from "react"
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
  media,
}: {
  media?: Media
  ids: string[]
  allTags: string[]
  existing?: string[]
  label: string
  bulk?: boolean
}) {
  const mobile = useMobile()
  const [viewport, setViewport] = useState<{
    bottom: number
    height: number
  } | null>(null)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [added, setAdded] = useState<string[]>([])
  const input = useRef<HTMLInputElement>(null)
  const drawer = useRef<HTMLDivElement>(null)
  const busy = useRef(false)
  const client = useQueryClient()
  const save = useMutation({
    mutationFn: (tag: string) => action("add-tags", { ids, tags: [tag] }),
    onSuccess: async (_result, tag) => {
      setAdded((tags) => [...tags, tag])
      await client.invalidateQueries({ queryKey: ["library"] })
      if (!mobile) input.current?.focus()
    },
    onError: (error) => toast.error(error.message),
    onSettled: () => {
      busy.current = false
    },
  })
  useEffect(() => {
    if (!mobile || !open) return
    const viewport = window.visualViewport
    const update = () =>
      setViewport(
        viewport
          ? {
              bottom: Math.max(
                0,
                window.innerHeight - viewport.height - viewport.offsetTop
              ),
              height: viewport.height,
            }
          : null
      )
    update()
    viewport?.addEventListener("resize", update)
    viewport?.addEventListener("scroll", update)
    return () => {
      viewport?.removeEventListener("resize", update)
      viewport?.removeEventListener("scroll", update)
    }
  }, [mobile, open])
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
  const onOpenChange = (value: boolean) => {
    setOpen(value)
    if (value) {
      setSearch("")
      setAdded([])
    }
  }
  const trigger = (
    <button
      type="button"
      className={bulk ? "bulk-tag-trigger" : "tag-add"}
      aria-label={label}
      disabled={!ids.length}
    >
      <Plus size={15} />
      {bulk && "Add tags"}
    </button>
  )
  const picker = (
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
  )
  if (mobile)
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogTrigger asChild>{trigger}</DialogTrigger>
        <DialogContent
          ref={drawer}
          className="mobile-tag-drawer"
          overlayClassName="mobile-tag-overlay"
          style={
            viewport
              ? { bottom: viewport.bottom, maxHeight: viewport.height * 0.9 }
              : undefined
          }
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            drawer.current?.focus()
          }}
        >
          <div className="drawer-handle" aria-hidden="true" />
          <div className="mobile-tag-heading">
            <DialogTitle>Add tags</DialogTitle>
            <DialogDescription className="sr-only">
              Choose an existing tag or search to create one. You can add
              multiple tags.
            </DialogDescription>
            {bulk ? (
              <span className="drawer-selection-count">
                {ids.length} selected
              </span>
            ) : (
              media && (
                <div className="drawer-media">
                  <div className="drawer-media-thumbnail">
                    <Thumbnail
                      id={media.id}
                      name=""
                      video={media.mime_type.startsWith("video/")}
                      eager
                    />
                  </div>
                  <strong>{media.display_name}</strong>
                </div>
              )
            )}
          </div>
          {picker}
          <span className="sr-only" role="status">
            {save.isPending
              ? "Adding tag…"
              : added.length
                ? `${added.length} tags added`
                : ""}
          </span>
        </DialogContent>
      </Dialog>
    )
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="tag-popover"
          sideOffset={8}
          align="start"
          collisionPadding={12}
          aria-label={bulk ? "Add tags to selected media" : "Add media tags"}
        >
          <h3>{bulk ? `Add tags to ${ids.length} items` : "Add tags"}</h3>
          {picker}
          <div className="tag-popover-hint" role="status">
            {save.isPending ? "Adding tag…" : "↑ ↓ to choose · Enter to add"}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
