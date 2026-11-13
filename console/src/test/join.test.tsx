// M11-SPEC "Simpler joining": the Setup page shows one small card, "Join in 2 minutes", above the
// steps, to a viewer who has not joined yet (their Mac has never reported in, or they have never
// accepted the team's topic): open Terminal, paste the setup line (with a big Copy button), come
// back and click Accept, which brings the Accept step on the same page into view. It goes once
// they have joined. The team page does not show it. The old developer join panel (plugin,
// marketplace, channel and read-folder commands) is gone. The console server is the dev mock.

import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { setTransport } from '@/api/client'
import { setConsoleKey } from '@/api/key'
import { App } from '@/App'
import { MockRelay, mockStatus } from '@/mock/relay'
import { renderWithClient } from './render'

const KEY = 'j01nj01nj01nj01nj01nj01nj01nj01n'
const LINE = 'curl -fsSL https://relay.example.com/setup | bash'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** The dev mock with alice (the viewer) not joined yet: her Mac has never reported in. */
function server(override?: (path: string) => Response | null) {
  const relay = new MockRelay()
  relay.latency = [0, 0]
  relay.setMemberStatus('alice', null, false)
  setTransport(async (path, init) => {
    const url = new URL(path, 'http://console.invalid/')
    return override?.(url.pathname) ?? relay.handle(path, init)
  })
  return relay
}

const card = () => screen.findByRole('region', { name: 'Join in 2 minutes' })

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  setConsoleKey(KEY)
  window.history.replaceState(null, '', '/join')
  window.localStorage.clear()
})

describe('the join card', () => {
  it('a viewer who is not set up sees the three plain steps and the line with a big Copy button, above their setup', async () => {
    server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const c = await card()
    await within(c).findByText(LINE)
    const steps = within(c).getByRole('list', { name: 'Steps to join' })
    expect([...steps.querySelectorAll('[data-join-step]')].map((li) => li.textContent)).toEqual([
      '1Open Terminal: press Cmd+Space, type Terminal, press Enter.',
      `2Paste this line and press Enter, then answer its questions:${LINE}Copy`,
      '3Come back to this page and click Accept.Go to Accept',
    ])
    await user.click(within(c).getByRole('button', { name: 'Copy setup line' }))
    expect(await navigator.clipboard.readText()).toBe(LINE)
    expect(within(c).getByRole('button', { name: 'Copy setup line' })).toHaveTextContent('Copied')
    // Nothing technical, and the old developer panel is gone.
    expect(c.textContent).not.toMatch(/plugin|marketplace|channel|\bCLI\b|\bNode|daemon|LaunchAgent|ANSWERER_READ_DIRS|boundaries/i)
    expect(document.querySelector('[data-join]')).toBeNull()
    expect(screen.queryByRole('button', { name: /Join the team/ })).toBeNull()
    // The card sits above the viewer's own progress, on the same page.
    const setup = await screen.findByRole('region', { name: 'Your setup' })
    expect(c.compareDocumentPosition(setup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('"Go to Accept" brings the Accept step on the same page into view and focuses Accept', async () => {
    server()
    const user = userEvent.setup()
    const scrolled: Element[] = []
    const scroll = vi.fn(function (this: Element) {
      scrolled.push(this)
    })
    Element.prototype.scrollIntoView = scroll
    try {
      renderWithClient(<App />)
      const c = await card()
      // It only goes there: accepting is done in the step, after reading the topic.
      expect(within(c).queryByRole('button', { name: 'Accept' })).toBeNull()
      const accept = await screen.findByRole('button', { name: 'Accept' })
      await user.click(within(c).getByRole('button', { name: 'Go to Accept' }))
      expect(window.location.pathname).toBe('/join')
      expect(scrolled).toEqual([document.querySelector('[data-setup-step="accept"]')])
      expect(document.activeElement).toBe(accept)
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  it('the team page does not show it', async () => {
    window.history.replaceState(null, '', '/team')
    server()
    renderWithClient(<App />)
    await screen.findByRole('region', { name: 'Members' })
    await act(async () => {})
    expect(screen.queryByRole('region', { name: 'Join in 2 minutes' })).toBeNull()
    expect(document.querySelector('[data-join-card]')).toBeNull()
  })

  it('goes once the viewer has joined: their Mac has reported in, and they have accepted once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    try {
      const relay = server()
      renderWithClient(<App />)
      await flush(50)
      await flush(50)
      expect(screen.getByRole('region', { name: 'Join in 2 minutes' })).toBeInTheDocument()
      // The Mac reports in: still not joined until she has accepted the topic once.
      relay.setMemberStatus('alice', mockStatus(Date.now(), {}), true, undefined, 0)
      await flush(30_000)
      await flush(50)
      expect(screen.getByRole('region', { name: 'Join in 2 minutes' })).toBeInTheDocument()
      // She accepts version 2, and the topic changes since (version 3): she has joined, and her
      // acceptance holds (the topic widens nothing).
      await relay.handle('api/acceptance', { method: 'PUT', headers: { 'X-Relay-Team': 'demo' }, body: JSON.stringify({ version: 2 }) })
      relay.setBoundariesAs('demo', 'bob', { topic: 'Example Co: payments only.' })
      await flush(60_000)
      await flush(50)
      expect(screen.queryByRole('region', { name: 'Join in 2 minutes' })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('no card while progress is unknown: a relay that does not report it (404)', async () => {
    server((p) => (p === '/api/members-status' || p === '/api/acceptance' ? json({ error: 'not_found' }, 404) : null))
    renderWithClient(<App />)
    await screen.findByRole('region', { name: 'Your setup' })
    await act(async () => {})
    expect(screen.queryByRole('region', { name: 'Join in 2 minutes' })).toBeNull()
  })

  it('without an address for the line (a local console whose server names no relay), it says where the line comes from', async () => {
    // The tests run on localhost, like the local console: only /api/join names the relay's address.
    expect(window.location.hostname).toBe('localhost')
    server((p) => (p === '/api/join' ? json({ error: 'not_found' }, 404) : null))
    renderWithClient(<App />)
    const c = await card()
    await waitFor(() => expect(c.querySelector('[data-no-command]')).not.toBeNull())
    expect(c.querySelector('[data-no-command]')).toHaveTextContent('Paste the setup line a team owner sent you, press Enter, then answer its questions.')
    expect(c.querySelector('[data-command]')).toBeNull()
  })
})
