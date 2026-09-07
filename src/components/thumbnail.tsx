import { createContext, memo, useContext, useState } from "react"
import { Film, ImageIcon } from "lucide-react"
export const MediaCensorContext = createContext(false)

type ThumbnailProps = {
  id: string
  name: string
  video?: boolean
  eager?: boolean
}

export const Thumbnail = memo(function Thumbnail(props: ThumbnailProps) {
  return <ThumbnailImage key={props.id} {...props} />
})

const readyImage = (image: HTMLImageElement | null) => {
  if (image?.complete && image.naturalWidth)
    image.classList.remove("thumbnail-loading")
}

function ThumbnailImage({
  id,
  name,
  video = false,
  eager = false,
}: ThumbnailProps) {
  const blurred = useContext(MediaCensorContext)
  const [failed, setFailed] = useState(false)
  return failed ? (
    <div className="thumbnail-fallback">
      {video ? <Film /> : <ImageIcon />}
      <span>Preview unavailable</span>
    </div>
  ) : (
    <img
      data-blurred={blurred || undefined}
      src={`/api/media/${id}?thumbnail`}
      className="thumbnail-loading"
      ref={readyImage}
      onLoad={(event) => readyImage(event.currentTarget)}
      alt={name}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      fetchPriority="low"
      onError={() => setFailed(true)}
    />
  )
}
