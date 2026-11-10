// M10-SPEC §2, §7.1: /team-relay:folders, the `folders` tool of a working session's relay server.
// It shows the member's local settings for the team they are signed in to (member-folders.ts):
// repo roots, their own folders, the boundaries version they accepted (M11-SPEC §2: as the relay
// holds it) and what a newer version adds, and what the answerer would read with them. It adds
// or removes a repo root or an extra folder.
//
// Accepting the team's boundaries is no longer done here (M11-SPEC §2): the member accepts in
// the console, where only they can, and the `accept` action says where.
//
// A change is never the model's to make: every add or remove opens a dialog (MCP elicitation)
// that says exactly what changes (which folder, resolved) and only the member's choice there
// changes the file. Without dialogs nothing changes. So nothing a teammate writes can steer the
// session into widening (or narrowing) what the answerer reads.

import type { Elicit } from './approvals-review.js';
import type { TeamBoundaries } from './boundaries-types.js';
import { buildAllowedSet, quotedOwnerText, setSummary, wideningText, type GitCache } from './boundary-set.js';
import {
  acceptedAtVersion,
  changeMemberFolders,
  effectiveBoundaries,
  memberFolderProblem,
  memberFoldersPath,
  readMemberSettings,
  sinceOf,
  teamSettings,
  withTeam,
  writeMemberSettings,
  type FolderList,
  type MemberFolders,
  type TeamSettings,
} from './member-folders.js';
import { describeError, isPlainObject, toolError, toolJson, type ToolResult } from './tool-util.js';

export const FOLDERS_TOOL = {
  name: 'folders',
  description:
    'Show or change where your automatic answerer looks when your team has boundaries (/team-relay:folders): repo roots (folders ' +
    'searched 3 levels deep for clones of the team\'s GitHub repositories; only files git tracks are read), folders of your own when ' +
    'the team allows them, and which version of the team\'s boundaries you accepted. action "show" (default) lists them and what they give; ' +
    '"add_root", "remove_root", "add_folder" and "remove_folder" take a path (absolute or starting with ~/); "accept" says where to ' +
    'accept the team\'s boundaries (the team console, in the browser). Every change asks the user in a dialog first: only the user decides there.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['show', 'add_root', 'remove_root', 'add_folder', 'remove_folder', 'accept'] },
      path: { type: 'string', minLength: 1, maxLength: 1024 },
    },
    additionalProperties: false,
  },
} as const;

const DIALOG_MS = 10 * 60_000;
const NO_DIALOGS = 'This Claude Code does not offer dialogs to plugins (MCP elicitation)';

export type FoldersDeps = {
  env: NodeJS.ProcessEnv;
  elicit: Elicit | null;
  /** The team this session is signed in to (null: not signed in). */
  team: () => string | null;
  /** The team's boundaries, when they can be read now (null: not signed in or unreachable). */
  boundaries: () => Promise<TeamBoundaries | null>;
  /** M11-SPEC §2: the boundaries version the member accepted, from the relay (null: unknown). */
  acceptance: () => Promise<number | null>;
  /** M11-SPEC §2: the console, where the member accepts (null: not signed in). */
  console: () => string | null;
  cache?: GitCache | null;
};

/** Where to accept, in one sentence. */
function whereToAccept(url: string | null): string {
  return url
    ? `Accept your team's boundaries in the team console: open ${url} and press Accept on the Join or Team page. Only you can accept for yourself.`
    : "Accept your team's boundaries in the team console (sign in first with /team-relay:login to see its address). Only you can accept for yourself.";
}

function describeFolders(v: MemberFolders, env: NodeJS.ProcessEnv) {
  const one = (raw: string) => {
    const { path, reason } = memberFolderProblem(raw, env);
    return { path: raw, resolved: path, ...(reason ? { not_used: reason } : {}) };
  };
  return { repo_roots: v.repo_roots.map(one), extra_folders: v.extra_folders.map(one) };
}

