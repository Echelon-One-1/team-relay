// M11 §6 and "Simpler joining": the three steps' rules (with the Mac's own checks inside the
// first), the boundaries' "new" marks, the setup line, the invite message, and reading
// members-status and the acceptance without trusting their shape.

import { describe, expect, it } from 'vitest'

import type { Join, MemberSetupStatus, MemberSources, MemberStatusEntry, TeamBoundaries } from '@/api/types'
import {
  acceptedVersion,
  boundaryItems,
  CLONE_TODO,
  currentVersion,
  inviteMessage,
  hasJoined,
  macChecks,
  missingNames,
  missingSources,
  publicOrigin,
  readAcceptance,
  readMembersStatus,
  SELF_TEST_PENDING,
  SETUP_STEPS,
  setupCommand,
  setupCount,
  setupSteps,
} from './setup'

const NOW = Date.parse('2026-11-10T10:00:00Z')

function status(o: Partial<{ found: boolean; signedIn: boolean; roots: number; drive: boolean; ok: boolean; reason: string | null }> = {}): MemberSetupStatus {
  return {
    daemon: { version: '0.11.0', started_at: new Date(NOW - 3_600_000).toISOString() },
    claude: { found: o.found ?? true, signed_in: o.signedIn ?? true },
    folders: { repo_roots: o.roots ?? 1, clones: 4, extra_folders: 0 },
    drive: { connected: o.drive ?? true },
    self_test: { ok: o.ok ?? true, at: new Date(NOW - 60_000).toISOString(), reason: o.reason ?? null },
    seen_at: new Date(NOW - 10_000).toISOString(),
  }
}

const entry = (s: MemberSetupStatus | null, answering = true, accepted = 3, sources: MemberSources | null = null): MemberStatusEntry => ({
  member: 'alice',
  status: s,
  answering,
  accepted_version: accepted,
  sources,
})

const DRIVE_ID = '0AExampleDriveId0PVA'
const FOLDER_ID = '1ExampleFolderClients0000000000a'

const BOUNDS: TeamBoundaries = {
  team: 'demo',
  version: 3,
  boundaries: {
    topic: 'Example Co: orders and payments.',
    github_orgs: ['Example-Org', 'second-org'],
    github_repos: [],
    drive_folders: [],
    drives: [
      { domain: 'example.com', shared_drive: 'Team Drive' },
      { domain: 'example.com', shared_drive: 'Clients' },
    ],
    member_folders: true,
  },
  since: {
    github_orgs: { 'example-org': 1, 'second-org': 3 },
    github_repos: {},
    drive_folders: {},
    drives: [
      { domain: 'example.com', shared_drive: 'Team Drive', since: 1 },
      { domain: 'example.com', shared_drive: 'Clients', since: 2 },
    ],
    member_folders: 3,
  },
  updated_at: '2026-11-09T10:00:00Z',
  updated_by: 'olga',
}

const done = (steps: ReturnType<typeof setupSteps>) => Object.fromEntries(steps.map((s) => [s.id, s.done]))
// `b` left out: the team's boundaries (BOUNDS); passed as undefined or null: not read.
type Read = TeamBoundaries | null | undefined
const checks = (e: MemberStatusEntry | null, ...b: [Read?]) => Object.fromEntries(macChecks(e, b.length ? b[0] : BOUNDS).map((c) => [c.id, c.done]))
const todo = (e: MemberStatusEntry | null, id: string, ...b: [Read?]) => macChecks(e, b.length ? b[0] : BOUNDS).find((c) => c.id === id)!.todo

