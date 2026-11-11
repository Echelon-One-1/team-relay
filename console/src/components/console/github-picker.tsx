import { Archive, ExternalLink, FolderGit2, Lock, X } from 'lucide-react'
import { useId, useState, type FormEvent, type ReactNode } from 'react'

import type { GithubInstallation, GithubListing, RepoBoundary } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useGithubListing, useSourcesConfig } from '@/hooks/queries'
import { useNow } from '@/hooks/use-now'
import { ORGS_MAX, REPOS_MAX } from '@/lib/boundaries'
import { findListed, parseGithubAddress, repoName } from '@/lib/sources'
import { cn } from '@/lib/utils'

// PICKERS-SPEC §7.1: the GitHub part of an owner's boundaries form. The relay's GitHub App lists
// the repositories of the orgs it is installed on; the owner ticks exact repositories, or a whole
// org (its new repositories then join on their own). Pasting a github.com address always works,
// the app or not. What is chosen shows as chips above, also what the app's list does not have.

export const fieldClass =
  'h-8 w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-[12.5px] text-foreground shadow-none outline-none transition-colors placeholder:text-faint focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 aria-invalid:border-bad'

/** A filter box shows above an org's list once it has more repositories than this. */
export const FILTER_FROM = 8

export const NO_APP_LINE = "Picking from a list needs the relay's GitHub app. Whoever runs the relay can set it up."
export const NOT_INSTALLED_LINE = "The GitHub app isn't installed on any of your organisations yet. An organisation owner installs it here:"
export const GITHUB_DOWN_LINE = "GitHub didn't answer just now."
export const NOT_LISTED_NOTE = "not found in the app's list (private, renamed or not installed)"
export const PASTE_GITHUB_ERROR = 'Paste a github.com address of an organisation or a repository.'

/** One chosen source: its name, a note under it when there is one, and a remove button. */
export function SourceChip({
  icon,
  name,
  note,
  onRemove,
  removeLabel,
  action,
  data,
}: {
  icon: ReactNode
  name: ReactNode
  note?: string | null
  onRemove: () => void
  removeLabel: string
  action?: ReactNode
  data?: Record<string, string>
}) {
  return (
    <li className="flex min-w-0 items-start gap-2 rounded-md border border-hairline bg-muted/60 py-1 pr-1 pl-2 text-[12px]" {...data}>
      <span aria-hidden className="mt-1 shrink-0 text-subtle [&_svg]:size-3.5">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col py-0.5">
        <span className="min-w-0 [overflow-wrap:anywhere]">{name}</span>
        {note ? <span className="text-[11px] leading-snug text-subtle">{note}</span> : null}
        {action ? <span className="pt-1">{action}</span> : null}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeLabel}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-subtle outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40"
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </li>
  )
}

export interface GithubChoice {
  github_orgs: string[]
  github_repos: RepoBoundary[]
}

const lower = (s: string) => s.toLowerCase()
const sameRepo = (a: { org: string; repo: string }, b: { org: string; repo: string }) => lower(a.org) === lower(b.org) && lower(a.repo) === lower(b.repo)

