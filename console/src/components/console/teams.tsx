import { useQueryClient } from '@tanstack/react-query'
import { Check, ChevronsUpDown, Plus, ShieldCheck, ShieldUser, UserX } from 'lucide-react'
import { useId, useState, type FormEvent, type ReactNode } from 'react'

import type { ChangeError } from '@/api/client'
import type { InvitationEntry, TeamEntry, Teams } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { teamsKey, useTeamChange } from '@/hooks/queries'
import { useNav } from '@/hooks/team'
import { suggestMemberId } from '@/lib/roster'
import {
  createProblem,
  createRefusal,
  deleteRefusal,
  invitationRefusal,
  slotsLeft,
  teamIdFromName,
  tidyTeamId,
  type CreateField,
} from '@/lib/teams'
import { cn } from '@/lib/utils'
import { BoundariesSection } from './boundaries'
import { Panel, RelayMark } from './primitives'

// M9 §5 and §7: the viewer's teams. A switcher in the header (the teams, the open invitations,
// Create team, Admin for relay admins), the Create team dialog, Team settings (M10 §1: the
// team's boundaries, which owners edit and members read; an owner's Delete team), and the page
// for a viewer who is on no team.

const inputClass =
  'h-9 w-full min-w-0 rounded-sm border border-input bg-field px-2.5 text-[12.5px] text-foreground shadow-none outline-none transition-colors placeholder:text-faint focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-bad'

function InlineError({ id, children }: { id?: string; children: string | null }) {
  if (!children) return null
  return (
    <p id={id} role="alert" className="text-[12px] leading-snug text-bad" data-error>
      {children}
    </p>
  )
}

function OwnerMark() {
  return (
    <span className="inline-flex h-[18px] items-center gap-1 rounded bg-signal-soft px-1.5 text-[10.5px] font-medium text-signal">
      <ShieldCheck aria-hidden className="size-3" />
      Owner
    </span>
  )
}

/** A team as a line: its name, and its id beside it when the two differ. */
function TeamLabel({ name, team, className }: { name: string; team: string; className?: string }) {
  return (
    <span className={cn('flex min-w-0 items-baseline gap-1.5', className)}>
      <span className="truncate font-medium">{name}</span>
      {name !== team ? <span className="shrink-0 font-mono text-[11px] text-subtle">{team}</span> : null}
    </span>
  )
}

// ---------------------------------------------------------------------------------------
// Invitations (M9 §7.2)

function Invitation({ inv, onAccepted }: { inv: InvitationEntry; onAccepted?: (team: string) => void }) {
  const change = useTeamChange()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<'accept' | 'decline' | null>(null)
  const answer = (accept: boolean) => {
    setError(null)
    setPending(accept ? 'accept' : 'decline')
    change.mutate(
      { kind: 'answer', team: inv.team, accept },
      {
        onSuccess: () => {
          if (accept) onAccepted?.(inv.team)
        },
        onError: (err: ChangeError) => setError(invitationRefusal(err)),
        onSettled: () => setPending(null),
      },
    )
  }
  return (
    <li className="flex flex-col gap-2 py-2.5" data-invitation={inv.team}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <TeamLabel name={inv.name} team={inv.team} className="text-[13px]" />
        <span className="text-[12px] text-subtle">
          {inv.invited_by_member ? (
            <>
              <span className="font-mono text-[11.5px] text-foreground">{inv.invited_by_member}</span> invited you
            </>
          ) : (
            'You are invited'
          )}{' '}
          as <span className="font-mono text-[11.5px] text-foreground">{inv.member}</span>
          {inv.role === 'owner' ? ', an owner' : ''}.
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <Button size="sm" disabled={change.isPending} onClick={() => answer(true)}>
          {pending === 'accept' ? 'Joining…' : 'Accept'}
        </Button>
        <Button size="sm" variant="ghost" disabled={change.isPending} onClick={() => answer(false)}>
          {pending === 'decline' ? 'Declining…' : 'Decline'}
        </Button>
      </div>
      <InlineError>{error}</InlineError>
    </li>
  )
}