describe('setupSteps: two plain steps', () => {
  it('both done for a Mac that is set up and answering, and the current version accepted', () => {
    const steps = setupSteps(entry(status()), BOUNDS, 3, 3)
    expect(steps.map((s) => [s.id, s.title])).toEqual([
      ['mac', 'Set up your Mac'],
      ['accept', 'Accept what the team shares'],
    ])
    expect(SETUP_STEPS).toBe(2)
    expect(steps.every((s) => s.done)).toBe(true)
    expect(setupCount(entry(status()), BOUNDS, 3)).toBe(2)
    expect(setupCount(entry(status(), true, 2), BOUNDS, 3)).toBe(1)
  })

  it('joined (the join card goes): the Mac has reported once and the member has accepted once', () => {
    expect(hasJoined(entry(null, false, 0), BOUNDS, 0)).toBe(false)
    expect(hasJoined(null, BOUNDS, 0)).toBe(false)
    expect(hasJoined(entry(status()), BOUNDS, 0)).toBe(false)
    expect(hasJoined(entry(status()), BOUNDS, 3)).toBe(true)
    // Later trouble does not undo joining: the Mac off, an older version accepted.
    expect(hasJoined(entry(status({ drive: false }), false), BOUNDS, 2)).toBe(true)
    // Nothing to accept yet (or not read yet): the Mac reporting is enough.
    const none: TeamBoundaries = { team: 'demo', version: 0, boundaries: null, since: null, updated_at: null, updated_by: null }
    expect(hasJoined(entry(status()), none, 0)).toBe(true)
    expect(hasJoined(entry(null), none, 0)).toBe(false)
  })

  it('without any status: the only check is running the setup line', () => {
    const steps = setupSteps(entry(null, false, 0), BOUNDS, 0, 3)
    expect(done(steps)).toEqual({ mac: false, accept: false })
    expect(steps[0]!.checks).toEqual([
      { id: 'setup', done: false, todo: 'Paste the setup line into Terminal on your Mac, press Enter and answer its questions.' },
    ])
    expect(setupSteps(null, BOUNDS, 0, 3)[0]!.checks.map((c) => c.id)).toEqual(['setup'])
  })

  it('the Mac step needs every old check: each reads its own field, and says in one plain sentence what to do', () => {
    expect(checks(entry(status()))).toEqual({ setup: true, claude: true, answering: true, folders: true, drive: true, self_test: true })
    expect(checks(entry(status({ found: false }))).claude).toBe(false)
    expect(todo(entry(status({ found: false })), 'claude')).toBe("Claude Code isn't on your Mac yet. Run the setup line again and say yes when it offers to install it.")
    expect(todo(entry(status({ signedIn: false })), 'claude')).toBe("Claude Code isn't signed in on your Mac. Run the setup line again and sign in when it asks.")
    expect(checks(entry(status(), false)).answering).toBe(false)
    expect(todo(entry(status(), false), 'answering')).toBe("Your Mac isn't answering right now. Make sure it's switched on; if this stays, run the setup line again.")
    expect(checks(entry(status({ roots: 0 }))).folders).toBe(false)
    expect(todo(entry(status({ roots: 0 })), 'folders')).toBe(
      "Your Mac doesn't know where your Example-Org and second-org project folders are yet. Run the setup line again and pick them.",
    )
    expect(checks(entry(status({ drive: false }))).drive).toBe(false)
    expect(todo(entry(status({ drive: false })), 'drive')).toBe("Google Drive isn't connected yet. Run the setup line again and sign in to Google when it asks.")
    for (const e of [status({ found: false }), status({ roots: 0 }), status({ drive: false })]) {
      expect(done(setupSteps(entry(e), BOUNDS, 3, 3)).mac).toBe(false)
    }
    // Never the technical names.
    const all = macChecks(entry(status({ signedIn: false, roots: 0, drive: false, ok: false, reason: null }), false), BOUNDS).map((c) => c.todo)
    for (const t of all) expect(t).not.toMatch(/daemon|LaunchAgent|plugin|channel|\bCLI\b|\bNode|boundaries|repo root|self-test|command/i)
  })

  it('the self-test: a failure says what to do and what to show an owner; not run yet is checking, not failed', () => {
    const failed = entry(status({ ok: false, reason: 'Claude Code is not signed in.' }))
    expect(checks(failed).self_test).toBe(false)
    expect(todo(failed, 'self_test')).toBe(
      "Your Mac's last check didn't pass. Run the setup line again. If it still doesn't pass, show this to a team owner: Claude Code is not signed in.",
    )
    expect(todo(entry(status({ ok: false, reason: null })), 'self_test')).toBe("Your Mac's last check didn't pass. Run the setup line again.")
    const pending = entry(status({ ok: false, reason: SELF_TEST_PENDING }))
    expect(SELF_TEST_PENDING).toBe('the self-test has not run yet')
    expect(checks(pending).self_test).toBe(false)
    expect(todo(pending, 'self_test')).toBe('Your Mac is checking that everything works. This takes about a minute.')
  })

  it('boundaries not read (still loading, or failed): folders and Drive are not known, never done', () => {
    const bare = entry(status({ roots: 0, drive: false }))
    for (const unread of [undefined, null]) {
      expect(checks(bare, unread)).toMatchObject({ folders: false, drive: false })
      expect(todo(bare, 'folders', unread)).toBe("We couldn't check this yet, because the team's settings haven't loaded. This page tries again in a moment.")
      expect(todo(bare, 'drive', unread)).toBe(todo(bare, 'folders', unread))
    }
    // Not even a Mac that reports folders and Drive counts as set up while they are not known.
    expect(checks(entry(status()), undefined)).toMatchObject({ folders: false, drive: false })
    expect(done(setupSteps(entry(status()), undefined, 3, 3)).mac).toBe(false)
    // Read and never set: nothing to choose, nothing to connect.
    const none: TeamBoundaries = { team: 'demo', version: 0, boundaries: null, since: null, updated_at: null, updated_by: null }
    expect(checks(bare, none)).toMatchObject({ folders: true, drive: true })
    // A team with no orgs and no drives needs neither.
    const plain = { ...BOUNDS, boundaries: { ...BOUNDS.boundaries!, github_orgs: [], drives: [] } }
    expect(checks(bare, plain)).toMatchObject({ folders: true, drive: true })
  })

  it('single repositories need project folders, picked Drive folders need Google Drive (PICKERS-SPEC)', () => {
    const bare = entry(status({ roots: 0, drive: false }))
    const repos = { ...BOUNDS, boundaries: { ...BOUNDS.boundaries!, github_orgs: [], drives: [], github_repos: [{ org: 'labs-org', repo: 'api', id: 1 }] } }
    expect(checks(bare, repos)).toMatchObject({ folders: false, drive: true })
    expect(todo(bare, 'folders', repos)).toBe("Your Mac doesn't know where your labs-org project folders are yet. Run the setup line again and pick them.")
    const folders = {
      ...BOUNDS,
      boundaries: { ...BOUNDS.boundaries!, github_orgs: [], drives: [], drive_folders: [{ domain: 'example.com', drive_id: DRIVE_ID, folder_id: FOLDER_ID, folder_name: 'Clients', drive_name: null }] },
    }
    expect(checks(bare, folders)).toMatchObject({ folders: true, drive: false })
    // Whole orgs and the orgs of repositories, each once.
    const both = { ...BOUNDS, boundaries: { ...BOUNDS.boundaries!, github_repos: [{ org: 'example-org', repo: 'api', id: null }, { org: 'labs-org', repo: 'x', id: 2 }] } }
    expect(todo(bare, 'folders', both)).toMatch(/your Example-Org, second-org and labs-org project folders/)
  })

  it('boundaries never set: accepting cannot be done', () => {
    const none: TeamBoundaries = { team: 'demo', version: 0, boundaries: null, since: null, updated_at: null, updated_by: null }
    expect(setupSteps(entry(status()), none, 0, 0)[1]!.done).toBe(false)
    expect(setupSteps(entry(status()), BOUNDS, 2, 3)[1]!.done).toBe(false)
  })

  it('the accepted version: the acceptance read wins over members-status; the current version is the newer one seen', () => {
    expect(acceptedVersion(entry(status(), true, 2), { version: 3, accepted_at: null })).toBe(3)
    expect(acceptedVersion(entry(status(), true, 2), undefined)).toBe(2)
    expect(acceptedVersion(null, null)).toBe(0)
    expect(currentVersion(BOUNDS, 4)).toBe(4)
    expect(currentVersion(BOUNDS, null)).toBe(3)
    expect(currentVersion(undefined, undefined)).toBe(0)
  })
})

