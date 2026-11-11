import { Folder, FolderGit2, HardDrive } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'

import type { ChangeError } from '@/api/client'
import type { TeamBoundaries } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useBoundaries, useMe, useSetBoundaries } from '@/hooks/queries'
import { useNav, useTeam } from '@/hooks/team'
import { useNow } from '@/hooks/use-now'
import {
  boundariesProblem,
  boundariesRefusal,
  chars,
  draftFrom,
  isSet,
  sameDraft,
  toBoundaries,
  TOPIC_MAX,
  type BoundariesDraft,
  type BoundariesField,
} from '@/lib/boundaries'
import { emailDomain, folderWhere, isWholeDrive, repoName } from '@/lib/sources'
import { formatAgo, ms } from '@/lib/time'
import { cn } from '@/lib/utils'
import { DriveFolders } from './drive-folders'
import { fieldClass, GithubPicker } from './github-picker'

// M10 §1 and PICKERS-SPEC §7: the team's boundaries, in Team settings. An owner edits and saves
// them (from the version they were read at; someone else's save in between is a conflict, and
// the form then shows the latest): the topic, GitHub (picked from the relay's GitHub app, or
// pasted), Google Drive folders (picked in Google's own picker, or pasted) and members' own
// folders. A member reads them. Until they are set, answers need each member's approval, as
// before (M8), and owners are asked to set them.

export const UNSET_LINE = "Until boundaries are set, answers need each member's approval, as before."

function Changed({ data }: { data: TeamBoundaries }) {
  const now = useNow()
  const at = ms(data.updated_at)
  if (!isSet(data)) return null
  return (
    <span className="text-[11.5px] text-subtle" data-boundaries-version={data.version}>
      Version {data.version}
      {data.updated_by ? (
        <>
          , set by <span className="font-mono text-foreground">{data.updated_by}</span>
        </>
      ) : null}
      {at !== null ? <span title={new Date(at).toISOString()}> {formatAgo(now - at)}</span> : null}
    </span>
  )
}

function ViewLine({ icon, children, data }: { icon: ReactNode; children: ReactNode; data?: Record<string, string> }) {
  return (
    <li className="flex min-w-0 items-center gap-1.5" {...data}>
      <span aria-hidden className="shrink-0 text-subtle [&_svg]:size-3.5">
        {icon}
      </span>
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </li>
  )
}

/** A member's view: what the team's answerers may read and talk about. */
function BoundariesView({ data }: { data: TeamBoundaries }) {
  if (!isSet(data)) {
    return (
      <p className="rounded-md border border-dashed border-border px-3 py-2.5 text-[12.5px] leading-relaxed text-subtle" data-boundaries-unset>
        No boundaries yet. Until an owner sets them, answers need each member's approval, as before.
      </p>
    )
  }
  const b = data.boundaries
  const github = b.github_orgs.length + b.github_repos.length
  const drive = b.drive_folders.length + b.drives.length
  return (
    <div className="flex flex-col gap-3" data-boundaries-view>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-[12.5px] sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-y-3">
        <dt className="text-subtle">Topic</dt>
        <dd className="mb-2 whitespace-pre-line break-words sm:mb-0" data-boundaries-topic>
          {b.topic}
        </dd>
        <dt className="text-subtle">GitHub</dt>
        <dd className="mb-2 sm:mb-0">
          {github > 0 ? (
            <ul className="flex flex-col gap-1" aria-label="GitHub">
              {b.github_orgs.map((o) => (
                <ViewLine key={`org:${o}`} icon={<FolderGit2 />} data={{ 'data-org': o }}>
                  <span className="font-mono">{o}</span> <span className="text-subtle">whole organisation</span>
                </ViewLine>
              ))}
              {b.github_repos.map((r) => (
                <ViewLine key={`repo:${repoName(r)}`} icon={<FolderGit2 />} data={{ 'data-repo': repoName(r) }}>
                  <span className="font-mono">{repoName(r)}</span>
                </ViewLine>
              ))}
            </ul>
          ) : (
            <span className="text-subtle">None</span>
          )}
        </dd>
        <dt className="text-subtle">Google Drive</dt>
        <dd className="mb-2 sm:mb-0">
          {drive > 0 ? (
            <ul className="flex flex-col gap-1" aria-label="Google Drive">
              {b.drive_folders.map((f) => (
                <ViewLine key={`folder:${f.folder_id}`} icon={isWholeDrive(f) ? <HardDrive /> : <Folder />} data={{ 'data-folder': f.folder_id }}>
                  <span className="font-medium">{f.folder_name}</span> <span className="text-subtle">{folderWhere(f)}</span>
                </ViewLine>
              ))}
              {b.drives.map((d) => (
                <ViewLine key={`drive:${d.domain}/${d.shared_drive}`} icon={<HardDrive />} data={{ 'data-drive': d.shared_drive }}>
                  <span className="font-medium">{d.shared_drive}</span> <span className="text-subtle">shared drive, matched by name</span>
                </ViewLine>
              ))}
            </ul>
          ) : (
            <span className="text-subtle">None</span>
          )}
        </dd>
        <dt className="text-subtle">Members' own folders</dt>
        <dd data-member-folders={b.member_folders ? 'allowed' : 'not-allowed'}>
          {b.member_folders ? 'Allowed: each member may add folders of their own' : 'Not allowed'}
        </dd>
      </dl>
      <Changed data={data} />
    </div>
  )
}

