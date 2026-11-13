import { randomInt } from "node:crypto"
import type { RowDataPacket } from "mysql2/promise"
import { Effect } from "effect"
import { Database } from "@/effect/database"
import type { DatabaseSession } from "@/effect/database"
import { tagColorChoices } from "./tag-colors"

/**
 * Creates the catalog tags in `names` that don't exist yet, each with a color
 * not yet in use. With a `session`, every statement runs on that connection,
 * so inside a transaction the new tags commit or roll back with it. Without
 * one they run on a pool connection of their own.
 */
export const ensure = Effect.fn("Tags.ensure")(function* (
  names: ReadonlyArray<string>,
  session?: DatabaseSession
) {
  if (!names.length) return
  const database = yield* Database
  const connection: DatabaseSession = session ?? {
    execute: (sql, values) => database.execute("tags.ensure", sql, values),
    queryRows: (sql, values) => database.queryRows("tags.ensure", sql, values),
  }
  const existing = yield* connection.queryRows<RowDataPacket>(
    "SELECT name,color FROM catalog_tag"
  )
  const known = new Set(existing.map((tag) => tag.name as string))
  const colors = existing.map((tag) => tag.color as string)
  for (const name of new Set(names)) {
    if (known.has(name)) continue
    const choices = tagColorChoices(colors)
    const color = choices[randomInt(choices.length)]
    yield* connection.execute(
      "INSERT IGNORE INTO catalog_tag(name,color) VALUES (?,?)",
      [name, color]
    )
    colors.push(color)
    known.add(name)
  }
})
