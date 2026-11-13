// M10 §1, schema v3 (13 Nov 2026): a team's boundaries in Team settings are its topic alone. An
// owner edits and saves it (from the version read; someone else's save in between is a conflict
// and the form shows the latest). A member reads it. Until it is set, owners are asked to set it.
// Nothing about GitHub, Google Drive or members' folders is shown, asked for or sent: a body with
// one of those fields is refused by name, and a document an earlier relay stored reads as its
// topic alone. The console server is the dev mock (src/mock/relay.ts), with every call recorded.

import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { ChangeError, setTransport } from '@/api/client'
import { setConsoleKey } from '@/api/key'
import { App } from '@/App'
import { UNSET_LINE } from '@/components/console/boundaries'
import {
  boundariesProblem,
  boundariesRefusal,
  boundariesValid,
  draftFrom,
  readBoundaries,
  readTeamBoundaries,
  REMOVED_FIELDS,
  removedField,
  toBoundaries,
  versionOk,
} from '@/lib/boundaries'
import { TEAM_STORAGE_KEY } from '@/lib/teams'
import { MockRelay } from '@/mock/relay'
import { renderWithClient } from './render'
import { PLACEHOLDERS, rawVectors, vectors } from './vectors'

const KEY = 'b0und-b0und-b0und-b0und-b0und-b0'
/** Words of the removed sources: none may show in the panel. */
const SOURCES_WORDS = /github|google drive|shared drive|repositor|organisation|members may add|their own folders/i

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
  return { relay, calls, puts: () => calls.filter((c) => c.method === 'PUT'), reads: (p: string) => calls.filter((c) => c.path === p) }
}

const section = () => screen.findByRole('region', { name: 'Boundaries' })
const ownerForm = async () => within(await section()).findByRole('form', { name: 'Team boundaries' })

beforeEach(() => {
  setConsoleKey(KEY)
  // Team settings are their own page (/settings).
  window.history.replaceState(null, '', '/settings')
  window.localStorage.clear()
})

