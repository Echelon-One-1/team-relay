// M9 §5 and §7: the console with the viewer's teams. The header's switcher (teams, invitations,
// Create team, Admin), remembering the last team in this browser, every call naming its team
// in X-Relay-Team, the Create team dialog with the relay's refusals in words, invitations on
// the not-on-team page, an owner's Invited entries and Delete team, and the admin page. The
// console server is the dev mock (src/mock/relay.ts), with every call recorded.

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { ChangeError, setTransport } from '@/api/client'
import { setConsoleKey } from '@/api/key'
import type { Teams } from '@/api/types'
import { App } from '@/App'
import { fixtureTeams } from '@/mock/fixtures'
import { MockRelay } from '@/mock/relay'
import { createProblem, createRefusal, pickTeam, readTeams, TEAM_STORAGE_KEY, teamIdFromName, tidyTeamId } from '@/lib/teams'
import { renderWithClient } from './render'

const KEY = 't3ams-t3ams-t3ams-t3ams-t3ams-t3'

type Call = { method: string; path: string; team: string | null; body: unknown }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** The dev mock as the console server, every call recorded; `override` answers first when it will. */
function server(opts: { stranger?: boolean; override?: (c: Call) => Response | null } = {}) {
  const relay = new MockRelay()
  relay.latency = [0, 0]
  relay.stranger = opts.stranger ?? false
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
  return { relay, calls, changes: () => calls.filter((c) => c.method !== 'GET') }
}

const switcher = () => screen.getByRole('button', { name: /Switch team/ })

beforeEach(() => {
  setConsoleKey(KEY)
  window.history.replaceState(null, '', '/')
})

describe('the team switcher (M9 §5)', () => {
  it('shows the default team, names it on every call, and switches to another, remembering it', async () => {
    const s = server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    await waitFor(() => expect(switcher()).toHaveTextContent('Demo'))
    await waitFor(() => expect(s.calls.some((c) => c.path.startsWith('/api/directory'))).toBe(true))
    // Every call about the team names it; /api/teams names none.
    expect(s.calls.filter((c) => c.path === '/api/teams').every((c) => c.team === null)).toBe(true)
    expect(s.calls.filter((c) => /^\/api\/(me|directory|activity|roster)/.test(c.path)).every((c) => c.team === 'demo')).toBe(true)

    await user.click(switcher())
    const menu = await screen.findByRole('dialog', { name: 'Your teams' })
    expect(within(menu).getAllByRole('button', { current: true }).map((b) => b.getAttribute('data-team-option'))).toEqual(['demo'])
    expect(within(menu).getByText('Operations')).toBeInTheDocument()
    expect(within(menu).getByText('2 left')).toBeInTheDocument()
    await user.click(within(menu).getByText('Research'))
    await waitFor(() => expect(switcher()).toHaveTextContent('Research'))
    await waitFor(() => expect(s.calls.some((c) => c.path.startsWith('/api/directory') && c.team === 'research')).toBe(true))
    expect(window.localStorage.getItem(TEAM_STORAGE_KEY)).toBe('research')
    // The quiet team has no traffic, and the invitation for frank shows as Invited to its owner.
    const frank = await waitFor(() => {
      const row = document.querySelector('[data-member="frank"]')
      expect(row).not.toBeNull()
      return row as HTMLElement
    })
    expect(frank).toHaveAttribute('data-status', 'invited')
    expect(within(frank).getByText('Invited')).toBeInTheDocument()
  })

  it('opens on the team last chosen in this browser, and ignores a stored team that is not the viewer\'s', async () => {
    window.localStorage.setItem(TEAM_STORAGE_KEY, 'research')
    server()
    const first = renderWithClient(<App />)
    await waitFor(() => expect(switcher()).toHaveTextContent('Research'))
    first.unmount()
    window.localStorage.setItem(TEAM_STORAGE_KEY, 'ops')
    server()
    renderWithClient(<App />)
    await waitFor(() => expect(switcher()).toHaveTextContent('Demo'))
  })

  it('works when storage is refused (a private window)', async () => {
    const original = Storage.prototype.getItem
    const originalSet = Storage.prototype.setItem
    Storage.prototype.getItem = () => {
      throw new Error('SecurityError')
    }
    Storage.prototype.setItem = () => {
      throw new Error('SecurityError')
    }
    try {
      server()
      const user = userEvent.setup()
      renderWithClient(<App />)
      await waitFor(() => expect(switcher()).toHaveTextContent('Demo'))
      await user.click(switcher())
      await user.click(within(await screen.findByRole('dialog', { name: 'Your teams' })).getByText('Research'))
      await waitFor(() => expect(switcher()).toHaveTextContent('Research'))
    } finally {
      Storage.prototype.getItem = original
      Storage.prototype.setItem = originalSet
    }
  })

  it('accepts an invitation from the switcher and moves to that team', async () => {
    const s = server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    await waitFor(() => expect(switcher()).toHaveTextContent('Demo'))
    expect(document.querySelector('[data-invitation-dot]')).not.toBeNull()
    await user.click(switcher())
    const inv = (await screen.findByRole('dialog', { name: 'Your teams' })).querySelector('[data-invitation="ops"]') as HTMLElement
    expect(inv).toHaveTextContent('olga invited you as alice.')
    await user.click(within(inv).getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(switcher()).toHaveTextContent('Operations'))
    expect(s.changes()).toEqual([{ method: 'POST', path: '/api/invitations/ops', team: null, body: { accept: true } }])
    expect(document.querySelector('[data-invitation-dot]')).toBeNull()
  })
})

