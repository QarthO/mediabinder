import { useState } from "react"
import { Popover } from "radix-ui"
import { FolderOpen, Check, ChevronsUpDown, X, Search } from "lucide-react"
import { Input } from "./ui/input"
import type { DriveSource } from "@/lib/types"
export function FolderSelector({
  sources,
  selected,
  onChange,
  compact,
}: {
  sources: DriveSource[]
  selected: string[]
  onChange: (ids: string[]) => void
  compact: boolean
}) {
  const [query, setQuery] = useState("")
  const label = !selected.length
    ? "All Folders"
    : selected.length === 1
      ? (sources.find((source) => source.folder_id === selected[0])
          ?.folder_name ?? "Selected folder")
      : `${selected.length} folders`
  return (
    <Popover.Root>
      <Popover.Trigger
        className="folder-selector-trigger"
        aria-label="Select Drive folders"
        title={label}
      >
        <FolderOpen size={18} />
        {!compact && (
          <>
            <span>{label}</span>
            <ChevronsUpDown size={14} />
          </>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="folder-selector-popover"
          sideOffset={8}
          align="start"
          collisionPadding={12}
        >
          <div className="folder-selector-search">
            <Search size={16} />
            <Input
              aria-label="Search linked folders"
              placeholder="Search folders…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button
              aria-label="Clear folder selections"
              title="Clear folder selections"
              onClick={() => {
                onChange([])
                setQuery("")
              }}
            >
              <X size={16} />
            </button>
          </div>
          <div
            role="listbox"
            aria-label="Linked folders"
            aria-multiselectable="true"
            className="folder-selector-options"
          >
            <button
              role="option"
              aria-selected={!selected.length}
              onClick={() => onChange([])}
            >
              <FolderOpen size={17} />
              <span>
                All Folders<small>Media from every linked folder</small>
              </span>
              {!selected.length && <Check size={16} />}
            </button>
            {sources
              .filter((source) =>
                `${source.folder_name} ${source.folder_id}`
                  .toLowerCase()
                  .includes(query.toLowerCase())
              )
              .map((source) => (
                <button
                  key={source.folder_id}
                  role="option"
                  aria-selected={selected.includes(source.folder_id)}
                  onClick={() =>
                    onChange(
                      selected.includes(source.folder_id)
                        ? selected.filter((id) => id !== source.folder_id)
                        : [...selected, source.folder_id]
                    )
                  }
                >
                  <FolderOpen size={17} />
                  <span>
                    {source.folder_name}
                    <small>{source.folder_id}</small>
                  </span>
                  {selected.includes(source.folder_id) && <Check size={16} />}
                </button>
              ))}
            {!sources.length && (
              <p>Link a folder in Settings to get started.</p>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