describe("an owner's boundaries: the topic only (M10 §1, schema v3)", () => {
  it('edits the topic and saves exactly {version, boundaries: {topic}}, trimmed', async () => {
    const s = server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const form = await ownerForm()
    const topic = within(form).getByLabelText('Topic')
    expect(topic).toHaveValue('Example Co: the orders and payments services, their runbooks, deploys and incidents, and how the team works.')
    expect(within(form).getByText(/Version 2, set by/)).toBeInTheDocument()
    const save = within(form).getByRole('button', { name: 'Save boundaries' })
    expect(save).toBeDisabled()
    // The topic is the one field: no GitHub, Drive or members' folders to set.
    expect(within(form).getAllByRole('textbox')).toEqual([topic])
    expect(within(form).queryByRole('switch')).toBeNull()
    expect(within(form).queryByRole('checkbox')).toBeNull()
    expect(within(form).queryByRole('group')).toBeNull()
    expect(form.textContent).not.toMatch(SOURCES_WORDS)

    await user.clear(topic)
    await user.type(topic, '  Example Co: payments.  ')
    expect(within(form).getByText('Unsaved changes')).toBeInTheDocument()
    await user.click(save)
    await waitFor(() => expect(within(form).getByText(/Saved\. Answers use version 3/)).toBeInTheDocument())
    expect(s.puts()).toEqual([{ method: 'PUT', path: '/api/boundaries', team: 'demo', body: { version: 2, boundaries: { topic: 'Example Co: payments.' } } }])
    expect(topic).toHaveValue('Example Co: payments.')
    expect(save).toBeDisabled()
    // Nothing else is read for the form.
    expect(s.calls.some((c) => c.path.startsWith('/api/sources'))).toBe(false)
  })

  it('checks the topic before sending anything', async () => {
    const s = server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const form = await ownerForm()
    const topic = within(form).getByLabelText('Topic')
    await user.clear(topic)
    await user.click(within(form).getByRole('button', { name: 'Save boundaries' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent(/Say what the team talks about/)
    expect(topic).toHaveAttribute('aria-invalid', 'true')
    await user.click(topic)
    await user.paste('x'.repeat(501))
    await user.click(within(form).getByRole('button', { name: 'Save boundaries' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent('The topic is 501 characters; at most 500.')
    expect(s.puts()).toEqual([])
  })

  it('a team without boundaries asks its owner to set them, and saves the topic from version 0', async () => {
    window.localStorage.setItem(TEAM_STORAGE_KEY, 'research')
    const s = server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const form = await ownerForm()
    expect(within(form).getByText("Set this team's boundaries")).toBeInTheDocument()
    expect(within(form).getByText(UNSET_LINE)).toBeInTheDocument()
    expect(within(form).getByRole('button', { name: 'Save boundaries' })).toBeDisabled()
    await user.type(within(form).getByLabelText('Topic'), 'Research at Example Co.')
    await user.click(within(form).getByRole('button', { name: 'Save boundaries' }))
    await waitFor(() => expect(s.puts()).toHaveLength(1))
    expect(s.puts()[0]).toMatchObject({ team: 'research', body: { version: 0, boundaries: { topic: 'Research at Example Co.' } } })
    await waitFor(() => expect(within(form).queryByText("Set this team's boundaries")).toBeNull())
  })

  it('someone else saved first: says so and shows the latest, and nothing is overwritten', async () => {
    const s = server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const form = await ownerForm()
    await user.type(within(form).getByLabelText('Topic'), ' More.')
    s.relay.setBoundariesAs('demo', 'bob', { topic: "bob's topic" })
    await user.click(within(form).getByRole('button', { name: 'Save boundaries' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent(/Someone else changed the boundaries/)
    await waitFor(() => expect(within(form).getByLabelText('Topic')).toHaveValue("bob's topic"))
    expect(s.puts()).toHaveLength(1)
    expect(s.puts()[0]!.body).toMatchObject({ version: 2 })
    await user.type(within(form).getByLabelText('Topic'), '!')
    await user.click(within(form).getByRole('button', { name: 'Save boundaries' }))
    await waitFor(() => expect(s.puts()).toHaveLength(2))
    expect(s.puts()[1]!.body).toEqual({ version: 3, boundaries: { topic: "bob's topic!" } })
  })

  it("a refusal is said in the relay's words: a removed field named", async () => {
    const detail = "boundaries.github_orgs: no longer part of a team's boundaries (only the topic is, since 13 Nov 2026)"
    const s = server({
      override: (c) =>
        c.method === 'PUT' && c.path === '/api/boundaries' ? json({ error: 'relay_refused', relay_status: 400, relay_error: 'invalid_body', detail }, 502) : null,
    })
    const user = userEvent.setup()
    renderWithClient(<App />)
    const form = await ownerForm()
    await user.type(within(form).getByLabelText('Topic'), '!')
    await user.click(within(form).getByRole('button', { name: 'Save boundaries' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent(detail)
    expect(s.puts()).toHaveLength(1)
  })
})

describe("a member's view (M10 §1)", () => {
  it('reads the topic, with no way to change it and nothing about sources', async () => {
    const s = server({ role: 'member' })
    renderWithClient(<App />)
    const region = await section()
    const view = await waitFor(() => {
      const v = region.querySelector('[data-boundaries-view]')
      expect(v).not.toBeNull()
      return v as HTMLElement
    })
    expect(within(view).getByText(/the orders and payments services/)).toBeInTheDocument()
    expect(within(view).getByText(/Version 2, set by/)).toBeInTheDocument()
    expect(view.textContent).not.toMatch(SOURCES_WORDS)
    expect(within(region).queryByRole('list')).toBeNull()
    expect(within(region).queryByRole('form')).toBeNull()
    expect(within(region).queryByRole('textbox')).toBeNull()
    expect(within(region).queryByRole('switch')).toBeNull()
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

describe('loading, older relays, and a failed read', () => {
  it('a document an earlier relay stored reads as its topic alone, and is saved as the topic alone', async () => {
    const v2 = {
      team: 'demo',
      version: 4,
      boundaries: vectors.stored.find((x) => x.why === 'a schema v2 document')!.stored,
      since: { github_orgs: { 'example-org': 1 }, drives: [], member_folders: null },
      updated_at: '2026-10-01T10:00:00Z',
      updated_by: 'olga',
    }
    const s = server({
      override: (c) =>
        c.path === '/api/boundaries'
          ? c.method === 'GET'
            ? json(v2)
            : json({ team: 'demo', version: 5, boundaries: (c.body as { boundaries: unknown }).boundaries, updated_at: '2026-11-13T10:00:00Z', updated_by: 'alice' })
          : null,
    })
    const user = userEvent.setup()
    renderWithClient(<App />)
    const form = await ownerForm()
    expect(within(form).getByLabelText('Topic')).toHaveValue('Example Org: our clients, products and engineering.')
    expect(form.textContent).not.toMatch(SOURCES_WORDS)
    await user.type(within(form).getByLabelText('Topic'), '!')
    await user.click(within(form).getByRole('button', { name: 'Save boundaries' }))
    await waitFor(() => expect(s.puts()).toHaveLength(1))
    expect(s.puts()[0]!.body).toEqual({ version: 4, boundaries: { topic: 'Example Org: our clients, products and engineering.!' } })
  })

  it('a relay without the route (404) says so, and is not asked again', async () => {
    const s = server({ override: (c) => (c.path === '/api/boundaries' ? json({ error: 'not_found' }, 404) : null) })
    renderWithClient(<App />)
    const region = await section()
    expect(await within(region).findByText(/This relay does not keep boundaries yet/)).toBeInTheDocument()
    expect(s.calls.filter((c) => c.path === '/api/boundaries')).toHaveLength(1)
  })

  it('a failed read, or an answer that breaks the rule, says so and can be tried again', async () => {
    let answer: Response | null = json({ error: 'internal' }, 500)
    server({ override: (c) => (c.path === '/api/boundaries' ? answer : null) })
    const user = userEvent.setup()
    renderWithClient(<App />)
    const region = await section()
    expect(await within(region).findByRole('alert')).toHaveTextContent('The boundaries could not be read.')
    answer = json({ team: 'demo', version: 2, boundaries: { topic: 'T', extra: 1 } })
    await user.click(within(region).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(within(region).getByRole('button', { name: 'Try again' })).toBeEnabled())
    expect(within(region).getByRole('alert')).toHaveTextContent('The boundaries could not be read.')
    answer = null
    await user.click(within(region).getByRole('button', { name: 'Try again' }))
    expect(await within(region).findByRole('form', { name: 'Team boundaries' })).toBeInTheDocument()
  })
})

describe('creating a team goes straight to its boundaries (M10 §1)', () => {
  it('opens Team settings at Boundaries with the topic focused', async () => {
    window.history.replaceState(null, '', '/team')
    const s = server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Switch team/ })).toHaveTextContent('Demo'))
    await user.click(screen.getByRole('button', { name: /Switch team/ }))
    await user.click(within(await screen.findByRole('dialog', { name: 'Your teams' })).getByRole('button', { name: /Create team/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Create a team' })
    await user.type(within(dialog).getByLabelText('Team name'), 'Payments')
    // Every team whose settings are drawn from here on: only the new one, never another in between
    // (the teams are read again slowly, so a page drawn before they arrive would show).
    s.relay.latency = [80, 80]
    const drawn = new Set<string>()
    const seen = new MutationObserver(() => {
      for (const el of document.querySelectorAll('[data-settings-team]')) drawn.add(el.getAttribute('data-settings-team') ?? '')
    })
    seen.observe(document.body, { childList: true, subtree: true, attributes: true })
    await user.click(within(dialog).getByRole('button', { name: 'Create team' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Switch team/ })).toHaveTextContent('Payments'))
    const form = await ownerForm()
    expect(within(form).getByText(UNSET_LINE)).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(within(form).getByLabelText('Topic')))
    // On the settings page, its own address.
    expect(window.location.pathname).toBe('/settings')
    expect(screen.getByRole('button', { name: 'Team settings' })).toHaveAttribute('aria-current', 'page')
    seen.disconnect()
    expect([...drawn]).toEqual(['payments'])
  })
})

describe('Team settings: a page of its own (/settings)', () => {
  it('is a tab after Setup with its own address; the team page no longer holds it', async () => {
    window.history.replaceState(null, '', '/team')
    server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    await screen.findByRole('region', { name: 'Members' })
    expect(screen.queryByRole('region', { name: 'Team settings' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Boundaries' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Team settings' }))
    expect(window.location.pathname).toBe('/settings')
    const settings = await screen.findByRole('region', { name: 'Team settings' })
    expect(within(settings).getByText('Team id')).toBeInTheDocument()
    expect(within(settings).getByRole('form', { name: 'Delete this team' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Members' })).toBeNull()
    // Back and forward through the history move between the pages.
    await act(async () => {
      window.history.back()
      await new Promise((r) => setTimeout(r, 50))
    })
    await screen.findByRole('region', { name: 'Members' })
    expect(window.location.pathname).toBe('/team')
  })
})

describe('the form rules (lib/boundaries)', () => {
  it('finds the problem with the topic', () => {
    expect(boundariesProblem({ topic: 'Topic' })).toBeNull()
    expect(boundariesProblem({ topic: ' ' })).toMatch(/Say what the team talks about/)
    expect(boundariesProblem({ topic: 'x'.repeat(501) })).toMatch(/501 characters/)
    expect(boundariesProblem({ topic: 'a\u202eb' })).toMatch(/control or invisible character/)
  })

  it('sends the topic trimmed, and nothing else', () => {
    expect(toBoundaries({ topic: '  T  ' })).toEqual({ topic: 'T' })
    expect(draftFrom(null)).toEqual({ topic: '' })
    expect(draftFrom({ topic: 'x' })).toEqual({ topic: 'x' })
  })

  it('words the refusals', () => {
    const relay = (status: number, code: string | null, detail: string | null = null) =>
      new ChangeError('refused', { status: 502, relayStatus: status, relayError: code, detail })
    expect(boundariesRefusal(relay(409, 'version_conflict'))).toMatchObject({ conflict: true })
    expect(boundariesRefusal(relay(403, 'forbidden')).message).toBe('Only team owners can change the boundaries.')
    expect(boundariesRefusal(relay(400, 'invalid_body', 'topic is too long')).message).toBe('topic is too long')
    expect(boundariesRefusal(relay(400, 'invalid_body')).message).toBe('The relay refused this topic. Check it and save again.')
    expect(boundariesRefusal(relay(429, 'rate_limited')).message).toMatch(/Too many changes/)
    expect(boundariesRefusal(new ChangeError('gone', { signedOut: true })).message).toBe('gone')
  })

  it('reads a GET answer: {topic} only; a broken one is not read', () => {
    expect(readTeamBoundaries({ team: 'demo', version: 3, boundaries: { topic: 'T' }, updated_at: null, updated_by: null })).toEqual({
      team: 'demo',
      version: 3,
      boundaries: { topic: 'T' },
      updated_at: null,
      updated_by: null,
    })
    expect(readTeamBoundaries({ team: 'demo', version: 0, boundaries: null, updated_at: null, updated_by: null })?.boundaries).toBeNull()
    expect(readTeamBoundaries({ team: 'demo', version: 3, boundaries: { topic: '' } })).toBeNull()
    expect(readTeamBoundaries({ team: 'demo', version: 3, boundaries: { topic: 'T', other: 1 } })).toBeNull()
    expect(readTeamBoundaries({ team: 'demo', version: 'x', boundaries: null })).toBeNull()
  })
})

// One rule: the relay, the console server, the plugin and this page accept exactly what
// schema/boundaries-vectors.json says.
describe('the one validation rule (schema/boundaries-vectors.json)', () => {
  it('expands every placeholder it names', () => {
    expect(Object.keys(rawVectors.placeholders).sort()).toEqual(Object.keys(PLACEHOLDERS).sort())
    const names = new RegExp(`"(${Object.keys(PLACEHOLDERS).join('|')})"`)
    expect(JSON.stringify([vectors.valid, vectors.invalid, vectors.removed, vectors.normalised, vectors.stored])).not.toMatch(names)
    expect(PLACEHOLDERS.TOPIC_500!.length).toBe(500)
    expect(PLACEHOLDERS.TOPIC_501!.length).toBe(501)
  })

  it.each(vectors.valid.map((b, i) => [i, b] as const))('accepts valid document %i', (_i, b) => {
    expect(boundariesValid(b)).toBe(true)
    expect(readBoundaries(b)).toEqual(b)
    // The form holds it and finds no problem; what it sends passes the rule.
    expect(boundariesProblem(b as { topic: string })).toBeNull()
    expect(boundariesValid(toBoundaries(b as { topic: string }))).toBe(true)
  })

  it.each(vectors.invalid.map((v) => [v.why, v] as const))('refuses: %s', (_why, v) => {
    expect(boundariesValid(v.boundaries)).toBe(false)
    expect(readBoundaries(v.boundaries)).toBeNull()
    // A topic the form can hold (a string) is a problem before anything is sent.
    if (v.field === 'topic' && typeof v.boundaries.topic === 'string') expect(boundariesProblem({ topic: v.boundaries.topic })).not.toBeNull()
  })

  it.each(vectors.removed.map((v, i) => [i, v] as const))('refuses a removed field, naming it: body %i', async (_i, v) => {
    expect(REMOVED_FIELDS).toContain(v.field)
    expect(boundariesValid(v.boundaries)).toBe(false)
    expect(removedField(v.boundaries)).toBe(v.field)
    // The mock relay answers as the relay does.
    const relay = new MockRelay()
    relay.latency = [0, 0]
    const res = await relay.handle('api/boundaries', {
      method: 'PUT',
      headers: { 'X-Relay-Team': 'demo', 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 2, boundaries: v.boundaries }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: 'invalid_body',
      detail: `boundaries.${v.field}: no longer part of a team's boundaries (only the topic is, since 13 Nov 2026)`,
    })
  })

  it.each(vectors.stored.map((v) => [v.why, v] as const))('reads a stored document as its topic alone: %s', (_why, v) => {
    expect(boundariesValid(v.stored)).toBe(false)
    expect(readBoundaries(v.stored)).toEqual(v.expect)
    expect(readTeamBoundaries({ team: 'demo', version: 4, boundaries: v.stored, updated_at: null, updated_by: null })?.boundaries).toEqual(v.expect)
  })

  it.each(vectors.normalised.map((n) => [n.why, n] as const))('sends what the relay stores: %s', (_why, n) => {
    const out = toBoundaries(n.boundaries as { topic: string })
    expect(out).toEqual(n.expect)
    expect(boundariesValid(out)).toBe(true)
  })

  it.each(vectors.versions.valid.map((v) => [JSON.stringify(v), v] as const))('accepts version %s', (_s, v) => {
    expect(versionOk(v)).toBe(true)
  })

  it.each(vectors.versions.invalid.map((v) => [JSON.stringify(v), v] as const))('refuses version %s', (_s, v) => {
    expect(versionOk(v)).toBe(false)
  })
})
