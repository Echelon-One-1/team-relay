// PICKERS-SPEC §5.4: the Google Drive picker page (/pick/drive, hosted console only, under its
// own headers). The boundaries form opens it in a new window with `#n=<nonce>&team=<team>`; it
// lets the owner pick shared-drive folders in Google's own Picker and hands them back to the
// form over a same-origin BroadcastChannel, as one message:
//
//   channel  BroadcastChannel('team-relay-pick')
//   opened   /pick/drive#n=<nonce>&team=<team>  (nonce: 32 random bytes, base64url, 43
//            characters; team optional: the console's default team when left out)
//   message  {"nonce": "<the form's nonce>",
//             "folders": [{"drive_id", "folder_id", "folder_name", "drive_name" | null}, …]}
//            1-20 folders, each passing the PICKERS-SPEC §2.1 rule (the form fills `domain`)
//
// The Google token (scope drive.file, from Google Identity Services, asked for on a click) lives
// in one variable of this page only: never in storage, a cookie, a URL, the message or any
// request to our origin. It is revoked when the owner is done, cancels, or leaves the page.
// From our origin the page reads only GET /api/sources/config. Everything Google answers (the
// Picker's documents, files.get) is data: checked by the rule before it is posted.

import '@/index.css'

export const CHANNEL_NAME = 'team-relay-pick'
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
export const FOLDER_MIME = 'application/vnd.google-apps.folder'
export const GAPI_URL = 'https://apis.google.com/js/api.js'
export const GSI_URL = 'https://accounts.google.com/gsi/client'
/** §5.4 step 3: how long each of Google's scripts may take to load. */
export const LOAD_TIMEOUT_MS = 15_000
/** §2.1: a team holds at most 20 folders, so one pick hands back at most 20. */
export const PICK_MAX = 20

