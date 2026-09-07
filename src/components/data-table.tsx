import { useMediaPreviewIntent } from "@/lib/media-preview"
import { formatNameList } from "@/lib/name-list"
import { useMobile } from "@/hooks/use-mobile"
import { ChipOverflow } from "./chip-overflow"
import { MediaSets } from "./media-sets"
import { tagStyle } from "@/lib/tag-colors"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu"
import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
} from "react"
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
  type Row,
} from "@tanstack/react-table"
import {
  observeElementRect,
  useVirtualizer,
  type VirtualizerOptions,
} from "@tanstack/react-virtual"
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

const emptySelection: RowSelectionState = {}

export function useMediaTable(
  items: Media[],
  search: string,
  sorting: SortingState,
  onSortingChange: OnChangeFn<SortingState>,
  onOpen: (media: Media) => void,
  allTags: string[],
  tagColors: Record<string, string>,
  sets: MediaSet[],
  selectionMode: boolean
) {
  const previewIntent = useMediaPreviewIntent()
  const itemIds = useMemo(() => items.map((item) => item.id).join(","), [items])
  const scope = `${itemIds}:${search}`
  const [selection, setSelection] = useState({
    scope,
    rows: emptySelection,
  })
  const rowSelection =
    selection.scope === scope ? selection.rows : emptySelection
  if (selection.scope !== scope && Object.keys(selection.rows).length)
    setSelection({ scope, rows: emptySelection })
  const setRowSelection: OnChangeFn<RowSelectionState> = (update) =>
    setSelection((current) => {
      const rows = current.scope === scope ? current.rows : emptySelection
      return {
        scope,
        rows: typeof update === "function" ? update(rows) : update,
      }
    })
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
        cell: ({ row, table }) => (
          <MediaCheckbox
            table={table}
            id={row.id}
            label={`Select ${row.original.display_name}`}
            checked={row.getIsSelected()}
          />
        ),
      },
      {
        accessorKey: "display_name",
        header: "Name",
        cell: ({ row, table }) => (
          <MediaName
            table={table}
            id={row.original.id}
            name={row.original.display_name}
            rawName={row.original.raw_name}
            copyCount={row.original.copy_count}
            video={row.original.mime_type.startsWith("video/")}
            selectionMode={(table.options.meta as MediaTableMeta).selectionMode}
            selected={row.getIsSelected()}
          />
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
            compact
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
            compact
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
        cell: ({ row }) => <FileSize size={row.original.size} />,
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        enableGlobalFilter: false,
        cell: ({ row, table }) => (
          <MediaActions
            media={row.original}
            sets={(table.options.meta as MediaTableMeta).sets}
          />
        ),
      },
    ],
    []
  )
  return useReactTable({
    data: items,
    meta: {
      previewIntent,
      onOpen,
      allTags,
      tagColors,
      sets,
      selectionMode,
    } satisfies MediaTableMeta,
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
    autoResetPageIndex: false,
    enableSortingRemoval: false,
  })
}

