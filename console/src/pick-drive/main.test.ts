// PICKERS-SPEC §5.4, ACC-020: the Google Drive picker page, driven with fake Google globals
// (gapi, google.accounts.oauth2, google.picker), a fake fetch and a fake BroadcastChannel. No
// request leaves the test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CHANNEL_NAME,
  DRIVE_FILE_SCOPE,
  FOLDER_MIME,
  GAPI_URL,
  GSI_URL,
  LOAD_TIMEOUT_MS,
  PICK_MAX,
  TEXT,
  pickedFolderOk,
  pickerConfig,
  readFragment,
  runPicker,
  type PickMessage,
  type PickerEnv,
  type TokenResponse,
} from './main'

const NONCE = 'N'.repeat(43)
const HASH = `#n=${NONCE}&team=research`
const TOKEN = 'ya29.test-token-value'
const PICKER = { client_id: '123-abc.apps.googleusercontent.com', api_key: `AIza${'A'.repeat(35)}`, app_id: '123456789012' }
const DRIVE = '0AExampleDriveId0PVA'
const FOLDER = '1ExampleFolderIdxxxxxxxxxxxxxxxxx'
const MY_DRIVE_FOLDER = '1MyDriveFolderIdxxxxxxxxxxxxxxxx'

type DriveFile = { id: string; name?: unknown; mimeType?: unknown; driveId?: unknown }

/** Google, as far as the page uses it, recording every call. */
class FakeGoogle {
  initConfig: { client_id: string; scope: string; prompt: string; login_hint?: string; callback: (r: TokenResponse) => void; error_callback: (e: { type?: string }) => void } | null = null
  requested = 0
  revoked: string[] = []
  granted = true
  builder: Record<string, unknown[]> = {}
  pickerCallback: ((data: Record<string, unknown>) => void) | null = null
  visible = false
  view: Record<string, unknown[]> = {}
  loadPicker: 'ok' | 'error' | 'never' = 'ok'

  globals() {
    const self = this
    class DocsView {
      constructor(viewId: unknown) {
        self.view.viewId = [viewId]
      }
      setIncludeFolders(v: boolean) {
        self.view.setIncludeFolders = [v]
        return this
      }
      setSelectFolderEnabled(v: boolean) {
        self.view.setSelectFolderEnabled = [v]
        return this
      }
      setEnableDrives(v: boolean) {
        self.view.setEnableDrives = [v]
        return this
      }
      setMimeTypes(v: string) {
        self.view.setMimeTypes = [v]
        return this
      }
    }
    class PickerBuilder {
      private rec(name: string, v: unknown) {
        self.builder[name] = [v]
        return this
      }
      setAppId(v: string) {
        return this.rec('setAppId', v)
      }
      setOAuthToken(v: string) {
        return this.rec('setOAuthToken', v)
      }
      setDeveloperKey(v: string) {
        return this.rec('setDeveloperKey', v)
      }
      addView(v: unknown) {
        return this.rec('addView', v)
      }
      enableFeature(v: unknown) {
        return this.rec('enableFeature', v)
      }
      setCallback(cb: (data: Record<string, unknown>) => void) {
        self.pickerCallback = cb
        return this
      }
      build() {
        return { setVisible: (v: boolean) => void (self.visible = v) }
      }
    }
    return {
      gapi: {
        load: (_name: string, o: { callback: () => void; onerror?: () => void }) => {
          if (this.loadPicker === 'ok') o.callback()
          else if (this.loadPicker === 'error') o.onerror?.()
        },
      },
      google: {
        accounts: {
          oauth2: {
            initTokenClient: (c: NonNullable<FakeGoogle['initConfig']>) => {
              this.initConfig = c
              return { requestAccessToken: () => void this.requested++ }
            },
            hasGrantedAllScopes: (r: TokenResponse, scope: string) => this.granted && r.scope === scope,
            revoke: (t: string, done?: () => void) => {
              this.revoked.push(t)
              done?.()
            },
          },
        },
        picker: {
          PickerBuilder,
          DocsView,
          ViewId: { FOLDERS: 'folders' },
          Feature: { MULTISELECT_ENABLED: 'multiselect' },
          Action: { PICKED: 'picked', CANCEL: 'cancel' },
          Response: { ACTION: 'action', DOCUMENTS: 'docs' },
          Document: { ID: 'id', NAME: 'name', MIME_TYPE: 'mimeType' },
        },
      },
    }
  }

