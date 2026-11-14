import { Monitor, Moon, Sun } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useApprovalsSummary, useConnection, useInboxSummary, useMe } from '@/hooks/queries'
import { useNav } from '@/hooks/team'
import { useNow } from '@/hooks/use-now'
import { useTheme, type ThemeChoice } from '@/hooks/use-theme'
import { formatAgo, formatClock } from '@/lib/time'
import { approvalsLine, waitingLine } from '@/lib/waiting'
import { cn } from '@/lib/utils'
import { Avatar, RelayMark, StatusPill } from './primitives'
import { TeamSwitcher } from './teams'

const THEME_LABEL: Record<ThemeChoice, string> = {
  system: 'Theme follows the system',
  light: 'Light theme',
  dark: 'Dark theme',
}

function ThemeButton() {
  const { choice, cycle } = useTheme()
  const Icon = choice === 'light' ? Sun : choice === 'dark' ? Moon : Monitor
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" onClick={cycle} aria-label={`${THEME_LABEL[choice]}. Switch theme`}>
          <Icon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{THEME_LABEL[choice]}</TooltipContent>
    </Tooltip>
  )
}

export function ConnectionStatus() {
  const conn = useConnection()
  const now = useNow()

  let dot = 'bg-faint'
  let label = 'Connecting'
  let detail: string | null = null
  if (conn.state === 'live') {
    dot = 'bg-ok'
    label = 'Live'
    detail = `Updated ${formatAgo(now - conn.updatedAt)}`
  } else if (conn.state === 'slowed') {
    dot = 'bg-warn'
    label = 'Slowed down'
    detail = conn.updatedAt !== null ? `Updated ${formatAgo(now - conn.updatedAt)}` : null
  } else if (conn.state === 'unreachable') {
    dot = 'bg-bad'
    label = conn.reason === 'relay' ? 'Relay unreachable' : 'Console server stopped'
    detail = conn.updatedAt ? `Last update ${formatClock(conn.updatedAt)}` : null
  } else if (conn.state === 'unauthorized') {
    dot = 'bg-bad'
    label = 'Link expired'
  } else if (conn.state === 'session_expired') {
    dot = 'bg-bad'
    label = 'Signed out'
  }

  return (
    <div className="flex min-w-0 items-center gap-3 text-[12px]" role="status" aria-live="polite">
      <span className="inline-flex items-center gap-1.5 font-medium">
        <span className="relative inline-flex size-2">
          {conn.state === 'live' && <span className="dot-pulse absolute inset-0 rounded-full bg-ok" />}
          <span className={cn('relative size-2 rounded-full', dot)} />
        </span>
        {conn.state === 'slowed' ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="rounded text-foreground" data-connection="slowed">
                {label}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-64">
              The relay asked for fewer reads, so the console polls less often for a while. What is shown stays; updates
              resume on their own.
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className={cn(conn.state === 'unreachable' || conn.state === 'unauthorized' || conn.state === 'session_expired' ? 'text-bad' : 'text-foreground')}>
            {label}
          </span>
        )}
      </span>
      {conn.state === 'live' && conn.rttMs !== null ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="tnum hidden rounded text-subtle sm:inline">
              {conn.rttMs} ms
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">Round trip to the relay through the console server</TooltipContent>
        </Tooltip>
      ) : null}
      {detail ? <span className="tnum hidden text-subtle md:inline">{detail}</span> : null}
    </div>
  )
}

/**
 * M7 §3: the viewer's own questions waiting for their answering session, while it is not
 * running (from /api/inbox/summary; nothing from a server without it).
 */
function InboxWaiting() {
  const summary = useInboxSummary()
  const now = useNow()
  const line = waitingLine(summary.data, now)
  if (line === null) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="min-w-0 rounded-full" data-inbox-waiting={summary.data?.pending}>
          <StatusPill tone="warn" className="tnum max-w-full truncate">
            {line}
          </StatusPill>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-72">
        Nothing on your Mac is answering right now. In Claude, type /team-relay:setup and leave Background answering
        on; the questions reach your Mac then.
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * M8 §5: answers the viewer's channel working session holds for their approval (local console
 * only, from /api/approvals/summary; the hosted console cannot see a laptop's queue).
 */
function ApprovalsWaiting() {
  const summary = useApprovalsSummary()
  const line = approvalsLine(summary.data)
  if (line === null) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="min-w-0 rounded-full" data-approvals-waiting={summary.data?.pending}>
          <StatusPill tone="warn" className="tnum max-w-full truncate">
            {line}
          </StatusPill>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-72">
        Your working session answered a teammate but needs your approval before it sends the answer or takes a step. Run
        /team-relay:approvals in that session.
      </TooltipContent>
    </Tooltip>
  )
}

function Brand() {
  return (
    <div className="flex items-center gap-2">
      <RelayMark />
      <span className="text-[13.5px] font-semibold tracking-[-0.01em]">Team relay</span>
    </div>
  )
}

const HEADER_CLASS = 'sticky top-0 z-30 border-b bg-canvas/90 backdrop-blur-md supports-[backdrop-filter]:bg-canvas/75'

export function Header() {
  const nav = useNav()
  if (nav.view === 'admin') {
    // M9 §4: the admin page is about no one team: the switcher leads back to one.
    return (
      <header className={HEADER_CLASS}>
        <div className="mx-auto flex h-12 max-w-[1440px] items-center gap-3 px-4 sm:px-6">
          <Brand />
          <span aria-hidden className="h-4 w-px bg-border" />
          <TeamSwitcher />
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-subtle">Admin</span>
          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <ThemeButton />
          </div>
        </div>
      </header>
    )
  }
  return <TeamHeader multi={nav.teams !== null} />
}

function TeamHeader({ multi }: { multi: boolean }) {
  const me = useMe()
  return (
    <header className={HEADER_CLASS}>
      <div className="mx-auto flex h-12 max-w-[1440px] items-center gap-3 px-4 sm:px-6">
        <Brand />
        {multi ? (
          <div className="flex min-w-0 items-center gap-3 text-[12.5px]">
            <span aria-hidden className="h-4 w-px bg-border" />
            <TeamSwitcher />
            {me.data ? (
              <>
                <span aria-hidden className="hidden h-4 w-px bg-border sm:block" />
                <span className="hidden items-center gap-1.5 sm:inline-flex">
                  <Avatar member={me.data.member} you size="sm" />
                  <span className="font-medium">{me.data.member}</span>
                  <span className="text-subtle">(you)</span>
                </span>
                <InboxWaiting />
                <ApprovalsWaiting />
              </>
            ) : null}
          </div>
        ) : me.data ? (
          <div className="flex min-w-0 items-center gap-3 text-[12.5px]">
            <span aria-hidden className="h-4 w-px bg-border" />
            <span className="truncate">
              <span className="text-subtle">Team </span>
              <span className="font-medium">{me.data.team}</span>
            </span>
            <span aria-hidden className="hidden h-4 w-px bg-border sm:block" />
            <span className="hidden items-center gap-1.5 sm:inline-flex">
              <Avatar member={me.data.member} you size="sm" />
              <span className="font-medium">{me.data.member}</span>
              <span className="text-subtle">(you)</span>
            </span>
            <InboxWaiting />
            <ApprovalsWaiting />
          </div>
        ) : null}
        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <ConnectionStatus />
          <ThemeButton />
        </div>
      </div>
    </header>
  )
}
