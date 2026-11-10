// M11 §6: the Join checklist's rules, the boundaries' "new" marks, the setup command, the
// invite message, and reading members-status and the acceptance without trusting their shape.

import { describe, expect, it } from 'vitest'

import type { Join, MemberSetupStatus, MemberStatusEntry, TeamBoundaries } from '@/api/types'
import {
  acceptedVersion,
  boundaryItems,
  currentVersion,
  inviteMessage,
  publicOrigin,
  readAcceptance,
  readMembersStatus,
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

const entry = (s: MemberSetupStatus | null, answering = true, accepted = 3): MemberStatusEntry => ({ member: 'alice', status: s, answering, accepted_version: accepted })

const BOUNDS: TeamBoundaries = {
  team: 'demo',
  version: 3,
  boundaries: {
    topic: 'Example Co: orders and payments.',
    github_orgs: ['Example-Org', 'second-org'],
    drives: [
      { domain: 'example.com', shared_drive: 'Team Drive' },
      { domain: 'example.com', shared_drive: 'Clients' },
    ],
    member_folders: true,
  },
  since: {
    github_orgs: { 'example-org': 1, 'second-org': 3 },
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

describe('setupSteps (M11 §6)', () => {
  it('ticks all seven for a Mac that is set up, answering, and has accepted the current version', () => {
    const steps = setupSteps(entry(status()), BOUNDS, 3, 3)
    expect(steps.map((s) => s.id)).toEqual(['setup', 'claude', 'answering', 'folders', 'drive', 'boundaries', 'self_test'])
    expect(steps.every((s) => s.done)).toBe(true)
    expect(setupCount(entry(status()), BOUNDS, 3)).toBe(7)
  })

  it('without any status: nothing ticks but what the team does not need, and each step says what to do', () => {
    const steps = setupSteps(entry(null, false, 0), BOUNDS, 0, 3)
    expect(done(steps)).toEqual({ setup: false, claude: false, answering: false, folders: false, drive: false, boundaries: false, self_test: false })
    for (const s of steps) expect(s.todo).toMatch(/\.$/)
    expect(steps.find((s) => s.id === 'folders')!.todo).toContain('Example-Org and second-org')
    // A team with no orgs and no drives ticks those two.
    const plain = { ...BOUNDS, boundaries: { ...BOUNDS.boundaries!, github_orgs: [], drives: [] } }
    expect(done(setupSteps(null, plain, 0, 3))).toMatchObject({ folders: true, drive: true, setup: false })
  })

  it('each check reads its own field', () => {
    expect(done(setupSteps(entry(status({ found: false })), BOUNDS, 3, 3)).claude).toBe(false)
    expect(setupSteps(entry(status({ found: false })), BOUNDS, 3, 3)[1]!.todo).toMatch(/Install Claude Code/)
    expect(setupSteps(entry(status({ signedIn: false })), BOUNDS, 3, 3)[1]!.todo).toMatch(/claude auth login/)
    expect(done(setupSteps(entry(status(), false), BOUNDS, 3, 3)).answering).toBe(false)
    expect(done(setupSteps(entry(status({ roots: 0 })), BOUNDS, 3, 3)).folders).toBe(false)
    expect(done(setupSteps(entry(status({ drive: false })), BOUNDS, 3, 3)).drive).toBe(false)
    expect(done(setupSteps(entry(status()), BOUNDS, 2, 3)).boundaries).toBe(false)
    const failed = setupSteps(entry(status({ ok: false, reason: 'Claude Code is not signed in.' })), BOUNDS, 3, 3)
    expect(done(failed).self_test).toBe(false)
    expect(failed[6]!.todo).toBe('The self-test failed (Claude Code is not signed in); fix that, then run the setup command again.')
  })

  it('boundaries not read (still loading, or failed): folders and Drive are not known, never ticked', () => {
    const bare = entry(status({ roots: 0, drive: false }))
    for (const unread of [undefined, null]) {
      const steps = setupSteps(bare, unread, 3, 3)
      expect(done(steps)).toMatchObject({ folders: false, drive: false })
      expect(steps[3]!.todo).toBe("Not known yet: the team's boundaries have not loaded.")
      expect(steps[4]!.todo).toBe("Not known yet: the team's boundaries have not loaded.")
    }
    // Not even a Mac that reports folders and Drive ticks them while they are not known.
    expect(done(setupSteps(entry(status()), undefined, 3, 3))).toMatchObject({ folders: false, drive: false })
    // Read and never set: nothing to choose, nothing to connect.
    const none: TeamBoundaries = { team: 'demo', version: 0, boundaries: null, since: null, updated_at: null, updated_by: null }
    expect(done(setupSteps(bare, none, 0, 0))).toMatchObject({ folders: true, drive: true })
  })

  it('boundaries never set: step 6 waits for an owner, and cannot tick', () => {
    const none: TeamBoundaries = { team: 'demo', version: 0, boundaries: null, since: null, updated_at: null, updated_by: null }
    const step = setupSteps(entry(status()), none, 0, 0)[5]!
    expect(step.done).toBe(false)
    expect(step.todo).toMatch(/An owner has not set/)
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

describe('the setup command and the invite message', () => {
  const join: Join = { relay_url: 'https://relay.example.com/', team: 'demo', repo_url: null, marketplace: 'team-relay-dev', plugin: 'team-relay' }
  it('hosted: the page origin; local: the relay https origin', () => {
    expect(publicOrigin({ hostname: 'team.example.com', origin: 'https://team.example.com' }, undefined)).toBe('https://team.example.com')
    expect(publicOrigin({ hostname: 'team.example.com', origin: 'http://team.example.com' }, join)).toBeNull()
    expect(publicOrigin({ hostname: '127.0.0.1', origin: 'http://127.0.0.1:4545' }, join)).toBe('https://relay.example.com')
    expect(publicOrigin({ hostname: 'localhost', origin: 'http://localhost:4545' }, undefined)).toBeNull()
    expect(publicOrigin({ hostname: 'localhost', origin: 'http://localhost:4545' }, { ...join, relay_url: 'http://relay.example.com' })).toBeNull()
    expect(publicOrigin({ hostname: 'localhost', origin: 'http://localhost:4545' }, { ...join, relay_url: 'https://u:p@relay.example.com' })).toBeNull()
    expect(publicOrigin({ hostname: 'localhost', origin: 'http://localhost:4545' }, { ...join, relay_url: 'not a url' })).toBeNull()
  })
  it('builds the one command and the plain-text message', () => {
    expect(setupCommand('https://team.example.com')).toBe('curl -fsSL https://team.example.com/setup | bash')
    expect(inviteMessage('Demo\nteam', 'https://team.example.com')).toBe(
      [
        "You're invited to the team Demo team on Team relay.",
        '',
        'Console: https://team.example.com/',
        'Setup command (run it in Terminal on your Mac): curl -fsSL https://team.example.com/setup | bash',
        '',
        'Open the link, accept the invitation, then follow the checklist.',
      ].join('\n'),
    )
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
    expect(out.members[2]).toEqual({ member: 'dana', status: null, answering: false, accepted_version: 0 })
    expect(readMembersStatus({ members: 'x', boundaries_version: 1 })).toBeNull()
    expect(readMembersStatus({ ok: true })).toBeNull()
    expect(readMembersStatus(null)).toBeNull()
  })
  it('acceptance: {version, accepted_at} or null', () => {
    expect(readAcceptance({ version: 2, accepted_at: '2026-11-10T00:00:00Z' })).toEqual({ version: 2, accepted_at: '2026-11-10T00:00:00Z' })
    expect(readAcceptance({ version: 0 })).toEqual({ version: 0, accepted_at: null })
    expect(readAcceptance({ version: '2' })).toBeNull()
    expect(readAcceptance([])).toBeNull()
  })
})
