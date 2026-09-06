# MediaBinder

A private media library for Google Drive. TanStack Start, React Query, Table, and Virtual, shadcn/Radix, Better Auth, and MySQL. A compact blue workspace inspired by Kiln, with grid/list views, folder multi-select, search, colored inline and bulk tagging, sets, ⌘K, and ⌘B to toggle the sidebar.

Original images and videos stay in Drive. MediaBinder stores display names, raw filenames, tags, dates, set membership, and social post links in its own database. Sets are flat, and a media item can belong to any number of sets. Posts accept any platform name, an HTTP(S) link, an optional post ID, and a date; both media and sets can have posts.

## Run with Docker

1. Copy `.env.example` to `.env`. Set independent random database passwords and a random `BETTER_AUTH_SECRET` of at least 32 characters (`openssl rand -hex 32`). Use the same application database password in `MYSQL_PASSWORD` and `DATABASE_URL`.
2. Configure Google OAuth as described below.
3. Run `docker compose up -d --build` for production, or `pnpm dev:docker` for development with hot reload.
4. Open **http://localhost:3100**. The root is the login page; signed-in users go to `/media`. Link one or more folders in Settings. The app syncs on fresh page loads and supports manual sync.

The first verified Google account becomes the superuser. Further sign-ups are rejected unless `ALLOW_SIGNUPS=true` is explicitly configured. Existing accounts can still sign in. Drive connections are scoped to each user; identical media shares catalog metadata across the instance. There is no public registration or landing page. Claim the first account before exposing a fresh instance to the internet.

MySQL data persists in the `mysql-data` volume. `pnpm dev:docker:down` stops development without deleting the database. For a deployment behind a reverse proxy, set `MEDIABINDER_URL` to the public HTTPS origin and add its exact callback URL in Google Cloud. Keep the app and database on the private Docker network; the default host binding is loopback only.

## Coolify: Dockerfile with separate MySQL

Choose the **Dockerfile** build pack, base directory `/`, Dockerfile `/Dockerfile`, and **Ports Exposes `3100`**. Leave the build target at its default (the final `production` stage), and leave the start command and pre/post-deploy commands empty. Set the application's domain to your public HTTPS URL. If configuring Coolify's health check, use HTTP `GET /api/health` on port `3100`. The image also supplies its own Docker health check.

Create a MySQL 8 service/database with a persistent volume, and make it reachable from the app's Docker network. `DB_HOST` is its internal hostname, not `localhost` and not a `mysql://` URL. The database must exist and its user needs permissions to create/alter tables, indexes and constraints as well as read/write data; the app creates its schema automatically.

Set these **eight runtime environment variables** in Coolify (build-time availability is unnecessary):

```dotenv
MEDIABINDER_URL=https://media.example.com
DB_HOST=your-mysql-internal-hostname
DB_NAME=mediabinder
DB_USER=mediabinder
DB_PASS=your-database-password
BETTER_AUTH_SECRET=your-generated-secret-at-least-32-characters
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-google-client-secret
```

Generate the auth secret with `openssl rand -hex 32` and retain it across deployments. If importing an existing MediaBinder database, retain that database's original secret so encrypted Google tokens remain readable. Enter `DB_PASS` literally; do not URL-encode it. `DB_PORT` defaults to `3306`.

In the Google Web application OAuth client, add the authorized redirect URI **`https://media.example.com/api/auth/callback/google`**. Keep the localhost redirect too if using the same OAuth client for development. The app domain, `MEDIABINDER_URL`, and the redirect URI must agree. Enable the Drive API in that Google project; the Google credentials are separate from Coolify's GitHub App credentials.

The image validates runtime configuration, retries transient MySQL connection failures up to 30 times with a two-second delay (following Kiln’s startup pattern), applies migrations under a database lock, and starts both the web server and Drive worker. Applied application migrations are recorded and skipped on redeployment. It stops the container if either service fails, allowing Coolify to restart it. No separate worker service or app volume is needed; MySQL holds persistent state, and thumbnails use an ephemeral memory cache. No `DATABASE_URL`, `BETTER_AUTH_URL`, `MYSQL_PASSWORD`, `MYSQL_ROOT_PASSWORD`, `PORT`, or `HOST` is required in the standalone app's environment. Existing `DATABASE_URL` and `BETTER_AUTH_URL` deployments remain supported; `DB_*` and `MEDIABINDER_URL` take precedence.

