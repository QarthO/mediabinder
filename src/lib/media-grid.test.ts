import { describe, expect, it } from "vite-plus/test"
import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MediaGrid } from "@/components/media-grid"
import type { Media } from "./types"

describe("MediaGrid", () => {
  it("server-renders at most sixteen of 178 media cards", () => {
    const items = Array.from({ length: 178 }, (_, i): Media => ({
      id: `media-${i}`,
      display_name: `Photo ${i}`,
      raw_name: `photo-${i}.jpg`,
      mime_type: "image/jpeg",
      tags: [],
      created_at: "2026-09-06T00:00:00Z",
      uploaded_at: "2026-09-06T00:00:00Z",
      size: 3,
      width: 640,
      height: 480,
      duration_ms: null,
      video_codec: null,
      available: true,
      cataloged: true,
      cataloged_at: "2026-09-06T00:00:00Z",
      sha256: null,
      copy_count: 1,
      drive_id: `drive-${i}`,
      source_ids: [],
      parent_ids: [],
      set_ids: [],
      post_count: 0,
    }))
    const client = new QueryClient()
    try {
      const render = () =>
        renderToString(
          createElement(QueryClientProvider, {
            client,
            children: createElement(MediaGrid, {
              items,
              selection: { "media-0": true },
              previewIntent: () => ({
                onPointerEnter: () => {},
                onPointerLeave: () => {},
                onFocus: () => {},
                onBlur: () => {},
              }),
              mobile: false,
              selectionMode: false,
              onOpen: () => {},
              onSelect: () => {},
              allTags: [],
              colors: {},
            }),
          })
        )
      const html = render()
      expect((html.match(/class="media-card"/g) ?? []).length).toBe(16)
      expect(html).toMatch(/data-selected="true"/)
      expect(html).not.toMatch(/Photo 177/)
      expect((render().match(/class="media-card"/g) ?? []).length).toBe(16)
    } finally {
      client.clear()
    }
  })
})
