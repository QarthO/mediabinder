// Hook point for browser error reporting. It does nothing until browser
// telemetry is wired in; callers already pass the operation that failed.
export function reportBrowserError(
  cause: unknown,
  context: { operation: string }
): void {
  void cause
  void context
}
