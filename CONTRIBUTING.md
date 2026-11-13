# Contributing to MediaBinder

Thanks for contributing.

## Setup

Use the Node version in `.node-version` and pnpm 11 (the `packageManager` field
pins it; `corepack enable` provides it). Docker with Compose is needed to run
the app and the database tests.

```sh
pnpm install --frozen-lockfile
pnpm verify static
```

[Development](docs/development.md) covers the dev Docker stack, React Scan, the
MySQL tests and running an OTLP receiver. [AGENTS.md](AGENTS.md) holds the
engineering rules, which apply to people as much as to agents.

## Checks

`pnpm verify` runs the same stages as CI: `static`, `tests`, `database` and
`build`. Pass a stage name to run one, such as `pnpm verify tests`.

The `database` stage runs the `*.mysql.test.ts` suites against a real MySQL and
refuses to run without one, so a skipped suite never reads as a pass. Start a
throwaway server and point `DB_*` at it:

```sh
docker run -d --rm --name mb-test-mysql -p 127.0.0.1:3306:3306 \
  -e MYSQL_ROOT_PASSWORD=root mysql:8.4
MEDIABINDER_TEST_MYSQL=1 DB_HOST=127.0.0.1 DB_NAME=mediabinder_test \
  DB_USER=root DB_PASS=root pnpm verify database
docker stop mb-test-mysql
```

`DB_NAME` must end in `_test`. Never point it at real data.

## Pull requests

1. Keep changes focused and consistent with existing patterns. Large changes
   are welcome as a stack of small PRs, each based on the one below it.
2. Name branches `<type>/<short-kebab-case-task>`, such as `fix/sync-lock-leak`
   or `feat/set-covers`.
3. Title the PR with an imperative sentence in sentence case and no
   conventional prefix, like the commit history, for example `Add bulk set editing`.
4. Fill in the [pull request template](.github/pull_request_template.md): why,
   summary and validation. For UI changes, include the React Scan render audit
   and a production-build check as AGENTS.md describes.
5. Rebase onto `main` and run `pnpm verify` before pushing. CI ("Code checks")
   runs the same stages on every PR.
6. Keep the description unchanged during review unless the overall PR changes.
