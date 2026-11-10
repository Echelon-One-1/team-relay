import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

import { resetTransport } from '@/api/client'
import { setConsoleKey } from '@/api/key'
import { resetFeedHealth } from '@/hooks/queries'

// jsdom lays nothing out and has no observers; these stubs are the whole difference.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  resetTransport()
  resetFeedHealth()
  setConsoleKey(null)
  // What a test left in storage (a panel's open state) never leaks into the next.
  window.localStorage.clear()
  window.sessionStorage.clear()
})
