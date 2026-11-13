import { useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { LoaderCircle } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { action } from "@/lib/api"
import type { Post } from "@/lib/types"
import { isoDate } from "@/lib/utils"
import { postFields } from "@/lib/validation"

type PostDialogProps = {
  /** The item a new post links to. */
  target: { id: string; kind: "media" | "set" }
  /** The post being edited; without it the dialog adds a post. */
  post?: Post
  onOpenChange: (open: boolean) => void
}

function hostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}

const today = () => new Date().toISOString().slice(0, 10)

/**
 * Adds a post link, or edits one when `post` is given. Mount it only while
 * open: it keeps its form state locally, so typing re-renders only this body.
 */
export function PostDialog({ target, post, onOpenChange }: PostDialogProps) {
  const client = useQueryClient()
  const initialDate = post ? isoDate(post.created_at).slice(0, 10) : today()
  const [url, setUrl] = useState(post?.url ?? "")
  // Null follows the link's host until the user types a platform.
  const [platform, setPlatform] = useState<string | null>(
    post ? post.platform : null
  )
  const [externalId, setExternalId] = useState(post?.external_id ?? "")
  const [date, setDate] = useState(initialDate)
  const urlRef = useRef<HTMLInputElement>(null)
  // The button that opened the dialog gets focus back when it closes.
  const opener = useRef(document.activeElement)
  const shownPlatform = platform ?? hostname(url)

  const dateIso =
    date && !Number.isNaN(new Date(date).valueOf())
      ? new Date(date).toISOString()
      : ""
  const parsed = postFields.safeParse({
    platform: shownPlatform,
    url,
    externalId,
    // An untouched date keeps the stored time of day.
    createdAt:
      post && date === initialDate ? isoDate(post.created_at) : dateIso,
  })
  const issue = (field: string) =>
    parsed.success
      ? undefined
      : parsed.error.issues.find((i) => i.path[0] === field)?.message
  const urlError = url ? issue("url") : undefined
  const platformError = platform !== null ? issue("platform") : undefined
  const idError = issue("externalId")
  const unchanged =
    !!post &&
    parsed.success &&
    parsed.data.url === post.url &&
    parsed.data.platform === post.platform &&
    parsed.data.externalId === post.external_id &&
    date === initialDate

  const save = useMutation({
    mutationFn: (value: NonNullable<typeof parsed.data>) =>
      post
        ? action("update-post", { id: post.id, ...value })
        : action("create-post", {
            targetId: target.id,
            kind: target.kind,
            ...value,
          }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["library"] })
      toast.success(post ? "Post updated" : "Post linked")
      onOpenChange(false)
    },
  })

  return (
    <Dialog open onOpenChange={save.isPending ? undefined : onOpenChange}>
      <DialogContent
        className="post-link-dialog"
        overlayClassName="post-link-overlay"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          urlRef.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          if (
            opener.current instanceof HTMLElement &&
            opener.current.isConnected
          ) {
            event.preventDefault()
            opener.current.focus()
          }
        }}
        // Keys here must not reach the detail view's arrow navigation.
        onKeyDown={(event) => event.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>{post ? "Edit post" : "Link a post"}</DialogTitle>
          <DialogDescription>
            {post
              ? "Change where this post lives or when it went up."
              : "Paste a post URL from any platform."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="post-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            if (parsed.success && !unchanged && !save.isPending)
              save.mutate(parsed.data)
          }}
        >
          <label className="field">
            Post link
            <Input
              ref={urlRef}
              type="url"
              required
              maxLength={2048}
              placeholder="https://…"
              value={url}
              aria-invalid={urlError ? true : undefined}
              onChange={(e) => setUrl(e.target.value)}
            />
            {urlError ? (
              <small className="field-error">{urlError}</small>
            ) : null}
          </label>
          <label className="field">
            Platform
            <Input
              required
              maxLength={100}
              placeholder="Instagram, Reddit…"
              value={shownPlatform}
              aria-invalid={platformError ? true : undefined}
              onChange={(e) => setPlatform(e.target.value)}
            />
            {platformError ? (
              <small className="field-error">{platformError}</small>
            ) : null}
          </label>
          <label className="field">
            <span>
              Post ID <small>(optional)</small>
            </span>
            <Input
              maxLength={255}
              value={externalId}
              aria-invalid={idError ? true : undefined}
              onChange={(e) => setExternalId(e.target.value)}
            />
            {idError ? <small className="field-error">{idError}</small> : null}
          </label>
          <label className="field">
            Date posted
            <Input
              required
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          {save.error ? (
            <p role="alert" className="confirm-dialog-error">
              {save.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              disabled={save.isPending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={save.isPending || !parsed.success || unchanged}
            >
              {save.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : null}
              {post ? "Save" : "Link post"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
