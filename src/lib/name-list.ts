// Commas delimit names; spaces inside a name are preserved.
export function parseNameList(value: string): string[] {
  const names = new Map<string, string>()
  for (const part of value.split(",")) {
    const name = part.trim()
    if (name && !names.has(name.toLowerCase()))
      names.set(name.toLowerCase(), name)
  }
  return [...names.values()]
}

export function formatNameList(names: string[]): string {
  return names.join(", ")
}