export function InvitationList({ invitations, onAccepted, className }: { invitations: InvitationEntry[]; onAccepted?: (team: string) => void; className?: string }) {
  if (invitations.length === 0) return null
  return (
    <ul className={cn('divide-y divide-hairline', className)} aria-label="Invitations" data-invitations>
      {invitations.map((inv) => (
        <Invitation key={inv.team} inv={inv} onAccepted={onAccepted} />
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------------------
// The switcher (header)

function TeamOption({ t, current, onPick }: { t: TeamEntry; current: boolean; onPick: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        aria-current={current ? 'true' : undefined}
        data-team-option={t.team}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
          current && 'bg-signal-soft hover:bg-signal-soft',
        )}
      >
        <span className="flex w-4 shrink-0 justify-center">{current ? <Check aria-hidden className="size-3.5 text-signal" /> : null}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <TeamLabel name={t.name} team={t.team} className="text-[13px]" />
          <span className="text-[11.5px] text-subtle">
            as <span className="font-mono">{t.member}</span>
          </span>
        </span>
        {t.role === 'owner' ? <OwnerMark /> : null}
      </button>
    </li>
  )
}

export function TeamSwitcher() {
  const nav = useNav()
  const [open, setOpen] = useState(false)
  const teams = nav.teams
  if (!teams) return null
  const current = teams.teams.find((t) => t.team === nav.team) ?? null
  const invitations = teams.invitations.length
  const left = slotsLeft(teams)
  // Another team opens on the same page (an admin goes back to a team's own page).
  const pick = (team: string) => {
    setOpen(false)
    nav.selectTeam(team, undefined, nav.view === 'admin' ? 'team' : nav.view)
  }
  // M11 §6: a team just joined opens on its Join checklist.
  const joined = (team: string) => {
    setOpen(false)
    nav.selectTeam(team, undefined, 'join')
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative inline-flex h-8 min-w-0 max-w-[14rem] sm:max-w-[22rem] items-center gap-1.5 rounded-md px-2 text-[12.5px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted"
          aria-label={`Team ${current?.name ?? nav.team ?? ''}. Switch team${invitations ? `, ${invitations} ${invitations === 1 ? 'invitation' : 'invitations'}` : ''}`}
          data-team-switcher
        >
          {nav.view === 'admin' ? (
            <span className="truncate font-medium">All teams</span>
          ) : current ? (
            <>
              <span className="text-subtle">Team</span>
              <TeamLabel name={current.name} team={current.team} />
            </>
          ) : (
            <span className="truncate font-medium">Choose a team</span>
          )}
          <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 text-subtle" />
          {invitations > 0 ? <span aria-hidden className="absolute top-1 right-0.5 size-1.5 rounded-full bg-signal" data-invitation-dot /> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[22rem] p-1.5" aria-label="Your teams">
        <div className="flex max-h-[min(70vh,34rem)] flex-col overflow-y-auto">
          <p className="px-2 pt-1.5 pb-1 text-[11.5px] font-medium text-subtle">Your teams</p>
          {teams.teams.length > 0 ? (
            <ul className="flex flex-col gap-0.5" aria-label="Your teams">
              {teams.teams.map((t) => (
                <TeamOption key={t.team} t={t} current={nav.view !== 'admin' && t.team === nav.team} onPick={() => pick(t.team)} />
              ))}
            </ul>
          ) : (
            <p className="px-2 pb-2 text-[12px] text-subtle">You are not on a team yet.</p>
          )}
          {invitations > 0 ? (
            <div className="mt-1 border-t border-hairline px-2 pt-2">
              <p className="text-[11.5px] font-medium text-subtle">
                {invitations === 1 ? 'An invitation' : `${invitations} invitations`}
              </p>
              <InvitationList invitations={teams.invitations} onAccepted={joined} />
            </div>
          ) : null}
          <div className="mt-1 flex flex-col gap-0.5 border-t border-hairline pt-1">
            {teams.can_manage_teams ? (
              <button
                type="button"
                disabled={left === 0}
                onClick={() => {
                  setOpen(false)
                  nav.openCreate()
                }}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12.5px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                data-create-team
              >
                <Plus aria-hidden className="size-4 text-subtle" />
                <span className="flex-1 font-medium">Create team</span>
                {left !== null ? <span className="tnum text-[11.5px] text-subtle">{left === 0 ? 'None left' : `${left} left`}</span> : null}
              </button>
            ) : null}
            {teams.admin ? (
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  nav.setView('admin')
                }}
                aria-current={nav.view === 'admin' ? 'page' : undefined}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12.5px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                data-admin-link
              >
                <ShieldUser aria-hidden className="size-4 text-subtle" />
                <span className="flex-1 font-medium">Admin: every team</span>
              </button>
            ) : null}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------------------------------
// Create team (M9 §2)

/** How many of the account's team slots are used: three small marks, filled for each one. */
function Slots({ used, max }: { used: number; max: number }) {
  return (
    <span className="inline-flex items-center gap-1" aria-hidden>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={cn('h-1.5 w-4 rounded-full', i < used ? 'bg-foreground/70' : 'bg-border')} />
      ))}
    </span>
  )
}

export function CreateTeamDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const nav = useNav()
  const qc = useQueryClient()
  const teams = nav.teams
  const change = useTeamChange()
  const [name, setName] = useState('')
  const [id, setId] = useState('')
  const [member, setMember] = useState('')
  // Once typed in (even emptied), a field no longer follows its suggestion.
  const [idEdited, setIdEdited] = useState(false)
  const [memberEdited, setMemberEdited] = useState(false)
  const [error, setError] = useState<{ field: CreateField | null; message: string } | null>(null)
  const ids = { name: useId(), id: useId(), member: useId(), error: useId() }
  const suggestedMember = teams?.suggested_member ?? (teams?.email ? suggestMemberId(teams.email) : '')
  const left = slotsLeft(teams ?? undefined)
  const max = teams?.max_teams_created ?? null

  const reset = () => {
    setName('')
    setId('')
    setMember('')
    setIdEdited(false)
    setMemberEdited(false)
    setError(null)
  }
  const onOpen = (o: boolean) => {
    if (o) reset()
    onOpenChange(o)
  }
  // The id follows the name until it is typed in; emptied, it is made from the name again on create.
  const derivedId = name.trim() ? teamIdFromName(name) : ''
  const effectiveId = idEdited ? id : derivedId
  const effectiveMember = memberEdited ? member : suggestedMember

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const sentId = effectiveId === '' ? derivedId : effectiveId
    const problem = createProblem(name, sentId, effectiveMember)
    if (problem) {
      setError(problem)
      return
    }
    setError(null)
    change.mutate(
      { kind: 'create', name: name.trim(), id: sentId, owner_member_id: effectiveMember },
      {
        onSuccess: async (out) => {
          const created = (out as { team?: unknown } | null)?.team
          onOpenChange(false)
          // M10 §1: straight on to the new team's boundaries, on its settings page; only once the
          // teams read again name it, so no other team's settings are drawn in between. A failed
          // read still goes on: the console then shows what it has, as after any change.
          await qc.refetchQueries({ queryKey: teamsKey }).catch(() => undefined)
          nav.selectTeam(typeof created === 'string' ? created : sentId, 'boundaries', 'settings')
        },
        onError: (err: ChangeError) => setError(createRefusal(err, max)),
      },
    )
  }
  const invalid = (field: CreateField) => (error?.field === field ? true : undefined)

  return (
    <Dialog open={open} onOpenChange={onOpen}>
      <DialogContent aria-describedby={ids.error} data-create-dialog>
        <form onSubmit={submit} noValidate className="flex flex-col gap-4 p-5" aria-label="Create a team">
          <div className="flex flex-col gap-1 pr-8">
            <DialogTitle>Create a team</DialogTitle>
            <DialogDescription>
              You become its owner, and invite teammates by their Google email. Their Claude sessions can then ask each
              other questions.
            </DialogDescription>
          </div>
          <label htmlFor={ids.name} className="flex flex-col gap-1">
            <span className="text-[11.5px] text-subtle">Team name</span>
            <input
              id={ids.name}
              type="text"
              autoComplete="off"
              maxLength={60}
              placeholder="Payments platform"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setError(null)
              }}
              aria-invalid={invalid('name')}
              aria-describedby={error?.field === 'name' ? ids.error : undefined}
              className={inputClass}
              autoFocus
            />
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor={ids.id} className="text-[11.5px] text-subtle">
                Team id
              </label>
              <input
                id={ids.id}
                type="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={32}
                placeholder={derivedId || 'payments-platform'}
                value={effectiveId}
                onChange={(e) => {
                  const v = tidyTeamId(e.target.value)
                  setIdEdited(true)
                  setId(v)
                  setError(null)
                }}
                aria-invalid={invalid('id')}
                aria-describedby={error?.field === 'id' ? `${ids.error} ${ids.id}-hint` : `${ids.id}-hint`}
                className={cn(inputClass, 'font-mono text-[12px]')}
              />
              <span id={`${ids.id}-hint`} className="text-[11px] leading-snug text-faint">
                In commands and links; it cannot change later.
              </span>
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor={ids.member} className="text-[11.5px] text-subtle">
                Your member id
              </label>
              <input
                id={ids.member}
                type="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={32}
                placeholder="alice"
                value={effectiveMember}
                onChange={(e) => {
                  const v = e.target.value
                    .toLowerCase()
                    .replace(/[\s.-]/g, '_')
                    .replace(/[^a-z0-9_]/g, '')
                  setMemberEdited(true)
                  setMember(v)
                  setError(null)
                }}
                aria-invalid={invalid('member')}
                aria-describedby={error?.field === 'member' ? `${ids.error} ${ids.member}-hint` : `${ids.member}-hint`}
                className={cn(inputClass, 'font-mono text-[12px]')}
              />
              <span id={`${ids.member}-hint`} className="text-[11px] leading-snug text-faint">
                How teammates address you.
              </span>
            </div>
          </div>
          <InlineError id={ids.error}>{error?.message ?? null}</InlineError>
          <div className="flex flex-wrap items-center gap-3 border-t border-hairline pt-4">
            {max !== null && teams?.teams_created !== null && teams?.teams_created !== undefined ? (
              <span className="flex items-center gap-2 text-[12px] text-subtle" data-slots-left={left}>
                <Slots used={Math.min(max, teams.teams_created)} max={max} />
                <span className="tnum">
                  {left === 0 ? `You have created ${max} of ${max} teams` : `${left} of ${max} left to create`}
                </span>
              </span>
            ) : null}
            <div className="ml-auto flex items-center gap-1.5">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={change.isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={change.isPending || name.trim() === '' || left === 0}>
                {change.isPending ? 'Creating…' : 'Create team'}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------------------
// Team settings: the boundaries (M10 §1) for everyone on the team; Delete team (M9 §7.7) for owners

export function TeamSettings({ entry, owner, roleKnown = true }: { entry: TeamEntry; owner: boolean; roleKnown?: boolean }) {
  return (
    <Panel id="team-settings" title="Team settings">
      <BoundariesSection owner={owner} roleKnown={roleKnown} />
      <div
        className={cn(
          'grid grid-cols-1 border-t border-hairline',
          owner && 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] lg:divide-x lg:divide-hairline',
        )}
      >
        <dl className="grid grid-cols-[auto_1fr] content-start gap-x-6 gap-y-2 px-4 py-3.5 text-[12.5px]">
          <dt className="text-subtle">Name</dt>
          <dd className="min-w-0 truncate font-medium">{entry.name}</dd>
          <dt className="text-subtle">Team id</dt>
          <dd className="font-mono text-[12px]">{entry.team}</dd>
          <dt className="text-subtle">You</dt>
          <dd>
            <span className="font-mono text-[12px]">{entry.member}</span>, {owner ? 'an owner' : 'a member'}
          </dd>
        </dl>
        {owner ? <DeleteTeam entry={entry} /> : null}
      </div>
    </Panel>
  )
}

