// PICKERS-SPEC §6.2 (ACC-011, ACC-012): finding picked shared-drive folders by their Drive for
// desktop attribute. A synthetic CloudStorage tree in a temporary home; the attribute reader is
// a fake keyed by path, so no real Drive mount and no xattr is ever touched. Ids and names are
// synthetic.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FolderBoundary } from '../src/boundaries-types.js';
import { DriveLocator, driveMounts, mountsSignature, type ItemIdReader } from '../src/drive-locate.js';

const DOMAIN = 'example.com';
const DRIVE_ID = '0AExampleDriveId0PVA';
const OTHER_DRIVE_ID = '0AOtherDriveId00PVAx';
const CLIENTS_ID = '1ExampleFolderClients0000000000a';
const LOOKALIKE_ID = '1ExampleFolderLookalike00000000b';
const RENAMED_ID = '1ExampleFolderRenamed0000000000c';
const DEEP_ID = '1ExampleFolderDeep000000000000d';
const LINKED_ID = '1ExampleFolderLinked0000000000ee';

let root: string;
let home: string;
let shared: string;
let team: string;
let ids: Map<string, string>;
let reads: string[];

const mk = (p: string, id?: string) => {
  mkdirSync(p, { recursive: true });
  if (id) ids.set(p, id);
  return p;
};
const reader: ItemIdReader = async (p) => {
  reads.push(p);
  return ids.get(p) ?? null;
};
const folder = (folder_id: string, folder_name: string, drive_id: string | null = DRIVE_ID): FolderBoundary => ({ domain: DOMAIN, drive_id, folder_id, folder_name, drive_name: 'Team Drive' });

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'tr-locate-')));
  home = join(root, 'home');
  ids = new Map();
  reads = [];
  const cloud = join(home, 'Library', 'CloudStorage');
  shared = join(cloud, `GoogleDrive-alice@${DOMAIN}`, 'Shared drives');
  team = mk(join(shared, 'Team Drive'), DRIVE_ID);
  mk(join(shared, 'Other Drive'), OTHER_DRIVE_ID);
  mk(join(team, 'Projects', 'Clients'), CLIENTS_ID);
  // The same name with another id comes first in a breadth-first walk.
  mk(join(team, 'Clients'), LOOKALIKE_ID);
  mk(join(team, 'z', 'y', 'Now Named Otherwise'), RENAMED_ID);
  // Nine levels down: deeper than the walk goes.
  mk(join(team, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'Deep'), DEEP_ID);
  // A symlink inside the drive to a folder outside, with an id: never followed.
  const outside = mk(join(root, 'outside', 'Linked'), LINKED_ID);
  symlinkSync(outside, join(team, 'Linked'));
  ids.set(join(team, 'Linked'), LINKED_ID);
  // The same ids in places that never count: My Drive, another domain's mount, a lookalike domain.
  mk(join(cloud, `GoogleDrive-alice@${DOMAIN}`, 'My Drive', 'Clients'), CLIENTS_ID);
  mk(join(cloud, 'GoogleDrive-alice@example.net', 'Shared drives', 'Team Drive'), DRIVE_ID);
  mk(join(cloud, 'GoogleDrive-alice@example.net', 'Shared drives', 'Team Drive', 'Clients'), CLIENTS_ID);
  mk(join(cloud, `GoogleDrive-alice@${DOMAIN}.evil.example`, 'Shared drives', 'Team Drive'), DRIVE_ID);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('finding a picked folder (ACC-011)', () => {
  it('a whole shared drive is its root, found by id', async () => {
    const l = new DriveLocator({ home, readId: reader });
    const found = await l.locate([folder(DRIVE_ID, 'Team Drive')]);
    expect(found.get(DRIVE_ID)).toEqual({ folder_id: DRIVE_ID, domain: DOMAIN, account: `alice@${DOMAIN}`, shared, drive_root: team, drive_root_id: DRIVE_ID, path: team });
  });

  it('a subfolder is found by its name and id; one with the same name and another id is not it', async () => {
    const l = new DriveLocator({ home, readId: reader });
    const found = await l.locate([folder(CLIENTS_ID, 'Clients')]);
    expect(found.get(CLIENTS_ID)?.path).toBe(join(team, 'Projects', 'Clients'));
    expect(found.get(CLIENTS_ID)?.drive_root_id).toBe(DRIVE_ID);
    expect(reads).toContain(join(team, 'Clients'));
  });

  it('a folder whose name is NFC-equal is found; another case is not a name match', async () => {
    mk(join(team, 'Café'), RENAMED_ID.replace('c', 'C'));
    const l = new DriveLocator({ home, readId: reader });
    expect((await l.locate([folder(RENAMED_ID.replace('c', 'C'), 'Café')])).size).toBe(1);
    reads = [];
    const other = new DriveLocator({ home, readId: reader, limits: { blindReads: 0 } });
    expect((await other.locate([folder(RENAMED_ID.replace('c', 'C'), 'CAFÉ')])).size).toBe(0);
  });

  it('a renamed folder is found by the blind scan, within its read budget', async () => {
    const l = new DriveLocator({ home, readId: reader });
    expect((await l.locate([folder(RENAMED_ID, 'Old Name')])).get(RENAMED_ID)?.path).toBe(join(team, 'z', 'y', 'Now Named Otherwise'));
    const tight = new DriveLocator({ home, readId: reader, limits: { blindReads: 2 } });
    reads = [];
    expect((await tight.locate([folder(RENAMED_ID, 'Old Name')])).size).toBe(0);
    // The roots (2) and at most the 2 blind reads.
    expect(reads.length).toBeLessThanOrEqual(4);
  });

  it('the blind scan stops at its time budget', async () => {
    let t = 0;
    const slow: ItemIdReader = async (p) => {
      t += 6000;
      return reader(p);
    };
    const l = new DriveLocator({ home, readId: slow, now: () => t });
    expect((await l.locate([folder(RENAMED_ID, 'Old Name')])).size).toBe(0);
  });

  it('without a drive id (a pasted link) the folder is looked for by name under every root, never blindly', async () => {
    const l = new DriveLocator({ home, readId: reader });
    expect((await l.locate([folder(CLIENTS_ID, 'Clients', null)])).get(CLIENTS_ID)?.drive_root_id).toBe(DRIVE_ID);
    expect((await l.locate([folder(DRIVE_ID, 'Team Drive', null)])).get(DRIVE_ID)?.path).toBe(team);
    expect((await new DriveLocator({ home, readId: reader }).locate([folder(RENAMED_ID, 'Old Name', null)])).size).toBe(0);
  });

  it('a drive id that no mounted root has is missing, without walking anything', async () => {
    const l = new DriveLocator({ home, readId: reader });
    expect((await l.locate([folder(CLIENTS_ID, 'Clients', '0AMissingDriveId0PVA')])).size).toBe(0);
    expect(reads.every((p) => p.split('/').length === shared.split('/').length + 1)).toBe(true);
  });

  it('never follows a symlink, never goes too deep, never uses My Drive or another domain', async () => {
    const l = new DriveLocator({ home, readId: reader });
    const found = await l.locate([folder(LINKED_ID, 'Linked'), folder(DEEP_ID, 'Deep')]);
    expect(found.size).toBe(0);
    expect(reads).not.toContain(join(team, 'Linked'));
    expect(reads).not.toContain(join(team, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'Deep'));
    for (const p of reads) {
      expect(p.startsWith(`${shared}/`), p).toBe(true);
    }
    expect(await driveMounts(home, DOMAIN)).toEqual([{ account: `alice@${DOMAIN}`, shared }]);
  });

  it('a Shared drives folder that is a symlink is no mount', async () => {
    const cloud = join(home, 'Library', 'CloudStorage');
    const real = mk(join(root, 'elsewhere', 'Shared drives', 'Team Drive'), DRIVE_ID);
    mkdirSync(join(cloud, 'GoogleDrive-bob@example.com'), { recursive: true });
    symlinkSync(join(real, '..'), join(cloud, 'GoogleDrive-bob@example.com', 'Shared drives'));
    expect((await driveMounts(home, DOMAIN)).map((m) => m.account)).toEqual([`alice@${DOMAIN}`]);
  });

  it('the name-hint walk stops at its listing cap', async () => {
    const l = new DriveLocator({ home, readId: reader, limits: { hintDirs: 1, blindReads: 0 } });
    expect((await l.locate([folder(CLIENTS_ID, 'Clients')])).size).toBe(0);
  });

  it('no Drive for desktop at all: nothing found, nothing read', async () => {
    const l = new DriveLocator({ home: join(root, 'nobody'), readId: reader });
    expect((await l.locate([folder(DRIVE_ID, 'Team Drive')])).size).toBe(0);
    expect(reads).toEqual([]);
  });
});

