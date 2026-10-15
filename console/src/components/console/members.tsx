import { ShieldCheck } from 'lucide-react'
import { useCallback, useId, useRef, useState, type FormEvent } from 'react'

import type { ChangeError } from '@/api/client'
import type { Roster, RosterMember } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useRosterChange } from '@/hooks/queries'
import { addProblem, entries, isInvited, ownerCount, sortedMembers, suggestMemberId, visibleEmails } from '@/lib/roster'
import { readStored, writeStored } from '@/lib/stored'
import { cn } from '@/lib/utils'
import { Avatar, Panel } from './primitives'

// The Members panel (M6 §4). An owner invites a member by Google email (with a member id
// suggested from the email's local part, editable), removes one after a confirm step that
// names the person, and makes or unmakes owners; every refusal is shown inline, where it
// happened. A member sees a read-only list of names and roles. M9 §7.2: an addition is an
// invitation until its person accepts (at sign-in, or in the console); the owner sees it as
// Invited, and can withdraw it (which retires nothing). The panel folds away to its header
// (with the counts still showing), and stays as the viewer left it in this browser.

export const MEMBERS_STORAGE_KEY = 'team-relay-console.members'

function useMembersOpen(): [boolean, () => void] {
  const [open, setOpen] = useState(() => readStored(MEMBERS_STORAGE_KEY) !== 'closed')
  const toggle = useCallback(() => {
    const next = !open
    writeStored(MEMBERS_STORAGE_KEY, next ? 'open' : 'closed')
    setOpen(next)
  }, [open])
  return [open, toggle]
}

function RoleBadge() {
  return (
    <span className="inline-flex h-[18px] items-center gap-1 rounded bg-signal-soft px-1.5 text-[10.5px] font-medium text-signal">
      <ShieldCheck aria-hidden className="size-3" />
      Owner
    </span>
  )
}

function InlineError({ id, children }: { id?: string; children: string | null }) {
  if (!children) return null
  return (
    <p id={id} role="alert" className="text-[12px] leading-snug text-bad" data-error>
      {children}
    </p>
  )
}

function InvitedBadge() {
  return (
    <span className="inline-flex h-[18px] items-center rounded border border-dashed border-faint px-1.5 text-[10.5px] font-medium text-subtle">
      Invited
    </span>
  )
}

function who(m: RosterMember): string {
  const emails = visibleEmails(m)
  return emails.length > 0 ? `${m.member} (${emails.join(', ')})` : m.member
}

