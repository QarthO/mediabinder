// Google's folder picker. Choosing a folder grants MediaBinder's drive.file
// token access to that folder only, which is what lets the server share it.
declare global {
  interface Window {
    gapi?: {
      load: (
        name: string,
        options: { callback: () => void; onerror: () => void }
      ) => void
    }
    google?: { picker?: any }
  }
}
export interface PickerSession {
  token: string
  apiKey: string
  appId: string
}
const FOLDER = "application/vnd.google-apps.folder"
let loading: Promise<void> | null = null

function loadPicker() {
  if (window.google?.picker) return Promise.resolve()
  loading ??= new Promise<void>((resolve, reject) => {
    const fail = () => {
      loading = null
      reject(new Error("Couldn't load Google's folder picker. Try again."))
    }
    const script = document.createElement("script")
    script.src = "https://apis.google.com/js/api.js"
    script.async = true
    script.onload = () =>
      window.gapi
        ? window.gapi.load("picker", { callback: resolve, onerror: fail })
        : fail()
    script.onerror = fail
    document.head.append(script)
  })
  return loading
}

export async function pickDriveFolder(
  session: PickerSession
): Promise<{ id: string; name: string } | null> {
  await loadPicker()
  const picker = window.google!.picker
  const folders = (drives: boolean) =>
    new picker.DocsView(picker.ViewId.FOLDERS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true)
      .setMimeTypes(FOLDER)
      .setEnableDrives(drives)
  return new Promise((resolve) => {
    new picker.PickerBuilder()
      .setTitle("Choose a folder to sync")
      .addView(folders(false).setOwnedByMe(true).setLabel("My Drive"))
      .addView(folders(false).setOwnedByMe(false).setLabel("Shared with me"))
      .addView(folders(true).setLabel("Shared drives"))
      .enableFeature(picker.Feature.SUPPORT_DRIVES)
      .setOAuthToken(session.token)
      .setDeveloperKey(session.apiKey)
      .setAppId(session.appId)
      .setCallback((data: any) => {
        const action = data[picker.Response.ACTION]
        if (action === picker.Action.PICKED) {
          const doc = data[picker.Response.DOCUMENTS][0]
          resolve({
            id: doc[picker.Document.ID],
            name: doc[picker.Document.NAME],
          })
        } else if (action === picker.Action.CANCEL) resolve(null)
      })
      .build()
      .setVisible(true)
  })
}
