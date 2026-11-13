// M11 §6 and "Simpler joining": the two steps' rules (with the Mac's own checks inside the
// first), the folder count an owner reads, the setup line, the invite message, and reading
// members-status and the acceptance without trusting their shape.

import { describe, expect, it } from 'vitest'

import type { Join, MemberSetupStatus, MemberStatusEntry, TeamBoundaries } from '@/api/types'
import { vectors } from '@/test/vectors'
import {
  acceptedVersion,
  currentVersion,
  folderCountText,
  FOLDERS_TODO,
  FOLDERS_UNREADABLE_TODO,
  inviteMessage,
  hasJoined,
  isAccepted,
  macChecks,
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

function status(o: Partial<{ found: boolean; signedIn: boolean; ok: boolean; reason: string | null }> = {}): MemberSetupStatus {
  return {
    daemon: { version: '0.11.0', started_at: new Date(NOW - 3_600_000).toISOString() },
    claude: { found: o.found ?? true, signed_in: o.signedIn ?? true },
    self_test: { ok: o.ok ?? true, at: new Date(NOW - 60_000).toISOString(), reason: o.reason ?? null },
    seen_at: new Date(NOW - 10_000).toISOString(),
  }
}

const entry = (s: MemberSetupStatus | null, answering = true, accepted = 3, folderCount: number | null = 2, foldersOk: boolean | null = true): MemberStatusEntry => ({
  member: 'alice',
  status: s,
  answering,
  accepted_version: accepted,
  folder_count: folderCount,
  folders_ok: foldersOk,
})

const BOUNDS: TeamBoundaries = {
  team: 'demo',
  version: 3,
  boundaries: { topic: 'Example Co: orders and payments.' },
  updated_at: '2026-11-09T10:00:00Z',
  updated_by: 'olga',
}
const NONE: TeamBoundaries = { team: 'demo', version: 0, boundaries: null, updated_at: null, updated_by: null }

const done = (steps: ReturnType<typeof setupSteps>) => Object.fromEntries(steps.map((s) => [s.id, s.done]))
const checks = (e: MemberStatusEntry | null) => Object.fromEntries(macChecks(e).map((c) => [c.id, c.done]))
const todo = (e: MemberStatusEntry | null, id: string) => macChecks(e).find((c) => c.id === id)!.todo

describe('setupSteps: two plain steps', () => {
  it('both done for a Mac that is set up and answering, and the current version accepted', () => {
    const steps = setupSteps(entry(status()), BOUNDS, 3, 3)
    expect(steps.map((s) => [s.id, s.title])).toEqual([
      ['mac', 'Set up your Mac'],
      ['accept', "Accept the team's topic"],
    ])
    expect(SETUP_STEPS).toBe(2)
    expect(steps.every((s) => s.done)).toBe(true)
    expect(setupCount(entry(status()), BOUNDS, 3)).toBe(2)
    // An acceptance of an earlier version holds (the topic widens nothing); one of a later version
    // (an earlier team under the same id) and none at all do not.
    expect(setupCount(entry(status(), true, 2), BOUNDS, 3)).toBe(2)
    expect(setupCount(entry(status(), true, 4), BOUNDS, 3)).toBe(1)
    expect(setupCount(entry(status(), true, 0), BOUNDS, 3)).toBe(1)
  })

  it('joined (the join card goes): the Mac has reported once and the member has accepted once', () => {
    expect(hasJoined(entry(null, false, 0), BOUNDS, 0)).toBe(false)
    expect(hasJoined(null, BOUNDS, 0)).toBe(false)
    expect(hasJoined(entry(status()), BOUNDS, 0)).toBe(false)
    expect(hasJoined(entry(status()), BOUNDS, 3)).toBe(true)
    // Later trouble does not undo joining: the Mac off, an older version accepted.
    expect(hasJoined(entry(status({ ok: false }), false, 2, 0), BOUNDS, 2)).toBe(true)
    // Nothing to accept yet (or not read yet): the Mac reporting is enough.
    expect(hasJoined(entry(status()), NONE, 0)).toBe(true)
    expect(hasJoined(entry(null), NONE, 0)).toBe(false)
  })

  it('without any status: the only check is running the setup line', () => {
    const steps = setupSteps(entry(null, false, 0), BOUNDS, 0, 3)
    expect(done(steps)).toEqual({ mac: false, accept: false })
    expect(steps[0]!.checks).toEqual([
      { id: 'setup', done: false, todo: 'Paste the setup line into Terminal on your Mac, press Enter and answer its questions.' },
    ])
    expect(setupSteps(null, BOUNDS, 0, 3)[0]!.checks.map((c) => c.id)).toEqual(['setup'])
  })

  it('the Mac step needs every check: each reads its own field, and says in one plain sentence what to do', () => {
    expect(checks(entry(status()))).toEqual({ setup: true, claude: true, answering: true, folders: true, self_test: true })
    expect(checks(entry(status({ found: false }))).claude).toBe(false)
    expect(todo(entry(status({ found: false })), 'claude')).toBe("Claude Code isn't on your Mac yet. Run the setup line again and say yes when it offers to install it.")
    expect(todo(entry(status({ signedIn: false })), 'claude')).toBe("Claude Code isn't signed in on your Mac. Run the setup line again and sign in when it asks.")
    expect(checks(entry(status(), false)).answering).toBe(false)
    expect(todo(entry(status(), false), 'answering')).toBe("Your Mac isn't answering right now. Make sure it's switched on; if this stays, run the setup line again.")
    for (const e of [entry(status({ found: false })), entry(status(), true, 3, 0)]) {
      expect(done(setupSteps(e, BOUNDS, 3, 3)).mac).toBe(false)
    }
    // Never the technical names.
    const all = macChecks(entry(status({ signedIn: false, ok: false, reason: null }), false, 3, 0)).map((c) => c.todo)
    for (const t of all) expect(t).not.toMatch(/daemon|LaunchAgent|plugin|channel|\bCLI\b|\bNode|boundaries|repo root|self-test|command/i)
  })

  it('folders: a Mac that reported no folder chosen is told to choose them; nothing about sources, clones or Drive', () => {
    expect(checks(entry(status(), true, 3, 0)).folders).toBe(false)
    expect(todo(entry(status(), true, 3, 0), 'folders')).toBe(FOLDERS_TODO)
    expect(FOLDERS_TODO).toBe(
      "Your Mac has no folders chosen yet, so your Claude can't read anything for teammates. Run the setup line again and choose your folders.",
    )
    expect(checks(entry(status(), true, 3, 1)).folders).toBe(true)
    expect(checks(entry(status(), true, 3, 20)).folders).toBe(true)
    // Not known (another member's count, which only owners read): never shown as missing.
    expect(checks(entry(status(), true, 3, null)).folders).toBe(true)
    for (const c of macChecks(entry(status(), true, 3, 0))) expect(c.todo).not.toMatch(/drive|github|clone|source|repo/i)
  })

  it("folders: a folders file the Mac can't use says how to see why and fix it; a readable one does not", () => {
    const bad = entry(status(), true, 3, 0, false)
    expect(checks(bad).folders).toBe(false)
    expect(todo(bad, 'folders')).toBe(FOLDERS_UNREADABLE_TODO)
    expect(FOLDERS_UNREADABLE_TODO).toBe("Your Mac can't read your folders settings. Run /team-relay:folders in Claude to see why and fix them.")
    expect(done(setupSteps(bad, BOUNDS, 3, 3)).mac).toBe(false)
    // false wins whatever the count says; true or null (not known) leaves the count to decide.
    expect(checks(entry(status(), true, 3, 2, false)).folders).toBe(false)
    expect(todo(entry(status(), true, 3, 0, true), 'folders')).toBe(FOLDERS_TODO)
    expect(todo(entry(status(), true, 3, 0, null), 'folders')).toBe(FOLDERS_TODO)
    expect(checks(entry(status(), true, 3, 2, null)).folders).toBe(true)
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

  it('boundaries never set: accepting cannot be done', () => {
    expect(setupSteps(entry(status()), NONE, 0, 0)[1]!.done).toBe(false)
    expect(setupSteps(entry(status()), NONE, 1, 0)[1]!.done).toBe(false)
    expect(setupSteps(entry(status()), BOUNDS, 0, 3)[1]!.done).toBe(false)
  })

  it('an acceptance holds for any version from 1 up to the current one (as the plugin counts it)', () => {
    expect(isAccepted(0, 3)).toBe(false)
    expect(isAccepted(1, 3)).toBe(true)
    expect(isAccepted(3, 3)).toBe(true)
    expect(isAccepted(4, 3)).toBe(false)
    expect(isAccepted(1, 0)).toBe(false)
    expect(setupSteps(entry(status()), BOUNDS, 1, 3)[1]!.done).toBe(true)
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

describe("a member's folder count, as an owner reads it", () => {
  it('"1 folder", "N folders"', () => {
    expect(folderCountText(0)).toBe('0 folders')
    expect(folderCountText(1)).toBe('1 folder')
    expect(folderCountText(5)).toBe('5 folders')
    expect(folderCountText(20)).toBe('20 folders')
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
    expect(out.members[2]).toEqual({ member: 'dana', status: null, answering: false, accepted_version: 0, folder_count: null, folders_ok: null })
    expect(readMembersStatus({ members: 'x', boundaries_version: 1 })).toBeNull()
    expect(readMembersStatus({ ok: true })).toBeNull()
    expect(readMembersStatus(null)).toBeNull()
  })
  it("members-status: a member's folder_count is an integer 0..20 (schema/boundaries-vectors.json folder_counts), else null", () => {
    const read = (folder_count: unknown) =>
      readMembersStatus({ boundaries_version: 2, members: [{ member: 'alice', status: status(), answering: false, accepted_version: 0, folder_count }] })!.members[0]!.folder_count
    expect(vectors.folder_counts.valid.length).toBeGreaterThan(0)
    for (const n of vectors.folder_counts.valid) expect(read(n)).toBe(n)
    for (const n of vectors.folder_counts.invalid) expect(read(n)).toBeNull()
    expect(read(undefined)).toBeNull()
  })

  it('members-status: a status never carries folder names, counts by source, or Drive: an older shape keeps only what it reads', () => {
    const old = {
      ...status(),
      folders: { repo_roots: 1, clones: 4, extra_folders: 0 },
      drive: { connected: true },
    }
    const out = readMembersStatus({ boundaries_version: 2, members: [{ member: 'alice', status: old, answering: true, accepted_version: 1, folder_count: 3, sources: { boundaries_version: 2, missing: [] } }] })!
    expect(out.members[0]).toEqual({ member: 'alice', status: status(), answering: true, accepted_version: 1, folder_count: 3, folders_ok: null })
  })

  it("members-status: a member's folders_ok is kept only when it is a boolean", () => {
    const read = (folders_ok: unknown) =>
      readMembersStatus({ boundaries_version: 2, members: [{ member: 'alice', status: status(), answering: false, accepted_version: 0, folder_count: 0, folders_ok }] })!.members[0]!.folders_ok
    expect(read(true)).toBe(true)
    expect(read(false)).toBe(false)
    for (const v of [null, undefined, 0, 1, 'false', {}]) expect(read(v)).toBeNull()
  })

  it('acceptance: {version, accepted_at} or null', () => {
    expect(readAcceptance({ version: 2, accepted_at: '2026-11-10T00:00:00Z' })).toEqual({ version: 2, accepted_at: '2026-11-10T00:00:00Z' })
    expect(readAcceptance({ version: 0 })).toEqual({ version: 0, accepted_at: null })
    expect(readAcceptance({ version: '2' })).toBeNull()
    expect(readAcceptance([])).toBeNull()
  })
})
