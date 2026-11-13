import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Fragment, useId, useState, type FormEvent } from 'react'

import type { ChangeError } from '@/api/client'
import type { AdminTeam } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useAdminDelete, useAdminTeams } from '@/hooks/queries'
import { useNow } from '@/hooks/use-now'
import { deleteRefusal } from '@/lib/teams'
import { formatAgo, ms } from '@/lib/time'
import { cn } from '@/lib/utils'
import { Panel, StatusPill } from './primitives'

// M9 §4: the relay admin's page. Every team, a page at a time (the relay's `after` cursor),
// with no emails and no content: its id and name, status, members and owners, when and by
// whom it was created, and its last activity. A team the API created can be deleted after its
// id is typed again; a team of the relay's team file cannot. A deletion whose removal ran out
// of budget shows "Removal pending" and can be run again to finish.

const dateFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

function day(iso: string | null | undefined): string {
  const t = ms(iso)
  return t === null ? '' : dateFormat.format(t)
}

function Status({ t }: { t: AdminTeam }) {
  if (t.status === 'active') return <StatusPill tone="ok">Active</StatusPill>
  if (t.removal === 'pending') return <StatusPill tone="warn">Removal pending</StatusPill>
  return <StatusPill tone="muted">Deleted</StatusPill>
}

function ConfirmDelete({ t, onDone }: { t: AdminTeam; onDone: () => void }) {
  const del = useAdminDelete()
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputId = useId()
  const resume = t.status === 'deleted'
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (typed !== t.id) return
    setError(null)
    del.mutate({ team: t.id, confirm: typed }, { onSuccess: onDone, onError: (err: ChangeError) => setError(deleteRefusal(err)) })
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-md border border-bad/25 bg-bad-soft px-3 py-2.5" data-confirm-delete={t.id} aria-label={`Delete ${t.id}`}>
      <p className="text-[12.5px] leading-snug">
        {resume ? (
          <>
            Finish removing <span className="font-mono font-semibold">{t.id}</span>. Its members already have no access.
          </>
        ) : (
          <>
            Delete <span className="font-semibold">{t.name}</span> (<span className="font-mono">{t.id}</span>)?{' '}
            <span className="text-subtle">
              Its {t.members} {t.members === 1 ? 'member loses' : 'members lose'} access at once, and everything it holds is removed.
              The id stays reserved for 31 days.
            </span>
          </>
        )}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label htmlFor={inputId} className="flex min-w-[12rem] flex-1 flex-col gap-1">
          <span className="text-[11.5px] text-subtle">
            Type <span className="font-mono text-foreground">{t.id}</span> to confirm
          </span>
          <input
            id={inputId}
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            autoFocus
            onChange={(e) => {
              setTyped(e.target.value.trim())
              setError(null)
            }}
            className="h-8 w-full min-w-0 rounded-sm border border-input bg-field px-2.5 font-mono text-[12px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
          />
        </label>
        <Button type="submit" size="sm" variant="destructive" disabled={typed !== t.id || del.isPending}>
          {del.isPending ? 'Deleting…' : resume ? 'Finish removal' : 'Delete team'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone} disabled={del.isPending}>
          Cancel
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-[12px] text-bad" data-error>
          {error}
        </p>
      ) : null}
    </form>
  )
}

const COLUMNS = ['Team', 'Status', 'Members', 'Owners', 'Created', 'Last activity', ''] as const