/** One org of the app's listing: a whole-org switch, a filter box when long, and a tick per repository. */
function OrgListing({
  inst,
  choice,
  onChange,
  onNote,
}: {
  inst: GithubInstallation
  choice: GithubChoice
  onChange: (next: GithubChoice) => void
  onNote: (note: string | null) => void
}) {
  const [filter, setFilter] = useState('')
  const id = useId()
  const whole = choice.github_orgs.some((o) => lower(o) === lower(inst.account))
  const f = filter.trim().toLowerCase()
  const shown = f ? inst.repos.filter((r) => r.name.toLowerCase().includes(f)) : inst.repos
  const ticked = (name: string) => !whole && choice.github_repos.some((r) => sameRepo(r, { org: inst.account, repo: name }))
  const count = whole ? 0 : choice.github_repos.filter((r) => lower(r.org) === lower(inst.account)).length

  const setWhole = (on: boolean) => {
    onNote(null)
    if (on) {
      if (choice.github_orgs.length >= ORGS_MAX) return onNote(`At most ${ORGS_MAX} whole organisations.`)
      onChange({ github_orgs: [...choice.github_orgs, inst.account], github_repos: choice.github_repos.filter((r) => lower(r.org) !== lower(inst.account)) })
    } else {
      onChange({ ...choice, github_orgs: choice.github_orgs.filter((o) => lower(o) !== lower(inst.account)) })
    }
  }

  const tick = (repo: { name: string; id: number }, on: boolean) => {
    onNote(null)
    const rest = choice.github_repos.filter((r) => !sameRepo(r, { org: inst.account, repo: repo.name }))
    if (!on) return onChange({ ...choice, github_repos: rest })
    if (rest.length >= REPOS_MAX) return onNote(`At most ${REPOS_MAX} repositories.`)
    onChange({ ...choice, github_repos: [...rest, { org: inst.account, repo: repo.name, id: repo.id }] })
  }

  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-md border bg-canvas px-3 py-2.5" data-installation={inst.account}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-semibold">
          <FolderGit2 aria-hidden className="size-3.5 shrink-0 text-subtle" />
          <span className="truncate font-mono">{inst.account}</span>
        </span>
        {inst.state === 'ok' ? (
          <span className="tnum text-[11px] text-subtle">{whole ? 'Whole organisation' : `${count} of ${inst.repos.length} picked`}</span>
        ) : null}
      </div>
      {inst.state === 'suspended' ? (
        <p className="text-[12px] text-subtle" data-suspended>
          This installation is suspended on GitHub.
        </p>
      ) : (
        <>
          <div className="flex items-start gap-2.5">
            <Switch id={`${id}-whole`} checked={whole} onCheckedChange={setWhole} className="mt-0.5" />
            <label htmlFor={`${id}-whole`} className="text-[12px] leading-snug">
              Whole org (new repositories join automatically)
            </label>
          </div>
          {inst.repos.length > FILTER_FROM ? (
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter repositories"
              aria-label={`Filter ${inst.account} repositories`}
              disabled={whole}
              autoComplete="off"
              spellCheck={false}
              className={cn(fieldClass, 'sm:max-w-[18rem]')}
            />
          ) : null}
          {inst.repos.length === 0 ? (
            <p className="text-[12px] text-subtle">The app can't see any repositories here.</p>
          ) : (
            <ul className={cn('flex max-h-64 flex-col gap-0.5 overflow-y-auto pr-1', whole && 'opacity-60')} aria-label={`${inst.account} repositories`}>
              {shown.map((r) => (
                <li key={r.id}>
                  <label className={cn('flex min-h-8 items-center gap-2 rounded px-1 text-[12.5px] hover:bg-muted', whole ? 'cursor-not-allowed' : 'cursor-pointer')} data-repo={r.name}>
                    <input
                      type="checkbox"
                      checked={ticked(r.name)}
                      disabled={whole}
                      onChange={(e) => tick(r, e.target.checked)}
                      className="size-4 shrink-0 accent-[var(--primary)]"
                    />
                    <span className={cn('min-w-0 truncate font-mono text-[12px]', r.archived && 'text-faint')}>{r.name}</span>
                    {r.private ? (
                      <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-subtle">
                        <Lock aria-hidden className="size-3" />
                        private
                      </span>
                    ) : null}
                    {r.archived ? (
                      <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-faint">
                        <Archive aria-hidden className="size-3" />
                        archived
                      </span>
                    ) : null}
                  </label>
                </li>
              ))}
              {shown.length === 0 ? <li className="px-1 py-1 text-[12px] text-subtle">No repository matches.</li> : null}
            </ul>
          )}
          {inst.truncated ? <p className="text-[11.5px] text-subtle">Showing the first 1000.</p> : null}
        </>
      )}
    </li>
  )
}

