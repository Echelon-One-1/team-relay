// M11 §6 and "Simpler joining": guided joining. Accepting an invitation opens the team's Setup
// page: two plain steps (set up your Mac, accept the team's topic) that tick as the viewer's Mac
// reports in (read every 5 s while the page is visible), and below them "Ask the team", always
// there and never a step. Inside the first, only what is not done shows, one sentence each; the
// second shows the topic and Accept (an acceptance of an earlier version holds: the topic widens
// nothing). The team page shows a banner when a joined viewer has not accepted; the Members panel
// shows each member's progress ("set up", or n of 2) and, to owners only, how many folders each
// chose ("3 folders"); an owner copies an invite message after inviting someone. The console
// server is the dev mock (src/mock/relay.ts), with every call recorded.

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setConsoleKey } from '@/api/key'
import { setTransport } from '@/api/client'
import { App } from '@/App'
import { BACKGROUND_FAILED_TEXT, BACKGROUND_TEXT, FINISHED_TEXT, FOLDERS_HINT, NO_CHOOSER_TEXT, PREVIOUS_TEXT, resetSetupFinished } from '@/components/console/local-setup'
import { FOLDERS_TODO, FOLDERS_UNREADABLE_TODO, inviteMessage } from '@/lib/setup'
import { MockRelay, mockStatus } from '@/mock/relay'
import { renderWithClient, setHidden } from './render'

const KEY = 's3tup-s3tup-s3tup-s3tup-s3tup-s3'
const LINE = 'curl -fsSL https://relay.example.com/setup | bash'

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

const setupPanel = () => screen.findByRole('region', { name: 'Your setup' })
const step = (id: string) => document.querySelector(`[data-setup-step="${id}"]`) as HTMLElement
const doneOf = () => Object.fromEntries([...document.querySelectorAll('[data-setup-step]')].map((e) => [e.getAttribute('data-setup-step'), e.getAttribute('data-done') === 'true']))
const openChecks = () => [...step('mac').querySelectorAll('[data-mac-check]')].map((e) => e.getAttribute('data-mac-check'))
const askCta = () => document.querySelector('[data-ask-cta]') as HTMLElement
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