function DeleteTeam({ entry }: { entry: TeamEntry }) {
  const nav = useNav()
  const change = useTeamChange()
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)
  const confirmId = useId()
  const errorId = useId()
  const matches = typed === entry.team
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!matches) return
    setError(null)
    // Gone: back to the team page (of the team shown next), not another team's settings.
    change.mutate(
      { kind: 'delete', team: entry.team, confirm: typed },
      { onSuccess: () => nav.setView('team'), onError: (err: ChangeError) => setError(deleteRefusal(err)) },
    )
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5 border-t border-hairline px-4 py-3.5 lg:border-t-0" aria-label="Delete this team" data-delete-team>
      <div className="flex flex-col gap-0.5">
        <h3 className="text-[12.5px] font-semibold text-bad">Delete this team</h3>
        <p className="text-[12px] leading-snug text-subtle">
          Everyone loses access at once, signed-in devices are signed out, and its questions and answers are removed.
          The id <span className="font-mono text-foreground">{entry.team}</span> stays reserved for 31 days. This
          cannot be undone.
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label htmlFor={confirmId} className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[11.5px] text-subtle">
            Type <span className="font-mono text-foreground">{entry.team}</span> to confirm
          </span>
          <input
            id={confirmId}
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value.trim())
              setError(null)
            }}
            aria-describedby={error ? errorId : undefined}
            className={cn(inputClass, 'font-mono text-[12px]')}
          />
        </label>
        <Button type="submit" variant="destructive" disabled={!matches || change.isPending}>
          {change.isPending ? 'Deleting…' : 'Delete team'}
        </Button>
      </div>
      <InlineError id={errorId}>{error}</InlineError>
    </form>
  )
}

