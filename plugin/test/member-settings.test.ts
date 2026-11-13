// The member's settings file (13 Nov 2026, local folders only): per team, one `folders` list of
// at most 20. An earlier plugin's `repo_roots` and `extra_folders` are read into it (in that
// order, duplicates dropped, the first 20 kept, the rest dropped and said), `accepted` ignored;
// writing keeps `folders` alone. The accepted version is the relay's (hasAccepted), and the
// folders tool lists, adds and removes, each change in a dialog the member answers.

import { beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Elicit } from '../src/approvals-review.js';
import type { TeamBoundaries } from '../src/boundaries-types.js';
import { FOLDERS_TOOL, foldersTool } from '../src/folders-tool.js';
import {
  MAX_FOLDERS,
  MemberFoldersError,
  changeMemberFolders,
  droppedSentence,
  hasAccepted,
  memberFolderProblem,
  memberFoldersPath,
  parseMemberSettings,
  parseTeamSettings,
  readMemberSettings,
  readTeamSettings,
  teamSettings,
  withTeam,
  writeMemberSettings,
} from '../src/member-folders.js';
import { BOUNDARIES, FOLDERS, MY_FOLDER, REPO_ROOT, TEAM, makeFixture, writeFolders, type Fixture } from './helpers/boundary-fixture.js';

let f: Fixture;
/** 25 distinct folders that exist: ~/many/f00 .. ~/many/f24. */
let MANY: string[];
beforeAll(() => {
  f = makeFixture();
  MANY = Array.from({ length: 25 }, (_, i) => `~/many/f${String(i).padStart(2, '0')}`);
  for (const m of MANY) mkdirSync(join(f.home, m.slice(2)), { recursive: true });
});

describe('the folder rules', () => {
  it('paths follow the folder rules: absolute or ~/, not /, home, above it, directly in it, or under ~/Library or ~/.*', () => {
    const env = f.env;
    mkdirSync(join(f.home, '.config', 'x'), { recursive: true });
    mkdirSync(join(f.home, 'Library', 'Mail'), { recursive: true });
    mkdirSync(join(f.home, 'Library', 'CloudStorage'), { recursive: true });
    expect(memberFolderProblem(REPO_ROOT, env)).toEqual({ path: f.repoRoot, reason: null });
    expect(memberFolderProblem(f.repoRoot, env).reason).toBeNull();
    const cases: Array<[string, RegExp]> = [
      ['code/example-org', /not an absolute path/],
      ['/', /root directory/],
      ['~', /your home directory/],
      [f.root, /contains your home directory/],
      ['~/code', /directly in your home directory/],
      ['~/Library/Mail', /inside ~\/Library/],
      ['~/Library/CloudStorage', /inside ~\/Library/],
      ['~/.config/x', /inside|configuration/],
      ['~/code/missing', /does not exist/],
      ['~/code/example-org\u0000', /control characters/],
    ];
    for (const [raw, why] of cases) expect(memberFolderProblem(raw, env).reason, raw).toMatch(why);
  });
});

