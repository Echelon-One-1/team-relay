import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useJoin } from '@/hooks/queries'
import {
  addPlugin,
  COME_BACK,
  joinPlugin,
  joinSource,
  NO_SOURCE,
  OPEN_PLUGINS,
  PASTE_SOURCE,
  SETUP_COMMAND,
  SETUP_PAGE,
} from '@/lib/setup'
import { BigCopyCommand, CopyCommand } from './copy'
import { joinCardShows, useViewerSetup } from './setup'

// M11-SPEC "Simpler joining": on the Setup page, above the steps, for a viewer who has not joined
// yet (their Mac has never reported in, or they have never accepted the team's topic), one small
// card with the things to do. It goes once they have joined (lib/setup.ts hasJoined).
// Joining is done in the Claude app (14 Nov 2026): add the plugin source, add the plugin, type
// /team-relay:setup. It names nothing but the Claude app's own labels: it is for people who have
// never used Terminal.

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
  const source = joinSource(join.data)
  return (
    <section aria-labelledby="join-card-title" className="flex min-w-0 flex-col gap-3.5 rounded-lg bg-card px-4 py-4" data-join-card>
      <h2 id="join-card-title" className="text-base leading-[22px] font-semibold">
        Join in 2 minutes
      </h2>
      <ol className="flex flex-col gap-3" aria-label="Steps to join">
        <Item n={1}>
          <p>{OPEN_PLUGINS}</p>
        </Item>
        <Item n={2}>
          {source ? (
            <>
              <p>{PASTE_SOURCE}</p>
              <BigCopyCommand text={source} label="plugin source" />
            </>
          ) : join.isPending ? (
            <Skeleton className="h-9 w-full" />
          ) : (
            <p data-no-source>{NO_SOURCE}</p>
          )}
        </Item>
        <Item n={3}>
          <p>{addPlugin(joinPlugin(join.data))}</p>
        </Item>
        <Item n={4}>
          <p>Start a Code session and type this:</p>
          <CopyCommand text={SETUP_COMMAND} label="setup command" />
          <p>{SETUP_PAGE}</p>
        </Item>
        <Item n={5}>
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
