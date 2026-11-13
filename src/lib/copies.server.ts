import { Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import { Database } from "@/effect/database"
import { NotFoundError } from "@/effect/errors"
import type { ItemCopy } from "./types"

// A path is never deeper than Drive allows; the bound only guards a cycle.
const MAX_DEPTH = 100

/**
 * Every available copy of a library item that belongs to the user, each with
 * the linked folders that reach it. A copy shows once per linked folder, with
 * the folder names from that linked folder down to the file's parent folder
 * (empty when the file sits in the linked folder itself). `path` is null when
 * the folder tree hasn't been stored yet, which is until the next sync. Only
 * the user's own copies and linked folders are read, so another user's copy
 * of the same item never shows, and an item the user has no copy of is a
 * NotFoundError, as for any other action. Folder names are returned to the
 * caller and never recorded in telemetry.
 */
export const list = Effect.fn("Copies.list")(function* (
  userId: string,
  catalogId: string
) {
  yield* Effect.annotateCurrentSpan("mediabinder.user_id", userId)
  const database = yield* Database
  const found = yield* database.queryRows<RowDataPacket>(
    "copies.list",
    `SELECT m.id,m.drive_id,m.raw_name,m.size,m.mime_type,m.uploaded_at,
      COALESCE(l.parent_ids,JSON_ARRAY()) AS parent_ids,
      f.folder_id AS root_id,f.folder_name AS root_name
    FROM media m
    JOIN media_source s ON s.media_id=m.id AND s.user_id=m.user_id
    JOIN drive_folder f ON f.user_id=s.user_id AND f.folder_id=s.folder_id
    LEFT JOIN media_location l ON l.media_id=m.id
    WHERE m.user_id=? AND m.catalog_id=? AND m.available=TRUE
    ORDER BY m.uploaded_at,m.drive_id,f.folder_name,f.folder_id`,
    [userId, catalogId]
  )
  if (!found.length) return yield* new NotFoundError({ resource: "Item" })
  yield* Effect.annotateCurrentSpan("mediabinder.copies.count", found.length)

  // The folders above each parent, within the linked folder that reached it.
  const parents = [
    ...new Set(found.flatMap((row) => row.parent_ids as string[])),
  ]
  const tree = new Map<string, { parentId: string; name: string }>()
  if (parents.length) {
    const nodes = yield* database.queryRows<RowDataPacket>(
      "copies.tree",
      `WITH RECURSIVE chain AS (
        SELECT root_folder_id,folder_id,parent_id,name,1 AS depth
        FROM drive_folder_node WHERE user_id=? AND folder_id IN (${parents.map(() => "?").join(",")})
        UNION ALL
        SELECT n.root_folder_id,n.folder_id,n.parent_id,n.name,c.depth+1
        FROM drive_folder_node n JOIN chain c
          ON n.user_id=? AND n.root_folder_id=c.root_folder_id AND n.folder_id=c.parent_id
        WHERE c.depth<${MAX_DEPTH}
      ) SELECT DISTINCT root_folder_id,folder_id,parent_id,name FROM chain`,
      [userId, ...parents, userId]
    )
    for (const node of nodes)
      tree.set(`${node.root_folder_id}\u0000${node.folder_id}`, {
        parentId: node.parent_id as string,
        name: node.name as string,
      })
  }
  const pathFrom = (rootId: string, parentIds: string[]) => {
    if (parentIds.includes(rootId)) return []
    for (const start of parentIds) {
      const names: string[] = []
      let current = start
      for (let depth = 0; depth < MAX_DEPTH; depth++) {
        const node = tree.get(`${rootId}\u0000${current}`)
        if (!node) break
        names.unshift(node.name)
        if (node.parentId === rootId) return names
        current = node.parentId
      }
    }
    return null
  }

  const copies = new Map<string, ItemCopy>()
  for (const row of found) {
    let copy = copies.get(row.id)
    if (!copy) {
      copy = {
        drive_id: row.drive_id,
        raw_name: row.raw_name,
        size: Number(row.size),
        mime_type: row.mime_type,
        uploaded_at: row.uploaded_at,
        locations: [],
      }
      copies.set(row.id, copy)
    }
    copy.locations.push({
      folder_name: row.root_name,
      path: pathFrom(row.root_id, row.parent_ids),
    })
  }
  return [...copies.values()]
})