function MemberRow({ m, me, owner, lastOwner }: { m: RosterMember; me: string | null; owner: boolean; lastOwner: boolean }) {
  const change = useRosterChange()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const you = m.member === me
  const emails = visibleEmails(m)
  const errorId = useId()
  const invited = isInvited(m)

  const run = (c: Parameters<typeof change.mutate>[0], after?: () => void) => {
    setError(null)
    change.mutate(c, {
      onSuccess: () => after?.(),
      onError: (err: ChangeError) => setError(err.message),
    })
  }

  return (
    <li className="flex flex-col gap-1.5 px-4 py-2.5" data-member={m.member} data-role={m.role} data-status={invited ? 'invited' : 'active'}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className={cn(invited && 'opacity-55')}>
          <Avatar member={m.member} you={you} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-center gap-1.5 [&>*:not(:first-child)]:shrink-0">
            <span className={cn('min-w-0 truncate text-[13px] leading-tight', invited ? 'font-medium text-subtle' : 'font-semibold')}>{m.member}</span>
            {you ? <span className="text-[12px] text-subtle">(you)</span> : null}
            {invited ? (
              <>
                <InvitedBadge />
                {m.role === 'owner' ? <span className="text-[11.5px] text-subtle">as an owner</span> : null}
              </>
            ) : m.role === 'owner' ? (
              <RoleBadge />
            ) : (
              <span className="text-[11.5px] text-subtle">Member</span>
            )}
          </div>
          {owner && emails.length > 0 ? (
            <span className="truncate font-mono text-[11px] text-subtle" title={emails.join(', ')}>
              {emails.join(', ')}
            </span>
          ) : null}
        </div>
        {owner && invited ? (
          <div className="flex shrink-0 items-center gap-1 max-sm:basis-full max-sm:pl-[30px] sm:ml-auto">
            <span className="mr-1 hidden text-[11.5px] text-faint md:inline">Waiting for them to accept</span>
            <Button size="xs" variant="ghost" disabled={change.isPending} onClick={() => run({ kind: 'remove', member: m.member })}>
              {change.isPending ? 'Withdrawing…' : 'Withdraw'}
            </Button>
          </div>
        ) : null}
        {owner && !invited && !confirming ? (
          <div className="flex shrink-0 items-center gap-1 max-sm:basis-full max-sm:pl-[30px] sm:ml-auto">
            {m.role === 'owner' ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={change.isPending || lastOwner}
                title={lastOwner ? 'A team always has at least one owner' : undefined}
                onClick={() => run({ kind: 'role', member: m.member, role: 'member' })}
              >
                Remove owner
              </Button>
            ) : (
              <Button size="xs" variant="ghost" disabled={change.isPending} onClick={() => run({ kind: 'role', member: m.member, role: 'owner' })}>
                Make owner
              </Button>
            )}
            <Button
              size="xs"
              variant="ghost"
              className="text-bad hover:bg-bad-soft hover:text-bad"
              disabled={change.isPending || (m.role === 'owner' && lastOwner)}
              title={m.role === 'owner' && lastOwner ? 'A team always has at least one owner' : undefined}
              onClick={() => {
                setError(null)
                setConfirming(true)
              }}
            >
              Remove
            </Button>
          </div>
        ) : null}
      </div>
      {confirming ? (
        <div
          role="group"
          aria-label={`Remove ${m.member}`}
          aria-describedby={errorId}
          className="ml-[38px] flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-bad/25 bg-bad-soft px-3 py-2"
          data-confirm={m.member}
        >
          <p className="min-w-0 flex-1 text-[12.5px] leading-snug">
            Remove <span className="font-semibold">{who(m)}</span> from the team?{' '}
            <span className="text-subtle">
              {you ? 'You lose access to this team, and ' : 'They lose access at once, and '}
              {you ? 'your' : 'their'} signed-in devices are signed out.
            </span>
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="destructive"
              disabled={change.isPending}
              onClick={() => run({ kind: 'remove', member: m.member }, () => setConfirming(false))}
            >
              {change.isPending ? 'Removing…' : `Remove ${m.member}`}
            </Button>
            <Button size="sm" variant="ghost" disabled={change.isPending} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      <div className="ml-[38px]">
        <InlineError id={errorId}>{error}</InlineError>
      </div>
    </li>
  )
}

const inputClass =
  'h-8 w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-[12.5px] text-foreground shadow-none outline-none transition-colors placeholder:text-faint focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 aria-invalid:border-bad'

function AddMember({ roster }: { roster: Roster | undefined }) {
  const change = useRosterChange()
  const [email, setEmail] = useState('')
  const [member, setMember] = useState('')
  const edited = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState<string | null>(null)
  const emailId = useId()
  const memberId = useId()
  const errorId = useId()
  const taken = entries(roster).map((m) => m.member)

  const onEmail = (v: string) => {
    setEmail(v)
    setAdded(null)
    setError(null)
    // The id follows the email until the owner edits it.
    if (!edited.current) setMember(v.includes('@') || v.trim() ? suggestMemberId(v, taken) : '')
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const address = email.trim().toLowerCase()
    // An emptied id field falls back to the suggestion from the email.
    const id = member === '' ? suggestMemberId(address, taken) : member
    if (id !== member) setMember(id)
    const problem = addProblem(roster, id, address)
    if (problem) {
      setError(problem)
      return
    }
    setError(null)
    change.mutate(
      { kind: 'add', member: id, email: address },
      {
        onSuccess: () => {
          setAdded(member)
          setEmail('')
          setMember('')
          edited.current = false
        },
        onError: (err: ChangeError) => setError(err.message),
      },
    )
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-2.5 px-4 py-3.5" aria-label="Invite a member" data-add-member>
      <div className="flex flex-col gap-0.5">
        <h3 className="text-[12.5px] font-semibold">Invite a member</h3>
        <p className="text-[12px] leading-snug text-subtle">
          They accept with this Google account when they sign in, or here in the console. The member id is how teammates
          address them.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] sm:items-end">
        <label htmlFor={emailId} className="flex min-w-0 flex-col gap-1">
          <span className="text-[11.5px] text-subtle">Google email</span>
          <input
            id={emailId}
            type="email"
            inputMode="email"
            autoComplete="off"
            spellCheck={false}
            placeholder="name@example.com"
            value={email}
            onChange={(e) => onEmail(e.target.value)}
            aria-invalid={error !== null && error.toLowerCase().includes('email') ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className={inputClass}
          />
        </label>
        <label htmlFor={memberId} className="flex min-w-0 flex-col gap-1">
          <span className="text-[11.5px] text-subtle">Member id</span>
          <input
            id={memberId}
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="name"
            value={member}
            maxLength={32}
            onChange={(e) => {
              // Typed ids are tidied as they go: lower case, and a space, - or . becomes _.
              const tidy = e.target.value
                .toLowerCase()
                .replace(/[\s.-]/g, '_')
                .replace(/[^a-z0-9_]/g, '')
              edited.current = tidy !== ''
              setMember(tidy)
              setError(null)
              setAdded(null)
            }}
            aria-invalid={error !== null && error.toLowerCase().includes('member id') ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className={cn(inputClass, 'font-mono text-[12px]')}
          />
        </label>
        <Button type="submit" size="default" disabled={change.isPending || email.trim() === ''}>
          {change.isPending ? 'Inviting…' : 'Invite'}
        </Button>
      </div>
      <InlineError id={errorId}>{error}</InlineError>
      {added ? (
        <p role="status" className="text-[12px] text-ok" data-added={added}>
          Invited {added}. Send them the install steps from Join the team; they accept when they sign in.
        </p>
      ) : null}
    </form>
  )
}

export function Members({
  roster,
  loading,
  failed,
  me,
  owner,
  className,
}: {
  roster: Roster | undefined
  loading: boolean
  failed: boolean
  me: string | null
  owner: boolean
  className?: string
}) {
  const members = sortedMembers(roster)
  const owners = ownerCount(roster)
  const invitedCount = members.filter(isInvited).length
  const activeCount = members.length - invitedCount
  const [open, toggle] = useMembersOpen()
  return (
    <Panel
      id="members"
      title="Members"
      className={className}
      collapse={{ open, onToggle: toggle }}
      aside={
        roster ? (
          <span className="tnum text-[12px] text-subtle">
            {activeCount} {activeCount === 1 ? 'member' : 'members'}, {owners} {owners === 1 ? 'owner' : 'owners'}
            {invitedCount > 0 ? `, ${invitedCount} invited` : ''}
          </span>
        ) : null
      }
    >
      {loading ? (
        <div className="flex flex-col gap-2 p-4">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : failed && !roster ? (
        <p className="px-4 py-5 text-[12.5px] text-subtle">The member list did not load. It is read again in a moment.</p>
      ) : (
        <div className={cn('grid grid-cols-1', owner && 'lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] lg:divide-x lg:divide-hairline')}>
          <ul className="divide-y divide-hairline" aria-label="Team members" data-members-view={owner ? 'owner' : 'member'}>
            {members.map((m) => (
              <MemberRow key={m.member} m={m} me={me} owner={owner} lastOwner={m.role === 'owner' && owners <= 1} />
            ))}
          </ul>
          {owner ? (
            <div className="border-t border-hairline lg:border-t-0">
              <AddMember roster={roster} />
            </div>
          ) : (
            <p className="border-t border-hairline px-4 py-2.5 text-[12px] text-subtle">
              Owners invite and remove members. Ask an owner to invite someone.
            </p>
          )}
        </div>
      )}
    </Panel>
  )
}
