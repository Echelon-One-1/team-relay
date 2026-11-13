// The setup page's own routes (/team-relay:setup): /api/local/*, answered by the console server
// on the member's Mac only (local mode; hosted they are 404). The console server checks every
// request first (console-app.ts: the Host, the per-launch key, Sec-Fetch-Site, JSON of at most
// LOCAL_BODY_LIMIT bytes with only the route's fields, no query); this file answers them.
//
//   GET  /api/local/setup            what the page shows: who is signed in, the folders the
//                                    member's Claude answers from, `previous` (the folders an
//                                    earlier plugin's file held, each with its kind: never read
//                                    from, shown so the member can pick again the ones they
//                                    still want; saving the folders removes them from the file),
//                                    whether the Mac's folder chooser
//                                    is here, the background answerer (installed, and whether it
//                                    can be turned on here: a Mac with Claude Code; else why not)
//   POST /api/local/folders/choose   opens the Mac's folder chooser and adds what was chosen
//                                    (checked by the folder rules); the only way to add a folder
//   POST /api/local/folders/remove   {"path"}: removes exactly that stored entry
//   PUT  /api/local/background       {"on"}: installs or removes the background answerer
//   POST /api/local/done             the member is done: the server stops shortly after
//
// One list of folders, every member's own (owners included), at most 20: the folders file's
// `folders` (member-folders.ts).
//
// No route takes a folder to add: added folders come only from the Mac's chooser, which the
// member works on their own screen. So a script on any page, even one holding the key, can add
// nothing the member did not pick.

import { homeDir } from './boundary-set.js';
import { AgentError } from './daemon-launch.js';
import { MAX_FOLDERS, MemberFoldersError, changeMemberFolders, memberFoldersPath, readTeamSettings, type TeamSettings } from './member-folders.js';
import { addFolder, saveTeamFolders, type FolderChooser } from './setup-steps.js';
import { describeError } from './tool-util.js';

/** A request body here is at most this many bytes. */
export const LOCAL_BODY_LIMIT = 4096;

/** The routes: the one method each allows and the only fields its body may hold. */
export const LOCAL_ROUTES: Readonly<Record<string, { method: 'GET' | 'POST' | 'PUT'; fields: readonly string[] }>> = Object.freeze({
  '/api/local/setup': { method: 'GET', fields: [] },
  '/api/local/folders/choose': { method: 'POST', fields: [] },
  '/api/local/folders/remove': { method: 'POST', fields: ['path'] },
  '/api/local/background': { method: 'PUT', fields: ['on'] },
  '/api/local/done': { method: 'POST', fields: [] },
});

export type LocalAnswer = { status: number; body: unknown };

/** What the console server hands a checked request to. */
export type LocalSetup = {
  /** `body` is undefined (no body) or a plain object holding only the route's fields. */
  handle(path: string, body: Record<string, unknown> | undefined): Promise<LocalAnswer>;
};

export type LocalSetupDeps = {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Who is signed in on this Mac (shown on the page). */
  signedIn: { member: string; team: string; email: string | null };
  /** The Mac's folder chooser (null: none on this computer). */
  chooser: FolderChooser | null;
  background: {
    /** Whether it can be turned on here (a Mac with Claude Code), and why not. */
    availability: () => { available: true } | { available: false; reason: string };
    installed: () => boolean;
    install: () => Promise<void>;
    uninstall: () => Promise<boolean>;
  };
  /** The member pressed Done. */
  onDone: () => void;
  log?: (line: string) => void;
};

const MAX_PATH = 1024;

/** The chooser's own prompt. */
export const CHOOSER_PROMPT = 'Pick the folders your Claude may answer your team from. Hold Cmd to pick more than one.';

/** A path as the page shows it: under the home folder as ~/…, anything else as it is. */
export function displayPath(raw: string, env: NodeJS.ProcessEnv): string {
  const home = homeDir(env).replace(/\/+$/, '');
  if (home && raw === home) return '~';
  if (home && raw.startsWith(`${home}/`)) return `~/${raw.slice(home.length + 1)}`;
  return raw;
}

const bad = (detail: string): LocalAnswer => ({ status: 400, body: { error: 'bad_request', detail } });
const notSaved = (err: unknown): LocalAnswer => ({
  status: 500,
  body: { error: 'not_saved', detail: `Nothing was saved (${err instanceof MemberFoldersError ? err.message : describeError(err)}).` },
});