describe('boundaryItems: what is new since the viewer accepted (M10 §7.1 since)', () => {
  const set = BOUNDS as TeamBoundaries & { boundaries: NonNullable<TeamBoundaries['boundaries']> }
  it('marks what was added after the accepted version', () => {
    const items = boundaryItems(set, 1)
    expect(items.orgs).toEqual([
      { name: 'Example-Org', isNew: false },
      { name: 'second-org', isNew: true },
    ])
    expect(items.drives.map((d) => d.isNew)).toEqual([false, true])
    expect(items.memberFolders).toEqual({ allowed: true, isNew: true })
    expect(boundaryItems(set, 2).drives.map((d) => d.isNew)).toEqual([false, false])
  })
  it('marks nothing before a first acceptance, and counts an item since does not name as added now', () => {
    const items = boundaryItems(set, 0)
    expect([...items.orgs, ...items.drives].some((x) => x.isNew)).toBe(false)
    expect(items.memberFolders.isNew).toBe(false)
    const unnamed = boundaryItems({ ...set, since: null }, 2)
    expect(unnamed.orgs.every((o) => o.isNew)).toBe(true)
    // Not allowed: never new.
    expect(boundaryItems({ ...set, boundaries: { ...set.boundaries, member_folders: false } }, 1).memberFolders).toEqual({ allowed: false, isNew: false })
  })
})

