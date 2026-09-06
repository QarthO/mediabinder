import { useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { Popover } from "radix-ui"

// Measure against the actual column width, reserving room for the overflow count.
export function ChipOverflow({
  children,
  label,
}: {
  children: ReactNode[]
  label: string
}) {
  const measure = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(children.length)
  useLayoutEffect(() => {
    const element = measure.current
    if (!element) return
    const update = () => {
      const width = element.clientWidth
      if (!width) return
      const chips = Array.from(element.children) as HTMLElement[]
      const counter = chips.pop()!
      const widths = chips.map((chip) => chip.getBoundingClientRect().width)
      const fits = (values: number[]) => {
        let row = 1,
          used = 0
        for (const value of values) {
          if (used && used + 6 + value > width + 0.5) {
            row++
            used = 0
          }
          used += (used ? 6 : 0) + value
        }
        return row <= 2
      }
      let count = children.length
      while (count > 0) {
        counter.textContent = `+${children.length - count}`
        if (
          fits(
            count === children.length
              ? widths
              : [
                  ...widths.slice(0, count),
                  counter.getBoundingClientRect().width,
                ]
          )
        )
          break
        count--
      }
      setVisible(count)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    document.fonts.addEventListener("loadingdone", update)
    return () => {
      observer.disconnect()
      document.fonts.removeEventListener("loadingdone", update)
    }
  }, [children])
  const hidden = children.length - visible
  return (
    <div className="chip-overflow">
      <div className="tag-chips chip-visible">
        {children.slice(0, visible)}
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
      <div
        className="tag-chips chip-measure"
        ref={measure}
        aria-hidden="true"
        inert
      >
        {children}
        <span className="chip-more">+{children.length}</span>
      </div>
    </div>
  )
}