Optional runtime variables:

| Variable                             | Default / purpose                                                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DB_PORT`                            | `3306`; override for a different database port.                                                                                                                                 |
| `DRIVE_WEBHOOK_URL`                  | Defaults to `MEDIABINDER_URL` + `/api/drive/webhook` for HTTPS deployments. Optional override for a separate public callback URL. HTTP/local development disables registration. |
| `ALLOW_SIGNUPS`                      | Disabled. First verified Google user becomes superuser; `true` permits additional accounts.                                                                                     |
| `DRIVE_WORKER_ENABLED`               | Enabled. Set `false` only when running a separate worker; the repository's Docker Compose setup does this for its web container.                                                |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Unset. Optional thumbnail span export, described below.                                                                                                                         |

Configuration references: [Coolify Dockerfile build pack](https://coolify.io/docs/applications/build-packs/dockerfile), [Better Auth Google callback setup](https://better-auth.com/docs/authentication/google).

## Google OAuth

In a Google Cloud project:

1. Enable **Google Drive API**.
2. Configure Google Auth Platform branding and an External audience. For private development, leave it in Testing and add your Google account as a test user.
3. Create a **Web application** OAuth client with redirect URI `http://localhost:3100/api/auth/callback/google` (and your deployment's corresponding HTTPS URI when needed).
4. Put its client ID and secret in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Recreate the web container after changing environment variables.
5. During sign-in, approve the Drive permission as well as the identity permission.

The app requests `drive.readonly`, plus Google's standard sign-in scopes. Google grants this permission across the account; the linked folders are an application-level import boundary, not an OAuth permission boundary. Folder selection works with shared folders accessible to your account and scans subfolders. Shortcuts are not followed. No Drive write permissions are requested.

Google may expire refresh tokens after seven days for External apps in Testing that request Drive scopes. Use **Settings → Reconnect Google** when needed. Public OAuth distribution/verification and a production domain are separate from this private development setup. OAuth credentials and encrypted refresh tokens must remain private; retain `BETTER_AUTH_SECRET` across restarts and back it up with the database.

## Sync and previews

- Sync runs on demand and in response to configured webhooks. Opening the workspace reads the existing MySQL catalog without scanning Google Drive. Sync paginates Drive results and walks all linked folders and their subfolders, then reconciles in a transaction. Concurrent syncs for the same account are prevented with a MySQL lock.
- Re-sync updates technical file metadata without overwriting your display names, tags, creation dates, sets, or post links. Media outside the linked folders is hidden from the library, search, tags, and set counts; its metadata remains intact. Unlinking a folder hides its media immediately, except items also present in another linked folder. Re-link and sync to restore it. Overlapping folders never create duplicate media. A failed Drive scan does not mark files unavailable.
- The list supports selection, additive bulk tagging, persistent click/Enter tag popovers, removal, and sorting. Tags receive a saved random color, editable beside each sidebar tag filter. Selection resets when the search or media scope changes, but survives tag edits. Upload timestamps use Radix/shadcn tooltips; file actions open Drive or copy the original name and parent folder ID.
- Uploaded dates in the list are relative for the first 30 days, then use the browser’s local calendar date. Hover for the full local timestamp, including seconds and timezone.
- “Uploaded to Drive” uses Drive's `createdTime`. “Date created” initially uses image capture metadata when available, otherwise the Drive creation time. You can edit it. Editor date fields display in UTC. Locally created sets have no Drive upload date or underlying Drive file; their raw name records the name they were created with.
- Thumbnail and original endpoints require a session and check file ownership. Tokens are refreshed on the server and encrypted at rest.
- Eligible photos warm after 180 ms of mouse hover or keyboard focus. TanStack Query shares the request with the detail viewer, with an in-memory limit of six photos, 8 MiB per photo, two concurrent downloads, and one-minute freshness/unused retention. Touch hover, data-saving/slow connections, videos, and larger photos do not trigger speculative downloads. Effect enforces streamed byte limits, cancellation, and concurrency; photo object URLs are revoked when the viewer releases them. Details show the thumbnail immediately while originals load.
- Video originals stream through the server with backpressure, cancellation, and HTTP byte ranges. Playback/seek does not buffer the entire file or save it to disk. There is no transcoding or persistent media cache; browser codec support and Drive bandwidth/quota still apply. Unsupported formats can be opened in Drive. Video-byte caching or transcoding can be added later if needed.

