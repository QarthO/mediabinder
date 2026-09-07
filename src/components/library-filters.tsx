import { memo } from "react"
import {
  ArrowUpDown,
  Eye,
  EyeOff,
  Inbox,
  Images,
  FolderOpen,
  LayoutGrid,
  List,
} from "lucide-react"
import type { OnChangeFn, SortingState } from "@tanstack/react-table"
import type { MediaSet } from "@/lib/types"
import { Select } from "./ui/select"
import { SearchSelect } from "./ui/search-select"
import { Button } from "./ui/button"

export const LibraryFilters = memo(function LibraryFilters({
  mediaType,
  setMediaType,
  catalogStatus,
  setCatalogStatus,
  setFilter,
  setSetFilter,
  sets,
  sort,
  setSorting,
  mediaCensored,
  onToggleCensor,
  view,
  onView,
}: {
  mediaType: string
  setMediaType: (value: string) => void
  catalogStatus: string
  setCatalogStatus: (value: string) => void
  setFilter: string
  setSetFilter: (value: string) => void
  sets: MediaSet[]
  sort: string
  setSorting: OnChangeFn<SortingState>
  mediaCensored: boolean
  onToggleCensor: () => void
  view: "grid" | "list"
  onView: (value: "grid" | "list") => void
}) {
  return (
    <>
      <Select
        label="Filter by media type"
        mobileIcon={Images}
        value={mediaType}
        onChange={setMediaType}
        options={[
          { value: "all", label: "All types" },
          { value: "images", label: "Images" },
          { value: "videos", label: "Videos" },
        ]}
      />
      <Select
        label="Filter by catalog status"
        mobileIcon={Inbox}
        value={catalogStatus}
        onChange={setCatalogStatus}
        options={[
          { value: "all", label: "All content" },
          { value: "uncataloged", label: "Uncataloged" },
          { value: "cataloged", label: "Cataloged" },
        ]}
      />
      <SearchSelect
        label="Filter by set"
        mobileIcon={FolderOpen}
        value={setFilter || "all"}
        onChange={(value) => setSetFilter(value === "all" ? "" : value)}
        options={[
          { value: "all", label: "All sets" },
          ...sets.map((set) => ({
            value: set.id,
            label: set.display_name,
          })),
        ]}
      />
      <div className="toolbar-spacer" />
      <Select
        label="Sort media"
        mobileIcon={ArrowUpDown}
        value={sort}
        onChange={(value) =>
          setSorting([
            {
              id: value === "name" ? "display_name" : "uploaded_at",
              desc: value === "newest",
            },
          ])
        }
        options={[
          { value: "newest", label: "Newest first" },
          { value: "oldest", label: "Oldest first" },
          { value: "name", label: "Name A–Z" },
          ...(sort === "custom"
            ? [{ value: "custom", label: "Custom sort" }]
            : []),
        ]}
      />
      <Button
        className="thumbnail-blur-toggle"
        variant="outline"
        size="icon"
        aria-label="Censor media"
        aria-pressed={mediaCensored}
        title={mediaCensored ? "Uncensor media" : "Censor media"}
        onClick={onToggleCensor}
      >
        {mediaCensored ? <EyeOff /> : <Eye />}
      </Button>
      <div className="view-switch">
        {(["grid", "list"] as const).map((v) => (
          <button
            key={v}
            aria-label={`${v === "grid" ? "Grid" : "List"} view`}
            aria-pressed={view === v}
            className={view === v ? "selected" : ""}
            onClick={() => {
              onView(v)
            }}
          >
            {v === "grid" ? <LayoutGrid size={16} /> : <List size={17} />}
          </button>
        ))}
      </div>
    </>
  )
})
