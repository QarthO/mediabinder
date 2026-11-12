import { randomBytes, randomUUID } from "node:crypto"
import { expect, test } from "vite-plus/test"

import { describeMysql, useTestDatabase } from "@/test/database"
import {
  act,
  count,
  insertFolder,
  newUser,
  rejectedStatus,
  stubAccessToken,
  stubGoogle,
} from "@/test/fixtures"
import { Effect } from "effect"
import { resolve, transaction } from "./catalog.server"
import { runTracedAppEffect } from "@/effect/runtime.server"
import { rows } from "./database.server"
import { syncDrive, type DriveFile } from "./drive.server"
import { library } from "./library.server"

const hash = () => randomBytes(32).toString("hex")
const file = (
  id: string,
  name: string,
  sha256Checksum?: string
): DriveFile => ({
  id,
  name,
  mimeType: "image/jpeg",
  createdTime: "2026-09-01T00:00:00Z",
  size: "42",
  sha256Checksum,
  parents: ["parent"],
})

// Several users syncing the same bytes share one catalog item: its name, tags,
// sets and posts are common, while access follows each user's own copies.
describeMysql("shared catalog", () => {
  useTestDatabase()
  const google = stubGoogle()
  // The access token is the user's id, so the fake Drive can tell who asks.
  stubAccessToken((userId) => userId ?? "")

  // Two users with one folder each (the first with two), and a Drive that
  // lists whatever `drive[userId]` currently holds.
  async function scenario() {
    const a = newUser(),
      b = newUser(),
      outsider = newUser()
    const drive: Record<string, DriveFile[]> = { [a.id]: [], [b.id]: [] }
    let failing = false
    google((url, init) => {
      expect(url.hostname).toBe("www.googleapis.com")
      if (failing) return new Response(null, { status: 503 })
      const token = new Headers(init.headers)
        .get("authorization")
        ?.replace("Bearer ", "")
      return Response.json({ files: drive[token ?? ""] ?? [] })
    })
    const prefix = randomUUID()
    await insertFolder(a.id, `${prefix}-folder-a`)
    await insertFolder(a.id, `${prefix}-folder-a2`)
    await insertFolder(b.id, `${prefix}-folder-b`)
    return {
      a,
      b,
      outsider,
      drive,
      prefix,
      fail: (value: boolean) => (failing = value),
    }
  }

  test("identical bytes are one item, and curation reaches every user who has them", async () => {
    const { a, b, outsider, drive, prefix } = await scenario()
    const bytes = hash()
    drive[a.id] = [
      file("one", "original.jpg", bytes),
      file("two", "different-name.jpg", bytes),
    ]
    drive[b.id] = [file("three", "another-name.jpg", bytes)]

    await syncDrive(a.id)
    const mine = (await library(a)).media
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ copy_count: 2, cataloged: false })
    expect(mine[0].source_ids).toHaveLength(2)
    const target = mine[0].id

    await act(a, "add-tags", { ids: [target], tags: ["shared"] })
    await act(a, "metadata", {
      id: target,
      kind: "media",
      displayName: "Curated name",
      createdAt: "2026-08-01T00:00:00Z",
    })
    const set = (await act(a, "set-membership", {
      id: target,
      displayName: "Shared set",
    })) as { id: string }
    await act(a, "create-post", {
      kind: "media",
      targetId: target,
      platform: "Example",
      url: "https://example.com/post",
      createdAt: "2026-09-01T00:00:00Z",
    })

    await syncDrive(b.id)
    const shared = await library(b)
    expect(shared.media[0]).toMatchObject({
      id: target,
      copy_count: 1,
      drive_id: "three",
      display_name: "Curated name",
      tags: ["shared"],
      cataloged: true,
      set_ids: [set.id],
      source_ids: [`${prefix}-folder-b`],
    })
    expect(shared.sets[0].media_count).toBe(1)
    expect(shared.posts[0].media_id).toBe(target)

    // A user with no copy sees nothing and cannot edit it.
    expect((await library(outsider)).media).toHaveLength(0)
    expect((await library(outsider)).sets).toHaveLength(0)
    expect(
      await rejectedStatus(
        act(outsider, "add-tags", { ids: [target], tags: ["forbidden"] })
      )
    ).toBe(404)
  })

  test("tags and colors are shared, and concurrent edits by two users both land", async () => {
    const { a, b, drive } = await scenario()
    const bytes = hash()
    drive[a.id] = [file("one", "a.jpg", bytes)]
    drive[b.id] = [file("two", "b.jpg", bytes)]
    await syncDrive(a.id)
    await syncDrive(b.id)
    const target = (await library(a)).media[0].id
    await act(a, "add-tags", { ids: [target], tags: ["shared"] })

    await Promise.all([
      act(a, "add-tags", { ids: [target], tags: ["a"] }),
      act(b, "add-tags", { ids: [target], tags: ["b"] }),
    ])
    expect(new Set((await library(a)).media[0].tags)).toEqual(
      new Set(["shared", "a", "b"])
    )

    await act(b, "remove-tag", { id: target, tag: "shared" })
    expect((await library(a)).media[0].tags).not.toContain("shared")
    await act(b, "tag-color", { name: "b", color: "#38bdf8" })
    expect((await library(a)).tag_colors.b).toBe("#38bdf8")
  })

  test("bulk edits that include an item the user cannot access are rejected whole", async () => {
    const { a, b, drive } = await scenario()
    const shared = hash()
    drive[a.id] = [file("one", "a.jpg", shared)]
    drive[b.id] = [file("two", "b.jpg", shared)]
    await syncDrive(a.id)
    await syncDrive(b.id)
    drive[a.id].push(file("private", "private.jpg", hash()))
    await syncDrive(a.id)
    const items = (await library(a)).media
    const target = items.find(
      (m) => m.copy_count === 1 && m.drive_id === "one"
    )!.id
    const privateId = items.find((m) => m.drive_id === "private")!.id
    const ids = [target, privateId]

    expect(
      await rejectedStatus(
        act(b, "add-tags", { ids: [privateId], tags: ["forbidden"] })
      )
    ).toBe(404)

    await act(a, "add-tags", { ids, tags: ["bulk-toggle"] })
    expect(
      await rejectedStatus(
        act(b, "remove-tags", { ids, tags: ["bulk-toggle"] })
      )
    ).toBe(404)
    expect(
      (await library(a)).media.every((m) => m.tags.includes("bulk-toggle"))
    ).toBe(true)
    await act(a, "remove-tags", { ids, tags: ["bulk-toggle"] })
    expect(
      (await library(a)).media.some((m) => m.tags.includes("bulk-toggle"))
    ).toBe(false)

    // An item b cannot see, added to a set b can see, does not count for b.
    const visibleSet = (await act(a, "set-membership", {
      id: target,
      displayName: "Visible set",
    })) as { id: string }
    await act(a, "set-membership", { id: privateId, setId: visibleSet.id })
    expect(
      (await library(b)).sets.find((s) => s.id === visibleSet.id)!.media_count
    ).toBe(1)

    const bulkSet = (await act(a, "set-membership", {
      ids,
      displayName: "Bulk set",
    })) as { id: string }
    expect(
      (await library(a)).media.every((m) => m.set_ids.includes(bulkSet.id))
    ).toBe(true)
    expect(
      await rejectedStatus(
        act(b, "set-membership", { ids, setId: bulkSet.id, remove: true })
      )
    ).toBe(404)
    expect(
      await rejectedStatus(
        act(b, "set-membership", { ids, displayName: "Forbidden bulk set" })
      )
    ).toBe(404)
    expect(
      (await library(a)).sets.some(
        (s) => s.display_name === "Forbidden bulk set"
      )
    ).toBe(false)
    expect(
      (await library(a)).media.every((m) => m.set_ids.includes(bulkSet.id))
    ).toBe(true)

    await act(a, "set-membership", { ids, setId: bulkSet.id, remove: true })
    expect(
      (await library(a)).media.some((m) => m.set_ids.includes(bulkSet.id))
    ).toBe(false)
  })

  test("replaced bytes return to the inbox, and the same bytes later recover the old curation", async () => {
    const { a, b, drive } = await scenario()
    const original = hash()
    drive[a.id] = [file("one", "a.jpg", original)]
    drive[b.id] = [file("three", "b.jpg", original)]
    await syncDrive(a.id)
    await syncDrive(b.id)
    const target = (await library(a)).media[0].id
    await act(a, "metadata", {
      id: target,
      kind: "media",
      displayName: "Curated name",
      createdAt: "2026-08-01T00:00:00Z",
    })
    await act(a, "add-tags", { ids: [target], tags: ["shared"] })

    // New bytes under an existing Drive id are a different item.
    drive[b.id] = [file("three", "new-content.jpg", hash())]
    await syncDrive(b.id)
    const changed = (await library(b)).media[0]
    expect(changed.id).not.toBe(target)
    expect(changed).toMatchObject({ cataloged: false, tags: [] })
    expect(
      (await library(a)).media.find((m) => m.id === target)!.display_name
    ).toBe("Curated name")

    // An identical upload, even under a new name, finds the old item again.
    drive[b.id] = [file("reupload", "reuploaded.jpg", original)]
    await syncDrive(b.id)
    expect((await library(b)).media[0].id).toBe(target)
  })

  test("files without a checksum match only on their Drive id", async () => {
    const { a, b, drive } = await scenario()
    drive[a.id] = [file("nohash", "same.jpg")]
    drive[b.id] = [file("nohash", "same.jpg"), file("nohash-other", "same.jpg")]
    await syncDrive(a.id)
    await syncDrive(b.id)

    // Same Drive id: one item. A coincidental name and size: a separate one.
    expect((await library(b)).media).toHaveLength(2)
    const [mine] = (await library(a)).media
    await act(a, "add-tags", { ids: [mine.id], tags: ["same-drive"] })
    expect(
      (await library(b)).media.filter((m) => m.tags.includes("same-drive"))
    ).toHaveLength(1)
  })

  test("a failed sync keeps the library, and unlinking removes only that user's access", async () => {
    const { a, b, drive, prefix, fail } = await scenario()
    const bytes = hash()
    drive[a.id] = [file("one", "a.jpg", bytes)]
    drive[b.id] = [file("two", "b.jpg", bytes)]
    await syncDrive(a.id)
    await syncDrive(b.id)
    const target = (await library(a)).media[0].id

    fail(true)
    await expect(syncDrive(b.id)).rejects.toThrow()
    expect((await library(b)).media).toHaveLength(1)
    fail(false)

    await act(a, "remove-source", { folderId: `${prefix}-folder-a` })
    expect((await library(a)).media).toHaveLength(1)
    await act(a, "remove-source", { folderId: `${prefix}-folder-a2` })
    expect((await library(a)).media).toHaveLength(0)
    expect((await library(b)).media).toHaveLength(1)
    // Without a copy, a can no longer edit it, but the catalog item remains.
    expect(
      await rejectedStatus(
        act(a, "add-tags", { ids: [target], tags: ["no-access"] })
      )
    ).toBe(404)
    expect(await count("catalog WHERE id=?", [target])).toBe(1)
  })

  test("merging already-curated duplicates preserves tags, names, memberships and posts", async () => {
    const owner = newUser()
    const first = randomUUID()
    const second = randomUUID()
    const bytes = hash()
    await runTracedAppEffect(
      transaction((session) =>
        Effect.gen(function* () {
          for (const [id, name, tag, date] of [
            [first, "First curated name", "one", "2026-01-01"],
            [second, "Second curated name", "two", "2026-02-01"],
          ]) {
            yield* session.execute(
              "INSERT INTO catalog(id,display_name,tags,created_at,cataloged_at) VALUES (?,?,?,NOW(3),?)",
              [id, name, JSON.stringify([tag]), date]
            )
            yield* session.execute(
              "INSERT INTO media(id,user_id,drive_id,catalog_id,display_name,raw_name,mime_type,tags,created_at,uploaded_at,available,synced_at) VALUES (?,?,?,?,?,'fixture.jpg','image/jpeg','[]',NOW(3),NOW(3),TRUE,NOW(3))",
              [id, owner.id, id, id, name]
            )
            const setId = randomUUID()
            yield* session.execute(
              "INSERT INTO media_set(id,user_id,display_name,raw_name,tags,created_at) VALUES (?,?,'Set','Set','[]',NOW(3))",
              [setId, owner.id]
            )
            yield* session.execute(
              "INSERT INTO catalog_set_member VALUES (?,?)",
              [setId, id]
            )
            yield* session.execute(
              "INSERT INTO post(id,user_id,media_id,catalog_id,platform,url,created_at) VALUES (?,?,?,?,'Example','https://example.com/post',NOW(3))",
              [randomUUID(), owner.id, id, id]
            )
          }
          const incoming = (id: string): DriveFile => ({
            id,
            name: "renamed.jpg",
            mimeType: "image/jpeg",
            createdTime: "2026-01-01T00:00:00Z",
            sha256Checksum: bytes,
            size: "24",
          })
          expect(yield* resolve(session, incoming(first))).toBe(first)
          expect(yield* resolve(session, incoming(second))).toBe(first)
        })
      )
    )

    const result = await library(owner)
    expect(result.media).toHaveLength(1)
    expect(result.media[0]).toMatchObject({
      copy_count: 2,
      display_name: "First curated name",
    })
    expect(new Set(result.media[0].tags)).toEqual(new Set(["one", "two"]))
    expect(result.media[0].set_ids).toHaveLength(2)
    expect(result.posts).toHaveLength(2)
    const [retained] = await rows<{
      display_name: string
      merged_into: string
    }>("SELECT display_name,merged_into FROM catalog WHERE id=?", [second])
    expect(retained).toEqual({
      display_name: "Second curated name",
      merged_into: first,
    })
  })
})
