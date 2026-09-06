import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  ArrowUpRight,
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
}: {
  selected: { id: string; kind: "media" | "set" }
  data: Library
  onClose: () => void
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
    [sets, setSets] = useState(media?.set_ids ?? []),
    [addPost, setAddPost] = useState(false),
    [platform, setPlatform] = useState(""),
    [url, setUrl] = useState(""),
    [postId, setPostId] = useState(""),
    [postDate, setPostDate] = useState(new Date().toISOString().slice(0, 10)),
    [failed, setFailed] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false)
  const client = useQueryClient()
  const save = useMutation({
    mutationFn: () =>
      action("metadata", {
        ...selected,
        displayName: name,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        createdAt:
          item && created === isoDate(item.created_at).slice(0, 10)
            ? isoDate(item.created_at)
            : new Date(created).toISOString(),
        ...(media ? { setIds: sets } : {}),
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
        platform,
        url,
        externalId: postId,
        createdAt: new Date(postDate).toISOString(),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["library"] })
      setAddPost(false)
      setUrl("")
      setPlatform("")
      setPostId("")
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
      <DialogContent className="detail-dialog" showCloseButton={false}>
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
                <label className="field">
                  Tags
                  <Input
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    placeholder="portrait, summer, campaign"
                  />
                  <small>Separate tags with commas.</small>
                </label>
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
                  <fieldset className="set-checkboxes">
                    <legend>Sets</legend>
                    {data.sets.length ? (
                      data.sets.map((set) => (
                        <label key={set.id}>
                          <input
                            type="checkbox"
                            checked={sets.includes(set.id)}
                            onChange={(e) =>
                              setSets(
                                e.target.checked
                                  ? [...sets, set.id]
                                  : sets.filter((id) => id !== set.id)
                              )
                            }
                          />
                          <FolderOpen size={14} />
                          {set.display_name}
                        </label>
                      ))
                    ) : (
                      <p>Create a set from the library to group this item.</p>
                    )}
                  </fieldset>
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
                {addPost && (
                  <form
                    className="post-form"
                    onSubmit={(e) => {
                      e.preventDefault()
                      createPost.mutate()
                    }}
                  >
                    <label className="field">
                      Platform
                      <Input
                        required
                        maxLength={100}
                        placeholder="Instagram, TikTok, or anywhere"
                        value={platform}
                        onChange={(e) => setPlatform(e.target.value)}
                      />
                    </label>
                    <label className="field">
                      Post link
                      <Input
                        type="url"
                        required
                        placeholder="https://…"
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                      />
                    </label>
                    <label className="field">
                      Post ID <span className="muted">(optional)</span>
                      <Input
                        maxLength={255}
                        value={postId}
                        onChange={(e) => setPostId(e.target.value)}
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
                        Add post link
                      </Button>
                    </div>
                  </form>
                )}
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
