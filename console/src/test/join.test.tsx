// M11-SPEC "Simpler joining": the team page shows one small card, "Join in 2 minutes", to a
// viewer who has not joined yet (their Mac has never reported in, or they have never accepted
// what the team shares): open Terminal, paste the setup line (with a big Copy button), come back
// and click Accept, and a link to their progress. It goes once they have joined. The old
// developer join panel (plugin, marketplace, channel and read-folder commands) is gone. The
// console server is the dev mock.

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
  window.history.replaceState(null, '', '/')
  window.localStorage.clear()
})

describe('the join card', () => {
  it('a viewer who is not set up sees the three plain steps, the line with a big Copy button, and a link to their progress', async () => {
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
    // While the card shows, the accept banner (which says the same) does not.
    expect(screen.queryByRole('region', { name: 'Accept what the team shares' })).toBeNull()
    await user.click(within(c).getByRole('button', { name: /See your progress/ }))
    expect(window.location.pathname).toBe('/join')
    expect(await screen.findByRole('region', { name: 'Your setup' })).toBeInTheDocument()
  })

  it('"Go to Accept" on the card goes to the Setup page, where the viewer reads and accepts', async () => {
    server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const c = await card()
    // It only goes there: accepting is done on the Setup page, after reading what is shared.
    expect(within(c).queryByRole('button', { name: 'Accept' })).toBeNull()
    await user.click(within(c).getByRole('button', { name: 'Go to Accept' }))
    expect(window.location.pathname).toBe('/join')
    expect(await screen.findByRole('button', { name: 'Accept' })).toBeInTheDocument()
  })

  it('goes once the viewer has joined: their Mac has reported in, and they have accepted once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    try {
      const relay = server()
      renderWithClient(<App />)
      await flush(50)
      await flush(50)
      expect(screen.getByRole('region', { name: 'Join in 2 minutes' })).toBeInTheDocument()
      // The Mac reports in (alice accepted version 1 earlier): on the next read she has joined.
      relay.setMemberStatus('alice', mockStatus(Date.now(), { drive: false }), true)
      await flush(30_000)
      await flush(50)
      expect(screen.queryByRole('region', { name: 'Join in 2 minutes' })).toBeNull()
      // Something new to accept shows the banner, not the card.
      expect(screen.getByRole('region', { name: 'Accept what the team shares' })).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('no card while progress is unknown: a relay that does not report it (404)', async () => {
    server((p) => (p === '/api/members-status' || p === '/api/acceptance' ? json({ error: 'not_found' }, 404) : null))
    renderWithClient(<App />)
    await screen.findByRole('region', { name: 'Members' })
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
