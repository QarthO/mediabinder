import { createFileRoute } from "@tanstack/react-router"
import { Brand } from "@/components/brand"

export const Route = createFileRoute("/privacy")({ component: Privacy })
function Privacy() {
  return (
    <main className="privacy-page">
      <a href="/" aria-label="MediaBinder home">
        <Brand />
      </a>
      <h1>Privacy</h1>
      <p>
        MediaBinder is a private media library. This notice describes the
        instance at rien.cloud.
      </p>
      <h2>What we access and store</h2>
      <p>
        Google sign-in provides your name, email address, and profile image. We
        store account and session information to keep your library private, and
        encrypted Google OAuth tokens to maintain your Drive connection.
      </p>
      <p>
        Google grants read-only access to Drive. Folder browsing lists folders
        available to your account; syncing reads the folders you link and their
        subfolders. We store file identifiers, names, dates, sizes, dimensions,
        folder relationships, and the tags, sets, and post links you enter in
        the application database.
      </p>
      <h2>Shared catalog</h2>
      <p>
        Identical file contents share a catalog entry across this instance,
        including across different users and folders. People who connect an
        identical file or the same Drive file can see and edit its display name,
        tags, sets, and post links. Only media available through your linked
        folders is shown; another user’s private folder identifiers and
        inaccessible set members are not included. Treat catalog metadata as
        shared with other users who have the same content.
      </p>
      <h2>Previews and automatic sync</h2>
      <p>
        Images and videos are transmitted through the application server for
        authenticated previews. Original media stays in Google Drive. Thumbnails
        are temporarily cached in server memory and may be cached by your
        browser. Google notifications let the server refresh your library while
        you are away.
      </p>
      <h2>How information is used</h2>
      <p>
        Information is used to sign you in, organize your library, show
        previews, and synchronize linked folders. MediaBinder has no advertising
        or social-platform integration; adding a post link does not send your
        media to that platform. Hosting and database infrastructure process
        information needed to run the service. Operational logs may contain
        request timing, errors, and technical identifiers.
      </p>
      <p>
        MediaBinder does not sell your Google user data or use it to train AI
        models. Its use and transfer of information received from Google APIs
        adheres to the{" "}
        <a href="https://developers.google.com/terms/api-services-user-data-policy">
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements.
      </p>
      <h2>Retention and your choices</h2>
      <p>
        Library metadata remains stored until it is deleted by the instance
        administrator. Unlinking a folder hides its media from the active
        library and preserves existing metadata. It does not delete originals in
        Drive. You can revoke MediaBinder’s access through{" "}
        <a href="https://myaccount.google.com/connections">
          your Google Account connections
        </a>
        ; revoking access stops future authorized Drive access but does not
        itself erase stored metadata.
      </p>
      <p>
        For questions or to request deletion of your account and stored
        application data, contact{" "}
        <a href="mailto:qartho@gmail.com">qartho@gmail.com</a>.
      </p>
      <a href="/">Back to MediaBinder</a>
    </main>
  )
}
