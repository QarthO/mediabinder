# Development

Use the Node version in `.node-version`, pnpm 11 (pinned by `packageManager`;
`corepack enable` provides it) with Vite+, Git, and Docker with Compose.

```sh
pnpm install --frozen-lockfile
pnpm dev:setup    # once, from any worktree
pnpm dev:docker   # in any worktree
```

`pnpm dev:docker` prints the stack's URL. Click "Skip login for development"
to use the app as the developer; see [Dev stack](#dev-stack).

## Commands

| Command                         | Purpose                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `pnpm dev`                      | Vite+ dev server on port 3100. Needs a reachable MySQL and the environment from `.env`          |
| `pnpm build`                    | Production build into `dist/` (`vp build`)                                                      |
| `pnpm start`                    | Serve `dist/` (`scripts/serve.mjs`); the container runs `scripts/start.ts` instead              |
| `pnpm typecheck`                | `tsc --noEmit`                                                                                  |
| `pnpm lint`                     | `vp lint`: type-aware oxlint and the `mediabinder/effect-recovery` rule                         |
| `pnpm format`                   | `vp fmt` (oxfmt) rewrites files                                                                 |
| `pnpm check`                    | `vp check`: lint, format check and types                                                        |
| `pnpm test`                     | `vp test run`: unit tests; the MySQL suites skip themselves                                     |
| `pnpm verify [stage]`           | `static`, `tests`, `database`, `build`, or all of them; the stages CI runs                      |
| `pnpm db:migrate`               | Apply pending migrations (`scripts/migrate.ts`)                                                 |
| `pnpm dev:setup`                | Create the shared dev env file, or add its missing keys (never changes a value)                 |
| `pnpm dev:docker`               | Build and start this worktree's stack: MySQL, the hot-reload web container and the Drive worker |
| `pnpm dev:docker:down`          | Stop the stack and keep its MySQL volume                                                        |
| `pnpm dev:docker:destroy --yes` | Remove the stack and its MySQL volume                                                           |
| `pnpm dev:docker:url`           | Print the stack's URL                                                                           |
| `pnpm dev:docker:logs`          | Follow the web and worker logs                                                                  |

Run `pnpm format` before committing; `pnpm check` and CI fail on unformatted
files, including Markdown.

## Dev stack

Each worktree gets its own Docker Compose project, `mediabinder-dev-<branch>`,
with its own MySQL volume and a free host port from 3101-3199 (kept while the
stack exists). The name is saved in the worktree's git directory
(`mediabinder-dev-project`), so `down` and `destroy` still find the stack after
a branch switch. The script only ever runs compose for that project; it never
touches `mediabinder`, `mediabinder-sharing` or any container it didn't create.

**Setup, once.** `pnpm dev:setup` writes the shared env file: the primary
checkout's `.env` (found through `git rev-parse --git-common-dir`). Every
worktree's stack reads it, so a new worktree needs no setup. A missing file is
created; an existing one only gains the keys it lacks, with values left alone.
It generates `BETTER_AUTH_SECRET` and the MySQL passwords, sets
`MEDIABINDER_ENVIRONMENT=dev`, and adds commented placeholders for what it
can't know. [`.env.dev.example`](../.env.dev.example) lists them all. Set
`MEDIABINDER_DEV_ENV_FILE=<path>` to use another file.

**Start.** `pnpm dev:docker` builds and starts MySQL, the web app (the
`development` target with hot reload, as `compose.dev.yaml` binds `src`,
`public`, `scripts`, `migrations` and `vite.config.ts`) and the Drive worker
(the same target, restarted on each `pnpm dev:docker` to pick up server
changes). It waits until the app is healthy and prints the URL. The stack sets
`MEDIABINDER_URL` and `BETTER_AUTH_URL` to `http://localhost:<port>` itself.

**Skip login.** With `MEDIABINDER_ENVIRONMENT=dev` the login page shows
"Skip login for development". It sets the `mediabinder-dev-auth-bypass` cookie
(httpOnly, 12 hours), and every session check then resolves to the developer:
id `mediabinder-dev-user`, "MediaBinder Developer", `developer@mediabinder.local`.
The bypass needs `MEDIABINDER_ENVIRONMENT=dev` and a `NODE_ENV` other than
`production`, so the production image ignores it even if the variable is set.
The developer has a real `user` row, made when the stack starts. It is the
workspace owner and superuser when nobody owns the workspace yet. The stack
sets `ALLOW_SIGNUPS=true`, so a real Google account can still sign in as a
regular user. Signing out clears the cookie. The developer has no Google OAuth
token: in shared-folder mode Drive reads use the service account, but the
Google Picker, creating a folder and sharing need a real Google sign-in and
fail with a reconnect message for the developer.

**Prelinked folder.** Put the service account's key path in
`GOOGLE_SERVICE_ACCOUNT_KEY_HOST_FILE` (a path on your machine; quote it if it
has spaces). The stack mounts it read-only at
`/run/secrets/mediabinder-drive-sync.json` and points
`GOOGLE_SERVICE_ACCOUNT_KEY_FILE` there. With `MEDIABINDER_DEV_FOLDER_ID` also
set (a folder shared with that service account), startup links the folder for
the developer, named from Drive or "Development folder" if Drive can't be
reached, and queues one initial sync for the worker. Restarting neither
duplicates the link nor queues another sync.

**Reset.** `pnpm dev:docker:down` stops the stack and keeps the database.
`pnpm dev:docker:destroy --yes` also deletes its MySQL volume; the next
`pnpm dev:docker` starts from scratch.

Logs are JSON: `pnpm dev:docker:logs`. Use the T3 preview browser at the
printed URL to check UI changes. To build and run the production image the way
a deployment does, use `docker compose up -d --build` (see the README). Pass
`--build-arg SOURCE_COMMIT=$(git rev-parse HEAD)` to `docker build` to have
`/api/health` report the commit.

## React Scan

React Scan is opt-in so its instrumentation and toolbar don't delay fresh dev
loads. It loads only in the dev server, and only when `VITE_REACT_SCAN=true` is
set when the server starts:

```sh
VITE_REACT_SCAN=true pnpm dev
VITE_REACT_SCAN=true pnpm dev:docker
```

`compose.dev.yaml` passes the variable into the web container. Restart without
it to switch React Scan off; production bundles never contain it. With it on,
use the toolbar, or `window.__mediaBinderRenderAudit`:

- `reset()`, then one interaction, then `snapshot()` returns per component name
  `mounts`, `updates`, `unmounts`, `unnecessary`, `commits`, `events` and
  `time` (ms). No props are recorded.
- `start()` begins a window and `stop()` ends it and returns the snapshot.

The commit checklist is in [AGENTS.md](../AGENTS.md#ui-performance-before-committing).
Also check a production build without React Scan. The User Timing marks
`mediabinder-hydration-start` and `mediabinder-interactive` separate JavaScript
hydration from first paint, and a fast first paint alone is not enough.

## Running the MySQL tests

The `*.mysql.test.ts` suites run the server modules against a real MySQL, with
Google and Better Auth's session lookup faked at their single seams. They skip
unless `MEDIABINDER_TEST_MYSQL=1`, and `pnpm verify database` fails instead of
skipping.

```sh
docker run -d --rm --name mb-test-mysql -p 127.0.0.1:3306:3306 \
  -e MYSQL_ROOT_PASSWORD=root mysql:8.4
MEDIABINDER_TEST_MYSQL=1 DB_HOST=127.0.0.1 DB_NAME=mediabinder_test \
  DB_USER=root DB_PASS=root pnpm verify database
docker stop mb-test-mysql
```

- `DB_NAME` must end in `_test`, and the account must be able to create
  databases. Each Vitest worker gets its own `<DB_NAME>_<n>` database (for
  example `mediabinder_test_1`), created on demand, so files run in parallel.
  Never point this at real data.
- To run one file, use the same variables with
  `MEDIABINDER_TEST_MYSQL=1 pnpm exec vp test run src/lib/shared-catalog.mysql.test.ts`.
- The tests run in `America/New_York` (`src/test/global-setup.ts`).
- Another port: add `-p 127.0.0.1::3306`, read it with
  `docker port mb-test-mysql 3306`, and set `DB_PORT`.

## Running an OTLP receiver locally

Nothing is exported unless an OTLP endpoint is set. To see traces, error logs
and metrics locally, run an OpenTelemetry Collector that prints what it
receives. Save this as `collector.yaml`:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

exporters:
  debug:
    verbosity: detailed

service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
    logs:
      receivers: [otlp]
      exporters: [debug]
    metrics:
      receivers: [otlp]
      exporters: [debug]
```

```sh
docker run --rm --name mb-otel -p 127.0.0.1:4318:4318 \
  -v "$PWD/collector.yaml:/etc/otelcol/config.yaml:ro" \
  otel/opentelemetry-collector:latest
```

Point MediaBinder at it before starting it. `pnpm dev` on the host uses
`http://127.0.0.1:4318`. The Docker stack reaches the host through
`host.docker.internal` (Docker Desktop and OrbStack):

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318 \
OTEL_METRICS_EXPORTER=otlp pnpm dev:docker
```

`compose.yaml` passes every `OTEL_*` variable through to `web` and `worker`.
Metrics are off unless `OTEL_METRICS_EXPORTER=otlp`. The README's Observability
section lists all the variables. Spans are named `Area.operation` and a request
is one trace; check that the spans you added nest under the request span. Never
look for, or add, file names, tags or other user data: telemetry must not
carry any (see [AGENTS.md](../AGENTS.md)).