describe('one team\'s settings: one folders list, an earlier plugin\'s lists read into it', () => {
  it('folders alone', () => {
    expect(parseTeamSettings({ folders: FOLDERS }, f.env)).toEqual({ folders: FOLDERS, dropped: [] });
    expect(parseTeamSettings({}, f.env)).toEqual({ folders: [], dropped: [] });
  });

  it('both earlier lists: repo_roots first, then extra_folders', () => {
    expect(parseTeamSettings({ repo_roots: [REPO_ROOT], extra_folders: [MY_FOLDER] }, f.env)).toEqual({ folders: [REPO_ROOT, MY_FOLDER], dropped: [] });
    expect(parseTeamSettings({ extra_folders: [MY_FOLDER], repo_roots: [REPO_ROOT] }, f.env)).toEqual({ folders: [REPO_ROOT, MY_FOLDER], dropped: [] });
  });

  it('duplicates are dropped, the same string or the same path once expanded (first kept as written)', () => {
    const v = parseTeamSettings({ repo_roots: [REPO_ROOT, REPO_ROOT], extra_folders: [f.repoRoot, `${f.home}/notes/team`, MY_FOLDER] }, f.env);
    expect(v).toEqual({ folders: [REPO_ROOT, `${f.home}/notes/team`], dropped: [] });
  });

  it('more than 20 together: the first 20 kept, the rest dropped in order', () => {
    const v = parseTeamSettings({ repo_roots: MANY.slice(0, 15), extra_folders: [...MANY.slice(15), MANY[3]!] }, f.env);
    expect(v.folders).toEqual(MANY.slice(0, MAX_FOLDERS));
    expect(v.dropped).toEqual(MANY.slice(MAX_FOLDERS));
    // A duplicate of a dropped one is not dropped twice.
    expect(parseTeamSettings({ repo_roots: MANY.slice(0, 20), extra_folders: [MANY[20]!, MANY[20]!] }, f.env).dropped).toEqual([MANY[20]]);
  });

  it('folders and the earlier keys together: folders first, then repo_roots, then extra_folders', () => {
    const v = parseTeamSettings({ folders: [MY_FOLDER], repo_roots: [REPO_ROOT, MY_FOLDER], extra_folders: MANY.slice(0, 20) }, f.env);
    expect(v.folders).toEqual([MY_FOLDER, REPO_ROOT, ...MANY.slice(0, 18)]);
    expect(v.dropped).toEqual(MANY.slice(18, 20));
  });

  it('`accepted` (an earlier plugin\'s, even a malformed one) is ignored', () => {
    expect(parseTeamSettings({ repo_roots: [REPO_ROOT], accepted: { version: 'x' } }, f.env)).toEqual({ folders: [REPO_ROOT], dropped: [] });
    expect(parseTeamSettings({ folders: [], accepted: null }, f.env)).toEqual({ folders: [], dropped: [] });
  });

  it('strict: wrong types, unknown fields, unsafe folders, and more than 20 in one list are refused; a gone folder is kept', () => {
    const cases: Array<[unknown, RegExp]> = [
      [[], /not a JSON object/],
      [{ folders: REPO_ROOT }, /must be a list/],
      [{ folders: ['~'] }, /home directory/],
      [{ repo_roots: ['~/Library/Mail'] }, /inside ~\/Library/],
      [{ folders: MANY.slice(0, 21) }, /folders has more than 20/],
      [{ repo_roots: MANY.slice(0, 21) }, /repo_roots has more than 20/],
      [{ folders: [], drives: [] }, /unknown field/],
    ];
    for (const [raw, why] of cases) expect(() => parseTeamSettings(raw, f.env), JSON.stringify(raw)).toThrow(why);
    expect(parseTeamSettings({ folders: ['~/code/gone'] }, f.env).folders).toEqual(['~/code/gone']);
  });

  it('the file: per team, strict; the older format without teams is refused', () => {
    const s = parseMemberSettings({ teams: { demo: { folders: [REPO_ROOT] }, other: { repo_roots: [MY_FOLDER], extra_folders: [] } } }, f.env);
    expect(teamSettings(s, 'demo')).toEqual({ folders: [REPO_ROOT], dropped: [] });
    expect(teamSettings(s, 'other')).toEqual({ folders: [MY_FOLDER], dropped: [] });
    expect(teamSettings(s, 'missing')).toEqual({ folders: [], dropped: [] });
    expect(() => parseMemberSettings({ repo_roots: [REPO_ROOT], extra_folders: [] }, f.env)).toThrow(/older format/);
    expect(() => parseMemberSettings({ folders: [REPO_ROOT] }, f.env)).toThrow(/older format/);
    expect(() => parseMemberSettings({ teams: { 'Not A Team': { folders: [] } } }, f.env)).toThrow(/not a team id/);
    expect(() => parseMemberSettings({ teams: {}, extra: 1 }, f.env)).toThrow(/unknown field/);
    expect(() => parseMemberSettings({ teams: [] }, f.env)).toThrow(/"teams", an object/);
  });

  it('the dropped sentence names each dropped folder, and none when nothing was dropped', () => {
    expect(droppedSentence([])).toBeNull();
    expect(droppedSentence(['~/a'])).toBe('Only 20 folders can be used: "~/a" was dropped. Save your folders (/team-relay:folders or /team-relay:setup) to make this permanent.');
    expect(droppedSentence(['~/a', '~/b'])).toBe('Only 20 folders can be used: "~/a", "~/b" were dropped. Save your folders (/team-relay:folders or /team-relay:setup) to make this permanent.');
  });
});