describe('not on a team (M9 §3, §5)', () => {
  it('offers the invitation and Create team, with the signed-in email', async () => {
    const s = server({ stranger: true })
    const user = userEvent.setup()
    renderWithClient(<App />)
    const page = await screen.findByText("You're not on a team yet")
    expect(page).toBeInTheDocument()
    expect(document.querySelector('[data-not-on-team]')).toHaveTextContent('Ask a team owner to invite dana@example.com, or create a team of your own.')
    expect(document.querySelector('[data-invitation="ops"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: /Create a team/ })).toBeEnabled()
    // Nothing about any team was read.
    expect(s.calls.map((c) => c.path)).toEqual(['/api/teams'])
    await user.click(screen.getByRole('button', { name: /Create a team/ }))
    expect(await screen.findByRole('dialog', { name: 'Create a team' })).toBeInTheDocument()
  })

  it('a team route that answers not_on_team (removed, or the team deleted) reads the teams again and says so', async () => {
    let gone = false
    const s = server({ override: (c) => (gone && c.team === 'demo' ? json({ error: 'not_on_team', team: 'demo' }, 403) : null) })
    renderWithClient(<App />)
    await waitFor(() => expect(switcher()).toHaveTextContent('Demo'))
    const before = s.calls.filter((c) => c.path === '/api/teams').length
    gone = true
    await screen.findByText('This team is not yours any more', undefined, { timeout: 6000 })
    await waitFor(() => expect(s.calls.filter((c) => c.path === '/api/teams').length).toBeGreaterThan(before))
    // The viewer's other teams are offered.
    expect(document.querySelector('[data-no-team] [data-team-option="research"]')).not.toBeNull()
  }, 10_000)
})

describe('Create team (M9 §2)', () => {
  async function openDialog() {
    const user = userEvent.setup()
    renderWithClient(<App />)
    await waitFor(() => expect(switcher()).toHaveTextContent('Demo'))
    await user.click(switcher())
    await user.click(within(await screen.findByRole('dialog', { name: 'Your teams' })).getByRole('button', { name: /Create team/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Create a team' })
    return { user, dialog }
  }

  it('suggests the id from the name and the member id from the account, keeps edits, creates and switches to it', async () => {
    const s = server()
    const { user, dialog } = await openDialog()
    const name = within(dialog).getByLabelText('Team name')
    const id = within(dialog).getByLabelText('Team id')
    const member = within(dialog).getByLabelText('Your member id')
    expect(member).toHaveValue('alice')
    expect(within(dialog).getByText('2 of 3 left to create')).toBeInTheDocument()
    await user.type(name, 'Payments Platform')
    expect(id).toHaveValue('payments-platform')
    await user.clear(id)
    await user.type(id, 'Pay Ops')
    expect(id).toHaveValue('pay-ops')
    await user.type(name, '!')
    expect(id).toHaveValue('pay-ops')
    await user.click(within(dialog).getByRole('button', { name: 'Create team' }))
    await waitFor(() => expect(switcher()).toHaveTextContent('Payments Platform!'))
    expect(s.changes()).toEqual([
      { method: 'POST', path: '/api/teams', team: null, body: { name: 'Payments Platform!', id: 'pay-ops', owner_member_id: 'alice' } },
    ])
    expect(screen.queryByRole('dialog', { name: 'Create a team' })).toBeNull()
    await waitFor(() => expect(s.calls.some((c) => c.team === 'pay-ops')).toBe(true))
  })

  it('shows the relay\'s refusals in words, on the field they are about', async () => {
    const refusals: Array<[string, RegExp]> = [
      ['team_id_unavailable', /That team id is taken or reserved/],
      ['team_name_unavailable', /already has that name/],
      ['team_limit', /created 3 teams, the most one account may/],
      ['rate_limited', /Too many team creations/],
    ]
    let next = 0
    server({
      override: (c) =>
        c.method === 'POST' && c.path === '/api/teams'
          ? json({ error: 'relay_refused', relay_status: refusals[next]![0] === 'rate_limited' ? 429 : 409, relay_error: refusals[next++]![0] }, 502)
          : null,
    })
    const { user, dialog } = await openDialog()
    await user.type(within(dialog).getByLabelText('Team name'), 'Ops')
    for (const [code, message] of refusals) {
      await user.click(within(dialog).getByRole('button', { name: 'Create team' }))
      const alert = await within(dialog).findByRole('alert')
      expect(alert, code).toHaveTextContent(message)
      if (code === 'team_id_unavailable') expect(within(dialog).getByLabelText('Team id')).toHaveAttribute('aria-invalid', 'true')
      if (code === 'team_name_unavailable') expect(within(dialog).getByLabelText('Team name')).toHaveAttribute('aria-invalid', 'true')
    }
  })

  it('checks the values before sending anything', async () => {
    const s = server()
    const { user, dialog } = await openDialog()
    await user.type(within(dialog).getByLabelText('Team name'), 'ok')
    const id = within(dialog).getByLabelText('Team id')
    await user.clear(id)
    await user.type(id, 'ab')
    await user.click(within(dialog).getByRole('button', { name: 'Create team' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/3 to 32 characters/)
    expect(s.changes()).toEqual([])
  })

  it('says when no slot is left, and does not offer to create', async () => {
    const full: Teams = { ...fixtureTeams, teams_created: 3 }
    server({ override: (c) => (c.path === '/api/teams' && c.method === 'GET' ? json(full) : null) })
    const user = userEvent.setup()
    renderWithClient(<App />)
    await waitFor(() => expect(switcher()).toHaveTextContent('Demo'))
    await user.click(switcher())
    const create = within(await screen.findByRole('dialog', { name: 'Your teams' })).getByRole('button', { name: /Create team/ })
    expect(create).toBeDisabled()
    expect(create).toHaveTextContent('None left')
  })
})

describe('an owner\'s team (M9 §7.2, §7.7)', () => {
  it('withdraws an invitation from the Members panel', async () => {
    const s = server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const dana = await waitFor(() => {
      const row = document.querySelector('[data-member="dana"]')
      expect(row).not.toBeNull()
      return row as HTMLElement
    })
    expect(screen.getByText('3 members, 1 owner, 1 invited')).toBeInTheDocument()
    await user.click(within(dana).getByRole('button', { name: 'Withdraw' }))
    await waitFor(() => expect(document.querySelector('[data-member="dana"]')).toBeNull())
    expect(s.changes()).toEqual([{ method: 'DELETE', path: '/api/roster/dana', team: 'demo', body: undefined }])
  })

  it('deletes a team it owns after the id is typed, and moves to another team', async () => {
    window.localStorage.setItem(TEAM_STORAGE_KEY, 'research')
    window.history.replaceState(null, '', '/settings')
    const s = server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const form = await screen.findByRole('form', { name: 'Delete this team' })
    const button = within(form).getByRole('button', { name: 'Delete team' })
    expect(button).toBeDisabled()
    await user.type(within(form).getByLabelText(/Type research to confirm/), 'researc')
    expect(button).toBeDisabled()
    await user.type(within(form).getByLabelText(/Type research to confirm/), 'h')
    await user.click(button)
    await waitFor(() => expect(switcher()).toHaveTextContent('Demo'))
    expect(s.changes()).toEqual([{ method: 'DELETE', path: '/api/teams/research', team: null, body: { confirm: 'research' } }])
    // Back on the team page of the team shown next, not on its settings.
    expect(window.location.pathname).toBe('/team')
    expect(await screen.findByRole('region', { name: 'Members' })).toBeInTheDocument()
  })

  it('explains a team from the relay\'s team file cannot be deleted here', async () => {
    window.history.replaceState(null, '', '/settings')
    server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const form = await screen.findByRole('form', { name: 'Delete this team' })
    await user.type(within(form).getByLabelText(/Type demo to confirm/), 'demo')
    await user.click(within(form).getByRole('button', { name: 'Delete team' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent(/comes from the relay's team file/)
  })
})

describe('the admin page (M9 §4)', () => {
  it('lists every team with its counts, pages with the relay\'s cursor, and deletes after the id is typed', async () => {
    window.history.replaceState(null, '', '/admin')
    const s = server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const table = await screen.findByRole('table')
    const rows = () => [...table.querySelectorAll('[data-admin-team]')].map((r) => r.getAttribute('data-admin-team'))
    await waitFor(() => expect(rows()).toContain('design-guild'))
    expect(rows()[0]).toBe('demo')
    const seed = table.querySelector('[data-admin-team="demo"]') as HTMLElement
    expect(within(seed).getByText('Team file')).toBeInTheDocument()
    expect(within(seed).queryByRole('button', { name: 'Delete' })).toBeNull()
    const deleted = table.querySelector('[data-admin-team="old-pilot"]') as HTMLElement
    expect(within(deleted).getByText('Deleted')).toBeInTheDocument()
    expect(within(deleted).queryByRole('button')).toBeNull()
    // No email and no content anywhere.
    expect(table.textContent).not.toMatch(/@/)

    const guild = table.querySelector('[data-admin-team="design-guild"]') as HTMLElement
    expect(guild).toHaveTextContent('hana')
    await user.click(within(guild).getByRole('button', { name: 'Delete' }))
    const confirm = await screen.findByRole('form', { name: 'Delete design-guild' })
    const del = within(confirm).getByRole('button', { name: 'Delete team' })
    expect(del).toBeDisabled()
    await user.type(within(confirm).getByLabelText(/Type design-guild to confirm/), 'design-guild')
    await user.click(del)
    await waitFor(() => expect(within(table.querySelector('[data-admin-team="design-guild"]') as HTMLElement).getByText('Deleted')).toBeInTheDocument())
    expect(s.changes()).toEqual([{ method: 'DELETE', path: '/api/admin/teams/design-guild', team: null, body: { confirm: 'design-guild' } }])
    expect(s.calls.filter((c) => c.path.startsWith('/api/admin/teams?')).every((c) => c.path.includes('limit=50'))).toBe(true)
  })

  it('reaches the admin page from the switcher, and back to a team', async () => {
    server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    await waitFor(() => expect(switcher()).toHaveTextContent('Demo'))
    await user.click(switcher())
    await user.click(within(await screen.findByRole('dialog', { name: 'Your teams' })).getByRole('button', { name: /Admin/ }))
    expect(await screen.findByText('Every team on this relay')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/admin')
    await user.click(switcher())
    await user.click(within(await screen.findByRole('dialog', { name: 'Your teams' })).getByText('Research'))
    await waitFor(() => expect(switcher()).toHaveTextContent('Research'))
    // Back to a team: the team view's own path (docs/SIGNIN-PAGE.md).
    expect(window.location.pathname).toBe('/team')
  })

  it('pages: Next asks for the page after the last id', async () => {
    const s = server({
      override: (c) => {
        if (!c.path.startsWith('/api/admin/teams?')) return null
        const after = new URLSearchParams(c.path.split('?')[1]).get('after')
        const row = (id: string) => ({ id, name: id, status: 'active', seed: false, created_at: null, created_by_member: null, members: 1, owners: 1, last_activity_at: null })
        return json(after === null ? { teams: [row('aaa'), row('bbb')], next: 'bbb' } : { teams: [row('ccc')], next: null })
      },
    })
    window.history.replaceState(null, '', '/admin')
    const user = userEvent.setup()
    renderWithClient(<App />)
    await screen.findByText('aaa', { selector: 'span.font-mono' })
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Next page' }))
    await screen.findByText('ccc', { selector: 'span.font-mono' })
    expect(s.calls.some((c) => c.path.includes('after=bbb'))).toBe(true)
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Previous page' }))
    await screen.findByText('aaa', { selector: 'span.font-mono' })
  })
})

describe('the team rules', () => {
  it('makes a team id from a name as the relay does, and tidies typed ids', () => {
    expect(teamIdFromName('Payments Platform')).toBe('payments-platform')
    expect(teamIdFromName('  2026 plans!  ')).toBe('team-2026-plans')
    expect(teamIdFromName('Café Ünïon')).toBe('cafe-union')
    expect(teamIdFromName('Ω')).toBe('team')
    expect(teamIdFromName('x'.repeat(50))).toHaveLength(32)
    expect(tidyTeamId('My Team_2.0')).toBe('my-team-2-0')
  })

  it('picks the chosen, then the stored, then the default, then the first team', () => {
    expect(pickTeam(fixtureTeams, 'research', null)).toBe('research')
    expect(pickTeam(fixtureTeams, 'ops', 'research')).toBe('research')
    expect(pickTeam(fixtureTeams, null, 'nope')).toBe('demo')
    expect(pickTeam({ ...fixtureTeams, default_team: 'elsewhere' }, null, null)).toBe('demo')
    expect(pickTeam({ ...fixtureTeams, teams: [] }, 'demo', 'demo')).toBeNull()
  })

  it('checks a new team and words the relay\'s refusals', () => {
    expect(createProblem('', 'abc', 'al')).toMatchObject({ field: 'name' })
    expect(createProblem('A‮b', 'abc', 'al')).toMatchObject({ field: 'name' })
    expect(createProblem('Ok', 'Abc', 'al')).toMatchObject({ field: 'id' })
    expect(createProblem('Ok', 'abc', 'A')).toMatchObject({ field: 'member' })
    expect(createProblem('Ok', 'abc', 'al')).toBeNull()
    const refusal = (code: string) => new ChangeError('x', { status: 502, relayStatus: 409, relayError: code })
    expect(createRefusal(refusal('team_limit'), 3).message).toMatch(/created 3 teams/)
    expect(createRefusal(refusal('team_id_unavailable'), 3).field).toBe('id')
  })

  it('reads only a well-formed teams answer', () => {
    expect(readTeams({ members: [] })).toBeNull()
    expect(readTeams(null)).toBeNull()
    const t = readTeams({ ...fixtureTeams, teams: [...fixtureTeams.teams, { team: 'BAD', member: 'x' }, 'junk'] })!
    expect(t.teams.map((x) => x.team)).toEqual(['demo', 'research'])
    expect(readTeams({ teams: [{ team: 'abc', member: 'al', name: '' }], default_team: 'abc' })!.teams[0]!.name).toBe('abc')
  })
})