// ---------------------------------------------------------------------------------------
// A viewer on no team (M9 §3, §5), or no longer on the one they were looking at

export function NoTeamPage({ teams, lost }: { teams: Teams; lost?: string | null }) {
  const nav = useNav()
  const left = slotsLeft(teams)
  const others = teams.teams.filter((t) => t.team !== lost)
  let lead: ReactNode
  if (lost) {
    lead = (
      <p>
        You are no longer a member of <span className="font-mono text-foreground">{lost}</span>, or it was deleted.
      </p>
    )
  } else {
    lead = (
      <p data-not-on-team>
        Ask a team owner to invite{' '}
        {teams.email ? <span className="font-medium text-foreground">{teams.email}</span> : 'the Google account you signed in with'}
        {teams.can_manage_teams ? ', or create a team of your own.' : '.'}
      </p>
    )
  }
  return (
    <main className="flex min-h-dvh items-start justify-center px-4 pt-[14vh] pb-10">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-lg bg-card p-6" data-no-team>
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <RelayMark />
          Team relay
        </div>
        <div className="flex items-start gap-3">
          <UserX aria-hidden className="mt-0.5 size-4 shrink-0 text-subtle" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <h1 className="text-[15px] font-semibold">{lost ? 'This team is not yours any more' : "You're not on a team yet"}</h1>
            <div className="text-[13px] leading-relaxed text-subtle">{lead}</div>
          </div>
        </div>
        {others.length > 0 ? (
          <div className="flex flex-col gap-1 border-t border-hairline pt-3">
            <p className="text-[12px] font-medium text-subtle">Your teams</p>
            <ul className="flex flex-col gap-0.5">
              {others.map((t) => (
                <TeamOption key={t.team} t={t} current={false} onPick={() => nav.selectTeam(t.team)} />
              ))}
            </ul>
          </div>
        ) : null}
        {teams.invitations.length > 0 ? (
          <div className="flex flex-col border-t border-hairline pt-3">
            <p className="text-[12px] font-medium text-subtle">
              {teams.invitations.length === 1 ? 'You have an invitation' : `You have ${teams.invitations.length} invitations`}
            </p>
            <InvitationList invitations={teams.invitations} onAccepted={(team) => nav.selectTeam(team, undefined, 'join')} />
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 border-t border-hairline pt-4">
          {teams.can_manage_teams ? (
            <Button onClick={nav.openCreate} disabled={left === 0} data-create-team>
              <Plus aria-hidden />
              Create a team
            </Button>
          ) : null}
          {teams.admin ? (
            <Button variant="ghost" onClick={() => nav.setView('admin')} data-admin-link>
              <ShieldUser aria-hidden />
              Admin
            </Button>
          ) : null}
          {left === 0 ? <span className="text-[12px] text-subtle">You have created the most teams one account may.</span> : null}
        </div>
        <p className="text-[12px] text-subtle">Signed in with the wrong account? Sign out of Google in this browser, then reload.</p>
      </div>
    </main>
  )
}
