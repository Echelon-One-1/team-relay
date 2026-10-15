import { ChevronRight, LockKeyhole } from 'lucide-react'
import type { ReactNode } from 'react'

import type { Tone } from '@/lib/activity'
import type { Presence } from '@/lib/presence'
import { cn } from '@/lib/utils'

const TONE_TEXT: Record<Tone, string> = {
  live: 'text-signal',
  ok: 'text-ok',
  warn: 'text-warn',
  bad: 'text-bad',
  muted: 'text-subtle',
}

const TONE_DOT: Record<Tone, string> = {
  live: 'bg-signal',
  ok: 'bg-ok',
  warn: 'bg-warn',
  bad: 'bg-bad',
  muted: 'bg-faint',
}

const TONE_SOFT: Record<Tone, string> = {
  live: 'bg-signal-soft',
  ok: 'bg-ok-soft',
  warn: 'bg-warn-soft',
  bad: 'bg-bad-soft',
  muted: 'bg-muted',
}

/** A status as a quiet pill: a coloured dot and a label, the tint only behind live states. */
export function StatusPill({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11.5px] font-medium whitespace-nowrap',
        TONE_SOFT[tone],
        TONE_TEXT[tone],
        className,
      )}
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', TONE_DOT[tone])} />
      {children}
    </span>
  )
}

export const PRESENCE_TONE: Record<Presence, Tone> = { online: 'ok', idle: 'warn', offline: 'muted' }

export function PresenceDot({ presence, className }: { presence: Presence; className?: string }) {
  return (
    <span aria-hidden className={cn('relative inline-flex size-2 shrink-0', className)}>
      {presence === 'online' && <span className="dot-pulse absolute inset-0 rounded-full bg-ok" />}
      <span
        className={cn(
          'relative inline-flex size-2 rounded-full',
          presence === 'online' && 'bg-ok',
          presence === 'idle' && 'bg-warn',
          presence === 'offline' && 'border border-faint bg-transparent',
        )}
      />
    </span>
  )
}

export function Avatar({ member, you = false, size = 'md' }: { member: string; you?: boolean; size?: 'sm' | 'md' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold uppercase select-none',
        size === 'sm' ? 'size-5 text-[10px]' : 'size-7 text-[11.5px]',
        you ? 'bg-foreground text-background' : 'bg-muted text-subtle ring-1 ring-border ring-inset',
      )}
    >
      {member.slice(0, 1)}
    </span>
  )
}

export const MASKED_TEXT = 'Only participants can see this'

/** Where the relay withheld text or params from a non-participant (M2 §3.5). */
export function Masked({ className, what, label = MASKED_TEXT }: { className?: string; what?: string; label?: string }) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md border border-dashed px-3 py-2.5 text-[12.5px] text-subtle',
        className,
      )}
    >
      <LockKeyhole aria-hidden className="size-3.5 shrink-0 text-faint" />
      <span>
        {label}
        {what ? <span className="sr-only"> ({what})</span> : null}
      </span>
    </div>
  )
}

export function EnvBadge({ environment }: { environment: 'staging' | 'production' }) {
  return (
    <span
      className={cn(
        'inline-flex h-[18px] items-center rounded px-1.5 text-[10.5px] font-medium',
        environment === 'production' ? 'bg-warn-soft text-warn' : 'bg-muted text-subtle',
      )}
    >
      {environment === 'production' ? 'Production' : 'Staging'}
    </span>
  )
}

/** A panel the viewer can close: the title becomes the toggle, the aside stays visible. */
export interface PanelCollapse {
  open: boolean
  onToggle: () => void
}

export function Panel({
  title,
  aside,
  children,
  className,
  bodyClassName,
  id,
  collapse,
}: {
  title: ReactNode
  aside?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
  id?: string
  collapse?: PanelCollapse
}) {
  const headingId = id ? `${id}-title` : undefined
  const bodyId = id ? `${id}-body` : undefined
  const open = collapse ? collapse.open : true
  return (
    <section
      aria-labelledby={headingId}
      className={cn('flex min-w-0 flex-col rounded-xl border bg-card shadow-[0_1px_0_0_var(--hairline)]', className)}
      data-collapsed={collapse ? (open ? 'open' : 'closed') : undefined}
    >
      <header
        className={cn(
          'flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2',
          open && 'border-b border-hairline',
          collapse && 'pl-2',
        )}
      >
        <h2 id={headingId} className="text-[13px] font-semibold tracking-[-0.005em]">
          {collapse ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={bodyId}
              onClick={collapse.onToggle}
              className="-my-1 flex items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none"
            >
              <ChevronRight
                aria-hidden
                className={cn('size-4 shrink-0 text-subtle transition-transform motion-reduce:transition-none', open && 'rotate-90')}
              />
              {title}
            </button>
          ) : (
            title
          )}
        </h2>
        {aside ? <div className="ml-auto flex items-center gap-2">{aside}</div> : null}
      </header>
      <div id={bodyId} hidden={!open} className={cn('min-h-0 flex-1', bodyClassName)}>
        {open ? children : null}
      </div>
    </section>
  )
}

export function RelayMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn('size-5', className)}>
      <circle cx="5" cy="15" r="2.6" className="fill-foreground" />
      <circle cx="19" cy="9" r="2.6" className="fill-foreground" />
      <path d="M7.4 13.2 C 10 7.5, 13.5 6.8, 16.6 8.4" className="fill-none stroke-signal" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M16.6 10.8 C 14 16.5, 10.5 17.2, 7.4 15.6" className="fill-none stroke-foreground/35" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}