## Routes and folder selection

`/` is login; `/login` redirects there for compatibility. Authenticated routes are `/media`, `/sets`, `/sets/$setId`, and `/settings`. Images/videos are a media-type filter on `/media`; tags live in a searchable sidebar section. Grid/list choice is stored in a cookie so the server renders the chosen view immediately. Multiple tag selections match any selected tag. Signed-out requests redirect to login. The sidebar folder picker supports multiple linked roots, with an explicit **All Folders** option and a clear button. Folder selection is stored in the URL and restored on reload. Empty selection means all linked folders. Sets can contain media from any linked folder; opening a set clears folder selection so every available member is shown.

## Google Drive webhooks

The optional `worker` Docker service runs automatically with Compose. It uses Better Auth's encrypted Google refresh tokens on the server; it does not need an active browser session.

To enable notifications after deploying:

1. Set `MEDIABINDER_URL=https://your-domain.example`. The callback automatically uses `/api/drive/webhook` on that origin; no extra webhook variable is needed. Use a publicly reachable HTTPS endpoint with a trusted certificate, routed to the web service. This endpoint validates Google's channel credentials itself and must not be blocked by proxy-level login or a robots.txt disallow rule.
2. Configure the Google OAuth callback for your deployment as described above, then redeploy the app (or recreate Compose services with `docker compose up -d --build`).
3. Link your Drive folders and check **Settings → Automatic sync**. The worker registers watches for the user's changes feed and any shared-drive scopes containing linked folders. It checks renewal schedules and creates replacement channels before Google's maximum seven-day expiration. Old channels are stopped after replacement.

Notifications are authenticated using a random per-channel token (only its hash is stored), channel/resource IDs, expiry, and message numbers. The endpoint commits a coalesced job to MySQL before acknowledging; duplicate notifications are ignored. A worker reconciles the linked folders with the same sync lock used by manual sync. Jobs survive restarts, retry with backoff, and preserve the catalog if a Drive scan fails. Notifications arriving during a sync remain queued for another pass. Registration and renewal queue a full reconciliation to cover the handshake window.

The worker checks its MySQL queue every ten seconds; it **does not poll Google Drive for media changes**. Watch setup and renewal are separate scheduled API calls. The workspace preloads the stored catalog during server rendering and hydrates the same TanStack Query cache in the browser. Catalog data stays fresh for 30 seconds; returning focus to a tab or navigating with stale data refreshes MySQL data in the background without starting a Drive sync. Reloading also reads the catalog. Google notification delivery is not guaranteed; use **Sync Drive** for manual reconciliation, including local installations without webhooks. Token expiry or revoked access appears in Settings; use Reconnect Google if needed.

