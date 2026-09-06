import * as React from "react"
import { DropdownMenu as Primitive } from "radix-ui"
import { cn } from "@/lib/utils"
export const DropdownMenu = Primitive.Root
export const DropdownMenuTrigger = Primitive.Trigger
export function DropdownMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        className={cn("dropdown-content", className)}
        sideOffset={6}
        collisionPadding={12}
        {...props}
      />
    </Primitive.Portal>
  )
}
export function DropdownMenuItem({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Item>) {
  return (
    <Primitive.Item className={cn("dropdown-item", className)} {...props} />
  )
}