/** The app's listing, or why there is none; `paste` is always there. */
function Listing({
  choice,
  onChange,
  onNote,
}: {
  choice: GithubChoice
  onChange: (next: GithubChoice) => void
  onNote: (note: string | null) => void
}) {
  const config = useSourcesConfig(true)
  const configured = config.data?.github.configured === true
  const listing = useGithubListing(configured)
  const now = useNow()

  const skeleton = (
    <div className="flex flex-col gap-1.5" role="status" aria-label="Loading the repositories">
      <Skeleton className="h-5 w-1/3" />
      <Skeleton className="h-7 w-full" />
      <Skeleton className="h-7 w-full" />
      <Skeleton className="h-7 w-2/3" />
    </div>
  )

  if (config.isPending) return skeleton
  const noApp = (
    <p className="text-[12px] leading-snug text-subtle" data-github-state="no-app">
      {NO_APP_LINE}
    </p>
  )
  if (config.error?.kind === 'not_found') return noApp
  if (!config.data) {
    return (
      <div className="flex flex-wrap items-center gap-2" data-github-state="error">
        <p className="text-[12px] text-subtle">The list of repositories didn&apos;t load.</p>
        <Button type="button" size="xs" variant="outline" onClick={() => void config.refetch()} disabled={config.isFetching}>
          {config.isFetching ? 'Trying…' : 'Try again'}
        </Button>
      </div>
    )
  }
  if (!configured || listing.error?.kind === 'not_found') return noApp
  if (listing.isPending) return skeleton
  if (!listing.data) {
    const err = listing.error
    const wait = err?.retryAfterMs ? Math.max(0, listing.errorUpdatedAt + err.retryAfterMs - now) : 0
    return (
      <div className="flex flex-wrap items-center gap-2" data-github-state="unavailable">
        <p className="text-[12px] text-subtle">{GITHUB_DOWN_LINE}</p>
        <Button type="button" size="xs" variant="outline" onClick={() => void listing.refetch()} disabled={listing.isFetching || wait > 0}>
          {listing.isFetching ? 'Trying…' : wait > 0 ? `Try again in ${Math.ceil(wait / 1000)} s` : 'Try again'}
        </Button>
      </div>
    )
  }
  const l: GithubListing = listing.data
  if (l.installations.length === 0) {
    const url = config.data.github.install_url
    return (
      <div className="flex flex-col items-start gap-2 rounded-md border border-dashed px-3 py-2.5" data-github-state="not-installed">
        <p className="text-[12px] leading-snug text-subtle">{NOT_INSTALLED_LINE}</p>
        <div className="flex flex-wrap items-center gap-2">
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-[12px] font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/40"
            >
              Install the app on GitHub
              <ExternalLink aria-hidden className="size-3" />
            </a>
          ) : null}
          <Button type="button" size="xs" variant="ghost" onClick={() => void listing.refetch()} disabled={listing.isFetching}>
            {listing.isFetching ? 'Checking…' : 'Check again'}
          </Button>
        </div>
      </div>
    )
  }
  return (
    <ul className="flex flex-col gap-2" aria-label="Organisations the GitHub app can see" data-github-state="listed">
      {l.installations.map((inst) => (
        <OrgListing key={inst.account} inst={inst} choice={choice} onChange={onChange} onNote={onNote} />
      ))}
    </ul>
  )
}

