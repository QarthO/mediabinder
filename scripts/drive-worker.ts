import { driveWebhookUrl } from "../src/lib/config"
import { setTimeout } from "node:timers/promises"
import { pool } from "../src/lib/database.server"
import {
  processSyncJobs,
  processWatchRenewals,
} from "../src/lib/drive-webhook.server"
const shutdown = new AbortController()
let stopping = false
process.on("SIGTERM", () => {
  stopping = true
  shutdown.abort()
})
process.on("SIGINT", () => {
  stopping = true
  shutdown.abort()
})
console.log(
  "Drive worker started; webhook registration",
  driveWebhookUrl() ? "enabled" : "disabled"
)
while (!stopping) {
  const connection = await pool.getConnection()
  try {
    const [lock] = await connection.query<import("mysql2").RowDataPacket[]>(
      "SELECT GET_LOCK('mediabinder-drive-worker',0) AS acquired"
    )
    if (lock[0].acquired === 1) {
      await processWatchRenewals()
      await processSyncJobs()
    }
  } catch (error) {
    console.error(
      "Drive worker failed:",
      error instanceof Error ? error.message : "Unknown error"
    )
  } finally {
    await connection.query("SELECT RELEASE_LOCK('mediabinder-drive-worker')")
    connection.release()
  }
  if (!stopping)
    await setTimeout(10000, undefined, { signal: shutdown.signal }).catch(
      (error) => {
        if (!stopping) throw error
      }
    )
}
await pool.end()
