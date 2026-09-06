import { MediaSets } from "./media-sets"
import { tagStyle } from "@/lib/tag-colors"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu"
import { useEffect, useMemo, useRef, useState } from "react"
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type OnChangeFn,
  type SortingState,
  type Table,
  type RowSelectionState,
} from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  X,
  ArrowUpRight,
  MoreHorizontal,
} from "lucide-react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { action } from "@/lib/api"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip"
import { Thumbnail } from "./thumbnail"
import { bytes } from "@/lib/utils"
import { TagPopover } from "./tag-popover"
import { mediaDate } from "@/lib/media-date"
import type { Media, MediaSet } from "@/lib/types"

export function useMediaTable(
  items: Media[],
  search: string,
  sorting: SortingState,
  onSortingChange: OnChangeFn<SortingState>,
  onOpen: (media: Media) => void,
  allTags: string[],
  tagColors: Record<string, string>,
  sets: MediaSet[]
) {
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const itemIds = items.map((item) => item.id).join(",")
  useEffect(() => setRowSelection({}), [itemIds, search])
  const columns = useMemo<ColumnDef<Media>[]>(
    () => [
      {
        id: "select",
        enableSorting: false,
        enableGlobalFilter: false,
        header: ({ table }) => (
          <SelectionCheckbox
            label="Select all matching media"
            checked={table.getIsAllRowsSelected()}
            mixed={table.getIsSomeRowsSelected()}
            onChange={table.getToggleAllRowsSelectedHandler()}
          />
        ),
        cell: ({ row }) => (
          <SelectionCheckbox
            label={`Select ${row.original.display_name}`}
            checked={row.getIsSelected()}
            onChange={row.getToggleSelectedHandler()}
          />
        ),
      },
      {
        accessorKey: "display_name",
        header: "Name",
        cell: ({ row, table }) => (
          <button
            className="table-name"
            onClick={() =>
              (table.options.meta as MediaTableMeta).onOpen(row.original)
            }
          >
            <div className="table-thumbnail">
              <Thumbnail
                id={row.original.id}
                name=""
                eager
                video={row.original.mime_type.startsWith("video/")}
              />
            </div>
            <div>
              <strong>{row.original.display_name}</strong>
              <small>
                <span className="raw-filename">{row.original.raw_name}</span>
              </small>
            </div>
          </button>
        ),
      },
      {
        accessorKey: "tags",
        header: "Tags",
        enableSorting: false,
        cell: ({ row, table }) => (
          <MediaTags
            media={row.original}
            allTags={(table.options.meta as MediaTableMeta).allTags}
            colors={(table.options.meta as MediaTableMeta).tagColors}
          />
        ),
      },
      {
        id: "sets",
        header: "Sets",
        enableSorting: false,
        enableGlobalFilter: false,
        cell: ({ row, table }) => (
          <MediaSets
            media={row.original}
            sets={(table.options.meta as MediaTableMeta).sets}
          />
        ),
      },
      {
        accessorKey: "uploaded_at",
        header: "Uploaded",
        cell: ({ row }) => <UploadedDate value={row.original.uploaded_at} />,
      },
      {
        accessorKey: "size",
        header: "Size",
        cell: ({ row }) => (
          <span className="table-file-size">{bytes(row.original.size)}</span>
        ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        enableGlobalFilter: false,
        cell: ({ row }) => <MediaActions media={row.original} />,
      },
    ],
    []
  )
  return useReactTable({
    data: items,
    meta: { onOpen, allTags, tagColors, sets } satisfies MediaTableMeta,
    columns,
    state: { globalFilter: search, sorting, rowSelection },
    onRowSelectionChange: setRowSelection,
    enableRowSelection: true,
    onSortingChange,
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    globalFilterFn: (row, _column, value: string) =>
      [
        row.original.display_name,
        row.original.raw_name,
        ...row.original.tags,
      ].some((text) => text.toLowerCase().includes(value.toLowerCase())),
    enableSortingRemoval: false,
  })
}

// Kiln's table structure: shared column tracks, fixed header, and a measured virtual body.
export function DataTable({
  table,
  resetKey,
  allTags,
}: {
  table: Table<Media>
  resetKey: string
  allTags: string[]
}) {
  const body = useRef<HTMLTableSectionElement>(null)
  const [scrollbar, setScrollbar] = useState(0)
  const rows = table.getRowModel().rows
  const selected = table
    .getFilteredSelectedRowModel()
    .rows.map((row) => row.original.id)
  const sorting = JSON.stringify(table.getState().sorting)
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => body.current,
    estimateSize: () => 84,
    getItemKey: (index) => rows[index].id,
    overscan: 8,
  })
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0
  }, [resetKey, sorting])
  useEffect(() => {
    const element = body.current
    if (!element) return
    const observer = new ResizeObserver(() =>
      setScrollbar(element.offsetWidth - element.clientWidth)
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return (
    <TooltipProvider>
      <div className="data-table-frame">
        <table
          className="data-table"
          aria-label="Media"
          aria-rowcount={rows.length + 1}
        >
          <thead style={{ paddingInlineEnd: scrollbar }}>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted()
                  const Icon =
                    sorted === "asc"
                      ? ArrowUp
                      : sorted === "desc"
                        ? ArrowDown
                        : ArrowUpDown
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={
                        sorted === "asc"
                          ? "ascending"
                          : sorted === "desc"
                            ? "descending"
                            : undefined
                      }
                    >
                      {header.column.getCanSort() ? (
                        <button
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                          <Icon size={14} />
                        </button>
                      ) : (
                        flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )
                      )}
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
          <tbody ref={body} tabIndex={0} aria-label="Scrollable media rows">
            <tr
              aria-hidden="true"
              className="table-spacer"
              style={{ height: virtual.getTotalSize() }}
            >
              <td colSpan={table.getVisibleLeafColumns().length} />
            </tr>
            {virtual.getVirtualItems().map((item) => {
              const row = rows[item.index]
              return (
                <tr
                  key={row.id}
                  data-index={item.index}
                  aria-selected={row.getIsSelected()}
                  data-selected={row.getIsSelected() || undefined}
                  ref={virtual.measureElement}
                  aria-rowindex={item.index + 2}
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="table-footer" aria-label="Table selection">
          <span aria-live="polite">
            {selected.length} of {rows.length} selected
          </span>
          {selected.length > 0 && (
            <div className="selection-actions">
              <button onClick={() => table.resetRowSelection()}>
                Clear selection
              </button>
              <TagPopover
                ids={selected}
                allTags={allTags}
                label="Add tags to selected media"
                bulk
              />
            </div>
          )}
        </div>
      </div>
    </TooltipProvider>
  )
}

function SelectionCheckbox({
  label,
  checked,
  mixed = false,
  onChange,
}: {
  label: string
  checked: boolean
  mixed?: boolean
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (input.current) input.current.indeterminate = mixed && !checked
  }, [checked, mixed])
  return (
    <input
      ref={input}
      className="row-checkbox"
      type="checkbox"
      aria-label={label}
      checked={checked}
      onChange={onChange}
    />
  )
}
function UploadedDate({ value }: { value: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const date = mediaDate(value, now)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dateTime={date.iso} tabIndex={0} aria-label={date.timestamp}>
          {date.label}
        </time>
      </TooltipTrigger>
      <TooltipContent>{date.timestamp}</TooltipContent>
    </Tooltip>
  )
}

type MediaTableMeta = {
  onOpen: (media: Media) => void
  allTags: string[]
  tagColors: Record<string, string>
  sets: MediaSet[]
}
export function MediaTags({
  media,
  allTags,
  colors,
}: {
  media: Media
  allTags: string[]
  colors: Record<string, string>
}) {
  const client = useQueryClient()
  const remove = useMutation({
    mutationFn: (tag: string) => action("remove-tag", { id: media.id, tag }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["library"] }),
    onError: (error) => toast.error(error.message),
  })
  return (
    <div className="table-tags">
      <TagPopover
        ids={[media.id]}
        existing={media.tags}
        allTags={allTags}
        label={`Add tags to ${media.display_name}`}
      />
      <div className="tag-chips">
        {media.tags.length ? (
          media.tags.map((tag) => (
            <span className="tag" style={tagStyle(colors[tag])} key={tag}>
              <span title={tag}>{tag}</span>
              <button
                type="button"
                aria-label={`Remove ${tag} tag from ${media.display_name}`}
                disabled={remove.isPending}
                onClick={() => remove.mutate(tag)}
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

function MediaActions({ media }: { media: Media }) {
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success("Copied to clipboard")
    } catch {
      toast.error("Could not copy. Check clipboard permissions.")
    }
  }
  return (
    <div className="media-row-actions">
      <a
        href={`https://drive.google.com/file/d/${media.drive_id}/view`}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${media.display_name} in Drive`}
        title="Open in Drive"
      >
        <ArrowUpRight size={16} />
      </a>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="icon-button"
          aria-label={`Actions for ${media.display_name}`}
        >
          <MoreHorizontal size={17} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void copy(media.raw_name)}>
            Copy file name
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!media.parent_ids[0] && !media.source_ids[0]}
            onSelect={() =>
              void copy(media.parent_ids[0] ?? media.source_ids[0])
            }
          >
            Copy Drive folder ID
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
