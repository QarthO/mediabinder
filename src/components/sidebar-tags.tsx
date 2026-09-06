import { useState } from "react"
import { Collapsible } from "radix-ui"
import { ChevronDown, Search, Tags, X } from "lucide-react"

export function SidebarTags({
  tags,
  selected,
  colors,
  counts,
  onChange,
  onColor,
  expanded,
  onExpanded,
}: {
  tags: string[]
  selected: string[]
  colors: Record<string, string>
  counts: Record<string, number>
  onChange: (tags: string[]) => void
  onColor: (tag: string, color: string) => void
  expanded: boolean
  onExpanded: (open: boolean) => void
}) {
  const [search, setSearch] = useState("")
  const matching = tags.filter((tag) =>
    tag.includes(search.toLowerCase().trim())
  )
  return (
    <Collapsible.Root
      className="sidebar-tags"
      open={expanded}
      onOpenChange={onExpanded}
    >
      <Collapsible.Trigger
        className="nav-item sidebar-tags-trigger"
        title="Filter by tags"
      >
        <Tags size={17} />
        <span>Tags</span>
        <small>{selected.length || tags.length}</small>
        <ChevronDown className="tags-chevron" size={15} />
      </Collapsible.Trigger>
      <Collapsible.Content className="sidebar-tag-content">
        <div className="sidebar-tag-search">
          <Search size={14} />
          <input
            aria-label="Search tag filters"
            placeholder="Find tags…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {selected.length > 0 && (
            <button aria-label="Clear tag filters" onClick={() => onChange([])}>
              <X size={14} />
            </button>
          )}
        </div>
        <div
          className="sidebar-tag-options"
          role="group"
          aria-label="Filter media by any selected tag"
        >
          {matching.map((tag) => (
            <div className="sidebar-tag-option" key={tag}>
              <label className="sidebar-tag-check">
                <input
                  type="checkbox"
                  checked={selected.includes(tag)}
                  onChange={() =>
                    onChange(
                      selected.includes(tag)
                        ? selected.filter((value) => value !== tag)
                        : [...selected, tag]
                    )
                  }
                />
                <span title={tag}>{tag}</span>
                <small>{counts[tag] ?? 0}</small>
              </label>
              <input
                className="sidebar-tag-color"
                type="color"
                aria-label={`Color for ${tag}`}
                title={`Change ${tag} color`}
                value={colors[tag] ?? "#7dd3fc"}
                onChange={(event) => onColor(tag, event.target.value)}
              />
            </div>
          ))}
          {!matching.length && (
            <p>{tags.length ? "No matching tags." : "No tags yet."}</p>
          )}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  )
}
