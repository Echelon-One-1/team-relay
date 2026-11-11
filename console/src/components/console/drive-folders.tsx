import { Folder, HardDrive } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import { isHosted } from '@/api/key'
import type { DriveBoundary, FolderBoundary } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useSourcesConfig } from '@/hooks/queries'
import { domainOk, FOLDER_NAME_MAX, folderNameOk, FOLDERS_MAX, tidyDomain, trimText } from '@/lib/boundaries'
import { folderWhere, isWholeDrive, newNonce, parseDriveFolderLink, PICK_CHANNEL, pickedToFolders, pickerUrl, readPickMessage, type PickedFolder } from '@/lib/sources'
import { cn } from '@/lib/utils'
import { fieldClass, SourceChip } from './github-picker'

// PICKERS-SPEC §7.2: the Google Drive part of an owner's boundaries form. On the team's page
// online, "Choose folders in Google Drive" opens the picker page (/pick/drive, its own window
// and headers, §5.4), which sends the picked folders back on a BroadcastChannel tied to this
// form by a nonce. Pasting a folder link always works. Shared drives typed by name before
// folders could be picked stay until the owner picks them again or removes them.

export const BLOCKED_LINE = 'Your browser blocked the window. Allow pop-ups for this site, or paste a folder link.'
export const PICKING_LINE = 'Choose in the Google window…'
export const LOCAL_LINE = "Picking from Google Drive works on the team's page online. Here, paste a folder link."
export const NOT_SET_UP_LINE = "Picking from Google Drive isn't set up for this relay. Paste a folder link instead."
export const PASTE_DRIVE_ERROR = 'Paste a link to a Google Drive folder.'

export interface DriveChoice {
  drive_folders: FolderBoundary[]
  drives: DriveBoundary[]
}

type Picking = { state: 'idle' } | { state: 'blocked' } | { state: 'picking' }

const channelAvailable = () => typeof BroadcastChannel === 'function'

