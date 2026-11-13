import { describe, expect, it } from "vite-plus/test"
import {
  createSyncWatcher,
  giveUpChecking,
  hideSyncRun,
  isCheckingFormats,
  observeSyncRun,
} from "./sync-watch"
import type { SyncStatus } from "./types"

const run = (overrides: Partial<SyncStatus>): SyncStatus => ({
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
  codecs_pending: 0,
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

  describe("video format checks after a sync", () => {
    const done = (pending: number) =>
      run({ status: "succeeded", item_count: 3, codecs_pending: pending })

    it("follows the checks in the same toast, then announces the result once", () => {
      const watcher = createSyncWatcher()
      observeSyncRun(watcher, run({}))
      expect(observeSyncRun(watcher, done(40))).toEqual({
        retire: null,
        refreshLibrary: true,
        toast: "checking",
        codecs: { done: 0, total: 40 },
      })
      expect(isCheckingFormats(watcher, "a")).toBe(true)
      const next = observeSyncRun(watcher, done(30))
      expect(next).toMatchObject({
        refreshLibrary: false,
        toast: "checking",
        codecs: { done: 10, total: 40 },
      })
      expect(observeSyncRun(watcher, done(0))).toEqual({
        retire: null,
        refreshLibrary: true,
        toast: "success",
      })
      expect(isCheckingFormats(watcher, "a")).toBe(false)
      expect(observeSyncRun(watcher, done(0)).toast).toBe(null)
    })

    it("grows the total when more videos arrive", () => {
      const watcher = createSyncWatcher()
      observeSyncRun(watcher, run({}))
      observeSyncRun(watcher, done(5))
      expect(observeSyncRun(watcher, done(8)).codecs).toEqual({
        done: 0,
        total: 8,
      })
    })

    it("keeps a closed toast closed until the checks finish", () => {
      const watcher = createSyncWatcher()
      observeSyncRun(watcher, run({}))
      hideSyncRun(watcher, "a")
      expect(observeSyncRun(watcher, done(9)).toast).toBe(null)
      expect(observeSyncRun(watcher, done(4)).toast).toBe(null)
      expect(isCheckingFormats(watcher, "a")).toBe(true)
      // Closing the checking toast closes it the same way.
      const other = createSyncWatcher()
      observeSyncRun(other, run({}))
      observeSyncRun(other, done(9))
      hideSyncRun(other, "a")
      expect(observeSyncRun(other, done(4)).toast).toBe(null)
      expect(observeSyncRun(other, done(0)).toast).toBe("success")
    })

    it("shows nothing about formats when nothing is pending, or for a quiet run", () => {
      const watcher = createSyncWatcher()
      observeSyncRun(watcher, run({}))
      expect(observeSyncRun(watcher, done(0)).toast).toBe("success")
      const quiet = createSyncWatcher()
      observeSyncRun(quiet, run({ origin: "automatic" }))
      expect(
        observeSyncRun(quiet, { ...done(12), origin: "automatic" })
      ).toEqual({ retire: null, refreshLibrary: true, toast: null })
      expect(isCheckingFormats(quiet, "a")).toBe(false)
    })

    it("gives up on checks that stall, announcing the sync", () => {
      const watcher = createSyncWatcher()
      observeSyncRun(watcher, run({}))
      observeSyncRun(watcher, done(3))
      expect(giveUpChecking(watcher, "a")).toEqual({
        retire: null,
        refreshLibrary: true,
        toast: "success",
      })
      expect(isCheckingFormats(watcher, "a")).toBe(false)
      expect(giveUpChecking(watcher, "a").toast).toBe(null)
    })

    it("retires the checking toast when a newer run starts", () => {
      const watcher = createSyncWatcher()
      observeSyncRun(watcher, run({}))
      observeSyncRun(watcher, done(3))
      expect(
        observeSyncRun(
          watcher,
          run({ run_id: "b", started_at: "2026-11-12T00:01:00.000" })
        )
      ).toMatchObject({ retire: "a", toast: "progress" })
    })
  })
})