// Kiln's table structure: shared column tracks, fixed header, and a measured virtual body.
export function DataTable({
  table,
  resetKey,
}: {
  table: Table<Media>
  resetKey: string
}) {
  const mobile = useMobile()
  const selectionMode = (table.options.meta as MediaTableMeta).selectionMode
  const body = useRef<HTMLTableSectionElement>(null)
  const [scrollbar, setScrollbar] = useState(0)
  const rows = table.getRowModel().rows
  const selected = table
    .getFilteredSelectedRowModel()
    .rows.map((row) => row.original.id)
  const sorting = JSON.stringify(table.getState().sorting)
  const bodyRef = useCallback(
    (element: HTMLTableSectionElement | null) => {
      body.current = element
      if (element) element.scrollTop = 0
    },
    [resetKey, sorting]
  )
  const observeRect = useCallback<
    VirtualizerOptions<
      HTMLTableSectionElement,
      HTMLTableRowElement
    >["observeElementRect"]
  >(
    (instance, notify) =>
      observeElementRect(instance, (rect) => {
        const element = instance.scrollElement
        if (element) setScrollbar(element.offsetWidth - element.clientWidth)
        notify(rect)
      }),
    []
  )
  const virtual = useVirtualizer({
    // Render the first screen during SSR, then measure the real scroll area.
    initialRect: { width: 0, height: 720 },
    count: rows.length,
    getScrollElement: () => body.current,
    observeElementRect: observeRect,
    estimateSize: () => (mobile ? 76 : 96),
    getItemKey: (index) => rows[index].id,
    overscan: 8,
  })
  return (
    <TooltipProvider>
      <div className="data-table-frame">
        <table
          className={`data-table ${mobile ? "mobile-media-table" : ""}`}
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
          <tbody ref={bodyRef} tabIndex={0} aria-label="Scrollable media rows">
            <tr
              aria-hidden="true"
              className="table-spacer"
              style={{
                height: virtual.getTotalSize() + (selected.length ? 88 : 0),
              }}
            >
              <td colSpan={table.getVisibleLeafColumns().length} />
            </tr>
            {virtual.getVirtualItems().map((item) => {
              const row = rows[item.index]
              return (
                <MediaTableRow
                  key={row.id}
                  row={row}
                  table={table}
                  meta={table.options.meta as MediaTableMeta}
                  mobile={mobile}
                  selectionMode={selectionMode}
                  selected={row.getIsSelected()}
                  index={item.index}
                  start={item.start}
                  measureElement={virtual.measureElement}
                />
              )
            })}
          </tbody>
        </table>
      </div>
    </TooltipProvider>
  )
}

// TanStack v8 rebuilds Row wrappers when data changes. Compare their original
// records and explicit presentation state so unrelated rows remain untouched.
const MediaTableRow = memo(
  function MediaTableRow({
    row,
    table,
    mobile,
    selectionMode,
    selected,
    index,
    start,
    measureElement,
  }: {
    row: Row<Media>
    table: Table<Media>
    meta: MediaTableMeta
    mobile: boolean
    selectionMode: boolean
    selected: boolean
    index: number
    start: number
    measureElement: Ref<HTMLTableRowElement>
  }) {
    return (
      <tr
        key={row.id}
        data-index={index}
        onClick={(event) => {
          if (
            selectionMode &&
            !(event.target as HTMLElement).closest(
              "button, a, input, [role=dialog]"
            )
          )
            row.toggleSelected()
        }}
        aria-selected={selected}
        data-selected={selected || undefined}
        ref={measureElement}
        aria-rowindex={index + 2}
        style={{ transform: `translateY(${start}px)` }}
      >
        {mobile ? (
          <>
            <td className="mobile-media-main">
              <MediaName
                table={table}
                id={row.original.id}
                name={row.original.display_name}
                video={row.original.mime_type.startsWith("video/")}
                selectionMode={selectionMode}
                selected={selected}
                mobile
                uploadedAt={row.original.uploaded_at}
                size={row.original.size}
              />
            </td>
            <td className="mobile-media-actions">
              <MobileMetadata
                media={row.original}
                meta={table.options.meta as MediaTableMeta}
                kind="tags"
              />
              <MobileMetadata
                media={row.original}
                meta={table.options.meta as MediaTableMeta}
                kind="sets"
              />
              <MediaActions
                media={row.original}
                sets={(table.options.meta as MediaTableMeta).sets}
                mobile
              />
            </td>
          </>
        ) : (
          row
            .getVisibleCells()
            .map((cell) => (
              <td key={cell.id}>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </td>
            ))
        )}
      </tr>
    )
  },
  (previous, next) =>
    previous.row.original === next.row.original &&
    previous.table === next.table &&
    previous.mobile === next.mobile &&
    previous.selectionMode === next.selectionMode &&
    previous.selected === next.selected &&
    previous.index === next.index &&
    previous.start === next.start &&
    previous.measureElement === next.measureElement &&
    sameStrings(previous.meta.allTags, next.meta.allTags) &&
    previous.meta.tagColors === next.meta.tagColors &&
    previous.meta.sets === next.meta.sets
)

