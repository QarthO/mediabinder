import { describe, expect, it } from "vite-plus/test"
import { newPost, metadata, folder, folderIdFromInput } from "./validation"

const targetId = "a6507f20-de60-48a4-a04d-e911c64f5f9e"

describe("validation", () => {
  it("keeps post links platform agnostic and rejects executable URLs", () => {
    const post = {
      targetId,
      kind: "media",
      platform: "My photo journal",
      url: "https://example.com/posts/42",
      createdAt: "2026-09-05T12:00:00Z",
    }
    expect(newPost.parse(post).platform).toBe("My photo journal")
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
    ])
      expect(newPost.safeParse({ ...post, url }).success).toBe(false)
  })

  it("stops folder IDs injecting Drive queries and normalizes tags", () => {
    expect(
      folder.parse({
        folderId: folderIdFromInput(
          "https://drive.google.com/drive/folders/Example_123-abc?usp=sharing"
        ),
      }).folderId
    ).toBe("Example_123-abc")
    expect(
      folder.safeParse({ folderId: "foo' or trashed = false" }).success
    ).toBe(false)
    const result = metadata.parse({
      id: targetId,
      kind: "media",
      displayName: "A frame",
      tags: ["Travel", "travel", " blue "],
      createdAt: "2026-09-05T00:00:00Z",
    })
    expect(result.tags).toEqual(["travel", "blue"])
  })
})
