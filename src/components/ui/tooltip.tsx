import * as React from "react"
import { Tooltip as Primitive } from "radix-ui"
import { cn } from "@/lib/utils"

export function TooltipProvider(
  props: React.ComponentProps<typeof Primitive.Provider>
) {
  return <Primitive.Provider delayDuration={0} {...props} />
}

export const Tooltip = Primitive.Root

// Safari on macOS doesn't match :focus-visible when focus comes from outside
// the page, so there the last input decides. `window` is checked first because
// Node (SSR) defines `navigator` on macOS but not `CSS`.
const isMacSafari =
  typeof window !== "undefined" &&
  navigator.platform.toLowerCase().startsWith("mac") &&
  navigator.maxTouchPoints <= 1 &&
  CSS.supports("-webkit-backdrop-filter:none")
let lastInputWasKeyboard = true
if (isMacSafari) {
  window.addEventListener(
    "keydown",
    () => {
      lastInputWasKeyboard = true
    },
    true
  )
  window.addEventListener(
    "pointerdown",
    () => {
      lastInputWasKeyboard = false
    },
    true
  )
}

function isKeyboardFocus(event: React.FocusEvent<HTMLElement>) {
  if (isMacSafari && !event.relatedTarget) return lastInputWasKeyboard
  return event.currentTarget.matches(":focus-visible")
}

export function TooltipTrigger({
  onFocus,
  ...props
}: React.ComponentProps<typeof Primitive.Trigger>) {
  return (
    <Primitive.Trigger
      data-slot="tooltip-trigger"
      onFocus={(event) => {
        onFocus?.(event)
        // Radix opens on any focus, so a dialog or menu handing focus back to
        // its trigger after a click left the tooltip stuck open. Only keyboard
        // focus should open it.
        if (!isKeyboardFocus(event)) event.preventDefault()
      }}
      {...props}
    />
  )
}

export function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        data-slot="tooltip-content"
        className={cn("tooltip-content", className)}
        sideOffset={sideOffset}
        collisionPadding={12}
        {...props}
      >
        {children}
        <Primitive.Arrow className="tooltip-arrow" />
      </Primitive.Content>
    </Primitive.Portal>
  )
}
