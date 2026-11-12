import { driveWebhookUrl } from "../src/lib/config"
import { setTimeout } from "node:timers/promises"
import { pool } from "../src/lib/database.server"
import {
  processSyncJobs,
  processWatchRenewals,
} from "../src/lib/drive-webhook.server"
import { revokeLegacyDriveGrants } from "../src/lib/google-grants.server"
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
      // Housekeeping only: never let it hold up watches or syncs.
      const revoked = await revokeLegacyDriveGrants().catch((error) => {
        console.warn(
          "Old Google grant cleanup failed:",
          error instanceof Error ? error.message : "Unknown error"
        )
        return 0
      })
      if (revoked)
        console.log(`Revoked ${revoked} old full-Drive Google grant(s).`)
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
