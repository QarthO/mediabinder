export interface Media {
  id: string
  display_name: string
  raw_name: string
  mime_type: string
  tags: string[]
  created_at: string
  uploaded_at: string
  size: number
  width: number | null
  height: number | null
  duration_ms: number | null
  available: boolean
  cataloged: boolean
  cataloged_at: string | null
  sha256: string | null
  copy_count: number
  drive_id: string
  source_ids: string[]
  parent_ids: string[]
  set_ids: string[]
  post_count: number
}
/** One Drive file of a library item, and where under each linked folder it is. */
export interface ItemCopy {
  drive_id: string
  raw_name: string
  size: number
  mime_type: string
  uploaded_at: string
  locations: {
    folder_name: string
    // Folder names below the linked folder; null until a sync stores the tree.
    path: string[] | null
  }[]
}
export interface MediaSet {
  id: string
  display_name: string
  raw_name: string
  tags: string[]
  created_at: string
  uploaded_at: string | null
  media_count: number
  cover_id: string | null
  post_count: number
}
export interface Post {
  id: string
  media_id: string | null
  set_id: string | null
  platform: string
  url: string
  external_id: string
  created_at: string
}
export interface DriveSource {
  folder_id: string
  folder_name: string
  last_synced_at: string | null
  // Shared-folder mode: MediaBinder added (and will remove) its own access.
  shared_by_app?: boolean | number
}
export interface Library {
  tag_colors: Record<string, string>
  media: Media[]
  sets: MediaSet[]
  posts: Post[]
  workspace: {
    sources: DriveSource[]
    drive_access: {
      mode: "shared-folder" | "full-drive"
      // The address users share folders with (a Google Group or the service account).
      share_address: string | null
      picker: boolean
    }
    webhook: { configured: boolean; active: number; error: string | null }
    last_synced_at: string | null
  }
  user: { name: string; email: string; role: string; image: string | null }
}
export interface SyncRun {
  run_id: string
  origin: "manual" | "automatic"
  status: "running" | "succeeded" | "failed"
  phase: "scanning" | "saving" | "done"
  folders_scanned: number
  files_found: number
  files_saved: number
  files_total: number
  item_count: number | null
  error: string | null
  started_at: string
  finished_at: string | null
}