export function DriveFolders({
  choice,
  onChange,
  team,
  viewerDomain,
}: {
  choice: DriveChoice
  onChange: (next: DriveChoice) => void
  team: string | null
  /** The signed-in viewer's email domain, when known: the domain of what they pick. */
  viewerDomain: string | null
}) {
  const config = useSourcesConfig(true)
  const [picking, setPicking] = useState<Picking>({ state: 'idle' })
  const [replacing, setReplacing] = useState<number | null>(null)
  const [link, setLink] = useState('')
  const [name, setName] = useState('')
  const [typedDomain, setTypedDomain] = useState('')
  const [error, setError] = useState<{ field: 'link' | 'name' | 'domain' | 'pick'; message: string } | null>(null)
  const [added, setAdded] = useState<string | null>(null)
  const channel = useRef<BroadcastChannel | null>(null)
  const linkRef = useRef<HTMLInputElement>(null)
  const id = useId()

  // The domain of new entries: the viewer's own, else that of what the team already shares.
  const knownDomain = viewerDomain ?? choice.drive_folders[0]?.domain ?? choice.drives[0]?.domain ?? null
  const latest = useRef({ choice, onChange, knownDomain })
  latest.current = { choice, onChange, knownDomain }

  const stopListening = () => {
    channel.current?.close()
    channel.current = null
  }
  useEffect(() => stopListening, [])

  /** Adds folders (picked or pasted), replacing a legacy drive when the owner asked to. */
  const addFolders = (folders: FolderBoundary[], replace: number | null): string | null => {
    const { choice: c, onChange: change } = latest.current
    const next = [...c.drive_folders]
    let skipped = 0
    let fresh = 0
    for (const f of folders) {
      if (next.some((x) => x.folder_id === f.folder_id)) continue
      if (next.length >= FOLDERS_MAX) {
        skipped++
        continue
      }
      next.push(f)
      fresh++
    }
    const drives = replace !== null && fresh > 0 ? c.drives.filter((_, i) => i !== replace) : c.drives
    change({ drive_folders: next, drives })
    if (skipped > 0) return `At most ${FOLDERS_MAX} folders: ${skipped} ${skipped === 1 ? 'was' : 'were'} not added.`
    return null
  }

  const onPicked = (picked: PickedFolder[], replace: number | null) => {
    const domain = latest.current.knownDomain
    stopListening()
    setPicking({ state: 'idle' })
    setReplacing(null)
    if (!domain) {
      setError({ field: 'pick', message: "Your account's domain isn't known here, so nothing was added. Paste a folder link instead." })
      return
    }
    const over = addFolders(pickedToFolders(picked, domain, latest.current.choice.drive_folders), replace)
    if (over) setError({ field: 'pick', message: over })
    setAdded(picked.length === 1 ? `Added ${picked[0]!.folder_name}.` : `Added ${picked.length} folders.`)
  }

  const startPick = (replace: number | null) => {
    setError(null)
    setAdded(null)
    stopListening()
    const nonce = newNonce()
    // Listen before the window opens, so its message cannot arrive first.
    const ch = new BroadcastChannel(PICK_CHANNEL)
    ch.onmessage = (e: MessageEvent) => {
      const picked = readPickMessage(e.data, nonce)
      if (picked) onPicked(picked, replace)
    }
    channel.current = ch
    const w = window.open(pickerUrl(nonce, team), '_blank')
    if (!w) {
      stopListening()
      setPicking({ state: 'blocked' })
      return
    }
    setPicking({ state: 'picking' })
  }

  const cancel = () => {
    stopListening()
    setPicking({ state: 'idle' })
    setReplacing(null)
  }

  // The picker page needs the team in its fragment (it reads the settings for that team).
  const pickerOn = isHosted() && team !== null && !!config.data?.google_picker && channelAvailable()
  const needsDomain = knownDomain === null

  const paste = () => {
    setAdded(null)
    const folderId = parseDriveFolderLink(link)
    if (!folderId) return setError({ field: 'link', message: PASTE_DRIVE_ERROR })
    const n = trimText(name)
    if (!folderNameOk(n)) return setError({ field: 'name', message: `Give the folder a name, as it shows in Google Drive: up to ${FOLDER_NAME_MAX} characters.` })
    const domain = needsDomain ? tidyDomain(typedDomain) : knownDomain
    if (!domain || !domainOk(domain)) return setError({ field: 'domain', message: 'The Google Workspace domain of the drive, such as example.com.' })
    if (choice.drive_folders.some((f) => f.folder_id === folderId)) return setError({ field: 'link', message: 'This folder is already listed.' })
    if (choice.drive_folders.length >= FOLDERS_MAX) return setError({ field: 'link', message: `At most ${FOLDERS_MAX} folders.` })
    setError(null)
    addFolders([{ domain, drive_id: null, folder_id: folderId, folder_name: n, drive_name: null }], replacing)
    setReplacing(null)
    setLink('')
    setName('')
  }

  const pickAgain = (i: number) => {
    if (pickerOn) return startPick(i)
    setReplacing(i)
    setError(null)
    linkRef.current?.focus()
  }

  let pickArea
  if (config.isPending) {
    pickArea = <Skeleton className="h-8 w-56" />
  } else if (pickerOn) {
    pickArea =
      picking.state === 'picking' ? (
        <div className="flex flex-wrap items-center gap-2" role="status" data-drive-state="picking">
          <span className="text-[12px] text-subtle">{PICKING_LINE}</span>
          <Button type="button" size="xs" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-1.5">
          <Button type="button" variant="outline" onClick={() => startPick(null)} data-drive-state={picking.state === 'blocked' ? 'blocked' : 'ready'}>
            <HardDrive aria-hidden />
            Choose folders in Google Drive
          </Button>
          {picking.state === 'blocked' ? (
            <p role="alert" className="text-[12px] leading-snug text-bad">
              {BLOCKED_LINE}
            </p>
          ) : null}
        </div>
      )
  } else if (config.error && config.error.kind !== 'not_found') {
    pickArea = (
      <div className="flex flex-wrap items-center gap-2" data-drive-state="error">
        <p className="text-[12px] text-subtle">Picking from Google Drive couldn&apos;t be checked. Paste a folder link, or try again.</p>
        <Button type="button" size="xs" variant="outline" onClick={() => void config.refetch()} disabled={config.isFetching}>
          {config.isFetching ? 'Trying…' : 'Try again'}
        </Button>
      </div>
    )
  } else {
    pickArea = (
      <p className="text-[12px] leading-snug text-subtle" data-drive-state="paste-only">
        {isHosted() ? NOT_SET_UP_LINE : LOCAL_LINE}
      </p>
    )
  }

  const chosen = choice.drive_folders.length + choice.drives.length
  const replacingName = replacing !== null ? choice.drives[replacing]?.shared_drive : undefined
  const err = (f: 'link' | 'name' | 'domain') => (error?.field === f ? `${id}-error` : undefined)

  return (
    <fieldset className="flex min-w-0 flex-col gap-2" aria-describedby={`${id}-hint`} data-drive-folders>
      <legend className="mb-1 text-[12px] font-medium">Google Drive</legend>
      {chosen > 0 ? (
        <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2" aria-label="Chosen in Google Drive">
          {choice.drive_folders.map((f) => (
            <SourceChip
              key={`folder:${f.folder_id}`}
              icon={isWholeDrive(f) ? <HardDrive /> : <Folder />}
              name={
                <>
                  <span className="font-medium">{f.folder_name}</span> <span className="text-subtle">{folderWhere(f)}</span>
                </>
              }
              note={f.drive_id === null ? 'not checked' : null}
              removeLabel={`Remove ${f.folder_name}`}
              onRemove={() => onChange({ ...choice, drive_folders: choice.drive_folders.filter((x) => x.folder_id !== f.folder_id) })}
              data={{ 'data-chosen-folder': f.folder_id }}
            />
          ))}
          {choice.drives.map((d, i) => (
            <SourceChip
              key={`drive:${d.domain}/${d.shared_drive}`}
              icon={<HardDrive />}
              name={
                <>
                  <span className="font-medium">{d.shared_drive}</span> <span className="text-subtle">(matched by name)</span>
                </>
              }
              note="Pick it again, so members' Macs find it for sure."
              action={
                <Button type="button" size="xs" variant="outline" onClick={() => pickAgain(i)} disabled={picking.state === 'picking'}>
                  Pick it again
                </Button>
              }
              removeLabel={`Remove ${d.shared_drive}`}
              onRemove={() => {
                if (replacing === i) setReplacing(null)
                onChange({ ...choice, drives: choice.drives.filter((_, j) => j !== i) })
              }}
              data={{ 'data-legacy-drive': d.shared_drive }}
            />
          ))}
        </ul>
      ) : null}

      {pickArea}
      {added ? (
        <p role="status" className="text-[12px] text-ok">
          {added} Save to keep it.
        </p>
      ) : null}

      <div className={cn('flex flex-col gap-1.5 rounded-md border border-dashed px-3 py-2.5', replacingName && 'border-signal/40 bg-signal-soft')} data-drive-paste>
        <p className="text-[11.5px] text-subtle">
          {replacingName ? (
            <>
              Paste the link of <span className="font-medium text-foreground">{replacingName}</span>: it replaces the entry matched by name.{' '}
              <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setReplacing(null)}>
                Cancel
              </button>
            </>
          ) : (
            'Or paste a folder link from Google Drive (open the folder, copy the address bar).'
          )}
        </p>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto]">
          <input
            ref={linkRef}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://drive.google.com/drive/folders/…"
            aria-label="Folder link"
            value={link}
            onChange={(e) => {
              setLink(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                paste()
              }
            }}
            aria-invalid={error?.field === 'link' ? true : undefined}
            aria-describedby={err('link')}
            className={cn(fieldClass, 'font-mono text-[12px]')}
          />
          <input
            type="text"
            autoComplete="off"
            maxLength={FOLDER_NAME_MAX}
            placeholder="Its name, e.g. Clients"
            aria-label="Folder name"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                paste()
              }
            }}
            aria-invalid={error?.field === 'name' ? true : undefined}
            aria-describedby={err('name')}
            className={fieldClass}
          />
          <Button type="button" variant="outline" onClick={paste} disabled={link.trim() === ''}>
            Add
          </Button>
        </div>
        {needsDomain ? (
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={253}
            placeholder="example.com"
            aria-label="Google Workspace domain"
            value={typedDomain}
            onChange={(e) => {
              setTypedDomain(tidyDomain(e.target.value))
              setError(null)
            }}
            aria-invalid={error?.field === 'domain' ? true : undefined}
            aria-describedby={err('domain')}
            className={cn(fieldClass, 'font-mono text-[12px] sm:max-w-[18rem]')}
          />
        ) : null}
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-[12px] leading-snug text-bad">
          {error.message}
        </p>
      ) : null}
      <span id={`${id}-hint`} className="text-[11px] leading-snug text-faint">
        Folders of shared drives only. Members answer from them through Google Drive for desktop, signed in with their work
        account. At most {FOLDERS_MAX}.
      </span>
    </fieldset>
  )
}
