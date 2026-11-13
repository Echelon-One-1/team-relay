// docs/SIGNIN-PAGE.md: on the hosted address, / is the relay's public sign-in page, so the team
// view has its own path, /team, and the page's "Sign in with Google" leads to /start. /start
// shows the loading state, then, once the viewer's own setup is known, replaces its address
// (never a new history entry) with /join while the setup is not done, else /ask. A viewer on no
// team sees what / shows them; a setup that cannot be read goes to /join, which says why. The
// local console still opens on the team view at /. The console server is the dev mock
// (src/mock/relay.ts), with every call recorded.

import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { setTransport } from '@/api/client'
import { setConsoleKey } from '@/api/key'
import { App } from '@/App'
import { MockRelay, mockStatus } from '@/mock/relay'
import { renderWithClient } from './render'

const KEY = 'st4rt-st4rt-st4rt-st4rt-st4rt-st'

type Call = { method: string; path: string; team: string | null }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function server(opts: { stranger?: boolean; override?: (c: Call) => Response | null } = {}) {
  const relay = new MockRelay()
  relay.latency = [0, 0]
  relay.stranger = opts.stranger ?? false
  const calls: Call[] = []
  setTransport(async (path, init) => {
    const url = new URL(path, 'http://console.invalid/')
    const call: Call = {
      method: (init.method ?? 'GET').toUpperCase(),
      path: url.pathname + url.search,
      team: new Headers(init.headers).get('X-Relay-Team'),
    }
    calls.push(call)
    return opts.override?.(call) ?? relay.handle(path, init)
  })
  return { relay, calls }
}

/** alice's own setup, done: her Mac reports every check passing and she accepted the current boundaries. */
async function setUpAlice(relay: MockRelay) {
  relay.setMemberStatus('alice', mockStatus(Date.now(), {}), true)
  const headers = { 'X-Relay-Team': 'demo', 'Content-Type': 'application/json' }
  const bounds = (await (await relay.handle('/api/boundaries', { headers })).json()) as { version: number }
  const put = await relay.handle('/api/acceptance', { method: 'PUT', headers, body: JSON.stringify({ version: bounds.version }) })
  expect(put.status).toBe(200)
}

const tab = (name: string) => screen.getByRole('navigation', { name: 'Pages' }).querySelector(`[data-view-tab="${name}"]`) as HTMLElement

type HistoryChange = (data: unknown, unused: string, url?: string | URL | null) => void
let replace: MockInstance<HistoryChange>
let push: MockInstance<HistoryChange>

beforeEach(() => {
  setConsoleKey(KEY)
  window.localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function at(path: string) {
  window.history.replaceState(null, '', path)
  replace = vi.spyOn(window.history, 'replaceState')
  push = vi.spyOn(window.history, 'pushState')
}

const replacedTo = () => replace.mock.calls.map((c) => c[2])

describe('/start: where the sign-in page leads', () => {
  it('shows the loading state, then replaces /start with /join while the setup is not done', async () => {
    server()
    at('/start')
    renderWithClient(<App />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading')
    expect(await screen.findByRole('region', { name: 'Your setup' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/join')
    expect(tab('join')).toHaveAttribute('aria-current', 'page')
    expect(replacedTo()).toEqual(['/join'])
    expect(push).not.toHaveBeenCalled()
  })

  it('replaces /start with /ask once the setup is done', async () => {
    const s = server()
    await setUpAlice(s.relay)
    at('/start')
    renderWithClient(<App />)
    expect(await screen.findByRole('region', { name: 'Ask the team' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/ask')
    expect(tab('ask')).toHaveAttribute('aria-current', 'page')
    expect(replacedTo()).toEqual(['/ask'])
    expect(push).not.toHaveBeenCalled()
  })

  it('reads nothing new: only what the Setup tab already reads', async () => {
    const s = server()
    at('/start')
    renderWithClient(<App />)
    await screen.findByRole('region', { name: 'Your setup' })
    const paths = new Set(s.calls.map((c) => c.path.split('?')[0]))
    // On a Mac, the Setup tab also asks for /team-relay:setup's page (404 here: the usual page).
    for (const p of paths) {
      expect(['/api/teams', '/api/me', '/api/members-status', '/api/acceptance', '/api/boundaries', '/api/directory', '/api/activity', '/api/roster', '/api/join', '/api/my-requests', '/api/inbox/summary', '/api/approvals/summary', '/api/local/setup']).toContain(p)
    }
  })

  it('a setup that cannot be read goes to /join, which says so', async () => {
    server({ override: (c) => (c.path === '/api/members-status' ? json({ error: 'not_found' }, 404) : null) })
    at('/start')
    renderWithClient(<App />)
    expect(await screen.findByText(/This team can't show your progress here yet/)).toBeInTheDocument()
    expect(window.location.pathname).toBe('/join')
    expect(replacedTo()).toEqual(['/join'])
    expect(push).not.toHaveBeenCalled()
  })

  it('a viewer on no team sees what / shows them, at /team', async () => {
    server({ stranger: true })
    at('/start')
    renderWithClient(<App />)
    expect(await screen.findByText("You're not on a team yet")).toBeInTheDocument()
    await waitFor(() => expect(window.location.pathname).toBe('/team'))
    expect(replacedTo()).toEqual(['/team'])
    expect(push).not.toHaveBeenCalled()
  })

  it('keeps the query and drops any fragment', async () => {
    server()
    at('/start?x=1#frag')
    renderWithClient(<App />)
    await screen.findByRole('region', { name: 'Your setup' })
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/join?x=1')
  })
})

describe('/team: the team view has its own path', () => {
  it('/team shows the team view', async () => {
    server()
    at('/team')
    renderWithClient(<App />)
    expect(await screen.findByRole('region', { name: 'Members' })).toBeInTheDocument()
    expect(tab('team')).toHaveAttribute('aria-current', 'page')
    expect(window.location.pathname).toBe('/team')
    expect(push).not.toHaveBeenCalled()
  })

  it('the Team tab pushes /team; back returns to where the viewer was', async () => {
    server()
    at('/join')
    const user = userEvent.setup()
    renderWithClient(<App />)
    await screen.findByRole('region', { name: 'Your setup' })
    await user.click(tab('team'))
    expect(await screen.findByRole('region', { name: 'Members' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/team')
    expect(push.mock.calls.map((c) => c[2])).toEqual(['/team'])
    window.history.back()
    expect(await screen.findByRole('region', { name: 'Your setup' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/join')
    expect(tab('join')).toHaveAttribute('aria-current', 'page')
    await user.click(tab('ask'))
    expect(window.location.pathname).toBe('/ask')
    await user.click(tab('team'))
    expect(window.location.pathname).toBe('/team')
  })

  it('the local console still opens on the team view at /', async () => {
    server()
    at('/')
    renderWithClient(<App />)
    expect(await screen.findByRole('region', { name: 'Members' })).toBeInTheDocument()
    expect(tab('team')).toHaveAttribute('aria-current', 'page')
    expect(window.location.pathname).toBe('/')
    expect(push).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })
})
