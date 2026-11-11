// PICKERS-SPEC §2.2, §5.4, §7.1-§7.2: item keys (the shared vectors), names in words, the
// addresses an owner may paste, the picker page's channel message, and reading the relay's
// sources answers without trusting their shape.

import { describe, expect, it } from 'vitest'

import type { Boundaries, FolderBoundary } from '@/api/types'
import { vectors } from '@/test/vectors'
import { boundariesValid } from './boundaries'
import {
  emailDomain,
  findListed,
  folderLabel,
  folderWhere,
  itemKey,
  itemKeys,
  itemLabel,
  itemsForKeys,
  newNonce,
  parseDriveFolderLink,
  parseGithubAddress,
  pickedToFolders,
  pickerUrl,
  readGithubListing,
  readPickMessage,
  readSourcesConfig,
  type SourceItem,
} from './sources'

const DRIVE = '0AExampleDriveId0PVA'
const FOLDER = '1ExampleFolderClients0000000000a'

describe('item keys (schema/boundaries-vectors.json keys, item_keys)', () => {
  it.each(vectors.keys.map((k) => [k.key, k] as const))('%s', (_key, k) => {
    expect(itemKey({ kind: k.kind, ...k.item } as SourceItem)).toBe(k.key)
  })

  it.each(vectors.item_keys.map((c, i) => [i, c] as const))('the keys of document %i, in order, each once', (_i, c) => {
    expect(itemKeys(c.boundaries as unknown as Boundaries)).toEqual(c.keys)
  })

  it('names for keys: only items of the current boundaries, in the order given, each once', () => {
    for (const c of vectors.sources.kept) {
      const b = c.boundaries as unknown as Boundaries
      expect(itemsForKeys(b, c.missing).map(itemKey)).toEqual(c.kept)
    }
    expect(itemsForKeys(null, ['org:x'])).toEqual([])
  })
})

describe('names in words', () => {
  const folder = (o: Partial<FolderBoundary>): FolderBoundary => ({ domain: 'example.com', drive_id: DRIVE, folder_id: FOLDER, folder_name: 'Clients', drive_name: 'Example Team Drive', ...o })

  it('says where a folder is', () => {
    expect(folderWhere(folder({}))).toBe('in Example Team Drive')
    expect(folderWhere(folder({ drive_name: null }))).toBe('in a shared drive')
    expect(folderWhere(folder({ folder_id: DRIVE }))).toBe('a whole shared drive')
    expect(folderWhere(folder({ drive_id: null, drive_name: null }))).toBe('in a shared drive')
    expect(folderLabel(folder({}))).toBe('Clients (in Example Team Drive)')
  })

  it('names each kind of item', () => {
    expect(itemLabel({ kind: 'org', org: 'example-org' })).toBe('example-org (whole organisation)')
    expect(itemLabel({ kind: 'repo', org: 'example-org', repo: 'api', id: 1 })).toBe('example-org/api')
    expect(itemLabel({ kind: 'folder', ...folder({}) })).toBe('Clients (in Example Team Drive)')
    expect(itemLabel({ kind: 'drive', domain: 'example.com', shared_drive: 'Old Drive' })).toBe('Old Drive')
  })
})

describe('a pasted github.com address (ACC-018)', () => {
  it.each([
    ['https://github.com/example-org', { kind: 'org', org: 'example-org' }],
    ['https://github.com/example-org/', { kind: 'org', org: 'example-org' }],
    ['https://www.github.com/Example-Org', { kind: 'org', org: 'Example-Org' }],
    ['https://github.com/example-org/api', { kind: 'repo', org: 'example-org', repo: 'api' }],
    ['https://github.com/example-org/api.git', { kind: 'repo', org: 'example-org', repo: 'api' }],
    ['https://github.com/example-org/api/', { kind: 'repo', org: 'example-org', repo: 'api' }],
    ['  https://github.com/example-org/api.git?tab=readme#top  ', { kind: 'repo', org: 'example-org', repo: 'api' }],
    ['https://github.com/example-org/Repo.Name_with-chars', { kind: 'repo', org: 'example-org', repo: 'Repo.Name_with-chars' }],
    ['HTTPS://GITHUB.COM/example-org/api', { kind: 'repo', org: 'example-org', repo: 'api' }],
  ])('reads %s', (text, want) => {
    expect(parseGithubAddress(text)).toEqual(want)
  })

  it.each([
    'example-org',
    'github.com/example-org',
    'http://github.com/example-org',
    'https://gitlab.com/example-org/api',
    'https://github.example.com/example-org',
    'https://evilgithub.com/example-org',
    'https://github.com.example.com/example-org',
    'https://github.com/orgs/example-org',
    'https://github.com/orgs/example-org/repositories',
    'https://github.com/example-org/api/tree/main',
    'https://github.com/example-org/api/issues',
    'https://github.com/',
    'https://github.com',
    'https://github.com//api',
    'https://github.com/-bad/api',
    'https://github.com/example-org/..',
    'https://github.com/example-org/.git',
    'https://github.com/example-org/a%20b',
    'https://user:pass@github.com/example-org',
    'https://github.com:8443/example-org',
    'https://github.com/example org',
    '',
  ])('refuses %s', (text) => {
    expect(parseGithubAddress(text)).toBeNull()
  })

  it('finds a pasted repository in the listing without case, with its id', () => {
    const listing = readGithubListing({
      installations: [{ account: 'Example-Org', state: 'ok', repository_selection: 'all', repos: [{ name: 'API', id: 5, private: true, archived: false }], truncated: false }],
      fetched_at: 'x',
    })!
    expect(findListed(listing, 'example-org', 'api')).toEqual({ org: 'Example-Org', repo: 'API', id: 5 })
    expect(findListed(listing, 'example-org', 'web')).toBeNull()
    expect(findListed(undefined, 'example-org', 'api')).toBeNull()
  })
})

