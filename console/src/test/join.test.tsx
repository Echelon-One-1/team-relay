// M11-SPEC "Simpler joining": the Setup page shows one small card, "Join in 2 minutes", above the
// steps, to a viewer who has not joined yet (their Mac has never reported in, or they have never
// accepted the team's topic): in the Claude app (14 Nov 2026), add the plugin source (with a big
// Copy button), add the plugin, type /team-relay:setup in a Code session, then come back and
// click Accept, which brings the Accept step on the same page into view. No Terminal, no curl. It goes once
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
const SOURCE = 'example-org/team-relay'

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
  it('a viewer who is not set up sees the five plain steps through the Claude app, the plugin source with a big Copy button, above their setup', async () => {
    server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const c = await card()
    await within(c).findByText(SOURCE)
    const steps = within(c).getByRole('list', { name: 'Steps to join' })
    expect([...steps.querySelectorAll('[data-join-step]')].map((li) => li.textContent)).toEqual([
      '1Open the Claude app. Click Customize, then Plugins, then "+ Add", then "Add marketplace".',
      `2Paste this and click Sync:${SOURCE}Copy`,
      '3Find "team-relay" in the list and click Add.',
      '4Start a Code session and type this:/team-relay:setupA page opens: sign in, pick your team, choose the folders your Claude may read, then click Done.',
      '5Come back to this page. If it still asks, click Accept.Go to Accept',
    ])
    await user.click(within(c).getByRole('button', { name: 'Copy plugin source' }))
    expect(await navigator.clipboard.readText()).toBe(SOURCE)
    expect(within(c).getByRole('button', { name: 'Copy plugin source' })).toHaveTextContent('Copied')
    await user.click(within(c).getByRole('button', { name: 'Copy setup command' }))
    expect(await navigator.clipboard.readText()).toBe('/team-relay:setup')
    // No Terminal, nothing technical beyond the Claude app's own labels, and the old developer panel is gone.
    expect(c.textContent).not.toMatch(/Terminal|curl|setup line|channel|\bCLI\b|\bNode|daemon|LaunchAgent|ANSWERER_READ_DIRS|boundaries/i)
    expect(document.querySelector('[data-join]')).toBeNull()
    expect(screen.queryByRole('button', { name: /Join the team/ })).toBeNull()
    // The card sits above the viewer's own progress, on the same page.
    const setup = await screen.findByRole('region', { name: 'Your setup' })
    expect(c.compareDocumentPosition(setup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The steps are said once: the Mac step points up to the card.
    const mac = setup.querySelector('[data-setup-step="mac"]') as HTMLElement
    expect(within(mac).getByText('Follow "Join in 2 minutes" above.')).toBeInTheDocument()
    expect(within(mac).queryByText(SOURCE)).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Copy plugin source' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Copy setup command' })).toHaveLength(1)
    expect(document.body.textContent).not.toMatch(/Terminal|curl|setup line/i)
  })

  it('without the card (joined), the Mac step says how to change the folders in Claude', async () => {
    const relay = server()
    relay.setMemberStatus('alice', mockStatus(Date.now(), {}), true, undefined, 0)
    await relay.handle('api/acceptance', { method: 'PUT', headers: { 'X-Relay-Team': 'demo' }, body: JSON.stringify({ version: 2 }) })
    renderWithClient(<App />)
    const setup = await screen.findByRole('region', { name: 'Your setup' })
    // Her acceptance has loaded, and she has joined.
    await waitFor(() => expect(setup.querySelector('[data-setup-step="accept"]')).toHaveAttribute('data-done', 'true'))
    expect(screen.queryByRole('region', { name: 'Join in 2 minutes' })).toBeNull()
    const mac = setup.querySelector('[data-setup-step="mac"]') as HTMLElement
    expect(mac.querySelector('[data-setup-command]')).toHaveTextContent(
      "Choose your folders: in Claude, type /team-relay:setup. A page opens with your Mac's folder window.",
    )
    expect(within(mac).getByRole('button', { name: 'Copy setup command' })).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/Terminal|curl|setup line/i)
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

  it('"Go to Accept" with Accept already pressed focuses the step, with a visible ring until focus leaves', async () => {
    const relay = server()
    // Accepted, but the Mac has not reported in: still not joined, and the Accept button is disabled.
    await relay.handle('api/acceptance', { method: 'PUT', headers: { 'X-Relay-Team': 'demo' }, body: JSON.stringify({ version: 2 }) })
    const user = userEvent.setup()
    renderWithClient(<App />)
    const c = await card()
    expect(await screen.findByRole('button', { name: 'Accepted' })).toBeDisabled()
    await user.click(within(c).getByRole('button', { name: 'Go to Accept' }))
    const step = document.querySelector('[data-setup-step="accept"]') as HTMLElement
    expect(document.activeElement).toBe(step)
    expect(step).toHaveAttribute('data-focus-ring', 'true')
    await user.click(within(c).getByRole('button', { name: 'Copy plugin source' }))
    expect(step).not.toHaveAttribute('data-focus-ring')
  })

  it('the team page does not show it', async () => {
    window.history.replaceState(null, '', '/team')
    server()
    renderWithClient(<App />)
    await screen.findByRole('region', { name: 'Ask the team' })
    // Progress has loaded (the Setup tab counts 0 of 2) and she has not joined: still no card here.
    await waitFor(() => expect(document.querySelector('[data-setup-tab-count]')).toHaveTextContent('0/2'))
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
      // Her acceptance has loaded: the Accept step is done.
      expect(document.querySelector('[data-setup-step="accept"]')).toHaveAttribute('data-done', 'true')
      expect(screen.queryByRole('region', { name: 'Join in 2 minutes' })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('no card while progress is unknown: a relay that does not report it (404)', async () => {
    server((p) => (p === '/api/members-status' || p === '/api/acceptance' ? json({ error: 'not_found' }, 404) : null))
    renderWithClient(<App />)
    // The 404 has been read: the page says progress cannot be shown.
    expect(await screen.findByText(/This team can't show your progress here yet/)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Join in 2 minutes' })).toBeNull()
  })

  it('without a plugin source (a server that names none, or an older one), step 2 says to ask a team owner for it', async () => {
    server((p) => (p === '/api/join' ? json({ relay_url: 'https://relay.example.com', team: 'demo', marketplace_source: null }) : null))
    renderWithClient(<App />)
    const c = await card()
    await waitFor(() => expect(c.querySelector('[data-no-source]')).not.toBeNull())
    expect(c.querySelector('[data-no-source]')).toHaveTextContent('Ask a team owner for the plugin source, paste it and click Sync.')
    expect(within(c).queryByRole('button', { name: 'Copy plugin source' })).toBeNull()
    // The plugin's name falls back to team-relay; the setup command is still there.
    expect(c.querySelector('[data-join-step="3"]')).toHaveTextContent('Find "team-relay" in the list and click Add.')
    expect(within(c).getByRole('button', { name: 'Copy setup command' })).toBeInTheDocument()
  })

  it('a source that is not a GitHub owner/repo or a plain https URL is never shown', async () => {
    server((p) => (p === '/api/join' ? json({ relay_url: 'https://relay.example.com', team: 'demo', marketplace_source: 'a/b; rm -rf ~', plugin: '<b>x</b>' }) : null))
    renderWithClient(<App />)
    const c = await card()
    await waitFor(() => expect(c.querySelector('[data-no-source]')).not.toBeNull())
    expect(c.textContent).not.toMatch(/rm -rf|<b>/)
    expect(c.querySelector('[data-join-step="3"]')).toHaveTextContent('Find "team-relay" in the list and click Add.')
  })

  it('without /api/join at all (404), step 2 says to ask a team owner', async () => {
    server((p) => (p === '/api/join' ? json({ error: 'not_found' }, 404) : null))
    renderWithClient(<App />)
    const c = await card()
    await waitFor(() => expect(c.querySelector('[data-no-source]')).not.toBeNull())
    expect(c.querySelector('[data-command="plugin source"]')).toBeNull()
  })
})
