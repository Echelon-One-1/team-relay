// PICKERS-SPEC §3.3, §8 (ACC-013): missingSources reports exactly the keys of the team's items
// this Mac cannot find, and nothing else. A synthetic machine (boundary-fixture.ts); the Drive
// attribute reader is a fake keyed by path, so no real Drive mount is touched.

import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { sourcesOk } from '../src/boundaries-rule.js';
import type { Boundaries } from '../src/boundaries-types.js';
import { DriveLocator, type ItemIdReader } from '../src/drive-locate.js';
import { missingSources } from '../src/sources-report.js';
import { DOMAIN, ORG, REPO_ROOT, SHARED_DRIVE, makeFixture, type Fixture } from './helpers/boundary-fixture.js';

const DRIVE_ID = '0AExampleDriveId0PVA';
const CLIENTS_ID = '1ExampleFolderClients0000000000a';
const GONE_ID = '1ExampleFolderGone00000000000000';

let f: Fixture;
let reader: ItemIdReader;
beforeAll(() => {
  f = makeFixture();
  const ids = new Map([
    [f.driveRoot, DRIVE_ID],
    [join(f.driveRoot, 'Clients'), CLIENTS_ID],
  ]);
  reader = async (p) => ids.get(p) ?? null;
});

const folder = (folder_id: string, folder_name: string) => ({ domain: DOMAIN, drive_id: DRIVE_ID, folder_id, folder_name, drive_name: SHARED_DRIVE });

describe('missingSources (ACC-013)', () => {
  it('reports exactly the items not found, as keys, in item order', async () => {
    const b: Boundaries = {
      topic: 'T',
      github_orgs: [ORG, 'Nobody-Org'],
      github_repos: [
        { org: 'OtherOrg', repo: 'Other', id: 1 },
        { org: 'acme', repo: 'api', id: null },
      ],
      drive_folders: [folder(CLIENTS_ID, 'Clients'), folder(GONE_ID, 'Gone'), folder(DRIVE_ID, SHARED_DRIVE)],
      drives: [
        { domain: DOMAIN, shared_drive: SHARED_DRIVE },
        { domain: DOMAIN, shared_drive: 'Gone Drive' },
        { domain: 'example.net', shared_drive: 'Other Drive' },
      ],
      member_folders: false,
    };
    const missing = await missingSources(b, { repo_roots: [REPO_ROOT] }, f.env, { locator: new DriveLocator({ home: f.home, readId: reader }) });
    expect(missing).toEqual(['org:nobody-org', 'repo:acme/api', `folder:${GONE_ID}`, `drive:${DOMAIN}/Gone Drive`, 'drive:example.net/Other Drive']);
    expect(sourcesOk({ boundaries_version: 3, missing })).toBe(true);
    for (const k of missing) expect(k).not.toContain(f.root);
  });

  it('with no usable repo root every GitHub item is missing; with nothing listed nothing is', async () => {
    const b: Boundaries = { topic: 'T', github_orgs: [ORG], github_repos: [{ org: 'OtherOrg', repo: 'other', id: null }], drive_folders: [], drives: [], member_folders: false };
    expect(await missingSources(b, { repo_roots: [] }, f.env)).toEqual([`org:${ORG}`, 'repo:otherorg/other']);
    expect(await missingSources(b, { repo_roots: ['relative/path'] }, f.env)).toEqual([`org:${ORG}`, 'repo:otherorg/other']);
    expect(await missingSources({ ...b, github_orgs: [], github_repos: [] }, { repo_roots: [REPO_ROOT] }, f.env)).toEqual([]);
  });

  it('a repository of a whole org is the whole org (as the relay stores it): one key', async () => {
    const b: Boundaries = { topic: 'T', github_orgs: ['Nobody-Org'], github_repos: [{ org: 'nobody-org', repo: 'x', id: null }], drive_folders: [], drives: [], member_folders: false };
    expect(await missingSources(b, { repo_roots: [REPO_ROOT] }, f.env)).toEqual(['org:nobody-org']);
  });
});