function Row({ t, now, confirming, onConfirm, onDone }: { t: AdminTeam; now: number; confirming: boolean; onConfirm: () => void; onDone: () => void }) {
  const last = ms(t.last_activity_at)
  const deletable = !t.seed && (t.status === 'active' || t.removal === 'pending')
  return (
    <Fragment>
      <tr className={cn('border-t border-hairline align-middle', t.status === 'deleted' && 'text-subtle')} data-admin-team={t.id}>
        <td className="py-2.5 pr-4 pl-4">
          <div className="flex min-w-0 flex-col">
            <span className="flex items-center gap-2">
              <span className={cn('max-w-[16rem] truncate font-medium', t.status === 'deleted' && 'line-through decoration-faint')}>{t.name}</span>
              {t.seed ? (
                <span className="rounded bg-muted px-1.5 py-px text-[10.5px] font-medium text-subtle" title="Set up in the relay's team file">
                  Team file
                </span>
              ) : null}
            </span>
            <span className="font-mono text-[11.5px] text-subtle">{t.id}</span>
          </div>
        </td>
        <td className="py-2.5 pr-4">
          <div className="flex flex-col items-start gap-0.5">
            <Status t={t} />
            {t.status === 'deleted' && t.reserved_until ? (
              <span className="text-[11px] whitespace-nowrap text-faint">Id reserved until {day(t.reserved_until)}</span>
            ) : null}
          </div>
        </td>
        <td className="tnum py-2.5 pr-4 text-right">{t.members}</td>
        <td className="tnum py-2.5 pr-4 text-right">{t.owners}</td>
        <td className="py-2.5 pr-4 whitespace-nowrap">
          {day(t.created_at) || 'Unknown'}
          {t.created_by_member ? (
            <span className="block text-[11.5px] text-subtle">
              by <span className="font-mono">{t.created_by_member}</span>
            </span>
          ) : null}
        </td>
        <td className="tnum py-2.5 pr-4 whitespace-nowrap">{last === null ? <span className="text-faint">None yet</span> : formatAgo(now - last)}</td>
        <td className="py-2.5 pr-4 text-right">
          {deletable && !confirming ? (
            <Button size="xs" variant="ghost" className="text-bad hover:bg-bad-soft hover:text-bad" onClick={onConfirm}>
              {t.status === 'deleted' ? 'Finish removal' : 'Delete'}
            </Button>
          ) : null}
        </td>
      </tr>
      {confirming ? (
        <tr>
          <td colSpan={COLUMNS.length} className="px-4 pb-3">
            <ConfirmDelete t={t} onDone={onDone} />
          </td>
        </tr>
      ) : null}
    </Fragment>
  )
}

export function AdminPage() {
  // The relay's cursor: the `after` of each page read so far, so Previous can go back.
  const [cursors, setCursors] = useState<Array<string | null>>([null])
  const after = cursors.at(-1) ?? null
  const page = useAdminTeams(after)
  const now = useNow()
  const [confirming, setConfirming] = useState<string | null>(null)
  const teams = page.data?.teams ?? []
  const refused = page.error?.kind === 'relay_unreachable' && page.error.relayStatus === 403

  return (
    <main className="mx-auto flex max-w-[1440px] flex-col gap-4 px-3 py-4 sm:px-6 sm:py-5">
      <div className="flex flex-col gap-1 px-1">
        <h1 className="text-[17px] font-semibold tracking-[-0.01em]">Every team on this relay</h1>
        <p className="max-w-[68ch] text-[12.5px] leading-relaxed text-subtle">
          You are a relay admin. You see each team's size and activity, never its members' emails or its questions. Deleting
          a team removes it for everyone.
        </p>
      </div>
      <Panel
        id="admin-teams"
        title="Teams"
        aside={
          <div className="flex items-center gap-1">
            <span className="tnum mr-1 text-[12px] text-subtle">Page {cursors.length}</span>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Previous page"
              disabled={cursors.length === 1}
              onClick={() => {
                setConfirming(null)
                setCursors((c) => c.slice(0, -1))
              }}
            >
              <ChevronLeft />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Next page"
              disabled={!page.data?.next}
              onClick={() => {
                const next = page.data?.next ?? null
                if (next === null) return
                setConfirming(null)
                setCursors((c) => [...c, next])
              }}
            >
              <ChevronRight />
            </Button>
          </div>
        }
      >
        {page.isPending ? (
          <div className="flex flex-col gap-2 p-4">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : page.isError ? (
          <p className="px-4 py-5 text-[12.5px] text-subtle" role="alert">
            {refused ? 'Only relay admins can see every team.' : 'The team list did not load. Try again in a moment.'}
          </p>
        ) : teams.length === 0 ? (
          <p className="px-4 py-5 text-[12.5px] text-subtle">No teams on this page.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] border-collapse text-left text-[12.5px]" data-admin-table>
              <thead>
                <tr className="text-[11.5px] text-subtle">
                  {COLUMNS.map((c, i) => (
                    <th
                      key={c || 'actions'}
                      scope="col"
                      className={cn('py-2 pr-4 font-medium', i === 0 && 'pl-4', (c === 'Members' || c === 'Owners') && 'text-right')}
                    >
                      {c ? c : <span className="sr-only">Actions</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {teams.map((t) => (
                  <Row
                    key={t.id}
                    t={t}
                    now={now}
                    confirming={confirming === t.id}
                    onConfirm={() => setConfirming(t.id)}
                    onDone={() => setConfirming(null)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </main>
  )
}
