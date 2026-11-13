import { CircleAlert, CircleCheck, LoaderCircle, MessageSquare, ShieldAlert } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import type { ChangeError } from '@/api/client'
import type { TeamBoundaries } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  SETUP_INTERVAL_MS,
  useAcceptance,
  useBoundaries,
  useJoin,
  useMe,
  useMembersStatus,
  useRefreshBoundaries,
  useSetAcceptance,
} from '@/hooks/queries'
import { useNav, type ConsoleView } from '@/hooks/team'
import { acceptRefusal } from '@/lib/ask'
import {
  acceptedVersion,
  boundariesSet,
  CHECKING,
  currentVersion,
  hasJoined,
  isAccepted,
  publicOrigin,
  SETUP_STEPS,
  setupCommand,
  setupSteps,
  type MacCheck,
  type SetupStep,
} from '@/lib/setup'
import { cn } from '@/lib/utils'
import { BigCopyCommand, CopyCommand } from './copy'
import { Panel } from './primitives'

// M11 §6 and "Simpler joining": the Setup page. Two plain steps that tick on their own (read
// every 5 s while the page is visible): set up your Mac with one line in Terminal, and accept
// the team's topic (the member, for themselves). Inside the first step, only what is not
// done yet shows, each as one sentence of what to do. Below them, always: Ask the team (never a
// step: asking is what the setup is for, and works whatever the steps say).

/**
 * The viewer's own progress, from the Mac's last report, their acceptance and the team's
 * boundaries. Used by the Setup page, its tab and the join card.
 */
export function useViewerSetup(intervalMs?: number) {
  const me = useMe()
  const statuses = useMembersStatus(intervalMs)
  const acceptance = useAcceptance(intervalMs)
  const bounds = useBoundaries()
  const member = me.data?.member ?? null
  const entry = statuses.data?.members.find((m) => m.member === member) ?? null
  const current = currentVersion(bounds.data, statuses.data?.boundaries_version ?? null)
  const accepted = acceptedVersion(entry, acceptance.data)
  const steps = setupSteps(entry, bounds.data, accepted, current)
  return {
    me,
    entry,
    statuses,
    bounds,
    current,
    accepted,
    steps,
    done: steps.filter((s) => s.done).length,
    loading: me.isPending || statuses.isPending,
    /** An older relay that does not report setup progress (404). */
    missing: statuses.error?.kind === 'not_found',
    /** Everything the steps are worked out from has loaded at least once. */
    known: !!me.data && !!statuses.data && !!bounds.data,
  }
}

/** Whether the join card shows: progress has loaded and the viewer has not joined yet. */
export function joinCardShows(v: ReturnType<typeof useViewerSetup>): boolean {
  return v.known && !v.missing && !hasJoined(v.entry, v.bounds.data, v.accepted)
}

