import { randomInt } from "node:crypto"
import type { RowDataPacket } from "mysql2/promise"
import { tagColorChoices } from "./tag-colors"
import { pool } from "./database.server"
export async function ensureTags(
  _userId: string,
  names: string[],
  connection: Pick<typeof pool, "execute"> = pool
) {
  if (!names.length) return
  const [existing] = await connection.execute<RowDataPacket[]>(
    "SELECT name,color FROM catalog_tag"
  )
  const known = new Set(existing.map((tag) => tag.name as string))
  const colors = existing.map((tag) => tag.color as string)
  for (const name of new Set(names)) {
    if (known.has(name)) continue
    const choices = tagColorChoices(colors)
    const color = choices[randomInt(choices.length)]
    await connection.execute(
      "INSERT IGNORE INTO catalog_tag(name,color) VALUES (?,?)",
      [name, color]
    )
    colors.push(color)
    known.add(name)
  }
}
