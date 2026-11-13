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
  type ReactNode,
  type Ref,
} from "react"
import {
  FlexRender,
  Subscribe,
  type OnChangeFn,
  type Row,
  type RowSelectionState,
  type SortingState,
  type Table,
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
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip"
import { Thumbnail } from "./thumbnail"
import { bytes } from "@/lib/utils"
import { TagPopover } from "./tag-popover"
import { mediaDate } from "@/lib/media-date"
import {
  createAppColumnHelper,
  filterMediaBySearch,
  mediaTableFeatures,
  selectNoTableState,
  sortingKey,
  useAppTable,
  type MediaTableMeta,
} from "@/lib/data-table"
import {
  applySelectionClick,
  hasModifier,
  modifiersOf,
  type SelectionAnchor,
  type SelectionModifiers,
} from "@/lib/range-selection"
import type { Media, MediaSet } from "@/lib/types"

const emptySelection: RowSelectionState = {}

type MediaRow = Row<typeof mediaTableFeatures, Media>
// The table that cells and rows receive. It keeps one identity for the life of
// the component that owns the table, unlike the table `useMediaTable` returns.
type MediaCoreTable = Table<typeof mediaTableFeatures, Media>
export type MediaTable = ReturnType<typeof useMediaTable>

// Select an item in the order the table displays, with the file-explorer
// modifiers in `modifiers`.
export function selectMedia(
  table: MediaCoreTable | MediaTable,
  id: string,
  modifiers: SelectionModifiers
) {
  table.options.meta!.select(id, modifiers, () =>
    table.getRowModel().rows.map((row) => row.id)
  )
}

// Shift-click would otherwise start a text selection across the rows.
export function keepTextUnselected(event: React.MouseEvent) {
  if (event.shiftKey && !(event.target as HTMLElement).closest("input"))
    event.preventDefault()
}

const columnHelper = createAppColumnHelper<Media>()
const mediaColumns = columnHelper.columns([
  columnHelper.display({
    id: "select",
    enableSorting: false,
    header: ({ table }) => <SelectAllCheckbox table={table} />,
    cell: ({ row, table }) => (
      <MediaCheckbox
        table={table}
        id={row.id}
        label={`Select ${row.original.display_name}`}
        checked={row.getIsSelected()}
      />
    ),
  }),
  columnHelper.accessor("display_name", {
    header: "Name",
    sortFn: "alphanumeric",
    cell: ({ row, table }) => (
      <MediaName
        table={table}
        id={row.original.id}
        name={row.original.display_name}
        rawName={row.original.raw_name}
        copyCount={row.original.copy_count}
        video={row.original.mime_type.startsWith("video/")}
        selectionMode={table.options.meta!.selectionMode}
        selected={row.getIsSelected()}
      />
    ),
  }),
  columnHelper.accessor("tags", {
    header: "Tags",
    enableSorting: false,
    cell: ({ row, table }) => (
      <MediaTags
        media={row.original}
        allTags={table.options.meta!.allTags}
        colors={table.options.meta!.tagColors}
        compact
      />
    ),
  }),
  columnHelper.display({
    id: "sets",
    header: "Sets",
    enableSorting: false,
    cell: ({ row, table }) => (
      <MediaSets media={row.original} sets={table.options.meta!.sets} compact />
    ),
  }),
  columnHelper.accessor("uploaded_at", {
    header: "Uploaded",
    sortFn: "alphanumeric",
    cell: ({ row }) => <UploadedDate value={row.original.uploaded_at} />,
  }),
  columnHelper.accessor("size", {
    header: "Size",
    sortFn: "basic",
    cell: ({ row }) => <FileSize size={row.original.size} />,
  }),
  columnHelper.display({
    id: "actions",
    header: "",
    enableSorting: false,
    cell: ({ row, table }) => (
      <MediaActions media={row.original} sets={table.options.meta!.sets} />
    ),
  }),
])

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
  // The anchor for range selection lives with the selection, so a scope
  // change resets both at once. Updaters read the scope from the state they
  // are given, which the render-phase reset below keeps current, so the
  // callbacks keep one identity and the cards that receive them do not render.
  const [selection, setSelection] = useState<{
    scope: string
    rows: RowSelectionState
    anchor: SelectionAnchor | null
  }>({ scope, rows: emptySelection, anchor: null })
  const rowSelection =
    selection.scope === scope ? selection.rows : emptySelection
  if (selection.scope !== scope)
    setSelection({ scope, rows: emptySelection, anchor: null })
  // Whole-table changes (select all, clear) leave no anchor.
  const setRowSelection = useCallback<OnChangeFn<RowSelectionState>>(
    (update) =>
      setSelection((current) => ({
        scope: current.scope,
        rows: typeof update === "function" ? update(current.rows) : update,
        anchor: null,
      })),
    []
  )
  const select = useCallback<MediaTableMeta["select"]>(
    (id, modifiers, orderedIds) =>
      setSelection((current) => ({
        scope: current.scope,
        ...applySelectionClick({
          ids: modifiers.range ? orderedIds() : [],
          anchor: current.anchor,
          target: id,
          selection: current.rows,
          modifiers,
        }),
      })),
    []
  )
  const data = useMemo(
    () => filterMediaBySearch(items, search),
    [items, search]
  )
  return useAppTable(
    {
      data,
      columns: mediaColumns,
      meta: {
        previewIntent,
        onOpen,
        allTags,
        tagColors,
        sets,
        selectionMode,
        select,
      },
      state: { sorting, rowSelection },
      onRowSelectionChange: setRowSelection,
      enableRowSelection: true,
      onSortingChange,
      getRowId: (row) => row.id,
      enableSortingRemoval: false,
    },
    selectNoTableState
  )
}

