// M6 §4: the Members panel. An owner adds by Google email with a member id suggested from its
// local part (editable), removes after a confirm step that names the person, makes and
// unmakes owners, and sees every refusal inline; a member sees names and roles only. And the
// hosted "not on this team" page, which shows no data.

import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { ChangeError, sendChange, setTransport } from '@/api/client'
import { setConsoleKey } from '@/api/key'
import type { Roster, RosterMember } from '@/api/types'
import { App } from '@/App'
import { Members } from '@/components/console/members'
import { useRoster } from '@/hooks/queries'
import { addProblem, suggestMemberId } from '@/lib/roster'
import { fixtureActivity, fixtureDirectory, fixtureJoin, fixtureMe } from '@/mock/fixtures'
import { renderWithClient } from './render'

const KEY = 'm3mb3rsm3mb3rsm3mb3rsm3mb3rsm3mb'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

type Sent = { method: string; path: string; body: unknown; headers: Record<string, string> }

/** A console server with a roster, recording every change it is sent. */
function server(initial: RosterMember[], opts: { refuse?: (s: Sent) => Response | null } = {}) {
  let members = structuredClone(initial)
  const sent: Sent[] = []
  setTransport(async (path, init) => {
    const url = new URL(path, 'http://console.invalid/')
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET') {
      const s: Sent = {
        method,
        path: url.pathname,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        headers: init?.headers as Record<string, string>,
      }
      sent.push(s)
      const refused = opts.refuse?.(s)
      if (refused) return refused
      const body = s.body as Record<string, string> | undefined
      if (method === 'POST') members.push({ member: body!.member!, emails: [body!.email!], role: 'member' })
      else if (method === 'PATCH') members = members.map((m) => (`/api/roster/${m.member}` === s.path ? { ...m, role: body!.role as 'owner' | 'member' } : m))
      else members = members.filter((m) => `/api/roster/${m.member}` !== s.path)
      return json({ ok: true }, method === 'POST' ? 201 : 200)
    }
    if (url.pathname === '/api/roster') return json({ members })
    if (url.pathname === '/api/me') return json(fixtureMe)
    if (url.pathname === '/api/join') return json(fixtureJoin)
    if (url.pathname === '/api/directory') return json(fixtureDirectory)
    if (url.pathname === '/api/activity') return json(fixtureActivity)
    return json({ error: 'not_found' }, 404)
  })
  return { sent, members: () => members }
}

const OWNER_VIEW: RosterMember[] = [
  { member: 'carol', emails: ['carol@example.com'], role: 'member' },
  { member: 'alice', emails: ['alice@example.com'], role: 'owner' },
  { member: 'bob', emails: ['bob@example.com', 'bob@example.org'], role: 'member' },
]

function Harness({ owner, me = 'alice' }: { owner: boolean; me?: string }) {
  const roster = useRoster()
  return <Members roster={roster.data} loading={roster.isPending} failed={roster.isError} me={me} owner={owner} />
}

const row = (member: string) => document.querySelector(`[data-member="${member}"]`) as HTMLElement

beforeEach(() => {
  setConsoleKey(KEY)
})

