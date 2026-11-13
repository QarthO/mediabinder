import { memo } from "react"
import { Toaster as Primitive } from "sonner"

// Call sites keep using `toast` from "sonner". The memo keeps route changes
// and shell re-renders from re-rendering the toast container.
export const Toaster = memo(function Toaster(
  props: React.ComponentProps<typeof Primitive>
) {
  return (
    <Primitive theme="dark" position="bottom-right" richColors {...props} />
  )
})
