// The server keeps a browser trace by its ID, so every batch of one trace gets
// the same decision. The browser makes it too, to mark the `traceparent` it
// sends, and the server's request middleware makes it again for the spans it
// continues the trace with. Both halves of a trace are kept or dropped together.
export function keepBrowserTrace(traceId: string, ratio: number): boolean {
  return Number.parseInt(traceId.slice(0, 8), 16) / 0x1_0000_0000 < ratio
}

/** The page's `<meta>` carrying the ratio; present only when telemetry is on. */
export const browserTraceSampleRatioMeta =
  "mediabinder-browser-trace-sample-ratio"
