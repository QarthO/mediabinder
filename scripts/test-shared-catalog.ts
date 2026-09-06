import { randomUUID, randomBytes } from "node:crypto"
import { test, after, mock } from "node:test"
import assert from "node:assert/strict"
import { pool, rows } from "../src/lib/database.server"
import { auth } from "../src/lib/auth.server"
import { library, mutate } from "../src/lib/library.server"
import { syncDrive, type DriveFile } from "../src/lib/drive.server"

after(() => pool.end())
test("shared catalog deduplicates bytes, shares curation, isolates access and preserves content history", async () => {
  const hashA = randomBytes(32).toString("hex"),
    hashB = randomBytes(32).toString("hex")
  const a = randomUUID(),
    b = randomUUID(),
    outsider = randomUUID(),
    prefix = randomUUID()
  const user = (id: string) => ({
    id,
    name: "Fixture",
    email: "fixture@example.com",
    role: "user",
  })
  const first = `${prefix}-one`,
    second = `${prefix}-two`,
    third = `${prefix}-three`
  const file = (id: string, name: string, hash?: string): DriveFile => ({
    id,
    name,
    mimeType: "image/jpeg",
    createdTime: "2026-09-01T00:00:00Z",
    size: "42",
    sha256Checksum: hash,
    parents: ["parent"],
  })
  let aFiles = [
    file(first, "original.jpg", hashA),
    file(second, "different-name.jpg", hashA),
  ]
  let bFiles = [file(third, "another-name.jpg", hashA)]
  let fail = false
  mock.method(
    auth.api,
    "getAccessToken",
    async ({ body }: { body: { userId: string } }) => ({
      accessToken: body.userId,
    })
  )
  mock.method(
    globalThis,
    "fetch",
    async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      assert.equal(url.hostname, "www.googleapis.com")
      if (fail) return new Response(null, { status: 503 })
      const token = new Headers(init?.headers)
        .get("authorization")
        ?.replace("Bearer ", "")
      return Response.json({ files: token === a ? aFiles : bFiles })
    }
  )
  await pool.execute(
    "INSERT INTO drive_folder(user_id,folder_id,folder_name) VALUES (?,?,?),(?,?,?)",
    [a, `${prefix}-folder-a`, "A", b, `${prefix}-folder-b`, "B"]
  )
  await pool.execute(
    "INSERT INTO drive_folder(user_id,folder_id,folder_name) VALUES (?,?,'A second folder')",
    [a, `${prefix}-folder-a2`]
  )
  await syncDrive(a)
  let result = await library(user(a))
  assert.equal(result.media.length, 1)
  assert.equal(result.media[0].copy_count, 2)
  assert.equal(result.media[0].cataloged, false)
  assert.equal(result.media[0].source_ids.length, 2)
  const target = result.media[0].id
  await mutate(
    "add-tags",
    { ids: [target], tags: ["shared"] },
    a,
    new Headers()
  )
  await mutate(
    "metadata",
    {
      id: target,
      kind: "media",
      displayName: "Curated name",
      createdAt: "2026-08-01T00:00:00Z",
    },
    a,
    new Headers()
  )
  const set = (await mutate(
    "set-membership",
    { id: target, displayName: "Shared set" },
    a,
    new Headers()
  )) as { id: string }
  await mutate(
    "create-post",
    {
      kind: "media",
      targetId: target,
      platform: "Example",
      url: "https://example.com/post",
      createdAt: "2026-09-01T00:00:00Z",
    },
    a,
    new Headers()
  )
  await syncDrive(b)
  const shared = await library(user(b))
  assert.equal(shared.media[0].id, target)
  assert.equal(shared.media[0].copy_count, 1)
  assert.equal(shared.media[0].drive_id, third)
  assert.equal(shared.media[0].display_name, "Curated name")
  assert.deepEqual(shared.media[0].tags, ["shared"])
  assert.equal(shared.media[0].cataloged, true)
  assert.deepEqual(shared.media[0].set_ids, [set.id])
  assert.equal(shared.sets[0].media_count, 1)
  assert.equal(shared.posts[0].media_id, target)
  assert.deepEqual(shared.media[0].source_ids, [`${prefix}-folder-b`])
  assert.equal((await library(user(outsider))).media.length, 0)
  assert.equal((await library(user(outsider))).sets.length, 0)
  await assert.rejects(() =>
    mutate(
      "add-tags",
      { ids: [target], tags: ["forbidden"] },
      outsider,
      new Headers()
    )
  )
  await Promise.all([
    mutate("add-tags", { ids: [target], tags: ["a"] }, a, new Headers()),
    mutate("add-tags", { ids: [target], tags: ["b"] }, b, new Headers()),
  ])
  assert.deepEqual(
    new Set((await library(user(a))).media[0].tags),
    new Set(["shared", "a", "b"])
  )
  await mutate("remove-tag", { id: target, tag: "shared" }, b, new Headers())
  assert.equal((await library(user(a))).media[0].tags.includes("shared"), false)
  await mutate("tag-color", { name: "b", color: "#38bdf8" }, b, new Headers())
  assert.equal((await library(user(a))).tag_colors.b, "#38bdf8")
  aFiles.push(
    file(`${prefix}-private`, "private.jpg", randomBytes(32).toString("hex"))
  )
  await syncDrive(a)
  const privateId = (await library(user(a))).media.find(
    (m) => m.id !== target
  )!.id
  await mutate(
    "set-membership",
    { id: privateId, setId: set.id },
    a,
    new Headers()
  )
  assert.equal((await library(user(b))).sets[0].media_count, 1)
  await assert.rejects(() =>
    mutate(
      "add-tags",
      { ids: [privateId], tags: ["forbidden"] },
      b,
      new Headers()
    )
  )
  // Replacing bytes under an existing Drive ID must return to the inbox.
  bFiles = [file(third, "new-content.jpg", hashB)]
  await syncDrive(b)
  const changed = (await library(user(b))).media[0]
  assert.notEqual(changed.id, target)
  assert.equal(changed.cataloged, false)
  assert.deepEqual(changed.tags, [])
  assert.equal(
    (await library(user(a))).media.find((m) => m.id === target)!.display_name,
    "Curated name"
  )
  // A subsequent identical upload recovers the old catalog even under a new name.
  bFiles = [file(`${prefix}-reupload`, "reuploaded.jpg", hashA)]
  await syncDrive(b)
  assert.equal((await library(user(b))).media[0].id, target)
  // Missing checksums match only Drive ID, never coincidental filenames/sizes.
  aFiles = [file(`${prefix}-nohash`, "same.jpg")]
  bFiles = [
    file(`${prefix}-nohash`, "same.jpg"),
    file(`${prefix}-nohash-other`, "same.jpg"),
  ]
  await syncDrive(a)
  await syncDrive(b)
  assert.equal((await library(user(b))).media.length, 2)
  const nohash = (await library(user(a))).media[0]
  await mutate(
    "add-tags",
    { ids: [nohash.id], tags: ["same-drive"] },
    a,
    new Headers()
  )
  assert.ok(
    (await library(user(b))).media.some((m) => m.tags.includes("same-drive"))
  )
  fail = true
  await assert.rejects(() => syncDrive(b))
  assert.equal((await library(user(b))).media.length, 2)
  fail = false
  await mutate(
    "remove-source",
    { folderId: `${prefix}-folder-a` },
    a,
    new Headers()
  )
  assert.equal((await library(user(a))).media.length, 1)
  await mutate(
    "remove-source",
    { folderId: `${prefix}-folder-a2` },
    a,
    new Headers()
  )
  assert.equal((await library(user(a))).media.length, 0)
  assert.equal((await library(user(b))).media.length, 2)
  await assert.rejects(() =>
    mutate(
      "add-tags",
      { ids: [nohash.id], tags: ["no-access"] },
      a,
      new Headers()
    )
  )
  assert.equal(
    (await rows("SELECT id FROM catalog WHERE id=?", [target])).length,
    1
  )
  mock.restoreAll()
})