  /** Google's consent answers the token client. */
  grant(response: TokenResponse = { access_token: TOKEN, scope: DRIVE_FILE_SCOPE, expires_in: 3599 } as TokenResponse) {
    this.initConfig!.callback(response)
  }

  /** The owner picks `docs` in the Picker. */
  pick(docs: Array<Record<string, unknown>>) {
    this.pickerCallback!({ action: 'picked', docs })
  }
}

type Call = { url: string; init: RequestInit | undefined }

type Harness = {
  env: PickerEnv
  google: FakeGoogle
  calls: Call[]
  posted: Array<{ name: string; message: PickMessage }>
  closedChannels: number
  closedWindow: () => number
  pageHide: () => void
  scripts: string[]
  root: HTMLElement
  files: Map<string, { status: number; body?: DriveFile }>
  config: { status: number; body: unknown }
}

function harness(over: Partial<PickerEnv> = {}): Harness {
  const google = new FakeGoogle()
  const root = document.createElement('main')
  document.body.append(root)
  const calls: Call[] = []
  const posted: Harness['posted'] = []
  const files = new Map<string, { status: number; body?: DriveFile }>()
  const scripts: string[] = []
  let windowClosed = 0
  let hide: () => void = () => {}
  const h: Harness = {
    google,
    calls,
    posted,
    closedChannels: 0,
    closedWindow: () => windowClosed,
    pageHide: () => hide(),
    scripts,
    root,
    files,
    config: { status: 200, body: { github: { configured: false, install_url: null }, google_picker: PICKER } },
    env: undefined as unknown as PickerEnv,
  }
  let loaded = false
  h.env = {
    root,
    hash: HASH,
    clearFragment: () => {},
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.startsWith('/api/sources/config')) {
        return new Response(JSON.stringify(h.config.body), { status: h.config.status, headers: { 'Content-Type': 'application/json' } })
      }
      const m = /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^?]+)\?fields=id,name,mimeType,driveId&supportsAllDrives=true$/.exec(url)
      if (m) {
        const f = files.get(decodeURIComponent(m[1]!))
        if (!f) return new Response('{}', { status: 404 })
        return new Response(JSON.stringify(f.body ?? {}), { status: f.status, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`unexpected fetch ${url}`)
    }) as typeof fetch,
    loadScript: async (src) => {
      scripts.push(src)
      loaded = true
    },
    globals: () => (loaded ? google.globals() : {}),
    openChannel: (name) => ({
      postMessage: (message) => void posted.push({ name, message: structuredClone(message) }),
      close: () => void h.closedChannels++,
    }),
    closeWindow: () => void windowClosed++,
    onPageHide: (fn) => void (hide = fn),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    ...over,
  }
  return h
}

const status = (h: Harness) => h.root.querySelector('[role="status"]')!.textContent
const button = (h: Harness) => h.root.querySelector('button')!
const problems = (h: Harness) => [...h.root.querySelectorAll('li')].map((li) => li.textContent)
const settle = () => new Promise((r) => setTimeout(r, 0))
const folderFile = (id: string, name: string, driveId: string | null = DRIVE): { status: number; body: DriveFile } => ({
  status: 200,
  body: { id, name, mimeType: FOLDER_MIME, ...(driveId === null ? {} : { driveId }) },
})

/** Runs the page up to the "Choose" button. */
async function ready(h: Harness) {
  await runPicker(h.env)
  expect(status(h)).toBe(TEXT.ready)
  expect(button(h).hidden).toBe(false)
  expect(button(h).textContent).toBe(TEXT.choose)
}

/** Clicks "Choose", Google grants a token and the Picker opens. */
async function chooseAndGrant(h: Harness) {
  button(h).click()
  expect(h.google.requested).toBe(1)
  expect(status(h)).toBe(TEXT.waiting)
  h.google.grant()
  expect(h.google.visible).toBe(true)
}

/** Nothing the page made may hold the token outside Google's own calls. */
function expectTokenOnlyToGoogle(h: Harness) {
  for (const c of h.calls) {
    const auth = new Headers(c.init?.headers).get('Authorization')
    if (c.url.startsWith('https://www.googleapis.com/')) {
      expect(auth).toBe(`Bearer ${TOKEN}`)
      expect(c.init?.credentials).toBe('omit')
    } else {
      expect(c.url.startsWith('/')).toBe(true)
      expect(c.url).not.toContain(TOKEN)
      expect(auth).toBeNull()
      expect(JSON.stringify(c.init ?? {})).not.toContain(TOKEN)
    }
  }
  for (const p of h.posted) expect(JSON.stringify(p.message)).not.toContain(TOKEN)
  expect(window.localStorage.length).toBe(0)
  expect(window.sessionStorage.length).toBe(0)
  expect(document.cookie).toBe('')
  expect(document.body.innerHTML).not.toContain(TOKEN)
}

