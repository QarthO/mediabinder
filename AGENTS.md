# MediaBinder agents

MediaBinder is a private media library for Google Drive: TanStack Start, Effect
on the server, MySQL, and Better Auth. Favor simple operation and existing
patterns.

Performance/Speed and UX is always the most important thing to keep in mind for
every change you do. Avoid unnecessary React renders and paints outside the
changed component.

<!-- intent-skills:start -->

## Skill Loading

Before editing files for a substantial task:

- Run `pnpm dlx @tanstack/intent@latest list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `pnpm dlx @tanstack/intent@latest load <package>#<skill>` before changing files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.

<!-- intent-skills:end -->

## Work

- Use Vite+ (`vp`) and pnpm. `package.json` scripts wrap `vp`; see
  [Development](docs/development.md) for the full list. The ones you will use:
  `pnpm dev`, `pnpm typecheck` (`tsc --noEmit`), `pnpm lint`, `pnpm format`,
  `pnpm check` (lint, format and types through `vp check`), `pnpm test`, and
  `pnpm build`.
- `pnpm verify [stage]` runs the stages CI runs: `static` (`pnpm typecheck` and
  `vp check`), `tests` (`vp test run`), `database` (the `*.mysql.test.ts` suites
  on a real MySQL; it refuses to run without one), and `build` (`vp build`, then
  fails if `src/routeTree.gen.ts` changed). With no stage it runs all four.
  Commit the regenerated `src/routeTree.gen.ts` and `pnpm-lock.yaml`.
- Server code is Effect. Convert a Promise module to Effect rather than adding
  new Promise code, and follow the conventions below.
  - Domain functions are
    `export const thing = Effect.fn("Area.operation")(function* (...) { ... })`.
    Areas are PascalCase nouns (`Library`, `Catalog`, `Drive`, `DriveWorker`,
    `SyncProgress`, `Tags`), operations camelCase verbs. Names are stable; put
    IDs in span attributes with `Effect.annotateCurrentSpan`, never in the name.
  - All SQL goes through the `Database` service (`src/effect/database.ts`):
    `queryRows`, `execute`, `transaction` and `withNamedLock`, each with an
    operation name such as `"catalog.resolve"`. Only Better Auth owns a mysql2
    pool, in `src/lib/auth.server.ts`; don't create another.
  - Errors are `Schema.TaggedError` classes in `src/effect/errors.ts`. Don't
    throw `Response`, `Error` or strings from Effect code. `src/lib/http-errors.ts`
    is the one mapping from tagged errors to HTTP responses, and
    `src/observability/error-policy.ts` lists the expected ones that are not
    reported. A new error that callers should see needs an entry in both.
  - No `try`/`catch`, `.catch()` or `.finally()` in server code. Use
    `Effect.try`, `Effect.tryPromise`, `Result.try`, `Effect.catch` and
    `Effect.ensuring`. The `mediabinder/effect-recovery` lint rule
    (`scripts/oxlint-plugin.mjs`) is an error for `src/**/*.server.ts` and
    `src/effect/**` and a warning for the rest of `src/lib/**`.
  - Wrap external Promise APIs (Better Auth, `fetch`) once, at the boundary,
    with `Effect.tryPromise` mapped to a tagged error. Google Drive HTTP goes
    through `src/effect/drive-http.server.ts`.
  - Promise callers (route handlers, server functions, scripts) enter Effect
    through `src/effect/runtime.server.ts`. `runAppEffect(name, program, { signal })`
    runs an anonymous program under a span named `name`; route handlers pass
    `request.signal`. `runTracedAppEffect(effect)` runs an `Effect.fn` that
    already opens its own span, so it joins the trace without a duplicate.
