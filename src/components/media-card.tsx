import type { useMediaPreviewIntent } from "@/lib/media-preview"
import { memo, type CSSProperties } from "react"
import { Film, ImageIcon, Link2 } from "lucide-react"
import { Thumbnail } from "./thumbnail"
import { MediaTags } from "./data-table"
import { bytes } from "@/lib/utils"
import type { Media } from "@/lib/types"

export const MediaCard = memo(function MediaCard({
  media,
  previewIntent,
  mobile,
  selected,
  selectionMode,
  onOpen,
  onToggleSelection,
  allTags,
  colors,
  style,
}: {
  media: Media
  previewIntent: ReturnType<typeof useMediaPreviewIntent>
  mobile: boolean
  selected: boolean
  selectionMode: boolean
  onOpen: (media: Media) => void
  onToggleSelection: (id: string) => void
  allTags: string[]
  colors: Record<string, string>
  style?: CSSProperties
}) {
  return (
    <div className="media-card" style={style} data-selected={selected || undefined}>
      {!mobile && (
        <input
          className="media-card-checkbox"
          type="checkbox"
          aria-label={`Select ${media.display_name}`}
          checked={selected}
          onChange={() => onToggleSelection(media.id)}
        />
      )}
      <button
        {...(!selectionMode ? previewIntent(media) : {})}
        className="media-card-open"
        aria-pressed={selectionMode ? selected : undefined}
        onClick={() =>
          selectionMode ? onToggleSelection(media.id) : onOpen(media)
        }
      >
        <div className="media-image">
          <Thumbnail
            id={media.id}
            name={media.display_name}
            video={media.mime_type.startsWith("video/")}
          />
          {media.mime_type.startsWith("video/") && (
            <span className="media-type">
              <Film size={12} />
              {media.duration_ms
                ? `${Math.floor(media.duration_ms / 60000)}:${String(Math.floor(media.duration_ms / 1000) % 60).padStart(2, "0")}`
                : "VIDEO"}
            </span>
          )}
          {!media.available && (
            <span className="unavailable">Unavailable in Drive</span>
          )}
          {media.post_count > 0 && (
            <span className="posted-indicator">
              <Link2 size={11} />
              {media.post_count}
            </span>
          )}
        </div>
        <div className="media-info">
          <strong>{media.display_name}</strong>
          <span>
            {media.mime_type.startsWith("video/") ? (
              <Film size={12} />
            ) : (
              <ImageIcon size={12} />
            )}
            <span>
              {media.raw_name.split(".").pop()?.toUpperCase()}
              {media.copy_count > 1 && ` · ${media.copy_count} copies`}
            </span>
            <span className="dot-separator">·</span>
            {bytes(media.size)}
          </span>
        </div>
      </button>
      <div className="media-card-tags">
        <MediaTags media={media} allTags={allTags} colors={colors} compact />
      </div>
    </div>
  )
})
