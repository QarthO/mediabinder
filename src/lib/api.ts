import { queryOptions } from "@tanstack/react-query"
import type { Library } from "./types"
export const libraryQuery = queryOptions({
  queryKey: ["library"],
  queryFn: async (): Promise<Library> => {
    const response = await fetch("/api/library")
    if (response.status === 401) {
      window.location.assign("/")
      throw new Error("Sign in to continue.")
    }
    if (!response.ok)
      throw new Error("Could not load your library. Please retry.")
    return response.json()
  },
  staleTime: 30_000,
})
export async function action<T = { ok: boolean }>(
  action: string,
  data: unknown = {}
): Promise<T> {
  const response = await fetch("/api/library", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, data }),
  })
  if (response.status === 401) {
    window.location.assign("/")
    throw new Error("Sign in to continue.")
  }
  const result = await response.json()
  if (!response.ok)
    throw new Error(result.error ?? "Something went wrong. Please retry.")
  return result
}
