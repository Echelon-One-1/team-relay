// M11 §6: guided joining. Accepting an invitation opens the team's Join checklist: the setup
// command with a copy button, seven steps that tick as the viewer's Mac reports in (read every
// 5 s while the page is visible), and the boundaries to accept, with what changed since the
// viewer's last acceptance marked new. The team page shows a banner while the viewer has not
// accepted the current boundaries; the Members panel shows each member's progress; an owner
// copies an invite message after inviting someone. The console server is the dev mock
// (src/mock/relay.ts), with every call recorded.

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setConsoleKey } from '@/api/key'
import { setTransport } from '@/api/client'
import { App } from '@/App'
import { inviteMessage } from '@/lib/setup'
import { MockRelay, mockStatus } from '@/mock/relay'
import { renderWithClient, setHidden } from './render'

const KEY = 's3tup-s3tup-s3tup-s3tup-s3tup-s3'
const COMMAND = 'curl -fsSL https://relay.example.com/setup | bash'

type Call = { method: string; path: string; team: string | null; body: unknown }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function server(opts: { override?: (c: Call) => Response | null; relay?: MockRelay } = {}) {
  const relay = opts.relay ?? new MockRelay()
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
  return { relay, calls, count: (p: string) => calls.filter((c) => c.method === 'GET' && c.path === p).length }
}

const setupPanel = () => screen.findByRole('region', { name: 'Set up your Mac' })
const step = (id: string) => document.querySelector(`[data-setup-step="${id}"]`) as HTMLElement
const doneOf = () => Object.fromEntries([...document.querySelectorAll('[data-setup-step]')].map((e) => [e.getAttribute('data-setup-step'), e.getAttribute('data-done') === 'true']))
const tab = (name: string) => screen.getByRole('navigation', { name: 'Pages' }).querySelector(`[data-view-tab="${name}"]`) as HTMLElement

beforeEach(() => {
  setConsoleKey(KEY)
  window.history.replaceState(null, '', '/')
  window.localStorage.clear()
  setHidden(false)
})

afterEach(() => {
  setHidden(false)
})