describe('the cache (ACC-012)', () => {
  it('a cached path is used at once within 60 s, and checked again after', async () => {
    let t = 0;
    const l = new DriveLocator({ home, readId: reader, now: () => t });
    await l.locate([folder(CLIENTS_ID, 'Clients')]);
    reads = [];
    expect((await l.locate([folder(CLIENTS_ID, 'Clients')])).size).toBe(1);
    expect(reads).toEqual([]);
    t = 61_000;
    expect((await l.locate([folder(CLIENTS_ID, 'Clients')])).size).toBe(1);
    expect(reads).toContain(join(team, 'Projects', 'Clients'));
    expect(reads).not.toContain(join(team, 'Clients'));
  });

  it('force checks the cached path again at once', async () => {
    const l = new DriveLocator({ home, readId: reader, now: () => 0 });
    await l.locate([folder(CLIENTS_ID, 'Clients')]);
    reads = [];
    await l.locate([folder(CLIENTS_ID, 'Clients')], { force: true });
    expect(reads).toContain(join(team, 'Projects', 'Clients'));
  });

  it('a moved folder is found again', async () => {
    const l = new DriveLocator({ home, readId: reader, now: () => 0 });
    await l.locate([folder(CLIENTS_ID, 'Clients')]);
    const moved = join(team, 'Archive', 'Clients');
    mkdirSync(join(team, 'Archive'));
    renameSync(join(team, 'Projects', 'Clients'), moved);
    ids.delete(join(team, 'Projects', 'Clients'));
    ids.set(moved, CLIENTS_ID);
    expect((await l.locate([folder(CLIENTS_ID, 'Clients')], { force: true })).get(CLIENTS_ID)?.path).toBe(moved);
  });

  it('a changed id makes it search again (and not find it)', async () => {
    const l = new DriveLocator({ home, readId: reader, now: () => 0 });
    await l.locate([folder(CLIENTS_ID, 'Clients')]);
    ids.set(join(team, 'Projects', 'Clients'), '1SomethingElse000000000000000000');
    expect((await l.locate([folder(CLIENTS_ID, 'Clients')], { force: true })).size).toBe(0);
  });

  it('a cached path swapped for a symlink is not used', async () => {
    const l = new DriveLocator({ home, readId: reader, now: () => 0 });
    await l.locate([folder(CLIENTS_ID, 'Clients')]);
    const p = join(team, 'Projects', 'Clients');
    rmSync(p, { recursive: true });
    const out = mk(join(root, 'outside', 'Clients'), CLIENTS_ID);
    symlinkSync(out, p);
    ids.set(p, CLIENTS_ID);
    expect((await l.locate([folder(CLIENTS_ID, 'Clients')], { force: true })).size).toBe(0);
  });

  it('a folder not found waits 10 minutes, unless the entries or the mounts change', async () => {
    let t = 0;
    const l = new DriveLocator({ home, readId: reader, now: () => t });
    const entry = folder('1NotThereYet00000000000000000000', 'Later');
    expect((await l.locate([entry])).size).toBe(0);
    const p = mk(join(team, 'Later'), entry.folder_id);
    reads = [];
    t = 5 * 60_000;
    expect((await l.locate([entry])).size).toBe(0);
    expect(reads).toEqual([]);
    t = 11 * 60_000;
    expect((await l.locate([entry])).get(entry.folder_id)?.path).toBe(p);

    // Mounts change: a new shared drive root appears.
    const l2 = new DriveLocator({ home, readId: reader, now: () => 0 });
    const e2 = folder('1NotThereYet00000000000000000001', 'Later 2', null);
    expect((await l2.locate([e2])).size).toBe(0);
    const before = await mountsSignature(home);
    mk(join(shared, 'New Drive', 'Later 2'), e2.folder_id);
    ids.set(join(shared, 'New Drive'), '0ANewDriveId0000PVAx');
    expect(await mountsSignature(home)).not.toBe(before);
    expect((await l2.locate([e2])).get(e2.folder_id)?.drive_root_id).toBe('0ANewDriveId0000PVAx');

    // The entries change: looked for again at once.
    const l3 = new DriveLocator({ home, readId: reader, now: () => 0 });
    const e3 = folder('1NotThereYet00000000000000000002', 'Later 3');
    expect((await l3.locate([e3])).size).toBe(0);
    mk(join(team, 'Later 3'), e3.folder_id);
    expect((await l3.locate([e3])).size).toBe(0);
    expect((await l3.locate([e3, folder(DRIVE_ID, 'Team Drive')])).size).toBe(2);
  });
});
