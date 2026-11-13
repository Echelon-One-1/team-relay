import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleCheck, Folder, FolderPlus, LoaderCircle, PartyPopper, X } from 'lucide-react'
import { useId, useState, useSyncExternalStore, type ReactNode } from 'react'

import { api, type ApiError, type ChangeError } from '@/api/client'
import { isHosted } from '@/api/key'
import type { LocalChoice, LocalSetup, PreviousFolder } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useAcceptance, useBoundaries } from '@/hooks/queries'
import { useNav } from '@/hooks/team'
import { acceptedVersion, boundariesSet, isAccepted } from '@/lib/setup'
import { cn } from '@/lib/utils'
import { Panel } from './primitives'
import { AcceptBoundaries, SetupPage } from './setup'
import { FullPage } from './states'

// /team-relay:setup: the Setup page on the member's own Mac, served by the setup page's console
// server (plugin/src/setup-page.ts) with its own routes (/api/local/*). Each step shows whether it
// is done, still to do, or not needed: signed in, accept the team's topic, the one list of folders
// the member's Claude answers from (added only with the Mac's folder chooser), background answering
// (on unless they turn it off; off and disabled, with the reason, where it cannot run), then Done.
// Done never fails because of background answering: when turning it on fails at Done, the error
// shows and "Finish without it" finishes anyway. The hosted console never calls /api/local, and a local
// console without those routes (404) shows the usual Setup page.

export const localSetupKey = ['local-setup'] as const

export const FOLDERS_HINT =
  'Add every folder you use for your team, up to 20. Inside a git project, only the files git tracks are read.'
export const PREVIOUS_TEXT = 'Folders you chose before this change — add the ones you still want with Add folder'
export const PREVIOUS_KIND: Record<PreviousFolder['kind'], string> = { repo_root: 'repository root', own_folder: 'your own folder' }
export const BACKGROUND_TEXT = "Answers teammates' questions from your folders even when Claude is closed."
export const FINISHED_TEXT = 'All set. Go back to Claude.'
export const BACKGROUND_FAILED_TEXT = 'Background answering could not be turned on. Press Done to try again, or finish without it.'
export const NO_CHOOSER_TEXT = 'This computer has no folder chooser. In Claude Code, type /team-relay:folders to add your folders.'

// -- Done: the page's last word, once its server has stopped ------------------------------------------

let finished = false
const listeners = new Set<() => void>()

/** The member pressed Done: the whole page becomes the last word (its server stops). */
export function markSetupFinished(): void {
  finished = true
  for (const l of listeners) l()
}

/** Tests only. */
export function resetSetupFinished(): void {
  finished = false
}

export function useSetupFinished(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => finished,
  )
}

export function SetupFinished() {
  return (
    <FullPage icon={<PartyPopper className="size-4" />} title="Done">
      <p data-setup-finished>{FINISHED_TEXT}</p>
    </FullPage>
  )
}

// -- the view ---------------------------------------------------------------------------------------

/** The Setup view: on the member's Mac with the setup routes, the local steps; else the usual page. */
export function SetupView() {
  if (isHosted()) return <SetupPage />
  return <LocalSetupGate />
}

function LocalSetupGate() {
  const q = useQuery<LocalSetup, ApiError>({
    queryKey: localSetupKey,
    queryFn: async () => (await api.localSetup()).data,
    retry: false,
    refetchOnWindowFocus: false,
  })
  if (q.isPending) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 rounded-xl border bg-card p-4" aria-label="Loading your setup">
        <Skeleton className="h-5 w-2/5" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-5 w-1/3" />
      </div>
    )
  }
  // A console started without the setup page's routes: the usual Setup page.
  if (q.error?.kind === 'not_found') return <SetupPage />
  if (q.error || !q.data) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col items-start gap-3 rounded-xl border bg-card p-4" role="alert" data-local-setup-error>
        <p className="text-[13px]">Your setup didn&apos;t load. Check that Claude is still open, then try again.</p>
        <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
          Try again
        </Button>
      </div>
    )
  }
  return <LocalSetupPage setup={q.data} />
}

type StepState = 'done' | 'todo' | 'not_needed'

