import { MediaTags } from "./data-table"
import { MediaSets } from "./media-sets"
import { useContext, useRef, useState, type CSSProperties } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import {
  ArrowUpRight,
  EyeOff,
  ChevronLeft,
  ChevronRight,
  Link2,
  Pencil,
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
import { PostDialog } from "./post-dialog"
import { CopiesSection } from "./copies"
import {
  Thumbnail,
  MediaCensorContext,
  MediaCensorScaleContext,
} from "./thumbnail"
import { action } from "@/lib/api"
import { bytes, dateValue, isoDate } from "@/lib/utils"
import type { Library, Media, Post } from "@/lib/types"
import { canPreview, useMediaPreview } from "@/lib/media-preview"
import { canRelabelAsMp4 } from "@/lib/media-formats"

function PreviewImage({
  media,
  censored,
  onError,
  onRendered,
  src,
}: {
  media: Media
  censored: boolean
  onError: () => void
  onRendered: () => void
  src?: string
}) {
  const [loaded, setLoaded] = useState(false)
  // The original failed to display (HEIC in most browsers): ask for Google's
  // JPEG of it once. Failing again is the preview's failure.
  const [rendered, setRendered] = useState(false)
  const shown = rendered
    ? `/api/media/${encodeURIComponent(media.id)}?rendered`
    : src
  return (
    <>
      {!loaded && (
        <img
          data-blurred={censored || undefined}
          src={`/api/media/${encodeURIComponent(media.id)}?thumbnail`}
          alt={media.display_name}
          decoding="async"
        />
      )}
      {shown && (
        <img
          data-blurred={censored || undefined}
          src={shown}
          alt={loaded ? media.display_name : ""}
          decoding="async"
          style={loaded ? undefined : { position: "absolute", opacity: 0 }}
          onLoad={() => setLoaded(true)}
          onError={() => {
            if (rendered) return onError()
            setRendered(true)
            setLoaded(false)
            onRendered()
          }}
        />
      )}
    </>
  )
}

function PreviewVideo({
  media,
  censored,
  onError,
}: {
  media: Media
  censored: boolean
  onError: () => void
}) {
  // A browser that refuses the stored label (Chrome on Windows and Linux with
  // QuickTime) often plays the same bytes as MP4: label it so up front when
  // canPlayType says no, or after the original fails to load.
  const [asMp4, setAsMp4] = useState(
    () => canRelabelAsMp4(media.mime_type) && cannotPlay(media.mime_type)
  )
  const id = encodeURIComponent(media.id)
  return (
    <video
      data-blurred={censored || undefined}
      controls={!censored}
      tabIndex={censored ? -1 : undefined}
      autoPlay={false}
      playsInline
      preload="metadata"
      poster={`/api/media/${id}?thumbnail`}
      src={`/api/media/${id}${asMp4 ? "?as=mp4" : ""}`}
      onError={(event) => {
        const unsupported =
          event.currentTarget.error?.code ===
          MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
        if (!asMp4 && unsupported && canRelabelAsMp4(media.mime_type))
          setAsMp4(true)
        else onError()
      }}
    />
  )
}

function cannotPlay(mimeType: string) {
  return (
    typeof document !== "undefined" &&
    document.createElement("video").canPlayType(mimeType) === ""
  )
}

function CachedPreviewImage(props: {
  media: Media
  censored: boolean
  onError: () => void
  onRendered: () => void
}) {
  const src = useMediaPreview(props.media)
  return <PreviewImage {...props} src={src} />
}

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
  const censorEnabled = useContext(MediaCensorContext)
  const censorScale = useContext(MediaCensorScaleContext)
  // Detail is keyed by item, so closing or navigating always clears this reveal.
  const [revealed, setRevealed] = useState(false)
  const censored = censorEnabled && !revealed
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
    [dialog, setDialog] = useState<"add" | Post | null>(null),
    [failed, setFailed] = useState(false),
    [rendered, setRendered] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const copiesRef = useRef<HTMLElement>(null)
  const client = useQueryClient()
  const router = useRouter()
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
      await router.invalidate()
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
      created !== isoDate(item!.created_at).slice(0, 10)
    if (dirty || save.isPending) {
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
        style={{ "--censor-strength": censorScale } as CSSProperties}
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          dialogRef.current?.focus()
        }}
        onKeyDown={(event) => {
          if (
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
          <div
            className="detail-preview"
            data-rendered={(media && rendered && !failed) || undefined}
          >
            {media ? (
              failed || !media.available ? (
                <div className="preview-error">
                  <AlertCircle />
                  <h3>Preview unavailable</h3>
                  <p>
                    {media.available
                      ? media.mime_type.startsWith("video/")
                        ? "This video may use a format your browser can't decode, such as HEVC. Open the original in Drive."
                        : "This format may not display in your browser. Open the original in Drive."
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
                <PreviewVideo
                  media={media}
                  censored={censored}
                  onError={() => setFailed(true)}
                />
              ) : canPreview(media) ? (
                <CachedPreviewImage
                  media={media}
                  censored={censored}
                  onError={() => setFailed(true)}
                  onRendered={() => setRendered(true)}
                />
              ) : (
                <PreviewImage
                  media={media}
                  censored={censored}
                  src={`/api/media/${encodeURIComponent(media.id)}`}
                  onError={() => setFailed(true)}
                  onRendered={() => setRendered(true)}
                />
              )
            ) : (
              <MediaCensorContext value={censored}>
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
              </MediaCensorContext>
            )}
            {censored &&
              (media ? !failed && media.available : members.length > 0) && (
                <button
                  className="media-reveal"
                  aria-label="Reveal media"
                  onClick={() => {
                    setRevealed(true)
                    dialogRef.current?.focus()
                  }}
                >
                  <span>
                    <EyeOff size={20} />
                    Click to reveal
                  </span>
                </button>
              )}
            <div
              className="preview-caption"
              data-rendered={(media && rendered && !failed) || undefined}
            >
              <span>
                {media
                  ? `${media.width && media.height ? `${media.width} × ${media.height} · ` : ""}${bytes(media.size)}`
                  : `${members.length} items`}
              </span>
              {rendered && !failed && media ? (
                <>
                  <span className="preview-notice">
                    Preview from Google Drive, not the original file
                  </span>
                  <a
                    href={`https://drive.google.com/file/d/${media.drive_id}/view`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open original in Drive
                  </a>
                </>
              ) : (
                <span>Original preview</span>
              )}
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
                    <dd>
                      {item.raw_name}
                      {media && media.copy_count > 1 && (
                        <button
                          type="button"
                          className="copies-link"
                          onClick={() => {
                            copiesRef.current?.scrollIntoView({
                              block: "start",
                              behavior: "smooth",
                            })
                            copiesRef.current?.focus({ preventScroll: true })
                          }}
                        >
                          {media.copy_count} copies
                        </button>
                      )}
                    </dd>
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
              {media && media.copy_count > 1 && (
                <CopiesSection
                  catalogId={media.id}
                  count={media.copy_count}
                  ref={copiesRef}
                />
              )}
              <section className="detail-posts">
                <div className="section-heading">
                  <h3>
                    Posts <span>{posts.length}</span>
                  </h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDialog("add")}
                  >
                    <Plus />
                    Link post
                  </Button>
                </div>
                {posts.length ? (
                  posts.map((post) => (
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
                        aria-label={`Edit ${post.platform} post`}
                        title="Edit post"
                        onClick={() => setDialog(post)}
                      >
                        <Pencil size={14} />
                      </button>
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
                ) : (
                  <p className="muted">
                    No posts linked yet. Add a link from any platform.
                  </p>
                )}
                {dialog ? (
                  <PostDialog
                    target={selected}
                    post={dialog === "add" ? undefined : dialog}
                    onOpenChange={(open) => !open && setDialog(null)}
                  />
                ) : null}
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