describe('a pasted Drive folder link (ACC-019)', () => {
  it.each([
    [`https://drive.google.com/drive/folders/${FOLDER}`, FOLDER],
    [`https://drive.google.com/drive/folders/${FOLDER}/`, FOLDER],
    [`https://drive.google.com/drive/u/0/folders/${FOLDER}`, FOLDER],
    [`https://drive.google.com/drive/u/12/folders/${FOLDER}?usp=sharing`, FOLDER],
    [`https://drive.google.com/drive/folders/${FOLDER}?resourcekey=0-abc&usp=drive_link`, FOLDER],
    [`https://drive.google.com/open?id=${FOLDER}`, FOLDER],
    [`  https://drive.google.com/drive/folders/${DRIVE}  `, DRIVE],
  ])('reads %s', (text, id) => {
    expect(parseDriveFolderLink(text)).toBe(id)
  })

  it.each([
    FOLDER,
    `http://drive.google.com/drive/folders/${FOLDER}`,
    `https://docs.google.com/drive/folders/${FOLDER}`,
    `https://drive.google.com.example.com/drive/folders/${FOLDER}`,
    `https://drive.google.com/file/d/${FOLDER}/view`,
    `https://drive.google.com/drive/folders/short`,
    `https://drive.google.com/drive/folders/${FOLDER}/extra`,
    `https://drive.google.com/drive/folders/a.b.c.d.e.f.g`,
    `https://drive.google.com/open?id=${FOLDER}&id=${DRIVE}`,
    `https://drive.google.com/open`,
    `https://drive.google.com/drive/my-drive`,
    '',
  ])('refuses %s', (text) => {
    expect(parseDriveFolderLink(text)).toBeNull()
  })
})

