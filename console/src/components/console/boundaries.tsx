import { FolderGit2, HardDrive, Plus, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'

import type { ChangeError } from '@/api/client'
import type { TeamBoundaries } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useBoundaries, useSetBoundaries } from '@/hooks/queries'
import { useNav } from '@/hooks/team'
import { useNow } from '@/hooks/use-now'
import {
  boundariesProblem,
  boundariesRefusal,
  chars,
  draftFrom,
  DRIVE_NAME_MAX,
  DRIVES_MAX,
  isSet,
  orgProblem,
  ORGS_MAX,
  sameDraft,
  tidyDomain,
  toBoundaries,
  TOPIC_MAX,
  type BoundariesDraft,
  type BoundariesField,
} from '@/lib/boundaries'
import { formatAgo, ms } from '@/lib/time'
import { cn } from '@/lib/utils'

// M10 §1: the team's boundaries, in Team settings. An owner edits and saves them (from the
// version they were read at; someone else's save in between is a conflict, and the form then
// shows the latest); a member reads them. Until they are set, answers need each member's
// approval, as before (M8), and owners are asked to set them.

export const UNSET_LINE = "Until boundaries are set, answers need each member's approval, as before."

const fieldClass =
  'h-8 w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-[12.5px] text-foreground shadow-none outline-none transition-colors placeholder:text-faint focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 aria-invalid:border-bad'

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

