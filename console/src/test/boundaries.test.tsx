// M10 §1 and PICKERS-SPEC §7: a team's boundaries in Team settings. An owner edits and saves
// them (from the version read; someone else's save in between is a conflict and the form shows
// the latest): the topic, GitHub picked from the relay's GitHub app or pasted, Google Drive
// folders pasted here (picking from Google Drive is the hosted console's, drive-picker.test.tsx),
// and members' own folders. A member reads them. Until they are set, owners are asked to set them.
// The console server is the dev mock (src/mock/relay.ts), with every call recorded.

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { ChangeError, setTransport } from '@/api/client'
import { setConsoleKey } from '@/api/key'
import { App } from '@/App'
import { UNSET_LINE } from '@/components/console/boundaries'
import { LOCAL_LINE, PASTE_DRIVE_ERROR } from '@/components/console/drive-folders'
import { GITHUB_DOWN_LINE, NO_APP_LINE, NOT_INSTALLED_LINE, NOT_LISTED_NOTE, PASTE_GITHUB_ERROR } from '@/components/console/github-picker'
import {
  boundariesProblem,
  boundariesRefusal,
  boundariesValid,
  draftFrom,
  readBoundaries,
  readTeamBoundaries,
  toBoundaries,
  versionOk,
  type BoundariesDraft,
} from '@/lib/boundaries'
import { TEAM_STORAGE_KEY } from '@/lib/teams'
import { FIXTURE_DRIVE_ID, FIXTURE_FOLDER_ID, fixtureGithubListing } from '@/mock/fixtures'
import { MockRelay } from '@/mock/relay'
import { renderWithClient } from './render'
import { PLACEHOLDERS, rawVectors, vectors } from './vectors'

const KEY = 'b0und-b0und-b0und-b0und-b0und-b0'
const NEW_FOLDER = '1ExampleFolderContracts00000000b'

