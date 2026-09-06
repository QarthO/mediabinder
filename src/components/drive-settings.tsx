import { useState } from "react"
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
import { Input } from "./ui/input"
import type { Library } from "@/lib/types"
export function DriveSettings({
  workspace,
}: {
  workspace: Library["workspace"]
}) {
  const [folder, setFolder] = useState(""),
    [removing, setRemoving] = useState<string | null>(null),
    [browse, setBrowse] = useState(false),
    [search, setSearch] = useState("")
  const client = useQueryClient()
  const router = useRouter()
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
  const unlink = useMutation({
    mutationFn: (folderId: string) => action("remove-source", { folderId }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["library"] })
      await router.invalidate()
      setRemoving(null)
      toast.success("Folder unlinked. Its metadata is preserved.")
    },
    onError: (e) => toast.error(e.message),
  })
  const sync = useMutation({
    mutationFn: () => action<{ count: number }>("sync"),
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: ["library"] })
      toast.success(`Synced ${result.count} media items`)
    },
    onError: (e) => toast.error(e.message),
  })
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
                  sync.isPending
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
                  <Button variant="outline" onClick={() => folders.refetch()}>
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
                    <p>No folders found. Paste a shared folder link above.</p>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="settings-folders">
            <div className="section-heading">
              <h3>
                Linked folders <span>{workspace.sources.length}</span>
              </h3>
              <Button
                variant="outline"
                disabled={!workspace.sources.length || sync.isPending}
                onClick={() => sync.mutate()}
              >
                <RefreshCw className={sync.isPending ? "spin" : ""} />
                {sync.isPending ? "Syncing…" : "Sync all folders"}
              </Button>
            </div>
            {!workspace.sources.length && <p>No folders linked yet.</p>}
            <div className="source-list">
              {workspace.sources.map((source) => (
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
                      onClick={() => setRemoving(source.folder_id)}
                      disabled={unlink.isPending || sync.isPending}
                    >
                      <Unlink size={17} />
                    </button>
                  </div>
                  {removing === source.folder_id && (
                    <div className="unlink-confirm" role="alert">
                      <p>
                        Unlink this folder? Media unique to it will be hidden.
                        Your edits are kept if you link it again.
                      </p>
                      <div className="settings-actions">
                        <Button
                          variant="ghost"
                          onClick={() => setRemoving(null)}
                        >
                          Cancel
                        </Button>
                        <Button
                          variant="destructive"
                          disabled={unlink.isPending}
                          onClick={() => unlink.mutate(source.folder_id)}
                        >
                          {unlink.isPending ? "Unlinking…" : "Unlink folder"}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
