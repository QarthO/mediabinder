import * as React from "react"
import { Tooltip as Primitive } from "radix-ui"
import { cn } from "@/lib/utils"
export function TooltipProvider(
  props: React.ComponentProps<typeof Primitive.Provider>
) {
  return <Primitive.Provider delayDuration={0} {...props} />
}
export const Tooltip = Primitive.Root
export const TooltipTrigger = Primitive.Trigger
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
