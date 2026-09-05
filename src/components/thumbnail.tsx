import { useState } from "react"
import { Film, ImageIcon } from "lucide-react"
export function Thumbnail({
  id,
  name,
  video = false,
}: {
  id: string
  name: string
  video?: boolean
}) {
  const [failed, setFailed] = useState(false)
  return failed ? (
    <div className="thumbnail-fallback">
      {video ? <Film /> : <ImageIcon />}
      <span>Preview unavailable</span>
    </div>
  ) : (
    <img
      src={`/api/media/${id}?thumbnail`}
      alt={name}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  )
}
