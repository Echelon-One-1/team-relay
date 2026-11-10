import { act, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setTransport } from '@/api/client'
import { setConsoleKey, takeKeyFromLocation } from '@/api/key'
import type { ActivityPage } from '@/api/types'
import { App } from '@/App'
import { fixtureActivity, fixtureDirectory, fixtureMe, FIXTURE_NOW, RQ } from '@/mock/fixtures'
import { renderWithClient, setHidden } from './render'

const KEY = 'k3yk3yk3yk3yk3yk3yk3yk3yk3yk3yk3'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

interface Call {
  path: string
  key: string | null
}

/** A console server stand-in: records every call, answers from the fixtures. */
function server(opts: { activity?: (since: string | null) => Response | Promise<Response>; all?: () => Response | null } = {}) {
  const calls: Call[] = []
  setTransport(async (path, init) => {
    const headers = new Headers(init.headers)
    calls.push({ path, key: headers.get('X-Console-Key') })
    const forced = opts.all?.()
    if (forced) return forced
    const url = new URL(path, 'http://console.invalid/')
    if (url.pathname === '/api/me') return json(fixtureMe)
    if (url.pathname === '/api/directory') return json(fixtureDirectory)
    if (url.pathname === '/api/activity') {
      const since = url.searchParams.get('since')
      if (opts.activity) return opts.activity(since)
      return json(since === null ? fixtureActivity : ({ requests: [], next_since: since, server_time: FIXTURE_NOW } satisfies ActivityPage))
    }
    return json({ error: 'not_found' }, 404)
  })
  return {
    calls,
    activityCalls: () => calls.filter((c) => c.path.startsWith('api/activity')),
  }
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('the console', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(Date.parse(FIXTURE_NOW))
    setHidden(false)
    setConsoleKey(KEY)
  })

  afterEach(() => {
    setHidden(false)
  })

  it('sends the key on every call and renders the team, the agents and the feed', async () => {
    const s = server()
    renderWithClient(<App />)
    await flush(10)

    expect(s.calls.length).toBeGreaterThanOrEqual(3)
    expect(s.calls.every((c) => c.key === KEY)).toBe(true)
    expect(screen.getAllByRole('banner')[0]).toHaveTextContent('Team demo')
    expect(screen.getByRole('status')).toHaveTextContent('Live')

    const rows = document.querySelectorAll('li[data-request]')
    expect(rows).toHaveLength(fixtureActivity.requests.length)
    // Newest first.
    expect(rows[0]).toHaveAttribute('data-request', RQ.incoming)
    // A non-participant row names no text, only that it is withheld.
    const masked = document.querySelector(`li[data-request="${RQ.masked}"]`) as HTMLElement
    expect(within(masked).getByText(/Only participants can see this/)).toBeInTheDocument()
    // The broadcast's carol line shows where it stopped.
    const broadcast = document.querySelector(`li[data-request="${RQ.broadcast}"]`) as HTMLElement
    expect(broadcast.querySelector('[data-recipient="carol"]')).toHaveAttribute('data-phase', 'no_response')
    expect(within(broadcast).getByText('1 of 2 answered')).toBeInTheDocument()

    // Presence at FIXTURE_NOW: carol's working session was last seen 200 s ago.
    const carol = document.querySelector('[data-agent="carol"]') as HTMLElement
    expect(carol.querySelector('[data-session="working"]')).toHaveAttribute('data-presence', 'idle')
    expect(carol.querySelector('[data-session="answering"]')).toHaveAttribute('data-presence', 'online')
    expect(within(carol).getByText('production_db_count')).toBeInTheDocument()
  })

  it('shows what each agent can answer from, by name, or that it shares nothing yet (M4 §3, M10 §2)', async () => {
    server()
    renderWithClient(<App />)
    await flush(10)
    const bob = document.querySelector('[data-agent="bob"]') as HTMLElement
    expect(bob.querySelector('[data-shares]')).toHaveAttribute('data-shares', 'orders-service,runbooks')
    expect(bob.querySelector('[data-shares]')).toHaveTextContent('Can answer from: orders-service, runbooks')
    const carol = document.querySelector('[data-agent="carol"]') as HTMLElement
    expect(carol.querySelector('[data-shares]')).toHaveTextContent('Can answer from nothing shared yet')
  })

  it('says "shares nothing" for a teammate whose plugin publishes no shares list', async () => {
    const dir = structuredClone(fixtureDirectory)
    delete dir.members[0]!.manifest!.shares
    dir.members[1]!.manifest = null
    setTransport(async (path) => {
      const url = new URL(path, 'http://console.invalid/')
      if (url.pathname === '/api/me') return json(fixtureMe)
      if (url.pathname === '/api/directory') return json(dir)
      if (url.pathname === '/api/activity') return json(fixtureActivity)
      return json({ error: 'not_found' }, 404)
    })
    renderWithClient(<App />)
    await flush(10)
    for (const m of ['bob', 'carol']) {
      expect(document.querySelector(`[data-agent="${m}"] [data-shares]`)).toHaveTextContent('Can answer from nothing shared yet')
    }
  })

  it('shows a recipient waiting for access in amber on the feed, and clears it when the next event for that tool arrives (M4 §2)', async () => {
    let second = true
    server({
      activity: (since) => {
        if (since === null) return json(fixtureActivity)
        if (second) {
          second = false
          const allowed = structuredClone(fixtureActivity.requests.find((r) => r.request_id === RQ.grant)!)
          allowed.updated_at = '2026-09-23T10:15:02.000Z'
          allowed.recipients.carol!.tools.push({ tool: 'Read', status: 'ok', at: '2026-09-23T10:15:02.000Z', duration_ms: 14 })
          return json({ requests: [allowed], next_since: '2026-09-23T10:15:02.000Z', server_time: '2026-09-23T10:15:03.000Z' })
        }
        return json({ requests: [], next_since: since, server_time: '2026-09-23T10:15:06.000Z' })
      },
    })
    renderWithClient(<App />)
    await flush(10)
    const row = () => document.querySelector(`li[data-request="${RQ.grant}"]`) as HTMLElement
    const line = () => row().querySelector('[data-recipient="carol"]') as HTMLElement
    expect(line()).toHaveAttribute('data-phase', 'awaiting_access')
    expect(within(line()).getByText('Waiting for carol to allow access')).toHaveClass('text-warn')
    expect(line().querySelector('[data-step="tools"]')).toHaveAttribute('data-state', 'waiting')
    expect(line().querySelector('[data-tool-waiting="Read"]')).not.toBeNull()
    expect(within(row()).getByText('Needs access')).toBeInTheDocument()

    await flush(3_000)
    expect(line()).toHaveAttribute('data-phase', 'working')
    expect(within(row()).queryByText(/to allow access/)).toBeNull()
    expect(line().querySelector('[data-step="tools"]')).toHaveAttribute('data-state', 'done')
    expect(line().querySelector('[data-tool-waiting]')).toBeNull()
  })

  it('polls the feed every 3 s from next_since less 30 s of overlap and merges updates by request_id', async () => {
    let second = true
    const s = server({
      activity: (since) => {
        if (since === null) return json(fixtureActivity)
        if (second) {
          second = false
          const done = structuredClone(fixtureActivity.requests.find((r) => r.request_id === RQ.working)!)
          done.updated_at = '2026-09-23T10:15:02.000Z'
          done.recipients.bob = {
            ...done.recipients.bob!,
            status: 'answered',
            answered_at: '2026-09-23T10:15:02.000Z',
            answer_preview: 'Migration 0142.',
          }
          return json({ requests: [done], next_since: '2026-09-23T10:15:02.000Z', server_time: '2026-09-23T10:15:03.000Z' })
        }
        return json({ requests: [], next_since: since, server_time: '2026-09-23T10:15:06.000Z' })
      },
    })
    renderWithClient(<App />)
    await flush(10)
    expect(s.activityCalls()).toHaveLength(1)
    expect(s.activityCalls()[0]?.path).not.toContain('since=')

    await flush(3_000)
    expect(s.activityCalls()).toHaveLength(2)
    const sinceOf = (i: number) => new URL(s.activityCalls()[i]!.path, 'http://x/').searchParams.get('since')
    // M2 §7.1: 30 s before the cursor, so commits that land out of order are picked up.
    expect(sinceOf(1)).toBe('2026-09-23T10:14:28.300Z')
    const row = document.querySelector(`li[data-request="${RQ.working}"]`)!
    expect(row.querySelector('[data-recipient="bob"]')).toHaveAttribute('data-phase', 'returning')
    // Still one row per request.
    expect(document.querySelectorAll('li[data-request]')).toHaveLength(fixtureActivity.requests.length)

    await flush(3_000)
    expect(sinceOf(2)).toBe('2026-09-23T10:14:32.000Z')
    // A quiet window comes back with next_since = since; the cursor must not walk back.
    await flush(3_000)
    expect(sinceOf(3)).toBe('2026-09-23T10:14:32.000Z')
  })

  it('stops polling while the tab is hidden and fetches again as soon as it is visible', async () => {
    const s = server()
    renderWithClient(<App />)
    await flush(10)
    await flush(3_000)
    const before = s.activityCalls().length
    expect(before).toBe(2)

    act(() => setHidden(true))
    await flush(3_000) // the poll already scheduled when it went hidden may still land
    const hidden = s.activityCalls().length
    await flush(30_000)
    expect(s.activityCalls().length).toBe(hidden)
    expect(hidden - before).toBeLessThanOrEqual(1)

    act(() => setHidden(false))
    await flush(10)
    expect(s.activityCalls().length).toBeGreaterThan(hidden)
    const resumed = s.activityCalls().length
    await flush(3_000)
    expect(s.activityCalls().length).toBeGreaterThan(resumed)
  })

  it('says so when the relay stops answering, keeps what it had, and recovers', async () => {
    let down = false
    server({ activity: (since) => (down ? json({ error: 'relay_unreachable' }, 502) : json(since === null ? fixtureActivity : { requests: [], next_since: since, server_time: FIXTURE_NOW })) })
    renderWithClient(<App />)
    await flush(10)
    expect(screen.queryByRole('alert')).toBeNull()

    down = true
    await flush(3_000)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('The relay is not answering')
    expect(alert).toHaveTextContent('retrying every 3 s')
    expect(screen.getByRole('status')).toHaveTextContent('Relay unreachable')
    // The last data stays on screen.
    expect(document.querySelectorAll('li[data-request]')).toHaveLength(fixtureActivity.requests.length)

    down = false
    await flush(3_000)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('Live')
  })

  it('derives no response from the server clock once a pending request passes its ack deadline', async () => {
    // The server clock runs 107 s ahead of the local one: 10:16:47 at the start, five
    // seconds before the incoming request's ack deadline (10:16:52). The feed keeps
    // reporting the stored `pending` (M2 §7.2); the console must not.
    const skew = 107_000
    const serverNow = () => new Date(Date.now() + skew).toISOString()
    server({
      activity: (since) =>
        json(
          since === null
            ? { ...fixtureActivity, server_time: serverNow() }
            : ({ requests: [], next_since: since, server_time: serverNow() } satisfies ActivityPage),
        ),
    })
    renderWithClient(<App />)
    await flush(10)

    const row = () => document.querySelector(`li[data-request="${RQ.incoming}"] [data-recipient="alice"]`)
    const openCount = () => screen.getByRole('radio', { name: /Open/ }).textContent
    expect(row()).toHaveAttribute('data-phase', 'delivered')
    expect(document.querySelector('[data-flight="bob>alice:out"]')).not.toBeNull()
    const before = openCount()

    await flush(6_000)
    expect(row()).toHaveAttribute('data-phase', 'no_response')
    expect(document.querySelector('[data-flight="bob>alice:out"]')).toBeNull()
    // No longer open, and no longer counted as in flight on the map.
    expect(openCount()).not.toBe(before)
    expect(Number(openCount()?.replace(/\D/g, ''))).toBe(Number(before?.replace(/\D/g, '')) - 1)
  })

  it('backs off on 429 rate_limited, keeps what it has, says so quietly and resumes', async () => {
    let limited = 0
    const s = server({
      activity: (since) => {
        if (since === null) return json(fixtureActivity)
        if (limited > 0) {
          limited -= 1
          return json({ error: 'rate_limited', detail: 'At most 120 reads a minute' }, 429)
        }
        return json({ requests: [], next_since: since, server_time: FIXTURE_NOW })
      },
    })
    renderWithClient(<App />)
    await flush(10)
    limited = 2

    await flush(3_000) // the poll at 3 s is refused
    expect(s.activityCalls()).toHaveLength(2)
    expect(screen.getByRole('status')).toHaveTextContent('Slowed down')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.querySelectorAll('li[data-request]')).toHaveLength(fixtureActivity.requests.length)

    // 10 s before the next try, not 3.
    await flush(9_900)
    expect(s.activityCalls()).toHaveLength(2)
    await flush(100)
    expect(s.activityCalls()).toHaveLength(3) // refused again: now 20 s
    await flush(19_900)
    expect(s.activityCalls()).toHaveLength(3)
    await flush(100)
    expect(s.activityCalls()).toHaveLength(4)

    // Through: back to live and to every 3 s.
    expect(screen.getByRole('status')).toHaveTextContent('Live')
    await flush(3_000)
    expect(s.activityCalls()).toHaveLength(5)
  })

  it('backs the directory off on 429 too, keeping the agents on screen', async () => {
    let limited = false
    const dirCalls: number[] = []
    setTransport(async (path) => {
      const url = new URL(path, 'http://console.invalid/')
      if (url.pathname === '/api/me') return json(fixtureMe)
      if (url.pathname === '/api/directory') {
        dirCalls.push(Date.now())
        return limited ? json({ error: 'rate_limited' }, 429) : json(fixtureDirectory)
      }
      const since = url.searchParams.get('since')
      return json(since === null ? fixtureActivity : { requests: [], next_since: since, server_time: FIXTURE_NOW })
    })
    renderWithClient(<App />)
    await flush(10)
    limited = true
    await flush(10_000)
    expect(dirCalls).toHaveLength(2)
    expect(document.querySelector('[data-agent="carol"]')).not.toBeNull()
    await flush(9_900)
    expect(dirCalls).toHaveLength(2)
    await flush(100)
    expect(dirCalls).toHaveLength(3)
  })

  it('tells a stopped console server apart from an unreachable relay', async () => {
    let down = false
    setTransport(async (path) => {
      if (down) throw new TypeError('Failed to fetch')
      const url = new URL(path, 'http://console.invalid/')
      if (url.pathname === '/api/me') return json(fixtureMe)
      if (url.pathname === '/api/directory') return json(fixtureDirectory)
      return json(fixtureActivity)
    })
    renderWithClient(<App />)
    await flush(10)
    down = true
    await flush(3_000)
    expect(screen.getByRole('alert')).toHaveTextContent('The console server is not answering')
  })

  it('shows the unreachable state before any data has arrived', async () => {
    server({ all: () => json({ error: 'relay_unreachable' }, 503) })
    renderWithClient(<App />)
    await flush(10)
    expect(screen.getByRole('alert')).toHaveTextContent('The relay is not answering')
  })

  it('shows an expired link when the console server refuses the key', async () => {
    server({ all: () => json({ error: 'unauthorized' }, 401) })
    renderWithClient(<App />)
    await flush(10)
    expect(screen.getByRole('heading', { name: 'This console link is no longer valid' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('asks for the link when there is no key, and calls nothing', async () => {
    setConsoleKey(null)
    const s = server()
    renderWithClient(<App />)
    await flush(10)
    expect(screen.getByRole('heading', { name: 'Open the console from its link' })).toBeInTheDocument()
    expect(s.calls).toHaveLength(0)
  })
})

describe('the key in the fragment', () => {
  it('is read once, kept in memory and removed from the address bar', () => {
    window.history.replaceState(null, '', `/console/?x=1#k=${KEY}`)
    expect(takeKeyFromLocation()).toBe(KEY)
    expect(window.location.hash).toBe('')
    expect(window.location.pathname + window.location.search).toBe('/console/?x=1')
    expect(window.localStorage.length).toBe(0)
    expect(window.sessionStorage.length).toBe(0)
  })

  it('refuses a malformed key but still clears the fragment', () => {
    setConsoleKey(null)
    window.history.replaceState(null, '', '/#k=<script>')
    expect(takeKeyFromLocation()).toBeNull()
    expect(window.location.hash).toBe('')
  })
})
