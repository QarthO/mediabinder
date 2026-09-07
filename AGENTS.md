# Learning more about Effect

This repository uses the Effect Typescript library for thumbnail loading.

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
toolbar. Reset `window.__mediaBinderRenderAudit.reset()`, perform one interaction,
then inspect `window.__mediaBinderRenderAudit.snapshot()`. Check a fresh reload,
search typing, filter changes, thumbnail completion, and tag edits. Unrelated
rows, thumbnails, and toolbar controls must not redraw for local edits. Record
results in the PR. Also verify a production build without React Scan: first
paint alone is not evidence that the app is interactive. Never include media
contents or user data in profiling output.
