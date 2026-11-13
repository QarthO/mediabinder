import type { SyncStatus } from "./types"

// running/hidden: progress toast shown or closed by the user;
// checking/muted: the sync succeeded and the toast, or its closed remains,
// follows the video format checks that go on in the background;
// quiet: an unclaimed webhook run; done: its result has been handled.
export type WatchState =
  | "running"
  | "hidden"
  | "quiet"
  | "checking"
  | "muted"
  | "done"

export interface SyncWatcher {
  runs: Map<string, WatchState>
  latest: { id: string; startedAt: string } | null
  // The most videos seen waiting during this run's format checks.
  codecTotal: number
}

export interface SyncUpdate {
  // A superseded run whose progress toast should be removed.
  retire: string | null
  refreshLibrary: boolean
  toast: "progress" | "checking" | "success" | "error" | null
  // Set with the "checking" toast.
  codecs?: { done: number; total: number }
}

export function createSyncWatcher(): SyncWatcher {
  return { runs: new Map(), latest: null, codecTotal: 0 }
}

// Decides how one observed run changes the toast. The server keeps only the
// newest run per user, so a run this tab followed can be replaced before its
// result arrives; its toast is retired without inventing a result.
export function observeSyncRun(
  watcher: SyncWatcher,
  run: SyncStatus
): SyncUpdate {
  const update: SyncUpdate = {
    retire: null,
    refreshLibrary: false,
    toast: null,
  }
  const previous = watcher.latest
  if (previous && previous.id !== run.run_id) {
    // A delayed response can return an older run after a newer one; it must
    // not replace the run being followed. Timestamps share one SQL format.
    if (run.started_at < previous.startedAt) return update
    const state = watcher.runs.get(previous.id)
    if (state && state !== "done") {
      watcher.runs.set(previous.id, "done")
      update.retire = previous.id
      update.refreshLibrary = true
    }
  }
  watcher.latest = { id: run.run_id, startedAt: run.started_at }
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
  // A sync that succeeded leaves its videos to be read in the background; the
  // toast stays to show how far that is. A webhook run's results stay quiet.
  if (
    run.status === "succeeded" &&
    run.codecs_pending > 0 &&
    state !== "quiet"
  ) {
    if (state === "running" || state === "hidden") {
      watcher.runs.set(run.run_id, state === "running" ? "checking" : "muted")
      watcher.codecTotal = 0
      update.refreshLibrary = true
    }
    watcher.codecTotal = Math.max(watcher.codecTotal, run.codecs_pending)
    if (watcher.runs.get(run.run_id) !== "checking") return update
    return {
      ...update,
      toast: "checking",
      codecs: {
        done: watcher.codecTotal - run.codecs_pending,
        total: watcher.codecTotal,
      },
    }
  }
  watcher.runs.set(run.run_id, "done")
  if (run.status === "succeeded") update.refreshLibrary = true
  if (state === "quiet") return update
  return { ...update, toast: run.status === "succeeded" ? "success" : "error" }
}

// The user closed the progress toast; keep it closed until the result.
export function hideSyncRun(watcher: SyncWatcher, runId: string) {
  const state = watcher.runs.get(runId)
  if (state === "running") watcher.runs.set(runId, "hidden")
  if (state === "checking") watcher.runs.set(runId, "muted")
}

/** Whether the run's video format checks are being followed, so keep polling. */
export function isCheckingFormats(watcher: SyncWatcher, runId: string) {
  const state = watcher.runs.get(runId)
  return state === "checking" || state === "muted"
}

/**
 * The format checks stopped making progress (a file Drive keeps refusing, or
 * no worker running): the sync's result is announced as it would have been,
 * and polling stops.
 */
export function giveUpChecking(
  watcher: SyncWatcher,
  runId: string
): SyncUpdate {
  const update: SyncUpdate = {
    retire: null,
    refreshLibrary: false,
    toast: null,
  }
  if (!isCheckingFormats(watcher, runId)) return update
  watcher.runs.set(runId, "done")
  return { ...update, refreshLibrary: true, toast: "success" }
}
