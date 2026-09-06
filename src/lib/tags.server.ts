import { randomInt } from "node:crypto"
import { pool } from "./database.server"
export async function ensureTags(
  userId: string,
  names: string[],
  connection: Pick<typeof pool, "execute"> = pool
) {
  for (const name of new Set(names)) {
    const color = `#${[0, 1, 2].map(() => randomInt(110, 241).toString(16)).join("")}`
    await connection.execute(
      "INSERT IGNORE INTO tag_definition(user_id,name,color) VALUES (?,?,?)",
      [userId, name, color]
    )
  }
}