function teamPart(tb: TeamBoundaries | null, otherTeam = false) {
  if (otherTeam) return { team_boundaries: "unknown (the relay answered with another team's boundaries)" };
  if (!tb) return { team_boundaries: 'unknown (not signed in, or the relay could not be reached)' };
  if (!tb.boundaries) return { team_boundaries: 'none: your team has no boundaries, so your answerer reads only the folder your working session is in (and asks you for anything else)' };
  const b = tb.boundaries;
  return {
    team_boundaries: {
      version: tb.version,
      github_orgs: b.github_orgs,
      // Owner-written names: data, quoted.
      shared_drives: b.drives.map((d) => `${quotedOwnerText(d.shared_drive, 100)} (${d.domain})`),
      member_folders_allowed: b.member_folders,
    },
  };
}

/** What the member accepted (M11-SPEC §2: the relay's version), and what the team's current boundaries add to it (§7.1). */
function acceptancePart(tb: TeamBoundaries | null, version: number | null, url: string | null) {
  if (version === null) return { accepted: 'unknown (the relay could not say which version you accepted)' };
  const where = url ? `in the console (${url})` : 'in the console';
  const accepted = version > 0 ? { version } : `nothing yet: teammates' questions to you are declined until you accept your team's boundaries ${where}`;
  if (!tb?.boundaries) return { accepted };
  const since = sinceOf(tb);
  const eff = effectiveBoundaries(tb.boundaries, acceptedAtVersion(tb.boundaries, version, since), since);
  return {
    accepted,
    ...(eff.pending && !eff.notAccepted ? { not_accepted_yet: `version ${tb.version} adds ${wideningText(eff.pending)}: accept it ${where}` } : {}),
  };
}

async function decide(elicit: Elicit, message: string, yes: string, no: string): Promise<boolean> {
  const res = await elicit(
    {
      message: `${message}\n\nThis was asked for in your session; only your choice here changes it.`,
      requestedSchema: {
        type: 'object',
        properties: {
          decision: {
            type: 'string',
            title: 'Your decision',
            oneOf: [
              { const: 'change', title: yes },
              { const: 'keep', title: no },
            ],
          },
        },
        required: ['decision'],
      },
    },
    DIALOG_MS,
  );
  const content = isPlainObject(res.content) ? res.content : {};
  return res.action === 'accept' && content.decision === 'change';
}

