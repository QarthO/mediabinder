import { type ReactNode } from "react"
import { Popover } from "radix-ui"

// A fixed two-row summary needs no layout reads or hidden duplicate controls.
export function ChipOverflow({
  children,
  label,
}: {
  children: ReactNode[]
  label: string
}) {
  const visible = Math.min(2, children.length)
  const hidden = children.length - visible
  return (
    <div className="chip-overflow">
      <div
        className="tag-chips chip-visible"
        style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto" }}
      >
        {children.slice(0, visible).map((child, index) => (
          <div
            key={index}
            style={{
              minWidth: 0,
              gridColumn: index === 0 || !hidden ? "1 / -1" : "1",
            }}
          >
            {child}
          </div>
        ))}
        {hidden > 0 && (
          <Popover.Root>
            <Popover.Trigger asChild>
              <button
                type="button"
                className="chip-more"
                aria-label={`Show ${hidden} more ${label}`}
              >
                +{hidden}
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                className="tag-popover chip-overflow-popover"
                sideOffset={8}
                align="start"
                collisionPadding={12}
              >
                <h3>{label}</h3>
                <div className="table-tags">
                  <div className="tag-chips">{children.slice(visible)}</div>
                </div>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        )}
      </div>
    </div>
  )
}
