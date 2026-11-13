import { afterEach, describe, expect, it, vi } from "vite-plus/test"

// The memo lives in the module, so each test loads its own copy.
const load = async () => {
  vi.resetModules()
  return import("./video-codec")
}

// A browser that decodes only what `supported` lists, by codecs string.
const browser = (supported: string[]) => {
  const canPlayType = vi.fn((type: string) =>
    supported.some((codec) => type.includes(codec)) ? "probably" : ""
  )
  vi.stubGlobal("document", { createElement: () => ({ canPlayType }) })
  return canPlayType
}

afterEach(() => vi.unstubAllGlobals())

describe("canDecodeVideoCodec", () => {
  it("says no for a codec the browser lacks, yes for one it has, and nothing for what it can't ask about", async () => {
    browser(["avc1"])
    const { canDecodeVideoCodec } = await load()
    expect(canDecodeVideoCodec("hvc1")).toBe(false)
    expect(canDecodeVideoCodec("avc1")).toBe(true)
    expect(canDecodeVideoCodec("unknown")).toBeUndefined()
    expect(canDecodeVideoCodec(null)).toBeUndefined()
  })

  it("asks the browser once per codec", async () => {
    const canPlayType = browser([])
    const { canDecodeVideoCodec } = await load()
    canDecodeVideoCodec("hvc1")
    canDecodeVideoCodec("hvc1")
    canDecodeVideoCodec("hvc1")
    expect(canPlayType).toHaveBeenCalledTimes(1)
  })
})
