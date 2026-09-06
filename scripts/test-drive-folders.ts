import { randomUUID } from "node:crypto"
import assert from "node:assert/strict"
import { test, after } from "node:test"
import { pool, rows } from "../src/lib/database.server"
import { library, mutate } from "../src/lib/library.server"

after(() => pool.end())
test("tag additions and unlinking preserve metadata and user isolation", async () => {
  const userId = randomUUID(),
    otherUser = randomUUID(),
    mediaId = randomUUID(),
    setId = randomUUID(),
    postId = randomUUID()
  const user = {
    id: userId,
    name: "Folder regression",
    email: "fixture@example.com",
    role: "user",
  }
  try {
    await pool.execute(
      "INSERT INTO drive_folder (user_id,folder_id,folder_name) VALUES (?, 'a', 'A'), (?, 'b', 'B'), (?, 'a', 'Other A')",
      [userId, userId, otherUser]
    )
    await pool.execute(
      "INSERT INTO media (id,user_id,drive_id,display_name,raw_name,mime_type,tags,created_at,uploaded_at,size,available,synced_at) VALUES (?,?,'fixture','Edited name','original.jpg','image/jpeg',?,NOW(3),NOW(3),42,TRUE,NOW(3))",
      [mediaId, userId, JSON.stringify(["kept"])]
    )
    await pool.execute(
      "INSERT INTO media_set (id,user_id,display_name,raw_name,tags,created_at) VALUES (?,?,'Set','Set','[]',NOW(3))",
      [setId, userId]
    )
    await pool.execute(
      "INSERT INTO set_member (set_id,media_id) VALUES (?,?)",
      [setId, mediaId]
    )
    await pool.execute(
      "INSERT INTO post (id,user_id,media_id,platform,url,external_id,created_at) VALUES (?,?,?,'Anywhere','https://example.com/post','42',NOW(3))",
      [postId, userId, mediaId]
    )
    await pool.execute(
      "INSERT INTO media_source (user_id,folder_id,media_id) VALUES (?,'a',?), (?,'b',?)",
      [userId, mediaId, userId, mediaId]
    )
    await mutate(
      "add-tags",
      { ids: [mediaId, mediaId], tags: ["KEPT", "bulk"] },
      userId,
      new Headers()
    )
    await assert.rejects(() =>
      mutate(
        "add-tags",
        { ids: [mediaId], tags: ["unauthorized"] },
        otherUser,
        new Headers()
      )
    )
    await assert.rejects(() =>
      mutate(
        "add-tags",
        { ids: [mediaId, randomUUID()], tags: ["partial"] },
        userId,
        new Headers()
      )
    )
    assert.deepEqual((await library(user)).media[0].tags, ["kept", "bulk"])
    await mutate("remove-source", { folderId: "a" }, userId, new Headers())
    let result = await library(user)
    assert.equal(result.media.length, 1)
    assert.equal(result.workspace.sources.length, 1)
    assert.equal(result.sets[0].media_count, 1)
    assert.equal(result.posts.length, 1)
    assert.equal(
      (
        await rows("SELECT folder_id FROM drive_folder WHERE user_id=?", [
          otherUser,
        ])
      ).length,
      1
    )
    await mutate("remove-source", { folderId: "b" }, userId, new Headers())
    result = await library(user)
    assert.equal(result.media.length, 0)
    assert.equal(result.posts.length, 0)
    assert.equal(result.sets[0].media_count, 0)
    assert.equal(result.sets[0].cover_id, null)
    const [retained] = await rows<{
      display_name: string
      tags: string[]
      available: number
    }>("SELECT display_name,tags,available FROM media WHERE id=?", [mediaId])
    assert.equal(retained.display_name, "Edited name")
    assert.deepEqual(retained.tags, ["kept", "bulk"])
    assert.equal(retained.available, 0)
    assert.equal(
      (await rows("SELECT id FROM post WHERE id=?", [postId])).length,
      1
    )
    assert.equal(
      (
        await rows("SELECT media_id FROM set_member WHERE media_id=?", [
          mediaId,
        ])
      ).length,
      1
    )
  } finally {
    await pool.execute("DELETE FROM drive_folder WHERE user_id IN (?,?)", [
      userId,
      otherUser,
    ])
    await pool.execute("DELETE FROM media WHERE user_id=?", [userId])
    await pool.execute("DELETE FROM media_set WHERE user_id=?", [userId])
  }
})
