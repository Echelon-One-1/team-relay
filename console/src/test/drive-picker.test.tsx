// @vitest-environment-options {"url": "https://relay.example.com/team"}
//
// PICKERS-SPEC §5.4 and §7.2 (ACC-019), on the team's page online: "Choose folders in Google
// Drive" opens the picker page in its own window, with a fresh nonce and the team in the
// fragment, and listens on the BroadcastChannel; only a message with that nonce and a good shape
// is taken. A blocked pop-up says so; Cancel stops listening; "Pick it again" replaces a
// name-matched drive. The console server is the dev mock (src/mock/relay.ts).

import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setTransport } from '@/api/client'
import { isHosted } from '@/api/key'
import { BoundariesSection } from '@/components/console/boundaries'
import { BLOCKED_LINE, NOT_SET_UP_LINE, PICKING_LINE } from '@/components/console/drive-folders'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createQueryClient } from '@/hooks/queries'
import { NavContext, TeamContext, type Nav } from '@/hooks/team'
import { FIXTURE_DRIVE_ID, FIXTURE_FOLDER_ID, fixtureTeams } from '@/mock/fixtures'
import { MockRelay } from '@/mock/relay'

const PICKER = { client_id: '123-abc.apps.googleusercontent.com', api_key: `AIza${'x'.repeat(35)}`, app_id: '123456789012' }
const OTHER_FOLDER = '1ExampleFolderProjects000000000c'

/** A BroadcastChannel that delivers what a test posts to every open channel of that name. */
class FakeChannel {
  static open: FakeChannel[] = []
  onmessage: ((e: MessageEvent) => void) | null = null
  closed = false
  readonly name: string
  constructor(name: string) {
    this.name = name
    FakeChannel.open.push(this)
  }
  postMessage() {}
  close() {
    this.closed = true
    FakeChannel.open = FakeChannel.open.filter((c) => c !== this)
  }
  static post(data: unknown) {
    for (const c of [...FakeChannel.open]) c.onmessage?.(new MessageEvent('message', { data }))
  }
}

type Call = { method: string; path: string; body: string | undefined }

function setup(opts: { picker?: boolean; blocked?: boolean } = {}) {
  const relay = new MockRelay()
  relay.latency = [0, 0]
  relay.sourcesConfig = { github: { configured: false, install_url: null }, google_picker: opts.picker === false ? null : PICKER }
  const calls: Call[] = []
  setTransport(async (path, init) => {
    const url = new URL(path, 'http://console.invalid/')
    calls.push({ method: (init.method ?? 'GET').toUpperCase(), path: url.pathname + url.search + url.hash, body: typeof init.body === 'string' ? init.body : undefined })
    return relay.handle(path, init)
  })
  const open = vi.fn((..._args: unknown[]) => (opts.blocked ? null : ({ closed: false } as unknown as Window)))
  vi.stubGlobal('open', open)
  const nav: Nav = {
    teams: { ...fixtureTeams, email: 'alice@example.com' },
    team: 'demo',
    selectTeam: () => {},
    view: 'team',
    setView: () => {},
    openCreate: () => {},
    focus: null,
    clearFocus: () => {},
  }
  render(
    <QueryClientProvider client={createQueryClient()}>
      <TooltipProvider>
        <TeamContext.Provider value="demo">
          <NavContext.Provider value={nav}>
            <BoundariesSection owner />
          </NavContext.Provider>
        </TeamContext.Provider>
      </TooltipProvider>
    </QueryClientProvider>,
  )
  return { relay, calls, open, puts: () => calls.filter((c) => c.method === 'PUT') }
}

const driveGroup = async () => within(await screen.findByRole('form', { name: 'Team boundaries' })).getByRole('group', { name: 'Google Drive' })
const nonceOf = (open: ReturnType<typeof vi.fn>) => {
  const url = String(open.mock.calls.at(-1)![0])
  const m = /^\/pick\/drive#n=([A-Za-z0-9_-]{43})&team=demo$/.exec(url)
  expect(m, url).not.toBeNull()
  return m![1]!
}
const picked = (folder_id: string, folder_name: string, drive_name: string | null = null) => ({ drive_id: FIXTURE_DRIVE_ID, folder_id, folder_name, drive_name })