function OrgChip({ org, onRemove }: { org: string; onRemove?: () => void }) {
  return (
    <li className="inline-flex h-6 max-w-full items-center gap-1 rounded-md border border-hairline bg-muted/60 pl-2 text-[11.5px]" data-org={org}>
      <FolderGit2 aria-hidden className="size-3 shrink-0 text-subtle" />
      <span className="truncate font-mono">{org}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${org}`}
          className="ml-0.5 inline-flex size-6 items-center justify-center rounded-md text-subtle outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40"
        >
          <X aria-hidden className="size-3" />
        </button>
      ) : (
        <span className="pr-2" />
      )}
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
  return (
    <div className="flex flex-col gap-3" data-boundaries-view>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-[12.5px] sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-y-3">
        <dt className="text-subtle">Topic</dt>
        <dd className="mb-2 whitespace-pre-line break-words sm:mb-0" data-boundaries-topic>
          {b.topic}
        </dd>
        <dt className="text-subtle">GitHub orgs</dt>
        <dd className="mb-2 sm:mb-0">
          {b.github_orgs.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5" aria-label="GitHub orgs">
              {b.github_orgs.map((o) => (
                <OrgChip key={o} org={o} />
              ))}
            </ul>
          ) : (
            <span className="text-subtle">None</span>
          )}
        </dd>
        <dt className="text-subtle">Shared drives</dt>
        <dd className="mb-2 sm:mb-0">
          {b.drives.length > 0 ? (
            <ul className="flex flex-col gap-1" aria-label="Shared drives">
              {b.drives.map((d) => (
                <li key={`${d.domain}/${d.shared_drive}`} className="flex min-w-0 items-center gap-1.5" data-drive={d.shared_drive}>
                  <HardDrive aria-hidden className="size-3.5 shrink-0 text-subtle" />
                  <span className="truncate font-medium">{d.shared_drive}</span>
                  <span className="shrink-0 font-mono text-[11px] text-subtle">{d.domain}</span>
                </li>
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

const isDrive = (f: BoundariesField | undefined, i: number, part: 'domain' | 'shared_drive') =>
  typeof f === 'object' && f.drive === i && f.part === part

/** An owner's form. `reload` reads the boundaries again (after a conflict) and resolves with them. */
function BoundariesForm({ data, reload }: { data: TeamBoundaries; reload: () => Promise<TeamBoundaries | undefined> }) {
  const save = useSetBoundaries()
  const [base, setBase] = useState(data)
  const [draft, setDraft] = useState<BoundariesDraft>(() => draftFrom(data.boundaries))
  const [org, setOrg] = useState('')
  const [orgError, setOrgError] = useState<string | null>(null)
  const [problem, setProblem] = useState<{ field: BoundariesField; message: string } | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const id = useId()
  const ids = {
    topic: `${id}-topic`,
    topicHint: `${id}-topic-hint`,
    org: `${id}-org`,
    orgHint: `${id}-org-hint`,
    drivesHint: `${id}-drives-hint`,
    folders: `${id}-folders`,
    foldersHint: `${id}-folders-hint`,
    error: `${id}-error`,
  }
  const dirty = !sameDraft(draft, draftFrom(base.boundaries))
  const newer = data.version !== base.version

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

  const addOrg = (): string[] | null => {
    const o = org.trim()
    if (o === '') return draft.github_orgs
    const p = orgProblem(o, draft.github_orgs)
    if (p) {
      setOrgError(p)
      return null
    }
    const next = [...draft.github_orgs, o]
    edit({ github_orgs: next })
    setOrg('')
    setOrgError(null)
    return next
  }

  const onOrgKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addOrg()
    }
  }

  const discard = () => {
    const from = newer ? data : base
    setBase(from)
    setDraft(draftFrom(from.boundaries))
    setOrg('')
    setOrgError(null)
    setProblem(null)
    setRefusal(null)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    // An org typed but not yet added goes in with the rest.
    const orgs = addOrg()
    if (orgs === null) return
    const d = { ...draft, github_orgs: orgs }
    const p = boundariesProblem(d)
    if (p) {
      setProblem(p)
      return
    }
    setProblem(null)
    setRefusal(null)
    save.mutate(
      { version: base.version, boundaries: toBoundaries(d) },
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
  const drivesFull = draft.drives.length >= DRIVES_MAX

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4" aria-label="Team boundaries" data-boundaries-form>
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

      <div className="flex flex-col gap-1.5">
        <label htmlFor={ids.org} className="text-[12px] font-medium">
          GitHub orgs
        </label>
        {draft.github_orgs.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" aria-label="Added GitHub orgs">
            {draft.github_orgs.map((o) => (
              <OrgChip key={o} org={o} onRemove={() => edit({ github_orgs: draft.github_orgs.filter((x) => x !== o) })} />
            ))}
          </ul>
        ) : null}
        <div className="flex gap-1.5">
          <input
            id={ids.org}
            type="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={39}
            placeholder="your-org"
            value={org}
            disabled={draft.github_orgs.length >= ORGS_MAX}
            onChange={(e) => {
              setOrg(e.target.value.replace(/\s/g, ''))
              setOrgError(null)
            }}
            onKeyDown={onOrgKey}
            aria-invalid={invalid(orgError !== null || problem?.field === 'org')}
            aria-describedby={orgError ? `${ids.org}-error ${ids.orgHint}` : describedBy(ids.orgHint, problem?.field === 'org')}
            className={cn(fieldClass, 'font-mono text-[12px] sm:max-w-[18rem]')}
          />
          <Button type="button" variant="outline" onClick={() => addOrg()} disabled={org.trim() === ''}>
            Add
          </Button>
        </div>
        {orgError ? (
          <p id={`${ids.org}-error`} role="alert" className="text-[12px] leading-snug text-bad">
            {orgError}
          </p>
        ) : null}
        <span id={ids.orgHint} className="text-[11px] leading-snug text-faint">
          Members answer from the files git tracks in their clones of these orgs' repositories. Untracked and ignored files
          stay out. At most {ORGS_MAX}.
        </span>
      </div>

      <fieldset className="flex min-w-0 flex-col gap-1.5" aria-describedby={ids.drivesHint}>
        <legend className="mb-1.5 text-[12px] font-medium">Shared drives</legend>
        {draft.drives.length > 0 ? (
          <ul className="flex flex-col gap-2 sm:gap-1.5" aria-label="Added shared drives">
            {draft.drives.map((d, i) => (
              <li key={i} className="flex flex-col gap-1.5 sm:flex-row sm:items-center" data-drive-row={i}>
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={253}
                  placeholder="example.com"
                  aria-label={`Domain of shared drive ${i + 1}`}
                  value={d.domain}
                  onChange={(e) => edit({ drives: draft.drives.map((x, j) => (j === i ? { ...x, domain: tidyDomain(e.target.value) } : x)) })}
                  aria-invalid={invalid(isDrive(problem?.field, i, 'domain'))}
                  aria-describedby={isDrive(problem?.field, i, 'domain') ? ids.error : undefined}
                  className={cn(fieldClass, 'font-mono text-[12px] sm:w-[38%]')}
                />
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <input
                    type="text"
                    autoComplete="off"
                    maxLength={DRIVE_NAME_MAX}
                    placeholder="Team Drive"
                    aria-label={`Name of shared drive ${i + 1}`}
                    value={d.shared_drive}
                    onChange={(e) => edit({ drives: draft.drives.map((x, j) => (j === i ? { ...x, shared_drive: e.target.value } : x)) })}
                    aria-invalid={invalid(isDrive(problem?.field, i, 'shared_drive'))}
                    aria-describedby={isDrive(problem?.field, i, 'shared_drive') ? ids.error : undefined}
                    className={fieldClass}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove shared drive ${i + 1}`}
                    onClick={() => edit({ drives: draft.drives.filter((_, j) => j !== i) })}
                  >
                    <X aria-hidden />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={drivesFull}
            onClick={() => edit({ drives: [...draft.drives, { domain: draft.drives.at(-1)?.domain ?? '', shared_drive: '' }] })}
          >
            <Plus aria-hidden />
            Add a shared drive
          </Button>
        </div>
        <span id={ids.drivesHint} className="text-[11px] leading-snug text-faint">
          The Google Workspace domain and the drive's name exactly as it shows under "Shared drives". Members answer from it
          through Google Drive for desktop, signed in with an account in that domain. At most {DRIVES_MAX}.
        </span>
      </fieldset>

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
            Each member picks them on their own computer with /team-relay:folders. Off, members answer only from the orgs and
            drives above.
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