test("merging already-curated duplicates preserves tags, names, memberships and posts", async () => {
  const { catalogTransaction, resolveCatalog } = await import(
    "../src/lib/catalog.server"
  )
  const owner = randomUUID(),
    first = randomUUID(),
    second = randomUUID()
  const oneSet = randomUUID(),
    twoSet = randomUUID()
  await catalogTransaction(async (connection) => {
    for (const [key, name, tag, date] of [
      [first, "First curated name", "one", "2026-01-01"],
      [second, "Second curated name", "two", "2026-02-01"],
    ]) {
      await connection.execute(
        "INSERT INTO catalog(id,display_name,tags,created_at,cataloged_at) VALUES (?,?,?,NOW(3),?)",
        [key, name, JSON.stringify([tag]), date]
      )
      await connection.execute(
        "INSERT INTO media(id,user_id,drive_id,catalog_id,display_name,raw_name,mime_type,tags,created_at,uploaded_at,available,synced_at) VALUES (?,?,?,?,?,'fixture.jpg','image/jpeg','[]',NOW(3),NOW(3),TRUE,NOW(3))",
        [key, owner, key, key, name]
      )
    }
    for (const [setId, catalogId] of [
      [oneSet, first],
      [twoSet, second],
    ]) {
      await connection.execute(
        "INSERT INTO media_set(id,user_id,display_name,raw_name,tags,created_at) VALUES (?,?,'Set','Set','[]',NOW(3))",
        [setId, owner]
      )
      await connection.execute("INSERT INTO catalog_set_member VALUES (?,?)", [
        setId,
        catalogId,
      ])
      await connection.execute(
        "INSERT INTO post(id,user_id,media_id,catalog_id,platform,url,created_at) VALUES (?,?,?,?,'Example','https://example.com/post',NOW(3))",
        [randomUUID(), owner, catalogId, catalogId]
      )
    }
    const hash = randomBytes(32).toString("hex")
    const file = (id: string): DriveFile => ({
      id,
      name: "renamed.jpg",
      mimeType: "image/jpeg",
      createdTime: "2026-01-01T00:00:00Z",
      sha256Checksum: hash,
      size: "24",
    })
    assert.equal(await resolveCatalog(connection, file(first)), first)
    assert.equal(await resolveCatalog(connection, file(second)), first)
  })
  const result = await library({
    id: owner,
    name: "Fixture",
    email: "fixture@example.com",
    role: "user",
  })
  assert.equal(result.media.length, 1)
  assert.equal(result.media[0].copy_count, 2)
  assert.equal(result.media[0].display_name, "First curated name")
  assert.deepEqual(new Set(result.media[0].tags), new Set(["one", "two"]))
  assert.equal(result.media[0].set_ids.length, 2)
  assert.equal(result.posts.length, 2)
  const [retained] = await rows<{ display_name: string; merged_into: string }>(
    "SELECT display_name,merged_into FROM catalog WHERE id=?",
    [second]
  )
  assert.equal(retained.display_name, "Second curated name")
  assert.equal(retained.merged_into, first)
})
