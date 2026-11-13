import { describe, expect, it } from "vite-plus/test"
import { readWorkspacePreferences } from "./workspace-preferences.server"
import {
  preferencesCookieName,
  workspacePreferencesCookie,
} from "./workspace-preferences"

const defaults = {
  censored: false,
  censorStrength: 100,
  sorting: [{ id: "uploaded_at", desc: true }],
}
const header = (value: unknown) =>
  `${preferencesCookieName}=${encodeURIComponent(JSON.stringify(value))}`

describe("workspace preferences cookie", () => {
  it("round-trips the censor flag and multi-column sorting", () => {
    const preferences = {
      censored: true,
      censorStrength: 35,
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

  it("reads a cookie from before the blur strength as full strength", () => {
    expect(
      readWorkspacePreferences(
        header({ censored: true, sorting: [{ id: "size", desc: false }] })
      )
    ).toEqual({
      censored: true,
      censorStrength: 100,
      sorting: [{ id: "size", desc: false }],
    })
  })

  it("clamps the blur strength and falls back to full strength on garbage", () => {
    const strength = (censorStrength: unknown) =>
      readWorkspacePreferences(header({ censorStrength })).censorStrength
    expect(strength(-20)).toBe(0)
    expect(strength(250)).toBe(100)
    expect(strength(41.6)).toBe(42)
    for (const garbage of ["50", null, true, [], {}, Number.NaN])
      expect(strength(garbage)).toBe(100)
  })
})
