// /team-relay:folders, the `folders` tool of a working session's relay server (13 Nov 2026,
// local folders only). It lists the folders the member chose for the team they are signed in to
// (member-folders.ts: one list, at most 20), the folders an earlier plugin's file held (never read
// from; shown so the member can add again the ones they still want), the
// team's boundaries version and whether the member accepted it (M11-SPEC §2: as the relay holds
// it; accepting is done in the console, by the member only), and what the answerer would read.
// It adds or removes one folder.
//
// A change is never the model's to make: every add or remove opens a dialog (MCP elicitation)
// that says exactly what changes (which folder, resolved) and only the member's choice there
// changes the file. Without dialogs nothing changes. So nothing a teammate writes can steer the
// session into widening (or narrowing) what the answerer reads.

import type { Elicit } from './approvals-review.js';
import type { TeamBoundaries } from './boundaries-types.js';
import { buildAllowedSet, quotedOwnerText, setSummary, type GitCache } from './boundary-set.js';
import {
  MAX_FOLDERS,
  changeMemberFolders,
  hasAccepted,
  memberFolderProblem,
  memberFoldersPath,
  previousSentence,
  readMemberSettings,
  teamSettings,
  withTeam,
  writeMemberSettings,
  type TeamSettings,
} from './member-folders.js';
import { describeError, isPlainObject, toolError, toolJson, type ToolResult } from './tool-util.js';

export const FOLDERS_TOOL = {
  name: 'folders',
  description:
    'Show or change the folders on this Mac your automatic answerer may read for your team (/team-relay:folders): at most ' +
    `${MAX_FOLDERS}; inside a git repository only the files git tracks are read. action "list" (default) lists them, whether you ` +
    'accepted your team\'s boundaries and what answers come from; "add" and "remove" take a path (absolute or starting with ~/). ' +
    'Every change asks the user in a dialog first: only the user decides there.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'add', 'remove'] },
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

function describeFolders(folders: readonly string[], env: NodeJS.ProcessEnv) {
  return {
    folders: folders.map((raw) => {
      const { path, reason } = memberFolderProblem(raw, env);
      return { path: raw, resolved: path, ...(reason ? { not_used: reason } : {}) };
    }),
  };
}

/** The folders an earlier plugin's file held: shown, never read from, added again only with add. */
function previousPart(v: TeamSettings) {
  const sentence = previousSentence(v.previous);
  return sentence ? { previously_chosen: v.previous, previously_chosen_note: sentence } : {};
}

function teamPart(tb: TeamBoundaries | null, otherTeam = false) {
  if (otherTeam) return { team_boundaries: "unknown (the relay answered with another team's boundaries)" };
  if (!tb) return { team_boundaries: 'unknown (not signed in, or the relay could not be reached)' };
  if (!tb.boundaries) return { team_boundaries: 'none: your team has no boundaries, so your answerer reads only the folder your working session is in (and asks you for anything else)' };
  // The topic is owner-written: data, quoted.
  return { team_boundaries: { version: tb.version, topic: quotedOwnerText(tb.boundaries.topic, 500) } };
}

/** What the member accepted (M11-SPEC §2: the relay's version). */
function acceptancePart(tb: TeamBoundaries, version: number | null, url: string | null) {
  if (version === null) return { accepted: 'unknown (the relay could not say which version you accepted)' };
  const where = url ? `in the console (${url})` : 'in the console';
  return { accepted: hasAccepted(version, tb.version) ? { version } : `nothing yet: teammates' questions to you are declined until you accept your team's boundaries ${where}` };
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
  const action = args.action ?? 'list';
  const team = deps.team();
  if (!team) return toolError('Not signed in to a team: run /team-relay:login first. Your folders are kept per team.');
  const file = memberFoldersPath(deps.env);
  let current: TeamSettings;
  try {
    current = teamSettings(readMemberSettings(file, deps.env), team);
  } catch (err) {
    return toolError(`your folders file cannot be used (${describeError(err)}): fix or remove ${file}`);
  }

  if (action === 'list') {
    if (args.path !== undefined) return toolError('list takes no path');
    const read = await deps.boundaries().catch(() => null);
    // Another team's document is used for nothing: not shown, not worked out.
    const otherTeam = read !== null && read.team !== team;
    const tb = otherTeam ? null : read;
    const version = tb?.boundaries ? await deps.acceptance().catch(() => null) : null;
    let gives: string | null = null;
    if (tb?.boundaries) {
      if (version === null) {
        gives = 'unknown: the relay could not say which version you accepted';
      } else if (!hasAccepted(version, tb.version)) {
        gives = "nothing: teammates' questions are declined until you accept your team's boundaries";
      } else {
        try {
          const set = await buildAllowedSet({ version: tb.version, member: current, env: deps.env, cache: deps.cache ?? null });
          gives = setSummary(set);
        } catch (err) {
          gives = `could not be worked out (${describeError(err)})`;
        }
      }
    }
    return toolJson({
      file,
      team,
      ...describeFolders(current.folders, deps.env),
      ...previousPart(current),
      ...teamPart(tb, otherTeam),
      ...(tb?.boundaries ? acceptancePart(tb, version, deps.console()) : {}),
      ...(gives ? { answers_come_from: gives } : {}),
      how_to_change: `Ask to add or remove a folder (/team-relay:folders add <path> or remove <path>); each change opens a dialog where you decide. ${whereToAccept(deps.console())}`,
    });
  }

  if (action !== 'add' && action !== 'remove') return toolError('action must be list, add or remove');
  const raw = args.path;
  if (typeof raw !== 'string' || raw.length === 0) return toolError(`${action} needs a path (absolute, or starting with ~/)`);
  let change: ReturnType<typeof changeMemberFolders>;
  try {
    change = changeMemberFolders(current.folders, action, raw, deps.env);
  } catch (err) {
    return toolError(describeError(err));
  }
  if (!change.changed) {
    return toolJson({ message: action === 'add' ? 'It is already there; nothing changed.' : 'It is not in the list; nothing changed.', ...describeFolders(current.folders, deps.env) });
  }
  if (!deps.elicit) {
    return toolError(
      `${NO_DIALOGS}, so your folders cannot be changed from here. ` +
        `Use /team-relay:setup, or edit ${file} yourself (mode 600): {"teams": {"${team}": {"folders": [...]}}}.`,
    );
  }
  const where = change.resolved && change.resolved !== raw ? `${raw} (${change.resolved})` : raw;
  const what =
    action === 'add'
      ? `Let your automatic answerer read ${where}? Teammates' questions may then be answered, without asking you, from its files (inside a git repository, only the files git tracks).`
      : `Stop your automatic answerer reading ${where}?`;
  let yes: boolean;
  try {
    yes = await decide(deps.elicit, what, action === 'add' ? 'Yes, add it' : 'Yes, remove it', 'No, leave it as it is');
  } catch (err) {
    return toolError(`the dialog could not be shown (${describeError(err)}); nothing changed`);
  }
  if (!yes) return toolJson({ message: 'You kept it as it was; nothing changed.' });
  try {
    // Read again: the file may have changed while the dialog was open.
    const fresh = readMemberSettings(file, deps.env);
    const again = changeMemberFolders(teamSettings(fresh, team).folders, action, raw, deps.env);
    writeMemberSettings(file, withTeam(fresh, team, { folders: again.folders }), deps.env);
    return toolJson({ message: `${action === 'add' ? 'Added' : 'Removed'}. Your automatic answerer uses it from its next answer.`, ...describeFolders(again.folders, deps.env) });
  } catch (err) {
    return toolError(`nothing changed (${describeError(err)})`);
  }
}