- Telemetry is OpenTelemetry through Effect (`src/telemetry/index.ts`),
  configured only by the standard `OTEL_*` variables; see the README's
  Observability section for the list and
  [Development](docs/development.md#running-an-otlp-receiver-locally) for a
  local receiver. Nothing is exported without an endpoint. Errors are error
  logs with `exception.*` attributes and an `error.fingerprint` that groups
  occurrences, not span events. Report unexpected failures with `reportAppError`
  or `Telemetry.logException`; expected ones (see `error-policy.ts`) are not
  reported.
  - Name spans with `Effect.fn("Area.operation")` or `Effect.withSpan`, keep
    names stable and put IDs in attributes. Give long-lived loops and workers no
    span of their own, span each unit of work instead (one request, one sync,
    one webhook delivery, one worker pass that found work). Use metrics, not
    spans, for hot paths: per Drive page, per file, per thumbnail, and the
    worker's idle checks. Existing metrics are named `mediabinder.*`
    (`mediabinder.drive.api.requests`, `mediabinder.sync.files`,
    `mediabinder.worker.passes`, `mediabinder.mutation.duration`).
  - **Never put user data in telemetry.** No media contents, file names,
    display names, tags, set names, folder names, emails, search text, tokens
    or signed URLs in span names, span or metric attributes, log messages or
    attributes, error messages, or profiling output, in the server or the
    browser. Opaque IDs (user ID, run ID) are fine as span attributes; they
    are not metric attributes. Attribute values are action names, statuses,
    outcomes and counts. Error messages are exported as written, so don't
    interpolate names into them. Browser telemetry carries only route
    templates such as `/sets/:id`. If unsure, leave it out.
- Avoid patching framework/library internals unless explicitly given permission.
- Use Sonner for transient feedback (`toast.*`), and the shared tooltip
  primitives in `src/components/ui`.
- These lock names are shared by running containers and read by
  `IS_USED_LOCK`, so an old and a new container exclude each other. Keep them
  exactly: `mediabinder-catalog` (every catalog edit and merge),
  `drive:<userId>` (one sync per user, zero-second timeout),
  `mediabinder-drive-worker` (one Drive worker), and `mediabinder-migrate`
  (migrations). Sync status reads `drive:<userId>` to tell a running sync from
  an interrupted one.

## Testing

Tests exist to catch breakage that is expensive and hard to notice by hand.
Add or keep a test only when it protects one of:

- Security boundaries: authentication, session and ownership checks, OAuth and
  token handling, webhook channel tokens, Drive sharing and folder-link rules,
  the media proxy's path, Range and URL handling, parsing untrusted input.
- Data loss: tag and name-list edits, bulk edits that must apply whole,
  catalog merges that keep history, migrations and their ordering, deletion
  ordering, a failed Drive scan that must keep the library.
- Formats that outlive a release: stored rows and migrations, the lock names
  above, the preferences cookie, the webhook channel format.
- Non-trivial state machines and concurrency: sync progress claim and join,
  interrupted runs, lock contention and pool exhaustion, thumbnail cache
  sharing and cancellation, worker retry and backoff.
- A regression you just fixed.

Don't write tests that:

- Assert copy, labels, constants, defaults, palettes, CSS classes, or one row of
  a lookup table.
- Re-test a library (Effect, zod, TanStack, React) or what the type system
  already guarantees.
- Assert SQL text, command arguments, call order, call counts, timeouts, or
  internal state. Assert the outcome a caller or user would see.
- Mock the module under test, or mock so much that the test only checks the
  mocks.

How to write them:

- Test through the module's real entry points: the exported functions in
  `src/lib/*.server.ts` and the route handlers. Don't export a helper, add an
  optional parameter, make a dependency nullable, or extract a module only so a
  test can reach it. If a pure piece deserves direct tests, give it its own
  module with real callers.
- Server code that touches MySQL runs against a real database, not a mock.
  Name such files `*.mysql.test.ts`, wrap them in `describeMysql` and call
  `useTestDatabase()` from `src/test/database.ts`, which migrates the worker's
  database once and empties it before each test. Assert rows and results. They
  skip themselves unless `MEDIABINDER_TEST_MYSQL=1` and `DB_*` point at a
  server; `DB_NAME` must end in `_test`, and `src/test/setup.ts` gives each
  Vitest worker its own `<DB_NAME>_<n>` database so files run in parallel.
  `pnpm verify database` refuses to skip. See
  [Development](docs/development.md#running-the-mysql-tests).
- When a test must replace an external system (Google, Better Auth, the
  network, a clock), swap the Effect service or Layer production already uses,
  or fake it at that single boundary: `globalThis.fetch` for Google and
  `auth.api.getSession` / `auth.api.getAccessToken` for Better Auth, as in
  `src/test/fixtures.ts`. Restore spies after each test.
- Use `it.effect` from `@effect/vitest` for Effect code. Control time with
  Effect's `TestClock` or `vi.useFakeTimers`, never real sleeps. Keep tests
  independent of each other and of run order.
- Timeouts only catch hangs, so leave room for a busy box: don't set one below
  the defaults in `vite.config.ts` (60 s per test, 300 s per hook).
- Every API route handler and server function must authenticate:
  `src/lib/auth-coverage.test.ts` checks that each one reaches `requireSession`
  and that every library action is declared with `mutation()` and runs with the
  session's user ID. Intentional
  public endpoints go in its allowlists with a reason.
- Tests run in `America/New_York`, set once in `src/test/global-setup.ts`
  because a worker thread can't change the process timezone. Date tests rely on
  a zone that differs from UTC; don't override it.

## Learning more about Effect

This repository uses the Effect Typescript library for all server code and for
thumbnail loading.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

## UI performance before committing

Keep state with the smallest component that owns it. Use TanStack Query's
structural sharing and narrow render boundaries; do not copy query data into
component state or use effects to synchronize derived state. Subscriptions and
resource cleanup belong at their external-system boundary.

Before committing a UI change, use T3 Preview with the development React Scan
toolbar. The toolbar and audit load only when the dev server starts with
`VITE_REACT_SCAN=true` (see [Development](docs/development.md#react-scan)).
Reset `window.__mediaBinderRenderAudit.reset()`, perform one interaction,
then inspect `window.__mediaBinderRenderAudit.snapshot()`. Check a fresh reload,
search typing, filter changes, thumbnail completion, and tag edits. Unrelated
rows, thumbnails, and toolbar controls must not redraw for local edits. Record
results in the PR. Also verify a production build without React Scan: first
paint alone is not evidence that the app is interactive. Never include media
contents or user data in profiling output.

`snapshot()` returns, per component name, `mounts`, `updates`, `unmounts`,
`unnecessary` (renders with unchanged props and state), `commits`, `events`,
and `time` in ms. It records no props. `start()` clears and begins a window
and `stop()` ends it and returns the snapshot; recording is on until stopped.

## Development and pull requests

- Follow [Development](docs/development.md) for prerequisites, commands, the
  Docker flow, React Scan, the MySQL tests and a local OTLP receiver, and
  [Contributing](CONTRIBUTING.md) for branch and PR conventions.
- Validate the changed behavior with checks proportionate to the change. For
  simple changes, run only the relevant checks; run `pnpm verify` when the scope
  or risk warrants the full suite, including the `database` stage for anything
  that touches SQL, locks or the server modules. Validate user-visible changes in
  the browser. Docs-only work does not need a running stack.
- PR titles are an imperative sentence in sentence case with no conventional
  prefix, like the commit subjects: `Move the media table to TanStack Table v9`,
  `Revoke old full-Drive grants and close limited-access folder gaps`. GitHub
  appends `(#N)` on merge. Commit messages follow the same style, with a short
  body saying why. Fill in the
  [pull request template](.github/pull_request_template.md).
- Stacked PRs are welcome: split a large change into small layers that each
  build, test and review on their own, with every PR based on the one below it.
  CI runs on PRs into any base branch.
- CI ("Code checks") runs on every pull request and can be started by hand. It
  runs one `pnpm verify` stage per job: Static checks, Tests, Database tests
  (against `mysql:8.4`) and Build. Rebase onto `origin/main` before
  `pnpm verify` and before each push, and for a stack, sync the whole stack.
  After each push, check CI before pushing again.
- When asked to deliver a PR, commit, push, and open it ready for review. Never
  merge it yourself.