type Call = { method: string; path: string; team: string | null; body: unknown }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function server(opts: { role?: 'owner' | 'member'; override?: (c: Call) => Response | null } = {}) {
  const relay = new MockRelay()
  relay.latency = [0, 0]
  relay.role = opts.role ?? 'owner'
  const calls: Call[] = []
  setTransport(async (path, init) => {
    const url = new URL(path, 'http://console.invalid/')
    const headers = new Headers(init.headers)
    const call: Call = {
      method: (init.method ?? 'GET').toUpperCase(),
      path: url.pathname + url.search,
      team: headers.get('X-Relay-Team'),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    return opts.override?.(call) ?? relay.handle(path, init)
  })
  return { relay, calls, puts: () => calls.filter((c) => c.method === 'PUT'), reads: (p: string) => calls.filter((c) => c.path === p) }
}

const section = () => screen.findByRole('region', { name: 'Boundaries' })
const ownerForm = async () => within(await section()).findByRole('form', { name: 'Team boundaries' })
const github = (form: HTMLElement) => within(form).getByRole('group', { name: 'GitHub' })
const drive = (form: HTMLElement) => within(form).getByRole('group', { name: 'Google Drive' })
const org = async (form: HTMLElement, name: string) => {
  const el = await waitFor(() => {
    const li = form.querySelector(`[data-installation="${name}"]`)
    expect(li).not.toBeNull()
    return li as HTMLElement
  })
  return within(el)
}
const chosen = (form: HTMLElement) => within(github(form)).queryByRole('list', { name: 'Chosen on GitHub' })

beforeEach(() => {
  setConsoleKey(KEY)
  window.history.replaceState(null, '', '/')
  window.localStorage.clear()
})

describe("an owner's boundaries (M10 §1, PICKERS-SPEC §7)", () => {
  it('picks repositories, drops a whole org and a name-matched drive, pastes a folder, and saves all six fields', async () => {
    const s = server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const form = await ownerForm()
    const topic = within(form).getByLabelText('Topic')
    expect(topic).toHaveValue('Example Co: the orders and payments services, their runbooks, deploys and incidents, and how the team works.')
    expect(within(form).getByText(/Version 2, set by/)).toBeInTheDocument()
    const save = within(form).getByRole('button', { name: 'Save boundaries' })
    expect(save).toBeDisabled()

    // example-org is a whole org: its repositories cannot be ticked until it is not.
    const exampleOrg = await org(form, 'example-org')
    const whole = exampleOrg.getByRole('switch', { name: /Whole org/ })
    expect(whole).toBeChecked()
    expect(exampleOrg.getByRole('checkbox', { name: /^api/ })).toBeDisabled()
    await user.click(whole)
    await user.click(exampleOrg.getByRole('checkbox', { name: /^api/ }))
    await user.click(exampleOrg.getByRole('checkbox', { name: /^web/ }))
    expect(exampleOrg.getByText('2 of 4 picked')).toBeInTheDocument()
    // example-labs/handbook is ticked from the saved boundaries; swap it for tools.
    const labs = await org(form, 'example-labs')
    expect(labs.getByRole('checkbox', { name: /^handbook/ })).toBeChecked()
    await user.click(labs.getByRole('checkbox', { name: /^handbook/ }))
    await user.click(labs.getByRole('checkbox', { name: /^tools/ }))
    expect(within(chosen(form)!).getAllByRole('listitem').map((li) => li.getAttribute('data-chosen-repo'))).toEqual(['example-org/api', 'example-org/web', 'example-labs/tools'])

    // The name-matched drive goes; a pasted folder comes in, "not checked".
    const d = drive(form)
    expect(within(d).getByText('(matched by name)')).toBeInTheDocument()
    await user.click(within(d).getByRole('button', { name: 'Remove Example Team Drive' }))
    await user.type(within(d).getByLabelText('Folder link'), `https://drive.google.com/drive/folders/${NEW_FOLDER}?usp=sharing`)
    await user.type(within(d).getByLabelText('Folder name'), 'Contracts')
    await user.click(within(d).getByRole('button', { name: 'Add' }))
    const pasted = d.querySelector(`[data-chosen-folder="${NEW_FOLDER}"]`) as HTMLElement
    expect(pasted).toHaveTextContent('Contracts')
    expect(pasted).toHaveTextContent('not checked')

    await user.clear(topic)
    await user.type(topic, '  Example Co: payments.  ')
    await user.click(within(form).getByRole('switch', { name: 'Members may add their own folders' }))
    expect(within(form).getByText('Unsaved changes')).toBeInTheDocument()

    await user.click(save)
    await waitFor(() => expect(within(form).getByText(/Saved\. Answers use version 3/)).toBeInTheDocument())
    expect(s.puts()).toEqual([
      {
        method: 'PUT',
        path: '/api/boundaries',
        team: 'demo',
        body: {
          version: 2,
          boundaries: {
            topic: 'Example Co: payments.',
            github_orgs: [],
            github_repos: [
              { org: 'example-org', repo: 'api', id: 6001 },
              { org: 'example-org', repo: 'web', id: 6004 },
              { org: 'example-labs', repo: 'tools', id: 7002 },
            ],
            drive_folders: [
              { domain: 'example.com', drive_id: FIXTURE_DRIVE_ID, folder_id: FIXTURE_FOLDER_ID, folder_name: 'Clients', drive_name: 'Example Team Drive' },
              { domain: 'example.com', drive_id: null, folder_id: NEW_FOLDER, folder_name: 'Contracts', drive_name: null },
            ],
            drives: [],
            member_folders: false,
          },
        },
      },
    ])
    expect(topic).toHaveValue('Example Co: payments.')
    expect(save).toBeDisabled()
  })

  it('ticking a whole org clears and disables its repository ticks', async () => {
    server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const form = await ownerForm()
    const labs = await org(form, 'example-labs')
    const whole = labs.getByRole('switch', { name: /Whole org/ })
    expect(whole).not.toBeChecked()
    await user.click(labs.getByRole('checkbox', { name: /^tools/ }))
    expect(labs.getByText('2 of 2 picked')).toBeInTheDocument()
    await user.click(whole)
    for (const box of labs.getAllByRole('checkbox')) {
      expect(box).not.toBeChecked()
      expect(box).toBeDisabled()
    }
    expect(labs.getByText('Whole organisation')).toBeInTheDocument()
    const list = within(chosen(form)!)
    expect(list.queryByText('example-labs/handbook')).toBeNull()
    expect(form.querySelector('[data-chosen-org="example-labs"]')).not.toBeNull()
  })

  it('marks private and archived repositories, filters a long list, says when it is cut short, and when an installation is suspended', async () => {
    const s = server()
    s.relay.githubListing = {
      installations: [
        {
          account: 'big-org',
          state: 'ok',
          repository_selection: 'all',
          repos: Array.from({ length: 12 }, (_, i) => ({ name: `repo-${String(i).padStart(2, '0')}`, id: 100 + i, private: i === 1, archived: i === 2 })),
          truncated: true,
        },
        { account: 'paused-org', state: 'suspended', repository_selection: 'all', repos: [], truncated: false },
      ],
      fetched_at: '2026-11-11T10:00:00.000Z',
    }
    const user = userEvent.setup()
    renderWithClient(<App />)
    const form = await ownerForm()
    const big = await org(form, 'big-org')
    expect(big.getByRole('checkbox', { name: /^repo-01/ }).closest('label')).toHaveTextContent('private')
    expect(big.getByRole('checkbox', { name: /^repo-02/ }).closest('label')).toHaveTextContent('archived')
    expect(big.getByText('Showing the first 1000.')).toBeInTheDocument()
    await user.type(big.getByRole('searchbox', { name: 'Filter big-org repositories' }), '1')
    expect(big.getAllByRole('checkbox').map((c) => c.closest('label')!.getAttribute('data-repo'))).toEqual(['repo-01', 'repo-10', 'repo-11'])
    const paused = await org(form, 'paused-org')
    expect(paused.getByText('This installation is suspended on GitHub.')).toBeInTheDocument()
    expect(paused.queryByRole('switch')).toBeNull()
  })

  it('pastes github.com addresses: a listed repository gets its id, another is "not checked", a bad one is refused', async () => {
    const s = server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const form = await ownerForm()
    await org(form, 'example-labs')
    const g = within(github(form))
    const paste = g.getByLabelText('Paste a repository or org address')
    await user.type(paste, 'example-org/api{Enter}')
    expect(g.getByRole('alert')).toHaveTextContent(PASTE_GITHUB_ERROR)
    await user.clear(paste)
    await user.type(paste, 'https://github.com/example-org/payments{Enter}')
    expect(g.getByRole('alert')).toHaveTextContent('example-org is already shared as a whole organisation, so payments is in.')
    await user.clear(paste)
    await user.type(paste, 'https://github.com/Example-Labs/tools.git{Enter}')
    await user.type(paste, 'https://www.github.com/other-org/thing/{Enter}')
    await user.type(paste, 'https://github.com/second-org{Enter}')
    const labsTools = form.querySelector('[data-chosen-repo="example-labs/tools"]') as HTMLElement
    expect(labsTools).not.toHaveTextContent('not checked')
    expect((await org(form, 'example-labs')).getByRole('checkbox', { name: /^tools/ })).toBeChecked()
    expect(form.querySelector('[data-chosen-repo="other-org/thing"]')).toHaveTextContent('not checked')
    expect(form.querySelector('[data-chosen-org="second-org"]')).toHaveTextContent(NOT_LISTED_NOTE)
    await user.click(within(form).getByRole('button', { name: 'Save boundaries' }))
    await waitFor(() => expect(s.puts()).toHaveLength(1))
    expect(s.puts()[0]!.body).toMatchObject({
      boundaries: {
        github_orgs: ['example-org', 'second-org'],
        github_repos: [
          { org: 'example-labs', repo: 'handbook', id: 7001 },
          { org: 'example-labs', repo: 'tools', id: 7002 },
          { org: 'other-org', repo: 'thing', id: null },
        ],
      },
    })
  })

  it('keeps saved items the app does not list, marked, until they are removed', async () => {
    const s = server()
    s.relay.setBoundariesAs('demo', 'bob', {
      topic: 'T',
      github_orgs: ['legacy-org'],
      github_repos: [{ org: 'gone-org', repo: 'old', id: 99 }],
      drive_folders: [],
      drives: [],
      member_folders: false,
    })
    const user = userEvent.setup()
    renderWithClient(<App />)
    const form = await ownerForm()
    await org(form, 'example-org')
    expect(form.querySelector('[data-chosen-org="legacy-org"]')).toHaveTextContent(NOT_LISTED_NOTE)
    expect(form.querySelector('[data-chosen-repo="gone-org/old"]')).toHaveTextContent(NOT_LISTED_NOTE)
    await user.click(within(form).getByRole('button', { name: 'Remove gone-org/old' }))
    expect(form.querySelector('[data-chosen-repo="gone-org/old"]')).toBeNull()
  })

  it('checks the fields before sending anything', async () => {
    const s = server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const form = await ownerForm()
    const topic = within(form).getByLabelText('Topic')
    await user.clear(topic)
    await user.click(within(form).getByRole('button', { name: 'Save boundaries' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent(/Say what the team talks about/)
    expect(topic).toHaveAttribute('aria-invalid', 'true')
    await user.type(topic, 'x')
    const d = within(drive(form))
    await user.type(d.getByLabelText('Folder link'), 'https://example.com/folders/x')
    await user.click(d.getByRole('button', { name: 'Add' }))
    expect(d.getByRole('alert')).toHaveTextContent(PASTE_DRIVE_ERROR)
    expect(d.getByLabelText('Folder link')).toHaveAttribute('aria-invalid', 'true')
    await user.clear(d.getByLabelText('Folder link'))
    await user.type(d.getByLabelText('Folder link'), `https://drive.google.com/drive/folders/${NEW_FOLDER}`)
    await user.click(d.getByRole('button', { name: 'Add' }))
    expect(d.getByRole('alert')).toHaveTextContent(/Give the folder a name/)
    await user.clear(d.getByLabelText('Folder link'))
    await user.type(d.getByLabelText('Folder link'), `https://drive.google.com/open?id=${FIXTURE_FOLDER_ID}`)
    await user.type(d.getByLabelText('Folder name'), 'Clients again')
    await user.click(d.getByRole('button', { name: 'Add' }))
    expect(d.getByRole('alert')).toHaveTextContent('This folder is already listed.')
    expect(s.puts()).toEqual([])
  })

  it('a team without boundaries asks its owner to set them, and saves from version 0', async () => {
    window.localStorage.setItem(TEAM_STORAGE_KEY, 'research')
    const s = server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const form = await ownerForm()
    expect(within(form).getByText("Set this team's boundaries")).toBeInTheDocument()
    expect(within(form).getByText(UNSET_LINE)).toBeInTheDocument()
    expect(within(form).getByRole('button', { name: 'Save boundaries' })).toBeDisabled()
    await user.type(within(form).getByLabelText('Topic'), 'Research at Example Co.')
    await user.type(within(github(form)).getByLabelText('Paste a repository or org address'), 'https://github.com/example-research{Enter}')
    await user.click(within(form).getByRole('button', { name: 'Save boundaries' }))
    await waitFor(() => expect(s.puts()).toHaveLength(1))
    expect(s.puts()[0]).toMatchObject({
      team: 'research',
      body: { version: 0, boundaries: { topic: 'Research at Example Co.', github_orgs: ['example-research'], github_repos: [], drive_folders: [], drives: [], member_folders: false } },
    })
    await waitFor(() => expect(within(form).queryByText("Set this team's boundaries")).toBeNull())
  })

  it('someone else saved first: says so and shows the latest, and nothing is overwritten', async () => {
    const s = server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const form = await ownerForm()
    await user.type(within(form).getByLabelText('Topic'), ' More.')
    s.relay.setBoundariesAs('demo', 'bob', { topic: "bob's topic", github_orgs: ['bob-org'], github_repos: [], drive_folders: [], drives: [], member_folders: false })
    await user.click(within(form).getByRole('button', { name: 'Save boundaries' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent(/Someone else changed the boundaries/)
    await waitFor(() => expect(within(form).getByLabelText('Topic')).toHaveValue("bob's topic"))
    expect(s.puts()).toHaveLength(1)
    expect(s.puts()[0]!.body).toMatchObject({ version: 2 })
    await user.type(within(form).getByLabelText('Topic'), '!')
    await user.click(within(form).getByRole('button', { name: 'Save boundaries' }))
    await waitFor(() => expect(s.puts()).toHaveLength(2))
    expect(s.puts()[1]!.body).toMatchObject({ version: 3, boundaries: { topic: "bob's topic!" } })
  })

  it('a refusal for a typed drive name or an org or drive the relay does not allow is said in words', async () => {
    let code = 'legacy_drive'
    const s = server({
      override: (c) => (c.method === 'PUT' && c.path === '/api/boundaries' ? json({ error: 'relay_refused', relay_status: 400, relay_error: code, detail: 'refused' }, 502) : null),
    })
    const user = userEvent.setup()
    renderWithClient(<App />)
    const form = await ownerForm()
    await user.type(within(form).getByLabelText('Topic'), '!')
    await user.click(within(form).getByRole('button', { name: 'Save boundaries' }))
    expect(await within(form).findByText(/can only be kept or removed\. Pick shared-drive folders instead\./)).toBeInTheDocument()
    code = 'org_not_allowed'
    await user.click(within(form).getByRole('button', { name: 'Save boundaries' }))
    expect(await within(form).findByText(/only allows some GitHub organisations/)).toBeInTheDocument()
    code = 'drive_not_allowed'
    await user.click(within(form).getByRole('button', { name: 'Save boundaries' }))
    expect(await within(form).findByText(/only allows some shared drives/)).toBeInTheDocument()
    expect(s.puts()).toHaveLength(3)
  })
})

describe('the GitHub section without a listing (PICKERS-SPEC §7.1)', () => {
  it("the relay's GitHub app isn't set up: paste only, one line why, and no listing is asked for", async () => {
    const s = server()
    s.relay.sourcesConfig = { github: { configured: false, install_url: null }, google_picker: null }
    const user = userEvent.setup()
    renderWithClient(<App />)
    const form = await ownerForm()
    expect(await within(github(form)).findByText(NO_APP_LINE)).toBeInTheDocument()
    expect(s.reads('/api/sources/github')).toEqual([])
    // Saved choices still show; pasting still works.
    expect(form.querySelector('[data-chosen-repo="example-labs/handbook"]')).not.toBeNull()
    await user.type(within(github(form)).getByLabelText('Paste a repository or org address'), 'https://github.com/example-org/api{Enter}')
    expect(form.querySelector('[data-chosen-repo="example-org/api"]')).toBeNull()
    expect(within(github(form)).getByRole('alert')).toHaveTextContent(/already shared as a whole organisation/)
  })

  it('a relay without the sources routes (404): paste only, for GitHub and for Drive', async () => {
    const s = server()
    s.relay.sourcesConfig = null
    renderWithClient(<App />)
    const form = await ownerForm()
    expect(await within(github(form)).findByText(NO_APP_LINE)).toBeInTheDocument()
    expect(within(drive(form)).getByText(LOCAL_LINE)).toBeInTheDocument()
  })

  it('the app is not installed yet: the install link, and Check again reads the list again', async () => {
    const s = server()
    s.relay.githubListing = { installations: [], fetched_at: '2026-11-11T10:00:00.000Z' }
    const user = userEvent.setup()
    renderWithClient(<App />)
    const form = await ownerForm()
    expect(await within(github(form)).findByText(NOT_INSTALLED_LINE)).toBeInTheDocument()
    const link = within(github(form)).getByRole('link', { name: /Install the app on GitHub/ })
    expect(link).toHaveAttribute('href', 'https://github.com/apps/example-relay-sources/installations/new')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(s.reads('/api/sources/github')).toHaveLength(1)
    s.relay.githubListing = structuredClone(fixtureGithubListing)
    await user.click(within(github(form)).getByRole('button', { name: 'Check again' }))
    await org(form, 'example-org')
    expect(s.reads('/api/sources/github')).toHaveLength(2)
  })

  it("GitHub didn't answer: says so, waits for Retry-After before Try again, and keeps saved choices and pasting", async () => {
    const s = server()
    s.relay.githubListing = { status: 502, body: { error: 'relay_refused', relay_status: 503, relay_error: 'github_rate_limited' }, retryAfter: 120 }
    renderWithClient(<App />)
    const form = await ownerForm()
    expect(await within(github(form)).findByText(GITHUB_DOWN_LINE)).toBeInTheDocument()
    expect(within(github(form)).getByRole('button', { name: /Try again in 1[12][0-9] s/ })).toBeDisabled()
    expect(form.querySelector('[data-chosen-repo="example-labs/handbook"]')).not.toBeNull()
    expect(within(github(form)).getByLabelText('Paste a repository or org address')).toBeEnabled()
  })

  it('GitHub unavailable without Retry-After: Try again at once', async () => {
    const s = server()
    s.relay.githubListing = { status: 502, body: { error: 'relay_refused', relay_status: 502, relay_error: 'github_unavailable' } }
    const user = userEvent.setup()
    renderWithClient(<App />)
    const form = await ownerForm()
    expect(await within(github(form)).findByText(GITHUB_DOWN_LINE)).toBeInTheDocument()
    s.relay.githubListing = structuredClone(fixtureGithubListing)
    await user.click(within(github(form)).getByRole('button', { name: 'Try again' }))
    await org(form, 'example-labs')
  })
})

describe('the Drive section on this computer (PICKERS-SPEC §7.2)', () => {
  it('offers pasting only, and a name-matched drive is picked again by pasting its link, which replaces it', async () => {
    const s = server()
    s.relay.sourcesConfig = {
      github: { configured: true, install_url: null },
      google_picker: { client_id: '123-abc.apps.googleusercontent.com', api_key: `AIza${'x'.repeat(35)}`, app_id: '123456789012' },
    }
    const user = userEvent.setup()
    renderWithClient(<App />)
    const form = await ownerForm()
    const d = within(drive(form))
    expect(await d.findByText(LOCAL_LINE)).toBeInTheDocument()
    expect(d.queryByRole('button', { name: 'Choose folders in Google Drive' })).toBeNull()
    const legacy = drive(form).querySelector('[data-legacy-drive="Example Team Drive"]') as HTMLElement
    expect(legacy).toHaveTextContent('Example Team Drive (matched by name)')
    await user.click(within(legacy).getByRole('button', { name: 'Pick it again' }))
    expect(d.getByLabelText('Folder link')).toHaveFocus()
    expect(d.getByText(/it replaces the entry matched by name/)).toBeInTheDocument()
    await user.type(d.getByLabelText('Folder link'), `https://drive.google.com/drive/folders/${FIXTURE_DRIVE_ID}`)
    await user.type(d.getByLabelText('Folder name'), 'Example Team Drive{Enter}')
    expect(drive(form).querySelector('[data-legacy-drive]')).toBeNull()
    expect(drive(form).querySelector(`[data-chosen-folder="${FIXTURE_DRIVE_ID}"]`)).toHaveTextContent('not checked')
    await user.click(within(form).getByRole('button', { name: 'Save boundaries' }))
    await waitFor(() => expect(s.puts()).toHaveLength(1))
    expect(s.puts()[0]!.body).toMatchObject({
      boundaries: {
        drive_folders: [
          { folder_id: FIXTURE_FOLDER_ID },
          { domain: 'example.com', drive_id: null, folder_id: FIXTURE_DRIVE_ID, folder_name: 'Example Team Drive', drive_name: null },
        ],
        drives: [],
      },
    })
  })

  it('without any domain known, asks for it with a pasted link', async () => {
    window.localStorage.setItem(TEAM_STORAGE_KEY, 'research')
    const s = server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    const form = await ownerForm()
    const d = within(drive(form))
    await user.type(within(form).getByLabelText('Topic'), 'Research.')
    await user.type(d.getByLabelText('Folder link'), `https://drive.google.com/drive/folders/${NEW_FOLDER}`)
    await user.type(d.getByLabelText('Folder name'), 'Papers')
    await user.click(d.getByRole('button', { name: 'Add' }))
    expect(d.getByRole('alert')).toHaveTextContent(/Google Workspace domain/)
    await user.type(d.getByLabelText('Google Workspace domain'), 'Example.com')
    await user.click(d.getByRole('button', { name: 'Add' }))
    await user.click(within(form).getByRole('button', { name: 'Save boundaries' }))
    await waitFor(() => expect(s.puts()).toHaveLength(1))
    expect(s.puts()[0]!.body).toMatchObject({ boundaries: { drive_folders: [{ domain: 'example.com', folder_id: NEW_FOLDER, folder_name: 'Papers' }] } })
  })
})

describe("a member's view (M10 §1, PICKERS-SPEC §7.3)", () => {
  it('reads whole orgs, repositories, folders and name-matched drives, with no way to change them', async () => {
    const s = server({ role: 'member' })
    renderWithClient(<App />)
    const region = await section()
    const view = await waitFor(() => {
      const v = region.querySelector('[data-boundaries-view]')
      expect(v).not.toBeNull()
      return v as HTMLElement
    })
    expect(within(view).getByText(/the orders and payments services/)).toBeInTheDocument()
    const gh = within(view).getByRole('list', { name: 'GitHub' })
    expect(gh).toHaveTextContent('example-org whole organisation')
    expect(gh).toHaveTextContent('example-labs/handbook')
    const dr = within(view).getByRole('list', { name: 'Google Drive' })
    expect(dr).toHaveTextContent('Clients in Example Team Drive')
    expect(dr).toHaveTextContent('Example Team Drive shared drive, matched by name')
    expect(within(view).getByText(/Allowed: each member may add folders/)).toBeInTheDocument()
    expect(within(region).queryByRole('form')).toBeNull()
    expect(within(region).queryByRole('textbox')).toBeNull()
    expect(within(region).queryByRole('switch')).toBeNull()
    // A member's form never asks for the owners' sources settings.
    expect(s.reads('/api/sources/config')).toEqual([])
    expect(s.reads('/api/sources/github')).toEqual([])
    expect(s.puts()).toEqual([])
  })

  it('in a team without boundaries: says answers need approval as before', async () => {
    window.localStorage.setItem(TEAM_STORAGE_KEY, 'ops')
    server({
      override: (c) =>
        c.path === '/api/teams' && c.method === 'GET'
          ? json({
              teams: [
                { team: 'demo', name: 'Demo', member: 'alice', role: 'owner' },
                { team: 'ops', name: 'Operations', member: 'alice', role: 'member' },
              ],
              invitations: [],
              admin: false,
              teams_created: 0,
              max_teams_created: 3,
              suggested_member: 'alice',
              can_manage_teams: true,
              default_team: 'demo',
            })
          : c.path === '/api/boundaries' && c.team === 'ops'
            ? json({ team: 'ops', version: 0, boundaries: null, updated_at: null, updated_by: null })
            : c.team === 'ops'
              ? json({ error: 'not_found' }, 404)
              : null,
    })
    renderWithClient(<App />)
    const region = await section()
    expect(await within(region).findByText(/No boundaries yet\. Until an owner sets them, answers need each member's approval, as before\./)).toBeInTheDocument()
    expect(within(region).getByText(/Only owners change them/)).toBeInTheDocument()
  })
})

describe('loading, older relays, and a failed read', () => {
  it('a document the M10 relay wrote reads with no repositories and no folders, and is saved with all six fields (ACC-004)', async () => {
    const m10 = {
      team: 'demo',
      version: 4,
      boundaries: { topic: 'Old topic', github_orgs: ['example-org'], drives: [{ domain: 'example.com', shared_drive: 'Old Drive' }], member_folders: false },
      since: { github_orgs: { 'example-org': 1 }, drives: [{ domain: 'example.com', shared_drive: 'Old Drive', since: 2 }], member_folders: null },
      updated_at: '2026-10-01T10:00:00Z',
      updated_by: 'olga',
    }
    const s = server({
      override: (c) =>
        c.path === '/api/boundaries'
          ? c.method === 'GET'
            ? json(m10)
            : json({ ...m10, version: 5, boundaries: (c.body as { boundaries: unknown }).boundaries, since: null })
          : null,
    })
    const user = userEvent.setup()
    renderWithClient(<App />)
    const form = await ownerForm()
    expect(form.querySelector('[data-chosen-org="example-org"]')).not.toBeNull()
    expect(form.querySelector('[data-legacy-drive="Old Drive"]')).not.toBeNull()
    await user.type(within(form).getByLabelText('Topic'), '!')
    await user.click(within(form).getByRole('button', { name: 'Save boundaries' }))
    await waitFor(() => expect(s.puts()).toHaveLength(1))
    expect(s.puts()[0]!.body).toEqual({
      version: 4,
      boundaries: { topic: 'Old topic!', github_orgs: ['example-org'], github_repos: [], drive_folders: [], drives: [{ domain: 'example.com', shared_drive: 'Old Drive' }], member_folders: false },
    })
  })

  it('a relay without the route (404) says so, and is not asked again', async () => {
    const s = server({ override: (c) => (c.path === '/api/boundaries' ? json({ error: 'not_found' }, 404) : null) })
    renderWithClient(<App />)
    const region = await section()
    expect(await within(region).findByText(/This relay does not keep boundaries yet/)).toBeInTheDocument()
    expect(s.calls.filter((c) => c.path === '/api/boundaries')).toHaveLength(1)
  })

  it('a failed read, or an answer that breaks the rule, says so and can be tried again', async () => {
    let answer: Response | null = json({ error: 'internal' }, 500)
    server({ override: (c) => (c.path === '/api/boundaries' ? answer : null) })
    const user = userEvent.setup()
    renderWithClient(<App />)
    const region = await section()
    expect(await within(region).findByRole('alert')).toHaveTextContent('The boundaries could not be read.')
    answer = json({ team: 'demo', version: 2, boundaries: { topic: 'T', github_orgs: ['-bad'], github_repos: [], drive_folders: [], drives: [], member_folders: false } })
    await user.click(within(region).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(within(region).getByRole('button', { name: 'Try again' })).toBeEnabled())
    expect(within(region).getByRole('alert')).toHaveTextContent('The boundaries could not be read.')
    answer = null
    await user.click(within(region).getByRole('button', { name: 'Try again' }))
    expect(await within(region).findByRole('form', { name: 'Team boundaries' })).toBeInTheDocument()
  })
})

describe('creating a team goes straight to its boundaries (M10 §1)', () => {
  it('opens Team settings at Boundaries with the topic focused', async () => {
    server()
    const user = userEvent.setup()
    renderWithClient(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Switch team/ })).toHaveTextContent('Demo'))
    await user.click(screen.getByRole('button', { name: /Switch team/ }))
    await user.click(within(await screen.findByRole('dialog', { name: 'Your teams' })).getByRole('button', { name: /Create team/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Create a team' })
    await user.type(within(dialog).getByLabelText('Team name'), 'Payments')
    await user.click(within(dialog).getByRole('button', { name: 'Create team' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Switch team/ })).toHaveTextContent('Payments'))
    const form = await ownerForm()
    expect(within(form).getByText(UNSET_LINE)).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(within(form).getByLabelText('Topic')))
  })
})

describe('the form rules (lib/boundaries)', () => {
  const folder = { domain: 'example.com', drive_id: FIXTURE_DRIVE_ID, folder_id: FIXTURE_FOLDER_ID, folder_name: 'Clients', drive_name: 'Team Drive' }
  const draft: BoundariesDraft = {
    topic: 'Topic',
    github_orgs: ['a-org'],
    github_repos: [{ org: 'b-org', repo: 'api', id: 1 }],
    drive_folders: [folder],
    drives: [{ domain: 'example.com', shared_drive: 'Team Drive' }],
    member_folders: true,
  }

  it('finds the first problem, on its section', () => {
    expect(boundariesProblem(draft)).toBeNull()
    expect(boundariesProblem({ ...draft, topic: ' ' })?.field).toBe('topic')
    expect(boundariesProblem({ ...draft, topic: 'x'.repeat(501) })?.message).toMatch(/501 characters/)
    expect(boundariesProblem({ ...draft, topic: 'a\u202eb' })?.field).toBe('topic')
    expect(boundariesProblem({ ...draft, github_orgs: Array.from({ length: 11 }, (_, i) => `o${i}`) })?.field).toBe('github')
    expect(boundariesProblem({ ...draft, github_repos: Array.from({ length: 101 }, (_, i) => ({ org: 'b-org', repo: `r${i}`, id: null })) })?.message).toMatch(/At most 100/)
    expect(boundariesProblem({ ...draft, drive_folders: Array.from({ length: 21 }, (_, i) => ({ ...folder, folder_id: `${FIXTURE_FOLDER_ID}${i}` })) })?.field).toBe('drive')
  })

  it('sends trimmed values, the first of duplicates, and no repository of a whole org', () => {
    expect(
      toBoundaries({
        topic: '  T  ',
        github_orgs: ['a-org', 'A-ORG', ' b '],
        github_repos: [
          { org: 'A-Org', repo: 'x', id: 1 },
          { org: 'c-org', repo: 'API', id: 2 },
          { org: 'C-ORG', repo: 'api', id: 3 },
        ],
        drive_folders: [folder, { ...folder, folder_name: 'Again' }],
        drives: [
          { domain: 'example.com', shared_drive: 'D' },
          { domain: 'example.com', shared_drive: 'D' },
        ],
        member_folders: false,
      }),
    ).toEqual({
      topic: 'T',
      github_orgs: ['a-org', 'b'],
      github_repos: [{ org: 'c-org', repo: 'API', id: 2 }],
      drive_folders: [folder],
      drives: [{ domain: 'example.com', shared_drive: 'D' }],
      member_folders: false,
    })
    expect(draftFrom(null)).toEqual({ topic: '', github_orgs: [], github_repos: [], drive_folders: [], drives: [], member_folders: false })
  })

  it('words the refusals', () => {
    const relay = (status: number, code: string | null, detail: string | null = null) =>
      new ChangeError('refused', { status: 502, relayStatus: status, relayError: code, detail })
    expect(boundariesRefusal(relay(409, 'version_conflict'))).toMatchObject({ conflict: true })
    expect(boundariesRefusal(relay(403, 'forbidden')).message).toBe('Only team owners can change the boundaries.')
    expect(boundariesRefusal(relay(400, 'invalid_body', 'topic is too long')).message).toBe('topic is too long')
    expect(boundariesRefusal(relay(400, 'legacy_drive', 'x')).message).toMatch(/Pick shared-drive folders instead/)
    expect(boundariesRefusal(relay(429, 'rate_limited')).message).toMatch(/Too many changes/)
    expect(boundariesRefusal(new ChangeError('gone', { signedOut: true })).message).toBe('gone')
  })

  it('reads a GET answer: M10 documents get empty lists and every since map; a broken one is not read', () => {
    const m10 = { topic: 'T', github_orgs: ['a'], drives: [], member_folders: true }
    expect(readTeamBoundaries({ team: 'demo', version: 3, boundaries: m10, since: { github_orgs: { a: 1 }, drives: [], member_folders: 2 }, updated_at: null, updated_by: null })).toEqual({
      team: 'demo',
      version: 3,
      boundaries: { ...m10, github_repos: [], drive_folders: [] },
      since: { github_orgs: { a: 1 }, github_repos: {}, drive_folders: {}, drives: [], member_folders: 2 },
      updated_at: null,
      updated_by: null,
    })
    expect(readTeamBoundaries({ team: 'demo', version: 0, boundaries: null, updated_at: null, updated_by: null })?.boundaries).toBeNull()
    expect(readTeamBoundaries({ team: 'demo', version: 3, boundaries: { ...m10, github_orgs: ['-x'] } })).toBeNull()
    expect(readTeamBoundaries({ team: 'demo', version: 'x', boundaries: null })).toBeNull()
  })
})

// PICKERS-SPEC §2.1 (ACC-002): one rule. The relay, the console server and this page accept
// exactly what schema/boundaries-vectors.json says.
describe('the one validation rule (schema/boundaries-vectors.json)', () => {
  it('expands every placeholder it names', () => {
    expect(Object.keys(rawVectors.placeholders).sort()).toEqual(Object.keys(PLACEHOLDERS).sort())
    const names = new RegExp(`"(${Object.keys(PLACEHOLDERS).join('|')})"`)
    expect(JSON.stringify([vectors.valid, vectors.invalid, vectors.m10_documents, vectors.normalised])).not.toMatch(names)
    expect(PLACEHOLDERS.DOMAIN_253!.length).toBe(253)
    expect(PLACEHOLDERS.DOMAIN_254!.length).toBe(254)
  })

  it.each(vectors.valid.map((b, i) => [i, b] as const))('accepts valid document %i', (_i, b) => {
    expect(boundariesValid(b)).toBe(true)
    expect(readBoundaries(b)).toBe(b)
  })

  it.each(vectors.invalid.map((v) => [v.why, v.boundaries] as const))('refuses: %s', (_why, b) => {
    expect(boundariesValid(b)).toBe(false)
  })

  it.each(vectors.m10_documents.map((b, i) => [i, b] as const))('M10 document %i: never a PUT body, read with empty picked lists', (_i, b) => {
    expect(boundariesValid(b)).toBe(false)
    expect(readBoundaries(b)).toEqual({ ...b, github_repos: [], drive_folders: [] })
  })

  it.each(vectors.normalised.map((n) => [n.why, n] as const))('sends what the relay stores: %s', (_why, n) => {
    const out = toBoundaries(n.boundaries as unknown as BoundariesDraft)
    expect(out).toEqual(n.expect)
    expect(boundariesValid(out)).toBe(true)
  })

  it.each(vectors.versions.valid.map((v) => [JSON.stringify(v), v] as const))('accepts version %s', (_s, v) => {
    expect(versionOk(v)).toBe(true)
  })

  it.each(vectors.versions.invalid.map((v) => [JSON.stringify(v), v] as const))('refuses version %s', (_s, v) => {
    expect(versionOk(v)).toBe(false)
  })

  it('the form finds a problem with every invalid document it can hold, and none with a valid one', () => {
    const lists = ['github_orgs', 'github_repos', 'drive_folders', 'drives'] as const
    const asDraft = (b: Record<string, unknown>): BoundariesDraft | null => {
      if (typeof b.topic !== 'string' || typeof b.member_folders !== 'boolean' || lists.some((k) => !Array.isArray(b[k])) || Object.keys(b).length !== 6) return null
      // The form only ever holds entries of the right shape (it builds them itself).
      const str = (o: unknown, ...keys: string[]) => typeof o === 'object' && o !== null && keys.every((k) => typeof (o as Record<string, unknown>)[k] === 'string')
      const d = b as unknown as BoundariesDraft
      if (!d.github_orgs.every((o) => typeof o === 'string') || !d.github_repos.every((r) => str(r, 'org', 'repo'))) return null
      if (!d.drive_folders.every((f) => str(f, 'folder_id')) || !d.drives.every((x) => str(x, 'domain', 'shared_drive'))) return null
      return d
    }
    for (const b of vectors.valid) expect(boundariesProblem(asDraft(b)!)).toBeNull()
    for (const v of vectors.invalid) {
      const d = asDraft(v.boundaries)
      if (d === null) continue
      // The form drops duplicates before sending (as the relay stores them), so a list over its cap
      // only through duplicates is sent within it; anything else is a problem before sending.
      if (boundariesProblem(d) === null) {
        expect(v.why, v.why).toMatch(/with duplicates|^(extra drive field|repo extra field|folder extra field)$/)
        expect(boundariesValid(toBoundaries(d)), v.why).toBe(true)
      }
    }
    for (const b of vectors.valid) expect(boundariesValid(toBoundaries(asDraft(b)!))).toBe(true)
  })
})
