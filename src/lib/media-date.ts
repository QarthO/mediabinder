// MySQL date strings are UTC; presentation uses the browser's locale and timezone.
export function mediaDate(value: string, now = Date.now()) {
  const date = new Date(
    value.includes("T") ? value : value.replace(" ", "T") + "Z"
  )
  if (Number.isNaN(date.getTime()))
    return { label: "—", timestamp: "Unknown date", iso: undefined }
  const seconds = Math.floor((now - date.getTime()) / 1000)
  const days = Math.floor(seconds / 86400)
  const label =
    seconds < 0 || days > 30
      ? date.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
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
    timestamp: date.toLocaleString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    }),
  }
}