export async function foldersTool(args: Record<string, unknown>, deps: FoldersDeps): Promise<ToolResult> {
  for (const k of Object.keys(args)) if (k !== 'action' && k !== 'path') return toolError(`unknown argument: ${k}`);
  const action = args.action ?? 'show';
  const team = deps.team();
  if (!team) return toolError('Not signed in to a team: run /team-relay:login first. Your folders are kept per team.');
  const file = memberFoldersPath(deps.env);
  let current: TeamSettings;
  try {
    current = teamSettings(readMemberSettings(file, deps.env), team);
  } catch (err) {
    return toolError(`your folders file cannot be used (${describeError(err)}): fix or remove ${file}`);
  }

  if (action === 'show') {
    if (args.path !== undefined) return toolError('show takes no path');
    const read = await deps.boundaries().catch(() => null);
    // Another team's document is used for nothing: not shown, not worked out.
    const otherTeam = read !== null && read.team !== team;
    const tb = otherTeam ? null : read;
    const version = tb?.boundaries ? await deps.acceptance().catch(() => null) : null;
    let gives: string | null = null;
    if (tb?.boundaries) {
      const since = sinceOf(tb);
      const eff = effectiveBoundaries(tb.boundaries, version === null ? null : acceptedAtVersion(tb.boundaries, version, since), since);
      if (version === null) {
        gives = 'unknown: the relay could not say which version you accepted';
      } else if (eff.notAccepted) {
        gives = "nothing: teammates' questions are declined until you accept your team's boundaries";
      } else {
        try {
          const set = await buildAllowedSet({ version: tb.version, boundaries: eff.boundaries, member: current, env: deps.env, cache: deps.cache ?? null });
          gives = setSummary(set);
        } catch (err) {
          gives = `could not be worked out (${describeError(err)})`;
        }
      }
    }
    return toolJson({
      file,
      team,
      ...describeFolders(current, deps.env),
      ...teamPart(tb, otherTeam),
      ...(tb?.boundaries ? acceptancePart(tb, version, deps.console()) : {}),
      ...(gives ? { answers_come_from: gives } : {}),
      how_to_change: `Ask to add or remove a repo root or a folder; each change opens a dialog where you decide. ${whereToAccept(deps.console())}`,
    });
  }

  if (action === 'accept') {
    // M11-SPEC §2: accepting is done in the browser, by the member only.
    if (args.path !== undefined) return toolError('accept takes no path');
    return toolJson({ message: whereToAccept(deps.console()) });
  }

  const ops: Record<string, [FolderList, 'add' | 'remove']> = {
    add_root: ['repo_roots', 'add'],
    remove_root: ['repo_roots', 'remove'],
    add_folder: ['extra_folders', 'add'],
    remove_folder: ['extra_folders', 'remove'],
  };
  const op = typeof action === 'string' ? ops[action] : undefined;
  if (!op) return toolError('action must be show, add_root, remove_root, add_folder, remove_folder or accept');
  const raw = args.path;
  if (typeof raw !== 'string' || raw.length === 0) return toolError(`${String(action)} needs a path (absolute, or starting with ~/)`);
  const [list, kind] = op;
  let change: ReturnType<typeof changeMemberFolders<TeamSettings>>;
  try {
    change = changeMemberFolders(current, list, kind, raw, deps.env);
  } catch (err) {
    return toolError(describeError(err));
  }
  if (!change.changed) {
    return toolJson({ message: kind === 'add' ? 'It is already there; nothing changed.' : 'It is not in the list; nothing changed.', ...describeFolders(current, deps.env) });
  }
  if (!deps.elicit) {
    return toolError(
      `${NO_DIALOGS}, so your folders cannot be changed from here. ` +
        `Edit ${file} yourself (mode 600): {"teams": {"${team}": {"repo_roots": [...], "extra_folders": [...]}}}.`,
    );
  }
  const where = change.resolved && change.resolved !== raw ? `${raw} (${change.resolved})` : raw;
  const what =
    list === 'repo_roots'
      ? kind === 'add'
        ? `Let your automatic answerer search ${where}, 3 levels deep, for clones of your team's GitHub repositories? Teammates' questions may then be answered, without asking you, from every file git tracks in those clones.`
        : `Stop your automatic answerer searching ${where} for clones of your team's GitHub repositories?`
      : kind === 'add'
        ? `Let your automatic answerer read ${where}? Teammates' questions may then be answered, without asking you, from its files (only the files git tracks, when it is in a repository), if your team allows members' own folders.`
        : `Stop your automatic answerer reading ${where}?`;
  let yes: boolean;
  try {
    yes = await decide(deps.elicit, what, kind === 'add' ? 'Yes, add it' : 'Yes, remove it', 'No, leave it as it is');
  } catch (err) {
    return toolError(`the dialog could not be shown (${describeError(err)}); nothing changed`);
  }
  if (!yes) return toolJson({ message: 'You kept it as it was; nothing changed.' });
  try {
    // Read again: the file may have changed while the dialog was open.
    const fresh = readMemberSettings(file, deps.env);
    const again = changeMemberFolders(teamSettings(fresh, team), list, kind, raw, deps.env);
    writeMemberSettings(file, withTeam(fresh, team, again.value), deps.env);
    return toolJson({ message: `${kind === 'add' ? 'Added' : 'Removed'}. Your automatic answerer uses it from its next answer.`, ...describeFolders(again.value, deps.env) });
  } catch (err) {
    return toolError(`nothing changed (${describeError(err)})`);
  }
}
