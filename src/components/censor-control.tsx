import { useEffect, useRef } from "react"
import { Popover } from "radix-ui"
import { ChevronDown, Eye, EyeOff } from "lucide-react"
import { censorSteps } from "@/lib/workspace-preferences"
import { Button } from "./ui/button"

// The censor toggle with a caret that opens the blur-strength slider. Dragging
// only previews: `onPreview` writes the CSS variable straight to the DOM, and
// `onCommit` runs when the drag ends, so no media card re-renders mid-drag.
export function CensorControl({
  censored,
  strength,
  onToggle,
  onPreview,
  onCommit,
}: {
  censored: boolean
  strength: number
  onToggle: () => void
  onPreview: (strength: number) => void
  onCommit: (strength: number) => void
}) {
  return (
    <div className="censor-control" data-censored={censored || undefined}>
      <Button
        className="thumbnail-blur-toggle"
        variant="outline"
        size="icon"
        aria-label="Censor media"
        aria-pressed={censored}
        title={censored ? "Uncensor media" : "Censor media"}
        onClick={onToggle}
      >
        {censored ? <EyeOff /> : <Eye />}
      </Button>
      <Popover.Root>
        <Popover.Trigger asChild>
          <Button
            className="censor-strength-trigger"
            variant="outline"
            aria-label="Blur strength"
            title="Blur strength"
          >
            <ChevronDown />
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className="tag-popover censor-popover"
            sideOffset={5}
            align="end"
            collisionPadding={12}
          >
            <StrengthSlider
              strength={strength}
              onPreview={onPreview}
              onCommit={onCommit}
            />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  )
}

function StrengthSlider({
  strength,
  onPreview,
  onCommit,
}: {
  strength: number
  onPreview: (strength: number) => void
  onCommit: (strength: number) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const commit = useRef(onCommit)
  useEffect(() => {
    commit.current = onCommit
  })
  // `change` fires on release (and per keyboard step), unlike React's onChange,
  // which follows every `input` event.
  useEffect(() => {
    const element = input.current
    const onChange = () => commit.current(Number(element?.value))
    element?.addEventListener("change", onChange)
    return () => element?.removeEventListener("change", onChange)
  }, [])
  return (
    <input
      ref={input}
      className="censor-slider"
      type="range"
      min={1}
      max={censorSteps}
      step={1}
      defaultValue={strength}
      aria-label="Blur strength"
      onInput={(event) => onPreview(Number(event.currentTarget.value))}
    />
  )
}