// The stage around the catalog: the table owner does not render when the
// selection changes, so this reads it for the `data-has-selection` marker.
export function MediaStage({
  table,
  selectionMode,
  children,
}: {
  table: MediaTable
  selectionMode: boolean
  children: ReactNode
}) {
  return (
    <Subscribe
      source={table.atoms.rowSelection}
      selector={(selection) => Object.keys(selection).length > 0}
    >
      {(hasSelection) => (
        <div
          className="media-stage"
          data-selecting={selectionMode || undefined}
          data-has-selection={hasSelection || undefined}
        >
          {children}
        </div>
      )}
    </Subscribe>
  )
}

// Kiln's table structure: shared column tracks, fixed header, and a measured virtual body.
export function DataTable({
  table,
  resetKey,
}: {
  table: MediaTable
  resetKey: string
}) {
  return (
    <Subscribe source={table.atoms.sorting} selector={sortingKey}>
      {(sorting) => (
        <DataTableView table={table} resetKey={resetKey} sorting={sorting} />
      )}
    </Subscribe>
  )
}

function DataTableView({
  table,
  resetKey,
  sorting,
}: {
  table: MediaTable
  resetKey: string
  sorting: string
}) {
  const mobile = useMobile()
  const meta = table.options.meta!
  const selectionMode = meta.selectionMode
  const body = useRef<HTMLTableSectionElement>(null)
  const [scrollbar, setScrollbar] = useState(0)
  const rows = table.getRowModel().rows
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
    <div className="data-table-frame">
      <table
        className={`data-table ${mobile ? "mobile-media-table" : ""}`}
        aria-label="Media"
        aria-rowcount={rows.length + 1}
      >
        <thead style={{ paddingInlineEnd: scrollbar }}>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => (
                <TableHeaderCell
                  key={header.id}
                  table={table}
                  header={header}
                />
              ))}
            </tr>
          ))}
        </thead>
        <tbody ref={bodyRef} tabIndex={0} aria-label="Scrollable media rows">
          <TableSpacer
            table={table}
            height={virtual.getTotalSize()}
            columns={table.getAllLeafColumns().length}
          />
          {virtual.getVirtualItems().map((item) => {
            const row = rows[item.index]
            return (
              <MediaTableRowBoundary
                key={row.id}
                row={row}
                meta={meta}
                mobile={mobile}
                selectionMode={selectionMode}
                index={item.index}
                start={item.start}
                measureElement={virtual.measureElement}
              />
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

type MediaHeader = ReturnType<
  MediaTable["getHeaderGroups"]
>[number]["headers"][number]

// Only the sort indicator reads the sorting atom, so a sort change redraws the
// three sortable headers and nothing else. Headers keep their identity across
// table renders, so a selection or data change does not touch them.
const TableHeaderCell = memo(
  function TableHeaderCell({
    table,
    header,
  }: {
    table: MediaTable
    header: MediaHeader
  }) {
    if (!header.column.getCanSort())
      return (
        <th scope="col">
          <FlexRender header={header} />
        </th>
      )
    return (
      <Subscribe
        source={table.atoms.sorting}
        selector={() => header.column.getIsSorted()}
      >
        {(sorted) => {
          const Icon =
            sorted === "asc"
              ? ArrowUp
              : sorted === "desc"
                ? ArrowDown
                : ArrowUpDown
          return (
            <th
              scope="col"
              aria-sort={
                sorted === "asc"
                  ? "ascending"
                  : sorted === "desc"
                    ? "descending"
                    : undefined
              }
            >
              <button onClick={header.column.getToggleSortingHandler()}>
                <FlexRender header={header} />
                <Icon size={14} />
              </button>
            </th>
          )
        }}
      </Subscribe>
    )
  },
  (previous, next) =>
    previous.header.id === next.header.id &&
    previous.header.column.columnDef === next.header.column.columnDef
)

// The bulk-action bar covers the last rows, so the scroll area keeps room
// for it while anything is selected.
function TableSpacer({
  table,
  height,
  columns,
}: {
  table: MediaTable
  height: number
  columns: number
}) {
  return (
    <Subscribe
      source={table.atoms.rowSelection}
      selector={(selection) => Object.keys(selection).length > 0}
    >
      {(hasSelection) => (
        <tr
          aria-hidden="true"
          className="table-spacer"
          style={{ height: height + (hasSelection ? 88 : 0) }}
        >
          <td colSpan={columns} />
        </tr>
      )}
    </Subscribe>
  )
}

type MediaRowProps = {
  row: MediaRow
  meta: MediaTableMeta
  mobile: boolean
  selectionMode: boolean
  index: number
  start: number
  measureElement: Ref<HTMLTableRowElement>
}

// A row subscribes to its own entry in the selection, so toggling one row
// renders that row and no other.
const MediaTableRowBoundary = memo(
  function MediaTableRowBoundary(props: MediaRowProps) {
    const { row } = props
    return (
      <Subscribe
        source={row.table.atoms.rowSelection}
        selector={(selection) => Boolean(selection[row.id])}
      >
        {(selected) => <MediaTableRow {...props} selected={selected} />}
      </Subscribe>
    )
  },
  (previous, next) => sameRowProps(previous, next)
)

// TanStack rebuilds Row wrappers when data changes. Compare their original
// records and explicit presentation state so unrelated rows remain untouched.
function sameRowProps(previous: MediaRowProps, next: MediaRowProps) {
  return (
    previous.row.original === next.row.original &&
    previous.mobile === next.mobile &&
    previous.selectionMode === next.selectionMode &&
    previous.index === next.index &&
    previous.start === next.start &&
    previous.measureElement === next.measureElement &&
    sameStrings(previous.meta.allTags, next.meta.allTags) &&
    previous.meta.tagColors === next.meta.tagColors &&
    previous.meta.sets === next.meta.sets
  )
}

const MediaTableRow = memo(
  function MediaTableRow({
    row,
    meta,
    mobile,
    selectionMode,
    selected,
    index,
    start,
    measureElement,
  }: MediaRowProps & { selected: boolean }) {
    return (
      <tr
        key={row.id}
        data-index={index}
        onMouseDown={keepTextUnselected}
        onClick={(event) => {
          const modifiers = modifiersOf(event)
          if (
            (selectionMode || hasModifier(modifiers)) &&
            !(event.target as HTMLElement).closest(
              "button, a, input, [role=dialog]"
            )
          )
            selectMedia(row.table, row.id, modifiers)
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
                table={row.table}
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
              <MobileMetadata media={row.original} meta={meta} kind="tags" />
              <MobileMetadata media={row.original} meta={meta} kind="sets" />
              <MediaActions media={row.original} sets={meta.sets} mobile />
            </td>
          </>
        ) : (
          row.getAllCells().map((cell) => (
            <td key={cell.id}>
              <FlexRender cell={cell} />
            </td>
          ))
        )}
      </tr>
    )
  },
  (previous, next) =>
    sameRowProps(previous, next) && previous.selected === next.selected
)

const MediaCheckbox = memo(function MediaCheckbox({
  table,
  id,
  label,
  checked,
}: {
  table: MediaCoreTable
  id: string
  label: string
  checked: boolean
}) {
  return (
    <SelectionCheckbox
      label={label}
      checked={checked}
      onClick={(event) => selectMedia(table, id, modifiersOf(event))}
    />
  )
})

// Everything the table currently holds is selected, some of it, or none.
function SelectAllCheckbox({ table }: { table: MediaCoreTable }) {
  return (
    <Subscribe
      source={table.atoms.rowSelection}
      selector={() => {
        const all = table.getIsAllRowsSelected()
        return all ? "all" : table.getIsSomeRowsSelected() ? "some" : "none"
      }}
    >
      {(state) => (
        <SelectionCheckbox
          label="Select all matching media"
          checked={state === "all"}
          mixed={state === "some"}
          onChange={table.getToggleAllRowsSelectedHandler()}
        />
      )}
    </Subscribe>
  )
}

const noop = () => {}

function SelectionCheckbox({
  label,
  checked,
  mixed = false,
  onChange,
  onClick,
}: {
  label: string
  checked: boolean
  mixed?: boolean
  onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void
  // For checkboxes that need the click's modifier keys.
  onClick?: (event: React.MouseEvent<HTMLInputElement>) => void
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
      onChange={onChange ?? noop}
      onClick={onClick}
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
  table: MediaCoreTable
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
    return media && table.options.meta!.previewIntent(media)
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
      onClick={(event) => {
        const row = table.getCoreRowModel().rowsById[id]
        if (!row) return
        const modifiers = modifiersOf(event)
        if (selectionMode || hasModifier(modifiers))
          selectMedia(table, id, modifiers)
        else table.options.meta!.onOpen(row.original)
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
  table: MediaTable
  allTags: string[]
}) {
  return (
    <Subscribe source={table.atoms.rowSelection}>
      {() => {
        const mediaItems = table
          .getFilteredSelectedRowModel()
          .rows.map((row) => row.original)
        if (!mediaItems.length) return null
        const selected = mediaItems.map((media) => media.id)
        return (
          <div
            className="media-selection-overlay"
            role="toolbar"
            aria-label="Selected media actions"
          >
            <span aria-live="polite">{selected.length} selected</span>
            <TagPopover
              ids={selected}
              mediaItems={mediaItems}
              allTags={allTags}
              label="Add tags to selected media"
              bulk
            />
            <MediaSets
              mediaItems={mediaItems}
              sets={table.options.meta!.sets}
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
      }}
    </Subscribe>
  )
}