describe('the Join checklist (M11 §6)', () => {
  it('accepting an invitation opens that team on its Join checklist', async () => {
    const s = server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const switcher = await waitFor(() => {
      const el = document.querySelector('[data-team-switcher]') as HTMLElement
      expect(el).toHaveTextContent('Demo')
      return el
    })
    await user.click(switcher)
    const inv = (await screen.findByRole('dialog', { name: 'Your teams' })).querySelector('[data-invitation="ops"]') as HTMLElement
    await user.click(within(inv).getByRole('button', { name: 'Accept' }))
    const panel = await setupPanel()
    expect(window.location.pathname).toBe('/join')
    expect(tab('join')).toHaveAttribute('aria-current', 'page')
    await waitFor(() => expect(s.calls.some((c) => c.path === '/api/members-status' && c.team === 'ops')).toBe(true))
    // A new member: nothing has reported yet, and nothing is marked new before a first acceptance.
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Accept version 1' })).toBeEnabled())
    expect(doneOf()).toEqual({ setup: false, claude: false, answering: false, folders: false, drive: false, boundaries: false, self_test: false })
    expect(within(step('setup')).getByText('Copy the command above and run it in Terminal on your Mac.')).toBeInTheDocument()
    expect(panel.querySelectorAll('[data-new]')).toHaveLength(0)
    expect(within(step('boundaries')).getByText(/example-ops/)).toBeInTheDocument()
  })

  it('shows the setup command with a copy button, and the viewer progress', async () => {
    window.history.replaceState(null, '', '/join')
    server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const panel = await setupPanel()
    const command = await within(panel).findByText(COMMAND)
    expect(command.closest('[data-command]')).not.toBeNull()
    await user.click(within(panel).getByRole('button', { name: 'Copy setup command' }))
    expect(await navigator.clipboard.readText()).toBe(COMMAND)
    await waitFor(() => expect(within(panel).getByText('5 of 7 done')).toBeInTheDocument())
    expect(doneOf()).toEqual({ setup: true, claude: true, answering: true, folders: true, drive: false, boundaries: false, self_test: true })
    expect(within(step('drive')).getByText('Run the setup command again and connect Google Drive when it asks.')).toBeInTheDocument()
    // Step 6: the boundaries, with what was added after version 1 (members' own folders) marked new.
    const accept = within(step('boundaries'))
    expect(accept.getByText(/Example Co: the orders and payments services/)).toBeInTheDocument()
    expect(accept.getByText('example-org').closest('li')!.querySelector('[data-new]')).toBeNull()
    expect(accept.getByText('Example Team Drive').closest('li')!.querySelector('[data-new]')).toBeNull()
    expect(accept.getByText('You may add folders of your own').closest('li')!.querySelector('[data-new]')).not.toBeNull()
    expect(accept.getByText(/You accepted version 1/)).toBeInTheDocument()
    expect(tab('join')).toHaveTextContent('Setup5/7')
  })

  it('the copy falls back to a selected text box when the clipboard refuses', async () => {
    window.history.replaceState(null, '', '/join')
    server()
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new DOMException('no', 'NotAllowedError'))
    renderWithClient(<App />)
    const panel = await setupPanel()
    await within(panel).findByText(COMMAND)
    await user.click(within(panel).getByRole('button', { name: 'Copy setup command' }))
    const box = await within(panel).findByRole('textbox', { name: 'setup command' })
    expect(box).toHaveValue(COMMAND)
    expect(box).toHaveAttribute('readonly')
    expect(document.activeElement).toBe(box)
  })

  it('the viewer accepts the boundaries for themselves; step 6 ticks and the banner goes', async () => {
    const s = server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const banner = await screen.findByRole('region', { name: 'Boundaries to accept' })
    expect(banner).toHaveTextContent("The team's boundaries changed.")
    await user.click(within(banner).getByRole('button', { name: 'Review and accept' }))
    const panel = await setupPanel()
    expect(window.location.pathname).toBe('/join')
    await user.click(await within(panel).findByRole('button', { name: 'Accept version 2' }))
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Accepted version 2' })).toBeDisabled())
    expect(s.calls.filter((c) => c.method === 'PUT')).toEqual([{ method: 'PUT', path: '/api/acceptance', team: 'demo', body: { version: 2 } }])
    expect(doneOf().boundaries).toBe(true)
    await waitFor(() => expect(within(panel).getByText('6 of 7 done')).toBeInTheDocument())
    await user.click(tab('team'))
    expect(window.location.pathname).toBe('/')
    await screen.findByRole('region', { name: 'Members' })
    expect(screen.queryByRole('region', { name: 'Boundaries to accept' })).toBeNull()
  })

  it('boundaries that changed meanwhile: says so, and shows the latest to accept', async () => {
    window.history.replaceState(null, '', '/join')
    const s = server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const panel = await setupPanel()
    const button = await within(panel).findByRole('button', { name: 'Accept version 2' })
    s.relay.setBoundariesAs('demo', 'bob', {
      topic: 'Example Co: payments only.',
      github_orgs: ['example-org', 'payments-org'],
      drives: [],
      member_folders: false,
    })
    await user.click(button)
    expect(await within(panel).findByRole('alert')).toHaveTextContent('The boundaries changed while you were reading. Read them again below, then accept.')
    await within(panel).findByRole('button', { name: 'Accept version 3' })
    expect(within(step('boundaries')).getByText('payments-org').closest('li')!.querySelector('[data-new]')).not.toBeNull()
    expect(within(step('boundaries')).getByText('No folders of your own')).toBeInTheDocument()
  })

  it('all seven ticked: "You\'re set up", with a link to Ask', async () => {
    window.history.replaceState(null, '', '/join')
    const s = server()
    s.relay.setMemberStatus('alice', mockStatus(Date.now(), {}), true)
    const user = userEvent.setup()
    renderWithClient(<App />)
    const panel = await setupPanel()
    await user.click(await within(panel).findByRole('button', { name: 'Accept version 2' }))
    const done = await within(panel).findByText(/You're set up/)
    expect(within(panel).getByText('7 of 7 done')).toBeInTheDocument()
    await user.click(within(done.closest('[data-setup-complete]') as HTMLElement).getByRole('button', { name: 'Ask the team' }))
    expect(await screen.findByRole('region', { name: 'Ask the team' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/ask')
    expect(tab('join')).toHaveTextContent(/^Setup$/)
  })

  it('a relay without guided setup (404): says so, ticks nothing, shows no banner', async () => {
    window.history.replaceState(null, '', '/join')
    server({ override: (c) => (c.path === '/api/members-status' || c.path === '/api/acceptance' ? json({ error: 'not_found' }, 404) : null) })
    renderWithClient(<App />)
    const panel = await setupPanel()
    expect(await within(panel).findByText(/This relay does not report setup progress yet/)).toBeInTheDocument()
    expect(within(panel).queryByText(/of 7 done/)).toBeNull()
    fireEvent.click(tab('team'))
    await screen.findByRole('region', { name: 'Members' })
    expect(screen.queryByRole('region', { name: 'Boundaries to accept' })).toBeNull()
  })
})

describe('live ticks (M11 §6: every 5 s while the page is visible)', () => {
  async function flush(ms = 0) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  it('a step ticks on the next read; nothing is read while the tab is hidden', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    window.history.replaceState(null, '', '/join')
    const s = server()
    renderWithClient(<App />)
    await flush(50)
    await flush(50)
    expect(doneOf().drive).toBe(false)
    const before = s.count('/api/members-status')
    s.relay.setMemberStatus('alice', mockStatus(Date.now(), {}), true)
    await flush(5_000)
    expect(s.count('/api/members-status')).toBeGreaterThan(before)
    expect(doneOf().drive).toBe(true)
    expect(screen.getByText('6 of 7 done')).toBeInTheDocument()

    act(() => setHidden(true))
    await flush(10)
    const hidden = s.count('/api/members-status')
    const acceptance = s.count('/api/acceptance')
    await flush(30_000)
    expect(s.count('/api/members-status')).toBe(hidden)
    expect(s.count('/api/acceptance')).toBe(acceptance)
    act(() => setHidden(false))
    await flush(5_100)
    expect(s.count('/api/members-status')).toBeGreaterThan(hidden)
  })
})

describe('the Members panel and the invite message (M11 §6)', () => {
  it("shows each member's progress and whether they answer now", async () => {
    server()
    renderWithClient(<App />)
    const panel = await screen.findByRole('region', { name: 'Members' })
    const row = (m: string) => panel.querySelector(`[data-member="${m}"]`) as HTMLElement
    await waitFor(() => expect(row('alice').querySelector('[data-setup-progress]')).not.toBeNull())
    expect(row('alice').querySelector('[data-setup-progress]')).toHaveTextContent('5 of 7 set up')
    expect(row('alice').querySelector('[data-setup-progress]')).toHaveAttribute('data-answering', 'true')
    expect(row('bob').querySelector('[data-setup-progress]')).toHaveTextContent('7 of 7 set up')
    expect(row('carol').querySelector('[data-setup-progress]')).toHaveTextContent('0 of 7 set up')
    expect(row('carol').querySelector('[data-setup-progress]')).toHaveAttribute('data-answering', 'false')
    // An invitation has no progress yet.
    expect(row('dana').querySelector('[data-setup-progress]')).toBeNull()
  })

  it('after inviting someone, an owner copies the invite message; a refused clipboard shows it to copy', async () => {
    server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const panel = await screen.findByRole('region', { name: 'Members' })
    const form = await within(panel).findByRole('form', { name: 'Invite a member' })
    await user.type(within(form).getByLabelText('Google email'), 'erin@example.com')
    await user.click(within(form).getByRole('button', { name: 'Invite' }))
    await within(form).findByText(/Invited erin\. Send them the invite message/)
    const expected = inviteMessage('Demo', 'https://relay.example.com')
    expect(expected).toContain('Open the link, accept the invitation, then follow the checklist.')
    await user.click(within(form).getByRole('button', { name: 'Copy invite message' }))
    expect(await navigator.clipboard.readText()).toBe(expected)

    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new DOMException('no', 'NotAllowedError'))
    await user.click(within(form).getByRole('button', { name: 'Copy invite message' }))
    const box = await within(form).findByRole('textbox', { name: 'invite message' })
    expect(box).toHaveValue(expected)
    // The open invitations offer it too.
    expect(within(panel.querySelector('[data-member="dana"]') as HTMLElement).getByRole('button', { name: 'Copy invite message' })).toBeInTheDocument()
  })

  it('a member (not an owner) has the Setup page too, and no invite messages', async () => {
    const s = server()
    s.relay.role = 'member'
    const user = userEvent.setup()
    renderWithClient(<App />)
    const panel = await screen.findByRole('region', { name: 'Members' })
    await waitFor(() => expect(panel.querySelector('[data-setup-progress]')).not.toBeNull())
    expect(within(panel).queryByRole('button', { name: 'Copy invite message' })).toBeNull()
    await user.click(tab('join'))
    expect(await setupPanel()).toBeInTheDocument()
    expect(window.location.pathname).toBe('/join')
  })
})