/** The form's nonce: 32 random bytes, base64url without padding. */
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/
/** A team id (plugin/src/relay-client-core.ts TEAM_RE). */
const TEAM_RE = /^[a-z][a-z0-9_-]{1,31}$/
/** §2.1: a Drive id (folder or shared drive). */
const DRIVE_ITEM_ID_RE = /^[A-Za-z0-9_-]{10,200}$/
/** §2.1: a folder's or a shared drive's name holds no control or invisible character. */
/* Picked names come from Drive and are not checked for unassigned code points (Cn): each side's Unicode tables differ in age (PICKERS-SPEC, correction of 11 Nov 2026). */
const NAME_FORBIDDEN_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u
/** The white space no name may start or end with (Python's str.strip(), as the relay strips). */
const EDGE_SPACE_RE = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]|[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/
/** §4.2: the picker's public settings. */
const CLIENT_ID_RE = /^[A-Za-z0-9.-]{1,200}\.apps\.googleusercontent\.com$/
const API_KEY_RE = /^AIza[0-9A-Za-z_-]{35}$/
const APP_ID_RE = /^[0-9]{6,20}$/

/** One picked folder as the form gets it. */
export type PickedFolder = { drive_id: string; folder_id: string; folder_name: string; drive_name: string | null }
/** The one message the page posts on CHANNEL_NAME. */
export type PickMessage = { nonce: string; folders: PickedFolder[] }
const LOGIN_HINT_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/

export type PickerConfig = { client_id: string; api_key: string; app_id: string; login_hint?: string }

// --- Google's globals, as far as this page uses them ----------------------------------

export type TokenResponse = { access_token?: string; error?: string; scope?: string }
export type TokenClient = { requestAccessToken(overrides?: { prompt?: string }): void }
export type Oauth2 = {
  initTokenClient(config: {
    client_id: string
    scope: string
    prompt: string
    login_hint?: string
    callback: (response: TokenResponse) => void
    error_callback: (error: { type?: string }) => void
  }): TokenClient
  hasGrantedAllScopes(response: TokenResponse, scope: string): boolean
  revoke(token: string, done?: () => void): void
}
export type DocsView = {
  setIncludeFolders(on: boolean): DocsView
  setSelectFolderEnabled(on: boolean): DocsView
  setEnableDrives(on: boolean): DocsView
  setMimeTypes(types: string): DocsView
}
export type PickerBuilder = {
  setAppId(id: string): PickerBuilder
  setOAuthToken(token: string): PickerBuilder
  setDeveloperKey(key: string): PickerBuilder
  addView(view: DocsView): PickerBuilder
  enableFeature(feature: unknown): PickerBuilder
  setCallback(cb: (data: Record<string, unknown>) => void): PickerBuilder
  build(): { setVisible(on: boolean): void }
}
export type PickerApi = {
  PickerBuilder: new () => PickerBuilder
  DocsView: new (viewId: unknown) => DocsView
  ViewId: { FOLDERS: unknown }
  Feature: { MULTISELECT_ENABLED: unknown }
  Action: { PICKED: string; CANCEL: string }
  Response: { ACTION: string; DOCUMENTS: string }
  Document: { ID: string; NAME: string; MIME_TYPE: string }
}
export type Gapi = {
  load(name: 'picker', options: { callback: () => void; onerror?: () => void; timeout?: number; ontimeout?: () => void }): void
}
type GoogleWindow = { gapi?: Gapi; google?: { accounts?: { oauth2?: Oauth2 }; picker?: PickerApi } }

/** What the page reaches outside itself: injected, so the tests drive it with fakes. */
export type PickerEnv = {
  /** The element the page renders into. */
  root: HTMLElement
  /** The page's fragment, `#n=<nonce>&team=<team>`. */
  hash: string
  /** Drops the fragment from the address bar once read. */
  clearFragment: () => void
  fetch: typeof fetch
  /** Loads a script from `src`; rejects on an error or after `timeoutMs`. */
  loadScript: (src: string, timeoutMs: number) => Promise<void>
  /** Google's globals as they are now (absent before their scripts load). */
  globals: () => GoogleWindow
  openChannel: (name: string) => { postMessage(message: PickMessage): void; close(): void }
  closeWindow: () => void
  onPageHide: (fn: () => void) => void
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

// --- The rule (PICKERS-SPEC §2.1), for what Google answers ----------------------------

const chars = (s: string) => [...s].length

/** A picked folder's name: 1-255 characters, no control or invisible character, no surrounding space. */
export function nameOk(name: unknown, max = 255): name is string {
  return typeof name === 'string' && chars(name) >= 1 && chars(name) <= max && !NAME_FORBIDDEN_RE.test(name) && !EDGE_SPACE_RE.test(name)
}

export const driveIdOk = (id: unknown): id is string => typeof id === 'string' && DRIVE_ITEM_ID_RE.test(id)

/** One folder of the message, exactly its four fields, each by the rule. */
export function pickedFolderOk(f: unknown): f is PickedFolder {
  if (typeof f !== 'object' || f === null || Array.isArray(f)) return false
  const o = f as Record<string, unknown>
  const keys = Object.keys(o).sort().join(',')
  return (
    keys === 'drive_id,drive_name,folder_id,folder_name' &&
    driveIdOk(o.drive_id) &&
    driveIdOk(o.folder_id) &&
    nameOk(o.folder_name) &&
    (o.drive_name === null || nameOk(o.drive_name, 100))
  )
}

/**
 * The fragment's nonce and team (the team may be left out: the console's default team), or null
 * when the nonce is missing, either is given twice, or either is malformed.
 */
export function readFragment(hash: string): { nonce: string; team: string | null } | null {
  const p = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  if (p.getAll('n').length !== 1 || p.getAll('team').length > 1) return null
  const nonce = p.get('n')!
  const team = p.get('team')
  if (!NONCE_RE.test(nonce) || (team !== null && !TEAM_RE.test(team))) return null
  return { nonce, team }
}

/** GET /api/sources/config's `google_picker`, when each setting is well-formed; else null. */
export function pickerConfig(raw: unknown): PickerConfig | null {
  const gp = typeof raw === 'object' && raw !== null ? (raw as { google_picker?: unknown }).google_picker : null
  if (typeof gp !== 'object' || gp === null) return null
  const { client_id, api_key, app_id } = gp as Record<string, unknown>
  if (typeof client_id !== 'string' || !CLIENT_ID_RE.test(client_id)) return null
  if (typeof api_key !== 'string' || !API_KEY_RE.test(api_key)) return null
  if (typeof app_id !== 'string' || !APP_ID_RE.test(app_id)) return null
  // The viewer's own email from the console server (§5.2); anything else is left out.
  const hint = (gp as Record<string, unknown>).login_hint
  return typeof hint === 'string' && hint.length <= 254 && LOGIN_HINT_RE.test(hint)
    ? { client_id, api_key, app_id, login_hint: hint }
    : { client_id, api_key, app_id }
}

// --- What the owner reads -------------------------------------------------------------

export const TEXT = {
  noFragment: 'This window opens from the team page. Close it and choose folders there.',
  noConfig: "The team page's settings couldn't be read here. Close this window and try again from the team page.",
  notSetUp: "Picking from Google Drive isn't set up here. Paste a folder link instead.",
  loading: 'Loading Google Drive…',
  blocked: "Google's picker couldn't load here (an extension or network may block it). Paste a folder link in the team page instead.",
  ready: 'Choose the shared-drive folders your team answers from. Google asks you to allow this page to see only the folders you pick.',
  choose: 'Choose folders in Google Drive',
  chooseAgain: 'Choose again',
  waiting: 'Continue in the Google window…',
  denied: 'No access given, so nothing was picked.',
  popupBlocked: "Your browser blocked Google's window. Allow pop-ups for this site and choose again.",
  signInFailed: "Google's sign-in didn't finish. Choose again.",
  checking: 'Checking the folders…',
  cancelled: 'Nothing was picked. You can close this window.',
  done: 'Done. You can close this window.',
  tooMany: `At most ${PICK_MAX} folders at a time; the first ${PICK_MAX} were used.`,
  myDrive: (name: string) => `Only folders in shared drives can be used. ${name} is in My Drive.`,
  noAccess: (name: string) => `You can't open ${name}.`,
  notFolder: (name: string) => `${name} is not a folder.`,
  badName: (name: string) => `${name} has a name the team page can't use. Rename it in Drive, or paste its link in the team page.`,
  unanswered: (name: string) => `Google Drive didn't answer about ${name}. Choose it again.`,
  added: (n: number) => `Added ${n === 1 ? 'one folder' : `${n} folders`} to the team page.`,
  closeNow: 'You can close this window.',
}

type View = { message: string; problems?: string[]; button?: string | null; busy?: boolean }

/** Renders a view into the root: plain text only (names are data, never markup). */
function renderer(root: HTMLElement, onChoose: () => void): (v: View) => void {
  const doc = root.ownerDocument
  root.replaceChildren()
  const title = doc.createElement('h1')
  title.className = 'text-lg font-semibold'
  title.textContent = 'Choose folders in Google Drive'
  const status = doc.createElement('p')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  status.className = 'text-sm'
  const problems = doc.createElement('ul')
  problems.className = 'list-disc space-y-1 pl-5 text-sm text-muted-foreground'
  const button = doc.createElement('button')
  button.type = 'button'
  button.className =
    'inline-flex h-9 w-fit items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90 disabled:opacity-50'
  button.addEventListener('click', onChoose)
  root.append(title, status, problems, button)
  return (v) => {
    status.textContent = v.message
    problems.replaceChildren(
      ...(v.problems ?? []).map((p) => {
        const li = doc.createElement('li')
        li.textContent = p
        return li
      }),
    )
    problems.hidden = (v.problems ?? []).length === 0
    button.hidden = !v.button
    button.textContent = v.button ?? ''
    button.disabled = v.busy === true
  }
}

// --- The flow (PICKERS-SPEC §5.4 steps 1-6) -------------------------------------------

/** Resolves when `p` does, rejects after `ms`. */
function within<T>(env: PickerEnv, p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = env.setTimer(() => reject(new Error('timed out')), ms)
    p.then(
      (v) => {
        env.clearTimer(t)
        resolve(v)
      },
      (e: unknown) => {
        env.clearTimer(t)
        reject(e instanceof Error ? e : new Error('failed'))
      },
    )
  })
}