For HTTP or localhost application URLs, watch registration stays disabled and manual sync still works. `DRIVE_WEBHOOK_URL` can override the derived callback, for example when using an HTTPS tunnel. Registration, early handshakes, forged/duplicate messages, renewal, queue processing, and failure retries are tested locally with simulated Google responses. Actual Google-to-server delivery requires your public domain and has not been tested locally. See [Google's push-notification guide](https://developers.google.com/workspace/drive/api/guides/push).

## Development and checks

Node 24 and pnpm 11 are used in Docker. On the host, `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, and `pnpm build` check the code. Runtime development is simplest through `pnpm dev:docker`; container startup runs idempotent migrations before serving. For host-only runtime commands, supply the environment and a reachable MySQL URL yourself.

Use T3 Code's browser preview at http://localhost:3100 to check the real Google login and Drive flows. No development authentication bypass is included. `/api/health` checks the database connection. Back up MySQL before upgrading; versioned application migrations are in `migrations/`, and Better Auth manages its own tables during startup. The multiple-folder migration preserves your existing source and catalog.

The focused database regression check runs with `docker compose exec web pnpm exec tsx scripts/test-drive-folders.ts` against a disposable migrated test database. It creates fixtures to verify additive tagging, removal, persistent colors, rejected partial or unauthorized edits, unlinking, overlapping folder membership, metadata retention, and user isolation. `docker compose exec web pnpm exec tsx scripts/test-drive-webhook.ts` runs the focused webhook integration check with isolated MySQL fixtures and mocked Google HTTP responses.

## Preview fixtures

The initial browser validation uses only `ExampleMediaFolder`, with eight sample photos from [Lorem Picsum](https://picsum.photos/) and the [MDN CC0 flower video](https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4). These are test uploads, not application assets. They are not committed to this repository. Example social links in the preview are metadata fixtures, not published posts.

### Thumbnail loading and diagnostics

Thumbnails use a focused Effect service; the rest of the app still uses TanStack Query and async/await. The virtual table eagerly loads its eight overscan rows in each direction. A loading placeholder covers cold requests, and the browser retries failed thumbnail requests once.

Thumbnail responses use a private five-minute browser cache (`Vary: Cookie`) with ETags for revalidation. The web process caches at most 64 thumbnails for fifteen minutes, each capped at 1 MiB, with six concurrent Google loads. Concurrent requests for the same user/file share a lookup; failed loads are not cached. Nothing is written to disk. A cold server restart empties this cache. Drive image replacements can take up to twenty minutes to appear across the two cache layers. Every network request still checks the session, ownership, and current availability before accessing the server cache. Original images and video streams retain `no-store` and byte-range streaming.

Each thumbnail response includes `Server-Timing` for duration and cache reuse. Effect emits JSON timing/error logs in the web container, without tokens, signed URLs, file names, or user IDs. Inspect them with `docker compose logs web`. Set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to an OTLP HTTP/JSON collector (including `/v1/traces`) to export the thumbnail/token/lookup/download spans. No collector is required or deployed by default.

### Production OAuth and request handling

Set Google Auth Platform's homepage to your `MEDIABINDER_URL` and privacy-policy URL to `/privacy` on that origin. Deploy the privacy page before switching Audience to **In production**, then reconnect Google to replace Testing-mode authorization. Production status does not remove Google's unverified-app warning.

Library JSON requests and Google Drive JSON/watch requests use Effect HttpClient with a 30-second timeout, cancellation and tagged errors. Mutations are not automatically retried. Video proxy requests use Effect's Promise integration and retain the incoming request signal for the entire streamed response. Network spans share the optional `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` exporter with thumbnails. Database transaction and worker orchestration remain separate from this networking migration.

The login button uses Google's unmodified pre-approved asset; see `public/google-signin-NOTICE.txt` for its source.

### Shared catalog and inbox

Migration 004 separates Drive copies from catalog metadata. Sync requests Google's `sha256Checksum`: byte-identical images/videos share one catalog entry across the entire instance, regardless of filename, folder, or user. No original file download is needed to compute a hash. When a checksum is unavailable, only the same Drive file ID is matched; similar-looking or re-encoded media is not deduplicated.

Each user sees one row per accessible catalog entry, with a copy count when multiple Drive files match. Folder filtering includes all of that user's linked sources for the entry. Previews use a Drive copy accessible through that user's own connection. Tags, tag colors, display names, dates, set memberships and post links are shared; another user's inaccessible media and private folder IDs are not returned. Sets become visible to collaborators through shared members, and their counts/covers include only accessible members. Empty sets remain visible to their creator. Any collaborator with access to a shared set can edit or delete it.

Existing metadata is backfilled before syncing. On consolidation, the earliest cataloged entry wins conflicting names/dates (ID breaks ties); tags, memberships and posts are combined. Superseded catalog records retain their previous metadata for recovery in the database. Checksum consolidation occurs on the next sync, not during the SQL migration. A Drive file whose checksum changes gets a separate catalog entry, leaving the old content's curation intact.

Use **All content / Uncataloged / Cataloged** beside the media-type filter. Renaming, editing media metadata, tagging, adding/removing set membership or linking a post marks a media entry cataloged. That status persists even if a tag or membership is later removed, and is shared with duplicates and collaborators. Existing tags, non-default names, memberships and media posts are recognized during migration; historical date-only edits cannot be inferred reliably.

Catalog writes and merge transactions share one database lock to prevent edits being lost during consolidation. Google scans happen outside that lock, and failed scans preserve the existing catalog.

Run `scripts/test-shared-catalog.ts` only against a disposable test database. It uses mocked Google responses and retains catalog fixtures to exercise history preservation.
