import { test } from "node:test"
import assert from "node:assert/strict"
import { newPost, metadata, folder, folderIdFromInput } from "./validation"
const targetId = "a6507f20-de60-48a4-a04d-e911c64f5f9e"
test("post links stay platform agnostic and reject executable URLs", () => {
  const post = {
    targetId,
    kind: "media",
    platform: "My photo journal",
    url: "https://example.com/posts/42",
    createdAt: "2026-09-05T12:00:00Z",
  }
  assert.equal(newPost.parse(post).platform, "My photo journal")
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
  ])
    assert.equal(newPost.safeParse({ ...post, url }).success, false)
})
test("folder IDs cannot inject Drive queries; metadata normalizes tags", () => {
  assert.equal(
    folder.parse({
      folderId: folderIdFromInput(
        "https://drive.google.com/drive/folders/Example_123-abc?usp=sharing"
      ),
    }).folderId,
    "Example_123-abc"
  )
  assert.equal(
    folder.safeParse({ folderId: "foo' or trashed = false" }).success,
    false
  )
  const result = metadata.parse({
    id: targetId,
    kind: "media",
    displayName: "A frame",
    tags: ["Travel", "travel", " blue "],
    createdAt: "2026-09-05T00:00:00Z",
  })
  assert.deepEqual(result.tags, ["travel", "blue"])
})
