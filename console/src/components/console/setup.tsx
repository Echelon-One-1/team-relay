import { CircleCheck, FolderGit2, FolderOpen, HardDrive, MessageSquare, ShieldAlert } from 'lucide-react'
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
  boundaryItems,
  currentVersion,
  publicOrigin,
  SETUP_STEPS,
  setupCommand,
  setupSteps,
  type SetupStep,
} from '@/lib/setup'
import { cn } from '@/lib/utils'
import { CopyCommand } from './copy'
import { Panel } from './primitives'

// M11 §6: the Join page. After accepting the invitation, a member sets up their Mac with one
// command and watches seven steps tick as the Mac reports in (members-status and the
// acceptance, read every 5 s while the page is visible). The boundaries are accepted here, by
// the member, for themselves. Any member can come back to it from the page tabs.

function NewMark() {
  return (
    <span className="inline-flex h-[17px] items-center rounded bg-signal-soft px-1.5 text-[10.5px] font-medium text-signal" data-new>
      new
    </span>
  )
}

function Line({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex min-w-0 items-center gap-2 text-[12.5px]">
      <span aria-hidden className="text-subtle [&_svg]:size-3.5">
        {icon}
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">{children}</span>
    </li>
  )
}

/** Step 6: what the viewer accepts, with what changed since their last acceptance, and Accept. */
function AcceptBoundaries({
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
  const items = boundaryItems(bounds, accepted)
  // members-status already names a newer version: the one on screen is about to be replaced.
  const stale = bounds.version < current
  const done = accepted === bounds.version && !stale
  const submit = () => {
    setError(null)
    accept.mutate({ version: bounds.version }, { onError: (err: ChangeError) => setError(acceptRefusal(err)) })
  }
  return (
    <div className="flex flex-col gap-2.5 rounded-md border bg-canvas px-3 py-2.5" data-accept-boundaries={bounds.version}>
      <p className="text-[12px] text-subtle">
        Your Mac answers from these only (version {bounds.version}).{' '}
        {accepted > 0 && !done ? `You accepted version ${accepted}; what was added since is marked new.` : null}
      </p>
      <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]" data-topic>
        {items.topic}
      </p>
      <ul className="flex flex-col gap-1.5" aria-label="What your Mac answers from">
        {items.orgs.map((o) => (
          <Line key={`org-${o.name}`} icon={<FolderGit2 />}>
            <span>
              GitHub org <span className="font-mono text-[12px]">{o.name}</span>
            </span>
            {o.isNew ? <NewMark /> : null}
          </Line>
        ))}
        {items.drives.map((d) => (
          <Line key={`drive-${d.domain}-${d.shared_drive}`} icon={<HardDrive />}>
            <span className="[overflow-wrap:anywhere]">
              Shared drive <span className="font-medium">{d.shared_drive}</span> <span className="text-subtle">({d.domain})</span>
            </span>
            {d.isNew ? <NewMark /> : null}
          </Line>
        ))}
        <Line icon={<FolderOpen />}>
          <span>{items.memberFolders.allowed ? 'You may add folders of your own' : 'No folders of your own'}</span>
          {items.memberFolders.isNew ? <NewMark /> : null}
        </Line>
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={submit} disabled={done || stale || accept.isPending}>
          {done ? `Accepted version ${bounds.version}` : accept.isPending ? 'Accepting…' : `Accept version ${bounds.version}`}
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

function StepItem({ n, step, children }: { n: number; step: SetupStep; children?: ReactNode }) {
  return (
    <li className="flex gap-3 py-3" data-setup-step={step.id} data-done={step.done ? 'true' : 'false'}>
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
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <h3 className={cn('text-[13px] leading-5 font-semibold', step.done && 'text-subtle')}>
          {step.title}
          <span className="sr-only">{step.done ? ' (done)' : ' (to do)'}</span>
        </h3>
        {step.done ? null : <p className="text-[12.5px] leading-relaxed text-subtle">{step.todo}</p>}
        {children}
      </div>
    </li>
  )
}

export function SetupPage() {
  const me = useMe()
  const join = useJoin()
  const nav = useNav()
  const statuses = useMembersStatus(SETUP_INTERVAL_MS)
  const acceptance = useAcceptance(SETUP_INTERVAL_MS)
  const bounds = useBoundaries()
  const refresh = useRefreshBoundaries()

  const member = me.data?.member ?? null
  const entry = statuses.data?.members.find((m) => m.member === member) ?? null
  const statusVersion = statuses.data?.boundaries_version ?? null
  const shownVersion = bounds.data?.version ?? null
  // members-status names a newer version than the boundaries on screen: read them again.
  useEffect(() => {
    if (statusVersion !== null && shownVersion !== null && statusVersion > shownVersion) refresh()
  }, [statusVersion, shownVersion, refresh])

  const current = currentVersion(bounds.data, statusVersion)
  const accepted = acceptedVersion(entry, acceptance.data)
  const steps = setupSteps(entry, bounds.data, accepted, current)
  const done = steps.filter((s) => s.done).length
  const origin = publicOrigin(window.location, join.data)
  const loading = me.isPending || statuses.isPending
  const missing = statuses.error?.kind === 'not_found'

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <Panel
        id="setup"
        title="Set up your Mac"
        aside={
          loading || missing ? null : (
            <span className="tnum text-[12px] text-subtle" data-setup-count={done}>
              {done} of {SETUP_STEPS} done
            </span>
          )
        }
      >
        <div className="flex flex-col gap-3 px-4 pt-3.5">
          <p className="text-[12.5px] leading-relaxed text-subtle">
            Run one command in Terminal on your Mac. It installs what is needed, signs you in and starts answering
            teammates in the background. The steps below tick on their own as your Mac reports in.
          </p>
          {origin ? (
            <CopyCommand text={setupCommand(origin)} label="setup command" />
          ) : join.isPending ? (
            <Skeleton className="h-8 w-full" />
          ) : (
            <p className="text-[12.5px] text-subtle" data-no-command>
              The setup command is on the team&apos;s hosted console. Ask a team owner for it.
            </p>
          )}
          {missing ? (
            <p className="text-[12.5px] text-subtle" data-setup-missing>
              This relay does not report setup progress yet, so nothing ticks here.
            </p>
          ) : statuses.isError && !statuses.data ? (
            <p className="text-[12.5px] text-subtle">Your progress did not load. It is checked again in a few seconds.</p>
          ) : null}
        </div>
        {loading ? (
          <div className="flex flex-col gap-3 p-4" aria-label="Loading your progress">
            <Skeleton className="h-5 w-2/5" />
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-5 w-1/3" />
          </div>
        ) : (
          <ol className="divide-y divide-hairline px-4" aria-label="Setup steps">
            {steps.map((s, i) => (
              <StepItem key={s.id} n={i + 1} step={s}>
                {s.id === 'boundaries' ? (
                  bounds.isPending ? (
                    <Skeleton className="h-16 w-full" />
                  ) : boundariesSet(bounds.data) ? (
                    <AcceptBoundaries bounds={bounds.data} accepted={accepted} current={current} />
                  ) : bounds.isError && !bounds.data ? (
                    <p className="text-[12.5px] text-subtle">The boundaries did not load. They are read again in a moment.</p>
                  ) : null
                ) : null}
              </StepItem>
            ))}
          </ol>
        )}
        {!loading && done === SETUP_STEPS ? (
          <div className="mx-4 mb-4 flex flex-wrap items-center gap-3 rounded-md border border-ok/30 bg-ok-soft px-3 py-2.5" data-setup-complete>
            <CircleCheck aria-hidden className="size-4 shrink-0 text-ok" />
            <p className="min-w-0 flex-1 text-[13px] font-medium">You&apos;re set up. Your Mac answers teammates in the background.</p>
            <Button size="sm" onClick={() => nav.setView('ask')}>
              <MessageSquare aria-hidden />
              Ask the team
            </Button>
          </div>
        ) : (
          <div className="h-1" />
        )}
      </Panel>
    </div>
  )
}

/**
 * M11 §6 item 6: on the team page, the boundaries changed since the viewer last accepted them
 * (or were never accepted). A link to the Join page, where they read and accept them.
 */
export function AcceptBanner() {
  const acceptance = useAcceptance()
  const bounds = useBoundaries()
  const nav = useNav()
  if (!acceptance.data || !boundariesSet(bounds.data)) return null
  if (acceptance.data.version === bounds.data.version) return null
  const first = acceptance.data.version === 0
  return (
    <div
      role="region"
      aria-label="Boundaries to accept"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-warn/30 bg-warn-soft px-4 py-2.5"
      data-accept-banner={bounds.data.version}
    >
      <ShieldAlert aria-hidden className="size-4 shrink-0 text-warn" />
      <p className="min-w-0 flex-1 text-[12.5px] leading-snug">
        {first
          ? "Accept the team's boundaries so your Mac can answer teammates."
          : "The team's boundaries changed. Accept the new version so your Mac answers from it."}
      </p>
      <Button size="xs" variant="outline" onClick={() => nav.setView('join')}>
        Review and accept
      </Button>
    </div>
  )
}

const VIEWS: Array<{ view: ConsoleView; label: string }> = [
  { view: 'team', label: 'Team' },
  { view: 'ask', label: 'Ask' },
  { view: 'join', label: 'Setup' },
]

/** The team's pages (M11): the team view, Ask, and the Join checklist ("Setup"). */
export function ViewTabs({ setup }: { setup: { done: number } | null }) {
  const nav = useNav()
  return (
    <nav aria-label="Pages" className="-mb-1">
      <ul className="flex items-center gap-1">
        {VIEWS.map((v) => {
          const current = nav.view === v.view
          return (
            <li key={v.view}>
              <button
                type="button"
                onClick={() => nav.setView(v.view)}
                aria-current={current ? 'page' : undefined}
                data-view-tab={v.view}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium text-subtle outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40',
                  current && 'bg-card text-foreground shadow-[0_0_0_1px_var(--border)]',
                )}
              >
                {v.label}
                {v.view === 'join' && setup && setup.done < SETUP_STEPS ? (
                  <span className="tnum text-[11px] font-normal text-subtle" data-setup-tab-count>
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