beforeEach(() => {
  FakeChannel.open = []
  vi.stubGlobal('BroadcastChannel', FakeChannel)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('choosing folders in Google Drive (hosted)', () => {
  it('runs hosted, with no key', () => {
    expect(isHosted()).toBe(true)
  })

  it('opens the picker page with a fresh nonce, takes only its own message, and adds the folders with the viewer’s domain', async () => {
    const s = setup()
    const user = userEvent.setup()
    const d = within(await driveGroup())
    await user.click(await d.findByRole('button', { name: 'Choose folders in Google Drive' }))
    expect(s.open).toHaveBeenCalledTimes(1)
    expect(s.open.mock.calls[0]![1]).toBe('_blank')
    const nonce = nonceOf(s.open)
    expect(d.getByText(PICKING_LINE)).toBeInTheDocument()
    expect(FakeChannel.open.map((c) => c.name)).toEqual(['team-relay-pick'])

    // Another window's message, and one of a bad shape, are ignored.
    act(() => FakeChannel.post({ nonce: 'x'.repeat(43), folders: [picked(OTHER_FOLDER, 'Wrong')] }))
    act(() => FakeChannel.post({ nonce, folders: [{ ...picked(OTHER_FOLDER, 'Bad'), domain: 'evil.example' }] }))
    act(() => FakeChannel.post({ nonce, folders: [{ ...picked(OTHER_FOLDER, 'My Drive folder'), drive_id: null }] }))
    expect(d.getByText(PICKING_LINE)).toBeInTheDocument()
    expect((await driveGroup()).querySelector(`[data-chosen-folder="${OTHER_FOLDER}"]`)).toBeNull()

    act(() => FakeChannel.post({ nonce, folders: [picked(OTHER_FOLDER, 'Projects'), picked(FIXTURE_FOLDER_ID, 'Clients', 'Example Team Drive')] }))
    await waitFor(() => expect(d.queryByText(PICKING_LINE)).toBeNull())
    expect(d.getByText(/Added 2 folders\./)).toBeInTheDocument()
    expect(FakeChannel.open).toEqual([])
    const chip = (await driveGroup()).querySelector(`[data-chosen-folder="${OTHER_FOLDER}"]`) as HTMLElement
    // The drive's name comes from the entry of the same drive already listed.
    expect(chip).toHaveTextContent('Projects in Example Team Drive')
    expect(chip).not.toHaveTextContent('not checked')

    await user.click(screen.getByRole('button', { name: 'Save boundaries' }))
    await waitFor(() => expect(s.puts()).toHaveLength(1))
    const body = JSON.parse(s.puts()[0]!.body!) as { boundaries: { drive_folders: unknown[] } }
    expect(body.boundaries.drive_folders).toEqual([
      { domain: 'example.com', drive_id: FIXTURE_DRIVE_ID, folder_id: FIXTURE_FOLDER_ID, folder_name: 'Clients', drive_name: 'Example Team Drive' },
      { domain: 'example.com', drive_id: FIXTURE_DRIVE_ID, folder_id: OTHER_FOLDER, folder_name: 'Projects', drive_name: 'Example Team Drive' },
    ])
    // The nonce stays in the picker window's fragment: it never goes to a server.
    expect(s.calls.some((c) => c.path.includes(nonce) || (c.body ?? '').includes(nonce))).toBe(false)
  })

  it('a blocked pop-up says so, and nothing listens', async () => {
    const s = setup({ blocked: true })
    const user = userEvent.setup()
    const d = within(await driveGroup())
    await user.click(await d.findByRole('button', { name: 'Choose folders in Google Drive' }))
    expect(s.open).toHaveBeenCalledTimes(1)
    expect(d.getByRole('alert')).toHaveTextContent(BLOCKED_LINE)
    expect(FakeChannel.open).toEqual([])
  })

  it('Cancel stops listening: a later message adds nothing', async () => {
    const s = setup()
    const user = userEvent.setup()
    const d = within(await driveGroup())
    await user.click(await d.findByRole('button', { name: 'Choose folders in Google Drive' }))
    const nonce = nonceOf(s.open)
    await user.click(d.getByRole('button', { name: 'Cancel' }))
    expect(FakeChannel.open).toEqual([])
    act(() => FakeChannel.post({ nonce, folders: [picked(OTHER_FOLDER, 'Projects')] }))
    expect((await driveGroup()).querySelector(`[data-chosen-folder="${OTHER_FOLDER}"]`)).toBeNull()
    expect(d.getByRole('button', { name: 'Choose folders in Google Drive' })).toBeInTheDocument()
  })

  it('"Pick it again" on a drive matched by name opens the picker, and the pick replaces it', async () => {
    const s = setup()
    const user = userEvent.setup()
    const g = await driveGroup()
    const legacy = await waitFor(() => {
      const el = g.querySelector('[data-legacy-drive="Example Team Drive"]')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    await waitFor(() => expect(within(g).getByRole('button', { name: 'Choose folders in Google Drive' })).toBeInTheDocument())
    await user.click(within(legacy).getByRole('button', { name: 'Pick it again' }))
    const nonce = nonceOf(s.open)
    act(() => FakeChannel.post({ nonce, folders: [picked(FIXTURE_DRIVE_ID, 'Example Team Drive', 'Example Team Drive')] }))
    await waitFor(() => expect(g.querySelector('[data-legacy-drive]')).toBeNull())
    expect(g.querySelector(`[data-chosen-folder="${FIXTURE_DRIVE_ID}"]`)).toHaveTextContent('Example Team Drive a whole shared drive')
  })

  it('without the picker settings: paste only, one line why', async () => {
    setup({ picker: false })
    const d = within(await driveGroup())
    expect(await d.findByText(NOT_SET_UP_LINE)).toBeInTheDocument()
    expect(d.queryByRole('button', { name: 'Choose folders in Google Drive' })).toBeNull()
  })
})