function Step({ n, title, state, children }: { n: number; title: string; state: StepState; children?: ReactNode }) {
  const label = state === 'done' ? ' (done)' : state === 'todo' ? ' (to do)' : ' (not needed)'
  return (
    <li className="flex gap-3 py-3.5" data-local-step={n} data-state={state}>
      {state === 'done' ? (
        <CircleCheck aria-hidden className="mt-px size-5 shrink-0 text-ok" />
      ) : (
        <span
          aria-hidden
          className={cn(
            'tnum mt-px inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium text-subtle',
            state === 'not_needed' && 'border-dashed',
          )}
        >
          {n}
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <h3 className={cn('text-[13.5px] leading-5 font-semibold', state !== 'todo' && 'text-subtle')}>
          {title}
          <span className="sr-only">{label}</span>
        </h3>
        {children}
      </div>
    </li>
  )
}

function Note({ children, tone = 'subtle' }: { children: ReactNode; tone?: 'subtle' | 'bad' }) {
  return (
    <p role={tone === 'bad' ? 'alert' : undefined} className={cn('text-[12.5px] leading-relaxed', tone === 'bad' ? 'text-bad' : 'text-subtle')}>
      {children}
    </p>
  )
}

export function LocalSetupPage({ setup }: { setup: LocalSetup }) {
  const nav = useNav()
  const qc = useQueryClient()
  const bounds = useBoundaries()
  const acceptance = useAcceptance()
  const [folders, setFolders] = useState<string[]>(setup.folders)
  const [choosing, setChoosing] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [choice, setChoice] = useState<LocalChoice | null>(null)
  const [folderError, setFolderError] = useState<string | null>(null)
  // On by default where it can run: applied at Done, and at once whenever the member flips it.
  const available = setup.background.available
  const [background, setBackground] = useState(available)
  const [installed, setInstalled] = useState(setup.background.installed)
  const [applying, setApplying] = useState(false)
  const [backgroundError, setBackgroundError] = useState<string | null>(null)
  const [finishing, setFinishing] = useState(false)
  const [doneError, setDoneError] = useState<string | null>(null)
  // Turning background answering on failed at Done: offer to finish without it.
  const [offerSkip, setOfferSkip] = useState(false)
  const switchId = useId()
  const hintId = useId()

  // What the member chose before one folder list, less what is in the list again.
  const previous = (setup.previous ?? []).filter((p) => !folders.includes(p.path))
  const team = nav.teams?.teams.find((t) => t.team === setup.signed_in.team)?.name ?? setup.signed_in.team
  const who = setup.signed_in.email ?? setup.signed_in.member
  const accepted = acceptedVersion(null, acceptance.data)
  const acceptState: StepState = boundariesSet(bounds.data) ? (isAccepted(accepted, bounds.data.version) ? 'done' : 'todo') : bounds.data ? 'not_needed' : 'todo'

  /** The list as the server now holds it. */
  const keep = (next: string[]) => {
    setFolders(next)
    qc.setQueryData<LocalSetup>(localSetupKey, (old) => (old ? { ...old, folders: next } : old))
  }

  const add = async () => {
    setFolderError(null)
    setChoice(null)
    setChoosing(true)
    try {
      const out = await api.localChoose()
      keep(out.folders)
      setChoice(out)
    } catch (err) {
      setFolderError((err as ChangeError).message)
    } finally {
      setChoosing(false)
    }
  }

  const remove = async (path: string) => {
    setFolderError(null)
    setChoice(null)
    setRemoving(path)
    try {
      keep((await api.localRemove(path)).folders)
    } catch (err) {
      setFolderError((err as ChangeError).message)
    } finally {
      setRemoving(null)
    }
  }

  const apply = async (on: boolean): Promise<boolean> => {
    setBackgroundError(null)
    setApplying(true)
    try {
      const out = await api.localBackground(on)
      setInstalled(out.installed)
      return true
    } catch (err) {
      setBackgroundError((err as ChangeError).message)
      return false
    } finally {
      setApplying(false)
    }
  }

  const toggle = (on: boolean) => {
    setBackground(on)
    void apply(on)
  }

  const done = async (skipBackground = false) => {
    setDoneError(null)
    setFinishing(true)
    try {
      if (!skipBackground && available && background !== installed && !(await apply(background))) {
        setOfferSkip(true)
        setDoneError(BACKGROUND_FAILED_TEXT)
        return
      }
      await api.localDone()
      markSetupFinished()
    } catch (err) {
      setDoneError((err as ChangeError).message)
    } finally {
      setFinishing(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <Panel id="local-setup" title="Set up this Mac">
        <ol className="divide-y divide-hairline px-4 pb-1" aria-label="Setup steps">
          <Step n={1} title="Signed in" state="done">
            <Note>
              Signed in as <span className="font-medium text-foreground">{who}</span>, team{' '}
              <span className="font-medium text-foreground">{team}</span>.
            </Note>
          </Step>

          <Step n={2} title="Accept the team's topic" state={acceptState}>
            {bounds.isPending ? (
              <Skeleton className="h-16 w-full" />
            ) : boundariesSet(bounds.data) ? (
              <AcceptBoundaries bounds={bounds.data} accepted={accepted} current={bounds.data.version} />
            ) : bounds.data ? (
              <Note>A team owner hasn&apos;t set the team&apos;s topic yet. Nothing to accept for now.</Note>
            ) : (
              <Note>The team&apos;s topic didn&apos;t load. It is read again in a moment.</Note>
            )}
          </Step>

          <Step n={3} title="Folders your Claude answers from" state={folders.length > 0 ? 'done' : 'todo'}>
            <Note>{FOLDERS_HINT}</Note>
            {folders.length > 0 ? (
              <ul className="flex flex-col gap-1" aria-label="Your folders">
                {folders.map((f) => (
                  <li key={f} className="flex min-w-0 items-center gap-2 rounded-md border bg-canvas px-2.5 py-1.5 text-[12.5px]" data-folder={f}>
                    <Folder aria-hidden className="size-3.5 shrink-0 text-subtle" />
                    <span className="min-w-0 flex-1 font-mono text-[12px] [overflow-wrap:anywhere]">{f}</span>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`Remove ${f}`}
                      disabled={removing !== null || choosing}
                      onClick={() => void remove(f)}
                    >
                      {removing === f ? <LoaderCircle aria-hidden className="animate-spin motion-reduce:animate-none" /> : <X aria-hidden />}
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <Note>No folders yet.</Note>
            )}
            {previous.length > 0 ? (
              <div className="flex flex-col gap-1" data-previous={previous.length}>
                <p className="text-[12.5px] leading-relaxed text-subtle">{PREVIOUS_TEXT}</p>
                {/* Plain text only: an old path is added again only through the Mac's chooser. */}
                <ul className="flex flex-col gap-0.5 pl-2" aria-label="Folders you chose before">
                  {previous.map((p) => (
                    <li key={`${p.kind}:${p.path}`} className="text-[12px] text-subtle [overflow-wrap:anywhere]" data-previous-folder={p.path}>
                      <span className="font-mono">{p.path}</span> ({PREVIOUS_KIND[p.kind]})
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {setup.chooser ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => void add()} disabled={choosing || removing !== null || folders.length >= setup.limits.max_folders}>
                  {choosing ? <LoaderCircle aria-hidden className="animate-spin motion-reduce:animate-none" /> : <FolderPlus aria-hidden />}
                  Add folder
                </Button>
                {choosing ? (
                  <span className="text-[12px] text-subtle" role="status">
                    Pick folders in the window that opened on your Mac, then click Choose.
                  </span>
                ) : null}
              </div>
            ) : (
              <Note>{NO_CHOOSER_TEXT}</Note>
            )}
            {choice && !choice.cancelled && choice.refused.length > 0 ? (
              <ul className="flex flex-col gap-1" aria-label="Not added" data-refused>
                {choice.refused.map((r) => (
                  <li key={r.path} className="text-[12px] text-subtle [overflow-wrap:anywhere]">
                    Not added: <span className="font-mono">{r.path}</span> ({r.reason}).
                  </li>
                ))}
              </ul>
            ) : null}
            {folderError ? <Note tone="bad">{folderError}</Note> : null}
          </Step>

          <Step n={4} title="Answer in the background" state={installed ? 'done' : background && available ? 'todo' : 'not_needed'}>
            <div className="flex items-center gap-3">
              <Switch
                id={switchId}
                // Where it cannot be turned on, it shows what is installed and can only be turned off.
                checked={available ? background : installed}
                onCheckedChange={toggle}
                disabled={(!available && !installed) || applying || finishing}
                aria-describedby={hintId}
              />
              <label htmlFor={switchId} className="text-[12.5px] font-medium">
                Background answering
              </label>
              {applying ? <LoaderCircle aria-hidden className="size-3.5 animate-spin text-subtle motion-reduce:animate-none" /> : null}
            </div>
            <p id={hintId} className="text-[12.5px] leading-relaxed text-subtle">
              {BACKGROUND_TEXT}
            </p>
            {!available && setup.background.reason ? <Note>{setup.background.reason}</Note> : null}
            {backgroundError ? <Note tone="bad">{backgroundError}</Note> : null}
          </Step>
        </ol>
        <div className="m-4 flex flex-wrap items-center gap-3">
          <Button size="lg" onClick={() => void done()} disabled={finishing || choosing || applying}>
            {finishing ? <LoaderCircle aria-hidden className="animate-spin motion-reduce:animate-none" /> : null}
            Done
          </Button>
          {offerSkip ? (
            <Button size="sm" variant="link" onClick={() => void done(true)} disabled={finishing || choosing || applying}>
              Finish without it
            </Button>
          ) : null}
          {doneError ? <Note tone="bad">{doneError}</Note> : null}
        </div>
      </Panel>
    </div>
  )
}
