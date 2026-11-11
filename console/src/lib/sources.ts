import type { Boundaries, BoundariesSince, DriveBoundary, FolderBoundary, GithubListing, ItemKey, RepoBoundary, SourcesConfig } from '@/api/types'
import { domainOk, driveItemIdOk, folderNameOk, FOLDERS_MAX, orgOk, pickedDriveNameOk, repoNameOk, toBoundaries } from './boundaries'

// PICKERS-SPEC §2.2, §5.4, §7: the sources an owner picks. Item keys (as the relay and the
// plugin make them, plugin/src/boundaries-rule.ts), their names in words, the github.com and
// drive.google.com addresses an owner may paste instead of picking, and the check on what the
// picker page sends back over its BroadcastChannel. Everything read from outside (a pasted
// address, a channel message, a listing) is data, checked by the one rule before it is used.

// ---------------------------------------------------------------------------------------
// Item keys (§2.2).

export type SourceItem =
  | { kind: 'org'; org: string }
  | ({ kind: 'repo' } & RepoBoundary)
  | ({ kind: 'folder' } & FolderBoundary)
  | ({ kind: 'drive' } & DriveBoundary)

const lowerRepo = (r: { org: string; repo: string }) => `${r.org.toLowerCase()}/${r.repo.toLowerCase()}`

export const orgKey = (org: string): ItemKey => `org:${org.toLowerCase()}`
export const repoKey = (r: { org: string; repo: string }): ItemKey => `repo:${lowerRepo(r)}`
export const folderKey = (f: { folder_id: string }): ItemKey => `folder:${f.folder_id}`
export const driveKey = (d: DriveBoundary): ItemKey => `drive:${d.domain}/${d.shared_drive}`

export function itemKey(item: SourceItem): ItemKey {
  switch (item.kind) {
    case 'org':
      return orgKey(item.org)
    case 'repo':
      return repoKey(item)
    case 'folder':
      return folderKey(item)
    case 'drive':
      return driveKey(item)
  }
}

/** The items of a document as the relay stores it: whole orgs, repositories, folders, legacy drives. */
export function sourceItems(b: Boundaries): SourceItem[] {
  const n = toBoundaries(b)
  return [
    ...n.github_orgs.map((org): SourceItem => ({ kind: 'org', org })),
    ...n.github_repos.map((r): SourceItem => ({ kind: 'repo', ...r })),
    ...n.drive_folders.map((f): SourceItem => ({ kind: 'folder', ...f })),
    ...n.drives.map((d): SourceItem => ({ kind: 'drive', ...d })),
  ]
}

export const itemKeys = (b: Boundaries): ItemKey[] => sourceItems(b).map(itemKey)

const own = (o: Record<string, number> | undefined, k: string) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined)

/** In which version an item was last added; one `since` does not name counts as added in `version`. */
export function itemSince(item: SourceItem, since: BoundariesSince | null | undefined, version: number): number {
  if (!since) return version
  switch (item.kind) {
    case 'org':
      return own(since.github_orgs, item.org.toLowerCase()) ?? version
    case 'repo':
      return own(since.github_repos, lowerRepo(item)) ?? version
    case 'folder':
      return own(since.drive_folders, item.folder_id) ?? version
    case 'drive':
      return since.drives.find((x) => x.domain === item.domain && x.shared_drive === item.shared_drive)?.since ?? version
  }
}

// ---------------------------------------------------------------------------------------
// Names in words.

/** A repository as people write it: example-org/api. */
export const repoName = (r: { org: string; repo: string }) => `${r.org}/${r.repo}`

/** A whole shared drive (the folder is the drive's top folder). */
export const isWholeDrive = (f: FolderBoundary) => f.drive_id !== null && f.folder_id === f.drive_id

/** Where a folder is, in words: "a whole shared drive", "in Example Team Drive" or "in a shared drive". */
export function folderWhere(f: FolderBoundary): string {
  if (isWholeDrive(f)) return 'a whole shared drive'
  return f.drive_name ? `in ${f.drive_name}` : 'in a shared drive'
}

/** A folder's name with where it is: "Clients (in Example Team Drive)", "Example Team Drive (a whole shared drive)". */
export const folderLabel = (f: FolderBoundary) => `${f.folder_name} (${folderWhere(f)})`

/** One item's name in words, for lists of what the team shares and what a Mac cannot find. */
export function itemLabel(item: SourceItem): string {
  switch (item.kind) {
    case 'org':
      return `${item.org} (whole organisation)`
    case 'repo':
      return repoName(item)
    case 'folder':
      return folderLabel(item)
    case 'drive':
      return item.shared_drive
  }
}

/**
 * The current boundaries' items for the given keys, in the order given, each once. A key that is
 * not an item of `b` (removed since the Mac reported) is left out: nothing but the team's own
 * item names is ever shown.
 */
