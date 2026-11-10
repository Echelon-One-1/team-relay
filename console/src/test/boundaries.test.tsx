// M10 §1: a team's boundaries in Team settings. An owner edits and saves them (from the version
// read; someone else's save in between is a conflict and the form shows the latest); a member
// reads them; until they are set, owners are asked to set them and everyone is told answers
// need approval as before. Creating a team goes straight to its boundaries. The console server
// is the dev mock (src/mock/relay.ts), with every call recorded.

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { ChangeError, setTransport } from '@/api/client'
import { setConsoleKey } from '@/api/key'
import { App } from '@/App'
import { UNSET_LINE } from '@/components/console/boundaries'
import { boundariesProblem, boundariesRefusal, boundariesValid, draftFrom, orgProblem, toBoundaries, versionOk, type BoundariesDraft } from '@/lib/boundaries'
import vectorsFile from '../../../schema/boundaries-vectors.json'
import { TEAM_STORAGE_KEY } from '@/lib/teams'
import { MockRelay } from '@/mock/relay'
import { renderWithClient } from './render'

const KEY = 'b0und-b0und-b0und-b0und-b0und-b0'

type Call = { method: string; path: string; team: string | null; body: unknown }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function server(opts: { role?: 'owner' | 'member'; override?: (c: Call) => Response | null } = {}) {
  const relay = new MockRelay()
  relay.latency = [0, 0]
  relay.role = opts.role ?? 'owner'
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
  return { relay, calls, puts: () => calls.filter((c) => c.method === 'PUT') }
}

const section = () => screen.findByRole('region', { name: 'Boundaries' })

beforeEach(() => {
  setConsoleKey(KEY)
  window.history.replaceState(null, '', '/')
  window.localStorage.clear()
})

