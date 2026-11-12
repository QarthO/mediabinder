import type { SyncRun } from "./types"

// running/hidden: progress toast shown or closed by the user;
// quiet: an unclaimed webhook run; done: its result has been handled.
export type WatchState = "running" | "hidden" | "quiet" | "done"

export interface SyncWatcher {
  runs: Map<string, WatchState>
  latest: string | null
}

export interface SyncUpdate {
  // A superseded run whose progress toast should be removed.
  retire: string | null
  refreshLibrary: boolean
  toast: "progress" | "success" | "error" | null
}

export function createSyncWatcher(): SyncWatcher {
  return { runs: new Map(), latest: null }
}

// Decides how one observed run changes the toast. The server keeps only the
// newest run per user, so a run this tab followed can be replaced before its
// result arrives; its toast is retired without inventing a result.
export function observeSyncRun(watcher: SyncWatcher, run: SyncRun): SyncUpdate {
  const update: SyncUpdate = {
    retire: null,
    refreshLibrary: false,
    toast: null,
  }
  const previous = watcher.latest
  watcher.latest = run.run_id
  if (previous && previous !== run.run_id) {
    const state = watcher.runs.get(previous)
    if (state && state !== "done") {
      watcher.runs.set(previous, "done")
      update.retire = previous
      update.refreshLibrary = true
    }
  }
  const state = watcher.runs.get(run.run_id)
  if (run.status === "running") {
    if (state === "hidden" || state === "done") return update
    // Webhook syncs stay quiet unless someone asked to watch them.
    if (run.origin !== "manual") {
      watcher.runs.set(run.run_id, "quiet")
      return update
    }
    watcher.runs.set(run.run_id, "running")
    return { ...update, toast: "progress" }
  }
  // Only runs seen running are announced; old results stay silent on reload.
  if (!state || state === "done") return update
  watcher.runs.set(run.run_id, "done")
  if (run.status === "succeeded") update.refreshLibrary = true
  if (state === "quiet") return update
  return { ...update, toast: run.status === "succeeded" ? "success" : "error" }
}

// The user closed the progress toast; keep it closed until the result.
export function hideSyncRun(watcher: SyncWatcher, runId: string) {
  if (watcher.runs.get(runId) === "running") watcher.runs.set(runId, "hidden")
}