describe('the Setup page: two plain steps, then Ask the team', () => {
  it('accepting an invitation opens that team on its Setup page', async () => {
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
    // A new member: nothing has reported yet, and nothing is accepted.
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Accept' })).toBeEnabled())
    expect(doneOf()).toEqual({ mac: false, accept: false })
    expect([...panel.querySelectorAll('[data-setup-step] h3')].map((h) => h.firstChild?.textContent)).toEqual([
      'Set up your Mac',
      "Accept the team's topic",
    ])
    expect(within(step('mac')).getByText('Open Terminal (press Cmd+Space, type Terminal, press Enter). Paste this line, press Enter and answer its questions.')).toBeInTheDocument()
    expect(within(step('mac')).getByRole('button', { name: 'Copy setup line' })).toBeInTheDocument()
    // Nothing reported yet: no list of technical checks.
    expect(openChecks()).toEqual([])
    expect(within(step('accept')).getByText(/Operations at Example Co/)).toBeInTheDocument()
    expect(step('accept').textContent).not.toMatch(/github|drive|repositor|folders of your own/i)
    expect(within(askCta()).getByRole('button', { name: 'Ask the team' })).toBeInTheDocument()
  })

  it('shows the setup line with a big Copy button, only what is not done on the Mac, and the progress', async () => {
    window.history.replaceState(null, '', '/join')
    server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const panel = await setupPanel()
    const line = await within(panel).findByText(LINE)
    expect(line.closest('[data-command]')).not.toBeNull()
    await user.click(within(panel).getByRole('button', { name: 'Copy setup line' }))
    expect(await navigator.clipboard.readText()).toBe(LINE)
    // alice's Mac: everything but a folder (it reported none chosen); she has not accepted yet.
    await waitFor(() => expect(within(panel).getByText('0 of 2 done')).toBeInTheDocument())
    expect(doneOf()).toEqual({ mac: false, accept: false })
    expect(openChecks()).toEqual(['folders'])
    expect(within(step('mac')).getByText(FOLDERS_TODO)).toBeInTheDocument()
    expect(step('mac').textContent).not.toMatch(/daemon|LaunchAgent|plugin|channel|\bCLI\b|\bNode|boundaries|self-test|drive|clone|repositor/i)
    // Step 2: the topic, and Accept; no list of sources and nothing marked new.
    const accept = within(step('accept'))
    expect(accept.getByText(/Example Co: the orders and payments services/)).toBeInTheDocument()
    expect(accept.queryByRole('list')).toBeNull()
    expect(step('accept').querySelector('[data-new]')).toBeNull()
    expect(tab('join')).toHaveTextContent('Setup0/2')
  })

  it("the viewer's Mac can't read its folders settings: the folders check says how to see why and fix it", async () => {
    window.history.replaceState(null, '', '/join')
    const s = server()
    s.relay.setMemberStatus('alice', mockStatus(Date.now(), {}), true, undefined, 0, false)
    renderWithClient(<App />)
    await setupPanel()
    await waitFor(() => expect(openChecks()).toEqual(['folders']))
    expect(within(step('mac')).getByText(FOLDERS_UNREADABLE_TODO)).toBeInTheDocument()
    expect(within(step('mac')).queryByText(FOLDERS_TODO)).toBeNull()
  })

  it('the copy falls back to a selected text box when the clipboard refuses', async () => {
    window.history.replaceState(null, '', '/join')
    server()
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new DOMException('no', 'NotAllowedError'))
    renderWithClient(<App />)
    const panel = await setupPanel()
    await within(panel).findByText(LINE)
    await user.click(within(panel).getByRole('button', { name: 'Copy setup line' }))
    const box = await within(panel).findByRole('textbox', { name: 'setup line' })
    expect(box).toHaveValue(LINE)
    expect(box).toHaveAttribute('readonly')
    expect(document.activeElement).toBe(box)
  })

  it("the viewer accepts the team's topic for themselves; step 2 ticks and the banner goes", async () => {
    // alice's Mac has reported in, and she accepted version 5 of an earlier team under the same id
    // (the team is at version 2): not accepted, so the banner asks her.
    let accepted = 5
    const s = server({
      override: (c) => {
        if (c.path !== '/api/acceptance') return null
        if (c.method === 'PUT') accepted = (c.body as { version: number }).version
        return json({ version: accepted, accepted_at: '2026-11-13T10:00:00Z' })
      },
    })
    s.relay.setMemberStatus('alice', mockStatus(Date.now(), {}), true, undefined, 2)
    const user = userEvent.setup()
    renderWithClient(<App />)
    const banner = await screen.findByRole('region', { name: "Accept the team's topic" })
    expect(banner).toHaveTextContent("Accept the team's topic, so your Mac can answer teammates.")
    await user.click(within(banner).getByRole('button', { name: 'Review and accept' }))
    const panel = await setupPanel()
    expect(window.location.pathname).toBe('/join')
    await user.click(await within(panel).findByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Accepted' })).toBeDisabled())
    expect(s.calls.filter((c) => c.method === 'PUT')).toEqual([{ method: 'PUT', path: '/api/acceptance', team: 'demo', body: { version: 2 } }])
    expect(doneOf().accept).toBe(true)
    await waitFor(() => expect(within(panel).getByText('2 of 2 done')).toBeInTheDocument())
    await user.click(tab('team'))
    // The team view's own path (docs/SIGNIN-PAGE.md: / is the sign-in page on the hosted address).
    expect(window.location.pathname).toBe('/team')
    await screen.findByRole('region', { name: 'Members' })
    expect(screen.queryByRole('region', { name: "Accept the team's topic" })).toBeNull()
  })

  it('the topic changed meanwhile: says so and shows the latest to accept; once accepted, a later topic needs no new acceptance', async () => {
    window.history.replaceState(null, '', '/join')
    const s = server()
    const user = userEvent.setup()
    const { client } = renderWithClient(<App />)
    const panel = await setupPanel()
    const button = await within(panel).findByRole('button', { name: 'Accept' })
    expect(button).toHaveAttribute('data-accept-version', '2')
    s.relay.setBoundariesAs('demo', 'bob', { topic: 'Example Co: payments only.' })
    await user.click(button)
    expect(await within(panel).findByRole('alert')).toHaveTextContent(/changed while you were reading/)
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Accept' })).toHaveAttribute('data-accept-version', '3'))
    expect(within(step('accept')).getByText('Example Co: payments only.')).toBeInTheDocument()
    await user.click(within(panel).getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Accepted' })).toBeDisabled())
    // Another change: her acceptance of version 3 holds at version 4.
    s.relay.setBoundariesAs('demo', 'bob', { topic: 'Example Co: payments and orders.' })
    // The boundaries are read again (as on the page's next tick).
    await act(() => client.invalidateQueries())
    await waitFor(() => expect(within(step('accept')).getByText('Example Co: payments and orders.')).toBeInTheDocument())
    expect(within(panel).getByRole('button', { name: 'Accepted' })).toBeDisabled()
    expect(doneOf().accept).toBe(true)
  })

  it('both done: "You\'re all set", with a big button to Ask', async () => {
    window.history.replaceState(null, '', '/join')
    const s = server()
    s.relay.setMemberStatus('alice', mockStatus(Date.now(), {}), true, undefined, 3)
    const user = userEvent.setup()
    renderWithClient(<App />)
    const panel = await setupPanel()
    await user.click(await within(panel).findByRole('button', { name: 'Accept' }))
    const done = await within(panel).findByText("You're all set")
    expect(within(panel).getByText('2 of 2 done')).toBeInTheDocument()
    expect(openChecks()).toEqual([])
    await user.click(within(done.closest('[data-setup-complete]') as HTMLElement).getByRole('button', { name: 'Ask the team' }))
    expect(await screen.findByRole('region', { name: 'Ask the team' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/ask')
    expect(tab('join')).toHaveTextContent(/^Setup$/)
  })

  it('"Ask the team" is always there below the steps, never a step; asking or not changes nothing', async () => {
    window.history.replaceState(null, '', '/join')
    const s = server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const panel = await setupPanel()
    await waitFor(() => expect(within(panel).getByText('0 of 2 done')).toBeInTheDocument())
    expect(step('ask')).toBeNull()
    const cta = askCta()
    expect(panel.contains(cta)).toBe(true)
    expect(cta.compareDocumentPosition(step('accept')) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    expect(cta).toHaveTextContent('Ask your teammates a question at any time.')
    expect(cta).not.toHaveAttribute('data-setup-complete')
    // Whether the viewer has asked is not read for it.
    expect(s.count('/api/my-requests')).toBe(0)
    await user.click(within(cta).getByRole('button', { name: 'Ask the team' }))
    expect(window.location.pathname).toBe('/ask')
    expect(panel).not.toBeInTheDocument()
  })

  it('the pages: Ask first, then Team and Setup; the landing page is still the team', async () => {
    server()
    renderWithClient(<App />)
    await screen.findByRole('region', { name: 'Members' })
    const nav = screen.getByRole('navigation', { name: 'Pages' })
    expect([...nav.querySelectorAll('[data-view-tab]')].map((b) => b.getAttribute('data-view-tab'))).toEqual(['ask', 'team', 'join'])
    expect(tab('team')).toHaveAttribute('aria-current', 'page')
    expect(window.location.pathname).toBe('/')
  })

  it('a relay without guided setup (404): says so, ticks nothing, shows no banner', async () => {
    window.history.replaceState(null, '', '/join')
    server({ override: (c) => (c.path === '/api/members-status' || c.path === '/api/acceptance' ? json({ error: 'not_found' }, 404) : null) })
    renderWithClient(<App />)
    const panel = await setupPanel()
    expect(await within(panel).findByText(/This team can't show your progress here yet/)).toBeInTheDocument()
    expect(within(panel).queryByText(/of 2 done/)).toBeNull()
    // Asking needs no setup progress: still there.
    expect(within(askCta()).getByRole('button', { name: 'Ask the team' })).toBeInTheDocument()
    fireEvent.click(tab('team'))
    await screen.findByRole('region', { name: 'Members' })
    expect(screen.queryByRole('region', { name: "Accept the team's topic" })).toBeNull()
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
    expect(doneOf().mac).toBe(false)
    const before = s.count('/api/members-status')
    s.relay.setMemberStatus('alice', mockStatus(Date.now(), {}), true, undefined, 3)
    await flush(5_000)
    expect(s.count('/api/members-status')).toBeGreaterThan(before)
    expect(doneOf().mac).toBe(true)
    expect(screen.getByText('1 of 2 done')).toBeInTheDocument()

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
  it('an owner sees how many folders each member chose ("1 folder", "0 folders"), never which', async () => {
    const s = server()
    s.relay.setMemberStatus('bob', mockStatus(Date.now(), {}), true, 2, 1)
    renderWithClient(<App />)
    const panel = await screen.findByRole('region', { name: 'Members' })
    const row = (m: string) => panel.querySelector(`[data-member="${m}"]`) as HTMLElement
    const count = (m: string) => row(m).querySelector('[data-folder-count]')
    await waitFor(() => expect(count('bob')).not.toBeNull())
    expect(count('bob')).toHaveAttribute('data-folder-count', '1')
    expect(count('bob')).toHaveTextContent('1 folder')
    expect(count('bob')!.textContent).not.toMatch(/folders/)
    expect(count('alice')).toHaveTextContent('0 folders')
    // carol's Mac can't use her folders file: "folders unreadable", not "0 folders".
    expect(count('carol')).toBeNull()
    expect(row('carol').querySelector('[data-folders-unreadable]')).toHaveTextContent('folders unreadable')
    expect(row('bob').querySelector('[data-folders-unreadable]')).toBeNull()
    // Never a folder's name or path, and nothing about sources.
    expect(panel.textContent).not.toMatch(/\/|~|can't find|clone|drive|repo/i)
  })

  it("a member sees no one else's folder count (the relay gives them only their own)", async () => {
    const s = server()
    s.relay.role = 'member'
    s.relay.setMemberStatus('bob', mockStatus(Date.now(), {}), true, 2, 4)
    renderWithClient(<App />)
    const panel = await screen.findByRole('region', { name: 'Members' })
    await waitFor(() => expect(panel.querySelector('[data-setup-progress]')).not.toBeNull())
    expect(panel.querySelector('[data-folder-count]')).toBeNull()
    expect(panel.querySelector('[data-folders-unreadable]')).toBeNull()
    expect(panel.textContent).not.toMatch(/\bfolders?\b/)
    // The relay gives a member only their own count (src/mock/relay.ts plays that rule).
    const statuses = (await (await s.relay.handle('api/members-status', { headers: { 'X-Relay-Team': 'demo' } })).json()) as {
      members: Array<{ member: string; folder_count: number | null }>
    }
    expect(statuses.members.find((m) => m.member === 'bob')!.folder_count).toBeNull()
    expect(statuses.members.find((m) => m.member === 'alice')!.folder_count).toBe(0)
    const ok = statuses.members as unknown as Array<{ member: string; folders_ok: boolean | null }>
    expect(ok.find((m) => m.member === 'carol')!.folders_ok).toBeNull()
    expect(ok.find((m) => m.member === 'alice')!.folders_ok).toBe(true)
  })

  it("shows each member's progress (set up, or n of 2) and whether they answer now", async () => {
    server()
    renderWithClient(<App />)
    const panel = await screen.findByRole('region', { name: 'Members' })
    const row = (m: string) => panel.querySelector(`[data-member="${m}"]`) as HTMLElement
    await waitFor(() => expect(row('alice').querySelector('[data-setup-progress]')).not.toBeNull())
    await waitFor(() => expect(row('bob').querySelector('[data-setup-progress]')).toHaveTextContent(/^set upanswering now· 3 folders$/))
    expect(row('alice').querySelector('[data-setup-progress]')).toHaveTextContent('0 of 2 set up')
    expect(row('alice').querySelector('[data-setup-progress]')).toHaveAttribute('data-answering', 'true')
    // Asking is not a step: carol has asked the team questions (the activity shows them) and is 0 of 2.
    expect(row('carol').querySelector('[data-setup-progress]')).toHaveTextContent('0 of 2 set up')
    expect(row('carol').querySelector('[data-setup-progress]')).toHaveAttribute('data-answering', 'false')
    expect(panel.textContent).not.toMatch(/of 7/)
    // An invitation has no progress yet.
    expect(row('dana').querySelector('[data-setup-progress]')).toBeNull()
  })

  it('after inviting someone, an owner copies the invite message: the link, then the same three plain steps', async () => {
    server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const panel = await screen.findByRole('region', { name: 'Members' })
    const form = await within(panel).findByRole('form', { name: 'Invite a member' })
    await user.type(within(form).getByLabelText('Google email'), 'erin@example.com')
    await user.click(within(form).getByRole('button', { name: 'Invite' }))
    await within(form).findByText(/Invited erin\. Send them the invite message/)
    const expected = inviteMessage('Demo', 'https://relay.example.com')
    expect(expected.split('\n').slice(2, 5)).toEqual(['https://relay.example.com/', '', 'Open the link and accept the invitation. Then, on your Mac:'])
    expect(expected).toContain(LINE)
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

// /team-relay:setup: on the member's own Mac, the console server started by the setup tool answers
// /api/local/*: the Setup view then shows the local steps (signed in, accept, folders, background
// answering, Done). Folders are added only through the Mac's folder chooser (the server opens it).
describe('the local Setup page of /team-relay:setup', () => {
  type Local = { folders: string[]; previous?: Array<{ path: string; kind: 'repo_root' | 'own_folder' }>; chooser: boolean; installed: boolean; choice?: unknown; available?: boolean; reason?: string; failInstall?: boolean }
  function localServer(local: Local) {
    return server({
      override: (c) => {
        if (!c.path.startsWith('/api/local/')) return null
        if (c.path === '/api/local/setup') {
          return json({
            signed_in: { member: 'alice', team: 'demo', email: 'alice@example.com' },
            folders: local.folders,
            previous: local.previous ?? [],
            chooser: local.chooser,
            background: { installed: local.installed, available: local.available ?? true, ...(local.reason ? { reason: local.reason } : {}) },
            limits: { max_folders: 20 },
          })
        }
        if (c.path === '/api/local/folders/choose') {
          const out = local.choice as { folders: string[] }
          local.folders = out.folders
          return json(out)
        }
        if (c.path === '/api/local/folders/remove') {
          local.folders = local.folders.filter((f) => f !== (c.body as { path: string }).path)
          return json({ folders: local.folders })
        }
        if (c.path === '/api/local/background') {
          if (local.failInstall && (c.body as { on: boolean }).on) return json({ error: 'background_failed', detail: 'launchctl did not load it.' }, 500)
          local.installed = (c.body as { on: boolean }).on
          return json({ installed: local.installed })
        }
        if (c.path === '/api/local/done') return json({ ok: true })
        return json({ error: 'not_found' }, 404)
      },
    })
  }
  const localPanel = () => screen.findByRole('region', { name: 'Set up this Mac' })
  const states = () => Object.fromEntries([...document.querySelectorAll('[data-local-step]')].map((e) => [e.querySelector('h3')!.firstChild!.textContent, e.getAttribute('data-state')]))
  const writes = (s: ReturnType<typeof server>) => s.calls.filter((c) => c.method !== 'GET' && c.path.startsWith('/api/local/')).map((c) => [c.method, c.path, c.body])

  afterEach(() => resetSetupFinished())

  it('shows each step with its state; Add folder and Remove call the routes; background on by default; Done', async () => {
    window.history.replaceState(null, '', '/join')
    const local: Local = {
      folders: ['~/code/example-org'],
      chooser: true,
      installed: false,
      choice: { added: ['~/work/notes'], refused: [{ path: '~', reason: 'it is your home directory' }], cancelled: false, folders: ['~/code/example-org', '~/work/notes'] },
    }
    const s = localServer(local)
    const user = userEvent.setup()
    renderWithClient(<App />)
    const panel = await localPanel()
    expect(within(panel).getByText('alice@example.com')).toBeInTheDocument()
    await waitFor(() => expect(states()).toEqual({
      'Signed in': 'done',
      "Accept the team's topic": 'todo',
      'Folders your Claude answers from': 'done',
      'Answer in the background': 'todo',
    }))
    // Not the Terminal page.
    expect(screen.queryByRole('region', { name: 'Your setup' })).toBeNull()
    expect(within(panel).getByText(FOLDERS_HINT)).toBeInTheDocument()
    expect(within(panel).getByText(BACKGROUND_TEXT)).toBeInTheDocument()

    await user.click(within(panel).getByRole('button', { name: 'Add folder' }))
    await within(panel).findByText('~/work/notes')
    expect(within(panel).getByText(/Not added:/).closest('li')).toHaveTextContent('Not added: ~ (it is your home directory).')
    await user.click(within(panel).getByRole('button', { name: 'Remove ~/code/example-org' }))
    await waitFor(() => expect(within(panel).queryByText('~/code/example-org')).toBeNull())

    const sw = within(panel).getByRole('switch', { name: 'Background answering' })
    expect(sw).toBeChecked()
    // Nothing installed before Done.
    expect(writes(s)).toEqual([
      ['POST', '/api/local/folders/choose', {}],
      ['POST', '/api/local/folders/remove', { path: '~/code/example-org' }],
    ])
    await user.click(within(panel).getByRole('button', { name: 'Done' }))
    expect(await screen.findByText(FINISHED_TEXT)).toBeInTheDocument()
    expect(FINISHED_TEXT).toBe('All set. Go back to Claude.')
    expect(writes(s).slice(2)).toEqual([
      ['PUT', '/api/local/background', { on: true }],
      ['POST', '/api/local/done', {}],
    ])
    // No route is ever given a folder to add.
    expect(s.calls.filter((c) => c.path === '/api/local/folders/choose').every((c) => JSON.stringify(c.body) === '{}')).toBe(true)
  })

  it('folders chosen before one folder list are listed as plain text, until added again with the chooser', async () => {
    window.history.replaceState(null, '', '/join')
    const local: Local = {
      folders: ['~/code/example-org'],
      previous: [
        { path: '~/code', kind: 'repo_root' },
        { path: '~/notes', kind: 'own_folder' },
        // Already in the list: not shown.
        { path: '~/code/example-org', kind: 'own_folder' },
      ],
      chooser: true,
      installed: true,
      choice: { added: ['~/notes'], refused: [], cancelled: false, folders: ['~/code/example-org', '~/notes'] },
    }
    const s = localServer(local)
    const user = userEvent.setup()
    renderWithClient(<App />)
    const panel = await localPanel()
    const block = await waitFor(() => {
      const el = panel.querySelector('[data-previous]')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    expect(PREVIOUS_TEXT).toBe('Folders you chose before this change — add the ones you still want with Add folder')
    expect(within(block).getByText(PREVIOUS_TEXT)).toBeInTheDocument()
    const items = within(block).getByRole('list', { name: 'Folders you chose before' })
    expect([...items.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['~/code (repository root)', '~/notes (your own folder)'])
    // No way to add an old path directly: no button or link in the list.
    expect(within(items).queryByRole('button')).toBeNull()
    expect(within(items).queryByRole('link')).toBeNull()
    // Added again through the Mac's chooser (which sends no path): it leaves the old list.
    await user.click(within(panel).getByRole('button', { name: 'Add folder' }))
    await waitFor(() => expect(panel.querySelector('[data-previous-folder="~/notes"]')).toBeNull())
    expect(panel.querySelector('[data-previous-folder="~/code"]')).not.toBeNull()
    expect(s.calls.filter((c) => c.path === '/api/local/folders/choose').map((c) => c.body)).toEqual([{}])
  })

  it('nothing chosen before: no list of earlier folders', async () => {
    window.history.replaceState(null, '', '/join')
    localServer({ folders: ['~/code/example-org'], chooser: true, installed: true })
    renderWithClient(<App />)
    const panel = await localPanel()
    await within(panel).findByText('~/code/example-org')
    expect(panel.querySelector('[data-previous]')).toBeNull()
    expect(panel.textContent).not.toContain(PREVIOUS_TEXT)
  })

  it('turning background answering off applies at once, and Done then changes nothing more', async () => {
    window.history.replaceState(null, '', '/join')
    const s = localServer({ folders: [], chooser: true, installed: false })
    const user = userEvent.setup()
    renderWithClient(<App />)
    const panel = await localPanel()
    await waitFor(() => expect(states()['Folders your Claude answers from']).toBe('todo'))
    expect(within(panel).getByText('No folders yet.')).toBeInTheDocument()
    await user.click(within(panel).getByRole('switch', { name: 'Background answering' }))
    await waitFor(() => expect(writes(s)).toEqual([['PUT', '/api/local/background', { on: false }]]))
    expect(states()['Answer in the background']).toBe('not_needed')
    await user.click(within(panel).getByRole('button', { name: 'Done' }))
    await screen.findByText(FINISHED_TEXT)
    expect(writes(s)).toEqual([
      ['PUT', '/api/local/background', { on: false }],
      ['POST', '/api/local/done', {}],
    ])
  })

  it('background answering cannot run here: the switch is off and disabled with the reason, and Done finishes without it', async () => {
    window.history.replaceState(null, '', '/join')
    const reason = 'Background answering needs Claude Code, which was not found on this Mac.'
    const s = localServer({ folders: [], chooser: true, installed: false, available: false, reason })
    const user = userEvent.setup()
    renderWithClient(<App />)
    const panel = await localPanel()
    const sw = within(panel).getByRole('switch', { name: 'Background answering' })
    expect(sw).not.toBeChecked()
    expect(sw).toBeDisabled()
    expect(within(panel).getByText(reason)).toBeInTheDocument()
    await waitFor(() => expect(states()['Answer in the background']).toBe('not_needed'))
    await user.click(within(panel).getByRole('button', { name: 'Done' }))
    expect(await screen.findByText(FINISHED_TEXT)).toBeInTheDocument()
    expect(writes(s)).toEqual([['POST', '/api/local/done', {}]])
  })

  it('installed but no longer able to run here: the switch shows on and can still be turned off', async () => {
    window.history.replaceState(null, '', '/join')
    const reason = 'Background answering needs Claude Code, which was not found on this Mac.'
    const s = localServer({ folders: [], chooser: true, installed: true, available: false, reason })
    const user = userEvent.setup()
    renderWithClient(<App />)
    const panel = await localPanel()
    const sw = within(panel).getByRole('switch', { name: 'Background answering' })
    expect(sw).toBeChecked()
    expect(sw).toBeEnabled()
    expect(within(panel).getByText(reason)).toBeInTheDocument()
    await user.click(sw)
    await waitFor(() => expect(writes(s)).toEqual([['PUT', '/api/local/background', { on: false }]]))
    await waitFor(() => expect(sw).not.toBeChecked())
    // Off now, and it cannot be turned on again here.
    expect(sw).toBeDisabled()
    await user.click(within(panel).getByRole('button', { name: 'Done' }))
    await screen.findByText(FINISHED_TEXT)
    expect(writes(s)).toEqual([
      ['PUT', '/api/local/background', { on: false }],
      ['POST', '/api/local/done', {}],
    ])
  })

  it('turning background answering on fails at Done: the error shows, Done tries again, and "Finish without it" finishes', async () => {
    window.history.replaceState(null, '', '/join')
    const s = localServer({ folders: [], chooser: true, installed: false, failInstall: true })
    const user = userEvent.setup()
    renderWithClient(<App />)
    const panel = await localPanel()
    expect(within(panel).queryByRole('button', { name: 'Finish without it' })).toBeNull()
    await user.click(within(panel).getByRole('button', { name: 'Done' }))
    expect(await within(panel).findByText(BACKGROUND_FAILED_TEXT)).toBeInTheDocument()
    expect(within(panel).getByText('launchctl did not load it.')).toBeInTheDocument()
    expect(within(panel).queryByText(/relay did not answer/)).toBeNull()
    expect(screen.queryByText(FINISHED_TEXT)).toBeNull()
    await user.click(within(panel).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(writes(s)).toHaveLength(2))
    expect(screen.queryByText(FINISHED_TEXT)).toBeNull()
    await user.click(within(panel).getByRole('button', { name: 'Finish without it' }))
    expect(await screen.findByText(FINISHED_TEXT)).toBeInTheDocument()
    expect(writes(s)).toEqual([
      ['PUT', '/api/local/background', { on: true }],
      ['PUT', '/api/local/background', { on: true }],
      ['POST', '/api/local/done', {}],
    ])
  })

  it('no folder chooser on this computer: says how to add folders instead', async () => {
    window.history.replaceState(null, '', '/join')
    localServer({ folders: [], chooser: false, installed: true })
    renderWithClient(<App />)
    const panel = await localPanel()
    expect(within(panel).getByText(NO_CHOOSER_TEXT)).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'Add folder' })).toBeNull()
    await waitFor(() => expect(states()['Answer in the background']).toBe('done'))
  })

  it('a failed load says so and tries again', async () => {
    window.history.replaceState(null, '', '/join')
    let fail = true
    server({ override: (c) => (c.path === '/api/local/setup' ? (fail ? json({ error: 'internal' }, 500) : json({ signed_in: { member: 'alice', team: 'demo', email: null }, folders: [], previous: [], chooser: true, background: { installed: false, available: true }, limits: { max_folders: 20 } })) : null) })
    const user = userEvent.setup()
    renderWithClient(<App />)
    const alert = await screen.findByText(/Your setup didn't load/)
    fail = false
    await user.click(within(alert.closest('[data-local-setup-error]') as HTMLElement).getByRole('button', { name: 'Try again' }))
    expect(await localPanel()).toBeInTheDocument()
  })

  it('a console without the setup routes (404) shows the usual Setup page, which mentions /team-relay:setup', async () => {
    window.history.replaceState(null, '', '/join')
    server()
    renderWithClient(<App />)
    const panel = await setupPanel()
    expect(within(step('mac')).getByText('/team-relay:setup')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Set up this Mac' })).toBeNull()
    expect(panel).toBeInTheDocument()
  })
})