/** The GitHub part of the form: what is chosen, the app's listing, and the paste field. */
export function GithubPicker({
  choice,
  onChange,
  problem,
  problemId,
}: {
  choice: GithubChoice
  onChange: (next: GithubChoice) => void
  /** The form's problem with this part, when there is one (shown by the form). */
  problem?: boolean
  problemId?: string
}) {
  const config = useSourcesConfig(true)
  const listing = useGithubListing(config.data?.github.configured === true)
  const [paste, setPaste] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const id = useId()
  const listed = listing.data
  const hasOrg = (org: string) => !!listed?.installations.some((i) => lower(i.account) === lower(org))

  const change = (next: GithubChoice) => {
    setPasteError(null)
    onChange(next)
  }

  const add = (e: FormEvent | { preventDefault: () => void }) => {
    e.preventDefault()
    setNote(null)
    const a = parseGithubAddress(paste)
    if (!a) return setPasteError(PASTE_GITHUB_ERROR)
    if (a.kind === 'org') {
      if (choice.github_orgs.some((o) => lower(o) === lower(a.org))) return setPasteError(`${a.org} is already shared as a whole organisation.`)
      if (choice.github_orgs.length >= ORGS_MAX) return setPasteError(`At most ${ORGS_MAX} whole organisations.`)
      const inst = listed?.installations.find((i) => lower(i.account) === lower(a.org))
      change({ github_orgs: [...choice.github_orgs, inst?.account ?? a.org], github_repos: choice.github_repos.filter((r) => lower(r.org) !== lower(a.org)) })
    } else {
      if (choice.github_orgs.some((o) => lower(o) === lower(a.org))) return setPasteError(`${a.org} is already shared as a whole organisation, so ${a.repo} is in.`)
      if (choice.github_repos.some((r) => sameRepo(r, a))) return setPasteError(`${repoName(a)} is already listed.`)
      if (choice.github_repos.length >= REPOS_MAX) return setPasteError(`At most ${REPOS_MAX} repositories.`)
      const found = findListed(listed, a.org, a.repo)
      change({ ...choice, github_repos: [...choice.github_repos, found ?? { org: a.org, repo: a.repo, id: null }] })
    }
    setPaste('')
  }

  const repoNote = (r: RepoBoundary): string | null => {
    if (r.id === null) return 'not checked'
    if (listed && !findListed(listed, r.org, r.repo)) return NOT_LISTED_NOTE
    return null
  }

  const chosen = choice.github_orgs.length + choice.github_repos.length
  return (
    <fieldset className="flex min-w-0 flex-col gap-2" aria-describedby={`${id}-hint`} data-github-picker>
      <legend className="mb-1 text-[12px] font-medium">GitHub</legend>
      {chosen > 0 ? (
        <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2" aria-label="Chosen on GitHub">
          {choice.github_orgs.map((o) => (
            <SourceChip
              key={`org:${lower(o)}`}
              icon={<FolderGit2 />}
              name={
                <>
                  <span className="font-mono">{o}</span> <span className="text-subtle">whole organisation</span>
                </>
              }
              note={listed && !hasOrg(o) ? NOT_LISTED_NOTE : null}
              removeLabel={`Remove ${o}`}
              onRemove={() => change({ ...choice, github_orgs: choice.github_orgs.filter((x) => x !== o) })}
              data={{ 'data-chosen-org': o }}
            />
          ))}
          {choice.github_repos.map((r) => (
            <SourceChip
              key={`repo:${lower(repoName(r))}`}
              icon={<FolderGit2 />}
              name={<span className="font-mono">{repoName(r)}</span>}
              note={repoNote(r)}
              removeLabel={`Remove ${repoName(r)}`}
              onRemove={() => change({ ...choice, github_repos: choice.github_repos.filter((x) => !sameRepo(x, r)) })}
              data={{ 'data-chosen-repo': repoName(r) }}
            />
          ))}
        </ul>
      ) : null}

      <Listing choice={choice} onChange={change} onNote={setNote} />
      {note ? (
        <p role="alert" className="text-[12px] leading-snug text-bad">
          {note}
        </p>
      ) : null}

      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-paste`} className="text-[11.5px] text-subtle">
          Paste a repository or org address
        </label>
        <div className="flex gap-1.5">
          <input
            id={`${id}-paste`}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://github.com/example-org/api"
            value={paste}
            onChange={(e) => {
              setPaste(e.target.value)
              setPasteError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add(e)
            }}
            aria-invalid={pasteError || problem ? true : undefined}
            aria-describedby={[pasteError ? `${id}-paste-error` : null, problem ? problemId : null].filter(Boolean).join(' ') || undefined}
            className={cn(fieldClass, 'font-mono text-[12px] sm:max-w-[26rem]')}
          />
          <Button type="button" variant="outline" onClick={add} disabled={paste.trim() === ''}>
            Add
          </Button>
        </div>
        {pasteError ? (
          <p id={`${id}-paste-error`} role="alert" className="text-[12px] leading-snug text-bad">
            {pasteError}
          </p>
        ) : null}
      </div>
      <span id={`${id}-hint`} className="text-[11px] leading-snug text-faint">
        Members answer from the files git tracks in their own copies of these repositories. Untracked and ignored files stay
        out. At most {ORGS_MAX} whole organisations and {REPOS_MAX} repositories.
      </span>
    </fieldset>
  )
}