describe('boundaryItems: repositories and Drive folders (PICKERS-SPEC §7.3)', () => {
  const picked = {
    ...BOUNDS,
    boundaries: {
      ...BOUNDS.boundaries!,
      github_repos: [
        { org: 'labs-org', repo: 'API', id: 1 },
        { org: 'labs-org', repo: 'web', id: 2 },
        // Of a whole org: never an item.
        { org: 'example-org', repo: 'x', id: 3 },
      ],
      drive_folders: [
        { domain: 'example.com', drive_id: DRIVE_ID, folder_id: DRIVE_ID, folder_name: 'Team', drive_name: 'Team' },
        { domain: 'example.com', drive_id: DRIVE_ID, folder_id: FOLDER_ID, folder_name: 'Clients', drive_name: null },
      ],
    },
    since: { ...BOUNDS.since!, github_repos: { 'labs-org/api': 1, 'labs-org/web': 3 }, drive_folders: { [DRIVE_ID]: 1 } },
  } as TeamBoundaries & { boundaries: NonNullable<TeamBoundaries['boundaries']> }

  it('lists them with their new marks; an item since does not name is new in the current version', () => {
    const items = boundaryItems(picked, 2)
    expect(items.repos).toEqual([
      { name: 'labs-org/API', isNew: false },
      { name: 'labs-org/web', isNew: true },
    ])
    expect(items.folders).toEqual([
      { key: `folder:${DRIVE_ID}`, name: 'Team', where: 'a whole shared drive', isNew: false },
      { key: `folder:${FOLDER_ID}`, name: 'Clients', where: 'in a shared drive', isNew: true },
    ])
  })
})

