import { useEffect, useRef } from "react"
import { Popover } from "radix-ui"
import { ChevronDown, Eye, EyeOff } from "lucide-react"
import { maxCensorStrength } from "@/lib/workspace-preferences"
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
    <div className="censor-control">
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
              censored={censored}
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
  censored,
  strength,
  onPreview,
  onCommit,
}: {
  censored: boolean
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
    <label className="censor-slider">
      <span>Blur strength</span>
      <input
        ref={input}
        type="range"
        min={0}
        max={maxCensorStrength}
        step={1}
        defaultValue={strength}
        aria-label="Blur strength"
        onInput={(event) => onPreview(Number(event.currentTarget.value))}
      />
      <span className="censor-slider-ends">
        <span>Light</span>
        <span>Strong</span>
      </span>
      {!censored && (
        <span className="tag-popover-hint">
          Censoring is off. This applies when you turn it on.
        </span>
      )}
    </label>
  )
}
