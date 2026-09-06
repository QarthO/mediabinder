# MediaBinder

A private media library for Google Drive. TanStack Start, React Query, Table, and Virtual, shadcn/Radix, Better Auth, and MySQL. A compact blue workspace inspired by Kiln, with grid/list views, folder multi-select, search, colored inline and bulk tagging, sets, ⌘K, and ⌘B to toggle the sidebar.

Original images and videos stay in Drive. MediaBinder stores display names, raw filenames, tags, dates, set membership, and social post links in its own database. Sets are flat, and a media item can belong to any number of sets. Posts accept any platform name, an HTTP(S) link, an optional post ID, and a date; both media and sets can have posts.

## Run with Docker

1. Copy `.env.example` to `.env`. Set independent random database passwords and a random `BETTER_AUTH_SECRET` of at least 32 characters (`openssl rand -hex 32`). Use the same application database password in `MYSQL_PASSWORD` and `DATABASE_URL`.
2. Configure Google OAuth as described below.
3. Run `docker compose up -d --build` for production, or `pnpm dev:docker` for development with hot reload.
4. Open **http://localhost:3100**. The root is the login page; signed-in users go to `/media`. Link one or more folders in Settings. The app syncs on fresh page loads and supports manual sync.

The first verified Google account becomes the superuser. Further sign-ups are rejected unless `ALLOW_SIGNUPS=true` is explicitly configured. Existing accounts can still sign in. Libraries and Drive connections are scoped to each user; there is no public registration or landing page. Claim the first account before exposing a fresh instance to the internet.

MySQL data persists in the `mysql-data` volume. `pnpm dev:docker:down` stops development without deleting the database. For a deployment behind a reverse proxy, set `BETTER_AUTH_URL` to the public HTTPS origin and add its exact callback URL in Google Cloud. Keep the app and database on the private Docker network; the default host binding is loopback only.

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

- Sync runs on fresh authenticated page loads, on demand, and in response to configured webhooks. It paginates Drive results and walks all linked folders and their subfolders, then reconciles in a transaction. Concurrent syncs for the same account are prevented with a MySQL lock.
- Re-sync updates technical file metadata without overwriting your display names, tags, creation dates, sets, or post links. Media outside the linked folders is hidden from the library, search, tags, and set counts; its metadata remains intact. Unlinking a folder hides its media immediately, except items also present in another linked folder. Re-link and sync to restore it. Overlapping folders never create duplicate media. A failed Drive scan does not mark files unavailable.
- The list supports selection, additive bulk tagging, persistent click/Enter tag popovers, removal, and sorting. Tags receive a saved random color, editable beside each sidebar tag filter. Selection resets when the search or media scope changes, but survives tag edits. Upload timestamps use Radix/shadcn tooltips; file actions open Drive or copy the original name and parent folder ID.
- Uploaded dates in the list are relative for the first 30 days, then use the browser’s local calendar date. Hover for the full local timestamp, including seconds and timezone.
- “Uploaded to Drive” uses Drive's `createdTime`. “Date created” initially uses image capture metadata when available, otherwise the Drive creation time. You can edit it. Editor date fields display in UTC. Locally created sets have no Drive upload date or underlying Drive file; their raw name records the name they were created with.
- Thumbnail and original endpoints require a session and check file ownership. Tokens are refreshed on the server and encrypted at rest.
- Video originals stream through the server with backpressure, cancellation, and HTTP byte ranges. Playback/seek does not buffer the entire file or save it to disk. There is no transcoding or persistent media cache; browser codec support and Drive bandwidth/quota still apply. Unsupported formats can be opened in Drive. A bounded cache or transcoding can be added later if needed.

## Routes and folder selection

`/` is login; `/login` redirects there for compatibility. Authenticated routes are `/media`, `/sets`, `/sets/$setId`, and `/settings`. Images/videos are a media-type filter on `/media`; tags live in a searchable, collapsible sidebar section. Multiple tag selections match any selected tag. Signed-out requests redirect to login. The sidebar folder picker supports multiple linked roots, with an explicit **All Folders** option and a clear button. Folder selection is stored in the URL and restored on reload. Empty selection means all linked folders. Sets can contain media from any linked folder; opening a set clears folder selection so every available member is shown.

## Google Drive webhooks

The optional `worker` Docker service runs automatically with Compose. It uses Better Auth's encrypted Google refresh tokens on the server; it does not need an active browser session.

To enable notifications after deploying:

