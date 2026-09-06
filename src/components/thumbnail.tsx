import { createContext, useContext, useEffect, useState } from "react"
import { Film, ImageIcon } from "lucide-react"
export const MediaCensorContext = createContext(false)

export function Thumbnail({
  id,
  name,
  video = false,
  eager = false,
}: {
  id: string
  name: string
  video?: boolean
  eager?: boolean
}) {
  const blurred = useContext(MediaCensorContext)
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    setFailed(false)
    setLoaded(false)
    setAttempt(0)
  }, [id])
  useEffect(() => {
    if (!failed || attempt > 0) return
    const timer = window.setTimeout(() => {
      setAttempt(1)
      setFailed(false)
    }, 1000)
    return () => window.clearTimeout(timer)
  }, [failed, attempt])
  return failed && attempt > 0 ? (
    <div className="thumbnail-fallback">
      {video ? <Film /> : <ImageIcon />}
      <span>Preview unavailable</span>
    </div>
  ) : (
    <img
      data-blurred={blurred || undefined}
      src={`/api/media/${id}?thumbnail${attempt ? `&retry=${attempt}` : ""}`}
      className={loaded ? undefined : "thumbnail-loading"}
      ref={(image) => {
        if (image?.complete && image.naturalWidth) setLoaded(true)
      }}
      onLoad={() => setLoaded(true)}
      alt={name}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      onError={() => setFailed(true)}
    />
  )
}
