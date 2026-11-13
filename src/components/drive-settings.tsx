import { memo, useRef, useState } from "react"
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import {
  FolderOpen,
  ArrowUpRight,
  RefreshCw,
  Check,
  Unlink,
} from "lucide-react"
import { toast } from "sonner"
import { action } from "@/lib/api"
import { authClient } from "@/lib/auth-client"
import { folderIdFromInput } from "@/lib/validation"
import { dateValue } from "@/lib/utils"
import { Button } from "./ui/button"
import { ConfirmDialog } from "./ui/confirm-dialog"
import { Input } from "./ui/input"
import { DriveSyncButton, useDriveSyncBusy } from "./drive-sync"
import { SharedFolderLink } from "./shared-folder-link"
import type { Library } from "@/lib/types"
export function DriveSettings({
  workspace,
}: {
  workspace: Library["workspace"]
}) {
  const [folder, setFolder] = useState(""),
    [browse, setBrowse] = useState(false),
    [search, setSearch] = useState("")
  const client = useQueryClient()
  const folders = useQuery({
    queryKey: ["drive-folders"],
    queryFn: () => action<{ id: string; name: string }[]>("folders"),
    enabled: browse,
    staleTime: 60_000,
  })
  const save = useMutation({
    mutationFn: () => action("source", { folderId: folderIdFromInput(folder) }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["library"] })
      setBrowse(false)
      setFolder("")
      toast.success("Folder linked. Sync Drive to add its media.")
    },
    onError: (e) => toast.error(e.message),
  })
  const syncing = useDriveSyncBusy()
  const sharedMode = workspace.drive_access.mode === "shared-folder"
  const alreadyLinked = workspace.sources.some(
    (source) => source.folder_id === folderIdFromInput(folder)
  )
  const reconnect = useMutation({
    mutationFn: () =>
      authClient.linkSocial({ provider: "google", callbackURL: "/" }),
    onSuccess: (result) => {
      if (result.error) toast.error(result.error.message)
    },
    onError: (error) =>
      toast.error(error.message || "Could not reconnect Google"),
  })
  return (
    <div className="settings-content">
      <section className="settings-card">
        <div className="settings-body">
          <div className="section-heading settings-top">
            <h2>Google Drive</h2>
            <Button
              variant="outline"
              disabled={reconnect.isPending}
              onClick={() => reconnect.mutate()}
            >
              <RefreshCw />
              Reconnect Google
            </Button>
          </div>
          <h3>Link folder</h3>
          {sharedMode ? (
            <SharedFolderLink workspace={workspace} disabled={syncing} />
          ) : (
            <>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  save.mutate()
                }}
              >
                <label className="field">
                  Folder link or ID
                  <Input
                    value={folder}
                    onChange={(e) => setFolder(e.target.value)}
                    placeholder="Paste a Google Drive folder link"
                    required
                  />
                </label>
                <div className="settings-actions">
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => setBrowse((v) => !v)}
                  >
                    <FolderOpen />
                    Browse folders
                  </Button>
                  <Button
                    variant="secondary"
                    type="submit"
                    disabled={
                      !folder.trim() ||
                      save.isPending ||
                      alreadyLinked ||
                      syncing
                    }
                  >
                    {alreadyLinked
                      ? "Already linked"
                      : save.isPending
                        ? "Linking…"
                        : "Link folder"}
                  </Button>
                </div>
              </form>
              {browse && (
                <div className="folder-picker">
                  <Input
                    aria-label="Find a Drive folder"
                    placeholder="Find a folder…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  {folders.isPending ? (
                    <p>Loading folders…</p>
                  ) : folders.isError ? (
                    <div role="alert">
                      <p>{folders.error.message}</p>
                      <Button
                        variant="outline"
                        onClick={() => folders.refetch()}
                      >
                        Retry
                      </Button>
                    </div>
                  ) : (
                    <div className="folder-options">
                      {folders.data
                        .filter((f) =>
                          f.name.toLowerCase().includes(search.toLowerCase())
                        )
                        .map((f) => (
                          <button
                            key={f.id}
                            disabled={workspace.sources.some(
                              (source) => source.folder_id === f.id
                            )}
                            onClick={() => setFolder(f.id)}
                            className={folder === f.id ? "chosen" : ""}
                          >
                            <FolderOpen size={16} />
                            <span>
                              {f.name}
                              <small>{f.id}</small>
                            </span>
                            {(folder === f.id ||
                              workspace.sources.some(
                                (source) => source.folder_id === f.id
                              )) && <Check size={15} />}
                          </button>
                        ))}
                      {!folders.data.length && (
                        <p>
                          No folders found. Paste a shared folder link above.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          <div className="settings-folders">
            <div className="section-heading">
              <h3>
                Linked folders <span>{workspace.sources.length}</span>
              </h3>
              <DriveSyncButton
                variant="outline"
                label="Sync all folders"
                disabled={!workspace.sources.length}
              />
            </div>
            {!workspace.sources.length && <p>No folders linked yet.</p>}
            <LinkedFolders
              sources={workspace.sources}
              sharedMode={sharedMode}
              syncing={syncing}
            />
          </div>
        </div>
      </section>
    </div>
  )
}

type Source = Library["workspace"]["sources"][number]

// Owns the folder being unlinked, so opening the dialog re-renders only this
// list and not the rest of the settings.
const LinkedFolders = memo(function LinkedFolders({
  sources,
  sharedMode,
  syncing,
}: {
  sources: Source[]
  sharedMode: boolean
  syncing: boolean
}) {
  const [target, setTarget] = useState<Source | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const client = useQueryClient()
  const router = useRouter()
  const unlink = useMutation({
    mutationFn: (folderId: string) =>
      action<{
        ok: boolean
        access_removed?: boolean
        share_address?: string | null
      }>("remove-source", { folderId }),
  })
  return (
    <>
      <div className="source-list">
        {sources.map((source) => (
          <div className="source-entry" key={source.folder_id}>
            <div className="current-folder">
              <FolderOpen size={20} />
              <div>
                <strong>{source.folder_name}</strong>
                <small>
                  {source.last_synced_at
                    ? `Last synced ${dateValue(source.last_synced_at)}`
                    : "Not synced yet"}
                </small>
              </div>
              <a
                href={`https://drive.google.com/drive/folders/${source.folder_id}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open ${source.folder_name} in Drive`}
              >
                <ArrowUpRight size={17} />
              </a>
              <button
                className="icon-button"
                aria-label={`Unlink ${source.folder_name}`}
                title="Unlink folder"
                onClick={(event) => {
                  opener.current = event.currentTarget
                  setTarget(source)
                }}
                disabled={unlink.isPending || syncing}
              >
                <Unlink size={17} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setTarget(null)
        }}
        title={target ? `Unlink ${target.folder_name}?` : "Unlink folder?"}
        description={
          target
            ? `Media unique to this folder will be hidden. Your edits are kept if you link it again.${
                sharedMode
                  ? target.shared_by_app
                    ? " MediaBinder also tries to remove its access to the folder."
                    : " MediaBinder stops syncing it; you can remove its access from the folder's sharing in Drive."
                  : ""
              }`
            : undefined
        }
        onCloseAutoFocus={(event) => {
          // The opener is gone once the folder is unlinked.
          if (opener.current?.isConnected) {
            event.preventDefault()
            opener.current.focus()
          }
        }}
        confirmLabel="Unlink folder"
        pendingLabel="Unlinking…"
        variant="destructive"
        onConfirm={async () => {
          if (!target) return
          const result = await unlink.mutateAsync(target.folder_id)
          await client.invalidateQueries({ queryKey: ["library"] })
          await router.invalidate()
          if (result.share_address && !result.access_removed)
            toast.info(
              `Folder unlinked. MediaBinder no longer syncs it. To remove its access too, remove ${result.share_address} from the folder's sharing in Drive.`,
              { duration: 12_000 }
            )
          else toast.success("Folder unlinked. Its metadata is preserved.")
        }}
      />
    </>
  )
})
