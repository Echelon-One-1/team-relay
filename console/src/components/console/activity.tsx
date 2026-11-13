import { ArrowRight, KeyRound, LockKeyhole, MessageSquareText, Radio, SquareTerminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { ActivityRecipient, ActivityRequest } from '@/api/types'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { applyFilter, elapsedMs, isOpen, phaseTone, summarize, type Filter } from '@/lib/activity'
import { accessWaitLabel, deriveTrack, PHASE_LABEL, pendingGrant, usedTools } from '@/lib/steps'
import { formatClock, formatDuration, ms } from '@/lib/time'
import { cn } from '@/lib/utils'
import { EnvBadge, MASKED_TEXT, Panel, StatusPill } from './primitives'
import { StepTrack } from './step-track'

const FRESH_MS = 1_600

export function KindIcon({ req, className }: { req: ActivityRequest; className?: string }) {
  const Icon = req.kind === 'capability' ? SquareTerminal : req.broadcast ? Radio : MessageSquareText
  const label = req.kind === 'capability' ? 'Capability call' : req.broadcast ? 'Broadcast question' : 'Question'
  return <Icon aria-label={label} role="img" className={cn('size-4 shrink-0 text-subtle', className)} />
}

export function Headline({ req }: { req: ActivityRequest }) {
  if (req.kind === 'capability' && req.capability) {
    return (
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate font-mono text-[12.5px] font-medium">{req.capability.name}</span>
        <EnvBadge environment={req.capability.environment} />
      </span>
    )
  }
  if (req.question === null) {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-subtle" title={MASKED_TEXT}>
        <LockKeyhole aria-hidden className="size-3.5 shrink-0 text-faint" />
        <span className="truncate">{req.broadcast ? 'Broadcast question' : 'Question'}</span>
        <span className="sr-only">. {MASKED_TEXT}</span>
      </span>
    )
  }
  return <span className="block truncate font-medium">{req.question}</span>
}

function Route({ req, me }: { req: ActivityRequest; me: string | null }) {
  const to = Object.keys(req.recipients)
  const name = (m: string) => (m === me ? 'you' : m)
  return (
    <span className="flex min-w-0 items-center gap-1 text-[12px] text-subtle">
      <span className="truncate text-foreground">{name(req.asker)}</span>
      <ArrowRight aria-label="to" role="img" className="size-3 shrink-0 text-faint" />
      <span className="truncate text-foreground">{req.broadcast ? `everyone (${to.length})` : to.map(name).join(', ')}</span>
    </span>
  )
}

function Tools({ r, max = 3 }: { r: ActivityRecipient; max?: number }) {
  const waitingFor = pendingGrant(r)
  const used = usedTools(r)
  if (used.length === 0 && waitingFor === null) return null
  const names: { tool: string; error: boolean; n: number }[] = []
  for (const t of used) {
    const found = names.find((x) => x.tool === t.tool)
    if (found) {
      found.n += 1
      found.error ||= t.status === 'error'
    } else names.push({ tool: t.tool, error: t.status === 'error', n: 1 })
  }
  // The tool waiting for the member's permission leads, in amber (M4 §2).
  const shown = names.filter((x) => x.tool !== waitingFor).slice(0, waitingFor === null ? max : max - 1)
  const rest = names.filter((x) => x.tool !== waitingFor).length - shown.length
  const all = [...(waitingFor === null ? [] : [waitingFor]), ...names.map((x) => x.tool).filter((t) => t !== waitingFor)]
  return (
    <span className="hidden min-w-0 items-center gap-1 lg:flex" aria-label={`Tools: ${all.join(', ')}`}>
      {waitingFor !== null ? (
        <span
          data-tool-waiting={waitingFor}
          title={`${waitingFor}: waiting for permission`}
          className="inline-flex h-[18px] items-center gap-1 rounded border border-warn/40 bg-warn-soft px-1.5 font-mono text-[10.5px] text-warn"
        >
          <KeyRound aria-hidden className="size-3" />
          {waitingFor}
        </span>
      ) : null}
      {shown.map((x) => (
        <span
          key={x.tool}
          className={cn(
            'inline-flex h-[18px] items-center gap-1 rounded border px-1.5 font-mono text-[10.5px]',
            x.error ? 'border-bad/30 text-bad' : 'text-subtle',
          )}
        >
          {x.tool}
          {x.n > 1 ? <span className="tnum text-faint">×{x.n}</span> : null}
        </span>
      ))}
      {rest > 0 ? <span className="text-[10.5px] text-faint">+{rest}</span> : null}
    </span>
  )
}

function RecipientLine({ req, member, r, me }: { req: ActivityRequest; member: string; r: ActivityRecipient; me: string | null }) {
  const track = deriveTrack(req, r)
  const tone = phaseTone(track.phase)
  const used = usedTools(r).length
  const toolsNote = track.phase === 'working' && used > 0 ? `, ${used} tool${used > 1 ? 's' : ''}` : ''
  return (
    <div className="flex min-w-0 items-center gap-3" data-recipient={member} data-phase={track.phase}>
      <span className="w-12 shrink-0 truncate text-[12px] text-subtle">{member === me ? 'you' : member}</span>
      <StepTrack steps={track.steps} className="shrink-0" />
      <span
        className={cn(
          'min-w-0 truncate text-[12px]',
          tone === 'live' && 'text-signal',
          tone === 'ok' && 'text-subtle',
          tone === 'warn' && 'text-warn',
          tone === 'bad' && 'text-bad',
        )}
      >
        {track.phase === 'awaiting_access' ? accessWaitLabel(member, me) : PHASE_LABEL[track.phase]}
        {toolsNote}
      </span>
      <Tools r={r} />
    </div>
  )
}

