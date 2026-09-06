import * as React from "react"
import { Dialog as Primitive } from "radix-ui"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
export const Dialog = Primitive.Root
export const DialogTrigger = Primitive.Trigger
export const DialogClose = Primitive.Close
export const DialogTitle = Primitive.Title
export const DialogDescription = Primitive.Description
export function DialogHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return <div className={cn("dialog-header", className)} {...props} />
}
export function DialogFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return <div className={cn("dialog-footer", className)} {...props} />
}
export function DialogContent({
  children,
  className,
  showCloseButton = true,
  overlayClassName,
  ...props
}: React.ComponentProps<typeof Primitive.Content> & {
  overlayClassName?: string
  showCloseButton?: boolean
}) {
  return (
    <Primitive.Portal>
      <Primitive.Overlay className={cn("dialog-overlay", overlayClassName)} />
      <Primitive.Content className={cn("dialog-content", className)} {...props}>
        {children}
        {showCloseButton && (
          <Primitive.Close className="dialog-close" aria-label="Close">
            <X size={18} />
          </Primitive.Close>
        )}
      </Primitive.Content>
    </Primitive.Portal>
  )
}
