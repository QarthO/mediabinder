import { randomUUID } from "node:crypto"
import { expect, test } from "vite-plus/test"

import { describeMysql, useTestDatabase } from "@/test/database"
import {
  act,
  count,
  insertFolder,
  library,
  insertMedia,
  insertSet,
  newUser,
  rejectedStatus,
} from "@/test/fixtures"
import { pool, rows } from "./database.server"

// Tagging, sets and folder unlinking through the library's mutate entry point.
describeMysql("library edits", () => {
  useTestDatabase()

  test("edits are limited to the owner and a rejected request changes nothing", async () => {
    const user = newUser()
    const other = newUser()
    const id = await insertMedia({ userId: user.id, tags: ["kept"] })
    const setId = await insertSet(user.id, [])

    await act(user, "add-tags", { ids: [id, id], tags: ["KEPT", "bulk"] })
    expect((await library(user)).media[0].tags).toEqual(["kept", "bulk"])

    // Another user cannot touch it.
    for (const attempt of [
      () => act(other, "add-tags", { ids: [id], tags: ["unauthorized"] }),
      () => act(other, "remove-tag", { id, tag: "kept" }),
      () => act(other, "tag-color", { name: "bulk", color: "#ff0000" }),
      () => act(other, "set-membership", { id, setId, remove: true }),
      () => act(other, "set-membership", { id, displayName: "Unauthorized" }),
    ])
      expect(await rejectedStatus(attempt())).toBe(404)
    expect(await count("media_set WHERE user_id=?", [other.id])).toBe(0)

    // A request naming one id the user does not own is rejected whole.
    expect(
      await rejectedStatus(
        act(user, "add-tags", { ids: [id, randomUUID()], tags: ["partial"] })
      )
    ).toBe(404)
    expect((await library(user)).media[0].tags).toEqual(["kept", "bulk"])
  })

  test("tag colors persist: assigned once, kept when the tag is added again", async () => {
    const user = newUser()
    const id = await insertMedia({ userId: user.id })

    await act(user, "add-tags", { ids: [id], tags: ["bulk"] })
    expect((await library(user)).tag_colors.bulk).toMatch(/^#[0-9a-f]{6}$/)
    await act(user, "tag-color", { name: "bulk", color: "#38bdf8" })
    await act(user, "add-tags", { ids: [id], tags: ["bulk"] })
    expect((await library(user)).tag_colors.bulk).toBe("#38bdf8")

    await act(user, "remove-tag", { id, tag: "bulk" })
    expect((await library(user)).media[0].tags).toEqual([])
  })

  test("set membership: join, create inline, leave, and metadata edits keep both", async () => {
    const user = newUser()
    const id = await insertMedia({ userId: user.id, tags: ["kept"] })
    const setId = await insertSet(user.id, [])

    await act(user, "set-membership", { id, setId })
    expect((await library(user)).media[0].set_ids).toEqual([setId])
    const created = (await act(user, "set-membership", {
      id,
      displayName: "New inline set",
    })) as { id: string }
    await act(user, "metadata", {
      id,
      kind: "media",
      displayName: "Edited name",
      createdAt: new Date().toISOString(),
    })
    const edited = (await library(user)).media[0]
    expect(edited.tags).toEqual(["kept"])
    expect(edited.set_ids).toHaveLength(2)

    await act(user, "set-membership", { id, setId: created.id, remove: true })
    expect((await library(user)).media[0].set_ids).toEqual([setId])
    await act(user, "delete-set", { id: created.id })
    expect(
      await rejectedStatus(
        act(user, "set-membership", { id, setId: randomUUID() })
      )
    ).toBe(404)
  })

  test("unlinking a folder hides only media no other folder holds, and keeps curation", async () => {
    const user = newUser()
    const other = newUser()
    await insertFolder(user.id, "a", "A")
    await insertFolder(user.id, "b", "B")
    await insertFolder(other.id, "a", "Other A")
    const id = await insertMedia({
      userId: user.id,
      name: "Edited name",
      tags: ["kept"],
      folder: "a",
    })
    await pool.execute(
      "INSERT INTO media_source(user_id,folder_id,media_id) VALUES (?,'b',?)",
      [user.id, id]
    )
    const setId = await insertSet(user.id, [id])
    const postId = randomUUID()
    await pool.execute(
      "INSERT INTO post(id,user_id,media_id,catalog_id,platform,url,created_at) VALUES (?,?,?,?,'Anywhere','https://example.com/post',NOW(3))",
      [postId, user.id, id, id]
    )

    // Still in folder B: nothing disappears, and the other user is untouched.
    await act(user, "remove-source", { folderId: "a" })
    let result = await library(user)
    expect(result.media).toHaveLength(1)
    expect(result.workspace.sources).toHaveLength(1)
    expect(result.sets[0].media_count).toBe(1)
    expect(result.posts).toHaveLength(1)
    expect(await count("drive_folder WHERE user_id=?", [other.id])).toBe(1)

    await act(user, "remove-source", { folderId: "b" })
    result = await library(user)
    expect(result.media).toHaveLength(0)
    expect(result.posts).toHaveLength(0)
    expect(result.sets[0].media_count).toBe(0)
    expect(result.sets[0].cover_id).toBeNull()

    // The curation is retained for if the folder is linked again.
    const [retained] = await rows<{ display_name: string; available: number }>(
      "SELECT display_name,available FROM media WHERE id=?",
      [id]
    )
    expect(retained).toEqual({ display_name: "Edited name", available: 0 })
    const [catalog] = await rows<{ tags: string[] }>(
      "SELECT tags FROM catalog WHERE id=?",
      [id]
    )
    expect(catalog.tags).toEqual(["kept"])
    expect(await count("post WHERE id=?", [postId])).toBe(1)
    expect(await count("catalog_set_member WHERE set_id=?", [setId])).toBe(1)
  })

  test("equal upload dates keep their order across tag and set edits", async () => {
    const user = newUser()
    const ids = Array.from({ length: 30 }, () => randomUUID()).sort()
    for (const id of [...ids].reverse())
      await insertMedia({ userId: user.id, id, name: "Same name" })
    const orderedIds = async () =>
      (await library(user)).media.map((media) => media.id)
    expect(await orderedIds()).toEqual(ids)

    for (const id of ids.slice(0, 3)) {
      await act(user, "add-tags", {
        ids: [id],
        tags: ["a tag that changes the row payload", "another tag"],
      })
      expect(await orderedIds()).toEqual(ids)
      await act(user, "set-membership", { id, displayName: "Ordering set" })
      expect(await orderedIds()).toEqual(ids)
    }
  })

  test("one set can contain media from separate folders", async () => {
    const user = newUser()
    await insertFolder(user.id, "folder-a")
    await insertFolder(user.id, "folder-b")
    const first = await insertMedia({ userId: user.id, folder: "folder-a" })
    const second = await insertMedia({ userId: user.id, folder: "folder-b" })

    const set = (await act(user, "set-membership", {
      id: first,
      displayName: "Across folders",
    })) as { id: string }
    await act(user, "set-membership", { id: second, setId: set.id })

    const result = await library(user)
    expect(result.sets[0].media_count).toBe(2)
    expect(result.media.every((media) => media.set_ids.includes(set.id))).toBe(
      true
    )
    expect(
      new Set(result.media.flatMap((media) => media.source_ids)).size
    ).toBe(2)
  })
})
