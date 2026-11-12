import { describe, expect, it } from "vite-plus/test"
import { createSyncWatcher, hideSyncRun, observeSyncRun } from "./sync-watch"
import type { SyncRun } from "./types"

const run = (overrides: Partial<SyncRun>): SyncRun => ({
  run_id: "a",
  origin: "manual",
  status: "running",
  phase: "scanning",
  folders_scanned: 0,
  files_found: 0,
  files_saved: 0,
  files_total: 0,
  item_count: null,
  error: null,
  started_at: "2026-11-12T00:00:00.000",
  finished_at: null,
  ...overrides,
})

describe("sync watcher", () => {
  it("shows a manual run's progress, then its result once", () => {
    const watcher = createSyncWatcher()
    expect(observeSyncRun(watcher, run({})).toast).toBe("progress")
    expect(observeSyncRun(watcher, run({ phase: "saving" })).toast).toBe(
      "progress"
    )
    expect(
      observeSyncRun(watcher, run({ status: "succeeded", item_count: 3 }))
    ).toEqual({ retire: null, refreshLibrary: true, toast: "success" })
    expect(observeSyncRun(watcher, run({ status: "succeeded" })).toast).toBe(
      null
    )
  })

  it("keeps old results silent after a reload", () => {
    const watcher = createSyncWatcher()
    expect(observeSyncRun(watcher, run({ status: "failed" }))).toEqual({
      retire: null,
      refreshLibrary: false,
      toast: null,
    })
  })

  it("keeps a closed progress toast closed but shows the result", () => {
    const watcher = createSyncWatcher()
    observeSyncRun(watcher, run({}))
    hideSyncRun(watcher, "a")
    expect(observeSyncRun(watcher, run({ phase: "saving" })).toast).toBe(null)
    expect(observeSyncRun(watcher, run({ status: "failed" })).toast).toBe(
      "error"
    )
  })

  it("keeps webhook runs quiet but refreshes the library, until claimed", () => {
    const watcher = createSyncWatcher()
    expect(observeSyncRun(watcher, run({ origin: "automatic" })).toast).toBe(
      null
    )
    expect(
      observeSyncRun(watcher, run({ origin: "automatic", status: "succeeded" }))
    ).toEqual({ retire: null, refreshLibrary: true, toast: null })
    const claimed = createSyncWatcher()
    observeSyncRun(claimed, run({ origin: "automatic" }))
    expect(observeSyncRun(claimed, run({})).toast).toBe("progress")
    expect(observeSyncRun(claimed, run({ status: "succeeded" })).toast).toBe(
      "success"
    )
  })

  it("retires a superseded run's toast without inventing a result", () => {
    const watcher = createSyncWatcher()
    observeSyncRun(watcher, run({}))
    expect(
      observeSyncRun(
        watcher,
        run({
          run_id: "b",
          origin: "automatic",
          started_at: "2026-11-12T00:01:00.000",
        })
      )
    ).toEqual({ retire: "a", refreshLibrary: true, toast: null })
    // A late result for the replaced run is not announced.
    expect(observeSyncRun(watcher, run({ status: "succeeded" }))).toEqual({
      retire: null,
      refreshLibrary: false,
      toast: null,
    })
  })

  it("stops a delayed older run silencing the newer run", () => {
    const watcher = createSyncWatcher()
    const older = { run_id: "a", origin: "automatic" as const }
    const newer = { run_id: "b", started_at: "2026-11-12T00:01:00.000" }
    observeSyncRun(watcher, run(older))
    expect(observeSyncRun(watcher, run(newer)).toast).toBe("progress")
    // A request that started before b returns a's row late.
    expect(observeSyncRun(watcher, run(older))).toEqual({
      retire: null,
      refreshLibrary: false,
      toast: null,
    })
    expect(
      observeSyncRun(watcher, run({ ...newer, phase: "saving" })).toast
    ).toBe("progress")
    expect(
      observeSyncRun(watcher, run({ ...newer, status: "succeeded" }))
    ).toEqual({ retire: null, refreshLibrary: true, toast: "success" })
    // The same holds for an older run this tab never saw.
    const fresh = createSyncWatcher()
    observeSyncRun(fresh, run(newer))
    expect(observeSyncRun(fresh, run(older)).retire).toBe(null)
    expect(
      observeSyncRun(fresh, run({ ...newer, status: "failed" })).toast
    ).toBe("error")
  })
})
