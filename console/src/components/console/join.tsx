import { ArrowRight } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useJoin } from '@/hooks/queries'
import { useNav } from '@/hooks/team'
import { COME_BACK, OPEN_TERMINAL, PASTE_LINE, hasJoined, publicOrigin, setupCommand } from '@/lib/setup'
import { BigCopyCommand } from './copy'
import { useViewerSetup } from './setup'

// M11-SPEC "Simpler joining": on the team page, for a viewer who has not joined yet (their Mac
// has never reported in, or they have never accepted what the team shares), one small card with
// the three things to do. It goes once they have joined (lib/setup.ts hasJoined). Nothing in it
// names a tool: it is for people who have never used Terminal.

function Item({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3" data-join-step={n}>
      <span
        aria-hidden
        className="tnum mt-px inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium text-subtle"
      >
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 text-[13px] leading-relaxed">{children}</div>
    </li>
  )
}

/** Whether the join card shows: progress has loaded and the viewer has not joined yet. */
export function useShowJoinCard(): boolean {
  const v = useViewerSetup()
  return v.known && !v.missing && !hasJoined(v.entry, v.bounds.data, v.accepted)
}

export function JoinCard() {
  const join = useJoin()
  const nav = useNav()
  const show = useShowJoinCard()
  if (!show) return null
  const origin = publicOrigin(window.location, join.data)
  return (
    <section aria-labelledby="join-card-title" className="flex min-w-0 flex-col gap-3.5 rounded-xl border bg-card px-4 py-3.5 shadow-[0_1px_0_0_var(--hairline)]" data-join-card>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id="join-card-title" className="text-[14px] font-semibold tracking-[-0.005em]">
          Join in 2 minutes
        </h2>
        <button
          type="button"
          onClick={() => nav.setView('join')}
          className="ml-auto inline-flex items-center gap-1 rounded text-[12.5px] font-medium text-signal underline decoration-signal/40 underline-offset-2 hover:decoration-signal"
        >
          See your progress
          <ArrowRight aria-hidden className="size-3.5" />
        </button>
      </div>
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
            <Button size="sm" variant="outline" onClick={() => nav.setView('join')}>
              Go to Accept
            </Button>
          </div>
        </Item>
      </ol>
    </section>
  )
}
