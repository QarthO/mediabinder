import { expect, test } from "vite-plus/test"

import { describeMysql, useTestDatabase } from "@/test/database"
import {
  act,
  count,
  insertMedia,
  newUser,
  rejectedStatus,
  rows,
} from "@/test/fixtures"

// Batch tag and set names: the lists users type into the bulk editor.
describeMysql("batch names", () => {
  useTestDatabase()

  async function twoItems(owner: { id: string }) {
    return [
      await insertMedia({ userId: owner.id }),
      await insertMedia({ userId: owner.id }),
    ]
  }

  test("sets are reused by name, added without toggling, and tags are not duplicated", async () => {
    const owner = newUser()
    const ids = await twoItems(owner)
    const existing = (await act(owner, "create-set", {
      displayName: "Holiday",
    })) as { id: string }

    // Names match case-insensitively, and a repeated name counts once.
    await act(owner, "add-sets", {
      ids,
      names: ["HOLIDAY", "Beach", "Beach"],
    })
    // Adding again changes nothing: it adds, it never toggles off.
    await act(owner, "add-sets", { ids, names: ["Holiday", "Beach"] })

    const sets = await rows<{ id: string }>(
      "SELECT id FROM media_set WHERE user_id=?",
      [owner.id]
    )
    expect(sets).toHaveLength(2)
    expect(sets.map((set) => set.id)).toContain(existing.id)
    expect(await count("catalog_set_member")).toBe(4)

    await act(owner, "add-tags", { ids, tags: ["one", "two"] })
    await act(owner, "add-tags", { ids, tags: ["one"] })
    for (const row of await rows<{ tags: string[] }>(
      "SELECT tags FROM catalog"
    ))
      expect(row.tags).toEqual(["one", "two"])
  })

  test("another user can neither create sets on nor tag someone's media", async () => {
    const owner = newUser()
    const outsider = newUser()
    const ids = await twoItems(owner)

    expect(
      await rejectedStatus(
        act(outsider, "add-sets", { ids, names: ["Private"] })
      )
    ).toBe(404)
    expect(
      await rejectedStatus(
        act(outsider, "add-tags", { ids, tags: ["Private"] })
      )
    ).toBe(404)
    expect(await count("media_set")).toBe(0)
    expect(
      (await rows<{ tags: string[] }>("SELECT tags FROM catalog")).every(
        (row) => row.tags.length === 0
      )
    ).toBe(true)
  })

  test("a name containing a comma is rejected before anything is written", async () => {
    const owner = newUser()
    const ids = await twoItems(owner)

    await expect(
      act(owner, "add-sets", { ids, names: ["valid", "invalid, name"] })
    ).rejects.toThrow()
    await expect(
      act(owner, "set-membership", { ids, displayName: "invalid, name" })
    ).rejects.toThrow()
    await expect(
      act(owner, "add-tags", { ids, tags: ["invalid, tag"] })
    ).rejects.toThrow()
    expect(await count("media_set")).toBe(0)
  })

  test("a set name never matches or attaches to another user's inaccessible set", async () => {
    const owner = newUser()
    const outsider = newUser()
    const ids = await twoItems(owner)
    const hidden = (await act(outsider, "create-set", {
      displayName: "Hidden",
    })) as { id: string }

    await act(owner, "add-sets", { ids, names: ["Hidden"] })

    expect(await count("catalog_set_member WHERE set_id=?", [hidden.id])).toBe(
      0
    )
    expect(
      await count("media_set WHERE user_id=? AND display_name='Hidden'", [
        owner.id,
      ])
    ).toBe(1)
  })

  test("an ambiguous existing name rolls back sets created earlier in the batch", async () => {
    const owner = newUser()
    const ids = await twoItems(owner)
    await act(owner, "create-set", { displayName: "Twin" })
    await act(owner, "create-set", { displayName: "Twin" })

    expect(
      await rejectedStatus(
        act(owner, "add-sets", { ids, names: ["Rollback", "Twin"] })
      )
    ).toBe(400)

    expect(await count("media_set WHERE display_name='Rollback'")).toBe(0)
  })
})
