import { randomUUID } from "node:crypto"
import { expect, test } from "vite-plus/test"

import { describeMysql, useTestDatabase } from "@/test/database"
import {
  act,
  count,
  execute,
  insertFolder,
  library,
  insertMedia,
  insertSet,
  insertUser,
  newUser,
  rejectedStatus,
  rows,
  stubAccessToken,
  stubGoogle,
  syncDrive,
} from "@/test/fixtures"

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
    await execute(
      "INSERT INTO media_source(user_id,folder_id,media_id) VALUES (?,'b',?)",
      [user.id, id]
    )
    const setId = await insertSet(user.id, [id])
    const postId = randomUUID()
    await execute(
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

type Tree = Record<
  string,
  { folders?: [id: string, name: string][]; files?: string[] }
>

// Sets that follow first-level subfolders of a linked folder, through
// `Drive.sync` with Google stubbed at `fetch`.
describeMysql("subfolder sets", () => {
  useTestDatabase()
  const google = stubGoogle()
  stubAccessToken()

  // Drive answers each folder listing from `tree`; every file is a unique
  // photo named after its ID.
  let tree: Tree = {}
  let failing = false
  const serve = () =>
    google((url) => {
      if (failing) return new Response(null, { status: 503 })
      const parent = /'([^']+)' in parents/.exec(
        url.searchParams.get("q") ?? ""
      )?.[1]!
      const node = tree[parent] ?? {}
      return Response.json({
        files: [
          ...(node.folders ?? []).map(([id, name]) => ({
            id,
            name,
            mimeType: "application/vnd.google-apps.folder",
          })),
          ...(node.files ?? []).map((id) => ({
            id,
            name: `${id}.jpg`,
            mimeType: "image/jpeg",
            createdTime: "2026-09-01T00:00:00Z",
            size: "42",
            parents: [parent],
          })),
        ],
      })
    })
  const setup = async (nested = true) => {
    const user = await insertUser()
    const p = user.id
    tree = {
      [`${p}-root`]: {
        folders: [
          [`${p}-flowers`, "flowers"],
          [`${p}-cats`, "cats"],
        ],
        files: [`${p}-loose`],
      },
      [`${p}-flowers`]: {
        folders: nested ? [[`${p}-macro`, "macro"]] : [],
        files: [`${p}-rose`],
      },
      [`${p}-macro`]: { files: [`${p}-bee`] },
      [`${p}-cats`]: { files: [`${p}-tabby`] },
    }
    failing = false
    serve()
    await insertFolder(p, `${p}-root`, "Root")
    return { user, p }
  }
  const sets = (userId: string) =>
    rows<{ id: string; display_name: string; drive_folder_id: string | null }>(
      "SELECT id,display_name,drive_folder_id FROM media_set WHERE user_id=? ORDER BY display_name",
      [userId]
    )
  // Which files (by Drive ID) each set holds, keyed by set name.
  const members = async (userId: string) => {
    const found = await rows<{ name: string; drive_id: string }>(
      `SELECT s.display_name AS name,m.drive_id FROM catalog_set_member sm
       JOIN media_set s ON s.id=sm.set_id JOIN media m ON m.catalog_id=sm.catalog_id
       WHERE s.user_id=? AND m.user_id=? ORDER BY m.drive_id`,
      [userId, userId]
    )
    const result: Record<string, string[]> = {}
    for (const row of found)
      (result[row.name] ??= []).push(row.drive_id.replace(`${userId}-`, ""))
    return result
  }

  test("first-level subfolders become sets, nested files join the outermost, root files join none", async () => {
    const { user } = await setup()
    await syncDrive(user.id)
    expect(await members(user.id)).toEqual({
      cats: ["tabby"],
      flowers: ["bee", "rose"],
    })
    expect((await sets(user.id)).map((set) => set.display_name)).toEqual([
      "cats",
      "flowers",
    ])
  })

  test("syncing again duplicates nothing, and a file added later joins", async () => {
    const { user, p } = await setup()
    await syncDrive(user.id)
    await syncDrive(user.id)
    expect(await sets(user.id)).toHaveLength(2)
    expect(await count("catalog_set_member")).toBe(3)

    tree[`${p}-cats`].files!.push(`${p}-siamese`)
    await syncDrive(user.id)
    expect((await members(user.id)).cats).toEqual(["siamese", "tabby"])
    expect(await sets(user.id)).toHaveLength(2)
  })

  test("a pre-existing same-named set is adopted, ambiguity creates a new one, others' sets are untouched", async () => {
    const { user, p } = await setup()
    const other = await insertUser()
    const mine = await insertSet(user.id, [], "Flowers")
    const theirs = await insertSet(other.id, [], "cats")
    // Two sets named like the folder is ambiguous: nothing is adopted.
    await insertSet(user.id, [], "Cats")
    await insertSet(user.id, [], "CATS")
    await syncDrive(user.id)

    const own = await sets(user.id)
    expect(own.find((set) => set.id === mine)?.drive_folder_id).toBe(
      `${p}-flowers`
    )
    expect(
      own.filter((set) => set.display_name.toLowerCase() === "cats")
    ).toHaveLength(3)
    const created = own.find((set) => set.drive_folder_id === `${p}-cats`)!
    expect([mine, theirs]).not.toContain(created.id)
    expect(await count("catalog_set_member WHERE set_id=?", [mine])).toBe(2)
    expect(await count("catalog_set_member WHERE set_id=?", [created.id])).toBe(
      1
    )
    expect(await count("catalog_set_member WHERE set_id=?", [theirs])).toBe(0)
    expect((await sets(other.id)).map((set) => set.drive_folder_id)).toEqual([
      null,
    ])
  })

  test("a manual removal sticks, and a moved file joins the new set and keeps the old one", async () => {
    const { user, p } = await setup(false)
    await syncDrive(user.id)
    const flowers = (await sets(user.id)).find(
      (set) => set.display_name === "flowers"
    )!
    const [rose] = await rows<{ id: string }>(
      "SELECT catalog_id AS id FROM media WHERE user_id=? AND drive_id=?",
      [user.id, `${p}-rose`]
    )
    await act(user, "set-membership", {
      id: rose.id,
      setId: flowers.id,
      remove: true,
    })
    await syncDrive(user.id)
    expect((await members(user.id)).flowers).toBeUndefined()

    // Moved in Drive from flowers to cats.
    await act(user, "set-membership", { id: rose.id, setId: flowers.id })
    tree[`${p}-flowers`].files = []
    tree[`${p}-cats`].files!.push(`${p}-rose`)
    await syncDrive(user.id)
    const held = await members(user.id)
    expect(held.cats).toEqual(["rose", "tabby"])
    expect(held.flowers).toEqual(["rose"])
  })

  test("a set renamed in MediaBinder is reused, and a deleted set is not recreated", async () => {
    const { user, p } = await setup()
    await syncDrive(user.id)
    const [flowers, cats] = [
      (await sets(user.id)).find((set) => set.display_name === "flowers")!,
      (await sets(user.id)).find((set) => set.display_name === "cats")!,
    ]
    await execute("UPDATE media_set SET display_name='Garden' WHERE id=?", [
      flowers.id,
    ])
    // Drive's folder is renamed too: the user's name still wins.
    tree[`${p}-root`].folders![0][1] = "blooms"
    tree[`${p}-flowers`].files!.push(`${p}-tulip`)
    await syncDrive(user.id)
    expect((await sets(user.id)).map((set) => set.display_name)).toEqual([
      "cats",
      "Garden",
    ])
    expect((await members(user.id)).Garden).toEqual(["bee", "rose", "tulip"])

    // Deleting an auto-created set keeps it deleted, even as files arrive.
    await act(user, "delete-set", { id: cats.id })
    tree[`${p}-cats`].files!.push(`${p}-siamese`)
    await syncDrive(user.id)
    expect((await sets(user.id)).map((set) => set.display_name)).toEqual([
      "Garden",
    ])
    // A set the user makes with the folder's name takes it over from then on.
    const again = await insertSet(user.id, [], "cats")
    tree[`${p}-cats`].files!.push(`${p}-persian`)
    await syncDrive(user.id)
    expect(
      (await sets(user.id)).find((set) => set.id === again)?.drive_folder_id
    ).toBe(`${p}-cats`)
    expect((await members(user.id)).cats).toEqual(["persian"])
  })

  test("a linked subfolder pairs under each linked folder without duplicates", async () => {
    const { user, p } = await setup()
    await insertFolder(p, `${p}-flowers`, "Flowers root")
    await syncDrive(user.id)
    // Under the root the files belong to "flowers" and "macro" only by the
    // outermost folder; as a linked root, "macro" is its own first-level set.
    expect(await members(user.id)).toEqual({
      cats: ["tabby"],
      flowers: ["bee", "rose"],
      macro: ["bee"],
    })
    await syncDrive(user.id)
    expect(await count("catalog_set_member")).toBe(4)
    expect(await sets(user.id)).toHaveLength(3)
  })

  test("a failed scan creates no sets", async () => {
    const { user } = await setup()
    failing = true
    await expect(syncDrive(user.id)).rejects.toThrow()
    expect(await sets(user.id)).toHaveLength(0)
    expect(await count("drive_folder_set_applied")).toBe(0)
  })
})