export function createLocalSetup(d: LocalSetupDeps): LocalSetup {
  const { env } = d;
  const log = d.log ?? (() => {});
  const file = memberFoldersPath(env);
  const team = d.signedIn.team;
  let chooserOpen = false;

  const stored = (): TeamSettings => readTeamSettings(file, env, team);
  const shown = (list: string[]) => list.map((p) => displayPath(p, env));

  function state(): LocalAnswer {
    let mine: TeamSettings;
    try {
      mine = stored();
    } catch (err) {
      return { status: 500, body: { error: 'folders_unreadable', detail: `Your saved folders cannot be read (${describeError(err)}).` } };
    }
    return {
      status: 200,
      body: {
        signed_in: d.signedIn,
        folders: shown(mine.folders),
        previous: mine.previous.map((x) => ({ path: displayPath(x.path, env), kind: x.kind })),
        chooser: d.chooser !== null,
        background: { installed: d.background.installed(), ...d.background.availability() },
        limits: { max_folders: MAX_FOLDERS },
      },
    };
  }

  async function choose(): Promise<LocalAnswer> {
    if (!d.chooser) return { status: 409, body: { error: 'no_chooser', detail: 'This computer has no folder chooser. In Claude Code, type /team-relay:folders to add folders.' } };
    // One chooser at a time; taken before anything is awaited.
    if (chooserOpen) return { status: 409, body: { error: 'chooser_open', detail: 'The folder chooser is already open on your Mac.' } };
    chooserOpen = true;
    try {
      const r = await d.chooser(CHOOSER_PROMPT);
      if (r.kind === 'unavailable') {
        return { status: 503, body: { error: 'chooser_unavailable', detail: 'The folder chooser could not open (or was left open too long). Try again.' } };
      }
      if (r.kind === 'cancelled' || r.paths.length === 0) return { status: 200, body: { added: [], refused: [], cancelled: true, folders: shown(stored().folders) } };
      const added: string[] = [];
      const refused: Array<{ path: string; reason: string }> = [];
      const saved = saveTeamFolders(env, team, (cur) => {
        const list = [...cur];
        for (const raw of r.paths) {
          const o = addFolder(list, raw, env);
          if (o.kind === 'added') added.push(displayPath(raw, env));
          else
            refused.push({
              path: displayPath(raw, env),
              reason: o.kind === 'refused' ? o.reason : o.kind === 'duplicate' ? 'it is already in the list' : `at most ${MAX_FOLDERS} folders`,
            });
        }
        return list;
      });
      log(`setup page: ${added.length} folders added, ${refused.length} not used`);
      return { status: 200, body: { added, refused, cancelled: false, folders: shown(saved) } };
    } catch (err) {
      return notSaved(err);
    } finally {
      chooserOpen = false;
    }
  }

  function remove(body: Record<string, unknown> | undefined): LocalAnswer {
    const path = body?.path;
    if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH) return bad('path must be a stored folder');
    try {
      const cur = readTeamSettings(file, env, team).folders;
      if (!changeMemberFolders(cur, 'remove', path, env).changed) return { status: 404, body: { error: 'not_found', detail: 'That folder is not in the list.' } };
      // Removing only ever narrows: nothing is added here, whatever the path says.
      const saved = saveTeamFolders(env, team, (c) => changeMemberFolders(c, 'remove', path, env).folders);
      log('setup page: removed a folder');
      return { status: 200, body: { folders: shown(saved) } };
    } catch (err) {
      return notSaved(err);
    }
  }

  async function background(body: Record<string, unknown> | undefined): Promise<LocalAnswer> {
    const on = body?.on;
    if (typeof on !== 'boolean') return bad('on must be true or false');
    if (d.platform !== 'darwin') return { status: 409, body: { error: 'mac_only', detail: 'Background answering runs on macOS only.' } };
    if (on) {
      const a = d.background.availability();
      if (!a.available) return { status: 409, body: { error: 'background_unavailable', detail: a.reason } };
    }
    try {
      if (on) await d.background.install();
      else await d.background.uninstall();
    } catch (err) {
      return { status: 500, body: { error: 'background_failed', detail: err instanceof AgentError ? err.message : `That did not work: ${describeError(err)}` } };
    }
    log(`setup page: background answering ${on ? 'on' : 'off'}`);
    return { status: 200, body: { installed: d.background.installed() } };
  }

  return {
    async handle(path, body) {
      switch (path) {
        case '/api/local/setup':
          return state();
        case '/api/local/folders/choose':
          return choose();
        case '/api/local/folders/remove':
          return remove(body);
        case '/api/local/background':
          return background(body);
        case '/api/local/done':
          d.onDone();
          return { status: 200, body: { ok: true } };
      }
      return { status: 404, body: { error: 'not_found' } };
    },
  };
}
