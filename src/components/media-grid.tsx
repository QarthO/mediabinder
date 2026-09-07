import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
} from "react"
import {
  observeElementRect,
  useVirtualizer,
  type VirtualizerOptions,
} from "@tanstack/react-virtual"
import { MediaCard } from "./media-card"
import type { Media } from "@/lib/types"

const INITIAL_LAYOUT = {
  width: 1100,
  columns: 4,
  columnGap: 17,
  rowGap: 20,
  measured: false,
}

export function MediaGrid({
  items,
  selection,
  ...cardProps
}: Omit<ComponentProps<typeof MediaCard>, "media" | "selected" | "style"> & {
  items: Media[]
  selection: Record<string, boolean>
}) {
  const scroll = useRef<HTMLDivElement>(null)
  // A bounded, identical server/client first render. TanStack's existing size
  // subscription supplies the actual viewport after hydration.
  const [layout, setLayout] = useState(INITIAL_LAYOUT)
  const observeRect = useCallback<
    VirtualizerOptions<HTMLDivElement, HTMLDivElement>["observeElementRect"]
  >(
    (instance, callback) =>
      observeElementRect(instance, (rect) => {
        const width = instance.scrollElement?.clientWidth || rect.width
        const viewport = instance.targetWindow?.innerWidth ?? width
        const columnGap = viewport <= 760 ? 12 : 17
        const rowGap = viewport <= 760 ? 12 : 20
        const minimum = viewport >= 1500 ? 240 : viewport <= 1100 ? 180 : 205
        const columns =
          viewport <= 420
            ? 1
            : viewport <= 760
              ? 2
              : Math.max(
                  1,
                  Math.floor((width + columnGap) / (minimum + columnGap))
                )
        setLayout((previous) =>
          previous.measured &&
          previous.width === width &&
          previous.columns === columns &&
          previous.columnGap === columnGap &&
          previous.rowGap === rowGap
            ? previous
            : { width, columns, columnGap, rowGap, measured: true }
        )
        callback(rect)
      }),
    []
  )
  const cardWidth =
    (layout.width - layout.columnGap * (layout.columns - 1)) / layout.columns
  // 4:3 image, 64px metadata, 74px two-row tag area, and 2px border.
  const cardHeight = (cardWidth - 2) * 0.75 + 140
  const getItemKey = useCallback(
    (index: number) => items[index * layout.columns]?.id ?? index,
    [items, layout.columns, cardHeight]
  )
  const virtual = useVirtualizer({
    count: Math.ceil(items.length / layout.columns),
    getScrollElement: () => scroll.current,
    observeElementRect: observeRect,
    estimateSize: () => cardHeight,
    gap: layout.rowGap,
    overscan: 1,
    getItemKey,
  })
  const styles = useMemo<CSSProperties[]>(
    () =>
      Array.from({ length: items.length }, (_, index) => ({
        position: "absolute",
        top: Math.floor(index / layout.columns) * (cardHeight + layout.rowGap),
        left: (index % layout.columns) * (cardWidth + layout.columnGap),
        width: cardWidth,
        height: cardHeight,
      })),
    [
      items.length,
      layout.columns,
      layout.columnGap,
      layout.rowGap,
      cardWidth,
      cardHeight,
    ]
  )
  const rows = virtual.getVirtualItems()
  const start = layout.measured ? (rows[0]?.index ?? 0) * layout.columns : 0
  const end = layout.measured
    ? ((rows.at(-1)?.index ?? -1) + 1) * layout.columns
    : 16

  return (
    <div
      ref={scroll}
      className={`media-grid bounded-media-grid${layout.measured ? " virtual-media-grid" : ""}`}
      tabIndex={0}
      aria-label="Scrollable media grid"
    >
      {items.slice(start, end).map((media, index) => (
        <MediaCard
          {...cardProps}
          key={media.id}
          media={media}
          selected={!!selection[media.id]}
          style={layout.measured ? styles[start + index] : undefined}
        />
      ))}
      {layout.measured && (
        <div
          className="virtual-media-grid-space"
          style={{ height: virtual.getTotalSize() }}
          aria-hidden="true"
        />
      )}
    </div>
  )
}
