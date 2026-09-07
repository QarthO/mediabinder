import { readWorkspacePreferences } from "./workspace-preferences.server"
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  preferencesCookieName,
  workspacePreferencesCookie,
} from "./workspace-preferences"

const defaults = {
  censored: false,
  sorting: [{ id: "uploaded_at", desc: true }],
}
const header = (value: unknown) =>
  `${preferencesCookieName}=${encodeURIComponent(JSON.stringify(value))}`

test("censor and multi-column sorting survive a cookie round trip", () => {
  const preferences = {
    censored: true,
    sorting: [
      { id: "size", desc: true },
      { id: "display_name", desc: false },
    ],
  }
  const cookie = workspacePreferencesCookie(preferences, true)
  assert.deepEqual(
    readWorkspacePreferences(`unrelated=hello; ${cookie.split(";")[0]}`),
    preferences
  )
  assert.match(cookie, /Path=\/; Max-Age=31536000; SameSite=Lax; Secure$/)
  assert.ok(!workspacePreferencesCookie(preferences, false).includes("Secure"))
})

test("missing and malformed cookies use defaults", () => {
  for (const value of [
    null,
    "",
    `${preferencesCookieName}=%E0%A4%A`,
    `${preferencesCookieName}=not-json`,
    header(null),
  ])
    assert.deepEqual(readWorkspacePreferences(value), defaults)
})

test("invalid sort data falls back without losing a valid censor preference", () => {
  for (const sorting of [
    [],
    [{ id: "unknown", desc: true }],
    [{ id: "size", desc: "yes" }],
    [
      { id: "size", desc: true },
      { id: "size", desc: false },
    ],
  ])
    assert.deepEqual(
      readWorkspacePreferences(header({ censored: true, sorting })),
      { ...defaults, censored: true }
    )
  assert.deepEqual(
    readWorkspacePreferences(
      header({
        censored: "false",
        sorting: [{ id: "display_name", desc: false }],
      })
    ),
    { censored: false, sorting: [{ id: "display_name", desc: false }] }
  )
})
