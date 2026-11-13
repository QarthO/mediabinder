import { memo, useState } from "react"

function Picture({ image, name }: { image: string; name: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return null
  // Google can refuse a hotlink that carries a referrer. The initials stay
  // underneath, so a slow or broken picture never moves the layout.
  return (
    <img
      src={image}
      alt={`${name}'s profile picture`}
      width="30"
      height="30"
      referrerPolicy="no-referrer"
      // The server-rendered image can fail before React attaches onError.
      ref={(img) => {
        if (img?.complete && img.naturalWidth === 0) setFailed(true)
      }}
      onError={() => setFailed(true)}
    />
  )
}

/** The signed-in user's Google picture, or their initials without one. */
export const AccountAvatar = memo(function AccountAvatar({
  name,
  image,
}: {
  name: string
  image: string | null
}) {
  return (
    <div className="avatar">
      {name.slice(0, 2).toUpperCase()}
      {image && <Picture key={image} image={image} name={name} />}
    </div>
  )
})