/** An owner's form. `reload` reads the boundaries again (after a conflict) and resolves with them. */
function BoundariesForm({ data, reload }: { data: TeamBoundaries; reload: () => Promise<TeamBoundaries | undefined> }) {
  const save = useSetBoundaries()
  const nav = useNav()
  const me = useMe()
  const team = useTeam()
  const [base, setBase] = useState(data)
  const [draft, setDraft] = useState<BoundariesDraft>(() => draftFrom(data.boundaries))
  const [problem, setProblem] = useState<{ field: BoundariesField; message: string } | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const id = useId()
  const ids = {
    topic: `${id}-topic`,
    topicHint: `${id}-topic-hint`,
    folders: `${id}-folders`,
    foldersHint: `${id}-folders-hint`,
    error: `${id}-error`,
  }
  const dirty = !sameDraft(draft, draftFrom(base.boundaries))
  const newer = data.version !== base.version
  const viewerDomain = emailDomain(nav.teams?.email ?? me.data?.email)

  // Another owner's save arrives while nothing is being edited here: show it.
  useEffect(() => {
    if (newer && !dirty) {
      setBase(data)
      setDraft(draftFrom(data.boundaries))
    }
  }, [newer, dirty, data])

  const edit = (next: Partial<BoundariesDraft>) => {
    setDraft((d) => ({ ...d, ...next }))
    setProblem(null)
    setRefusal(null)
    setSaved(false)
  }

  const discard = () => {
    const from = newer ? data : base
    setBase(from)
    setDraft(draftFrom(from.boundaries))
    setProblem(null)
    setRefusal(null)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const p = boundariesProblem(draft)
    if (p) {
      setProblem(p)
      return
    }
    setProblem(null)
    setRefusal(null)
    save.mutate(
      { version: base.version, boundaries: toBoundaries(draft) },
      {
        onSuccess: (out) => {
          if (out && typeof out === 'object' && typeof out.version === 'number') {
            setBase(out)
            setDraft(draftFrom(out.boundaries))
          }
          setSaved(true)
        },
        onError: (err: ChangeError) => {
          const r = boundariesRefusal(err)
          setRefusal(r.message)
          if (r.conflict) {
            void reload().then((fresh) => {
              if (fresh) {
                setBase(fresh)
                setDraft(draftFrom(fresh.boundaries))
              }
            })
          }
        },
      },
    )
  }

  const error = problem?.message ?? refusal
  const invalid = (yes: boolean) => (yes ? true : undefined)
  const describedBy = (hint: string, yes: boolean) => (yes ? `${ids.error} ${hint}` : hint)
  const topicLength = chars(draft.topic.trim())

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5" aria-label="Team boundaries" data-boundaries-form>
      {!isSet(base) ? (
        <div className="flex flex-col gap-0.5 rounded-md border border-signal/30 bg-signal-soft px-3 py-2.5" data-boundaries-unset>
          <p className="text-[12.5px] font-semibold text-foreground">Set this team's boundaries</p>
          <p className="text-[12px] leading-snug text-subtle">{UNSET_LINE}</p>
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor={ids.topic} className="text-[12px] font-medium">
            Topic
          </label>
          <span className={cn('tnum text-[11px]', topicLength > TOPIC_MAX ? 'text-bad' : 'text-faint')} aria-hidden>
            {topicLength}/{TOPIC_MAX}
          </span>
        </div>
        <textarea
          id={ids.topic}
          rows={3}
          value={draft.topic}
          placeholder="Example Co: our clients and their delivery, our products and tools, engineering and team work."
          onChange={(e) => edit({ topic: e.target.value })}
          aria-invalid={invalid(problem?.field === 'topic')}
          aria-describedby={describedBy(ids.topicHint, problem?.field === 'topic')}
          className={cn(fieldClass, 'h-auto min-h-[4.5rem] resize-y py-1.5 leading-snug')}
          data-focus-first
        />
        <span id={ids.topicHint} className="text-[11px] leading-snug text-faint">
          What the team talks about. Questions about anything else are declined on their own.
        </span>
      </div>

      <GithubPicker
        choice={{ github_orgs: draft.github_orgs, github_repos: draft.github_repos }}
        onChange={(c) => edit(c)}
        problem={problem?.field === 'github'}
        problemId={ids.error}
      />

      <DriveFolders choice={{ drive_folders: draft.drive_folders, drives: draft.drives }} onChange={(c) => edit(c)} team={team} viewerDomain={viewerDomain} />

      <div className="flex items-start gap-3">
        <Switch
          id={ids.folders}
          checked={draft.member_folders}
          onCheckedChange={(v) => edit({ member_folders: v })}
          aria-describedby={ids.foldersHint}
          className="mt-0.5"
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          <label htmlFor={ids.folders} className="text-[12px] font-medium">
            Members may add their own folders
          </label>
          <span id={ids.foldersHint} className="text-[11px] leading-snug text-faint">
            Each member picks them on their own computer with /team-relay:folders. Off, members answer only from GitHub and
            Google Drive above.
          </span>
        </div>
      </div>

      {error ? (
        <p id={ids.error} role="alert" className="text-[12px] leading-snug text-bad" data-error>
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 border-t border-hairline pt-3">
        <span role="status" aria-live="polite" className="min-w-0 text-[11.5px] text-subtle">
          {saved ? (
            <span className="text-ok" data-boundaries-saved>
              Saved. Answers use version {base.version} from the next question on.
            </span>
          ) : newer ? (
            'Someone else saved a newer version: Discard to see it, or save and redo your change on it.'
          ) : dirty ? (
            'Unsaved changes'
          ) : (
            <Changed data={base} />
          )}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button type="button" variant="ghost" onClick={discard} disabled={(!dirty && !newer) || save.isPending}>
            Discard
          </Button>
          <Button type="submit" disabled={!dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save boundaries'}
          </Button>
        </div>
      </div>
    </form>
  )
}

/**
 * Team settings → Boundaries. `owner`: the viewer may change them; `roleKnown`: whether that is
 * settled yet (the roster or /me has answered). Brought into view (and, for an owner, the first
 * field focused) when the console asks for it, straight after a team is created.
 */
export function BoundariesSection({ owner, roleKnown = true }: { owner: boolean; roleKnown?: boolean }) {
  const q = useBoundaries()
  const nav = useNav()
  const ref = useRef<HTMLElement>(null)
  const headingId = useId()
  const ready = (q.data !== undefined || q.isError) && roleKnown
  const { focus, clearFocus } = nav

  useEffect(() => {
    if (focus !== 'boundaries' || !ready) return
    const el = ref.current
    if (el) {
      if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start', behavior: 'smooth' })
      const first = owner ? el.querySelector<HTMLElement>('[data-focus-first]') : null
      ;(first ?? el).focus({ preventScroll: true })
    }
    clearFocus()
  }, [focus, ready, owner, clearFocus])

  let body
  if (q.isPending) {
    body = (
      <div className="flex flex-col gap-2" role="status" aria-label="Loading the boundaries">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-8 w-1/2" />
      </div>
    )
  } else if (q.error?.kind === 'not_found') {
    body = (
      <p className="text-[12.5px] leading-relaxed text-subtle" data-boundaries-missing>
        This relay does not keep boundaries yet. Answers need each member's approval, as before.
      </p>
    )
  } else if (!q.data) {
    body = (
      <div className="flex flex-wrap items-center gap-2" data-boundaries-error>
        <p role="alert" className="text-[12.5px] text-bad">
          The boundaries could not be read.
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => void q.refetch()} disabled={q.isFetching}>
          {q.isFetching ? 'Trying…' : 'Try again'}
        </Button>
      </div>
    )
  } else if (owner) {
    body = <BoundariesForm data={q.data} reload={async () => (await q.refetch()).data} />
  } else {
    body = <BoundariesView data={q.data} />
  }

  return (
    <section
      ref={ref}
      id="boundaries"
      tabIndex={-1}
      aria-labelledby={headingId}
      className="flex scroll-mt-4 flex-col gap-3 px-4 py-3.5 outline-none"
      data-boundaries
    >
      <div className="flex flex-col gap-0.5">
        <h3 id={headingId} className="text-[12.5px] font-semibold">
          Boundaries
        </h3>
        <p className="text-[12px] leading-snug text-subtle">
          Inside them, teammates' questions are answered on their own, without approval dialogs. Questions off the topic
          are declined.{owner ? '' : ' Only owners change them.'}
        </p>
      </div>
      {body}
    </section>
  )
}
