// Small per-browser layout choices (a panel left closed, a height dragged to). Storage can be
// unavailable (a private window, blocked site data): reads then give null and writes do
// nothing, and the console works the same for that visit.

export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // Unavailable: the choice holds for this visit only.
  }
}