describe("the picker page's channel message (ACC-019)", () => {
  const nonce = 'n'.repeat(43)
  const folder = { drive_id: DRIVE, folder_id: FOLDER, folder_name: 'Clients', drive_name: null }

  it('takes a message with this form’s nonce and a good shape', () => {
    expect(readPickMessage({ nonce, folders: [folder] }, nonce)).toEqual([folder])
    expect(readPickMessage({ nonce, folders: [{ ...folder, folder_id: DRIVE, drive_name: 'Example Team Drive' }] }, nonce)).toHaveLength(1)
  })

  it.each([
    ['another nonce', { nonce: 'm'.repeat(43), folders: [folder] }],
    ['no nonce', { folders: [folder] }],
    ['a nonce that is not a string', { nonce: 1, folders: [folder] }],
    ['an extra field', { nonce, folders: [folder], token: 'x' }],
    ['no folders', { nonce, folders: [] }],
    ['21 folders', { nonce, folders: Array.from({ length: 21 }, () => folder) }],
    ['folders not a list', { nonce, folders: folder }],
    ['a folder with a domain', { nonce, folders: [{ ...folder, domain: 'example.com' }] }],
    ['a folder with no drive id (My Drive)', { nonce, folders: [{ ...folder, drive_id: null }] }],
    ['a bad folder id', { nonce, folders: [{ ...folder, folder_id: '../x' }] }],
    ['a name with a control character', { nonce, folders: [{ ...folder, folder_name: 'a\u0000b' }] }],
    ['a name with a bidi override', { nonce, folders: [{ ...folder, folder_name: 'a\u202eb' }] }],
    ['an empty name', { nonce, folders: [{ ...folder, folder_name: '' }] }],
    ['a drive name over 100', { nonce, folders: [{ ...folder, drive_name: 'd'.repeat(101) }] }],
    ['a string', 'hello'],
    ['null', null],
  ])('ignores %s', (_why, data) => {
    expect(readPickMessage(data, nonce)).toBeNull()
  })

  it('never takes a message when the form has no nonce', () => {
    expect(readPickMessage({ nonce: '', folders: [folder] }, '')).toBeNull()
  })

  it('adds the domain and fills a missing drive name from another entry of the same drive', () => {
    const have: FolderBoundary[] = [{ domain: 'example.com', drive_id: DRIVE, folder_id: DRIVE, folder_name: 'Example Team Drive', drive_name: 'Example Team Drive' }]
    const out = pickedToFolders([folder, { drive_id: '0AOtherDriveId000PVA', folder_id: '1OtherFolder00000000', folder_name: 'Other', drive_name: null }], 'example.com', have)
    expect(out).toEqual([
      { domain: 'example.com', drive_id: DRIVE, folder_id: FOLDER, folder_name: 'Clients', drive_name: 'Example Team Drive' },
      { domain: 'example.com', drive_id: '0AOtherDriveId000PVA', folder_id: '1OtherFolder00000000', folder_name: 'Other', drive_name: null },
    ])
    for (const f of out) expect(boundariesValid({ topic: 't', github_orgs: [], github_repos: [], drive_folders: [f], drives: [], member_folders: false })).toBe(true)
    // A drive picked together with its folder names it.
    expect(pickedToFolders([folder, { ...folder, folder_id: DRIVE, folder_name: 'Team', drive_name: 'Team' }], 'example.com', [])[0]!.drive_name).toBe('Team')
  })

  it('the nonce is 32 random bytes in base64url; the page address carries it and the team in the fragment', () => {
    const a = newNonce()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newNonce()).not.toBe(a)
    expect(pickerUrl(a, 'demo')).toBe(`/pick/drive#n=${a}&team=demo`)
    expect(pickerUrl(a, null)).toBe(`/pick/drive#n=${a}`)
  })

  it('takes the domain of an email address only when the rule accepts it', () => {
    expect(emailDomain('alice@Example.com')).toBe('example.com')
    expect(emailDomain('alice@localhost')).toBeNull()
    expect(emailDomain('nobody')).toBeNull()
    expect(emailDomain(undefined)).toBeNull()
  })
})

describe("the relay's answers, as read", () => {
  it('sources/config keeps only the public picker settings that look right', () => {
    const picker = { client_id: '123-abc.apps.googleusercontent.com', api_key: `AIza${'x'.repeat(35)}`, app_id: '123456789012' }
    const install = 'https://github.com/apps/example-relay-sources/installations/new'
    expect(readSourcesConfig({ github: { configured: true, install_url: install }, google_picker: picker })).toEqual({ github: { configured: true, install_url: install }, google_picker: picker })
    expect(readSourcesConfig({ github: { configured: true, install_url: 'https://example.com/x' }, google_picker: { ...picker, api_key: 'nope' } })).toEqual({
      github: { configured: true, install_url: null },
      google_picker: null,
    })
    expect(readSourcesConfig({ github: { configured: 'yes' } })).toBeNull()
    expect(readSourcesConfig(null)).toBeNull()
  })

  it('sources/github keeps installations and repositories the rule accepts, nothing else', () => {
    const l = readGithubListing({
      installations: [
        {
          account: 'example-org',
          state: 'ok',
          repository_selection: 'selected',
          repos: [
            { name: 'api', id: 1, private: true, archived: false, extra: 'ignored' },
            { name: '../etc', id: 2 },
            { name: 'web', id: -1 },
            { name: 'docs', id: 3, private: 'yes' },
          ],
          truncated: true,
        },
        { account: '-bad', state: 'ok', repos: [] },
        { account: 'paused-org', state: 'suspended', repos: [{ name: 'x', id: 9 }] },
        { account: 'odd-org', state: 'weird', repos: [] },
      ],
      fetched_at: '2026-11-11T10:00:00.000Z',
    })
    expect(l).toEqual({
      installations: [
        {
          account: 'example-org',
          state: 'ok',
          repository_selection: 'selected',
          repos: [
            { name: 'api', id: 1, private: true, archived: false },
            { name: 'docs', id: 3, private: false, archived: false },
          ],
          truncated: true,
        },
        { account: 'paused-org', state: 'suspended', repository_selection: 'all', repos: [], truncated: false },
      ],
      fetched_at: '2026-11-11T10:00:00.000Z',
    })
    expect(readGithubListing({ installations: 'x' })).toBeNull()
  })
})
