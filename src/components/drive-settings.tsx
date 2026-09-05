import { useState } from "react"
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query"
import {
  FolderOpen,
  ArrowUpRight,
  RefreshCw,
  Check,
  HardDrive,
  ShieldCheck,
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
  const [folder, setFolder] = useState(workspace.folder_id ?? ""),
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
      toast.success("Source folder saved. Sync Drive to update your library.")
    },
    onError: (e) => toast.error(e.message),
  })
  return (
    <div className="settings-content">
      <section className="settings-card">
        <div className="settings-section-heading">
          <div className="settings-icon">
            <HardDrive size={21} />
          </div>
          <div>
            <h2>Google Drive</h2>
            <p>Your files live here. MediaBinder keeps them organized.</p>
          </div>
          <span className="connection-badge">
            <span className="status-dot connected" />
            Connected
          </span>
        </div>
        <div className="settings-body">
          <h3>Source folder</h3>
          <p>
            Sync images and videos from a folder and its subfolders. Shared
            folders work too, as long as your Google account can access them.
          </p>
          {workspace.folder_name && (
            <div className="current-folder">
              <FolderOpen size={20} />
              <div>
                <strong>{workspace.folder_name}</strong>
                <small>
                  Last synced: {dateValue(workspace.last_synced_at)}
                </small>
              </div>
              <a
                href={`https://drive.google.com/drive/folders/${workspace.folder_id}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open source folder in Drive"
              >
                <ArrowUpRight size={17} />
              </a>
            </div>
          )}
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
              <Button type="submit" disabled={!folder.trim() || save.isPending}>
                {save.isPending ? "Saving…" : "Save folder"}
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
                        onClick={() => setFolder(f.id)}
                        className={folder === f.id ? "chosen" : ""}
                      >
                        <FolderOpen size={16} />
                        <span>
                          {f.name}
                          <small>{f.id}</small>
                        </span>
                        {folder === f.id && <Check size={15} />}
                      </button>
                    ))}
                  {!folders.data.length && (
                    <p>No folders found. Paste a shared folder link above.</p>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="settings-note">
            <ShieldCheck size={17} />
            <p>
              Drive access is read-only. Names, tags, sets, and post links are
              stored in MediaBinder. Your original files stay as they are.
            </p>
          </div>
        </div>
        <div className="settings-card-footer">
          <span>Having trouble accessing your files?</span>
          <Button
            variant="outline"
            onClick={async () => {
              try {
                const result = await authClient.linkSocial({
                  provider: "google",
                  callbackURL: "/",
                })
                if (result.error) throw new Error(result.error.message)
              } catch (e) {
                toast.error(
                  e instanceof Error ? e.message : "Could not reconnect Google"
                )
              }
            }}
          >
            <RefreshCw />
            Reconnect Google
          </Button>
        </div>
      </section>
      <section className="settings-card privacy-card">
        <ShieldCheck size={21} />
        <div>
          <h3>A private workspace</h3>
          <p>
            New sign-ups are disabled by default. The first account is the
            superuser. Access is controlled by your server configuration.
          </p>
        </div>
      </section>
    </div>
  )
}
