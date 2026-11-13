// The member's settings file (13 Nov 2026, local folders only): per team, one `folders` list of
// at most 20, the only folders ever read. An earlier plugin's `repo_roots` and `extra_folders`
// are never read from: they are a read-only `previous` list (each with its kind, duplicates and
// ones in `folders` left out), shown where folders are chosen; `accepted` is ignored; writing
// keeps `folders` alone. The accepted version is the relay's (hasAccepted), and the
// folders tool lists, adds and removes, each change in a dialog the member answers.

import { beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Elicit } from '../src/approvals-review.js';
import type { TeamBoundaries } from '../src/boundaries-types.js';
import { buildAllowedSet } from '../src/boundary-set.js';
import { FOLDERS_TOOL, foldersTool } from '../src/folders-tool.js';
import {
  MemberFoldersError,
  changeMemberFolders,
  hasAccepted,
  memberFolderProblem,
  memberFoldersPath,
  parseMemberSettings,
  parseTeamSettings,
  previousSentence,
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

describe('one team\'s settings: `folders` is read; an earlier plugin\'s lists are only `previous`', () => {
  it('folders alone', () => {
    expect(parseTeamSettings({ folders: FOLDERS }, f.env)).toEqual({ folders: FOLDERS, previous: [] });
    expect(parseTeamSettings({}, f.env)).toEqual({ folders: [], previous: [] });
    // A duplicate in `folders` is kept once.
    expect(parseTeamSettings({ folders: [REPO_ROOT, f.repoRoot] }, f.env).folders).toEqual([REPO_ROOT]);
  });

  it('both earlier lists give an EMPTY active list and the previous list, repo_roots then extra_folders, with kinds', () => {
    const v = parseTeamSettings({ extra_folders: [MY_FOLDER], repo_roots: [REPO_ROOT], accepted: { version: 1 } }, f.env);
    expect(v).toEqual({
      folders: [],
      previous: [
        { path: REPO_ROOT, kind: 'repo_root' },
        { path: MY_FOLDER, kind: 'own_folder' },
      ],
    });
  });

  it('previous leaves out duplicates (the same string or the same path once expanded) and folders already chosen', () => {
    const v = parseTeamSettings({ folders: [MY_FOLDER], repo_roots: [REPO_ROOT, REPO_ROOT, MY_FOLDER], extra_folders: [f.repoRoot, `${f.home}/notes/team`, '~/code/gone'] }, f.env);
    expect(v).toEqual({ folders: [MY_FOLDER], previous: [{ path: REPO_ROOT, kind: 'repo_root' }, { path: '~/code/gone', kind: 'own_folder' }] });
  });

  it('nothing is capped or dropped: 25 earlier entries are 25 previous ones, none read', () => {
    const v = parseTeamSettings({ repo_roots: MANY.slice(0, 20), extra_folders: [...MANY.slice(20), ...MANY.slice(0, 5)] }, f.env);
    expect(v.folders).toEqual([]);
    expect(v.previous.map((x) => x.path)).toEqual(MANY);
    expect(v).not.toHaveProperty('dropped');
  });

  it('an earlier entry that could not be added now is left out of previous; a wrong type still refuses the file', () => {
    mkdirSync(join(f.home, 'Library', 'Mail'), { recursive: true });
    expect(parseTeamSettings({ repo_roots: ['~/Library/Mail', '~', REPO_ROOT] }, f.env).previous).toEqual([{ path: REPO_ROOT, kind: 'repo_root' }]);
    expect(() => parseTeamSettings({ repo_roots: REPO_ROOT }, f.env)).toThrow(/must be a list/);
    expect(() => parseTeamSettings({ extra_folders: [3] }, f.env)).toThrow(/must be a list/);
    expect(() => parseTeamSettings({ repo_roots: MANY.slice(0, 21) }, f.env)).toThrow(/repo_roots has more than 20/);
  });

  it('strict: wrong types, unknown fields, unsafe folders, and more than 20 folders are refused; a gone folder is kept', () => {
    const cases: Array<[unknown, RegExp]> = [
      [[], /not a JSON object/],
      [{ folders: REPO_ROOT }, /must be a list/],
      [{ folders: ['~'] }, /home directory/],
      [{ folders: MANY.slice(0, 21) }, /folders has more than 20/],
      [{ folders: [], drives: [] }, /unknown field/],
    ];
    for (const [raw, why] of cases) expect(() => parseTeamSettings(raw, f.env), JSON.stringify(raw)).toThrow(why);
    expect(parseTeamSettings({ folders: ['~/code/gone'] }, f.env).folders).toEqual(['~/code/gone']);
  });

  it('the file: per team, strict; the older format without teams is refused', () => {
    const s = parseMemberSettings({ teams: { demo: { folders: [REPO_ROOT] }, other: { repo_roots: [MY_FOLDER], extra_folders: [] } } }, f.env);
    expect(teamSettings(s, 'demo')).toEqual({ folders: [REPO_ROOT], previous: [] });
    expect(teamSettings(s, 'other')).toEqual({ folders: [], previous: [{ path: MY_FOLDER, kind: 'repo_root' }] });
    expect(teamSettings(s, 'missing')).toEqual({ folders: [], previous: [] });
    expect(() => parseMemberSettings({ repo_roots: [REPO_ROOT], extra_folders: [] }, f.env)).toThrow(/older format/);
    expect(() => parseMemberSettings({ folders: [REPO_ROOT] }, f.env)).toThrow(/older format/);
    expect(() => parseMemberSettings({ teams: { 'Not A Team': { folders: [] } } }, f.env)).toThrow(/not a team id/);
    expect(() => parseMemberSettings({ teams: {}, extra: 1 }, f.env)).toThrow(/unknown field/);
    expect(() => parseMemberSettings({ teams: [] }, f.env)).toThrow(/"teams", an object/);
  });

  it('the previous sentence names each folder with its kind, and nothing when there is none', () => {
    expect(previousSentence([])).toBeNull();
    expect(previousSentence([{ path: '~/code', kind: 'repo_root' }, { path: '~/notes', kind: 'own_folder' }])).toBe(
      'Folders you chose before 13 Nov 2026 (not used now; add the ones you still want with /team-relay:folders add <path>): ~/code (repository root), ~/notes (folder of your own).',
    );
    // An odd path is quoted (one line, nothing taken as text around it).
    expect(previousSentence([{ path: '~/a\nb', kind: 'own_folder' }])).toContain('"~/a\\nb" (folder of your own)');
  });

  it('the answerer reads nothing from an earlier plugin\'s lists', async () => {
    const v = parseTeamSettings({ repo_roots: [REPO_ROOT], extra_folders: [MY_FOLDER] }, f.env);
    const set = await buildAllowedSet({ version: 1, member: v, env: f.env });
    expect(set.files.size).toBe(0);
    expect(set.areas).toEqual([]);
  });
});

describe('the file on disk', () => {
  it('written mode 600 in a mode-700 directory; a file others can read, or a symlink, is refused', () => {
    const env = { ...f.env, XDG_CONFIG_HOME: join(f.root, 'xdg2') };
    const path = memberFoldersPath(env);
    expect(path).toBe(join(f.root, 'xdg2', 'team-relay', 'boundaries.local.json'));
    expect(readTeamSettings(path, env, TEAM)).toEqual({ folders: [], previous: [] });
    writeMemberSettings(path, withTeam({ teams: {} }, TEAM, { folders: [REPO_ROOT] }), env);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(f.root, 'xdg2', 'team-relay')).mode & 0o777).toBe(0o700);
    expect(readTeamSettings(path, env, TEAM)).toEqual({ folders: [REPO_ROOT], previous: [] });
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

  it('after one save the active list is exactly what was chosen; the earlier lists and `accepted` are gone from the file', () => {
    writeFolders(f, [], { raw: { repo_roots: MANY.slice(0, 15), extra_folders: MANY.slice(15), accepted: { version: 2 } } });
    const file = memberFoldersPath(f.env);
    const before = readMemberSettings(file, f.env);
    expect(teamSettings(before, TEAM).folders).toEqual([]);
    expect(teamSettings(before, TEAM).previous).toHaveLength(25);
    writeMemberSettings(file, withTeam(before, TEAM, { folders: [MY_FOLDER] }), f.env);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ teams: { [TEAM]: { folders: [MY_FOLDER] } } });
    expect(readTeamSettings(file, f.env, TEAM)).toEqual({ folders: [MY_FOLDER], previous: [] });
    // Any write stores `folders` alone for every team: another team's earlier lists leave the file
    // too, and that team reads no folders.
    writeFileSync(file, JSON.stringify({ teams: { [TEAM]: { folders: [REPO_ROOT] }, other: { repo_roots: [MY_FOLDER], extra_folders: [] } } }));
    writeMemberSettings(file, withTeam(readMemberSettings(file, f.env), TEAM, { folders: [] }), f.env);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ teams: { [TEAM]: { folders: [] }, other: { folders: [] } } });
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
    expect(one).not.toHaveProperty('previously_chosen');
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

  it('list: the folders chosen before 13 Nov 2026, never read from, and how to add them again', async () => {
    writeFolders(f, [], { raw: { repo_roots: [REPO_ROOT], extra_folders: [MY_FOLDER] } });
    const r = json(await foldersTool({}, deps(tb(1, BOUNDARIES), 1)));
    expect(r.folders).toEqual([]);
    expect(r.previously_chosen).toEqual([
      { path: REPO_ROOT, kind: 'repo_root' },
      { path: MY_FOLDER, kind: 'own_folder' },
    ]);
    expect(r.previously_chosen_note).toBe(
      'Folders you chose before 13 Nov 2026 (not used now; add the ones you still want with /team-relay:folders add <path>): ~/code/example-org (repository root), ~/notes/team (folder of your own).',
    );
    expect(r.answers_come_from).toBe('none of your folders; 0 files');
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

  it('adding one folder saves exactly the chosen list: the earlier lists leave the file and are never read', async () => {
    writeFolders(f, [], { raw: { repo_roots: [REPO_ROOT], extra_folders: [], accepted: null } });
    await foldersTool({ action: 'add', path: MY_FOLDER }, deps(tb(1, BOUNDARIES), 1));
    expect(JSON.parse(readFileSync(memberFoldersPath(f.env), 'utf8'))).toEqual({ teams: { [TEAM]: { folders: [MY_FOLDER] } } });
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
    expect(teamSettings(all, 'other')).toEqual({ folders: [MY_FOLDER], previous: [] });
    expect(teamSettings(all, TEAM)).toEqual({ folders: [REPO_ROOT, MY_FOLDER], previous: [] });
    writeFolders(f, FOLDERS);
  });
});
