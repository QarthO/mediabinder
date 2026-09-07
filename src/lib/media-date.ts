// A null clock renders a deterministic UTC date until the browser hydrates.
// Afterwards, presentation uses the browser's locale and timezone.
export function mediaDate(value: string, now: number | null = Date.now()) {
  const date = new Date(
    value.includes("T") ? value : value.replace(" ", "T") + "Z"
  )
  if (Number.isNaN(date.getTime()))
    return { label: "—", timestamp: "Unknown date", iso: undefined }
  const locale = now === null ? "en-US" : undefined
  const timeZone = now === null ? "UTC" : undefined
  const seconds = Math.floor(((now ?? 0) - date.getTime()) / 1000)
  const days = Math.floor(seconds / 86400)
  const label =
    now === null || seconds < 0 || days > 30
      ? date.toLocaleDateString(locale, {
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone,
        })
      : seconds < 60
        ? "Just now"
        : seconds < 3600
          ? `${Math.floor(seconds / 60)}min ago`
          : seconds < 86400
            ? `${Math.floor(seconds / 3600)}hr ago`
            : days < 7
              ? `${days} ${days === 1 ? "day" : "days"} ago`
              : days < 30
                ? `${Math.floor(days / 7)} ${days < 14 ? "week" : "weeks"} ago`
                : "1 month ago"
  return {
    label,
    iso: date.toISOString(),
    timestamp: date.toLocaleString(locale, {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
      timeZone,
    }),
  }
}
