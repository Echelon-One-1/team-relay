import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useJoin } from '@/hooks/queries'
import { COME_BACK, OPEN_TERMINAL, PASTE_LINE, publicOrigin, setupCommand } from '@/lib/setup'
import { BigCopyCommand } from './copy'
import { joinCardShows, useViewerSetup } from './setup'

// M11-SPEC "Simpler joining": on the Setup page, above the steps, for a viewer who has not joined
// yet (their Mac has never reported in, or they have never accepted the team's topic), one small
// card with the three things to do. It goes once they have joined (lib/setup.ts hasJoined).
// Nothing in it names a tool: it is for people who have never used Terminal.

function Item({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3" data-join-step={n}>
      <span
        aria-hidden
        className="tnum mt-px inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-subtle"
      >
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 text-[13px] leading-relaxed">{children}</div>
    </li>
  )
}

/** Whether the join card shows: progress has loaded and the viewer has not joined yet. */
export function useShowJoinCard(): boolean {
  return joinCardShows(useViewerSetup())
}

/**
 * The Accept step on this page: brought into view, and its Accept button focused (the step
 * itself where the button cannot take focus, e.g. while it is disabled or still loading).
 */
export function goToAccept(): void {
  const step = document.getElementById('setup-step-accept')
  if (!step) return
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (typeof step.scrollIntoView === 'function') step.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
  const button = step.querySelector<HTMLButtonElement>('button[data-accept-version]:not(:disabled)')
  if (button) {
    button.focus({ preventScroll: true })
    return
  }
  // Focus set by script draws no :focus-visible ring on the step everywhere: mark it until focus leaves.
  step.setAttribute('data-focus-ring', 'true')
  step.addEventListener('blur', () => step.removeAttribute('data-focus-ring'), { once: true })
  step.focus({ preventScroll: true })
}

export function JoinCard() {
  const join = useJoin()
  const show = useShowJoinCard()
  if (!show) return null
  const origin = publicOrigin(window.location, join.data)
  return (
    <section aria-labelledby="join-card-title" className="flex min-w-0 flex-col gap-3.5 rounded-lg bg-card px-4 py-4" data-join-card>
      <h2 id="join-card-title" className="text-base leading-[22px] font-semibold">
        Join in 2 minutes
      </h2>
      <ol className="flex flex-col gap-3" aria-label="Steps to join">
        <Item n={1}>
          <p>{OPEN_TERMINAL}</p>
        </Item>
        <Item n={2}>
          {origin ? (
            <>
              <p>{PASTE_LINE}</p>
              <BigCopyCommand text={setupCommand(origin)} label="setup line" />
            </>
          ) : join.isPending ? (
            <Skeleton className="h-9 w-full" />
          ) : (
            <p data-no-command>Paste the setup line a team owner sent you, press Enter, then answer its questions.</p>
          )}
        </Item>
        <Item n={3}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="min-w-0 flex-1">{COME_BACK}</p>
            <Button size="sm" variant="outline" onClick={goToAccept}>
              Go to Accept
            </Button>
          </div>
        </Item>
      </ol>
    </section>
  )
}
