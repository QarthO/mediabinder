import { randomUUID } from "node:crypto"
import assert from "node:assert/strict"
import { test, after } from "node:test"
import { pool, rows } from "../src/lib/database.server"
import { library, mutate } from "../src/lib/library.server"

async function seedCatalog(userId: string) {
  await pool.execute(
    "INSERT IGNORE INTO catalog(id,display_name,tags,created_at) SELECT id,display_name,tags,created_at FROM media WHERE user_id=?",
    [userId]
  )
  await pool.execute(
    "UPDATE media SET catalog_id=id WHERE user_id=? AND catalog_id IS NULL",
    [userId]
  )
  await pool.execute(
    "INSERT IGNORE INTO catalog_set_member SELECT sm.set_id,sm.media_id FROM set_member sm JOIN media m ON m.id=sm.media_id WHERE m.user_id=?",
    [userId]
  )
  await pool.execute("UPDATE post SET catalog_id=media_id WHERE user_id=?", [
    userId,
  ])
}
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
    await seedCatalog(userId)
    await mutate(
      "add-tags",
      { ids: [mediaId, mediaId], tags: ["KEPT", "bulk"] },
      userId,
      new Headers()
    )
    assert.match((await library(user)).tag_colors.bulk, /^#[0-9a-f]{6}$/)
    await mutate(
      "tag-color",
      { name: "bulk", color: "#38bdf8" },
      userId,
      new Headers()
    )
    await assert.rejects(() =>
      mutate(
        "tag-color",
        { name: "bulk", color: "#ff0000" },
        otherUser,
        new Headers()
      )
    )
    await mutate(
      "add-tags",
      { ids: [mediaId], tags: ["bulk"] },
      userId,
      new Headers()
    )
    assert.equal((await library(user)).tag_colors.bulk, "#38bdf8")
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
    await assert.rejects(() =>
      mutate(
        "remove-tag",
        { id: mediaId, tag: "kept" },
        otherUser,
        new Headers()
      )
    )
    await mutate(
      "remove-tag",
      { id: mediaId, tag: "bulk" },
      userId,
      new Headers()
    )
    assert.deepEqual((await library(user)).media[0].tags, ["kept"])
    const membership = (input: unknown, owner = userId) =>
      mutate("set-membership", input, owner, new Headers())
    await assert.rejects(() =>
      membership({ id: mediaId, setId, remove: true }, otherUser)
    )
    await membership({ id: mediaId, setId })
    assert.deepEqual((await library(user)).media[0].set_ids, [setId])
    const createdSet = (await membership({
      id: mediaId,
      displayName: "New inline set",
    })) as { id: string }
    await mutate(
      "metadata",
      {
        id: mediaId,
        kind: "media",
        displayName: "Edited name",
        createdAt: new Date().toISOString(),
      },
      userId,
      new Headers()
    )
    assert.deepEqual((await library(user)).media[0].tags, ["kept"])
    assert.equal((await library(user)).media[0].set_ids.length, 2)
    await membership({ id: mediaId, setId: createdSet.id, remove: true })
    assert.deepEqual((await library(user)).media[0].set_ids, [setId])
    await mutate("delete-set", { id: createdSet.id }, userId, new Headers())
    await assert.rejects(() => membership({ id: mediaId, setId: randomUUID() }))
    await assert.rejects(() =>
      membership({ id: mediaId, displayName: "Unauthorized" }, otherUser)
    )
    assert.equal(
      (
        await rows<{ count: number }>(
          "SELECT COUNT(*) AS count FROM media_set WHERE user_id=?",
          [otherUser]
        )
      )[0].count,
      0
    )

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
    assert.deepEqual(retained.tags, ["kept"])
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
    await pool.execute("DELETE FROM tag_definition WHERE user_id=?", [userId])
    await pool.execute("DELETE FROM drive_sync_state WHERE user_id=?", [userId])
    await pool.execute("DELETE FROM media WHERE user_id=?", [userId])
    await pool.execute("DELETE FROM media_set WHERE user_id=?", [userId])
  }
})

test("equal upload dates keep their order across tag and set edits", async () => {
  const userId = randomUUID()
  const user = {
    id: userId,
    name: "Ordering regression",
    email: "ordering@example.com",
    role: "user",
  }
  const ids = Array.from({ length: 30 }, () => randomUUID()).sort()
  try {
    // Insert in reverse order, with equal names/dates/sizes and different tag lengths.
    for (const id of [...ids].reverse())
      await pool.execute(
        "INSERT INTO media (id,user_id,drive_id,display_name,raw_name,mime_type,tags,created_at,uploaded_at,size,available,synced_at) VALUES (?,?,?,'Same name','same.jpg','image/jpeg','[]','2026-09-01','2026-09-01',42,TRUE,NOW(3))",
        [id, userId, id]
      )
    await seedCatalog(userId)
    const orderedIds = async () =>
      (await library(user)).media.map((media) => media.id)
    assert.deepEqual(await orderedIds(), ids)
    for (const id of ids.slice(0, 3)) {
      await mutate(
        "add-tags",
        {
          ids: [id],
          tags: ["a tag that changes the row payload", "another tag"],
        },
        userId,
        new Headers()
      )
      assert.deepEqual(await orderedIds(), ids)
      await mutate(
        "set-membership",
        { id, displayName: "Ordering set" },
        userId,
        new Headers()
      )
      assert.deepEqual(await orderedIds(), ids)
    }
  } finally {
    await pool.execute("DELETE FROM media WHERE user_id=?", [userId])
    await pool.execute("DELETE FROM media_set WHERE user_id=?", [userId])
    await pool.execute("DELETE FROM tag_definition WHERE user_id=?", [userId])
  }
})

test("one set can contain media from separate Drive folders", async () => {
  const userId = randomUUID(),
    first = randomUUID(),
    second = randomUUID()
  const user = {
    id: userId,
    name: "Cross-folder set",
    email: "cross-folder@example.com",
    role: "user",
  }
  try {
    for (const [id, folderId] of [
      [first, "folder-a"],
      [second, "folder-b"],
    ]) {
      await pool.execute(
        "INSERT INTO drive_folder (user_id,folder_id,folder_name) VALUES (?,?,?)",
        [userId, folderId, folderId]
      )
      await pool.execute(
        "INSERT INTO media (id,user_id,drive_id,display_name,raw_name,mime_type,tags,created_at,uploaded_at,size,available,synced_at) VALUES (?,?,?,'Fixture','fixture.jpg','image/jpeg','[]',NOW(3),NOW(3),42,TRUE,NOW(3))",
        [id, userId, id]
      )
      await pool.execute(
        "INSERT INTO media_source (user_id,folder_id,media_id) VALUES (?,?,?)",
        [userId, folderId, id]
      )
    }
    await seedCatalog(userId)
    const set = (await mutate(
      "set-membership",
      { id: first, displayName: "Across folders" },
      userId,
      new Headers()
    )) as { id: string }
    await mutate(
      "set-membership",
      { id: second, setId: set.id },
      userId,
      new Headers()
    )
    const result = await library(user)
    assert.equal(result.sets[0].media_count, 2)
    assert.ok(result.media.every((media) => media.set_ids.includes(set.id)))
    assert.equal(
      new Set(result.media.flatMap((media) => media.source_ids)).size,
      2
    )
  } finally {
    await pool.execute("DELETE FROM drive_folder WHERE user_id=?", [userId])
    await pool.execute("DELETE FROM media WHERE user_id=?", [userId])
    await pool.execute("DELETE FROM media_set WHERE user_id=?", [userId])
  }
})