const MediaCheckbox = memo(function MediaCheckbox({
  table,
  id,
  label,
  checked,
}: {
  table: Table<Media>
  id: string
  label: string
  checked: boolean
}) {
  return (
    <SelectionCheckbox
      label={label}
      checked={checked}
      onChange={() => table.getRow(id).toggleSelected()}
    />
  )
})

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
  return (
    <input
      ref={(input) => {
        if (input) input.indeterminate = mixed && !checked
      }}
      className="row-checkbox"
      type="checkbox"
      aria-label={label}
      checked={checked}
      onChange={onChange}
    />
  )
}
let currentMinute = Date.now()
let dateTimer: ReturnType<typeof setInterval> | undefined
const dateListeners = new Set<() => void>()
const subscribeDate = (listener: () => void) => {
  dateListeners.add(listener)
  if (!dateTimer) {
    currentMinute = Date.now()
    dateTimer = setInterval(() => {
      currentMinute = Date.now()
      for (const notify of dateListeners) notify()
    }, 60_000)
  }
  return () => {
    dateListeners.delete(listener)
    if (!dateListeners.size) {
      clearInterval(dateTimer)
      dateTimer = undefined
    }
  }
}
const dateSnapshot = () => currentMinute
const serverDateSnapshot = () => null

const UploadedDate = memo(function UploadedDate({ value }: { value: string }) {
  const now = useSyncExternalStore(
    subscribeDate,
    dateSnapshot,
    serverDateSnapshot
  )
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
})

const FileSize = memo(function FileSize({ size }: { size: number }) {
  return <span className="table-file-size">{bytes(size)}</span>
})

const MediaName = memo(function MediaName({
  table,
  id,
  name,
  rawName,
  copyCount,
  video,
  selectionMode,
  selected,
  mobile = false,
  uploadedAt,
  size,
}: {
  table: Table<Media>
  id: string
  name: string
  rawName?: string
  copyCount?: number
  video: boolean
  selectionMode: boolean
  selected: boolean
  mobile?: boolean
  uploadedAt?: string
  size?: number
}) {
  // Resolve the current row at the event boundary: tag edits need not render
  // this cell, and opening/prefetching still sees the latest catalog metadata.
  const intent = () => {
    const media = table.getCoreRowModel().rowsById[id]?.original
    return media && (table.options.meta as MediaTableMeta).previewIntent(media)
  }
  return (
    <button
      className={mobile ? "mobile-media-open" : "table-name"}
      aria-pressed={selectionMode ? selected : undefined}
      {...(!selectionMode
        ? {
            onPointerEnter: (event: React.PointerEvent) =>
              intent()?.onPointerEnter(event),
            onPointerLeave: () => intent()?.onPointerLeave(),
            onFocus: () => intent()?.onFocus(),
            onBlur: () => intent()?.onBlur(),
          }
        : {})}
      onClick={() => {
        const row = table.getCoreRowModel().rowsById[id]
        if (!row) return
        if (selectionMode) row.toggleSelected()
        else (table.options.meta as MediaTableMeta).onOpen(row.original)
      }}
    >
      <div className="table-thumbnail">
        <Thumbnail id={id} name="" eager video={video} />
      </div>
      {mobile ? (
        <span className="mobile-media-copy">
          <strong>{name}</strong>
          <span>
            <UploadedDate value={uploadedAt!} /> · <FileSize size={size!} />
          </span>
        </span>
      ) : (
        <div>
          <strong>{name}</strong>
          <small>
            <span className="raw-filename">
              {rawName}
              {copyCount! > 1 && ` · ${copyCount} copies`}
            </span>
          </small>
        </div>
      )}
    </button>
  )
})

