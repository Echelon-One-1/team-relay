import { CircleAlert, CircleCheck, ExternalLink, Folder, FolderGit2, FolderOpen, HardDrive, LoaderCircle, MessageSquare, SearchX, ShieldAlert } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import type { ChangeError } from '@/api/client'
import type { MemberStatusEntry, TeamBoundaries } from '@/api/types'
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
  CHECKING,
  currentVersion,
  missingSources,
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
// what the team shares (the member, for themselves). Inside the first step, only what is not
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

/** Step 2: what the team shares, with what is new since the viewer last accepted, and Accept. */
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
        Your Mac answers teammates from these only.{' '}
        {accepted > 0 && !done ? 'Anything added since you last accepted is marked new.' : null}
      </p>
      <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]" data-topic>
        {items.topic}
      </p>
      <ul className="flex flex-col gap-1.5" aria-label="What the team shares">
        {items.orgs.map((o) => (
          <Line key={`org-${o.name}`} icon={<FolderGit2 />}>
            <span>
              GitHub: <span className="font-mono text-[12px]">{o.name}</span> <span className="text-subtle">(whole organisation)</span>
            </span>
            {o.isNew ? <NewMark /> : null}
          </Line>
        ))}
        {items.repos.map((r) => (
          <Line key={`repo-${r.name}`} icon={<FolderGit2 />}>
            <span>
              GitHub: <span className="font-mono text-[12px]">{r.name}</span>
            </span>
            {r.isNew ? <NewMark /> : null}
          </Line>
        ))}
        {items.folders.map((f) => (
          <Line key={f.key} icon={<Folder />}>
            <span className="[overflow-wrap:anywhere]">
              Google Drive: <span className="font-medium">{f.name}</span> <span className="text-subtle">({f.where})</span>
            </span>
            {f.isNew ? <NewMark /> : null}
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

/**
 * PICKERS-SPEC §7.4: what the viewer's Mac can't find of what the team shares, one line each
 * (a repository with the line that clones it). Never part of "Set up your Mac": the Mac answers
 * from the rest.
 */
function MissingSources({ entry, bounds }: { entry: MemberStatusEntry | null; bounds: TeamBoundaries | undefined }) {
  const { missing, checking } = missingSources(entry, bounds)
  if (missing.length === 0 && checking.length === 0) return null
  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-warn/30 bg-warn-soft/50 px-3 py-2.5" data-missing-sources={missing.length}>
      {missing.length > 0 ? (
        <p className="flex items-start gap-2 text-[12.5px] leading-relaxed">
          <SearchX aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warn" />
          <span>
            Your Mac can&apos;t find {missing.length} of the things your team shares. It answers from the rest.
          </span>
        </p>
      ) : null}
      {missing.length > 0 ? (
        <ul className="flex flex-col gap-2.5" aria-label="Not found on your Mac">
          {missing.map((m) => (
            <li key={m.key} className="flex min-w-0 flex-col gap-1.5 text-[12.5px] leading-relaxed" data-missing={m.key}>
              {m.kind === 'repo' ? (
                <>
                  <span>
                    <span className="font-mono text-[12px]">{m.name}</span> isn&apos;t on this Mac.
                  </span>
                  <CopyCommand text={m.command} label={`clone line for ${m.name}`} />
                  <span className="text-[12px] text-subtle">{m.todo}</span>
                </>
              ) : m.kind === 'org' ? (
                <>
                  <span className="[overflow-wrap:anywhere]">{m.todo}</span>
                  <a
                    href={m.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex w-fit items-center gap-1 text-[12px] font-medium underline underline-offset-2 hover:text-foreground"
                  >
                    See {m.name}&apos;s projects on GitHub
                    <ExternalLink aria-hidden className="size-3" />
                  </a>
                </>
              ) : (
                <span className="[overflow-wrap:anywhere]">{m.todo}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {checking.length > 0 ? (
        <ul className="flex flex-col gap-1" aria-label="Your Mac is still checking">
          {checking.map((c) => (
            <li key={c.key} className="flex min-w-0 items-center gap-2 text-[12px] text-subtle" data-checking={c.key}>
              <LoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {c.name}: checking…
              </span>
            </li>
          ))}
        </ul>
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
    <li className="flex gap-3 py-3.5" data-setup-step={step.id} data-done={step.done ? 'true' : 'false'}>
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

export function SetupPage() {
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

  const macBody = (step: SetupStep) => (
    <>
      {step.done ? (
        <p className="text-[12.5px] leading-relaxed text-subtle">
          Your Mac answers teammates in the background. To change your folders, run the setup line again.
        </p>
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
      {command ? (
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
      <MissingSources entry={v.entry} bounds={bounds.data} />
    </>
  )

  const acceptBody = (step: SetupStep) =>
    bounds.isPending ? (
      <Skeleton className="h-16 w-full" />
    ) : boundariesSet(bounds.data) ? (
      <AcceptBoundaries bounds={bounds.data} accepted={v.accepted} current={v.current} />
    ) : bounds.isError && !bounds.data ? (
      <p className="text-[12.5px] text-subtle">What the team shares didn&apos;t load. It is read again in a moment.</p>
    ) : step.done ? null : (
      <p className="text-[12.5px] leading-relaxed text-subtle">
        A team owner hasn&apos;t chosen what the team shares yet. Nothing is answered until they do.
      </p>
    )


  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
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
 * On the team page, once the viewer has joined: what the team shares changed since they last
 * accepted it (or was never accepted). A link to the Setup page, where they read and accept it.
 * Hidden while the join card shows (it says the same).
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
      aria-label="Accept what the team shares"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-warn/30 bg-warn-soft px-4 py-2.5"
      data-accept-banner={bounds.data.version}
    >
      <ShieldAlert aria-hidden className="size-4 shrink-0 text-warn" />
      <p className="min-w-0 flex-1 text-[12.5px] leading-snug">
        {first
          ? 'Accept what the team shares, so your Mac can answer teammates.'
          : 'What the team shares has changed. Accept it again, so your Mac answers from it.'}
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
]

/** The team's pages (M11): Ask first, then the team view and Setup (the landing page stays the team's). */
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