describe('the file on disk', () => {
  it('written mode 600 in a mode-700 directory; a file others can read, or a symlink, is refused', () => {
    const env = { ...f.env, XDG_CONFIG_HOME: join(f.root, 'xdg2') };
    const path = memberFoldersPath(env);
    expect(path).toBe(join(f.root, 'xdg2', 'team-relay', 'boundaries.local.json'));
    expect(readTeamSettings(path, env, TEAM)).toEqual({ folders: [], dropped: [] });
    writeMemberSettings(path, withTeam({ teams: {} }, TEAM, { folders: [REPO_ROOT] }), env);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(f.root, 'xdg2', 'team-relay')).mode & 0o777).toBe(0o700);
    expect(readTeamSettings(path, env, TEAM)).toEqual({ folders: [REPO_ROOT], dropped: [] });
    chmodSync(path, 0o644);
    expect(() => readMemberSettings(path, env)).toThrow(MemberFoldersError);
    expect(() => readMemberSettings(path, env)).toThrow(/mode 644/);
    chmodSync(path, 0o600);
    const env3 = { ...f.env, XDG_CONFIG_HOME: join(f.root, 'xdg3') };
    mkdirSync(join(f.root, 'xdg3', 'team-relay'), { recursive: true, mode: 0o700 });
    symlinkSync(path, memberFoldersPath(env3));
    expect(() => readMemberSettings(memberFoldersPath(env3), env3)).toThrow(/symbolic link/);
    expect(() => writeMemberSettings(memberFoldersPath(env3), { teams: {} }, env3)).toThrow(/not a regular file/);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ teams: { [TEAM]: { folders: [REPO_ROOT] } } });
  });

  it('writing back keeps `folders` alone: the earlier lists, `accepted` and what was dropped are gone; other teams kept', () => {
    writeFolders(f, [], { raw: { repo_roots: MANY.slice(0, 15), extra_folders: MANY.slice(15), accepted: { version: 2 } } });
    const file = memberFoldersPath(f.env);
    const before = readMemberSettings(file, f.env);
    expect(teamSettings(before, TEAM).dropped).toEqual(MANY.slice(20));
    writeMemberSettings(file, withTeam(before, TEAM, { folders: teamSettings(before, TEAM).folders }), f.env);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ teams: { [TEAM]: { folders: MANY.slice(0, 20) } } });
    expect(readTeamSettings(file, f.env, TEAM)).toEqual({ folders: MANY.slice(0, 20), dropped: [] });
    // Another team's earlier lists are written as its folders too.
    writeFileSync(file, JSON.stringify({ teams: { [TEAM]: { folders: [REPO_ROOT] }, other: { repo_roots: [MY_FOLDER], extra_folders: [] } } }));
    writeMemberSettings(file, withTeam(readMemberSettings(file, f.env), TEAM, { folders: [] }), f.env);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ teams: { [TEAM]: { folders: [] }, other: { folders: [MY_FOLDER] } } });
    writeFolders(f, FOLDERS);
  });

  it('adding checks the folder and the cap; removing matches it however it was written', () => {
    expect(() => changeMemberFolders([], 'add', '~/Library/Mail', f.env)).toThrow(/cannot be added: it is inside ~\/Library/);
    const added = changeMemberFolders([], 'add', REPO_ROOT, f.env);
    expect(added).toEqual({ folders: [REPO_ROOT], changed: true, resolved: f.repoRoot });
    expect(changeMemberFolders(added.folders, 'add', f.repoRoot, f.env).changed).toBe(false);
    expect(changeMemberFolders(added.folders, 'remove', f.repoRoot, f.env)).toEqual({ folders: [], changed: true, resolved: f.repoRoot });
    expect(changeMemberFolders(added.folders, 'remove', MY_FOLDER, f.env).changed).toBe(false);
    expect(() => changeMemberFolders(MANY.slice(0, 20), 'add', REPO_ROOT, f.env)).toThrow(/at most 20 folders/);
  });

  it('writeFolders (the test helper) writes what the host reads', () => {
    writeFolders(f, [REPO_ROOT]);
    expect(readTeamSettings(memberFoldersPath(f.env), f.env, TEAM).folders).toEqual([REPO_ROOT]);
    writeFolders(f, FOLDERS);
  });
});

describe('the accepted version comes from the relay', () => {
  it('a whole number from 1 to the current version; 0, a non-number and a version past the document are not accepted', () => {
    expect(hasAccepted(1, 1)).toBe(true);
    expect(hasAccepted(2, 3)).toBe(true);
    expect(hasAccepted(3, 3)).toBe(true);
    for (const v of [0, 4, -1, 1.5, '1', null, undefined, Number.NaN, 2 ** 31]) expect(hasAccepted(v, 3), String(v)).toBe(false);
  });
});

