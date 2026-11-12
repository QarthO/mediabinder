import { test } from "node:test"
import assert from "node:assert/strict"
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

test("a manual run shows progress, then its result once", () => {
  const watcher = createSyncWatcher()
  assert.equal(observeSyncRun(watcher, run({})).toast, "progress")
  assert.equal(
    observeSyncRun(watcher, run({ phase: "saving" })).toast,
    "progress"
  )
  const done = observeSyncRun(
    watcher,
    run({ status: "succeeded", item_count: 3 })
  )
  assert.deepEqual(done, {
    retire: null,
    refreshLibrary: true,
    toast: "success",
  })
  assert.equal(
    observeSyncRun(watcher, run({ status: "succeeded" })).toast,
    null
  )
})

test("old results stay silent after a reload", () => {
  const watcher = createSyncWatcher()
  assert.deepEqual(observeSyncRun(watcher, run({ status: "failed" })), {
    retire: null,
    refreshLibrary: false,
    toast: null,
  })
})

test("a closed progress toast stays closed, but the result is shown", () => {
  const watcher = createSyncWatcher()
  observeSyncRun(watcher, run({}))
  hideSyncRun(watcher, "a")
  assert.equal(observeSyncRun(watcher, run({ phase: "saving" })).toast, null)
  assert.equal(
    observeSyncRun(watcher, run({ status: "failed" })).toast,
    "error"
  )
})

test("webhook runs stay quiet but refresh the library, until claimed", () => {
  const watcher = createSyncWatcher()
  assert.equal(
    observeSyncRun(watcher, run({ origin: "automatic" })).toast,
    null
  )
  assert.deepEqual(
    observeSyncRun(watcher, run({ origin: "automatic", status: "succeeded" })),
    { retire: null, refreshLibrary: true, toast: null }
  )
  const claimed = createSyncWatcher()
  observeSyncRun(claimed, run({ origin: "automatic" }))
  assert.equal(observeSyncRun(claimed, run({})).toast, "progress")
  assert.equal(
    observeSyncRun(claimed, run({ status: "succeeded" })).toast,
    "success"
  )
})

test("a superseded run's toast is retired without inventing a result", () => {
  const watcher = createSyncWatcher()
  observeSyncRun(watcher, run({}))
  assert.deepEqual(
    observeSyncRun(watcher, run({ run_id: "b", origin: "automatic" })),
    {
      retire: "a",
      refreshLibrary: true,
      toast: null,
    }
  )
  // A late result for the replaced run is not announced.
  assert.equal(
    observeSyncRun(watcher, run({ status: "succeeded" })).toast,
    null
  )
})