export function itemsForKeys(b: Boundaries | null | undefined, keys: readonly string[]): SourceItem[] {
  if (!b) return []
  const byKey = new Map<string, SourceItem>(sourceItems(b).map((i) => [itemKey(i), i]))
  const out: SourceItem[] = []
  for (const k of keys) {
    const it = byKey.get(k)
    if (it) {
      out.push(it)
      byKey.delete(k)
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------
// Pasted addresses (§7.1, §7.2).

/** github.com paths that are GitHub's own pages, never an organisation. */
const GITHUB_RESERVED = new Set(['orgs', 'apps', 'settings', 'marketplace', 'features', 'topics', 'explore', 'sponsors', 'login', 'join', 'organizations', 'enterprises', 'notifications', 'new', 'search', 'pulls', 'issues'])

export type GithubAddress = { kind: 'org'; org: string } | { kind: 'repo'; org: string; repo: string }

/**
 * A github.com address of an organisation or a repository: https://github.com/<owner> or
 * https://github.com/<owner>/<repo>, with an optional www., .git, trailing /, query or fragment.
 * Null for anything else (another host, more path parts, GitHub's own pages).
 */
export function parseGithubAddress(text: string): GithubAddress | null {
  const t = text.trim()
  if (!/^https:\/\//i.test(t) || /\s/.test(t)) return null
  let u: URL
  try {
    u = new URL(t)
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase()
  if (u.protocol !== 'https:' || (host !== 'github.com' && host !== 'www.github.com') || u.port !== '' || u.username || u.password) return null
  const parts = u.pathname.split('/')
  // "/a/b/" splits to ['', 'a', 'b', '']: one trailing / is allowed, nothing else empty.
  if (parts[0] !== '') return null
  parts.shift()
  if (parts.length > 0 && parts.at(-1) === '') parts.pop()
  if (parts.length < 1 || parts.length > 2 || parts.some((p) => p === '')) return null
  const org = parts[0]!
  if (!orgOk(org) || GITHUB_RESERVED.has(org.toLowerCase())) return null
  if (parts.length === 1) return { kind: 'org', org }
  const repo = parts[1]!.replace(/\.git$/i, '')
  if (!repoNameOk(repo)) return null
  return { kind: 'repo', org, repo }
}

/**
 * The folder id of a link to a Google Drive folder: https://drive.google.com/drive/folders/<id>
 * (also /drive/u/<n>/folders/<id>; a query such as ?usp= or ?resourcekey= is ignored) or
 * https://drive.google.com/open?id=<id>. Null for anything else.
 */
export function parseDriveFolderLink(text: string): string | null {
  const t = text.trim()
  if (!/^https:\/\//i.test(t) || /\s/.test(t)) return null
  let u: URL
  try {
    u = new URL(t)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'drive.google.com' || u.port !== '' || u.username || u.password) return null
  const m = /^\/drive(?:\/u\/[0-9]{1,2})?\/folders\/([^/]+)\/?$/.exec(u.pathname)
  if (m) return driveItemIdOk(m[1]) ? m[1]! : null
  if (u.pathname === '/open') {
    const ids = u.searchParams.getAll('id')
    return ids.length === 1 && driveItemIdOk(ids[0]) ? ids[0]! : null
  }
  return null
}

/** The GitHub listing's repository for `org/repo` (without case), with its installation's spelling of the org. */
export function findListed(listing: GithubListing | undefined, org: string, repo: string): { org: string; repo: string; id: number } | null {
  if (!listing) return null
  const inst = listing.installations.find((i) => i.account.toLowerCase() === org.toLowerCase())
  const r = inst?.repos.find((x) => x.name.toLowerCase() === repo.toLowerCase())
  return inst && r ? { org: inst.account, repo: r.name, id: r.id } : null
}

// ---------------------------------------------------------------------------------------
// The Drive picker page and its channel (§5.4).

/** The BroadcastChannel the picker page posts on, same origin only. */
export const PICK_CHANNEL = 'team-relay-pick'

/** A picked folder as the picker page sends it (the form adds the domain). */
export interface PickedFolder {
  drive_id: string
  folder_id: string
  folder_name: string
  drive_name: string | null
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const exactly = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k))

/**
 * A picker page's message for this form: `{nonce, folders: [{drive_id, folder_id, folder_name,
 * drive_name}]}` with this form's own nonce, 1-20 folders, each passing the folder rule (a picked
 * folder is always in a shared drive, so drive_id is set). Null for anything else (another
 * picker window's, a stale one's, or a bad shape): such a message is ignored.
 */
export function readPickMessage(data: unknown, nonce: string): PickedFolder[] | null {
  if (!isObj(data) || !exactly(data, ['nonce', 'folders']) || typeof data.nonce !== 'string' || data.nonce !== nonce || nonce === '') return null
  const folders = data.folders
  if (!Array.isArray(folders) || folders.length < 1 || folders.length > FOLDERS_MAX) return null
  const out: PickedFolder[] = []
  for (const f of folders) {
    if (!isObj(f) || !exactly(f, ['drive_id', 'folder_id', 'folder_name', 'drive_name'])) return null
    if (!driveItemIdOk(f.drive_id) || !driveItemIdOk(f.folder_id) || !folderNameOk(f.folder_name) || !pickedDriveNameOk(f.drive_name)) return null
    out.push({ drive_id: f.drive_id, folder_id: f.folder_id, folder_name: f.folder_name, drive_name: f.drive_name })
  }
  return out
}

/** 32 random bytes, base64url: ties a picker window to the form that opened it. */
export function newNonce(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The picker page's address for this form: the nonce and the team in the fragment, never sent to a server. */
export function pickerUrl(nonce: string, team: string | null): string {
  const f = new URLSearchParams({ n: nonce })
  if (team) f.set('team', team)
  return `/pick/drive#${f.toString()}`
}

/** The domain of an email address, when it is a domain the rule accepts. */
export function emailDomain(email: string | null | undefined): string | null {
  if (typeof email !== 'string') return null
  const at = email.lastIndexOf('@')
  if (at < 1) return null
  const d = email.slice(at + 1).toLowerCase()
  return domainOk(d) ? d : null
}

/**
 * Picked folders as boundaries entries: `domain` added; a null drive_name filled from another
 * entry of the same shared drive (one already in the list, or picked with it).
 */
export function pickedToFolders(picked: PickedFolder[], domain: string, have: FolderBoundary[]): FolderBoundary[] {
  const names = new Map<string, string>()
  for (const f of [...have, ...picked]) if (f.drive_id && f.drive_name && !names.has(f.drive_id)) names.set(f.drive_id, f.drive_name)
  return picked.map((p) => ({ domain, drive_id: p.drive_id, folder_id: p.folder_id, folder_name: p.folder_name, drive_name: p.drive_name ?? names.get(p.drive_id) ?? null }))
}

// ---------------------------------------------------------------------------------------
// The relay's answers about sources, as read: never trusted to be shaped.

const PICKER_CLIENT_RE = /^[A-Za-z0-9.-]{1,200}\.apps\.googleusercontent\.com$/
const PICKER_KEY_RE = /^AIza[0-9A-Za-z_-]{35}$/
const PICKER_APP_RE = /^[0-9]{6,20}$/
const INSTALL_URL_RE = /^https:\/\/github\.com\/apps\/[a-z0-9][a-z0-9-]{0,99}\/installations\/new$/

/** GET /api/sources/config; null when it is not that answer. An install link that is not GitHub's own is dropped. */
export function readSourcesConfig(raw: unknown): SourcesConfig | null {
  if (!isObj(raw) || !isObj(raw.github) || typeof raw.github.configured !== 'boolean') return null
  const url = raw.github.install_url
  const github = { configured: raw.github.configured, install_url: typeof url === 'string' && INSTALL_URL_RE.test(url) ? url : null }
  const p = raw.google_picker
  const google_picker =
    isObj(p) && typeof p.client_id === 'string' && PICKER_CLIENT_RE.test(p.client_id) && typeof p.api_key === 'string' && PICKER_KEY_RE.test(p.api_key) && typeof p.app_id === 'string' && PICKER_APP_RE.test(p.app_id)
      ? { client_id: p.client_id, api_key: p.api_key, app_id: p.app_id }
      : null
  return { github, google_picker }
}

/** GET /api/sources/github, kept to installations and repositories the rule accepts; null when it is not that answer. */
export function readGithubListing(raw: unknown): GithubListing | null {
  if (!isObj(raw) || !Array.isArray(raw.installations)) return null
  const installations: GithubListing['installations'] = []
  for (const i of raw.installations.slice(0, 100)) {
    if (!isObj(i) || !orgOk(i.account) || (i.state !== 'ok' && i.state !== 'suspended') || !Array.isArray(i.repos)) continue
    const repos = []
    for (const r of i.repos.slice(0, 1000)) {
      if (!isObj(r) || !repoNameOk(r.name) || typeof r.id !== 'number' || !Number.isSafeInteger(r.id) || r.id < 1) continue
      repos.push({ name: r.name, id: r.id, private: r.private === true, archived: r.archived === true })
    }
    installations.push({
      account: i.account,
      state: i.state,
      repository_selection: i.repository_selection === 'selected' ? 'selected' : 'all',
      repos: i.state === 'ok' ? repos : [],
      truncated: i.truncated === true,
    })
  }
  return { installations, fetched_at: typeof raw.fetched_at === 'string' ? raw.fetched_at : '' }
}
