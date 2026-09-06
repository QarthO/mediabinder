import { setTimeout } from "node:timers/promises"
import { pool } from "../src/lib/database.server"
import {
  processSyncJobs,
  processWatchRenewals,
} from "../src/lib/drive-webhook.server"
let stopping = false
process.on("SIGTERM", () => {
  stopping = true
})
process.on("SIGINT", () => {
  stopping = true
})
console.log(
  "Drive worker started; webhook registration",
  process.env.DRIVE_WEBHOOK_URL ? "enabled" : "disabled"
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
  if (!stopping) await setTimeout(10000)
}
await pool.end()
