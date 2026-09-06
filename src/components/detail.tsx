import { MediaTags } from "./data-table"
import { MediaSets } from "./media-sets"
import { useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Link2,
  Plus,
  Trash2,
  FolderOpen,
  AlertCircle,
  X,
} from "lucide-react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogClose,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog"
import { Button } from "./ui/button"
import { Input } from "./ui/input"
import { Thumbnail } from "./thumbnail"
import { action } from "@/lib/api"
import { bytes, dateValue, isoDate } from "@/lib/utils"
import type { Library } from "@/lib/types"
export function Detail({
  selected,
  data,
  onClose,
  navigation,
}: {
  selected: { id: string; kind: "media" | "set" }
  data: Library
  onClose: () => void
  navigation?: {
    index: number
    count: number
    onStep: (direction: number) => void
  }
}) {
  const item =
    selected.kind === "media"
      ? data.media.find((m) => m.id === selected.id)
      : data.sets.find((s) => s.id === selected.id)
  const media =
    selected.kind === "media"
      ? data.media.find((m) => m.id === selected.id)
      : null
  const [name, setName] = useState(item?.display_name ?? ""),
    [tags, setTags] = useState(item?.tags.join(", ") ?? ""),
    [created, setCreated] = useState(
      item ? isoDate(item.created_at).slice(0, 10) : ""
    ),
    [addPost, setAddPost] = useState(false),
    [url, setUrl] = useState(""),
    [postDate, setPostDate] = useState(new Date().toISOString().slice(0, 10)),
    [failed, setFailed] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const client = useQueryClient()
  const save = useMutation({
    mutationFn: () =>
      action("metadata", {
        ...selected,
        displayName: name,
        ...(!media
          ? {
              tags: tags
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
            }
          : {}),
        createdAt:
          item && created === isoDate(item.created_at).slice(0, 10)
            ? isoDate(item.created_at)
            : new Date(created).toISOString(),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["library"] })
      toast.success("Changes saved")
    },
    onError: (e) => toast.error(e.message),
  })
  const createPost = useMutation({
    mutationFn: () =>
      action("create-post", {
        targetId: selected.id,
        kind: selected.kind,
        platform: new URL(url).hostname.replace(/^www\./, ""),
        url,
        externalId: "",
        createdAt: new Date(postDate).toISOString(),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["library"] })
      setAddPost(false)
      setUrl("")
      toast.success("Post linked")
    },
    onError: (e) => toast.error(e.message),
  })
  const remove = useMutation({
    mutationFn: (id: string) => action("delete-post", { id }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["library"] })
      toast.success("Post link removed")
    },
    onError: (e) => toast.error(e.message),
  })
  const deleteSet = useMutation({
    mutationFn: () => action("delete-set", { id: selected.id }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["library"] })
      onClose()
      toast.success("Set deleted")
    },
    onError: (e) => toast.error(e.message),
  })
  if (!item) return null
  function step(direction: number) {
    if (
      !navigation ||
      navigation.index + direction < 0 ||
      navigation.index + direction >= navigation.count
    )
      return
    const dirty =
      name !== item!.display_name ||
      (!media &&
        tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean)
          .join(",") !== item!.tags.join(",")) ||
      created !== isoDate(item!.created_at).slice(0, 10) ||
      (addPost && Boolean(url))
    if (dirty || save.isPending || createPost.isPending) {
      toast.info("Save your changes before moving to another item", {
        id: "media-navigation-draft",
      })
      return
    }
    navigation.onStep(direction)
  }
  const posts = data.posts.filter((p) =>
    selected.kind === "media"
      ? p.media_id === selected.id
      : p.set_id === selected.id
  )
  const members = data.media.filter((m) => m.set_ids.includes(selected.id))
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        ref={dialogRef}
        className="detail-dialog"
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          dialogRef.current?.focus()
        }}
        onKeyDown={(event) => {
          if (
            addPost ||
            !navigation ||
            event.defaultPrevented ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey
          )
            return
          const target = event.target as HTMLElement
          if (
            target.closest(
              'input, textarea, select, [contenteditable="true"], video, audio, [role="slider"], [role="combobox"], [role="menu"], [role="listbox"]'
            ) ||
            !event.currentTarget.contains(target)
          )
            return
          if (
            ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(
              event.key
            )
          ) {
            event.preventDefault()
            step(event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1)
          }
        }}
      >
        <header className="detail-header">
          <DialogHeader>
            <div className="eyebrow">
              {media
                ? media.mime_type.startsWith("video/")
                  ? "VIDEO"
                  : "IMAGE"
                : "SET"}
            </div>
            <DialogTitle>{item.display_name}</DialogTitle>
            <DialogDescription>
              {media
                ? item.raw_name
                : `${members.length} items · A collection in your library`}
            </DialogDescription>
          </DialogHeader>
          {navigation && (
            <div className="detail-navigation" aria-label="Media navigation">
              <button
                className="icon-button"
                aria-label="Previous media"
                title="Previous media (← or ↑)"
                disabled={navigation.index === 0}
                onClick={() => step(-1)}
              >
                <ChevronLeft size={20} />
              </button>
              <span aria-live="polite">
                {navigation.index + 1} / {navigation.count}
              </span>
              <button
                className="icon-button"
                aria-label="Next media"
                title="Next media (→ or ↓)"
                disabled={navigation.index === navigation.count - 1}
                onClick={() => step(1)}
              >
                <ChevronRight size={20} />
              </button>
            </div>
          )}
          {media && (
            <a
              className="detail-drive-link"
              href={`https://drive.google.com/file/d/${media.drive_id}/view`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open in Drive
              <ArrowUpRight size={17} />
            </a>
          )}
          <DialogClose className="icon-button" aria-label="Close">
            <X size={21} />
          </DialogClose>
        </header>
        <div className="detail-body">
          <div className="detail-preview">
            {media ? (
              failed || !media.available ? (
                <div className="preview-error">
                  <AlertCircle />
                  <h3>Preview unavailable</h3>
                  <p>
                    {media.available
                      ? "This format may not play in your browser. Open the original in Drive."
                      : "The file is no longer in the connected folder."}
                  </p>
                  <a
                    href={`https://drive.google.com/file/d/${media.drive_id}/view`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open in Google Drive <ArrowUpRight size={14} />
                  </a>
                </div>
              ) : media.mime_type.startsWith("video/") ? (
                <video
                  controls
                  autoPlay={false}
                  playsInline
                  preload="metadata"
                  src={`/api/media/${media.id}`}
                  onError={() => setFailed(true)}
                />
              ) : (
                <img
                  src={`/api/media/${media.id}`}
                  alt={media.display_name}
                  onError={() => setFailed(true)}
                />
              )
            ) : (
              <div className="set-preview-grid">
                {members.length ? (
                  members
                    .slice(0, 9)
                    .map((m) => (
                      <Thumbnail key={m.id} id={m.id} name={m.display_name} />
                    ))
                ) : (
                  <FolderOpen size={48} />
                )}
              </div>
            )}
            <div className="preview-caption">
              <span>
                {media
                  ? `${media.width && media.height ? `${media.width} × ${media.height} · ` : ""}${bytes(media.size)}`
                  : `${members.length} items`}
              </span>
              <span>Original preview</span>
            </div>
          </div>
          <aside className="detail-panel">
            <div className="detail-scroll">
              <div className="inspector-heading">
                <h3>Details</h3>
                <p>Give this {media ? "file" : "set"} a little context.</p>
              </div>
              <form
                id="media-metadata"
                onSubmit={(e) => {
                  e.preventDefault()
                  save.mutate()
                }}
              >
                <label className="field">
                  Display name
                  <Input
                    required
                    maxLength={255}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                {media ? (
                  <div className="field">
                    <span>Tags</span>
                    <MediaTags
                      media={media}
                      allTags={Object.keys(data.tag_colors)}
                      colors={data.tag_colors}
                    />
                  </div>
                ) : (
                  <label className="field">
                    Tags
                    <Input
                      value={tags}
                      onChange={(e) => setTags(e.target.value)}
                      placeholder="portrait, summer, campaign"
                    />
                    <small>Separate tags with commas.</small>
                  </label>
                )}
                <label className="field">
                  Date created
                  <Input
                    type="date"
                    required
                    value={created}
                    onChange={(e) => setCreated(e.target.value)}
                  />
                </label>
                <dl className="file-facts">
                  <div>
                    <dt>Raw name</dt>
                    <dd>{item.raw_name}</dd>
                  </div>
                  <div>
                    <dt>Uploaded to Drive</dt>
                    <dd>{dateValue(item.uploaded_at)}</dd>
                  </div>
                  {media && (
                    <>
                      <div>
                        <dt>File size</dt>
                        <dd>{bytes(media.size)}</dd>
                      </div>
                      {media.width && (
                        <div>
                          <dt>Dimensions</dt>
                          <dd>
                            {media.width} × {media.height}
                          </dd>
                        </div>
                      )}
                      <div>
                        <dt>Format</dt>
                        <dd>{media.mime_type}</dd>
                      </div>
                    </>
                  )}
                </dl>
                {media && (
                  <div className="field">
                    <span>Sets</span>
                    <MediaSets media={media} sets={data.sets} />
                  </div>
                )}
              </form>
              <section className="detail-posts">
                <div className="section-heading">
                  <h3>
                    Posts <span>{posts.length}</span>
                  </h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setAddPost((v) => !v)}
                  >
                    <Plus />
                    Link post
                  </Button>
                </div>
                {posts.length
                  ? posts.map((post) => (
                      <div key={post.id} className="linked-post">
                        <Link2 size={15} />
                        <div>
                          <a
                            href={post.url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {post.platform}
                            <ArrowUpRight size={12} />
                          </a>
                          <small>
                            {dateValue(post.created_at)}
                            {post.external_id && ` · ${post.external_id}`}
                          </small>
                        </div>
                        <button
                          aria-label={`Remove ${post.platform} post link`}
                          title="Remove post link"
                          disabled={remove.isPending}
                          onClick={() => remove.mutate(post.id)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))
                  : !addPost && (
                      <p className="muted">
                        No posts linked yet. Add a link from any platform.
                      </p>
                    )}
                <Dialog open={addPost} onOpenChange={setAddPost}>
                  <DialogContent
                    className="post-link-dialog"
                    overlayClassName="post-link-overlay"
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <DialogHeader>
                      <DialogTitle>Link a post</DialogTitle>
                      <DialogDescription>
                        Paste a post URL from any platform.
                      </DialogDescription>
                    </DialogHeader>
                    <form
                      className="post-form"
                      onSubmit={(e) => {
                        e.preventDefault()
                        createPost.mutate()
                      }}
                    >
                      <label className="field">
                        Post link
                        <Input
                          type="url"
                          required
                          maxLength={2048}
                          placeholder="https://…"
                          value={url}
                          onChange={(e) => setUrl(e.target.value)}
                        />
                      </label>
                      <label className="field">
                        Date posted
                        <Input
                          required
                          type="date"
                          value={postDate}
                          onChange={(e) => setPostDate(e.target.value)}
                        />
                      </label>
                      <div className="dialog-footer">
                        <Button
                          variant="ghost"
                          type="button"
                          onClick={() => setAddPost(false)}
                        >
                          Cancel
                        </Button>
                        <Button type="submit" disabled={createPost.isPending}>
                          Link post
                        </Button>
                      </div>
                    </form>
                  </DialogContent>
                </Dialog>
              </section>
              {selected.kind === "set" && (
                <div className="delete-set">
                  {confirmDelete ? (
                    <>
                      <p>
                        Delete this set? Its media will stay in your library.
                      </p>
                      <Button
                        variant="destructive"
                        disabled={deleteSet.isPending}
                        onClick={() => deleteSet.mutate()}
                      >
                        Delete set
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => setConfirmDelete(false)}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      onClick={() => setConfirmDelete(true)}
                    >
                      <Trash2 />
                      Delete set
                    </Button>
                  )}
                </div>
              )}
            </div>
            <div className="detail-actions">
              <span>Changes stay in MediaBinder</span>
              <Button
                type="submit"
                form="media-metadata"
                disabled={save.isPending}
              >
                {save.isPending ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  )
}
