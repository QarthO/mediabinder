import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
export function dateValue(value: string | null) {
  if (!value) return "—"
  const date = new Date(
    value.includes("T") ? value : value.replace(" ", "T") + "Z"
  )
  return Number.isNaN(date.valueOf())
    ? "—"
    : date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })
}
export function isoDate(value: string) {
  return new Date(
    value.includes("T") ? value : value.replace(" ", "T") + "Z"
  ).toISOString()
}
export function bytes(value: number) {
  if (!value) return "—"
  const i = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 3)
  return `${(value / 1024 ** i).toFixed(i ? 1 : 0)} ${["B", "KB", "MB", "GB"][i]}`
}