1. Set `DRIVE_WEBHOOK_URL=https://your-domain.example/api/drive/webhook` in `.env`. Use a publicly reachable HTTPS endpoint with a trusted certificate, routed to the web service. This endpoint validates Google's channel credentials itself and must not be blocked by proxy-level login or a robots.txt disallow rule.
2. Set `BETTER_AUTH_URL` and the Google OAuth callback to your deployment's origin as described above, then recreate both services with `docker compose up -d --build`.
3. Link your Drive folders and check **Settings → Automatic sync**. The worker registers watches for the user's changes feed and any shared-drive scopes containing linked folders. It checks renewal schedules and creates replacement channels before Google's maximum seven-day expiration. Old channels are stopped after replacement.

Notifications are authenticated using a random per-channel token (only its hash is stored), channel/resource IDs, expiry, and message numbers. The endpoint commits a coalesced job to MySQL before acknowledging; duplicate notifications are ignored. A worker reconciles the linked folders with the same sync lock used by manual sync. Jobs survive restarts, retry with backoff, and preserve the catalog if a Drive scan fails. Notifications arriving during a sync remain queued for another pass. Registration and renewal queue a full reconciliation to cover the handshake window.

The worker checks its MySQL queue every ten seconds; it **does not poll Google Drive for media changes**. Watch setup and renewal are separate scheduled API calls. Open browsers refresh their catalog on query refetch (such as returning focus to the tab), manual sync, or reload. Google notification delivery is not guaranteed, so fresh-load and manual reconciliation remain available. Token expiry or revoked access appears in Settings; use Reconnect Google if needed.

Without `DRIVE_WEBHOOK_URL`, watch registration stays disabled and fresh-load/manual sync still work. Registration, early handshakes, forged/duplicate messages, renewal, queue processing, and failure retries are tested locally with simulated Google responses. Actual Google-to-server delivery requires your public domain and has not been tested locally. See [Google's push-notification guide](https://developers.google.com/workspace/drive/api/guides/push).

## Development and checks

Node 24 and pnpm 11 are used in Docker. On the host, `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, and `pnpm build` check the code. Runtime development is simplest through `pnpm dev:docker`; container startup runs idempotent migrations before serving. For host-only runtime commands, supply the environment and a reachable MySQL URL yourself.

Use T3 Code's browser preview at http://localhost:3100 to check the real Google login and Drive flows. No development authentication bypass is included. `/api/health` checks the database connection. Back up MySQL before upgrading; versioned application migrations are in `migrations/`, and Better Auth manages its own tables during startup. The multiple-folder migration preserves your existing source and catalog.

The focused database regression check runs with `docker compose exec web pnpm exec tsx scripts/test-drive-folders.ts` against a migrated database. It creates and cleans up isolated fixtures to verify additive tagging, removal, persistent colors, rejected partial or unauthorized edits, unlinking, overlapping folder membership, metadata retention, and user isolation. `docker compose exec web pnpm exec tsx scripts/test-drive-webhook.ts` runs the focused webhook integration check with isolated MySQL fixtures and mocked Google HTTP responses.

## Preview fixtures

The initial browser validation uses only `ExampleMediaFolder`, with eight sample photos from [Lorem Picsum](https://picsum.photos/) and the [MDN CC0 flower video](https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4). These are test uploads, not application assets. They are not committed to this repository. Example social links in the preview are metadata fixtures, not published posts.

### Thumbnail loading and diagnostics

Thumbnails use a focused Effect service; the rest of the app still uses TanStack Query and async/await. The virtual table eagerly loads its eight overscan rows in each direction. A loading placeholder covers cold requests, and the browser retries failed thumbnail requests once.

Thumbnail responses use a private five-minute browser cache (`Vary: Cookie`) with ETags for revalidation. The web process caches at most 64 thumbnails for fifteen minutes, each capped at 1 MiB, with six concurrent Google loads. Concurrent requests for the same user/file share a lookup; failed loads are not cached. Nothing is written to disk. A cold server restart empties this cache. Drive image replacements can take up to twenty minutes to appear across the two cache layers. Every network request still checks the session, ownership, and current availability before accessing the server cache. Original images and video streams retain `no-store` and byte-range streaming.

Each thumbnail response includes `Server-Timing` for duration and cache reuse. Effect emits JSON timing/error logs in the web container, without tokens, signed URLs, file names, or user IDs. Inspect them with `docker compose logs web`. Set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to an OTLP HTTP/JSON collector (including `/v1/traces`) to export the thumbnail/token/lookup/download spans. No collector is required or deployed by default.