describe("missing sources: the viewer's own lines, an owner's names (PICKERS-SPEC §7.4, ACC-021, ACC-022)", () => {
  const b = {
    ...BOUNDS,
    version: 5,
    boundaries: {
      ...BOUNDS.boundaries!,
      github_orgs: ['example-org'],
      github_repos: [{ org: 'labs-org', repo: 'api', id: 1 }],
      drive_folders: [{ domain: 'example.com', drive_id: DRIVE_ID, folder_id: FOLDER_ID, folder_name: 'Clients', drive_name: 'Example Team Drive' }],
      drives: [{ domain: 'example.com', shared_drive: 'Old Drive' }],
    },
    since: { github_orgs: { 'example-org': 1 }, github_repos: { 'labs-org/api': 5 }, drive_folders: { [FOLDER_ID]: 2 }, drives: [{ domain: 'example.com', shared_drive: 'Old Drive', since: 1 }], member_folders: 3 },
  } satisfies TeamBoundaries
  const keys = ['repo:labs-org/api', 'org:example-org', `folder:${FOLDER_ID}`, 'drive:example.com/Old Drive'] as MemberSources['missing']

  it('one line per item: the clone line, the org page, Drive guidance', () => {
    const { missing, checking } = missingSources(entry(status(), true, 5, { boundaries_version: 5, missing: keys }), b)
    expect(checking).toEqual([])
    expect(missing).toEqual([
      { kind: 'repo', key: 'repo:labs-org/api', name: 'labs-org/api', command: 'git clone https://github.com/labs-org/api.git', todo: CLONE_TODO },
      {
        kind: 'org',
        key: 'org:example-org',
        name: 'example-org',
        todo: 'No example-org projects found. Clone the ones you work on into the folder you picked for projects.',
        link: 'https://github.com/orgs/example-org/repositories',
      },
      {
        kind: 'folder',
        key: `folder:${FOLDER_ID}`,
        name: 'Clients (in Example Team Drive)',
        todo: "Clients (in Example Team Drive) isn't on this Mac. Make sure Google Drive for desktop is signed in with your work account; if it still doesn't show, ask a team owner for access to the shared drive.",
      },
      {
        kind: 'drive',
        key: 'drive:example.com/Old Drive',
        name: 'Old Drive',
        todo: "The shared drive Old Drive isn't on this Mac. Make sure Google Drive for desktop is signed in with your work account; if it still doesn't show, ask a team owner for access to the shared drive.",
      },
    ])
    expect(CLONE_TODO).toBe('Run it in Terminal inside the folder you picked for projects.')
  })

  it('never a key that is not an item of the current boundaries; nothing without a report', () => {
    const odd = ['repo:labs-org/gone', '/Users/someone/projects/api', 'org:example-org', 'org:example-org'] as MemberSources['missing']  // e1-guard: allow (synthetic macOS home path in a test)
    expect(missingSources(entry(status(), true, 5, { boundaries_version: 5, missing: odd }), b).missing.map((m) => m.key)).toEqual(['org:example-org'])
    expect(missingSources(entry(status(), true, 5, null), b)).toEqual({ missing: [], checking: [] })
    expect(missingSources(null, b)).toEqual({ missing: [], checking: [] })
    expect(missingSources(entry(status(), true, 5, { boundaries_version: 5, missing: keys }), undefined)).toEqual({ missing: [], checking: [] })
  })

  it('a report from an older version: items added since show as checking', () => {
    const { missing, checking } = missingSources(entry(status(), true, 5, { boundaries_version: 3, missing: ['org:example-org'] }), b)
    expect(missing.map((m) => m.key)).toEqual(['org:example-org'])
    expect(checking).toEqual([{ key: 'repo:labs-org/api', name: 'labs-org/api' }])
  })

  it('missing never undoes "Set up your Mac"', () => {
    const e = entry(status(), true, 5, { boundaries_version: 5, missing: keys })
    expect(setupSteps(e, b, 5, 5)[0]!.done).toBe(true)
  })

  it("an owner reads each member's missing items by name", () => {
    expect(missingNames(entry(status(), true, 5, { boundaries_version: 5, missing: keys }), b)).toEqual([
      'labs-org/api',
      'example-org (whole organisation)',
      'Clients (in Example Team Drive)',
      'Old Drive',
    ])
    expect(missingNames(entry(status(), true, 5, null), b)).toEqual([])
  })
})

