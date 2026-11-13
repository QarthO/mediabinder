import { describe, expect, it } from "vite-plus/test"
import { readWorkspacePreferences } from "./workspace-preferences.server"
import {
  preferencesCookieName,
  workspacePreferencesCookie,
} from "./workspace-preferences"

const defaults = {
  censored: false,
  censorStep: 2,
  sorting: [{ id: "uploaded_at", desc: true }],
}
const header = (value: unknown) =>
  `${preferencesCookieName}=${encodeURIComponent(JSON.stringify(value))}`

describe("workspace preferences cookie", () => {
  it("round-trips the censor flag and multi-column sorting", () => {
    const preferences = {
      censored: true,
      censorStep: 5,
      sorting: [
        { id: "size", desc: true },
        { id: "display_name", desc: false },
      ],
    }
    const cookie = workspacePreferencesCookie(preferences, true)
    expect(
      readWorkspacePreferences(`unrelated=hello; ${cookie.split(";")[0]}`)
    ).toEqual(preferences)
    expect(cookie).toMatch(/Path=\/; Max-Age=31536000; SameSite=Lax; Secure$/)
    expect(workspacePreferencesCookie(preferences, false)).not.toContain(
      "Secure"
    )
  })

  it("uses defaults for missing and malformed cookies", () => {
    for (const value of [
      null,
      "",
      `${preferencesCookieName}=%E0%A4%A`,
      `${preferencesCookieName}=not-json`,
      header(null),
    ])
      expect(readWorkspacePreferences(value)).toEqual(defaults)
  })

  it("falls back on invalid sort data without losing a valid censor preference", () => {
    for (const sorting of [
      [],
      [{ id: "unknown", desc: true }],
      [{ id: "size", desc: "yes" }],
      [
        { id: "size", desc: true },
        { id: "size", desc: false },
      ],
    ])
      expect(
        readWorkspacePreferences(header({ censored: true, sorting }))
      ).toEqual({ ...defaults, censored: true })
    expect(
      readWorkspacePreferences(
        header({
          censored: "false",
          sorting: [{ id: "display_name", desc: false }],
        })
      )
    ).toEqual({
      ...defaults,
      sorting: [{ id: "display_name", desc: false }],
    })
  })

  it("reads a cookie from before the blur strength as the default step", () => {
    expect(
      readWorkspacePreferences(
        header({ censored: true, sorting: [{ id: "size", desc: false }] })
      )
    ).toEqual({
      censored: true,
      censorStep: 2,
      sorting: [{ id: "size", desc: false }],
    })
  })

  it("clamps the blur step and falls back to the default step on garbage", () => {
    const step = (censorStep: unknown) =>
      readWorkspacePreferences(header({ censorStep })).censorStep
    expect(step(-3)).toBe(1)
    expect(step(40)).toBe(7)
    expect(step(3.6)).toBe(4)
    for (const garbage of ["5", null, true, [], {}, Number.NaN])
      expect(step(garbage)).toBe(2)
  })
})