type MediaTableMeta = {
  previewIntent: ReturnType<typeof useMediaPreviewIntent>
  onOpen: (media: Media) => void
  allTags: string[]
  tagColors: Record<string, string>
  sets: MediaSet[]
  selectionMode: boolean
}
export const MediaTags = memo(
  function MediaTags({
    media,
    allTags,
    colors,
    compact = false,
  }: {
    media: Media
    allTags: string[]
    colors: Record<string, string>
    compact?: boolean
  }) {
    const client = useQueryClient()
    const remove = useMutation({
      mutationFn: (tag: string) => action("remove-tag", { id: media.id, tag }),
      onSuccess: () => client.invalidateQueries({ queryKey: ["library"] }),
      onError: (error) => toast.error(error.message),
    })
    const chips = media.tags.map((tag) => (
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
    return (
      <div className="table-tags">
        <TagPopover
          media={media}
          ids={[media.id]}
          existing={media.tags}
          allTags={allTags}
          label={`Add tags to ${media.display_name}`}
        />
        <div className="tag-chips">
          {media.tags.length ? (
            compact ? (
              <ChipOverflow label="tags">{chips}</ChipOverflow>
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
    previous.compact === next.compact &&
    previous.media.id === next.media.id &&
    previous.media.display_name === next.media.display_name &&
    previous.media.mime_type === next.media.mime_type &&
    previous.media.tags === next.media.tags &&
    sameStrings(previous.allTags, next.allTags) &&
    previous.media.tags.every(
      (tag) => previous.colors[tag] === next.colors[tag]
    )
)

function sameStrings(previous: string[], next: string[]) {
  return (
    previous === next ||
    (previous.length === next.length &&
      previous.every((value, index) => value === next[index]))
  )
}

const MediaActions = memo(function MediaActions({
  media,
  sets,
  mobile = false,
}: {
  media: Media
  sets: MediaSet[]
  mobile?: boolean
}) {
  const copy = (value: string) =>
    (
      navigator.clipboard?.writeText(value) ??
      Promise.reject(new Error("Clipboard unavailable"))
    ).then(
      () => toast.success("Copied to clipboard"),
      () => toast.error("Could not copy. Check clipboard permissions.")
    )
  return (
    <div className="media-row-actions">
      {!mobile && (
        <a
          href={`https://drive.google.com/file/d/${media.drive_id}/view`}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${media.display_name} in Drive`}
          title="Open in Drive"
        >
          <ArrowUpRight size={16} />
        </a>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          className="icon-button"
          aria-label={`Actions for ${media.display_name}`}
        >
          <MoreHorizontal size={17} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {mobile && (
            <>
              <DropdownMenuItem asChild>
                <a
                  href={`https://drive.google.com/file/d/${media.drive_id}/view`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open in Drive
                </a>
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuItem onSelect={() => void copy(media.raw_name)}>
            Copy file name
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!media.tags.length}
            onSelect={() => void copy(formatNameList(media.tags))}
          >
            Copy tags
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!media.set_ids.length}
            onSelect={() =>
              void copy(
                formatNameList(
                  sets
                    .filter((set) => media.set_ids.includes(set.id))
                    .map((set) => set.display_name)
                )
              )
            }
          >
            Copy sets
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
})

function MobileMetadata({
  media,
  meta,
  kind,
}: {
  media: Media
  meta: MediaTableMeta
  kind: "tags" | "sets"
}) {
  return kind === "tags" ? (
    <TagPopover
      media={media}
      ids={[media.id]}
      existing={media.tags}
      allTags={meta.allTags}
      label={`Manage tags for ${media.display_name}`}
      iconOnly
    />
  ) : (
    <MediaSets media={media} sets={meta.sets} iconOnly />
  )
}

export function MediaSelectionActions({
  table,
  allTags,
}: {
  table: Table<Media>
  allTags: string[]
}) {
  const selected = table
    .getFilteredSelectedRowModel()
    .rows.map((row) => row.original.id)
  if (!selected.length) return null
  return (
    <div
      className="media-selection-overlay"
      role="toolbar"
      aria-label="Selected media actions"
    >
      <span aria-live="polite">{selected.length} selected</span>
      <TagPopover
        ids={selected}
        mediaItems={table
          .getFilteredSelectedRowModel()
          .rows.map((row) => row.original)}
        allTags={allTags}
        label="Add tags to selected media"
        bulk
      />
      <MediaSets
        mediaItems={table
          .getFilteredSelectedRowModel()
          .rows.map((row) => row.original)}
        sets={(table.options.meta as MediaTableMeta).sets}
        bulk
      />
      <button
        className="icon-button"
        aria-label="Clear selection"
        onClick={() => table.resetRowSelection()}
      >
        <X size={16} />
      </button>
    </div>
  )
}