/** Step 3: Google's two scripts, then the Picker's own code (each within LOAD_TIMEOUT_MS). */
async function loadGoogle(env: PickerEnv): Promise<{ oauth2: Oauth2; picker: PickerApi }> {
  await Promise.all([env.loadScript(GAPI_URL, LOAD_TIMEOUT_MS), env.loadScript(GSI_URL, LOAD_TIMEOUT_MS)])
  const gapi = env.globals().gapi
  if (!gapi || typeof gapi.load !== 'function') throw new Error('gapi missing')
  await within(
    env,
    new Promise<void>((resolve, reject) =>
      gapi.load('picker', { callback: resolve, onerror: () => reject(new Error('picker failed')), timeout: LOAD_TIMEOUT_MS, ontimeout: () => reject(new Error('picker timed out')) }),
    ),
    LOAD_TIMEOUT_MS,
  )
  const g = env.globals().google
  const oauth2 = g?.accounts?.oauth2
  const picker = g?.picker
  if (!oauth2 || !picker) throw new Error('google missing')
  return { oauth2, picker }
}

type FileAnswer = { kind: 'ok'; id: string; name: unknown; mimeType: unknown; driveId: unknown } | { kind: 'denied' } | { kind: 'failed' }

/** Step 5: files.get under the page's token (never to our origin). */
async function filesGet(env: PickerEnv, id: string, token: string): Promise<FileAnswer> {
  let res: Response
  try {
    res = await env.fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,driveId&supportsAllDrives=true`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    })
  } catch {
    return { kind: 'failed' }
  }
  if (res.status === 403 || res.status === 404) return { kind: 'denied' }
  if (!res.ok) return { kind: 'failed' }
  try {
    const body = (await res.json()) as Record<string, unknown>
    if (typeof body !== 'object' || body === null || typeof body.id !== 'string') return { kind: 'failed' }
    return { kind: 'ok', id: body.id, name: body.name, mimeType: body.mimeType, driveId: body.driveId }
  } catch {
    return { kind: 'failed' }
  }
}

/** A name to show in a message: the given one when it is text, else a plain stand-in. */
const shown = (name: unknown) => (typeof name === 'string' && name.trim() !== '' ? [...name].slice(0, 255).join('') : 'A folder')

/**
 * Runs the page: steps 1-3, then the "Choose" button. Resolves once that view (or the view that
 * stops the page) is shown; the rest follows the owner's clicks and Google's callbacks.
 */
export async function runPicker(env: PickerEnv): Promise<void> {
  let token: string | null = null
  let tokenClient: TokenClient | null = null
  let google: { oauth2: Oauth2; picker: PickerApi } | null = null
  let config: PickerConfig | null = null
  let busy = false
  let posted = false

  /** Revokes the page's token, if it holds one, and forgets it. */
  const revoke = () => {
    const t = token
    token = null
    if (t !== null && google) {
      try {
        google.oauth2.revoke(t, () => {})
      } catch {
        // Revoking is the last thing the page does; a failure leaves a token that expires within the hour.
      }
    }
  }
  env.onPageHide(revoke)

  const show = renderer(env.root, () => choose())

  // Step 1: the form's nonce and the team, from the fragment; nothing else is read from it.
  const asked = readFragment(env.hash)
  env.clearFragment()
  if (!asked) return show({ message: TEXT.noFragment })

  // Step 2: the picker's settings for this team (owners only), from our origin.
  try {
    const res = await env.fetch(asked.team === null ? '/api/sources/config' : `/api/sources/config?team=${encodeURIComponent(asked.team)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    })
    if (!res.ok) return show({ message: TEXT.noConfig })
    config = pickerConfig(await res.json())
  } catch {
    return show({ message: TEXT.noConfig })
  }
  if (!config) return show({ message: TEXT.notSetUp })
  const settings = config

  // Step 3: Google's scripts.
  show({ message: TEXT.loading })
  try {
    google = await loadGoogle(env)
  } catch {
    return show({ message: TEXT.blocked })
  }
  const g = google

  // Step 4: a token on a click (so Google's consent window is allowed), then the Picker.
  try {
    tokenClient = g.oauth2.initTokenClient({
      client_id: settings.client_id,
      scope: DRIVE_FILE_SCOPE,
      prompt: '',
      // The viewer's own account (§5.2), when the console server named it. No `hd`: an email's
      // domain may be an alias, not the account's Workspace domain.
      ...(settings.login_hint ? { login_hint: settings.login_hint } : {}),
      callback: (response) => {
        if (!response.access_token || response.error || !g.oauth2.hasGrantedAllScopes(response, DRIVE_FILE_SCOPE)) {
          token = response.access_token ?? null
          revoke()
          busy = false
          return show({ message: TEXT.denied, button: TEXT.choose })
        }
        token = response.access_token
        openPicker()
      },
      error_callback: (error) => {
        busy = false
        const message = error?.type === 'popup_closed' ? TEXT.denied : error?.type === 'popup_failed_to_open' ? TEXT.popupBlocked : TEXT.signInFailed
        show({ message, button: TEXT.choose })
      },
    })
  } catch {
    return show({ message: TEXT.blocked })
  }
  show({ message: TEXT.ready, button: TEXT.choose })

  function choose(): void {
    if (busy || posted || !tokenClient) return
    busy = true
    show({ message: TEXT.waiting, button: TEXT.choose, busy: true })
    try {
      tokenClient.requestAccessToken({ prompt: '' })
    } catch {
      busy = false
      show({ message: TEXT.signInFailed, button: TEXT.choose })
    }
  }

  function openPicker(): void {
    const p = g.picker
    try {
      const view = new p.DocsView(p.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true).setEnableDrives(true).setMimeTypes(FOLDER_MIME)
      new p.PickerBuilder()
        .setAppId(settings.app_id)
        .setOAuthToken(token!)
        .setDeveloperKey(settings.api_key)
        .addView(view)
        .enableFeature(p.Feature.MULTISELECT_ENABLED)
        .setCallback((data) => void picked(data))
        .build()
        .setVisible(true)
    } catch {
      revoke()
      busy = false
      show({ message: TEXT.blocked })
    }
  }

  async function picked(data: Record<string, unknown>): Promise<void> {
    const p = g.picker
    const action = data?.[p.Response.ACTION]
    if (action === p.Action.CANCEL) {
      revoke()
      busy = false
      show({ message: TEXT.cancelled })
      env.closeWindow()
      return
    }
    if (action !== p.Action.PICKED || token === null) return
    const held = token
    show({ message: TEXT.checking, busy: true })
    const docs = Array.isArray(data[p.Response.DOCUMENTS]) ? (data[p.Response.DOCUMENTS] as unknown[]) : []
    const problems: string[] = []
    if (docs.length > PICK_MAX) problems.push(TEXT.tooMany)
    const folders: PickedFolder[] = []
    for (const raw of docs.slice(0, PICK_MAX)) {
      const doc = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
      const id = doc[p.Document.ID]
      const pickerName = doc[p.Document.NAME]
      if (!driveIdOk(id)) {
        problems.push(TEXT.noAccess(shown(pickerName)))
        continue
      }
      const file = await filesGet(env, id, held)
      if (file.kind === 'denied') {
        problems.push(TEXT.noAccess(shown(pickerName)))
        continue
      }
      if (file.kind === 'failed' || file.id !== id) {
        problems.push(TEXT.unanswered(shown(pickerName)))
        continue
      }
      const name = nameOk(file.name) ? file.name : nameOk(pickerName) ? pickerName : null
      if (file.mimeType !== FOLDER_MIME) {
        problems.push(TEXT.notFolder(shown(file.name ?? pickerName)))
        continue
      }
      if (file.driveId === undefined || file.driveId === null) {
        problems.push(TEXT.myDrive(shown(file.name ?? pickerName)))
        continue
      }
      if (!driveIdOk(file.driveId)) {
        problems.push(TEXT.unanswered(shown(file.name ?? pickerName)))
        continue
      }
      if (name === null) {
        problems.push(TEXT.badName(shown(file.name ?? pickerName)))
        continue
      }
      if (folders.some((f) => f.folder_id === id)) continue
      // A shared drive's own id is its top folder's: picked whole, its name is the drive's.
      folders.push({ drive_id: file.driveId, folder_id: id, folder_name: name, drive_name: id === file.driveId && nameOk(name, 100) ? name : null })
    }
    // A folder of a shared drive picked whole in the same go gets that drive's name.
    for (const f of folders) {
      if (f.drive_name === null) f.drive_name = folders.find((x) => x.folder_id === f.drive_id && x.drive_name !== null)?.drive_name ?? null
    }
    // Step 6: hand the folders to the form, then let the token go.
    const kept = folders.filter(pickedFolderOk)
    if (kept.length > 0) {
      const channel = env.openChannel(CHANNEL_NAME)
      try {
        channel.postMessage({ nonce: asked!.nonce, folders: kept })
      } finally {
        channel.close()
      }
      posted = true
    }
    revoke()
    busy = false
    if (problems.length === 0 && kept.length > 0) {
      show({ message: TEXT.done })
      env.closeWindow()
      return
    }
    show(
      kept.length > 0
        ? { message: `${TEXT.added(kept.length)} ${TEXT.closeNow}`, problems }
        : { message: TEXT.closeNow, problems, button: TEXT.chooseAgain },
    )
  }
}