describe('Members panel: owner (M6 §4)', () => {
  it('lists owners first with their emails and a role badge', async () => {
    server(OWNER_VIEW)
    renderWithClient(<Harness owner />)
    await screen.findByText('carol@example.com')
    expect([...document.querySelectorAll('[data-member]')].map((el) => el.getAttribute('data-member'))).toEqual(['alice', 'bob', 'carol'])
    expect(row('alice')).toHaveTextContent('(you)')
    expect(within(row('alice')).getByText('Owner')).toBeInTheDocument()
    expect(row('bob')).toHaveTextContent('bob@example.com, bob@example.org')
    expect(screen.getByText('3 members, 1 owner')).toBeInTheDocument()
    // The only owner can be neither unmade nor removed.
    expect(within(row('alice')).getByRole('button', { name: 'Remove owner' })).toBeDisabled()
    expect(within(row('alice')).getByRole('button', { name: 'Remove' })).toBeDisabled()
  })

  it('adds by email with the member id suggested from the local part, and sends exactly that', async () => {
    const s = server(OWNER_VIEW)
    const user = userEvent.setup()
    renderWithClient(<Harness owner />)
    await screen.findByText('carol@example.com')
    const email = screen.getByLabelText('Google email')
    const id = screen.getByLabelText('Member id')
    await user.type(email, 'Dave.Smith+relay@Example.com')
    expect(id).toHaveValue('dave_smith')
    await user.click(screen.getByRole('button', { name: 'Invite' }))
    await screen.findByText(/Invited dave_smith\. Send them the invite message/)
    expect(s.sent).toEqual([
      expect.objectContaining({ method: 'POST', path: '/api/roster', body: { member: 'dave_smith', email: 'dave.smith+relay@example.com' } }),
    ])
    expect(s.sent[0]!.headers['Content-Type']).toBe('application/json')
    expect(s.sent[0]!.headers['X-Console-Key']).toBe(KEY)
    await waitFor(() => expect(row('dave_smith')).not.toBeNull())
    expect(email).toHaveValue('')
  })

  it('keeps an edited member id, and suggests a free one when the local part is taken', async () => {
    const s = server(OWNER_VIEW)
    const user = userEvent.setup()
    renderWithClient(<Harness owner />)
    await screen.findByText('carol@example.com')
    await user.type(screen.getByLabelText('Google email'), 'bob@elsewhere.example')
    expect(screen.getByLabelText('Member id')).toHaveValue('bob_2')
    await user.clear(screen.getByLabelText('Member id'))
    await user.type(screen.getByLabelText('Member id'), 'robert')
    await user.type(screen.getByLabelText('Google email'), 'x')
    expect(screen.getByLabelText('Member id')).toHaveValue('robert')
    await user.click(screen.getByRole('button', { name: 'Invite' }))
    await waitFor(() => expect(s.sent).toHaveLength(1))
    expect(s.sent[0]!.body).toEqual({ member: 'robert', email: 'bob@elsewhere.examplex' })
  })

  it('shows problems inline, before sending and when the relay refuses', async () => {
    const s = server(OWNER_VIEW, {
      refuse: () => json({ error: 'relay_refused', relay_status: 409, relay_error: 'conflict', detail: 'That email already belongs to a member of the team.' }, 502),
    })
    const user = userEvent.setup()
    renderWithClient(<Harness owner />)
    await screen.findByText('carol@example.com')
    await user.type(screen.getByLabelText('Google email'), 'not-an-email')
    await user.click(screen.getByRole('button', { name: 'Invite' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a Google email address.')
    expect(s.sent).toHaveLength(0)
    await user.clear(screen.getByLabelText('Google email'))
    await user.type(screen.getByLabelText('Google email'), 'CAROL@example.com')
    await user.clear(screen.getByLabelText('Member id'))
    await user.type(screen.getByLabelText('Member id'), 'carol_two')
    await user.click(screen.getByRole('button', { name: 'Invite' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That email already belongs to a member of the team.')
    expect(s.sent).toHaveLength(0)
    await user.clear(screen.getByLabelText('Google email'))
    await user.type(screen.getByLabelText('Google email'), 'dave@example.com')
    await user.click(screen.getByRole('button', { name: 'Invite' }))
    await waitFor(() => expect(s.sent).toHaveLength(1))
    expect(await screen.findByRole('alert')).toHaveTextContent('That email already belongs to a member of the team.')
  })

  it('removes only after a confirm step that names the person; Cancel sends nothing', async () => {
    const s = server(OWNER_VIEW)
    const user = userEvent.setup()
    renderWithClient(<Harness owner />)
    await screen.findByText('carol@example.com')
    await user.click(within(row('bob')).getByRole('button', { name: 'Remove' }))
    const confirm = document.querySelector('[data-confirm="bob"]') as HTMLElement
    expect(confirm).toHaveTextContent('Remove bob (bob@example.com, bob@example.org) from the team?')
    expect(confirm).toHaveTextContent('signed-in devices are signed out')
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(document.querySelector('[data-confirm="bob"]')).toBeNull()
    expect(s.sent).toHaveLength(0)

    await user.click(within(row('bob')).getByRole('button', { name: 'Remove' }))
    await user.click(screen.getByRole('button', { name: 'Remove bob' }))
    await waitFor(() => expect(s.sent).toEqual([expect.objectContaining({ method: 'DELETE', path: '/api/roster/bob', body: undefined })]))
    await waitFor(() => expect(row('bob')).toBeNull())
  })

  it('makes and unmakes owners, and shows a refusal on that row', async () => {
    const s = server(OWNER_VIEW, {
      refuse: (x) =>
        x.path === '/api/roster/carol'
          ? json({ error: 'relay_refused', relay_status: 429, relay_error: 'rate_limited' }, 502)
          : null,
    })
    const user = userEvent.setup()
    renderWithClient(<Harness owner />)
    await screen.findByText('carol@example.com')
    await user.click(within(row('bob')).getByRole('button', { name: 'Make owner' }))
    await waitFor(() => expect(within(row('bob')).getByText('Owner')).toBeInTheDocument())
    expect(s.sent[0]).toMatchObject({ method: 'PATCH', path: '/api/roster/bob', body: { role: 'owner' } })
    // Two owners now: alice can be unmade.
    await waitFor(() => expect(within(row('alice')).getByRole('button', { name: 'Remove owner' })).toBeEnabled())

    await user.click(within(row('carol')).getByRole('button', { name: 'Make owner' }))
    expect(await within(row('carol')).findByRole('alert')).toHaveTextContent('Too many member changes for now.')
    expect(within(row('bob')).queryByRole('alert')).toBeNull()
  })
})

describe('Members panel: member (M6 §4)', () => {
  it('is a read-only list of names and roles', async () => {
    server([
      { member: 'alice', emails: [null], role: 'owner' },
      { member: 'bob', emails: ['bob@example.com'], role: 'member' },
    ])
    renderWithClient(<Harness owner={false} me="bob" />)
    await screen.findByText('alice')
    expect(document.querySelector('[data-members-view]')).toHaveAttribute('data-members-view', 'member')
    expect(within(row('alice')).getByText('Owner')).toBeInTheDocument()
    expect(within(row('bob')).getByText('Member')).toBeInTheDocument()
    // The only button is the panel's own fold toggle: nothing that changes the roster.
    expect(screen.queryAllByRole('button')).toEqual([screen.getByRole('button', { name: 'Members' })])
    expect(screen.queryByLabelText('Google email')).toBeNull()
    expect(document.body).not.toHaveTextContent('@example.com')
    expect(screen.getByText(/Ask an owner to invite someone/)).toBeInTheDocument()
  })
})

describe('in the console', () => {
  it('an owner gets the Members panel with the add form and the invite hint', async () => {
    window.localStorage.clear()
    server([{ member: 'alice', emails: ['alice@example.com'], role: 'owner' }, ...OWNER_VIEW.filter((m) => m.member !== 'alice')])
    renderWithClient(<App />)
    await screen.findByLabelText('Google email')
    expect(document.querySelector('[data-invite-hint]')).not.toBeNull()
    // Below the team map and the agents, above the live activity.
    const map = document.getElementById('team-map-title')!.closest('section')!
    const members = document.getElementById('members-title')!.closest('section')!
    expect(map.compareDocumentPosition(members) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const activity = document.getElementById('activity-title')?.closest('section')
    if (activity) expect(members.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('an older console server without a roster (404) shows no Members panel', async () => {
    setTransport(async (path) => {
      const url = new URL(path, 'http://console.invalid/')
      if (url.pathname === '/api/me') return json(fixtureMe)
      if (url.pathname === '/api/join') return json(fixtureJoin)
      if (url.pathname === '/api/directory') return json(fixtureDirectory)
      if (url.pathname === '/api/activity') return json(fixtureActivity)
      return json({ error: 'not_found' }, 404)
    })
    renderWithClient(<App />)
    await waitFor(() => expect(document.querySelector('[data-agent="bob"]')).not.toBeNull())
    await act(async () => {})
    expect(document.getElementById('members-title')).toBeNull()
  })
})

describe('not on this team (M6 §4, hosted)', () => {
  it('shows who to ask, and no data at all', async () => {
    setConsoleKey(null)
    Object.defineProperty(window, 'location', { configurable: true, value: new URL('https://console.team.example/') })
    try {
      const calls: string[] = []
      setTransport(async (path) => {
        calls.push(path)
        if (path === 'api/join') return json(fixtureJoin)
        return json({ error: 'not_on_team', email: 'dana@example.com' }, 403)
      })
      renderWithClient(<App />)
      const page = await screen.findByText("You're not on this team yet")
      expect(page).toBeInTheDocument()
      expect(document.querySelector('[data-not-on-team]')).toHaveTextContent('Ask the team owner to add dana@example.com.')
      expect(document.querySelector('[data-agent]')).toBeNull()
      expect(document.getElementById('members-title')).toBeNull()
      expect(document.querySelector('[data-join]')).toBeNull()
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: new URL('http://127.0.0.1:4317/') })
    }
  })
})

describe('roster rules', () => {
  it('suggests a member id from the local part', () => {
    expect(suggestMemberId('Dave.Smith@example.com')).toBe('dave_smith')
    expect(suggestMemberId('dave+tag@example.com')).toBe('dave')
    expect(suggestMemberId('9lives@example.com')).toBe('m_9lives')
    expect(suggestMemberId('x@example.com')).toBe('x_member')
    expect(suggestMemberId('a-b--c@example.com')).toBe('a_b_c')
    expect(suggestMemberId(`${'a'.repeat(50)}@example.com`)).toHaveLength(32)
    expect(suggestMemberId('bob@example.com', ['bob', 'bob_2'])).toBe('bob_3')
    for (const e of ['Dave.Smith@example.com', '9lives@x.com', 'x@y.com', '___@y.com', 'é@y.com']) {
      expect(suggestMemberId(e)).toMatch(/^[a-z][a-z0-9_]{1,31}$/)
    }
  })

  it('checks an add as the relay would', () => {
    const roster: Roster = { members: OWNER_VIEW }
    expect(addProblem(roster, 'dave', 'dave@example.com')).toBeNull()
    expect(addProblem(roster, 'bob', 'dave@example.com')).toMatch(/already a member id/)
    expect(addProblem(roster, 'dave', 'BOB@example.org')).toMatch(/already belongs/)
    expect(addProblem(roster, 'Dave', 'dave@example.com')).toMatch(/Pick a member id like/)
    expect(addProblem(roster, 'dave', 'dave')).toMatch(/Google email/)
    const full: Roster = { members: Array.from({ length: 50 }, (_, i) => ({ member: `m${i}x`, emails: [`m${i}@example.com`], role: 'member' as const })) }
    expect(addProblem(full, 'dave', 'dave@example.com')).toMatch(/at most 50/)
  })

  it('sendChange maps a stale key to signed out and a relay 403 to owners only', async () => {
    setTransport(async () => json({ error: 'forbidden', detail: 'wrong console key' }, 403))
    const stale = await sendChange('POST', 'api/roster', {}).catch((e: unknown) => e)
    expect(stale).toBeInstanceOf(ChangeError)
    expect((stale as ChangeError).signedOut).toBe(true)
    setTransport(async () => json({ error: 'relay_refused', relay_status: 403, relay_error: 'forbidden' }, 502))
    const notOwner = (await sendChange('DELETE', 'api/roster/bob').catch((e: unknown) => e)) as ChangeError
    expect(notOwner.message).toBe('Only team owners can change members.')
    setTransport(async () => json({ error: 'relay_refused', relay_status: 409, relay_error: 'x', detail: '<b>markup</b>' }, 502))
    const markup = (await sendChange('DELETE', 'api/roster/bob').catch((e: unknown) => e)) as ChangeError
    expect(markup.message).toBe('That member id or email is already on the team.')
  })
})

describe('a refused sign-in (M5 §6, M6 §4)', () => {
  const refusing = () =>
    setTransport(async (path) => {
      const url = new URL(path, 'http://console.invalid/')
      if (url.pathname === '/api/join') return json(fixtureJoin)
      return json({ error: 'relay_refused', relay_status: 401, relay_error: 'unauthenticated' }, 502)
    })

  it('locally, says to run /team-relay:login again', async () => {
    refusing()
    renderWithClient(<App />)
    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent('The relay refused your sign-in')
    expect(banner).toHaveTextContent('/team-relay:login')
  })

  it('hosted, a plain 401 is the console service, not the viewer: never the not-on-team page', async () => {
    setConsoleKey(null)
    Object.defineProperty(window, 'location', { configurable: true, value: new URL('https://console.team.example/') })
    try {
      refusing()
      renderWithClient(<App />)
      const banner = await screen.findByRole('alert')
      expect(banner).toHaveTextContent('The console could not sign in to the relay')
      expect(screen.queryByText("You're not on this team yet")).toBeNull()
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: new URL('http://127.0.0.1:4317/') })
    }
  })
})

describe('owner from /me (M6 §2)', () => {
  it('uses the role /me gives while the roster has not loaded', async () => {
    setTransport(async (path) => {
      const url = new URL(path, 'http://console.invalid/')
      if (url.pathname === '/api/me') return json({ ...fixtureMe, role: 'owner' })
      if (url.pathname === '/api/join') return json(fixtureJoin)
      if (url.pathname === '/api/directory') return json(fixtureDirectory)
      if (url.pathname === '/api/activity') return json(fixtureActivity)
      if (url.pathname === '/api/roster') return new Promise<Response>(() => {})
      return json({ error: 'not_found' }, 404)
    })
    renderWithClient(<App />)
    await waitFor(() => expect(document.querySelector('[data-invite-hint]')).not.toBeNull())
  })
})

describe('the member id field', () => {
  it('suggests an id that the relay accepts for awkward addresses', async () => {
    const { suggestMemberId } = await import('@/lib/roster')
    for (const email of ['Alice.Smith@example.com', '2fast@example.com', 'a@example.com', 'x-y+tag@example.com']) {
      expect(suggestMemberId(email, ['alice'])).toMatch(/^[a-z][a-z0-9_]{1,31}$/)
    }
  })
})

describe('the team map label', () => {
  it('summarises both sessions like the two rings', async () => {
    const { presenceSummary } = await import('@/components/console/team-map')
    expect(presenceSummary('online', null)).toBe('online, not answering')
    expect(presenceSummary('online', 'offline')).toBe('online, not answering')
    expect(presenceSummary('offline', 'online')).toBe('online')
    expect(presenceSummary('idle', 'online')).toBe('online')
    expect(presenceSummary('idle', 'offline')).toBe('idle, not answering')
    expect(presenceSummary(null, null)).toBe('offline')
  })
})
