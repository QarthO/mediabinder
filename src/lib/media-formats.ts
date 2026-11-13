// Video containers built on the ISO base media format. A browser that refuses
// the QuickTime or 3GPP label can often play the same bytes as MP4, so the
// viewer may ask the media route to serve them as `video/mp4`. Only these
// types qualify: the label is a security boundary, never a free-form choice.
export const MP4_RELABEL_TYPES: readonly string[] = [
  "video/quicktime",
  "video/x-m4v",
  "video/3gpp",
  "video/3gpp2",
]

export const canRelabelAsMp4 = (mimeType: string) =>
  MP4_RELABEL_TYPES.includes(mimeType)

// Video types whose files are ISO base media (an MP4-style box tree), so their
// codec can be read from the `moov` box. WebM and others are not looked at.
export const ISO_BMFF_VIDEO_TYPES: readonly string[] = [
  "video/mp4",
  ...MP4_RELABEL_TYPES,
]

export const isIsoBmffVideo = (mimeType: string) =>
  ISO_BMFF_VIDEO_TYPES.includes(mimeType)
