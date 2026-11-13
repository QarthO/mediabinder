# Development

Use the Node version in `.node-version`, pnpm 11 (pinned by `packageManager`;
`corepack enable` provides it) with Vite+, Git, and Docker with Compose.

```sh
pnpm install --frozen-lockfile
cp .env.example .env   # then fill it in, see the README
pnpm dev:docker
```

Open http://localhost:3100. Google sign-in needs real OAuth credentials, see
the README's Google OAuth section. There is no development authentication
bypass.

## Commands

| Command                | Purpose                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `pnpm dev`             | Vite+ dev server on port 3100. Needs a reachable MySQL and the environment from `.env`              |
| `pnpm build`           | Production build into `dist/` (`vp build`)                                                          |
| `pnpm start`           | Serve `dist/` (`scripts/serve.mjs`); the container runs `scripts/start.ts` instead                  |
| `pnpm typecheck`       | `tsc --noEmit`                                                                                      |
| `pnpm lint`            | `vp lint`: type-aware oxlint and the `mediabinder/effect-recovery` rule                             |
| `pnpm format`          | `vp fmt` (oxfmt) rewrites files                                                                     |
| `pnpm check`           | `vp check`: lint, format check and types                                                            |
| `pnpm test`            | `vp test run`: unit tests; the MySQL suites skip themselves                                         |
| `pnpm verify [stage]`  | `static`, `tests`, `database`, `build`, or all of them; the stages CI runs                          |
| `pnpm db:migrate`      | Apply pending migrations (`scripts/migrate.ts`)                                                     |
| `pnpm dev:docker`      | Build and start MySQL, the web container in hot-reload mode and the Drive worker, in the background |
| `pnpm dev:docker:down` | Stop the stack and keep the `mysql-data` volume                                                     |

Run `pnpm format` before committing; `pnpm check` and CI fail on unformatted
files, including Markdown.

## Docker development

`pnpm dev:docker` runs `docker compose -f compose.yaml -f compose.dev.yaml up -d --build`.

- `mysql` is MySQL 8.4 with a persistent `mysql-data` volume. It is not
  published to the host.
- `web` builds the `development` Dockerfile target, binds `src`, `public`,
  `scripts`, `migrations` and `vite.config.ts` from the checkout, applies
  migrations, then runs `pnpm dev`. It listens on `127.0.0.1:3100`. Edits to
  those paths hot reload; a dependency change needs `pnpm dev:docker` again.
- `worker` runs the Drive worker from the `production` image, so it does not
  hot reload. Rebuild it with `pnpm dev:docker` after changing server modules it
  uses. The web container has `DRIVE_WORKER_ENABLED=false`.
- Logs: `docker compose logs -f web` (or `worker`). They are JSON.

Use the T3 preview browser at http://localhost:3100 to check UI changes.

To build and run the production image the way a deployment does, use
`docker compose up -d --build` (see the README). Pass
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