describe('the setup command and the invite message', () => {
  const join: Join = { relay_url: 'https://relay.example.com/', team: 'demo' }
  it('hosted: the page origin; local: the relay https origin', () => {
    expect(publicOrigin({ hostname: 'team.example.com', origin: 'https://team.example.com' }, undefined)).toBe('https://team.example.com')
    expect(publicOrigin({ hostname: 'team.example.com', origin: 'http://team.example.com' }, join)).toBeNull()
    expect(publicOrigin({ hostname: '127.0.0.1', origin: 'http://127.0.0.1:4545' }, join)).toBe('https://relay.example.com')
    expect(publicOrigin({ hostname: 'localhost', origin: 'http://localhost:4545' }, undefined)).toBeNull()
    expect(publicOrigin({ hostname: 'localhost', origin: 'http://localhost:4545' }, { ...join, relay_url: 'http://relay.example.com' })).toBeNull()
    expect(publicOrigin({ hostname: 'localhost', origin: 'http://localhost:4545' }, { ...join, relay_url: 'https://u:p@relay.example.com' })).toBeNull()
    expect(publicOrigin({ hostname: 'localhost', origin: 'http://localhost:4545' }, { ...join, relay_url: 'not a url' })).toBeNull()
  })
  it('builds the one line and the plain-text message: the link first, then the same three steps as the join card', () => {
    expect(setupCommand('https://team.example.com')).toBe('curl -fsSL https://team.example.com/setup | bash')
    const message = inviteMessage('Demo\nteam', 'https://team.example.com')
    expect(message).toBe(
      [
        "You're invited to the team Demo team on Team relay.",
        '',
        'https://team.example.com/',
        '',
        'Open the link and accept the invitation. Then, on your Mac:',
        '',
        '1. Open Terminal: press Cmd+Space, type Terminal, press Enter.',
        '2. Paste this line and press Enter, then answer its questions:',
        'curl -fsSL https://team.example.com/setup | bash',
        '3. Come back to the page and click Accept.',
      ].join('\n'),
    )
    // Plain text: no markdown.
    expect(message).not.toMatch(/[`*>#]|\]\(/)
  })
})

describe('reading the answers', () => {
  it('members-status: well-formed entries only; not that answer is null', () => {
    const raw = {
      boundaries_version: 2,
      members: [
        { member: 'alice', status: status(), answering: true, accepted_version: 1 },
        { member: 'bob', status: null, answering: false, accepted_version: 0 },
        { member: 'Bad!', status: null, answering: true, accepted_version: 0 },
        { member: 'carol', status: { claude: 'yes' }, answering: true, accepted_version: 0 },
        { member: 'dana', status: null, answering: 'yes', accepted_version: -1 },
      ],
    }
    const out = readMembersStatus(raw)!
    expect(out.members.map((m) => m.member)).toEqual(['alice', 'bob', 'dana'])
    expect(out.members[2]).toEqual({ member: 'dana', status: null, answering: false, accepted_version: 0, sources: null })
    expect(readMembersStatus({ members: 'x', boundaries_version: 1 })).toBeNull()
    expect(readMembersStatus({ ok: true })).toBeNull()
    expect(readMembersStatus(null)).toBeNull()
  })
  it("members-status: a member's sources are kept only when well formed (keys of the four kinds, at most 140)", () => {
    const read = (sources: unknown) => readMembersStatus({ boundaries_version: 2, members: [{ member: 'alice', status: null, answering: false, accepted_version: 0, sources }] })!.members[0]!.sources
    expect(read({ boundaries_version: 2, missing: ['repo:example-org/api', 'org:x', 'repo:example-org/api'] })).toEqual({ boundaries_version: 2, missing: ['repo:example-org/api', 'org:x'] })
    expect(read({ boundaries_version: 2, missing: [] })).toEqual({ boundaries_version: 2, missing: [] })
    expect(read(undefined)).toBeNull()
    expect(read(null)).toBeNull()
    expect(read({ boundaries_version: -1, missing: [] })).toBeNull()
    expect(read({ boundaries_version: 2, missing: 'org:x' })).toBeNull()
    expect(read({ boundaries_version: 2, missing: ['/Users/someone/api'] })).toBeNull()  // e1-guard: allow (synthetic macOS home path in a test)
    expect(read({ boundaries_version: 2, missing: ['org:a\u0007b'] })).toBeNull()
    expect(read({ boundaries_version: 2, missing: [`drive:${'k'.repeat(400)}`] })).toBeNull()
    expect(read({ boundaries_version: 2, missing: Array.from({ length: 141 }, (_, i) => `org:o${i}`) })).toBeNull()
  })

  it('acceptance: {version, accepted_at} or null', () => {
    expect(readAcceptance({ version: 2, accepted_at: '2026-11-10T00:00:00Z' })).toEqual({ version: 2, accepted_at: '2026-11-10T00:00:00Z' })
    expect(readAcceptance({ version: 0 })).toEqual({ version: 0, accepted_at: null })
    expect(readAcceptance({ version: '2' })).toBeNull()
    expect(readAcceptance([])).toBeNull()
  })
})
