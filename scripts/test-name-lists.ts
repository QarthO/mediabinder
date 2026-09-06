import { after, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { pool, rows } from "../src/lib/database.server"
import { mutate } from "../src/lib/library.server"

after(() => pool.end())

test("batch names reuse sets, add without toggling, validate atomically, and isolate access", async () => {
  const owner = randomUUID(),
    outsider = randomUUID(),
    prefix = randomUUID()
  const targets = [randomUUID(), randomUUID()]
  const names = [`${prefix}-one`, `${prefix}-two`]
  const call = (action: string, data: unknown, user = owner) =>
    mutate(action, data, user, new Headers())
  try {
    for (const target of targets) {
      await pool.execute(
        "INSERT INTO catalog(id,display_name,tags,created_at) VALUES (?,?,'[]',NOW(3))",
        [target, prefix]
      )
      await pool.execute(
        `INSERT INTO media(id,user_id,drive_id,display_name,raw_name,mime_type,tags,created_at,uploaded_at,synced_at,catalog_id)
        VALUES (?,?,?,?,?,'image/jpeg','[]',NOW(3),NOW(3),NOW(3),?)`,
        [target, owner, target, prefix, prefix, target]
      )
    }
    const existing = (await call("create-set", { displayName: names[0] })) as {
      id: string
    }
    await call("add-sets", {
      ids: targets,
      names: [names[0].toUpperCase(), names[1], names[1]],
    })
    await call("add-sets", { ids: targets, names })
    const sets = await rows<{ id: string; display_name: string }>(
      "SELECT id,display_name FROM media_set WHERE user_id=?",
      [owner]
    )
    assert.equal(sets.length, 2)
    assert.ok(sets.some((set) => set.id === existing.id))
    assert.equal(
      (
        await rows(
          "SELECT * FROM catalog_set_member WHERE catalog_id IN (?,?)",
          targets
        )
      ).length,
      4
    )
    await call("add-tags", { ids: targets, tags: names })
    await call("add-tags", { ids: targets, tags: [names[0]] })
    for (const row of await rows<{ tags: string[] }>(
      "SELECT tags FROM catalog WHERE id IN (?,?)",
      targets
    ))
      assert.deepEqual(row.tags, names)

    await assert.rejects(
      call("add-sets", { ids: targets, names: [`${prefix}-private`] }, outsider)
    )
    assert.equal(
      (await rows("SELECT * FROM media_set WHERE user_id=?", [outsider]))
        .length,
      0
    )
    await assert.rejects(
      call("add-sets", { ids: targets, names: ["valid", "invalid, name"] })
    )
    await assert.rejects(
      call("set-membership", { ids: targets, displayName: "invalid, name" })
    )
    await assert.rejects(
      call("add-tags", { ids: targets, tags: ["invalid, tag"] })
    )

    // Same-name inaccessible sets must never be matched or attached.
    const hidden = (await call(
      "create-set",
      { displayName: `${prefix}-hidden` },
      outsider
    )) as { id: string }
    await call("add-sets", { ids: targets, names: [`${prefix}-hidden`] })
    assert.equal(
      (
        await rows("SELECT * FROM catalog_set_member WHERE set_id=?", [
          hidden.id,
        ])
      ).length,
      0
    )

    // An ambiguous existing name rolls back sets created earlier in the batch.
    await call("create-set", { displayName: names[0] })
    await assert.rejects(
      call("add-sets", {
        ids: targets,
        names: [`${prefix}-rollback`, names[0]],
      })
    )
    assert.equal(
      (
        await rows("SELECT * FROM media_set WHERE display_name=?", [
          `${prefix}-rollback`,
        ])
      ).length,
      0
    )
  } finally {
    await pool.execute("DELETE FROM media_set WHERE user_id IN (?,?)", [
      owner,
      outsider,
    ])
    await pool.execute("DELETE FROM media WHERE user_id=?", [owner])
    for (const target of targets)
      await pool.execute("DELETE FROM catalog WHERE id=?", [target])
    for (const name of names)
      await pool.execute("DELETE FROM catalog_tag WHERE name=?", [name])
  }
})
