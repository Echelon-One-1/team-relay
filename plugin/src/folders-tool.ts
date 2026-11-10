// M10-SPEC §2, §7.1: /team-relay:folders, the `folders` tool of a working session's relay server.
// It shows the member's local settings for the team they are signed in to (member-folders.ts):
// repo roots, their own folders, the boundaries they accepted and what a newer version adds,
// and what the answerer would read with them. It adds or removes a repo root or an extra
// folder, and accepts the team's current boundaries.
//
// A change is never the model's to make: every add, remove or accept opens a dialog (MCP
// elicitation) that says exactly what changes (which folder, resolved; which orgs, drives or
// member folders are added) and only the member's choice there changes the file. Without
// dialogs nothing changes and nothing is accepted. So nothing a teammate writes can steer the
// session into widening (or narrowing) what the answerer reads.

import type { Elicit } from './approvals-review.js';
import type { TeamBoundaries } from './boundaries-types.js';
import { buildAllowedSet, quotedOwnerText, setSummary, wideningText, type GitCache } from './boundary-set.js';
import {
  acceptedFrom,
  changeMemberFolders,
  effectiveBoundaries,
  memberFolderProblem,
  memberFoldersPath,
  readMemberSettings,
  settingsNarrowedTo,
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
    'the team allows them, and which of the team\'s boundaries you accepted. action "show" (default) lists them and what they give; ' +
    '"add_root", "remove_root", "add_folder" and "remove_folder" take a path (absolute or starting with ~/); "accept" accepts the ' +
    'team\'s current boundaries. Every change asks the user in a dialog first: only the user decides there.',
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
  cache?: GitCache | null;
};

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

/** What the member accepted, and what the team's current boundaries add to it (§7.1). */
function acceptancePart(tb: TeamBoundaries | null, t: TeamSettings) {
  const a = t.accepted;
  const accepted = a
    ? {
        version: a.version,
        github_orgs: a.github_orgs,
        shared_drives: a.drives.map((d) => `${quotedOwnerText(d.shared_drive, 100)} (${d.domain})`),
        member_folders: a.member_folders,
      }
    : "nothing yet: teammates' questions to you are declined until you accept your team's boundaries (/team-relay:folders accept)";
  if (!tb?.boundaries) return { accepted };
  const eff = effectiveBoundaries(tb.boundaries, a, sinceOf(tb));
  return {
    accepted,
    ...(eff.pending ? { not_accepted_yet: `version ${tb.version} adds ${wideningText(eff.pending)}: run /team-relay:folders accept` } : {}),
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
    // Another team's document is used for nothing: not narrowed to, not shown, not worked out.
    const otherTeam = read !== null && read.team !== team;
    const tb = otherTeam ? null : read;
    // §7.1: what the team dropped leaves the accepted set (no dialog: it only narrows).
    if (tb?.boundaries) {
      try {
        current = settingsNarrowedTo(file, deps.env, team, tb.boundaries, sinceOf(tb)).settings;
      } catch (err) {
        return toolError(`your folders file cannot be used (${describeError(err)}): fix or remove ${file}`);
      }
    }
    let gives: string | null = null;
    if (tb?.boundaries) {
      const eff = effectiveBoundaries(tb.boundaries, current.accepted, sinceOf(tb));
      if (eff.notAccepted) {
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
      ...acceptancePart(tb, current),
      ...(gives ? { answers_come_from: gives } : {}),
      how_to_change: 'Ask to add or remove a repo root or a folder, or to accept the team\'s boundaries; each change opens a dialog where you decide.',
    });
  }

  if (action === 'accept') {
    if (args.path !== undefined) return toolError('accept takes no path');
    return accept(deps, team, file, current);
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

/**
 * M10-SPEC §7.1: accept the team's current boundaries. The dialog shows exactly what accepting
 * adds to what the member accepted before (everything, the first time); the version shown is the
 * one recorded.
 */
async function accept(deps: FoldersDeps, team: string, file: string, current: TeamSettings): Promise<ToolResult> {
  const tb = await deps.boundaries().catch(() => null);
  if (!tb) return toolError("Your team's boundaries cannot be read now (not signed in, or the relay could not be reached); nothing was accepted.");
  if (tb.team !== team) return toolError('The relay answered for a different team; nothing was accepted.');
  if (!tb.boundaries) return toolJson({ message: 'Your team has no boundaries, so there is nothing to accept.' });
  const eff = effectiveBoundaries(tb.boundaries, current.accepted, sinceOf(tb));
  if (!eff.notAccepted && !eff.pending) {
    return toolJson({ message: `Nothing new to accept: everything in version ${tb.version} of your team's boundaries is already accepted.` });
  }
  let record: ReturnType<typeof acceptedFrom>;
  try {
    record = acceptedFrom(tb.boundaries, tb.version);
  } catch (err) {
    return toolError(`these boundaries cannot be accepted (${describeError(err)}); nothing was accepted`);
  }
  if (!deps.elicit) return toolError(`${NO_DIALOGS}, so nothing was accepted. Run /team-relay:folders accept in a Claude Code that offers dialogs.`);
  const adds = wideningText(eff.pending ?? { github_orgs: [], drives: [], member_folders: false });
  const message = eff.notAccepted
    ? `Accept your team's boundaries (version ${tb.version})? Your automatic answerer will then answer teammates' questions on its own, without asking you, from ${adds} (for GitHub, only files git tracks in your clones under your repo roots). Reads of anything else stay denied.`
    : `Accept what version ${tb.version} of your team's boundaries adds? Your automatic answerer will then also answer teammates' questions on its own, without asking you, from ${adds}.`;
  let yes: boolean;
  try {
    yes = await decide(deps.elicit, message, 'Yes, accept', 'No, not now');
  } catch (err) {
    return toolError(`the dialog could not be shown (${describeError(err)}); nothing was accepted`);
  }
  if (!yes) return toolJson({ message: 'Not accepted; nothing changed.' });
  try {
    // Read again: the file may have changed while the dialog was open.
    const fresh = readMemberSettings(file, deps.env);
    const mine = teamSettings(fresh, team);
    if (mine.accepted && mine.accepted.version > record.version) {
      // Either a newer version was accepted while the dialog was open, or the stored acceptance
      // belongs to an earlier team under this id (versions started over): ask the relay which.
      const now = await deps.boundaries().catch(() => null);
      const nowVersion = now && now.team === team ? now.version : null;
      if (nowVersion === null) return toolError('nothing was accepted (the relay could not be asked which version is current); try again');
      if (mine.accepted.version <= nowVersion) return toolJson({ message: 'A newer version was accepted meanwhile; nothing changed.' });
    }
    writeMemberSettings(file, withTeam(fresh, team, { ...mine, accepted: record }), deps.env);
    return toolJson({ message: `Accepted version ${tb.version} of your team's boundaries. Your automatic answerer uses them from its next answer.` });
  } catch (err) {
    return toolError(`nothing was accepted (${describeError(err)})`);
  }
}
