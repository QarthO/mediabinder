import { type ComponentProps, useEffect, useRef } from "react"
import {
  queryOptions,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { action } from "@/lib/api"
import type { SyncRun } from "@/lib/types"
import { Button } from "./ui/button"

// The server records each sync's progress; only DriveSyncMonitor polls it.
export const syncStatusQuery = queryOptions({
  queryKey: ["sync-status"],
  queryFn: () => action<SyncRun | null>("sync-status"),
  staleTime: 5_000,
})
const startKey = ["sync-start"]
const isRunning = (run: SyncRun | null) => run?.status === "running"

export function useDriveSyncBusy() {
  const { data: running = false } = useQuery({
    ...syncStatusQuery,
    select: isRunning,
  })
  return useIsMutating({ mutationKey: startKey }) > 0 || running
}

export function DriveSyncButton({
  label = "Sync Drive",
  disabled,
  ...props
}: Omit<ComponentProps<typeof Button>, "onClick" | "children"> & {
  label?: string
}) {
  const client = useQueryClient()
  const busy = useDriveSyncBusy()
  const start = useMutation({
    mutationKey: startKey,
    mutationFn: () => action<SyncRun | null>("sync"),
    onSuccess: (run) => client.setQueryData(syncStatusQuery.queryKey, run),
    onError: (error) => toast.error(error.message),
  })
  return (
    <Button
      {...props}
      aria-label={busy ? "Syncing Drive" : label}
      disabled={disabled || busy}
      onClick={() => start.mutate()}
    >
      <RefreshCw className={busy ? "spin" : ""} />
      <span>{busy ? "Syncing…" : label}</span>
    </Button>
  )
}

const count = new Intl.NumberFormat()
function items(value: number) {
  return `${count.format(value)} media ${value === 1 ? "item" : "items"}`
}

function SyncProgress({ run }: { run: SyncRun }) {
  const saving = run.phase === "saving" && run.files_total > 0
  const percent = saving
    ? Math.min(100, Math.floor((run.files_saved / run.files_total) * 100))
    : null
  return (
    <div className="sync-progress">
      <span>
        {saving
          ? `Saving ${count.format(run.files_saved)} of ${items(run.files_total)}`
          : `Scanning ${count.format(run.folders_scanned)} ${run.folders_scanned === 1 ? "folder" : "folders"} · ${count.format(run.files_found)} found`}
      </span>
      <div
        className="sync-progress-track"
        role="progressbar"
        aria-label="Sync progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <div
          className={percent === null ? "indeterminate" : undefined}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

// Mirrors the server's sync run into a single updating toast. Toasts are an
// external system, so this is the boundary that subscribes to the run.
export function DriveSyncMonitor() {
  const client = useQueryClient()
  const { data: run } = useQuery({
    ...syncStatusQuery,
    refetchInterval: (query) =>
      query.state.data?.status === "running" ? 1000 : false,
  })
  const watched = useRef(new Map<string, "running" | "hidden" | "done">())
  useEffect(() => {
    if (!run) return
    const id = `drive-sync-${run.run_id}`
    const state = watched.current.get(run.run_id)
    if (run.status === "running") {
      // Webhook syncs stay quiet unless someone asked to watch them.
      if (run.origin !== "manual" || state === "hidden" || state === "done")
        return
      watched.current.set(run.run_id, "running")
      toast.loading("Syncing Google Drive", {
        id,
        description: <SyncProgress run={run} />,
        duration: Infinity,
        closeButton: true,
        onDismiss: () => {
          if (watched.current.get(run.run_id) === "running")
            watched.current.set(run.run_id, "hidden")
        },
      })
      return
    }
    // Only announce runs this tab watched; old results stay silent on reload.
    if (!state || state === "done") return
    watched.current.set(run.run_id, "done")
    if (run.status === "succeeded") {
      void client.invalidateQueries({ queryKey: ["library"] })
      toast.success(`Synced ${items(run.item_count ?? run.files_total)}`, {
        id,
        description: undefined,
        duration: 5000,
      })
    } else
      toast.error(run.error ?? "Sync failed. Please try again.", {
        id,
        description: undefined,
        duration: 8000,
      })
  }, [run, client])
  return null
}
