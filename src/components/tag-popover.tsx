import { useState } from "react"
import { Popover } from "radix-ui"
import { Check, Plus } from "lucide-react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { action } from "@/lib/api"
import { Button } from "./ui/button"
import { Input } from "./ui/input"

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
  const [chosen, setChosen] = useState<string[]>([])
  const client = useQueryClient()
  const save = useMutation({
    mutationFn: () => action("add-tags", { ids, tags: chosen }),
    onSuccess: async () => {
      setOpen(false)
      await client.invalidateQueries({ queryKey: ["library"] })
      toast.success(
        `Tags added to ${ids.length === 1 ? "1 item" : `${ids.length} items`}`
      )
    },
    onError: (error) => toast.error(error.message),
  })
  const term = search.trim().toLowerCase()
  const options = [...new Set([...allTags, ...chosen])]
    .filter((tag) => !existing.includes(tag) && tag.includes(term))
    .sort()
  const toggle = (tag: string) =>
    setChosen((current) =>
      current.includes(tag)
        ? current.filter((value) => value !== tag)
        : [...current, tag]
    )
  return (
    <Popover.Root
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        if (value) {
          setSearch("")
          setChosen([])
        }
      }}
    >
      <Popover.Trigger asChild>
        <button
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
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (chosen.length) save.mutate()
            }}
          >
            <h3>{bulk ? `Add tags to ${ids.length} items` : "Add tags"}</h3>
            <Input
              aria-label="Find or create a tag"
              placeholder="Find or create a tag…"
              maxLength={50}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <div className="tag-options">
              {options.map((tag) => (
                <button
                  type="button"
                  key={tag}
                  aria-pressed={chosen.includes(tag)}
                  onClick={() => toggle(tag)}
                >
                  <span>{tag}</span>
                  {chosen.includes(tag) && <Check size={15} />}
                </button>
              ))}
              {term &&
                !allTags.includes(term) &&
                !chosen.includes(term) &&
                !existing.includes(term) && (
                  <button
                    type="button"
                    onClick={() => {
                      toggle(term)
                      setSearch("")
                    }}
                  >
                    <Plus size={15} />
                    <span>Create “{term}”</span>
                  </button>
                )}
              {!options.length && !term && <p>Type a name to create a tag.</p>}
              {existing.includes(term) && <p>This tag is already added.</p>}
            </div>
            <div className="tag-popover-footer">
              <span>{chosen.length} selected</span>
              <Button type="submit" disabled={!chosen.length || save.isPending}>
                {save.isPending ? "Adding…" : "Add tags"}
              </Button>
            </div>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
