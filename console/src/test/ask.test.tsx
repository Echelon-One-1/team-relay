// M11 §4: the Ask page. The viewer picks teammates or everyone, types a question (1-8000
// characters, counted) and sends exactly {to, question}; their last 20 questions are listed,
// and an open one shows each recipient's state and full answer, read every 3 s while open and
// every 30 s while closed. Answers are teammates' text: plain text, never markup. The console
// server is the dev mock (src/mock/relay.ts) on a clock the test moves.

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setConsoleKey } from '@/api/key'
import { setTransport } from '@/api/client'
import { App } from '@/App'
import { TEAM_STORAGE_KEY } from '@/lib/teams'
import { MockRelay } from '@/mock/relay'
import { renderWithClient, setHidden } from './render'

const KEY = 'a5k-a5k-a5k-a5k-a5k-a5k-a5k-a5k-'

type Call = { method: string; path: string; team: string | null; body: unknown }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function server(opts: { override?: (c: Call) => Response | null; now?: () => number } = {}) {
  const relay = new MockRelay(opts.now)
  relay.latency = [0, 0]
  const calls: Call[] = []
  setTransport(async (path, init) => {
    const url = new URL(path, 'http://console.invalid/')
    const headers = new Headers(init.headers)
    const call: Call = {
      method: (init.method ?? 'GET').toUpperCase(),
      path: url.pathname + url.search,
      team: headers.get('X-Relay-Team'),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    return opts.override?.(call) ?? relay.handle(path, init)
  })
  return { relay, calls, posts: () => calls.filter((c) => c.method === 'POST'), gets: (p: string) => calls.filter((c) => c.method === 'GET' && c.path === p).length }
}

const askPanel = () => screen.findByRole('region', { name: 'Ask the team' })
const listPanel = () => screen.findByRole('region', { name: 'Your questions' })
const chip = (m: string) => document.querySelector(`[data-recipient="${m}"]`) as HTMLElement

beforeEach(() => {
  setConsoleKey(KEY)
  window.history.replaceState(null, '', '/ask')
  window.localStorage.clear()
  setHidden(false)
})

afterEach(() => {
  setHidden(false)
})

describe('the Ask page (M11 §4)', () => {
  it('lists the questions the viewer asked, at most 20', async () => {
    const s = server()
    renderWithClient(<App />)
    const list = await listPanel()
    const items = await within(list).findAllByRole('button', { expanded: false })
    expect(items.length).toBeGreaterThan(0)
    expect(items.length).toBeLessThanOrEqual(20)
    expect(s.gets('/api/my-requests')).toBeGreaterThanOrEqual(1)
    const lines = [...list.querySelectorAll('[data-ask-item]')].map((li) => li.getAttribute('data-ask-item'))
    expect(new Set(lines).size).toBe(lines.length)
  })

  it('a team where the viewer has asked nothing: says so', async () => {
    window.localStorage.setItem(TEAM_STORAGE_KEY, 'research')
    server()
    renderWithClient(<App />)
    expect(await within(await listPanel()).findByText(/You have not asked anything yet/)).toBeInTheDocument()
  })

  it('a relay without the routes (404): says the list is not available', async () => {
    server({ override: (c) => (c.path === '/api/my-requests' ? json({ error: 'not_found' }, 404) : null) })
    renderWithClient(<App />)
    expect(await within(await listPanel()).findByText('This relay cannot list your questions yet.')).toBeInTheDocument()
  })

  it('needs someone to ask and a question; counts characters up to 8000', async () => {
    const s = server()
    renderWithClient(<App />)
    const panel = await askPanel()
    const send = within(panel).getByRole('button', { name: 'Send' })
    const box = within(panel).getByLabelText('Question')
    await waitFor(() => expect(chip('bob')).not.toBeNull())
    expect(send).toBeDisabled()
    fireEvent.change(box, { target: { value: 'Where is the runbook?' } })
    expect(send).toBeDisabled()
    fireEvent.click(chip('bob'))
    expect(chip('bob')).toHaveAttribute('aria-pressed', 'true')
    expect(send).toBeEnabled()
    expect(within(panel).getByText('21 / 8000')).toBeInTheDocument()
    fireEvent.change(box, { target: { value: '\u{1F600}'.repeat(8000) } })
    expect(within(panel).getByText('8000 / 8000')).toBeInTheDocument()
    expect(send).toBeEnabled()
    fireEvent.change(box, { target: { value: 'x'.repeat(8001) } })
    expect(within(panel).getByText('8001 / 8000')).toBeInTheDocument()
    expect(box).toHaveAttribute('aria-invalid', 'true')
    expect(send).toBeDisabled()
    fireEvent.change(box, { target: { value: '   ' } })
    expect(send).toBeDisabled()
    // Everyone replaces the teammates chosen.
    fireEvent.change(box, { target: { value: 'Anyone?' } })
    fireEvent.click(chip('*'))
    expect(chip('*')).toHaveAttribute('aria-pressed', 'true')
    expect(chip('bob')).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(send)
    await waitFor(() => expect(s.posts()).toEqual([{ method: 'POST', path: '/api/ask', team: 'demo', body: { to: '*', question: 'Anyone?' } }]))
    expect(await within(panel).findByText('Sent to everyone.')).toBeInTheDocument()
  })

  it('a refusal shows in words, where it happened', async () => {
    server({
      override: (c) =>
        c.method === 'POST'
          ? json({ error: 'relay_refused', relay_status: 400, relay_error: 'bad_recipients', detail: "'to' names someone who is not in your team." }, 502)
          : null,
    })
    const user = userEvent.setup()
    renderWithClient(<App />)
    const panel = await askPanel()
    await waitFor(() => expect(chip('carol')).not.toBeNull())
    await user.click(chip('carol'))
    await user.type(within(panel).getByLabelText('Question'), 'Hello?')
    await user.click(within(panel).getByRole('button', { name: 'Send' }))
    expect(await within(panel).findByRole('alert')).toHaveTextContent("'to' names someone who is not in your team.")
    // What was typed stays.
    expect(within(panel).getByLabelText('Question')).toHaveValue('Hello?')
  })

  it('an answer is shown as plain text: markup in it stays text', async () => {
    const id = `rq_${'e'.repeat(32)}`
    const evil = '<img src=x onerror="alert(1)"><b>bold</b>\n<script>alert(2)</script> & [a link](javascript:alert(3))'
    server({
      override: (c) => {
        if (c.path === '/api/my-requests') return json({ requests: [{ id, to: ['bob'], created_at: new Date().toISOString(), question_preview: '<i>q</i>' }] })
        if (c.path === `/api/requests/${id}`) {
          return json({
            request_id: id,
            kind: 'question',
            asker: 'alice',
            broadcast: false,
            question: '<i>q</i>',
            capability: null,
            created_at: new Date().toISOString(),
            ack_deadline: new Date().toISOString(),
            answer_deadline: new Date().toISOString(),
            expire_at: new Date(Date.now() + 86_400_000).toISOString(),
            recipients: { bob: { status: 'answered', acked_at: null, answered_at: null, answer_preview: 'short', answer: evil } },
            progress: [],
          })
        }
        return null
      },
    })
    const user = userEvent.setup()
    renderWithClient(<App />)
    const list = await listPanel()
    await user.click(await within(list).findByRole('button', { name: /<i>q<\/i>/ }))
    const answer = await waitFor(() => {
      const el = list.querySelector('[data-answer]') as HTMLElement
      expect(el).not.toBeNull()
      return el
    })
    expect(answer.textContent).toBe(evil)
    expect(answer.querySelector('img, b, script, a, i')).toBeNull()
    expect(list.querySelector('img, script, b')).toBeNull()
  })
})

describe('asking and following the answers (M11 §4)', () => {
  let t = 0
  async function flush(ms = 0) {
    await act(async () => {
      t += ms
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    t = Date.parse('2026-11-10T10:00:00.000Z')
  })

  it('sends exactly {to, question}, opens it, and shows who acknowledged and answered as it happens', async () => {
    const s = server({ now: () => t })
    renderWithClient(<App />)
    await flush(20)
    await flush(20)
    const panel = screen.getByRole('region', { name: 'Ask the team' })
    fireEvent.click(chip('bob'))
    fireEvent.click(chip('carol'))
    fireEvent.change(within(panel).getByLabelText('Question'), { target: { value: 'Who owns the invoice export?\nAnd its retries?' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Send' }))
    await flush(20)
    expect(s.posts()).toEqual([{ method: 'POST', path: '/api/ask', team: 'demo', body: { to: ['bob', 'carol'], question: 'Who owns the invoice export?\nAnd its retries?' } }])
    expect(within(panel).getByText('Sent to bob, carol.')).toBeInTheDocument()
    expect(within(panel).getByLabelText('Question')).toHaveValue('')
    await flush(20)
    const list = screen.getByRole('region', { name: 'Your questions' })
    const item = list.querySelector('[data-ask-item][data-open="true"]') as HTMLElement
    expect(item).not.toBeNull()
    expect(item.querySelector('[data-question]')).toHaveTextContent('Who owns the invoice export? And its retries?')
    const state = (m: string) => item.querySelector(`[data-ask-recipient="${m}"]`)?.getAttribute('data-status')
    expect(state('bob')).toBe('pending')
    expect(state('carol')).toBe('pending')
    await flush(3_000)
    expect(state('bob')).toBe('acked')
    expect(state('carol')).toBe('acked')
    expect(within(item).getAllByText('Acknowledged')).toHaveLength(2)
    await flush(3_000)
    expect(state('bob')).toBe('answered')
    const answer = item.querySelector('[data-ask-recipient="bob"] [data-answer]') as HTMLElement
    expect(answer.textContent).toBe('The export job is jobs/export_invoices.\nRetries are set in config/jobs.yaml: three attempts, backoff from 30 s.')
    expect(item.querySelector('[data-ask-recipient="carol"] [data-answer]')).toBeNull()
  })

  it('reads an open question every 3 s, a closed one every 30 s, and none while the tab is hidden', async () => {
    const s = server({ now: () => t })
    renderWithClient(<App />)
    await flush(20)
    await flush(20)
    const panel = screen.getByRole('region', { name: 'Ask the team' })
    fireEvent.click(chip('carol'))
    fireEvent.change(within(panel).getByLabelText('Question'), { target: { value: 'Still there?' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Send' }))
    await flush(20)
    await flush(20)
    const id = screen.getByRole('region', { name: 'Your questions' }).querySelector('[data-ask-item][data-open="true"]')!.getAttribute('data-ask-item')!
    const reads = () => s.gets(`/api/requests/${id}`)
    // Open: every 3 s (carol acknowledges and never answers).
    let n = reads()
    await flush(9_000)
    expect(reads() - n).toBe(3)
    // Closed: every 30 s while carol may still answer.
    fireEvent.click(screen.getByRole('region', { name: 'Your questions' }).querySelector(`[data-ask-item="${id}"] button`)!)
    await flush(20)
    n = reads()
    await flush(29_000)
    expect(reads()).toBe(n)
    await flush(1_100)
    expect(reads()).toBe(n + 1)
    // Hidden: nothing.
    act(() => setHidden(true))
    await flush(10)
    n = reads()
    await flush(90_000)
    expect(reads()).toBe(n)
  })
})