beforeEach(() => {
  document.body.replaceChildren()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('readFragment, pickerConfig and the message rule', () => {
  it("keeps the viewer's own email as login_hint only when it is an email", () => {
    expect(pickerConfig({ google_picker: { ...PICKER, login_hint: 'owner@example.com' } })).toEqual({ ...PICKER, login_hint: 'owner@example.com' })
    for (const bad of ['', 'owner', 'Owner@Example.com', 'a@b', 'x'.repeat(250) + '@example.com', 1, null]) {
      expect(pickerConfig({ google_picker: { ...PICKER, login_hint: bad } }), JSON.stringify(bad)).toEqual(PICKER)
    }
  })

  it('a picked name may hold a newly added emoji, never a control, private-use or separator character', () => {
    const f = { drive_id: '0AExampleDriveId0PVA', folder_id: '1ExampleFolderClients0000000000a', drive_name: 'Team \u{1FAE9} Drive' }
    // U+1FAE9 is unassigned in older Unicode tables (the relay's); U+0378 is unassigned everywhere.
    expect(pickedFolderOk({ ...f, folder_name: '\u{1FAE9} Ops' })).toBe(true)
    expect(pickedFolderOk({ ...f, folder_name: 'a\u0378b' })).toBe(true)
    for (const bad of ['a\ue000b', 'a\u2028b', 'a\u200bb', 'a\u0007b']) {
      expect(pickedFolderOk({ ...f, folder_name: bad }), JSON.stringify(bad)).toBe(false)
    }
  })

  it('reads exactly one well-formed nonce and team from the fragment', () => {
    expect(readFragment(HASH)).toEqual({ nonce: NONCE, team: 'research' })
    expect(readFragment(`n=${NONCE}&team=demo`)).toEqual({ nonce: NONCE, team: 'demo' })
    // No team: the console's default team.
    expect(readFragment(`#n=${NONCE}`)).toEqual({ nonce: NONCE, team: null })
    for (const bad of ['', '#', `#n=${NONCE}&team=demo&team=ops`, '#team=demo', `#n=short&team=demo`, `#n=${NONCE}=&team=demo`, `#n=${NONCE}&team=Bad!`, `#n=${NONCE}&n=${NONCE}&team=demo`, `#n=${'+'.repeat(43)}&team=demo`]) {
      expect(readFragment(bad), bad).toBeNull()
    }
  })

  it('takes the picker settings only when each is well-formed', () => {
    expect(pickerConfig({ google_picker: PICKER })).toEqual(PICKER)
    for (const bad of [null, {}, { google_picker: null }, { google_picker: { ...PICKER, api_key: 'nope' } }, { google_picker: { ...PICKER, client_id: 'x.example.com' } }, { google_picker: { ...PICKER, app_id: 1 } }]) {
      expect(pickerConfig(bad)).toBeNull()
    }
  })

  it('a posted folder is exactly its four fields, each by the PICKERS-SPEC §2.1 rule', () => {
    const ok = { drive_id: DRIVE, folder_id: FOLDER, folder_name: 'Clients / 2026', drive_name: null }
    expect(pickedFolderOk(ok)).toBe(true)
    expect(pickedFolderOk({ ...ok, drive_name: 'Example Team Drive' })).toBe(true)
    for (const bad of [
      { ...ok, domain: 'example.com' },
      { ...ok, drive_id: null },
      { ...ok, folder_id: 'short' },
      { ...ok, folder_name: ' Clients' },
      { ...ok, folder_name: 'a\u202eb' },
      { ...ok, folder_name: 'f'.repeat(256) },
      { ...ok, drive_name: 'd'.repeat(101) },
      { drive_id: DRIVE, folder_id: FOLDER, folder_name: 'C' },
    ]) {
      expect(pickedFolderOk(bad)).toBe(false)
    }
  })
})

describe('the picker page (ACC-020)', () => {
  it('without a well-formed nonce in the fragment it stops at once and reads nothing', async () => {
    for (const hash of ['', '#team=research', `#n=short&team=research`, `#n=${NONCE}&team=No!`]) {
      const h = harness({ hash })
      await runPicker(h.env)
      expect(status(h)).toBe(TEXT.noFragment)
      expect(h.calls).toEqual([])
      expect(h.scripts).toEqual([])
      expect(button(h).hidden).toBe(true)
      h.root.remove()
    }
  })

  it('drops the fragment from the address bar once read', async () => {
    const clearFragment = vi.fn()
    const h = harness({ clearFragment })
    await ready(h)
    expect(clearFragment).toHaveBeenCalledTimes(1)
  })

  it('reads only GET /api/sources/config for the team, and shows the paste message when the picker is not set up', async () => {
    const h = harness()
    h.config.body = { github: { configured: true, install_url: null }, google_picker: null }
    await runPicker(h.env)
    expect(status(h)).toBe(TEXT.notSetUp)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.url).toBe('/api/sources/config?team=research')
    expect(h.calls[0]!.init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' })
    expect(h.scripts).toEqual([])
  })

  it("asks Google for the viewer's own account when the console server names it", async () => {
    const h = harness()
    h.config.body = { github: { configured: false, install_url: null }, google_picker: { ...PICKER, login_hint: 'owner@example.com' } }
    await ready(h)
    expect(h.google.initConfig).toMatchObject({ client_id: PICKER.client_id, login_hint: 'owner@example.com' })
    expect(h.google.initConfig).not.toHaveProperty('hd')
  })

  it("without a team in the fragment it reads the console's default team's settings", async () => {
    const h = harness({ hash: `#n=${NONCE}` })
    await ready(h)
    expect(h.calls[0]!.url).toBe('/api/sources/config')
  })

  it('a refused or unreadable settings read stops with its own message', async () => {
    const h = harness()
    h.config = { status: 502, body: { error: 'relay_refused', relay_status: 403 } }
    await runPicker(h.env)
    expect(status(h)).toBe(TEXT.noConfig)
    const thrown = harness({ fetch: (async () => Promise.reject(new TypeError('redirected'))) as typeof fetch })
    await runPicker(thrown.env)
    expect(status(thrown)).toBe(TEXT.noConfig)
  })

  it("loads Google's two scripts and the Picker code; a blocked or slow script shows the blocked state", async () => {
    const h = harness()
    await ready(h)
    expect(h.scripts.sort()).toEqual([GAPI_URL, GSI_URL].sort())
    expect(h.google.initConfig).toMatchObject({ client_id: PICKER.client_id, scope: DRIVE_FILE_SCOPE, prompt: '' })
    // No viewer named by the console server: no hint at all.
    expect(h.google.initConfig).not.toHaveProperty('login_hint')
    expect(h.google.initConfig).not.toHaveProperty('hd')

    const failed = harness({ loadScript: async (src) => (src === GSI_URL ? Promise.reject(new Error('blocked')) : undefined) })
    await runPicker(failed.env)
    expect(status(failed)).toBe(TEXT.blocked)
    expect(button(failed).hidden).toBe(true)

    const picker = harness()
    picker.google.loadPicker = 'error'
    await runPicker(picker.env)
    expect(status(picker)).toBe(TEXT.blocked)

    vi.useFakeTimers()
    const slow = harness()
    slow.google.loadPicker = 'never'
    const run = runPicker(slow.env)
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS + 1)
    await run
    expect(status(slow)).toBe(TEXT.blocked)
  })

  it('asks for a token only on a click, builds the Picker as §5.4 says, and hands the shared-drive folders to the form', async () => {
    const h = harness()
    await ready(h)
    expect(h.google.requested).toBe(0)
    await chooseAndGrant(h)
    expect(h.google.builder).toMatchObject({
      setAppId: [PICKER.app_id],
      setOAuthToken: [TOKEN],
      setDeveloperKey: [PICKER.api_key],
      enableFeature: ['multiselect'],
    })
    expect(h.google.view).toEqual({
      viewId: ['folders'],
      setIncludeFolders: [true],
      setSelectFolderEnabled: [true],
      setEnableDrives: [true],
      setMimeTypes: [FOLDER_MIME],
    })
    h.files.set(DRIVE, folderFile(DRIVE, 'Example Team Drive'))
    h.files.set(FOLDER, folderFile(FOLDER, 'Clients'))
    h.google.pick([
      { id: FOLDER, name: 'Clients (picker name)', mimeType: FOLDER_MIME },
      { id: DRIVE, name: 'Example Team Drive', mimeType: FOLDER_MIME },
    ])
    await settle()
    expect(h.posted).toEqual([
      {
        name: CHANNEL_NAME,
        message: {
          nonce: NONCE,
          folders: [
            // Its drive was picked whole in the same go: it gets that drive's name.
            { drive_id: DRIVE, folder_id: FOLDER, folder_name: 'Clients', drive_name: 'Example Team Drive' },
            { drive_id: DRIVE, folder_id: DRIVE, folder_name: 'Example Team Drive', drive_name: 'Example Team Drive' },
          ],
        },
      },
    ])
    expect(h.closedChannels).toBe(1)
    expect(h.google.revoked).toEqual([TOKEN])
    expect(status(h)).toBe(TEXT.done)
    expect(h.closedWindow()).toBe(1)
    expectTokenOnlyToGoogle(h)
    // files.get was asked once per folder, with the token, never with our cookies.
    expect(h.calls.filter((c) => c.url.startsWith('https://www.googleapis.com/'))).toHaveLength(2)
    // Leaving the page later revokes nothing more: the token is gone.
    h.pageHide()
    expect(h.google.revoked).toEqual([TOKEN])
  })

  it('a folder in a shared drive not picked whole carries no drive name; the form fills it', async () => {
    const h = harness()
    await ready(h)
    await chooseAndGrant(h)
    h.files.set(FOLDER, folderFile(FOLDER, 'Clients / 2026'))
    h.google.pick([{ id: FOLDER, name: 'Clients / 2026' }])
    await settle()
    expect(h.posted[0]!.message.folders).toEqual([{ drive_id: DRIVE, folder_id: FOLDER, folder_name: 'Clients / 2026', drive_name: null }])
  })

  it('refuses My Drive folders, folders the owner cannot open, and anything Drive does not confirm, saying why', async () => {
    const h = harness()
    await ready(h)
    await chooseAndGrant(h)
    h.files.set(FOLDER, folderFile(FOLDER, 'Clients'))
    h.files.set(MY_DRIVE_FOLDER, folderFile(MY_DRIVE_FOLDER, 'My notes', null))
    h.files.set('1ForbiddenFolderxxxxxxxxxxxxxxxxx', { status: 403, body: { id: 'x' } })
    h.files.set('1NotAFolderxxxxxxxxxxxxxxxxxxxxxx', { status: 200, body: { id: '1NotAFolderxxxxxxxxxxxxxxxxxxxxxx', name: 'Report', mimeType: 'application/pdf', driveId: DRIVE } })
    h.files.set('1OtherIdAnsweredxxxxxxxxxxxxxxxxx', { status: 200, body: { id: '1SomethingElsexxxxxxxxxxxxxxxxxx', name: 'Odd', mimeType: FOLDER_MIME, driveId: DRIVE } })
    h.files.set('1DriveDownxxxxxxxxxxxxxxxxxxxxxxx', { status: 500 })
    h.files.set('1BadNamexxxxxxxxxxxxxxxxxxxxxxxxx', folderFile('1BadNamexxxxxxxxxxxxxxxxxxxxxxxxx', 'Name\u202ehidden'))
    h.google.pick([
      { id: FOLDER, name: 'Clients' },
      { id: MY_DRIVE_FOLDER, name: 'My notes' },
      { id: '1ForbiddenFolderxxxxxxxxxxxxxxxxx', name: 'Secret' },
      { id: '1NotAFolderxxxxxxxxxxxxxxxxxxxxxx', name: 'Report' },
      { id: '1OtherIdAnsweredxxxxxxxxxxxxxxxxx', name: 'Odd' },
      { id: '1DriveDownxxxxxxxxxxxxxxxxxxxxxxx', name: 'Busy' },
      { id: '1BadNamexxxxxxxxxxxxxxxxxxxxxxxxx', name: 'Name\u202ehidden' },
      { id: '../../etc', name: 'Path' },
    ])
    await settle()
    expect(h.posted).toHaveLength(1)
    expect(h.posted[0]!.message.folders.map((f) => f.folder_id)).toEqual([FOLDER])
    expect(problems(h)).toEqual([
      TEXT.myDrive('My notes'),
      TEXT.noAccess('Secret'),
      TEXT.notFolder('Report'),
      TEXT.unanswered('Odd'),
      TEXT.unanswered('Busy'),
      TEXT.badName('Name\u202ehidden'),
      TEXT.noAccess('Path'),
    ])
    expect(status(h)).toBe(`${TEXT.added(1)} ${TEXT.closeNow}`)
    // The token is revoked; the window stays open so the owner reads why; nothing more to pick.
    expect(h.google.revoked).toEqual([TOKEN])
    expect(h.closedWindow()).toBe(0)
    expect(button(h).hidden).toBe(true)
    // An id that is not a Drive id is never put in a URL.
    expect(h.calls.some((c) => c.url.includes('etc'))).toBe(false)
    expectTokenOnlyToGoogle(h)
    // Names are text, never markup.
    expect(h.root.querySelector('li')!.innerHTML).not.toContain('<')
  })

  it('a pick with nothing usable posts nothing and offers to choose again (with a new token)', async () => {
    const h = harness()
    await ready(h)
    await chooseAndGrant(h)
    h.files.set(MY_DRIVE_FOLDER, folderFile(MY_DRIVE_FOLDER, 'My notes', null))
    h.google.pick([{ id: MY_DRIVE_FOLDER, name: 'My notes' }])
    await settle()
    expect(h.posted).toEqual([])
    expect(problems(h)).toEqual([TEXT.myDrive('My notes')])
    expect(h.google.revoked).toEqual([TOKEN])
    expect(button(h).textContent).toBe(TEXT.chooseAgain)
    button(h).click()
    expect(h.google.requested).toBe(2)
  })

  it(`uses at most ${PICK_MAX} of a pick and says so`, async () => {
    const h = harness()
    await ready(h)
    await chooseAndGrant(h)
    const ids = Array.from({ length: PICK_MAX + 2 }, (_, i) => `1Folder${String(i).padStart(3, '0')}xxxxxxxxxxxxxxxxxxxxx`)
    for (const id of ids) h.files.set(id, folderFile(id, `F ${id.slice(7, 10)}`))
    h.google.pick(ids.map((id) => ({ id, name: 'x' })))
    await settle()
    expect(h.posted[0]!.message.folders).toHaveLength(PICK_MAX)
    expect(problems(h)).toEqual([TEXT.tooMany])
    expect(h.calls.filter((c) => c.url.startsWith('https://www.googleapis.com/'))).toHaveLength(PICK_MAX)
  })

  it('cancelling the Picker revokes the token, posts nothing and closes the window', async () => {
    const h = harness()
    await ready(h)
    await chooseAndGrant(h)
    h.google.pickerCallback!({ action: 'loaded' })
    expect(h.google.revoked).toEqual([])
    h.google.pickerCallback!({ action: 'cancel' })
    await settle()
    expect(h.posted).toEqual([])
    expect(h.google.revoked).toEqual([TOKEN])
    expect(status(h)).toBe(TEXT.cancelled)
    expect(h.closedWindow()).toBe(1)
    expectTokenOnlyToGoogle(h)
  })

  it('closing the window while the Picker is open revokes the token', async () => {
    const h = harness()
    await ready(h)
    await chooseAndGrant(h)
    h.pageHide()
    expect(h.google.revoked).toEqual([TOKEN])
    expect(h.posted).toEqual([])
  })

  it('consent closed, denied or not granting drive.file: "No access given", nothing picked, any token revoked', async () => {
    const h = harness()
    await ready(h)
    button(h).click()
    h.google.initConfig!.error_callback({ type: 'popup_closed' })
    expect(status(h)).toBe(TEXT.denied)
    expect(button(h).disabled).toBe(false)
    button(h).click()
    h.google.grant({ error: 'access_denied' })
    expect(status(h)).toBe(TEXT.denied)
    expect(h.google.visible).toBe(false)
    button(h).click()
    h.google.granted = false
    h.google.grant({ access_token: TOKEN, scope: 'https://www.googleapis.com/auth/drive.readonly' })
    expect(status(h)).toBe(TEXT.denied)
    expect(h.google.revoked).toEqual([TOKEN])
    expect(h.google.visible).toBe(false)
    button(h).click()
    h.google.initConfig!.error_callback({ type: 'popup_failed_to_open' })
    expect(status(h)).toBe(TEXT.popupBlocked)
    expect(h.posted).toEqual([])
  })

  it('ignores clicks while a sign-in is under way', async () => {
    const h = harness()
    await ready(h)
    button(h).click()
    button(h).click()
    expect(h.google.requested).toBe(1)
    expect(button(h).disabled).toBe(true)
  })
})