/** Step 2: the team's topic, and Accept. An acceptance of any version up to the current one holds. */
export function AcceptBoundaries({
  bounds,
  accepted,
  current,
}: {
  bounds: TeamBoundaries & { boundaries: NonNullable<TeamBoundaries['boundaries']> }
  accepted: number
  current: number
}) {
  const accept = useSetAcceptance()
  const [error, setError] = useState<string | null>(null)
  // members-status already names a newer version: the one on screen is about to be replaced.
  const stale = bounds.version < current
  const done = isAccepted(accepted, bounds.version) && !stale
  const submit = () => {
    setError(null)
    accept.mutate({ version: bounds.version }, { onError: (err: ChangeError) => setError(acceptRefusal(err)) })
  }
  return (
    <div className="flex flex-col gap-2.5 rounded-md border bg-canvas px-3 py-2.5" data-accept-boundaries={bounds.version}>
      <p className="text-[12px] text-subtle">
        Your Mac answers teammates&apos; questions on this topic only, from the folders you chose on it.
      </p>
      <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]" data-topic>
        {bounds.boundaries.topic}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={submit} disabled={done || stale || accept.isPending} data-accept-version={bounds.version}>
          {done ? 'Accepted' : accept.isPending ? 'Accepting…' : 'Accept'}
        </Button>
        {stale ? <span className="text-[12px] text-subtle">Loading the latest version…</span> : null}
      </div>
      {error ? (
        <p role="alert" className="text-[12px] leading-snug text-bad" data-error>
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** What "Set up your Mac" still needs, one sentence each. */
function OpenChecks({ checks }: { checks: MacCheck[] }) {
  const open = checks.filter((c) => !c.done && c.id !== 'setup')
  if (open.length === 0) return null
  return (
    <ul className="flex flex-col gap-1.5" aria-label="Still to do on your Mac">
      {open.map((c) => {
        const running = c.todo === CHECKING
        return (
          <li key={c.id} className="flex items-start gap-2 text-[12.5px] leading-relaxed" data-mac-check={c.id}>
            {running ? (
              <LoaderCircle aria-hidden className="mt-0.5 size-3.5 shrink-0 animate-spin text-subtle motion-reduce:animate-none" />
            ) : (
              <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warn" />
            )}
            <span className="min-w-0 [overflow-wrap:anywhere]">{c.todo}</span>
          </li>
        )
      })}
    </ul>
  )
}

function StepItem({ n, step, children }: { n: number; step: SetupStep; children?: ReactNode }) {
  return (
    <li
      id={`setup-step-${step.id}`}
      // The join card's "Go to Accept" brings this step into view and focuses it when its button cannot be.
      tabIndex={-1}
      className="-mx-2 flex gap-3 rounded-sm px-2 py-3.5 outline-none focus-visible:ring-2 focus-visible:ring-ring data-[focus-ring=true]:ring-2 data-[focus-ring=true]:ring-ring"
      data-setup-step={step.id}
      data-done={step.done ? 'true' : 'false'}
    >
      {step.done ? (
        <CircleCheck aria-hidden className="mt-px size-5 shrink-0 text-ok" />
      ) : (
        <span
          aria-hidden
          className="tnum mt-px inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium text-subtle"
        >
          {n}
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <h3 className={cn('text-[13.5px] leading-5 font-semibold', step.done && 'text-subtle')}>
          {step.title}
          <span className="sr-only">{step.done ? ' (done)' : ' (to do)'}</span>
        </h3>
        {children}
      </div>
    </li>
  )
}

/** `join`: shown above the steps (the join card, for a viewer who has not joined yet). */
export function SetupPage({ join: joinCard }: { join?: ReactNode } = {}) {
  const join = useJoin()
  const nav = useNav()
  const v = useViewerSetup(SETUP_INTERVAL_MS)
  const refresh = useRefreshBoundaries()
  const { statuses, bounds, steps, done, loading, missing } = v

  const statusVersion = statuses.data?.boundaries_version ?? null
  const shownVersion = bounds.data?.version ?? null
  // members-status names a newer version than the boundaries on screen: read them again.
  useEffect(() => {
    if (statusVersion !== null && shownVersion !== null && statusVersion > shownVersion) refresh()
  }, [statusVersion, shownVersion, refresh])

  const origin = publicOrigin(window.location, join.data)
  const command = origin ? setupCommand(origin) : null
  const allDone = !loading && done === SETUP_STEPS
  // The join card above already has the Terminal steps and the setup line: say them once.
  const cardShown = joinCard !== undefined && joinCardShows(v)

  const macBody = (step: SetupStep) => (
    <>
      {step.done ? (
        <p className="text-[12.5px] leading-relaxed text-subtle">
          Your Mac answers teammates in the background. To change your folders, run the setup line again.
        </p>
      ) : cardShown ? (
        <>
          <p className="text-[12.5px] leading-relaxed text-subtle" data-setup-see-card>
            Follow &quot;Join in 2 minutes&quot; above.
          </p>
          <p className="text-[12.5px] leading-relaxed text-subtle" data-setup-command>
            Or, in Claude Code, type <span className="font-mono text-[12px] text-foreground">/team-relay:setup</span>
          </p>
        </>
      ) : (
        <>
          <p className="text-[12.5px] leading-relaxed text-subtle">
            Open Terminal (press Cmd+Space, type Terminal, press Enter). Paste this line, press Enter and answer its questions.
          </p>
          <p className="text-[12.5px] leading-relaxed text-subtle" data-setup-command>
            Or, in Claude Code, type <span className="font-mono text-[12px] text-foreground">/team-relay:setup</span>
          </p>
        </>
      )}
      {cardShown ? null : command ? (
        step.done ? (
          <CopyCommand text={command} label="setup line" />
        ) : (
          <BigCopyCommand text={command} label="setup line" />
        )
      ) : join.isPending ? (
        <Skeleton className="h-9 w-full" />
      ) : (
        <p className="text-[12.5px] text-subtle" data-no-command>
          The setup line is on your team&apos;s page online. Ask a team owner for it.
        </p>
      )}
      {missing ? (
        <p className="text-[12.5px] text-subtle" data-setup-missing>
          This team can&apos;t show your progress here yet, so nothing ticks.
        </p>
      ) : statuses.isError && !statuses.data ? (
        <p className="text-[12.5px] text-subtle">Your progress didn&apos;t load. It is checked again in a few seconds.</p>
      ) : (
        <OpenChecks checks={step.checks} />
      )}
    </>
  )

  const acceptBody = (step: SetupStep) =>
    bounds.isPending ? (
      <Skeleton className="h-16 w-full" />
    ) : boundariesSet(bounds.data) ? (
      <AcceptBoundaries bounds={bounds.data} accepted={v.accepted} current={v.current} />
    ) : bounds.isError && !bounds.data ? (
      <p className="text-[12.5px] text-subtle">The team&apos;s topic didn&apos;t load. It is read again in a moment.</p>
    ) : step.done ? null : (
      <p className="text-[12.5px] leading-relaxed text-subtle">
        A team owner hasn&apos;t set the team&apos;s topic yet. Nothing is answered until they do.
      </p>
    )


  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      {joinCard}
      <Panel
        id="setup"
        title="Your setup"
        aside={
          loading || missing ? null : (
            <span className="tnum text-[12px] text-subtle" data-setup-count={done}>
              {done} of {SETUP_STEPS} done
            </span>
          )
        }
      >
        {loading ? (
          <div className="flex flex-col gap-3 p-4" aria-label="Loading your progress">
            <Skeleton className="h-5 w-2/5" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-5 w-1/3" />
          </div>
        ) : (
          <ol className="divide-y divide-hairline px-4 pb-1" aria-label="Setup steps">
            {steps.map((s, i) => (
              <StepItem key={s.id} n={i + 1} step={s}>
                {s.id === 'mac' ? macBody(s) : acceptBody(s)}
              </StepItem>
            ))}
          </ol>
        )}
        {/* Never a step: always there, and the big next thing once both steps are done. */}
        {allDone ? (
          <div className="m-4 flex flex-col items-start gap-3 rounded-md border border-ok/30 bg-ok-soft px-4 py-3.5 sm:flex-row sm:items-center" data-ask-cta data-setup-complete>
            <CircleCheck aria-hidden className="size-5 shrink-0 text-ok" />
            <p className="min-w-0 flex-1 text-[14px] font-semibold">You&apos;re all set</p>
            <Button size="lg" onClick={() => nav.setView('ask')}>
              <MessageSquare aria-hidden />
              Ask the team
            </Button>
          </div>
        ) : (
          <div className="m-4 flex flex-wrap items-center gap-3 rounded-md border bg-canvas px-4 py-3" data-ask-cta>
            <MessageSquare aria-hidden className="size-4 shrink-0 text-subtle" />
            <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-subtle">Ask your teammates a question at any time.</p>
            <Button size="sm" variant="outline" onClick={() => nav.setView('ask')}>
              Ask the team
            </Button>
          </div>
        )}
      </Panel>
    </div>
  )
}

/**
 * On the team page: the viewer has not accepted the team's topic (never, or only on an earlier
 * team under the same id). A link to the Setup page, where they read and accept it (and where the
 * join card is, until they have joined).
 */
export function AcceptBanner() {
  const acceptance = useAcceptance()
  const bounds = useBoundaries()
  const nav = useNav()
  if (!acceptance.data || !boundariesSet(bounds.data)) return null
  if (isAccepted(acceptance.data.version, bounds.data.version)) return null
  return (
    <div
      role="region"
      aria-label="Accept the team's topic"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-warn-soft px-4 py-2.5"
      data-accept-banner={bounds.data.version}
    >
      <ShieldAlert aria-hidden className="size-4 shrink-0 text-warn" />
      <p className="min-w-0 flex-1 text-[12.5px] leading-snug">
        Accept the team&apos;s topic, so your Mac can answer teammates.
      </p>
      <Button size="xs" variant="outline" onClick={() => nav.setView('join')}>
        Review and accept
      </Button>
    </div>
  )
}

const VIEWS: Array<{ view: ConsoleView; label: string }> = [
  { view: 'ask', label: 'Ask' },
  { view: 'team', label: 'Team' },
  { view: 'join', label: 'Setup' },
  { view: 'settings', label: 'Team settings' },
]

/**
 * The team's pages (M11): Ask first, then the team view, Setup and Team settings (the landing page
 * stays the team's), as pills in a segmented track. `settings`: whether the team has a settings
 * page (a console server that serves one team names none).
 */
export function ViewTabs({ setup, settings = true }: { setup: { done: number } | null; settings?: boolean }) {
  const nav = useNav()
  return (
    <nav aria-label="Pages" className="max-w-full">
      <ul className="flex w-fit max-w-full items-center gap-0.5 overflow-x-auto rounded-full bg-muted p-0.5">
        {VIEWS.filter((v) => settings || v.view !== 'settings').map((v) => {
          const current = nav.view === v.view
          return (
            <li key={v.view} className="shrink-0">
              <button
                type="button"
                onClick={() => nav.setView(v.view)}
                aria-current={current ? 'page' : undefined}
                data-view-tab={v.view}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium whitespace-nowrap text-subtle outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:px-4',
                  current && 'bg-thumb text-foreground shadow-thumb',
                )}
              >
                {v.label}
                {v.view === 'join' && setup && setup.done < SETUP_STEPS ? (
                  <span className="tnum rounded-full bg-muted px-1.5 text-[11px] leading-4 font-medium text-foreground" data-setup-tab-count>
                    {setup.done}/{SETUP_STEPS}
                  </span>
                ) : null}
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

