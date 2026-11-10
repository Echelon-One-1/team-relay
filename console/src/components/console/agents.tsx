import { FolderOpen } from 'lucide-react'

import type { DirectoryMember } from '@/api/types'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PRESENCE_LABEL, presenceOf } from '@/lib/presence'
import { agentWaiting } from '@/lib/waiting'
import { formatAgo, formatDuration, ms } from '@/lib/time'
import { cn } from '@/lib/utils'
import { Avatar, EnvBadge, Panel, PresenceDot, StatusPill } from './primitives'

function Session({ label, lastSeen, now }: { label: string; lastSeen: string | null; now: number }) {
  const p = presenceOf(lastSeen, now)
  const t = ms(lastSeen)
  return (
    <div className="flex min-w-0 items-center gap-2" data-session={label.toLowerCase()} data-presence={p}>
      <PresenceDot presence={p} />
      <span className="text-subtle">{label}</span>
      <span className={cn('tnum truncate', p === 'offline' ? 'text-faint' : 'text-foreground')}>
        {PRESENCE_LABEL[p]}
        {p !== 'online' && t !== null ? <span className="text-subtle">, {formatAgo(now - t)}</span> : null}
        {t === null ? <span className="text-subtle">, never seen</span> : null}
      </span>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-[11px] text-subtle">{label}</dt>
      <dd className="tnum text-[13px] font-medium">{value}</dd>
    </div>
  )
}

/**
 * What the member's answering session can answer from (M4 §3, M10 §2), by name: the plugin
 * publishes names only (repositories, shared drives, folders), never paths.
 */
function Shares({ agent }: { agent: DirectoryMember }) {
  const names = (agent.manifest?.shares ?? []).map((s) => s.name)
  const text = names.length === 0 ? 'Can answer from nothing shared yet' : `Can answer from: ${names.join(', ')}`
  return (
    <div
      className="flex min-w-0 basis-full items-center gap-1.5 pl-[38px] text-[11.5px] min-[420px]:ml-auto min-[420px]:max-w-[55%] min-[420px]:basis-auto min-[420px]:pl-0"
      data-shares={names.join(',')}
      title={`${text}. What this member's answering session reads to answer: repositories, shared drives and folders, by name.`}
    >
      <FolderOpen aria-hidden className="size-3.5 shrink-0 text-faint" />
      {names.length === 0 ? (
        <span className="truncate text-subtle">Can answer from nothing shared yet</span>
      ) : (
        <span className="min-w-0 truncate">
          <span className="text-subtle">Can answer from: </span>
          <span className="font-mono text-[11px]">{names.join(', ')}</span>
        </span>
      )}
    </div>
  )
}

/**
 * M7 §3: questions waiting in the teammate's inbox while their answering session is not
 * running. They are delivered when it starts.
 */
function Waiting({ agent, count }: { agent: DirectoryMember; count: number }) {
  const noun = count === 1 ? 'question' : 'questions'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="rounded-full" data-waiting={count}>
          <StatusPill tone="warn" className="tnum">
            {count >= 50 ? '50+' : count} waiting
          </StatusPill>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-64">
        {count >= 50 ? '50 or more' : count} {noun} waiting for {agent.member}. Their answering session is not running;
        the {noun} will reach it when it starts.
      </TooltipContent>
    </Tooltip>
  )
}

export function AgentRow({ agent, now }: { agent: DirectoryMember; now: number }) {
  const caps = agent.manifest?.capabilities ?? []
  const published = ms(agent.published_at)
  const waiting = agentWaiting(agent, now)
  return (
    <li className="flex flex-col gap-3 px-4 py-3.5" data-agent={agent.member}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <Avatar member={agent.member} />
        <div className="min-w-0 shrink-0">
          <div className="text-[13.5px] font-semibold leading-tight">{agent.member}</div>
          <div className="text-[11.5px] text-subtle">
            {caps.length === 0
              ? 'Answers questions only'
              : `${caps.length} ${caps.length === 1 ? 'capability' : 'capabilities'}`}
            {published !== null ? <span className="tnum">, published {formatAgo(now - published)}</span> : null}
          </div>
        </div>
        {waiting !== null ? <Waiting agent={agent} count={waiting} /> : null}
        <Shares agent={agent} />
      </div>

      <div className="grid grid-cols-1 gap-1.5 text-[12px] min-[420px]:grid-cols-2">
        <Session label="Answering" lastSeen={agent.sessions.answering.last_seen} now={now} />
        <Session label="Working" lastSeen={agent.sessions.working.last_seen} now={now} />
      </div>

      {caps.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={`${agent.member}'s capabilities`}>
          {caps.map((c) => (
            <li key={c.name}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    tabIndex={0}
                    className="inline-flex h-6 items-center gap-1.5 rounded-md border bg-canvas pr-1 pl-2 text-[11.5px]"
                  >
                    <span className="font-mono text-[11px]">{c.name}</span>
                    <EnvBadge environment={c.environment} />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-72 flex-col items-start gap-0.5">
                  <span className="font-medium">{c.title}</span>
                  <span className="opacity-80">{c.description}</span>
                </TooltipContent>
              </Tooltip>
            </li>
          ))}
        </ul>
      ) : null}

      <dl className="grid grid-cols-4 gap-2 rounded-lg bg-canvas px-3 py-2" aria-label="Last 24 hours">
        <Stat label="Asked" value={String(agent.stats.asked)} />
        <Stat label="Answered" value={String(agent.stats.answered)} />
        <Stat label="Open" value={String(agent.stats.open)} />
        <Stat
          label="Median"
          value={agent.stats.median_answer_seconds === null ? '–' : formatDuration(agent.stats.median_answer_seconds * 1000)}
        />
      </dl>
    </li>
  )
}

export function Agents({
  agents,
  loading,
  now,
  statsComplete = true,
  className,
}: {
  agents: DirectoryMember[]
  loading: boolean
  now: number
  /** The relay's stats covered only part of the 24 h window (M2 §7.10). */
  statsComplete?: boolean
  className?: string
}) {
  const online = agents.filter((a) => presenceOf(a.sessions.answering.last_seen, now) === 'online').length
  return (
    <Panel
      id="agents"
      title="Agents"
      className={className}
      aside={
        agents.length === 0 ? null : (
          <span className="tnum text-[12px] text-subtle">
            {online} of {agents.length} answering
            <span className="hidden sm:inline">{statsComplete ? ', stats for 24 h' : ', stats for 24 h (partial)'}</span>
          </span>
        )
      }
      bodyClassName="overflow-y-auto"
    >
      {loading ? (
        <div className="flex flex-col gap-3 p-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : agents.length === 0 ? (
        <p className="px-4 py-6 text-[12.5px] text-subtle">
          No teammates have connected yet. They appear here once their plugin publishes a manifest.
        </p>
      ) : (
        <ul className="divide-y divide-hairline">
          {agents.map((a) => (
            <AgentRow key={a.member} agent={a} now={now} />
          ))}
        </ul>
      )}
    </Panel>
  )
}
