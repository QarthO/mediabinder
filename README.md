# MediaBinder

A private media library for Google Drive. TanStack Start, React Query, Table, and Virtual, shadcn/Radix, Better Auth, and MySQL. A compact blue workspace inspired by Kiln, with grid/list views, search, tags, sets, ⌘K, and ⌘B to toggle the sidebar.

Original images and videos stay in Drive. MediaBinder stores display names, raw filenames, tags, dates, set membership, and social post links in its own database. Sets are flat, and a media item can belong to any number of sets. Posts accept any platform name, an HTTP(S) link, an optional post ID, and a date; both media and sets can have posts.

## Run with Docker

1. Copy `.env.example` to `.env`. Set independent random database passwords and a random `BETTER_AUTH_SECRET` of at least 32 characters (`openssl rand -hex 32`). Use the same application database password in `MYSQL_PASSWORD` and `DATABASE_URL`.
2. Configure Google OAuth as described below.
3. Run `docker compose up -d --build` for production, or `pnpm dev:docker` for development with hot reload.
4. Open **http://localhost:3100**. Sign in with Google, link one or more folders in Settings, and Sync Drive.

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

- Sync is manual. It paginates Drive results and walks all linked folders and their subfolders, then reconciles in a transaction. Concurrent syncs for the same account are prevented with a MySQL lock.
- Re-sync updates technical file metadata without overwriting your display names, tags, creation dates, sets, or post links. Media outside the linked folders is hidden from the library, search, tags, and set counts; its metadata remains intact. Unlinking a folder hides its media immediately, except items also present in another linked folder. Re-link and sync to restore it. Overlapping folders never create duplicate media. A failed Drive scan does not mark files unavailable.
- “Uploaded to Drive” uses Drive's `createdTime`. “Date created” initially uses image capture metadata when available, otherwise the Drive creation time. You can edit it. Dates display in UTC. Locally created sets have no Drive upload date or underlying Drive file; their raw name records the name they were created with.
- Thumbnail and original endpoints require a session and check file ownership. Tokens are refreshed on the server and encrypted at rest.
- Video originals stream through the server with backpressure, cancellation, and HTTP byte ranges. Playback/seek does not buffer the entire file or save it to disk. There is no transcoding or persistent media cache; browser codec support and Drive bandwidth/quota still apply. Unsupported formats can be opened in Drive. A bounded cache or transcoding can be added later if needed.

## Development and checks

Node 24 and pnpm 11 are used in Docker. On the host, `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, and `pnpm build` check the code. Runtime development is simplest through `pnpm dev:docker`; container startup runs idempotent migrations before serving. For host-only runtime commands, supply the environment and a reachable MySQL URL yourself.

Use T3 Code's browser preview at http://localhost:3100 to check the real Google login and Drive flows. No development authentication bypass is included. `/api/health` checks the database connection. Back up MySQL before upgrading; versioned application migrations are in `migrations/`, and Better Auth manages its own tables during startup. The multiple-folder migration preserves your existing source and catalog.

The focused database regression check runs with `docker compose exec web pnpm exec tsx scripts/test-drive-folders.ts` against a migrated database. It creates and cleans up isolated fixtures to verify unlinking, overlapping folder membership, metadata retention, and user isolation.

## Preview fixtures

The initial browser validation uses only `ExampleMediaFolder`, with eight sample photos from [Lorem Picsum](https://picsum.photos/) and the [MDN CC0 flower video](https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4). These are test uploads, not application assets. They are not committed to this repository. Example social links in the preview are metadata fixtures, not published posts.
