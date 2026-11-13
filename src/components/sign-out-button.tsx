import { memo, useState } from "react"
import { LogOut } from "lucide-react"

import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { authClient } from "@/lib/auth-client"
import { clearDevelopmentLogin } from "@/lib/development-auth"

// Owns the dialog state so opening it never re-renders the workspace.
export const SignOutButton = memo(function SignOutButton() {
  const [open, setOpen] = useState(false)
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button
          className="sign-out"
          title="Sign out of MediaBinder"
          aria-label="Sign out of MediaBinder"
        >
          <LogOut size={15} />
        </button>
      }
      title="Sign out of MediaBinder?"
      description="You will need to sign in again to see your library."
      confirmLabel="Sign out"
      pendingLabel="Signing out…"
      variant="destructive"
      keepOpenOnSuccess
      onConfirm={async () => {
        // The development bypass has no Better Auth session to end.
        const { cleared } = await clearDevelopmentLogin()
        const result = await authClient.signOut()
        if (result.error && !cleared)
          throw new Error("Could not sign out. Try again.")
        window.location.assign("/")
      }}
    />
  )
})