/** The page's real surroundings: the browser's window, document and Google's script tags. */
export function browserEnv(root: HTMLElement): PickerEnv {
  return {
    root,
    hash: window.location.hash,
    clearFragment: () => {
      if (window.location.hash) window.history.replaceState(null, '', window.location.pathname)
    },
    fetch: (input, init) => window.fetch(input, init),
    loadScript: (src, timeoutMs) =>
      new Promise<void>((resolve, reject) => {
        const s = document.createElement('script')
        const t = window.setTimeout(() => {
          s.remove()
          reject(new Error('timed out'))
        }, timeoutMs)
        s.src = src
        s.async = true
        s.onload = () => {
          window.clearTimeout(t)
          resolve()
        }
        s.onerror = () => {
          window.clearTimeout(t)
          s.remove()
          reject(new Error('failed'))
        }
        document.head.append(s)
      }),
    globals: () => window as unknown as GoogleWindow,
    openChannel: (name) => new BroadcastChannel(name),
    closeWindow: () => window.close(),
    onPageHide: (fn) => window.addEventListener('pagehide', fn),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (h) => window.clearTimeout(h as number),
  }
}

/** The console's theme (src/hooks/use-theme.ts), read here without React. */
function applyTheme(): void {
  let choice: string | null = null
  try {
    choice = window.localStorage.getItem('team-relay-console.theme')
  } catch {
    choice = null
  }
  const system = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.classList.toggle('dark', choice === 'dark' || (choice !== 'light' && system))
}

const pageRoot = typeof document !== 'undefined' ? document.getElementById('pick-drive') : null
if (pageRoot) {
  applyTheme()
  void runPicker(browserEnv(pageRoot))
}