describe('/team-relay:folders', () => {
  type Dialog = { message: string };
  const URL_ = 'https://relay.example.com';
  function deps(tb: TeamBoundaries | null, version: number | null, dialogs: Dialog[] | null = [], team: string | null = TEAM, decision = 'change') {
    const elicit: Elicit | null = dialogs
      ? async (params) => {
          dialogs.push({ message: params.message });
          return { action: 'accept', content: { decision } };
        }
      : null;
    return { env: f.env, elicit, team: () => team, boundaries: async () => tb, acceptance: async () => version, console: () => (team ? URL_ : null) };
  }
  const tb = (version: number, b: typeof BOUNDARIES | null, team = TEAM): TeamBoundaries => ({ team, version, boundaries: b, updated_at: null, updated_by: 'alice' });
  const json = (r: { content: Array<{ text?: string }> }) => JSON.parse(r.content[0]!.text!) as Record<string, unknown>;

  it('the tool offers list, add and remove', () => {
    expect(FOLDERS_TOOL.inputSchema.properties.action.enum).toEqual(['list', 'add', 'remove']);
  });

  it('list: the folders, the topic quoted, what was accepted (the relay\'s) and what answers come from; writes nothing', async () => {
    writeFolders(f, [...FOLDERS, '~/code/gone']);
    const dialogs: Dialog[] = [];
    const one = json(await foldersTool({}, deps(tb(1, BOUNDARIES), 1, dialogs)));
    expect(one.team).toBe(TEAM);
    expect(one.folders).toEqual([
      { path: REPO_ROOT, resolved: f.repoRoot },
      { path: MY_FOLDER, resolved: f.myFolder },
      { path: '~/code/gone', resolved: join(f.home, 'code', 'gone'), not_used: 'it does not exist' },
    ]);
    expect(one.team_boundaries).toEqual({ version: 1, topic: JSON.stringify(BOUNDARIES.topic) });
    expect(one.accepted).toEqual({ version: 1 });
    expect(one.answers_come_from).toBe(`2 of your folders (example-org, team); ${f.allowed.length} files`);
    expect(one).not.toHaveProperty('dropped');
    expect(dialogs).toEqual([]);
    const none = json(await foldersTool({ action: 'list' }, deps(tb(1, BOUNDARIES), 0)));
    expect(none.accepted).toBe(`nothing yet: teammates' questions to you are declined until you accept your team's boundaries in the console (${URL_})`);
    expect(none.answers_come_from).toMatch(/^nothing: teammates' questions are declined/);
    const unknown = json(await foldersTool({}, deps(tb(1, BOUNDARIES), null)));
    expect(unknown.accepted).toBe('unknown (the relay could not say which version you accepted)');
    // An accepted version the document has not reached (an earlier team under this id) is nothing.
    expect(json(await foldersTool({}, deps(tb(1, BOUNDARIES), 5))).answers_come_from).toMatch(/^nothing/);
    // Another team's document is used for nothing.
    const elsewhere = json(await foldersTool({}, deps(tb(1, BOUNDARIES, 'elsewhere'), 1)));
    expect(elsewhere.team_boundaries).toBe("unknown (the relay answered with another team's boundaries)");
    expect(elsewhere).not.toHaveProperty('answers_come_from');
    // A read-only configuration directory is no error for list.
    const dir = join(f.xdg, 'team-relay');
    chmodSync(dir, 0o500);
    try {
      expect((await foldersTool({}, deps(tb(1, BOUNDARIES), 1))).isError).toBeFalsy();
    } finally {
      chmodSync(dir, 0o700);
    }
    expect((await foldersTool({ action: 'list', path: '~/x' }, deps(null, null))).isError).toBe(true);
    writeFolders(f, FOLDERS);
  });

  it('list: what reading an earlier plugin\'s lists dropped, and how to keep the list as it is now', async () => {
    writeFolders(f, [], { raw: { repo_roots: MANY.slice(0, 15), extra_folders: MANY.slice(15) } });
    const r = json(await foldersTool({}, deps(tb(1, BOUNDARIES), 1)));
    expect((r.folders as unknown[]).length).toBe(20);
    expect(r.dropped).toEqual(MANY.slice(20));
    expect(r.dropped_note).toBe(droppedSentence(MANY.slice(20)));
    writeFolders(f, FOLDERS);
  });

  it('add and remove: a dialog first, only the member\'s choice changes the file, written as `folders`', async () => {
    writeFolders(f, [REPO_ROOT]);
    const dialogs: Dialog[] = [];
    const added = json(await foldersTool({ action: 'add', path: MY_FOLDER }, deps(tb(1, BOUNDARIES), 1, dialogs)));
    expect(added.message).toBe('Added. Your automatic answerer uses it from its next answer.');
    expect(added.folders).toEqual([
      { path: REPO_ROOT, resolved: f.repoRoot },
      { path: MY_FOLDER, resolved: f.myFolder },
    ]);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]!.message).toContain(`Let your automatic answerer read ${MY_FOLDER} (${f.myFolder})?`);
    expect(JSON.parse(readFileSync(memberFoldersPath(f.env), 'utf8'))).toEqual({ teams: { [TEAM]: { folders: [REPO_ROOT, MY_FOLDER] } } });
    // Declined: nothing changes.
    const kept = json(await foldersTool({ action: 'remove', path: REPO_ROOT }, deps(tb(1, BOUNDARIES), 1, [], TEAM, 'keep')));
    expect(kept.message).toBe('You kept it as it was; nothing changed.');
    expect(readTeamSettings(memberFoldersPath(f.env), f.env, TEAM).folders).toEqual([REPO_ROOT, MY_FOLDER]);
    const removed = json(await foldersTool({ action: 'remove', path: f.repoRoot }, deps(tb(1, BOUNDARIES), 1)));
    expect(removed.message).toMatch(/^Removed\./);
    expect(readTeamSettings(memberFoldersPath(f.env), f.env, TEAM).folders).toEqual([MY_FOLDER]);
    // Nothing to change: no dialog.
    const none: Dialog[] = [];
    expect(json(await foldersTool({ action: 'add', path: MY_FOLDER }, deps(null, null, none))).message).toBe('It is already there; nothing changed.');
    expect(json(await foldersTool({ action: 'remove', path: REPO_ROOT }, deps(null, null, none))).message).toBe('It is not in the list; nothing changed.');
    expect(none).toEqual([]);
    // An unsafe folder is refused before any dialog.
    expect((await foldersTool({ action: 'add', path: '~' }, deps(null, null, none))).isError).toBe(true);
    expect(none).toEqual([]);
    writeFolders(f, FOLDERS);
  });

  it('saving a migrated list makes it permanent: the earlier lists become `folders`', async () => {
    writeFolders(f, [], { raw: { repo_roots: [REPO_ROOT], extra_folders: [], accepted: null } });
    await foldersTool({ action: 'add', path: MY_FOLDER }, deps(tb(1, BOUNDARIES), 1));
    expect(JSON.parse(readFileSync(memberFoldersPath(f.env), 'utf8'))).toEqual({ teams: { [TEAM]: { folders: [REPO_ROOT, MY_FOLDER] } } });
    writeFolders(f, FOLDERS);
  });

  it('without dialogs nothing changes, and it says how to edit the file', async () => {
    writeFolders(f, [REPO_ROOT]);
    const r = await foldersTool({ action: 'add', path: MY_FOLDER }, deps(null, null, null));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain(`{"teams": {"${TEAM}": {"folders": [...]}}}`);
    expect(readTeamSettings(memberFoldersPath(f.env), f.env, TEAM).folders).toEqual([REPO_ROOT]);
    writeFolders(f, FOLDERS);
  });

  it('refuses when not signed in, an unknown action and unknown arguments', async () => {
    expect((await foldersTool({}, deps(tb(1, BOUNDARIES), 1, [], null))).isError).toBe(true);
    expect((await foldersTool({ action: 'accept' }, deps(tb(1, BOUNDARIES), 1))).isError).toBe(true);
    expect((await foldersTool({ action: 'add_folder', path: MY_FOLDER }, deps(tb(1, BOUNDARIES), 1))).isError).toBe(true);
    expect((await foldersTool({ action: 'list', extra: 1 }, deps(tb(1, BOUNDARIES), 1))).isError).toBe(true);
  });

  it('a folder change is kept per team: the other team\'s entry is untouched', async () => {
    const file = memberFoldersPath(f.env);
    writeFileSync(file, JSON.stringify({ teams: { [TEAM]: { folders: [REPO_ROOT] }, other: { folders: [MY_FOLDER] } } }));
    chmodSync(file, 0o600);
    await foldersTool({ action: 'add', path: MY_FOLDER }, deps(tb(1, BOUNDARIES), 1));
    const all = readMemberSettings(file, f.env);
    expect(teamSettings(all, 'other')).toEqual({ folders: [MY_FOLDER], dropped: [] });
    expect(teamSettings(all, TEAM)).toEqual({ folders: [REPO_ROOT, MY_FOLDER], dropped: [] });
    writeFolders(f, FOLDERS);
  });
});
