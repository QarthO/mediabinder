import * as React from "react"
import { LoaderCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

type ConfirmDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The element that opens the dialog; focus returns to it on close. */
  trigger?: React.ReactElement
  title: string
  description?: React.ReactNode
  confirmLabel: string
  /** Shown on the confirm button while `onConfirm` runs. */
  pendingLabel?: string
  cancelLabel?: string
  variant?: "default" | "destructive"
  /** Keep the dialog open (and pending) after `onConfirm` resolves, for
   * actions that navigate away. */
  keepOpenOnSuccess?: boolean
  /** A rejection keeps the dialog open and shows the error message. */
  onConfirm: () => Promise<void> | void
}

/**
 * Cheap by construction: while closed it renders only the Radix root, which
 * mounts nothing. State lives here, so opening it re-renders only the owner
 * of `open`. Destructive dialogs focus Cancel so Enter never destroys.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  confirmLabel,
  pendingLabel,
  cancelLabel = "Cancel",
  variant = "default",
  keepOpenOnSuccess = false,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      {open && (
        <ConfirmDialogBody
          title={title}
          description={description}
          confirmLabel={confirmLabel}
          pendingLabel={pendingLabel}
          cancelLabel={cancelLabel}
          variant={variant}
          keepOpenOnSuccess={keepOpenOnSuccess}
          onConfirm={onConfirm}
          onOpenChange={onOpenChange}
        />
      )}
    </Dialog>
  )
}

function ConfirmDialogBody({
  title,
  description,
  confirmLabel,
  pendingLabel,
  cancelLabel,
  variant,
  keepOpenOnSuccess,
  onConfirm,
  onOpenChange,
}: Required<
  Pick<ConfirmDialogProps, "cancelLabel" | "variant" | "keepOpenOnSuccess">
> &
  Omit<
    ConfirmDialogProps,
    "open" | "cancelLabel" | "variant" | "keepOpenOnSuccess"
  >) {
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const cancelRef = React.useRef<HTMLButtonElement>(null)
  const confirmRef = React.useRef<HTMLButtonElement>(null)
  const destructive = variant === "destructive"

  async function confirm() {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      await onConfirm()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.")
      setPending(false)
      return
    }
    if (keepOpenOnSuccess) return
    setPending(false)
    onOpenChange(false)
  }

  const keepOpen = (event: Event) => {
    if (pending) event.preventDefault()
  }

  return (
    <DialogContent
      className="confirm-dialog"
      showCloseButton={false}
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        ;(destructive ? cancelRef : confirmRef).current?.focus()
      }}
      onEscapeKeyDown={keepOpen}
      onPointerDownOutside={keepOpen}
      onInteractOutside={keepOpen}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description ? (
          <DialogDescription>{description}</DialogDescription>
        ) : null}
      </DialogHeader>
      {error ? (
        <p role="alert" className="confirm-dialog-error">
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <Button
          ref={cancelRef}
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => onOpenChange(false)}
        >
          {cancelLabel}
        </Button>
        <Button
          ref={confirmRef}
          type="button"
          variant={destructive ? "destructive" : "default"}
          disabled={pending}
          onClick={() => void confirm()}
        >
          {pending ? <LoaderCircle className="animate-spin" /> : null}
          {pending && pendingLabel ? pendingLabel : confirmLabel}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
