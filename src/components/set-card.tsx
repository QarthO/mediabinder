import { memo } from "react"
import { ChevronRight, FolderOpen } from "lucide-react"
import { tagStyle } from "@/lib/tag-colors"
import type { MediaSet } from "@/lib/types"
import { Thumbnail } from "./thumbnail"

export const SetCard = memo(function SetCard({
  set,
  colors,
  onOpen,
}: {
  set: MediaSet
  colors: Record<string, string>
  onOpen: (set: MediaSet) => void
}) {
  return (
    <button className="set-card" onClick={() => onOpen(set)}>
      <div className="set-cover">
        {set.cover_id ? (
          <Thumbnail id={set.cover_id} name={set.display_name} />
        ) : (
          <FolderOpen size={32} />
        )}
        <span className="set-tab">
          <FolderOpen size={13} />
          SET
        </span>
      </div>
      <div className="set-info">
        <strong>{set.display_name}</strong>
        <span>
          {set.media_count} items
          <ChevronRight size={15} />
        </span>
      </div>
      {set.tags.length > 0 && (
        <div className="tags">
          {set.tags.map((t) => (
            <span className="tag" style={tagStyle(colors[t])} key={t}>
              {t}
            </span>
          ))}
        </div>
      )}
    </button>
  )
})