export function ActivityRow({
  req,
  me,
  now,
  fresh,
  onOpen,
}: {
  req: ActivityRequest
  me: string | null
  now: number
  fresh: boolean
  onOpen: (id: string) => void
}) {
  const s = summarize(req)
  const live = isOpen(req)
  const created = ms(req.created_at)
  return (
    <li data-request={req.request_id} className={cn(fresh && 'row-fresh')}>
      <button
        type="button"
        onClick={() => onOpen(req.request_id)}
        className="group grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-2 px-4 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-offset-[-2px] md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)_4.5rem_7.5rem] md:items-center"
      >
        <span className="flex min-w-0 items-start gap-2.5">
          <KindIcon req={req} className="mt-px" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <Headline req={req} />
            <span className="flex min-w-0 items-center gap-2">
              <Route req={req} me={me} />
              {created !== null ? <span className="tnum shrink-0 text-[11.5px] text-faint">{formatClock(created)}</span> : null}
            </span>
          </span>
        </span>

        <span className="col-span-2 row-start-2 flex min-w-0 flex-col gap-1.5 pl-[26px] md:col-span-1 md:row-start-auto md:pl-0">
          {Object.entries(req.recipients).map(([m, r]) => (
            <RecipientLine key={m} req={req} member={m} r={r} me={me} />
          ))}
        </span>

        <span className={cn('tnum hidden text-right text-[12px] md:block', live ? 'text-foreground' : 'text-subtle')}>
          {formatDuration(elapsedMs(req, now))}
        </span>

        <span className="col-start-2 row-start-1 flex flex-col items-end gap-1 md:col-start-auto md:row-start-auto">
          <StatusPill tone={s.tone}>{s.label}</StatusPill>
          <span className={cn('tnum text-[11.5px] md:hidden', live ? 'text-foreground' : 'text-subtle')}>
            {formatDuration(elapsedMs(req, now))}
          </span>
        </span>
      </button>
    </li>
  )
}

export function Activity({
  requests,
  me,
  now,
  loading,
  onOpen,
}: {
  requests: ActivityRequest[]
  me: string | null
  now: number
  loading: boolean
  onOpen: (id: string) => void
}) {
  const [filter, setFilter] = useState<Filter>('all')
  const shown = applyFilter(requests, filter, me)
  const counts = {
    all: requests.length,
    mine: applyFilter(requests, 'mine', me).length,
    open: requests.filter(isOpen).length,
  }

  // Rows that arrive after the first load get a brief highlight, so a new request is
  // noticed without anything else on the page moving.
  const arrived = useRef<Map<string, number> | null>(null)
  const isFresh = (id: string) => {
    if (arrived.current === null) return false
    const t = arrived.current.get(id)
    return t === undefined || Date.now() - t < FRESH_MS
  }
  useEffect(() => {
    if (loading) return
    const first = arrived.current === null
    arrived.current ??= new Map()
    const t = first ? 0 : Date.now()
    for (const r of requests) if (!arrived.current.has(r.request_id)) arrived.current.set(r.request_id, t)
  }, [requests, loading])

  return (
    <Panel
      id="activity"
      title="Live activity"
      aside={
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={filter}
          onValueChange={(v) => {
            if (v === 'all' || v === 'mine' || v === 'open') setFilter(v)
          }}
          aria-label="Filter requests"
        >
          {(['all', 'mine', 'open'] as const).map((f) => (
            <ToggleGroupItem
              key={f}
              value={f}
              className="h-7 gap-1.5 px-3 text-[12px]"
            >
              {f === 'all' ? 'All' : f === 'mine' ? 'Mine' : 'Open'}
              <span className="tnum text-[11px] opacity-70">{counts[f]}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      }
    >
      <div className="hidden grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)_4.5rem_7.5rem] gap-x-4 border-b border-hairline px-4 py-1.5 text-[11px] text-faint md:grid">
        <span className="pl-[26px]">Request</span>
        <span>
          <span className="inline-block w-12">To</span>
          <span className="ml-3">Sent, delivered, acked, tools, answered, returned</span>
        </span>
        <span className="text-right">Elapsed</span>
        <span className="text-right">Status</span>
      </div>
      {loading ? (
        <div className="flex flex-col gap-2 p-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <p className="px-4 py-10 text-center text-[12.5px] text-subtle">
          {filter === 'open'
            ? 'Nothing in flight right now.'
            : filter === 'mine'
              ? 'Nothing you asked or were asked in the last 24 hours.'
              : 'No requests in the last 24 hours. Ask a teammate from Claude Code and it appears here.'}
        </p>
      ) : (
        <ul className="divide-y divide-hairline" aria-label="Requests, newest first">
          {shown.map((r) => (
            <ActivityRow key={r.request_id} req={r} me={me} now={now} fresh={isFresh(r.request_id)} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </Panel>
  )
}
