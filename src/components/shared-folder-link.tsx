import { useEffect, useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Copy,
  ExternalLink,
  FolderPlus,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react"
import { toast } from "sonner"
import { action } from "@/lib/api"
import { folderIdFromInput } from "@/lib/validation"
import { pickDriveFolder, type PickerSession } from "@/lib/google-picker"
import type { LinkResult } from "@/lib/library.server"
import type { Library } from "@/lib/types"
import { Button } from "./ui/button"
import { Input } from "./ui/input"

type Folder = { id: string; name: string | null }
type Step =
  | { kind: "idle" }
  | { kind: "create" }
  | { kind: "share"; folder: Folder; reason: string }

const NEW_FOLDER_NAME = "MediaBinder"
const POLL_MS = 4000

// Shared-folder mode: MediaBinder reads only folders shared with its service
// account. Google lets MediaBinder add that share itself only for folders it
// created; existing folders are shared by the user in Drive, and this panel
// links them as soon as the share reaches Google.
export function SharedFolderLink({
  workspace,
  disabled,
}: {
  workspace: Library["workspace"]
  disabled: boolean
}) {
  const access = workspace.drive_access
  const shareAddress = access.share_address ?? ""
  const [step, setStep] = useState<Step>({ kind: "idle" })
  const [paste, setPaste] = useState("")
  const [copied, setCopied] = useState(false)
  const client = useQueryClient()
  const polling = useRef<AbortController | null>(null)
  useEffect(() => () => polling.current?.abort(), [])
  const linked = (id: string) =>
    workspace.sources.some((source) => source.folder_id === id)

  const done = async (result: Extract<LinkResult, { ok: true }>) => {
    polling.current?.abort()
    await client.invalidateQueries({ queryKey: ["library"] })
    setStep({ kind: "idle" })
    setPaste("")
    toast.success(`${result.folder_name} linked. Sync Drive to add its media.`)
  }
  // Wait for the user's Drive share to reach the service account.
  const waitForShare = (folder: Folder) => {
    polling.current?.abort()
    const controller = new AbortController()
    polling.current = controller
    void (async () => {
      while (!controller.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
        if (controller.signal.aborted) return
        let result: LinkResult
        try {
          result = await action<LinkResult>("source", { folderId: folder.id })
        } catch (error) {
          // A refusal (for example someone else's folder) won't change by waiting.
          if (controller.signal.aborted) return
          controller.abort()
          setStep({ kind: "idle" })
          toast.error(
            error instanceof Error ? error.message : "Couldn't link the folder."
          )
          return
        }
        if (result.ok && !controller.signal.aborted) return done(result)
      }
    })()
  }
  const needsShare = (folder: Folder, reason: string) => {
    setCopied(false)
    setStep({ kind: "share", folder, reason })
    waitForShare(folder)
  }
  const cancel = () => {
    polling.current?.abort()
    setStep({ kind: "idle" })
  }

  const link = useMutation({
    mutationFn: (input: { folder: Folder; share?: boolean }) =>
      action<LinkResult>("source", {
        folderId: input.folder.id,
        share: input.share ?? false,
      }),
    onSuccess: (result, input) =>
      result.ok
        ? done(result)
        : needsShare(
            {
              id: result.folder_id,
              name: result.folder_name ?? input.folder.name,
            },
            result.reason
          ),
    onError: (error) => toast.error(error.message),
  })
  const choose = useMutation({
    mutationFn: async () =>
      pickDriveFolder(await action<PickerSession>("picker-session")),
    onSuccess: (folder) => {
      if (!folder) return
      if (linked(folder.id))
        return toast.info(`${folder.name} is already linked.`)
      link.mutate({ folder })
    },
    onError: (error) => toast.error(error.message),
  })
  const create = useMutation({
    mutationFn: () =>
      action<LinkResult>("create-folder", { name: NEW_FOLDER_NAME }),
    onSuccess: (result) =>
      result.ok
        ? done(result)
        : needsShare(
            { id: result.folder_id, name: result.folder_name },
            result.reason
          ),
    onError: (error) => toast.error(error.message),
  })
  const copy = () =>
    navigator.clipboard
      .writeText(shareAddress)
      .then(() => {
        setCopied(true)
        return true
      })
      .catch(() => {
        toast.error("Couldn't copy. Select the address instead.")
        return false
      })
  // One click: copy the address, then open the folder in Drive. The copy
  // starts first, while this page still has focus; opening a tab is still
  // part of the same click, so browsers don't treat it as a popup.
  const copyAndOpen = (folder: Folder) => {
    void copy()
    window.open(
      `https://drive.google.com/drive/folders/${folder.id}`,
      "_blank",
      "noopener,noreferrer"
    )
  }
  const busy =
    disabled || choose.isPending || link.isPending || create.isPending

  if (step.kind === "create")
    return (
      <div className="share-panel" role="dialog" aria-labelledby="share-title">
        <ShieldCheck size={20} />
        <div>
          <h3 id="share-title">Create a “{NEW_FOLDER_NAME}” folder?</h3>
          <p>
            MediaBinder creates an empty folder in your Drive and shares it with
            its sync account as a <strong>viewer</strong>. Anything you add to
            it, including subfolders, syncs automatically. MediaBinder can't see
            anything else in your Drive.
          </p>
          <div className="settings-actions">
            <Button variant="ghost" onClick={cancel}>
              Cancel
            </Button>
            <Button disabled={create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? "Creating…" : "Create folder"}
            </Button>
          </div>
        </div>
      </div>
    )

  if (step.kind === "share")
    return (
      <div className="share-panel" role="alert">
        <FolderPlus size={20} />
        <div>
          <h3>Share “{step.folder.name ?? "this folder"}” with MediaBinder</h3>
          <p>{step.reason} Share it with MediaBinder in Google Drive:</p>
          <Button onClick={() => copyAndOpen(step.folder)}>
            <Copy />
            Copy address &amp; open in Drive
            <ExternalLink />
          </Button>
          <p className="share-steps">
            {copied ? "Address copied. " : ""}In Drive, select{" "}
            <strong>Share</strong>, paste the address, set it to{" "}
            <strong>Viewer</strong>, then send.
          </p>
          <span className="share-copy">
            <code className="share-address">{shareAddress}</code>
            <button
              className="icon-button"
              aria-label="Copy MediaBinder's sync address"
              onClick={() => void copy()}
            >
              <Copy size={15} />
            </button>
          </span>
          <p className="share-waiting" role="status">
            <LoaderCircle size={14} />
            Waiting for Google… MediaBinder links the folder as soon as it's
            shared.
          </p>
          <div className="settings-actions">
            <Button variant="ghost" onClick={cancel}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              disabled={link.isPending}
              onClick={() => link.mutate({ folder: step.folder })}
            >
              {link.isPending ? "Checking…" : "Check now"}
            </Button>
          </div>
        </div>
      </div>
    )

  const pastedId = paste.trim() ? folderIdFromInput(paste) : ""
  return (
    <>
      <p className="settings-hint">
        MediaBinder syncs only the folders you share with it, including their
        subfolders and new files. It can't see anything else in your Drive.
      </p>
      <div className="settings-actions settings-actions-start">
        <Button
          disabled={busy || !access.picker}
          onClick={() => choose.mutate()}
        >
          <FolderPlus />
          {choose.isPending || link.isPending
            ? "Opening…"
            : "Choose a Drive folder"}
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => setStep({ kind: "create" })}
        >
          or create a new MediaBinder folder
        </Button>
      </div>
      <form
        className="paste-folder"
        onSubmit={(event) => {
          event.preventDefault()
          link.mutate({ folder: { id: pastedId, name: null } })
        }}
      >
        <label className="field">
          Or paste a link to a folder you've already shared with MediaBinder
          <Input
            value={paste}
            onChange={(event) => setPaste(event.target.value)}
            placeholder="https://drive.google.com/drive/folders/…"
          />
        </label>
        <Button
          variant="secondary"
          type="submit"
          disabled={!pastedId || busy || linked(pastedId)}
        >
          {linked(pastedId) ? "Already linked" : "Link folder"}
        </Button>
      </form>
    </>
  )
}
