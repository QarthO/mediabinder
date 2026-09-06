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
} from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react"
import { Thumbnail } from "./thumbnail"
import { bytes, dateValue } from "@/lib/utils"
import type { Media } from "@/lib/types"

export function useMediaTable(
  items: Media[],
  search: string,
  sorting: SortingState,
  onSortingChange: OnChangeFn<SortingState>,
  onOpen: (media: Media) => void
) {
  const columns = useMemo<ColumnDef<Media>[]>(
    () => [
      {
        accessorKey: "display_name",
        header: "Name",
        cell: ({ row }) => (
          <button className="table-name" onClick={() => onOpen(row.original)}>
            <div className="table-thumbnail">
              <Thumbnail
                id={row.original.id}
                name=""
                video={row.original.mime_type.startsWith("video/")}
              />
            </div>
            <div>
              <strong>{row.original.display_name}</strong>
              <small>{row.original.raw_name}</small>
            </div>
          </button>
        ),
      },
      {
        accessorKey: "tags",
        header: "Tags",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="tags">
            {row.original.tags.slice(0, 2).map((tag) => (
              <span className="tag" key={tag}>
                {tag}
              </span>
            ))}
            {row.original.tags.length > 2 && (
              <span>+{row.original.tags.length - 2}</span>
            )}
          </div>
        ),
      },
      {
        accessorKey: "uploaded_at",
        header: "Uploaded",
        cell: ({ row }) => dateValue(row.original.uploaded_at),
      },
      {
        accessorKey: "size",
        header: "Size",
        cell: ({ row }) => bytes(row.original.size),
      },
      { accessorKey: "post_count", header: "Posts" },
    ],
    [onOpen]
  )
  return useReactTable({
    data: items,
    columns,
    state: { globalFilter: search, sorting },
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
export function DataTable<T>({
  table,
  resetKey,
}: {
  table: Table<T>
  resetKey: string
}) {
  const body = useRef<HTMLTableSectionElement>(null)
  const [scrollbar, setScrollbar] = useState(0)
  const rows = table.getRowModel().rows
  const sorting = JSON.stringify(table.getState().sorting)
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => body.current,
    estimateSize: () => 76,
    getItemKey: (index) => rows[index].id,
    overscan: 6,
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
                      <button onClick={header.column.getToggleSortingHandler()}>
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
                ref={virtual.measureElement}
                aria-rowindex={item.index + 2}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="table-footer">
        {rows.length} {rows.length === 1 ? "item" : "items"}
        <span>Click a column heading to sort</span>
      </div>
    </div>
  )
}
