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
  drive_id: string
  source_ids: string[]
  parent_ids: string[]
  set_ids: string[]
  post_count: number
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
}
export interface Library {
  tag_colors: Record<string, string>
  media: Media[]
  sets: MediaSet[]
  posts: Post[]
  workspace: {
    sources: DriveSource[]
    webhook: { configured: boolean; active: number; error: string | null }
    last_synced_at: string | null
  }
  user: { name: string; email: string; role: string }
}