describe("an owner's boundaries (M10 §1)", () => {
  it('edits every field and saves them from the version read; the answer is the new version', async () => {
    const s = server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const form = await within(await section()).findByRole('form', { name: 'Team boundaries' })
    const topic = within(form).getByLabelText('Topic')
    expect(topic).toHaveValue('Example Co: the orders and payments services, their runbooks, deploys and incidents, and how the team works.')
    expect(within(form).getByText(/Version 2, set by/)).toBeInTheDocument()
    const save = within(form).getByRole('button', { name: 'Save boundaries' })
    expect(save).toBeDisabled()

    await user.clear(topic)
    await user.type(topic, '  Example Co: payments.  ')
    const org = within(form).getByLabelText('GitHub orgs')
    await user.type(org, 'second-org{Enter}')
    expect(within(within(form).getByRole('list', { name: 'Added GitHub orgs' })).getAllByRole('listitem').map((li) => li.getAttribute('data-org'))).toEqual([
      'example-org',
      'second-org',
    ])
    await user.click(within(form).getByRole('button', { name: 'Remove example-org' }))
    await user.click(within(form).getByRole('button', { name: /Add a shared drive/ }))
    // A new row starts on the domain of the one above it.
    expect(within(form).getByLabelText('Domain of shared drive 2')).toHaveValue('example.com')
    await user.type(within(form).getByLabelText('Name of shared drive 2'), 'Clients')
    await user.click(within(form).getByRole('button', { name: 'Remove shared drive 1' }))
    const folders = within(form).getByRole('switch', { name: 'Members may add their own folders' })
    expect(folders).toBeChecked()
    await user.click(folders)
    expect(folders).not.toBeChecked()
    expect(within(form).getByText('Unsaved changes')).toBeInTheDocument()

    await user.click(save)
    await waitFor(() => expect(within(form).getByText(/Saved\. Answers use version 3/)).toBeInTheDocument())
    expect(s.puts()).toEqual([
      {
        method: 'PUT',
        path: '/api/boundaries',
        team: 'demo',
        body: {
          version: 2,
          boundaries: {
            topic: 'Example Co: payments.',
            github_orgs: ['second-org'],
            drives: [{ domain: 'example.com', shared_drive: 'Clients' }],
            member_folders: false,
          },
        },
      },
    ])
    expect(topic).toHaveValue('Example Co: payments.')
    expect(save).toBeDisabled()
  })

  it('checks the fields before sending anything, on the field they are about', async () => {
    const s = server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const form = await within(await section()).findByRole('form', { name: 'Team boundaries' })
    const topic = within(form).getByLabelText('Topic')
    await user.clear(topic)
    await user.click(within(form).getByRole('button', { name: 'Save boundaries' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent(/Say what the team talks about/)
    expect(topic).toHaveAttribute('aria-invalid', 'true')
    await user.type(topic, 'x')
    // An org that is not a GitHub org name is not added.
    const org = within(form).getByLabelText('GitHub orgs')
    await user.type(org, 'not/an-org{Enter}')
    expect(await within(form).findByRole('alert')).toHaveTextContent(/1 to 39 letters, digits or -/)
    expect(org).toHaveAttribute('aria-invalid', 'true')
    await user.clear(org)
    // A drive row with a name and a bad domain.
    await user.click(within(form).getByRole('button', { name: /Add a shared drive/ }))
    const domain = within(form).getByLabelText('Domain of shared drive 2')
    await user.clear(domain)
    await user.type(domain, 'not a domain')
    await user.type(within(form).getByLabelText('Name of shared drive 2'), 'Clients')
    await user.click(within(form).getByRole('button', { name: 'Save boundaries' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent(/Google Workspace domain/)
    expect(domain).toHaveAttribute('aria-invalid', 'true')
    expect(s.puts()).toEqual([])
  })

  it('a team without boundaries asks its owner to set them, and saves from version 0', async () => {
    window.localStorage.setItem(TEAM_STORAGE_KEY, 'research')
    const s = server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const region = await section()
    const form = await within(region).findByRole('form', { name: 'Team boundaries' })
    expect(within(form).getByText("Set this team's boundaries")).toBeInTheDocument()
    expect(within(form).getByText(UNSET_LINE)).toBeInTheDocument()
    expect(within(form).getByRole('button', { name: 'Save boundaries' })).toBeDisabled()
    await user.type(within(form).getByLabelText('Topic'), 'Research at Example Co.')
    await user.type(within(form).getByLabelText('GitHub orgs'), 'example-research')
    // An org typed but not added goes in with the save.
    await user.click(within(form).getByRole('button', { name: 'Save boundaries' }))
    await waitFor(() => expect(s.puts()).toHaveLength(1))
    expect(s.puts()[0]).toMatchObject({
      team: 'research',
      body: { version: 0, boundaries: { topic: 'Research at Example Co.', github_orgs: ['example-research'], drives: [], member_folders: false } },
    })
    await waitFor(() => expect(within(form).queryByText("Set this team's boundaries")).toBeNull())
  })

  it('someone else saved first: says so and shows the latest, and nothing is overwritten', async () => {
    const s = server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const form = await within(await section()).findByRole('form', { name: 'Team boundaries' })
    await user.type(within(form).getByLabelText('Topic'), ' More.')
    s.relay.setBoundariesAs('demo', 'bob', { topic: "bob's topic", github_orgs: ['bob-org'], drives: [], member_folders: false })
    await user.click(within(form).getByRole('button', { name: 'Save boundaries' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent(/Someone else changed the boundaries/)
    await waitFor(() => expect(within(form).getByLabelText('Topic')).toHaveValue("bob's topic"))
    expect(s.puts()).toHaveLength(1)
    expect(s.puts()[0]!.body).toMatchObject({ version: 2 })
    // Saving again goes from bob's version.
    await user.type(within(form).getByLabelText('Topic'), '!')
    await user.click(within(form).getByRole('button', { name: 'Save boundaries' }))
    await waitFor(() => expect(s.puts()).toHaveLength(2))
    expect(s.puts()[1]!.body).toMatchObject({ version: 3, boundaries: { topic: "bob's topic!" } })
  })
})

describe("a member's view (M10 §1)", () => {
  it('reads the boundaries, with no way to change them', async () => {
    const s = server({ role: 'member' })
    renderWithClient(<App />)
    const region = await section()
    const view = await waitFor(() => {
      const v = region.querySelector('[data-boundaries-view]')
      expect(v).not.toBeNull()
      return v as HTMLElement
    })
    expect(within(view).getByText(/the orders and payments services/)).toBeInTheDocument()
    expect(within(view).getByRole('list', { name: 'GitHub orgs' })).toHaveTextContent('example-org')
    expect(within(view).getByRole('list', { name: 'Shared drives' })).toHaveTextContent('Example Team Drive')
    expect(within(view).getByText(/Allowed: each member may add folders/)).toBeInTheDocument()
    expect(within(region).queryByRole('form')).toBeNull()
    expect(within(region).queryByRole('textbox')).toBeNull()
    expect(within(region).queryByRole('switch')).toBeNull()
    expect(screen.queryByRole('form', { name: 'Delete this team' })).toBeNull()
    expect(s.puts()).toEqual([])
  })

  it('in a team without boundaries: says answers need approval as before', async () => {
    window.localStorage.setItem(TEAM_STORAGE_KEY, 'ops')
    server({
      override: (c) =>
        c.path === '/api/teams' && c.method === 'GET'
          ? json({
              teams: [
                { team: 'demo', name: 'Demo', member: 'alice', role: 'owner' },
                { team: 'ops', name: 'Operations', member: 'alice', role: 'member' },
              ],
              invitations: [],
              admin: false,
              teams_created: 0,
              max_teams_created: 3,
              suggested_member: 'alice',
              can_manage_teams: true,
              default_team: 'demo',
            })
          : c.path === '/api/boundaries' && c.team === 'ops'
            ? json({ team: 'ops', version: 0, boundaries: null, updated_at: null, updated_by: null })
            : c.team === 'ops'
              ? json({ error: 'not_found' }, 404)
              : null,
    })
    renderWithClient(<App />)
    const region = await section()
    expect(await within(region).findByText(/No boundaries yet\. Until an owner sets them, answers need each member's approval, as before\./)).toBeInTheDocument()
    expect(within(region).getByText(/Only owners change them/)).toBeInTheDocument()
  })
})

describe('loading, a relay without boundaries, and a failed read', () => {
  it('a relay without the route (404) says so, and is not asked again', async () => {
    const s = server({ override: (c) => (c.path === '/api/boundaries' ? json({ error: 'not_found' }, 404) : null) })
    renderWithClient(<App />)
    const region = await section()
    expect(await within(region).findByText(/This relay does not keep boundaries yet/)).toBeInTheDocument()
    expect(s.calls.filter((c) => c.path === '/api/boundaries')).toHaveLength(1)
  })

  it('a failed read says so and can be tried again', async () => {
    let fail = true
    server({ override: (c) => (c.path === '/api/boundaries' && fail ? json({ error: 'internal' }, 500) : null) })
    const user = userEvent.setup()
    renderWithClient(<App />)
    const region = await section()
    expect(await within(region).findByRole('alert')).toHaveTextContent('The boundaries could not be read.')
    fail = false
    await user.click(within(region).getByRole('button', { name: 'Try again' }))
    expect(await within(region).findByRole('form', { name: 'Team boundaries' })).toBeInTheDocument()
  })
})

describe('creating a team goes straight to its boundaries (M10 §1)', () => {
  it('opens Team settings at Boundaries with the topic focused', async () => {
    server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Switch team/ })).toHaveTextContent('Demo'))
    await user.click(screen.getByRole('button', { name: /Switch team/ }))
    await user.click(within(await screen.findByRole('dialog', { name: 'Your teams' })).getByRole('button', { name: /Create team/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Create a team' })
    await user.type(within(dialog).getByLabelText('Team name'), 'Payments')
    await user.click(within(dialog).getByRole('button', { name: 'Create team' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Switch team/ })).toHaveTextContent('Payments'))
    const region = await section()
    const form = await within(region).findByRole('form', { name: 'Team boundaries' })
    expect(within(form).getByText(UNSET_LINE)).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(within(form).getByLabelText('Topic')))
  })
})

describe('the form rules (lib/boundaries)', () => {
  const draft = { topic: 'Topic', github_orgs: ['a-org'], drives: [{ domain: 'example.com', shared_drive: 'Team Drive' }], member_folders: true }

  it('finds the first problem, on its field', () => {
    expect(boundariesProblem(draft)).toBeNull()
    expect(boundariesProblem({ ...draft, topic: ' ' })?.field).toBe('topic')
    expect(boundariesProblem({ ...draft, topic: 'x'.repeat(501) })?.message).toMatch(/501 characters/)
    expect(boundariesProblem({ ...draft, topic: 'a‮b' })?.field).toBe('topic')
    expect(boundariesProblem({ ...draft, drives: [{ domain: 'Example.com', shared_drive: 'D' }] })?.field).toEqual({ drive: 0, part: 'domain' })
    expect(boundariesProblem({ ...draft, drives: [{ domain: 'example.com', shared_drive: 'a/b' }] })?.field).toEqual({ drive: 0, part: 'shared_drive' })
    expect(boundariesProblem({ ...draft, drives: [{ domain: 'example.com', shared_drive: '..' }] })?.field).toEqual({ drive: 0, part: 'shared_drive' })
    // An empty row is left out, not a problem.
    expect(boundariesProblem({ ...draft, drives: [{ domain: '', shared_drive: ' ' }] })).toBeNull()
  })

  it('sends trimmed values, without empty rows or duplicates', () => {
    expect(
      toBoundaries({
        topic: '  T  ',
        github_orgs: ['a-org', 'A-ORG', ' b '],
        drives: [
          { domain: 'example.com', shared_drive: ' D ' },
          { domain: 'example.com', shared_drive: 'D' },
          { domain: '', shared_drive: '' },
        ],
        member_folders: false,
      }),
    ).toEqual({ topic: 'T', github_orgs: ['a-org', 'b'], drives: [{ domain: 'example.com', shared_drive: 'D' }], member_folders: false })
    expect(draftFrom(null)).toEqual({ topic: '', github_orgs: [], drives: [], member_folders: false })
  })

  it('refuses a bad, repeated or eleventh org', () => {
    expect(orgProblem('good-org', [])).toBeNull()
    expect(orgProblem('bad org', [])).toMatch(/1 to 39/)
    expect(orgProblem('A-Org', ['a-org'])).toMatch(/already listed/)
    expect(orgProblem('new', Array.from({ length: 10 }, (_, i) => `o${i}`))).toMatch(/At most 10/)
  })

  it('words the refusals', () => {
    const relay = (status: number, code: string | null, detail: string | null = null) =>
      new ChangeError('refused', { status: 502, relayStatus: status, relayError: code, detail })
    expect(boundariesRefusal(relay(409, 'version_conflict'))).toMatchObject({ conflict: true })
    expect(boundariesRefusal(relay(403, 'forbidden')).message).toBe('Only team owners can change the boundaries.')
    expect(boundariesRefusal(relay(400, 'invalid_body', 'topic is too long')).message).toBe('topic is too long')
    expect(boundariesRefusal(relay(429, 'rate_limited')).message).toMatch(/Too many changes/)
    expect(boundariesRefusal(new ChangeError('gone', { signedOut: true })).message).toBe('gone')
  })
})

// M10 §7.5: one rule. The relay, the console server and this page accept exactly what
// schema/boundaries-vectors.json says.
describe('the one validation rule (schema/boundaries-vectors.json)', () => {
  const vectors = vectorsFile as unknown as {
    valid: unknown[]
    invalid: Array<{ why: string; boundaries: Record<string, unknown> }>
    versions: { valid: unknown[]; invalid: unknown[] }
    placeholders: Record<string, string>
  }
  // Each placeholder's value, as the file's "placeholders" texts say.
  const placeholders: Record<string, string> = {
    TOPIC_501: 'a'.repeat(501),
    DOMAIN_253: `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`,
    DOMAIN_254: `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(58)}.com`,
    LABEL_63_DOMAIN: `${'a'.repeat(63)}.example.com`,
    LABEL_64_DOMAIN: `${'a'.repeat(64)}.example.com`,
    DRIVE_100: 'd'.repeat(100),
    DRIVE_101: 'd'.repeat(101),
  }
  const expandAny = (v: unknown): unknown => {
    if (typeof v === 'string') return Object.prototype.hasOwnProperty.call(placeholders, v) ? placeholders[v] : v
    if (Array.isArray(v)) return v.map(expandAny)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandAny(x)]))
    return v
  }
  const expand = (b: Record<string, unknown>) => expandAny(b) as Record<string, unknown>
  const valid = vectors.valid.map((b) => expand(b as Record<string, unknown>))
  const invalid = vectors.invalid.map((v) => [v.why, expand(v.boundaries)] as const)

  it('expands every placeholder it names', () => {
    expect(Object.keys(vectors.placeholders).sort()).toEqual(Object.keys(placeholders).sort())
    const names = new RegExp(`"(${Object.keys(placeholders).join('|')})"`)
    expect(JSON.stringify([valid, invalid])).not.toMatch(names)
    expect(invalid.some(([, b]) => b.topic === 'a'.repeat(501))).toBe(true)
    expect(placeholders.DOMAIN_253!.length).toBe(253)
    expect(placeholders.DOMAIN_254!.length).toBe(254)
  })

  it.each(valid.map((b, i) => [i, b] as const))('accepts valid document %i', (_i, b) => {
    expect(boundariesValid(b)).toBe(true)
  })

  it.each(invalid)('refuses: %s', (_why, b) => {
    expect(boundariesValid(b)).toBe(false)
  })

  it.each(vectors.versions.valid.map((v) => [JSON.stringify(v), v] as const))('accepts version %s', (_s, v) => {
    expect(versionOk(v)).toBe(true)
  })

  it.each(vectors.versions.invalid.map((v) => [JSON.stringify(v), v] as const))('refuses version %s', (_s, v) => {
    expect(versionOk(v)).toBe(false)
  })

  it('counts the list caps as sent, before duplicates are dropped', () => {
    const base = { topic: 't', github_orgs: [], drives: [], member_folders: false }
    expect(boundariesValid({ ...base, github_orgs: Array.from({ length: 11 }, () => 'example-org') })).toBe(false)
    expect(boundariesValid({ ...base, drives: Array.from({ length: 11 }, () => ({ domain: 'example.com', shared_drive: 'D' })) })).toBe(false)
    expect(boundariesValid({ ...base, github_orgs: Array.from({ length: 10 }, () => 'example-org') })).toBe(true)
  })

  it('the form finds a problem with every invalid document it can hold, and none with a valid one', () => {
    const asDraft = (b: Record<string, unknown>): BoundariesDraft | null => {
      if (typeof b.topic !== 'string' || !Array.isArray(b.github_orgs) || !Array.isArray(b.drives) || typeof b.member_folders !== 'boolean') return null
      if (Object.keys(b).length !== 4 || (b.drives as Record<string, unknown>[]).some((d) => Object.keys(d).length !== 2)) return null
      return b as unknown as BoundariesDraft
    }
    for (const b of valid) {
      expect(boundariesProblem(asDraft(b)!)).toBeNull()
    }
    for (const [why, b] of invalid) {
      const d = asDraft(b)
      // The form trims a drive name's surrounding space before sending (what it then sends passes).
      if (d === null || why === 'drive leading space') continue
      expect(boundariesProblem(d), why).not.toBeNull()
    }
    // Whatever the form lets through is what the rule accepts.
    for (const b of valid) expect(boundariesValid(toBoundaries(asDraft(b)!))).toBe(true)
  })
})
