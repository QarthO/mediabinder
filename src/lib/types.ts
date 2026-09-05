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
export interface Library {
  media: Media[]
  sets: MediaSet[]
  posts: Post[]
  workspace: {
    folder_id: string | null
    folder_name: string | null
    last_synced_at: string | null
  }
  user: { name: string; email: string; role: string }
}
