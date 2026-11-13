// The host (M8-SPEC §1–§5, §7): the channel server of a channel working session answers the
// member's teammates on its own, within the folder the session works in.
//
// - It holds the machine's answering lock (answering-lock.ts); only then does it read the
//   `inbox` stream. Without the lock it retries every 30 s and answers nothing. Taking over is
//   announced in the working session and by a desktop notification (§7 item 4).
// - For each question or capability call: ack at the relay at once, then (one at a time) run
//   a locked-down headless Claude in the scope folder (headless.ts) that finishes with the
//   host's `reply` tool, over a private socket (host-socket.ts, answer-tools.ts).
// - What ships on its own and what waits for the member is decided here, deterministically
//   (§3): reads outside the folder and every capability tool wait (the permission tool); a
//   draft ships only when the answerer did not flag it, the secret screen passes it, no file
//   it read has a name that suggests secrets and every search it made was recorded (the read
//   trail, §7 item 1), and no approval was needed during the run. Everything else waits in
//   the ApprovalQueue, which only the member's dialog or page decides, and which denies on
//   timeout. Past the volume limits (§7 item 5) a question waits for approval to run at all.
// - The member is told in the working session (a status event), by a desktop notification
//   (fixed text), and the asker's console by a `waiting` tool event; grouped (§7 item 5).
// - Nothing is lost on stop (§7 item 12): the inbox cursor moves past a question only once it
//   is fully handled (answered, declined or lapsed), so one in flight when the session closes
//   is received again by the next host, which skips it if the relay says it is answered. The
//   shared folder is withdrawn when the host stops.
//
// Teammate text is data throughout: it reaches the answerer only inside a nonce-framed block
// of its prompt, and the working session only quoted and neutralised in a status event.
//
// Boundary mode (M10-SPEC §2, §3), for a team whose owner set boundaries (since 13 Nov 2026 the
// topic alone): the boundaries are read at start and before every run (a run uses one version),
// and each run gets the allowed set built from the folders the member chose for the team on
// this Mac (member-folders.ts, boundary-set.ts). The answerer has Read only, in an empty private
// directory, plus the host's list_files and search_files (boundary-tools.ts); every Read reaches the permission tool, which allows a file in the set at
// once and denies anything else at once. Nothing waits for the member except a capability call:
// an off-topic answer becomes a fixed decline, a draft the secret screen (or the read trail)
// flags becomes a fixed "ask <member> directly" with a one-line note to the member, past the
// volume limits a fixed "too many questions" goes back, and everything else is sent. No share is
// published in boundary mode: the names of the member's chosen folders are seen by nobody else
// (13 Nov 2026). Teams without boundaries keep M8.
// §7.1: nothing accepted → the fixed "<member> hasn't set up answering" decline without a run.
// M11-SPEC §2: the accepted version comes from the relay (the member accepts in the console),
// read before every run (and at start); accepted means a version from 1 to the current one
// (member-folders.ts hasAccepted); when it cannot be read the question gets the fixed busy line
// (nothing is taken as accepted). §7.3: an
// allowed Read is a snapshot (snapshot.ts): the answerer reads a copy in the run's private
// folder, never a member path. §7.6: while the boundaries were never read, every question gets
// the fixed busy line, never an approval item.
//
// The background answerer (M11-SPEC §1, daemon.ts) runs this host with `background`: it holds the
// lock as `daemon`, answers in boundary mode only (a team without boundaries gets the fixed
// "<member> hasn't set up answering" decline, never folder mode), runs no capability (a call
// gets a fixed reply, and none is published or offered to the answerer) and so never holds an
// approval item; past a volume limit a question gets the fixed busy line.

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ActiveRequests, deadlineOf } from './active.js';
import { heldBy, lockPath, tryAcquire, type Acquired, type LockInfo } from './answering-lock.js';
import { consoleUrl } from './console-url.js';
import { ApprovalQueue, type ItemContext, type Pending } from './approvals.js';
import { ApprovalsPage } from './approvals-page.js';
import { reviewWithElicitation, summaryText, type Elicit } from './approvals-review.js';
import { approvalsSentence, clearApprovalsState, statePath, writeApprovalsState } from './approvals-state.js';
import { openInBrowser } from './console-open.js';
import type { Boundaries, TeamBoundaries } from './boundaries-types.js';
import { buildAllowedSet, denyContext, GitCache, setSummary, validBoundaries, type AllowedSet, type DenyCtx } from './boundary-set.js';
import { listFiles, searchFiles, type ToolOutcome } from './boundary-tools.js';
import { credentialHit, realOr, within } from './deny-list.js';
import { defaultManifestPath, discoveryPayload, exposedCapabilities } from './exposed.js';
import {
  boundaryRubric,
  buildPrompt,
  childArgs,
  childEnv,
  childMcpConfig,
  childSettings,
  rubric,
  runChild,
  RUN_LIMIT_MS,
  type WorkItem,
} from './headless.js';
import { HostSocket, newToken } from './host-socket.js';
import { codePointLength, hasLoneSurrogate, loadManifest, validateManifest } from './manifest.js';
import { hasAccepted, memberFoldersPath, readTeamSettings, type TeamSettings } from './member-folders.js';
import { envelopeToNotification, neutraliseChannelTags, RecentIds } from './notify.js';
import { APPROVAL_TEXT, TAKEOVER_TEXT, notifyCommand, type NoticeText } from './notify-desktop.js';
import { sensitiveName } from './read-trail-core.js';
import { RelayError, type AuthMode, type Envelope, type Me, type RelayClient, backoffDelay } from './relay-client.js';
import { relayCredentialDirs, scopeFolder, type Scope } from './scope.js';
import { screenDraft } from './secret-screen.js';
import { MAX_RUN_SNAPSHOT_BYTES, MAX_SNAPSHOT_BYTES, removeStaleSnapshotDirs, snapshotDirPrefix, snapshotRead, snapshotRun, type SnapshotRun } from './snapshot.js';
import { splitToolName } from './tool-event-core.js';
import { canonicalJson, describeError, isPlainObject } from './tool-util.js';

export const POLITE_DECLINE = (member: string) => `I couldn't answer this automatically; ${member} hasn't approved it.`;
/** M10-SPEC §3: the fixed replies in boundary mode. */
export const OFF_TOPIC_REPLY = (team: string) => `I only answer questions about ${team} topics.`;
export const WITHHELD_REPLY = (member: string) => `This answer may contain a credential, so it wasn't sent. Ask ${member} directly.`;
export const BUSY_REPLY = 'Too many questions right now; try again later.';
/** M10-SPEC §7.1: the member has not accepted the team's boundaries yet. */
export const NOT_SET_UP_REPLY = (member: string) => `${member} hasn't set up answering for this team yet.`;
/** M11-SPEC §1: the background answerer runs no capability. */
export const NO_CAPABILITY_REPLY = (member: string) => `${member}'s background answerer does not run capabilities; ask ${member} directly.`;
/** M10-SPEC §3: why a Read outside the allowed set is denied (at once, without asking). */
export const OUTSIDE_SET =
  "That file is not one you may read for this team: only files in the folders the member chose (in a git repository, only the files git tracks). " +
  'Use mcp__host__list_files or mcp__host__search_files to find what you can read; do not try to reach it another way.';
/** M10-SPEC §7.3: why an allowed file was not copied for the answerer. */
export const TOO_LARGE_READ = `That file is larger than ${MAX_SNAPSHOT_BYTES / (1024 * 1024)} MB, so it cannot be read. Answer without it, and say so.`;
export const UNSAFE_READ = 'That file changed or is not a regular file, so it cannot be read now. Answer without it, and say so.';
/** M10-SPEC §7.3: why a Read past the run's total copy cap is denied. */
export const RUN_CAP_READ = `This answer has already read ${MAX_RUN_SNAPSHOT_BYTES / (1024 * 1024)} MB of files, the most one answer may, so this file cannot be read. Answer with what you have, and say so.`;
const REPLY_DATA_LIMIT = 64 * 1024;
const LOCK_RETRY_MS = 30_000;
const QUOTE_LIMIT = 200;

/** M8-SPEC §7 item 5: at most this many questions from one asker wait to be answered automatically. */
export const MAX_QUEUED_PER_ASKER = 3;
/** M8-SPEC §7 item 5: at most this many automatic runs in any hour. */
export const MAX_RUNS_PER_HOUR = 20;
const HOUR_MS = 3_600_000;
/** M8-SPEC §7 item 5: at most one desktop notification, and one push quoting a teammate, per this long. */
export const NOTICE_GAP_MS = 5 * 60_000;
/** How long stopping waits for the shared folder to be withdrawn at the relay. */
const WITHDRAW_MS = 1500;

/** How the relay is reached, so the answerer's own servers can reach it the same way. */
export type HostConnection = {
  mode: AuthMode;
  url: string;
  team: string;
  credentialsFile?: string | undefined;
  tokenFile?: string | undefined;
  token?: string | undefined;
  gcloudAccount?: string | undefined;
};

export type HostOptions = {
  client: RelayClient;
  me: Me;
  env: NodeJS.ProcessEnv;
  connection: HostConnection;
  /** A status event into the working session. */
  push: (content: string) => Promise<void> | void;
  log: (line: string) => void;
  cwd?: string;
  /** Where the bundles are (dist/). */
  distDir?: string;
  node?: string;
  /**
   * The claude each run starts: a path, or a function asked afresh before every run (the
   * background answerer's: an update of the Claude desktop app moves its claude while the host
   * runs). Null from the function: claude on PATH.
   */
  claudeBin?: string | (() => string | null);
  lockFile?: string;
  stateFile?: string;
  lockRetryMs?: number;
  /** Desktop notification (fixed text); default: osascript / notify-send. */
  notify?: (text: NoticeText) => void;
  /** Opens the fallback page; default: the redirect-file opener. */
  openPage?: (url: string) => void;
  /** The volume limits and the notice gap (tests make them small). */
  limits?: { perAsker?: number; perHour?: number; noticeGapMs?: number };
  now?: () => number;
  /**
   * M11-SPEC §1: the background answerer. Holds the lock as `daemon`, answers in boundary mode
   * only, runs no capability and never holds an approval item.
   */
  background?: boolean;
};

export type HostStatus = {
  answering: boolean;
  why_not?: string;
  /** M10-SPEC: 'boundaries' when the team has boundaries (the last version read), else 'folder' (M8). */
  mode: 'boundaries' | 'folder';
  folder: string | null;
  reads_without_asking: boolean;
  approvals_pending: number;
};

function ownDist(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return basename(here) === 'src' ? join(here, '..', 'dist') : here;
}

function singleLine(text: string, limit: number): string {
  const flat = neutraliseChannelTags(text).replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/** One question or capability call from the inbox, until it is fully handled. */
type Job = {
  item: WorkItem;
  /** Its inbox seq: the cursor moves past it only once it is fully handled. */
  seq: number;
  /** The member allowed it to run past the volume limits. */
  approved: boolean;
};

type Run = {
  job: Job;
  item: WorkItem;
  replied: boolean;
  /** The reply went into the approval queue: the job is handled when that settles. */
  drafted: boolean;
  approvalNeeded: boolean;
  approvalRequested: string | null;
  waiting: number;
  cwd: string;
  denyDirs: string[];
  /** The read trail (§7 item 1): files read or searched with names that suggest secrets. */
  sensitiveReads: Set<string>;
  /** Searches reported before they ran whose results have not been reported yet. */
  openSearches: Set<string>;
  /** M10-SPEC: the run's allowed set and the team's name, in boundary mode (one version per run). */
  boundary: BoundaryRun | null;
  /** M10-SPEC §7.3: the run's Read snapshots and their private folder (boundary mode only). */
  snapshots: SnapshotRun | null;
};

/**
 * M10-SPEC §7.1: whether the member accepted the team's boundaries, as last worked out.
 * `unknown`: the relay could not say which version the member accepted (M11-SPEC §2).
 */
type Acceptance = { state: 'accepted' | 'not_accepted' | 'unreadable' | 'unknown'; version: number };

type BoundaryRun = { set: AllowedSet; teamName: string; ctx: DenyCtx };

export class AnswerHost {
  readonly queue: ApprovalQueue;
  private readonly env: NodeJS.ProcessEnv;
  private readonly scope: Scope;
  private readonly dist: string;
  private readonly node: string;
  private readonly lockFile: string;
  private readonly stateFile: string;
  private readonly now: () => number;
  private readonly perAsker: number;
  private readonly perHour: number;
  private readonly noticeGapMs: number;
  private readonly controller = new AbortController();
  private lock: Acquired | null = null;
  private holder: LockInfo | null = null;
  private socket: HostSocket | null = null;
  private page: ApprovalsPage | null = null;
  private work: Job[] = [];
  private working = false;
  private current: Run | null = null;
  private reviewing = false;
  private claudeMissing = false;
  private readonly recent = new RecentIds(500);
  private whyNot: string | null = 'starting';
  /** When each automatic run started, for the hourly limit. */
  private runStarts: number[] = [];
  private lastDesktop = Number.NEGATIVE_INFINITY;
  private lastQuoted = Number.NEGATIVE_INFINITY;
  /** Whether a folder was published as shared, so stopping withdraws it. */
  private sharing = false;
  // The inbox cursor (§7 item 12).
  private readAfter: number | undefined = undefined;
  private readonly open = new Set<number>();
  private maxSeen = 0;
  private cursorWanted = 0;
  private cursorPosted = 0;
  private cursorChain: Promise<void> = Promise.resolve();
  // M10-SPEC §1, §2: the team's boundaries as last read (null: never read), the last allowed
  // set, the shares published, and git's ls-files results by work tree.
  private boundaries: TeamBoundaries | null = null;
  private lastSet: AllowedSet | null = null;
  private shares: string[] = [];
  /** M10-SPEC §7.1: the member's acceptance as last worked out, and the last version a status line was pushed for. */
  private acceptance: Acceptance | null = null;
  private acceptanceNoted = -1;
  /** M11-SPEC §1: no new run starts (the background answerer is finishing to restart). */
  private finishing = false;
  private readonly gitCache = new GitCache();

  constructor(private readonly o: HostOptions) {
    this.env = o.env;
    this.now = o.now ?? Date.now;
    this.queue = new ApprovalQueue({ now: this.now });
    this.scope = scopeFolder(o.cwd ?? process.cwd(), o.env);
    this.dist = o.distDir ?? ownDist();
    this.node = o.node ?? process.execPath;
    this.lockFile = o.lockFile ?? lockPath(o.env);
    this.stateFile = o.stateFile ?? statePath(o.env);
    this.perAsker = o.limits?.perAsker ?? MAX_QUEUED_PER_ASKER;
    this.perHour = o.limits?.perHour ?? MAX_RUNS_PER_HOUR;
    this.noticeGapMs = o.limits?.noticeGapMs ?? NOTICE_GAP_MS;
    this.queue.onChange((e) => this.onQueueChange(e.type, e.item, e.outcome));
  }

  get stopped(): boolean {
    return this.controller.signal.aborted;
  }

  get folder(): Scope {
    return this.scope;
  }

  /** Whether the team has boundaries, as last read (M10-SPEC §3: then nothing waits for the member but a capability call). */
  private get boundaryMode(): boolean {
    return this.boundaries?.boundaries != null;
  }

  /**
   * M10-SPEC §3, §7.6: past a volume limit a question is declined with the fixed busy line, never
   * held for approval, in boundary mode and while the boundaries were never read (whether the
   * team has any is unknown then). The background answerer never holds one (M11-SPEC §1).
   */
  private get declinesWhenBusy(): boolean {
    return this.o.background === true || this.boundaries === null || this.boundaryMode;
  }

  /** Whether an answerer run is in progress now. */
  get busy(): boolean {
    return this.current !== null;
  }

  /** Where the member accepts the team's boundaries (M11-SPEC §2): the console. */
  private get console(): string {
    return consoleUrl(this.o.client.url);
  }

  status(): HostStatus {
    const boundary = this.boundaryMode;
    return {
      answering: this.lock !== null && !this.stopped,
      ...(this.lock ? {} : { why_not: this.whyNot ?? 'not started' }),
      mode: boundary ? 'boundaries' : 'folder',
      folder: boundary ? null : this.scope.share,
      reads_without_asking: boundary ? this.lastSet !== null && this.lastSet.files.size > 0 : this.scope.qualifies,
      approvals_pending: this.queue.size,
    };
  }

  /** The whoami fields (M8-SPEC §5; M10-SPEC: boundary mode and what is in it). */
  whoamiFields(): Record<string, unknown> {
    const s = this.status();
    const sentence = approvalsSentence(s.approvals_pending);
    const set = this.lastSet;
    const folders = set ? set.areas.map((a) => singleLine(a.name.replace(/^[a-z]+:/, ''), 200)) : [];
    return {
      answering_automatically: s.answering,
      ...(s.why_not ? { answering_note: s.why_not } : {}),
      answering_mode: s.mode,
      answering_folder: s.folder,
      ...(s.mode === 'boundaries'
        ? {
            boundaries_version: this.boundaries?.version ?? null,
            answering_from: set
              ? {
                  your_folders: folders,
                  files: set.files.size,
                  summary: singleLine(setSummary(set), 600),
                }
              : null,
            ...(set && set.notes.length ? { answering_from_notes: set.notes.slice(0, 10) } : {}),
            ...this.acceptanceFields(),
            answering_rules:
              'Inside the boundaries answers go out on their own; reads of anything else are denied at once; off-topic questions get a fixed decline. Change your folders with /team-relay:folders.',
          }
        : {}),
      approvals_pending: s.approvals_pending,
      ...(sentence ? { approvals_notice: `${sentence}: run /team-relay:approvals` } : {}),
    };
  }

  // -- M10-SPEC §1, §2: boundaries and the allowed set ---------------------------------------------

  /**
   * The team's boundaries, read now (at start and before every run). When the relay cannot be
   * read, or answers with a document that is not this team's, the version read last is used;
   * null when none was ever read.
   */
  private async readBoundaries(): Promise<TeamBoundaries | null> {
    try {
      const tb = await this.o.client.boundaries({ attempts: 2, signal: this.controller.signal });
      if (!validBoundaries(tb)) throw new Error('the relay answered something that is not a boundaries document');
      if (tb.team !== this.o.me.team) throw new Error("the relay answered with another team's boundaries");
      if (this.boundaries && this.boundaries.version !== tb.version) this.o.log(`the team's boundaries changed (version ${this.boundaries.version} → ${tb.version})`);
      this.boundaries = tb;
    } catch (err) {
      if (!this.stopped) this.o.log(`the team's boundaries could not be read (${describeError(err)})${this.boundaries ? `; using version ${this.boundaries.version}` : ''}`);
    }
    return this.boundaries;
  }

  /** The member's folders for the team (member-folders.ts). */
  private teamSettings(): TeamSettings | { error: string } {
    try {
      return readTeamSettings(memberFoldersPath(this.env), this.env, this.o.me.team);
    } catch (err) {
      return { error: describeError(err) };
    }
  }

  /**
   * M11-SPEC §2: the boundaries version the member accepted, read from the relay now (before every
   * run). Null when the relay cannot say: nothing is taken as accepted then.
   */
  private async acceptedVersion(): Promise<number | null> {
    try {
      const a = await this.o.client.acceptance({ attempts: 2, signal: this.controller.signal });
      const v = isPlainObject(a) ? a.version : undefined;
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error('the relay answered something that is not an acceptance');
      return v;
    } catch (err) {
      if (!this.stopped) this.o.log(`which boundaries you accepted could not be read (${describeError(err)})`);
      return null;
    }
  }

  /**
   * Whether the member accepted the team's boundaries (M11-SPEC §2: the version the relay holds,
   * from 1 to the current one), with their folders for the team. Null when the member's folders
   * file cannot be used (nothing is answered then); 'unknown' when the relay could not say what
   * was accepted (the question gets the busy line).
   */
  private async effective(tb: TeamBoundaries): Promise<{ accepted: boolean; settings: TeamSettings } | 'unknown' | null> {
    const settings = this.teamSettings();
    if ('error' in settings) {
      this.o.log(`your folders file cannot be used (${settings.error}); questions are declined until it is fixed`);
      this.acceptance = { state: 'unreadable', version: tb.version };
      return null;
    }
    const version = await this.acceptedVersion();
    if (version === null) {
      this.acceptance = { state: 'unknown', version: tb.version };
      return 'unknown';
    }
    const accepted = hasAccepted(version, tb.version);
    this.acceptance = { state: accepted ? 'accepted' : 'not_accepted', version: tb.version };
    return { accepted, settings };
  }

  /** M10-SPEC §7.1: one status line per version the member has not accepted (or cannot use their folders file). */
  private noteAcceptance(tb: TeamBoundaries): void {
    const a = this.acceptance;
    if (!a || a.state === 'accepted' || a.state === 'unknown' || this.acceptanceNoted === tb.version || this.stopped) return;
    this.acceptanceNoted = tb.version;
    const team = this.o.me.team;
    const text =
      a.state === 'not_accepted'
        ? `team-relay: ${team} has boundaries (version ${tb.version}) you have not accepted yet, so teammates' questions to you are declined. Open the console to see and accept them: ${this.console}`
        : `team-relay: your folders file cannot be used, so teammates' questions to you are declined. Run /team-relay:folders to see why.`;
    void Promise.resolve(this.o.push(text)).catch(() => {});
  }

  /** The whoami fields about acceptance (M10-SPEC §7.1). */
  private acceptanceFields(): Record<string, unknown> {
    const a = this.acceptance;
    if (!a) return {};
    const say: Record<Acceptance['state'], string> = {
      accepted: 'You accepted these boundaries; answers come from the folders you chose.',
      not_accepted: `You have not accepted your team's boundaries yet, so teammates' questions are declined: accept them in the console (${this.console}).`,
      unreadable: "Your folders file cannot be used, so teammates' questions are declined: run /team-relay:folders.",
      unknown: "Which boundaries you accepted could not be read from the relay just now, so teammates' questions get a busy reply until it can.",
    };
    return { boundaries_acceptance: a.state, boundaries_acceptance_note: singleLine(say[a.state], 800) };
  }

  private async allowedSet(tb: TeamBoundaries, settings: TeamSettings): Promise<AllowedSet> {
    const set = await buildAllowedSet({
      version: tb.version,
      member: { folders: settings.folders },
      env: this.env,
      cache: this.gitCache,
    });
    for (const n of set.notes) this.o.log(n);
    this.lastSet = set;
    return set;
  }

  /** Publish the shared folder's name when it changed (folder mode only; boundary mode publishes none). */
  private async publishShares(names: string[]): Promise<void> {
    if (this.stopped || (names.length === this.shares.length && names.every((n, i) => n === this.shares[i]))) return;
    this.shares = names;
    this.sharing = names.length > 0;
    await this.publish(names, { attempts: 2, signal: this.controller.signal });
  }

  // -- lifecycle ------------------------------------------------------------------------------

  /** Take the lock (retrying while another answerer holds it), then answer until stopped. */
  async start(): Promise<void> {
    const retry = this.o.lockRetryMs ?? LOCK_RETRY_MS;
    /** When this host took the answering lock (wall clock, as the file system keeps it). */
    let lockedAt = Date.now();
    if (!this.scope.qualifies && !this.o.background) {
      this.o.log(`the working folder cannot be read automatically (${this.scope.reason}): every read will need your approval`);
    }
    while (!this.stopped) {
      let got;
      try {
        got = tryAcquire(this.lockFile, this.o.background ? 'daemon' : 'host');
      } catch (err) {
        this.whyNot = `the answering lock could not be taken (${describeError(err)})`;
        this.o.log(this.whyNot);
        await this.sleep(retry);
        continue;
      }
      if (got.ok) {
        this.lock = got;
        this.whyNot = null;
        lockedAt = Date.now();
        break;
      }
      if (this.holder?.pid !== got.holder?.pid) this.o.log(`not answering: ${heldBy(got.holder)} answers for you`);
      this.holder = got.holder;
      this.whyNot = `${heldBy(got.holder)} answers for you`;
      await this.sleep(retry);
    }
    if (this.stopped) return;
    try {
      this.socket = new HostSocket();
      await this.socket.listen();
    } catch (err) {
      this.o.log(`cannot answer automatically: the private socket could not be made (${describeError(err)})`);
      this.whyNot = 'the private socket could not be made';
      this.lock?.release();
      this.lock = null;
      return;
    }
    // M10-SPEC §7.3: snapshot folders a host of this member left behind (it ended without
    // cleaning up) go now: only those whose host process is gone, so never another live host's.
    const stale = await removeStaleSnapshotDirs(dirname(this.socket.dir), lockedAt);
    if (stale > 0) this.o.log(`removed ${stale} snapshot ${stale === 1 ? 'folder' : 'folders'} an earlier answering host left behind`);
    this.writeState();
    const tb = await this.readBoundaries();
    if (this.stopped) return;
    if (tb?.boundaries) {
      const e = await this.effective(tb);
      if (this.stopped) return;
      const set = e && e !== 'unknown' && e.accepted ? await this.allowedSet(tb, e.settings) : null;
      if (this.stopped) return;
      if (!set) this.lastSet = null;
      this.announceBoundaries(tb, set);
      this.noteAcceptance(tb);
      // Spec decision 5 (13 Nov 2026): nobody else sees a member's folder names, so nothing is
      // published as shares in boundary mode.
      this.shares = [];
      this.sharing = false;
      await this.publish(this.shares, { attempts: 2, signal: this.controller.signal });
      this.o.log(
        set
          ? `answering automatically within the team's boundaries (version ${tb.version}): ${setSummary(set)}`
          : e === 'unknown'
            ? `which boundaries you accepted could not be read (version ${tb.version}): questions get the busy reply until it can`
            : `the team's boundaries (version ${tb.version}) are not accepted yet: questions are declined`,
      );
    } else if (this.o.background) {
      // M11-SPEC §1: never folder mode. Without boundaries (or before they are read) nothing is answered.
      this.shares = [];
      this.sharing = false;
      await this.publish([], { attempts: 2, signal: this.controller.signal });
      this.o.log(tb ? "your team has no boundaries: teammates' questions are declined until an owner sets them" : "the team's boundaries could not be read: questions get the busy reply until they can");
    } else {
      this.announce();
      const shares = this.scope.qualifies && this.scope.share ? [this.scope.share] : [];
      this.shares = shares;
      this.sharing = shares.length > 0;
      await this.publish(shares, { attempts: 2, signal: this.controller.signal });
      this.o.log(`answering automatically in ${this.scope.path}${this.scope.qualifies ? '' : ' (no automatic reads)'}`);
    }
    await this.inboxLoop();
  }

  /** §7 item 4: taking over answering is said in the working session and on the desktop. */
  private announce(): void {
    const reads = this.scope.qualifies
      ? 'reads inside it are automatic.'
      : `reads inside it are not automatic (${this.scope.reason}): every read needs your approval.`;
    void Promise.resolve(this.o.push(`team-relay: This session now answers teammates automatically from ${this.scope.path}; ${reads}`)).catch(() => {});
    this.notifyDesktop(TAKEOVER_TEXT);
  }

  /**
   * M10-SPEC §3: taking over in boundary mode says what the answers come from (names only), or,
   * with nothing accepted (null), that questions are declined until the member accepts (§7.1).
   */
  private announceBoundaries(tb: TeamBoundaries, set: AllowedSet | null): void {
    const text = set
      ? `team-relay: This session now answers teammates automatically within your team's boundaries (version ${tb.version}): ${singleLine(setSummary(set), 600)}. ` +
        'Reads of anything else are denied without asking, off-topic questions are declined, and nothing waits for your approval except a capability call. ' +
        'Change your folders with /team-relay:folders.'
      : `team-relay: This session now answers teammates for you, but declines their questions until you accept your team's boundaries in the console: ${this.console}`;
    void Promise.resolve(this.o.push(text)).catch(() => {});
    this.notifyDesktop(TAKEOVER_TEXT);
  }

  /**
   * M11-SPEC §1: start no new run, let the one in progress end, then stop (the lock released).
   * Questions not yet answered are received again by the next host (§7 item 12).
   */
  async finishAndStop(pollMs = 200): Promise<void> {
    this.finishing = true;
    while (this.current !== null && !this.stopped) await new Promise((r) => setTimeout(r, pollMs));
    await this.stop();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.controller.abort();
    // Whatever waits is withdrawn, not decided: the questions it belongs to are received again
    // by the next host, because the cursor never moved past them.
    this.queue.cancelAll();
    await this.page?.stop().catch(() => {});
    this.page = null;
    await this.socket?.close().catch(() => {});
    this.socket = null;
    try {
      clearApprovalsState(this.stateFile);
    } catch {
      // nothing to clear
    }
    const held = this.lock !== null;
    this.lock?.release();
    this.lock = null;
    // §7 item 12: the shared folder is withdrawn (the manifest re-published without it).
    if (held && this.sharing) {
      this.sharing = false;
      await this.publish([], { attempts: 1, timeoutMs: WITHDRAW_MS, signal: AbortSignal.timeout(WITHDRAW_MS) });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.stopped) return resolve();
      const t = setTimeout(done, ms);
      const signal = this.controller.signal;
      function done() {
        clearTimeout(t);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done);
    });
  }

  /** M4-SPEC §3 / M8-SPEC §1: the capabilities this member runs, and the folder it shares. */
  private async publish(shares: string[], opts: { attempts: number; timeoutMs?: number; signal: AbortSignal }): Promise<void> {
    try {
      // M11-SPEC §1: the background answerer runs no capability, so it publishes none.
      const exposed = this.o.background ? [] : exposedCapabilities(loadManifest(this.env.MANIFEST_PATH || defaultManifestPath()), this.env).exposed;
      const payload = validateManifest(discoveryPayload(exposed, shares.map((name) => ({ name }))));
      const res = await this.o.client.publishManifest(this.o.me.member, payload, opts);
      this.o.log(`published capabilities: ${res.capabilities.join(', ') || '(none)'}; shared folder: ${shares.join(', ') || '(none)'}`);
    } catch (err) {
      if (!opts.signal.aborted || shares.length === 0) this.o.log(`the capability manifest was not published (${describeError(err)})`);
    }
  }

  // -- the inbox and its cursor (§7 item 12) -----------------------------------------------------

  private async inboxLoop(): Promise<void> {
    let failures = 0;
    const { client } = this.o;
    while (!this.stopped) {
      const started = this.now();
      try {
        const q = { wait: 25, limit: 50, ...(this.readAfter !== undefined ? { after: this.readAfter } : {}) };
        const page = await client.readStream('inbox', q, { attempts: 1, signal: this.controller.signal });
        failures = 0;
        if (this.readAfter === undefined) {
          // The first read starts at the stored cursor: everything at or before it is handled.
          this.readAfter = page.cursor;
          this.cursorWanted = this.cursorPosted = page.cursor;
        }
        for (const envelope of page.messages) {
          if (this.stopped) return;
          const seq = envelope.seq;
          const tracked = Number.isSafeInteger(seq) && seq > (this.readAfter ?? 0);
          if (tracked) {
            this.open.add(seq);
            this.maxSeen = Math.max(this.maxSeen, seq);
          }
          const kept = await this.accept(envelope, seq);
          // Only after it is accepted: an envelope whose acknowledgement failed is read again.
          if (tracked) {
            this.readAfter = seq;
            if (!kept) this.handled(seq);
          }
        }
        if (page.messages.length === 0 && this.now() - started < 1000) await this.sleep(1000);
      } catch (err) {
        if (this.stopped) return;
        if (err instanceof RelayError && err.status === 401) {
          this.o.log('the relay refused the sign-in while reading the inbox; answering stops until you sign in again');
          return;
        }
        const delay = backoffDelay(failures++);
        this.o.log(`inbox read failed (${describeError(err)}); retrying in ${Math.round(delay / 1000)} s`);
        await this.sleep(delay);
      }
    }
  }

  /**
   * A question is fully handled: the cursor may move past it, and past every later one that is
   * handled too, but never past one still open.
   */
  private handled(seq: number): void {
    if (this.stopped) return;
    this.open.delete(seq);
    let target = this.maxSeen;
    for (const s of this.open) target = Math.min(target, s - 1);
    if (target <= this.cursorWanted) return;
    this.cursorWanted = target;
    this.cursorChain = this.cursorChain.then(() => this.postCursor());
  }

  private async postCursor(): Promise<void> {
    const want = this.cursorWanted;
    if (this.stopped || want <= this.cursorPosted) return;
    try {
      await this.o.client.ackCursor('inbox', want, { attempts: 2, signal: this.controller.signal });
      this.cursorPosted = Math.max(this.cursorPosted, want);
    } catch (err) {
      if (!this.stopped) this.o.log(`the inbox cursor was not moved (${describeError(err)}); it moves with the next handled question`);
      // Asked again next time: the wanted position stays ahead of the posted one.
      this.cursorWanted = this.cursorPosted;
    }
  }

  /**
   * One inbox envelope: acknowledged at the relay at once, then queued for an answerer.
   * Returns whether a job was kept for it (false: nothing more to do, it is handled).
   */
  private async accept(envelope: Envelope, seq: number): Promise<boolean> {
    const { client, me } = this.o;
    if (this.recent.has(envelope.id)) return false;
    const n = envelopeToNotification(envelope, { stream: 'inbox', team: me.team, member: me.member });
    if ('reject' in n) {
      this.o.log(`skipped inbox seq ${String(envelope.seq)}: ${n.reject}`);
      return false;
    }
    let ack: Record<string, unknown>;
    try {
      ack = (await client.ackRequest(envelope.request_id, { attempts: 2, signal: this.controller.signal })) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof RelayError && [404, 409, 410].includes(err.status)) {
        this.recent.add(envelope.id);
        this.o.log(`${envelope.request_id} can no longer be answered (${err.status}); skipped`);
        return false;
      }
      throw err;
    }
    this.recent.add(envelope.id);
    // Received again after a stop, and answered meanwhile (or by the host before): skipped.
    if (ack.status === 'answered') {
      this.o.log(`${envelope.request_id} is already answered; skipped`);
      return false;
    }
    const data = envelope.data ?? {};
    const deadline =
      deadlineOf(ack.answer_deadline) ?? deadlineOf(data.answer_deadline) ?? new Date(this.now() + 86_400_000).toISOString();
    const item: WorkItem = {
      request_id: envelope.request_id,
      from: envelope.from,
      kind: envelope.type === 'capability_call' ? 'capability_call' : 'question',
      question: typeof data.question === 'string' ? data.question : '',
      answer_deadline: Date.parse(deadline),
      ...(envelope.type === 'capability_call'
        ? { capability: { name: String(data.capability), params: isPlainObject(data.params) ? data.params : {} } }
        : {}),
    };
    const job: Job = { item, seq, approved: false };
    if (this.o.background && item.kind === 'capability_call') {
      // M11-SPEC §1: nothing here ever waits for the member, so no capability runs.
      try {
        await this.sendReply(item.request_id, NO_CAPABILITY_REPLY(me.member), null);
        this.o.log(`declined ${item.request_id}: the background answerer runs no capability`);
      } catch (err) {
        this.o.log(`the answer to ${item.request_id} could not be sent (${describeError(err)})`);
      }
      return false;
    }
    // §7 item 5: at most this many questions from one asker wait to be answered automatically.
    const queued = this.work.filter((j) => j.item.from === item.from).length;
    if (queued >= this.perAsker) {
      // M10-SPEC §3: in boundary mode a question past the limit is declined, never held.
      if (this.declinesWhenBusy) {
        await this.declineBusy(job, `${item.from} already has ${queued} questions waiting (at most ${this.perAsker})`);
        return false;
      }
      this.askToRun(job, `${item.from} already has ${queued} questions waiting to be answered automatically (at most ${this.perAsker})`);
      return true;
    }
    this.work.push(job);
    void this.drain();
    return true;
  }

  /** The job is over: the cursor may pass it (unless the host is stopping, when it is received again). */
  private finish(job: Job): void {
    if (Number.isSafeInteger(job.seq)) this.handled(job.seq);
  }

  private async drain(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      while (!this.stopped && !this.finishing) {
        const job = this.work.shift();
        if (!job) break;
        const item = job.item;
        if (this.now() >= item.answer_deadline) {
          this.o.log(`${item.request_id} passed its answer deadline before it could be answered`);
          this.finish(job);
          continue;
        }
        if (!job.approved) {
          // §7 item 5: at most this many automatic runs in any hour.
          const since = this.now() - HOUR_MS;
          this.runStarts = this.runStarts.filter((t) => t > since);
          if (this.runStarts.length >= this.perHour) {
            if (this.declinesWhenBusy) {
              await this.declineBusy(job, `${this.runStarts.length} questions were answered automatically in the last hour (at most ${this.perHour})`);
              this.finish(job);
              continue;
            }
            this.askToRun(job, `${this.runStarts.length} questions were answered automatically in the last hour (at most ${this.perHour})`);
            continue;
          }
          this.runStarts.push(this.now());
        }
        try {
          const ran = await this.answer(job);
          // A question declined without a run does not count towards the hourly limit.
          if (!ran && !job.approved) this.runStarts.pop();
        } catch (err) {
          this.o.log(`answering ${item.request_id} failed: ${describeError(err)}`);
          this.finish(job);
        }
      }
    } finally {
      this.working = false;
    }
  }

  /** M10-SPEC §3: past a volume limit in boundary mode, the fixed "too many questions" reply. */
  private async declineBusy(job: Job, why: string): Promise<void> {
    try {
      await this.sendReply(job.item.request_id, BUSY_REPLY, null);
      this.o.log(`declined ${job.item.request_id}: ${why}`);
    } catch (err) {
      this.o.log(`the answer to ${job.item.request_id} could not be sent (${describeError(err)})`);
    }
  }

  /** §7 item 5: past a volume limit, a question waits for the member's approval to run at all. */
  private askToRun(job: Job, reason: string): void {
    const { outcome } = this.queue.add(this.ctxOf(job.item), { type: 'run', reason }, job.item.answer_deadline);
    void outcome.then(async (o) => {
      if (o === 'cancelled') return; // the host is stopping: received again by the next one
      if (o === 'allow') {
        job.approved = true;
        this.work.push(job);
        void this.drain();
        return;
      }
      if (o === 'decline') {
        try {
          await this.sendReply(job.item.request_id, POLITE_DECLINE(this.o.me.member), null);
          this.o.log(`declined ${job.item.request_id} politely`);
        } catch (err) {
          this.o.log(`the answer to ${job.item.request_id} could not be sent (${describeError(err)})`);
        }
      } else {
        this.o.log(`nothing sent for ${job.item.request_id} (${o})`);
      }
      this.toolEvent(job.item.request_id, 'approval', 'error');
      this.finish(job);
    });
  }

  // -- one answerer run -------------------------------------------------------------------------

  private claudeBin(): string {
    const given = typeof this.o.claudeBin === 'function' ? this.o.claudeBin() : this.o.claudeBin;
    const b = (given ?? this.env.TEAM_RELAY_CLAUDE_BIN ?? '').trim();
    return b && isAbsolute(b) ? b : 'claude';
  }

  /** One answerer run for the job; false when it was declined without running one. */
  private async answer(job: Job): Promise<boolean> {
    const item = job.item;
    const socket = this.socket;
    if (!socket) return false;
    // M10-SPEC §2: one version of the boundaries per run, read now; the allowed set built from it.
    const tb = await this.readBoundaries();
    if (this.stopped) return false;
    if (tb === null) {
      // §7.6: never read, so whether the team has boundaries is unknown: the fixed busy line, never an approval item.
      await this.declineBusy(job, "the team's boundaries could not be read");
      this.finish(job);
      return false;
    }
    let boundary: BoundaryRun | null = null;
    if (tb.boundaries) {
      // §7.1: nothing accepted, nothing answered.
      const e = await this.effective(tb);
      if (this.stopped) return false;
      this.noteAcceptance(tb);
      if (e === 'unknown') {
        // M11-SPEC §2: what the member accepted is unknown, so nothing counts as accepted.
        await this.declineBusy(job, 'which boundaries you accepted could not be read');
        this.finish(job);
        return false;
      }
      if (!e || !e.accepted) {
        this.lastSet = null;
        await this.publishShares([]);
        try {
          await this.sendReply(item.request_id, NOT_SET_UP_REPLY(this.o.me.member), null);
          this.o.log(`declined ${item.request_id}: the team's boundaries are not accepted yet (accept them in the console)`);
        } catch (err) {
          this.o.log(`the answer to ${item.request_id} could not be sent (${describeError(err)})`);
        }
        this.finish(job);
        return false;
      }
      const set = await this.allowedSet(tb, e.settings);
      if (this.stopped) return false;
      boundary = { set, teamName: this.o.me.name?.trim() || this.o.me.team, ctx: denyContext(this.env) };
      await this.publishShares([]);
    } else if (this.o.background) {
      // M11-SPEC §1: never folder mode: a team without boundaries is not set up for answering.
      this.lastSet = null;
      this.acceptance = null;
      await this.publishShares([]);
      try {
        await this.sendReply(item.request_id, NOT_SET_UP_REPLY(this.o.me.member), null);
        this.o.log(`declined ${item.request_id}: your team has no boundaries`);
      } catch (err) {
        this.o.log(`the answer to ${item.request_id} could not be sent (${describeError(err)})`);
      }
      this.finish(job);
      return false;
    } else {
      this.lastSet = null;
      this.acceptance = null;
      await this.publishShares(this.scope.qualifies && this.scope.share ? [this.scope.share] : []);
    }
    if (this.stopped) return false;
    const runDir = mkdtempSync(join(socket.dir, 'run-'));
    // M10-SPEC §7.3: the run's private snapshot folder. Beside the host's private directory, not in
    // it (that one is on the answerer's deny list), mode 700, removed with the run.
    let snapshots: string | null = null;
    if (boundary) {
      try {
        snapshots = mkdtempSync(join(dirname(socket.dir), snapshotDirPrefix()));
        chmodSync(snapshots, 0o700);
      } catch (err) {
        rmSync(runDir, { recursive: true, force: true });
        throw err;
      }
    }
    let plan: RunPlan;
    try {
      plan = planRun({
        item,
        runDir,
        socket: { path: socket.path, dir: socket.dir },
        scope: this.scope,
        env: this.env,
        connection: this.o.connection,
        member: this.o.me.member,
        dist: this.dist,
        node: this.node,
        claudeBin: this.claudeBin(),
        log: this.o.log,
        ...(boundary && tb.boundaries ? { boundaries: { teamName: boundary.teamName, topic: tb.boundaries.topic } } : {}),
        ...(this.o.background ? { capabilities: false } : {}),
      });
    } catch (err) {
      rmSync(runDir, { recursive: true, force: true });
      if (snapshots) rmSync(snapshots, { recursive: true, force: true });
      throw err;
    }
    const active = new ActiveRequests(plan.stateDir, (err) => this.o.log(`open request not recorded: ${describeError(err)}`));
    await active.add(item.request_id, new Date(item.answer_deadline).toISOString());

    const run: Run = {
      job,
      item,
      replied: false,
      drafted: false,
      approvalNeeded: false,
      approvalRequested: null,
      waiting: 0,
      cwd: plan.cwd,
      denyDirs: plan.denyDirs,
      sensitiveReads: new Set(),
      openSearches: new Set(),
      boundary,
      snapshots: snapshots ? snapshotRun(snapshots) : null,
    };
    this.current = run;
    socket.setRun(plan.token, (method, params) => this.onCall(run, method, params));
    try {
      const result = await runChild({
        bin: plan.bin,
        args: plan.args,
        cwd: plan.cwd,
        env: plan.env,
        stdin: plan.stdin,
        limitMs: RUN_LIMIT_MS,
        hardDeadline: item.answer_deadline + 60_000,
        paused: () => run.waiting > 0,
        signal: this.controller.signal,
      });
      if (result.code === null && result.signal === null && !result.timedOut && !this.claudeMissing) {
        this.claudeMissing = true;
        this.o.log(`could not start ${plan.bin} (is Claude Code on PATH?); set TEAM_RELAY_CLAUDE_BIN to its absolute path`);
      }
      if (!run.replied && !this.stopped) {
        const why = result.timedOut
          ? 'it ran out of time'
          : result.result?.is_error
            ? `it failed (${String(result.result.subtype ?? 'error')})`
            : `it ended without replying (exit ${result.code ?? result.signal})`;
        this.o.log(`no answer sent for ${item.request_id}: ${why}`);
      }
    } finally {
      socket.clearRun();
      this.current = null;
      // Whatever the run still waited for is withdrawn: it can no longer be used.
      this.queue.cancelWhere((p) => p.ctx.request_id === item.request_id && p.ask.type === 'permission');
      rmSync(runDir, { recursive: true, force: true });
      if (snapshots) rmSync(snapshots, { recursive: true, force: true });
      // A drafted reply is handled when the member's decision settles; anything else is over.
      if (!run.drafted) this.finish(job);
    }
    return true;
  }

  private ctxOf(item: WorkItem): ItemContext {
    return {
      request_id: item.request_id,
      asker: item.from,
      kind: item.kind,
      question: item.question,
      ...(item.capability ? { capability: item.capability } : {}),
    };
  }

  private async onCall(run: Run, method: string, params: unknown): Promise<unknown> {
    if (this.current !== run) throw new Error('this answer is over');
    const p = isPlainObject(params) ? params : {};
    if (method === 'reply') return this.onReply(run, p);
    if (method === 'list_files' || method === 'search_files') return this.onFileTool(run, method, p);
    if (method === 'request_approval') {
      // M10-SPEC §3: nothing waits for the member in boundary mode (the tool is not even listed).
      if (run.boundary) return { ok: false, message: 'request_approval is not available for this team: answer, or say you cannot.' };
      const reason = typeof p.reason === 'string' ? p.reason.slice(0, 500) : 'no reason given';
      run.approvalRequested = reason;
      return { ok: true, message: "Noted: your answer will wait for the member's approval before it is sent." };
    }
    if (method === 'permission') return this.onPermission(run, p);
    if (method === 'trail') return this.onTrail(run, p);
    throw new Error(`unknown method: ${method}`);
  }

  // -- M10-SPEC §3: the host's file tools ---------------------------------------------------------

  private async onFileTool(run: Run, method: string, p: Record<string, unknown>): Promise<{ ok: true; result: unknown } | { ok: false; message: string }> {
    const b = run.boundary;
    if (!b) return { ok: false, message: `${method} is not available here.` };
    let out: ToolOutcome;
    if (method === 'list_files') out = listFiles(b.set, p);
    else out = await searchFiles(b.set, p, { ctx: b.ctx, now: this.now });
    if (!out.ok) this.o.log(`${method} for ${run.item.request_id} refused: ${singleLine(out.message, 200)}`);
    return out;
  }

  // -- §7 item 1: the read trail ------------------------------------------------------------

  /** A read-trail hook's report (read-trail.ts). Every field is checked again here. */
  private onTrail(run: Run, p: Record<string, unknown>): { ok: boolean } {
    const phase = p.phase;
    const tool = p.tool;
    if (tool !== 'Read' && tool !== 'Grep') return { ok: false };
    const id = typeof p.tool_use_id === 'string' && p.tool_use_id ? p.tool_use_id.slice(0, 200) : '(no id)';
    const note = (raw: unknown) => {
      if (typeof raw !== 'string' || raw === '') return;
      const path = resolvePath(run.cwd, raw.slice(0, 4096));
      for (const candidate of [raw, path, realOr(path)]) {
        if (sensitiveName(candidate)) run.sensitiveReads.add(basename(candidate.replace(/[/\\]+$/, '')));
      }
    };
    if (phase === 'pre') {
      note(p.path);
      if (tool === 'Grep') run.openSearches.add(id);
      return { ok: true };
    }
    if (tool !== 'Grep') return { ok: false };
    if (phase === 'post') {
      const paths = Array.isArray(p.paths) ? p.paths.slice(0, 5000) : [];
      for (const x of paths) note(x);
      run.openSearches.delete(id);
      return { ok: true };
    }
    if (phase === 'failed') {
      run.openSearches.delete(id);
      return { ok: true };
    }
    return { ok: false };
  }

  // -- §3: the reply decision table ---------------------------------------------------------

  private async onReply(run: Run, p: Record<string, unknown>): Promise<unknown> {
    if (run.replied) return { ok: false, message: 'You have already replied; reply only once.' };
    const text = p.text;
    if (typeof text !== 'string' || text.length === 0 || codePointLength(text) > 32000) return { ok: false, message: 'text must be 1 to 32000 characters' };
    if (hasLoneSurrogate(text)) return { ok: false, message: 'text contains a lone surrogate' };
    let data: Record<string, unknown> | null = null;
    if (p.data !== undefined && p.data !== null) {
      if (!isPlainObject(p.data)) return { ok: false, message: 'data must be a JSON object' };
      if (Buffer.byteLength(JSON.stringify(p.data), 'utf8') > REPLY_DATA_LIMIT) return { ok: false, message: 'data is larger than 64 KiB' };
      data = p.data;
    }
    if (run.boundary) {
      const decided = await this.onBoundaryReply(run, run.boundary, p, text, data);
      if (decided) return decided;
    }
    if (p.needs_approval !== undefined && typeof p.needs_approval !== 'boolean') return { ok: false, message: 'needs_approval must be true or false' };
    const reasons = draftReasons({
      needsApproval: p.needs_approval === true,
      reason: typeof p.reason === 'string' ? p.reason : null,
      requested: run.approvalRequested,
      approvalDuringRun: run.approvalNeeded,
      sensitiveReads: [...run.sensitiveReads],
      openSearches: run.openSearches.size,
      text,
      data,
    });
    run.replied = true;
    if (reasons.length === 0) {
      try {
        await this.sendReply(run.item.request_id, text, data);
      } catch (err) {
        run.replied = false;
        return { ok: false, message: `the answer could not be sent (${describeError(err)})` };
      }
      this.o.log(`answered ${run.item.request_id} automatically`);
      return { ok: true, message: 'Sent.' };
    }
    run.drafted = true;
    const { outcome } = this.queue.add(this.ctxOf(run.item), { type: 'draft', text, data, reasons }, run.item.answer_deadline);
    void outcome.then((o) => this.settleDraft(run.job, text, data, o));
    return { ok: true, message: "Your answer waits for the member's approval. Nothing more to do: end here." };
  }

  /**
   * M10-SPEC §3, the decision table in boundary mode: off-topic → the fixed decline; the secret
   * screen (or the read trail) flags the draft → not sent, the fixed line to the asker and a
   * one-line note to the member; otherwise sent. Nothing waits for the member, except the
   * result of a capability call the member approved (approvalNeeded): that goes on as in M8
   * (null is returned and the M8 table decides).
   */
  private async onBoundaryReply(
    run: Run,
    b: BoundaryRun,
    p: Record<string, unknown>,
    text: string,
    data: Record<string, unknown> | null,
  ): Promise<{ ok: boolean; message: string } | null> {
    if (p.needs_approval !== undefined || p.reason !== undefined) {
      return { ok: false, message: 'needs_approval and reason are not used for this team: reply with your answer, or with off_topic set to true.' };
    }
    if (p.off_topic !== undefined && typeof p.off_topic !== 'boolean') return { ok: false, message: 'off_topic must be true or false' };
    const send = async (body: string, d: Record<string, unknown> | null, done: string, logLine: string) => {
      run.replied = true;
      try {
        await this.sendReply(run.item.request_id, body, d);
      } catch (err) {
        run.replied = false;
        return { ok: false, message: `the answer could not be sent (${describeError(err)})` };
      }
      this.o.log(logLine);
      return { ok: true, message: done };
    };
    if (p.off_topic === true) {
      return send(OFF_TOPIC_REPLY(singleLine(b.teamName, 100)), null, 'Declined as off-topic. Nothing more to do: end here.', `declined ${run.item.request_id} as off-topic`);
    }
    if (run.approvalNeeded) return null;
    const flagged = screenDraft(text, data).length > 0 || run.sensitiveReads.size > 0 || run.openSearches.size > 0;
    if (flagged) {
      const r = await send(
        WITHHELD_REPLY(this.o.me.member),
        null,
        'Not sent: your answer may contain a credential. The teammate was told to ask the member directly. Nothing more to do: end here.',
        `withheld the answer to ${run.item.request_id}: it may contain a credential`,
      );
      if (r.ok) {
        // One line for the member: ids only, no teammate text.
        const note = `team-relay: an automatic answer to ${run.item.from} was not sent because it may contain a credential (request ${run.item.request_id}); ${run.item.from} was told to ask you directly.`;
        void Promise.resolve(this.o.push(note)).catch(() => {});
      }
      return r;
    }
    return send(text, data, 'Sent.', `answered ${run.item.request_id} automatically`);
  }

  private async sendReply(requestId: string, text: string, data: Record<string, unknown> | null): Promise<void> {
    await this.o.client.reply(requestId, { idempotency_key: randomUUID(), text, data });
  }

  private async settleDraft(job: Job, text: string, data: Record<string, unknown> | null, outcome: string): Promise<void> {
    const item = job.item;
    // The host is stopping: nothing is sent, and the question is received again by the next host.
    if (outcome === 'cancelled') return;
    try {
      if (outcome === 'send') {
        await this.sendReply(item.request_id, text, data);
        this.o.log(`sent the approved answer to ${item.request_id}`);
      } else if (outcome === 'decline') {
        await this.sendReply(item.request_id, POLITE_DECLINE(this.o.me.member), null);
        this.o.log(`declined ${item.request_id} politely`);
      } else {
        this.o.log(`nothing sent for ${item.request_id} (${outcome})`);
      }
    } catch (err) {
      this.o.log(`the answer to ${item.request_id} could not be sent (${describeError(err)})`);
    }
    this.toolEvent(item.request_id, 'approval', outcome === 'send' ? 'ok' : 'error');
    this.finish(job);
  }

  // -- §3: the permission tool --------------------------------------------------------------

  private async onPermission(run: Run, p: Record<string, unknown>): Promise<{ allow: boolean; message?: string; updatedInput?: Record<string, unknown> }> {
    // M8: anything outside the allow list makes the draft wait too, whatever is decided here.
    // M10-SPEC §3: in boundary mode an automatic decision never does; only an item that
    // actually waits for the member (a capability call) does.
    if (!run.boundary) run.approvalNeeded = true;
    const toolName = typeof p.tool_name === 'string' ? p.tool_name : '';
    const input = isPlainObject(p.input) ? p.input : {};
    const ask = run.boundary ? await this.classifyBoundary(run, run.boundary, toolName, input) : this.classify(run, toolName, input);
    if ('allow' in ask) return ask.updatedInput ? { allow: true, updatedInput: ask.updatedInput } : { allow: true };
    if ('deny' in ask) {
      this.o.log(`denied ${toolName || 'a tool'} for ${run.item.request_id} without asking: ${ask.deny}`);
      return { allow: false, message: ask.deny };
    }
    if (run.boundary) run.approvalNeeded = true;
    const { outcome } = this.queue.add(this.ctxOf(run.item), { type: 'permission', tool: ask.tool, action: ask.action }, run.item.answer_deadline);
    run.waiting++;
    let result: string;
    try {
      result = await outcome;
    } finally {
      run.waiting--;
    }
    if (result === 'allow') return { allow: true };
    this.toolEvent(run.item.request_id, ask.tool, 'error');
    const message =
      result === 'deny'
        ? 'The member denied this. Answer without it, or say you could not.'
        : 'The member did not allow this in time. Answer without it, or say you could not.';
    return { allow: false, message };
  }

  /** Whether an absolute path (or where it resolves to) is on the deny list or in a denied directory. */
  private denied(run: Run, path: string): boolean {
    const real = realOr(path);
    const ctx = { home: this.env.HOME ?? '', credentialDirs: relayCredentialDirs(this.env) };
    return (
      credentialHit(path, ctx) !== null ||
      credentialHit(real, ctx) !== null ||
      run.denyDirs.some((d) => within(real, realOr(d)) || within(path, d) || within(real, d))
    );
  }

  /**
   * M10-SPEC §3: in boundary mode a Read is allowed at once when the file (where it really
   * leads) is in the run's allowed set, and denied at once otherwise; capability calls are asked
   * about as in M8; everything else is denied at once. §7.3: an allowed Read is a snapshot: the
   * host copies the file into the run's private folder and the Read goes to the copy (its other
   * parameters unchanged), so the answerer never opens a member path.
   */
  private async classifyBoundary(
    run: Run,
    b: BoundaryRun,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ allow: true; updatedInput?: Record<string, unknown> } | { tool: string; action: string } | { deny: string }> {
    const { server, tool } = splitToolName(toolName);
    if (server === null && tool === 'Read') {
      const raw = input.file_path;
      if (typeof raw !== 'string' || raw === '') return { deny: 'Read needs a file_path.' };
      const path = resolvePath(run.cwd, raw);
      if (this.denied(run, path)) return { deny: 'That path is never readable (credentials and configuration are off limits). Do not try to reach it another way.' };
      if (!run.snapshots) return { deny: UNSAFE_READ };
      const snap = await snapshotRead({ set: b.set, ctx: b.ctx, requested: path, run: run.snapshots });
      if (!snap.ok) {
        const deny = { outside: OUTSIDE_SET, too_large: TOO_LARGE_READ, run_cap: RUN_CAP_READ, unsafe: UNSAFE_READ } as const;
        return { deny: deny[snap.why] };
      }
      return { allow: true, updatedInput: { ...input, file_path: snap.path } };
    }
    if (server === 'capabilities' && !this.o.background) return this.classify(run, toolName, input);
    return { deny: `${toolName || 'That tool'} is not available when answering automatically.` };
  }

  /** What the member is asked, or why it is denied without asking. */
  private classify(run: Run, toolName: string, input: Record<string, unknown>): { tool: string; action: string } | { deny: string } {
    const { server, tool } = splitToolName(toolName);
    if (server === null && (tool === 'Read' || tool === 'Glob' || tool === 'Grep')) {
      const refused = { deny: 'That path is never readable (credentials and configuration are off limits). Do not try to reach it another way.' };
      const raw = tool === 'Read' ? input.file_path : input.path;
      const given = typeof raw === 'string' && raw ? raw : run.cwd;
      const path = resolvePath(run.cwd, given);
      if (this.denied(run, path)) return refused;
      // §7 item 7: a Glob pattern, or a Grep glob, with a fixed prefix is checked against the
      // deny list before the member is asked; a hit is denied without asking.
      for (const key of tool === 'Glob' ? ['pattern'] : tool === 'Grep' ? ['glob'] : []) {
        const pattern = input[key];
        if (typeof pattern !== 'string' || pattern === '') continue;
        const target = patternTarget(pattern, path, this.env.HOME ?? '');
        if (this.denied(run, target.prefix) || credentialHit(target.whole, { home: this.env.HOME ?? '' }) !== null) return refused;
      }
      // §7 item 6: the member sees where a path really leads.
      const real = realOr(path);
      const where = real !== path ? `${path} → ${real}` : path;
      const pattern = typeof input.pattern === 'string' ? singleLine(input.pattern, 200) : '';
      if (tool === 'Read') return { tool, action: `read the file ${where}` };
      if (tool === 'Glob') return { tool, action: `list the files matching ${JSON.stringify(pattern)} in ${where}` };
      const glob = typeof input.glob === 'string' ? ` (files matching ${JSON.stringify(singleLine(input.glob, 200))})` : '';
      return { tool, action: `search ${where}${glob} for ${JSON.stringify(pattern)}` };
    }
    if (server === 'capabilities') {
      const item = run.item;
      if (item.kind !== 'capability_call' || !item.capability) {
        return { deny: 'Capabilities run only for a capability call, never for a question.' };
      }
      if (item.capability.name !== tool) return { deny: `This request is for ${item.capability.name}, not ${tool}.` };
      const { request_id: requestId, ...params } = input;
      if (requestId !== item.request_id) return { deny: `Use request_id "${item.request_id}".` };
      if (canonicalJson(params) !== canonicalJson(item.capability.params)) {
        return { deny: 'Use exactly the params of the capability call.' };
      }
      return { tool, action: `run ${tool} with ${JSON.stringify(item.capability.params)} for this capability call` };
    }
    return { deny: `${toolName || 'That tool'} is not available when answering automatically.` };
  }

  // -- telling the member and the asker (§4, §7 item 5) -----------------------------------------

  private onQueueChange(type: 'added' | 'settled', item: Pending, _outcome?: string) {
    this.writeState();
    if (type !== 'added' || this.stopped) return;
    const n = this.queue.size;
    const now = this.now();
    let content: string;
    if (now - this.lastQuoted >= this.noticeGapMs) {
      // The first push of a while quotes the teammate (neutralised, one line, clipped).
      this.lastQuoted = now;
      const quoted =
        item.ctx.kind === 'capability_call' && item.ctx.capability
          ? `run ${item.ctx.capability.name} ${singleLine(JSON.stringify(item.ctx.capability.params), QUOTE_LIMIT)}`
          : singleLine(item.ctx.question, QUOTE_LIMIT);
      const what = item.ask.type === 'run' ? 'answering it is waiting for your approval' : 'an answer is waiting for your approval';
      content = `team-relay: ${item.ctx.asker} asked: "${quoted}" — ${what} (${n} pending). Run /team-relay:approvals.`;
    } else {
      // Later ones carry counts only: no teammate text.
      content = `team-relay: another item is waiting for your approval (${n} pending). Run /team-relay:approvals.`;
    }
    void Promise.resolve(this.o.push(content)).catch(() => {});
    this.toolEvent(item.ctx.request_id, item.ask.type === 'permission' ? item.ask.tool : 'approval', 'waiting');
    this.notifyDesktop(APPROVAL_TEXT);
  }

  /** A desktop notification (fixed text), at most one per NOTICE_GAP_MS. */
  private notifyDesktop(text: NoticeText): void {
    const now = this.now();
    if (now - this.lastDesktop < this.noticeGapMs) return;
    this.lastDesktop = now;
    try {
      (this.o.notify ?? defaultNotify)(text);
    } catch {
      // a notification is a side surface
    }
  }

  private toolEvent(requestId: string, tool: string, status: 'ok' | 'error' | 'waiting') {
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(tool)) return;
    void this.o.client.toolEvent(requestId, { tool, status, duration_ms: null }, { attempts: 1, timeoutMs: 5000 }).catch((err: unknown) => {
      this.o.log(`tool event for ${requestId} not recorded (${describeError(err)})`);
    });
  }

  private writeState() {
    if (!this.lock) return;
    try {
      writeApprovalsState(this.stateFile, this.queue.size);
    } catch (err) {
      this.o.log(`approvals count not written (${describeError(err)})`);
    }
  }

  // -- §4: the review ---------------------------------------------------------------------------

  /**
   * /team-relay:approvals. With elicitation, one dialog per item in the working session;
   * without it, the local page in the browser. Returns what the model may tell the member:
   * counts only.
   */
  async review(elicit: Elicit | null): Promise<string> {
    if (!this.lock) return `This session is not answering automatically (${this.whyNot ?? 'not started'}), so it holds no approvals.`;
    if (this.queue.size === 0) return 'Nothing is waiting for your approval.';
    if (this.reviewing) return 'A review is already open in this session: finish that one first.';
    this.reviewing = true;
    try {
      if (elicit) return summaryText(await reviewWithElicitation(this.queue, elicit, this.o.me.member));
      this.page ??= new ApprovalsPage(this.queue, this.o.me.member);
      const url = await this.page.start();
      (this.o.openPage ?? ((u: string) => openInBrowser(u, { log: this.o.log, title: 'Team relay approvals', what: 'the approvals page' })))(url);
      return (
        `This Claude Code does not offer dialogs to plugins (MCP elicitation), so your ${this.queue.size} pending approval(s) opened in your browser ` +
        'on a local page instead (127.0.0.1, with a one-time key). Decide there; nothing is sent or run before you do.'
      );
    } finally {
      this.reviewing = false;
    }
  }
}

/**
 * §7 item 7: what a Glob pattern (or a Grep glob) can reach, as absolute paths: `prefix`, its
 * fixed part (up to the first segment with a glob character), and `whole`, the pattern itself.
 * A relative pattern is taken from the searched path; `~/` from home.
 */
export function patternTarget(pattern: string, base: string, home: string): { prefix: string; whole: string } {
  let p = pattern;
  if (p === '~' || p.startsWith('~/')) p = home + p.slice(1);
  const whole = isAbsolute(p) ? resolvePath(p) : resolvePath(base, p);
  const parts = whole.split('/');
  const fixed: string[] = [];
  for (const part of parts) {
    if (/[*?[\]{}!]/.test(part)) break;
    fixed.push(part);
  }
  return { prefix: fixed.join('/') || '/', whole };
}

export type RunPlan = {
  runDir: string;
  stateDir: string;
  /** The answerer's working directory: the scope folder when it qualifies, else an empty private one. */
  cwd: string;
  denyDirs: string[];
  token: string;
  bin: string;
  args: string[];
  env: Record<string, string>;
  stdin: string;
  files: { mcpConfig: string; settings: string; toolEvent: string | null; readTrail: string };
};

/** How the answerer's servers reach the relay, and what they must never read. */
function relayServerEnv(
  connection: HostConnection,
  env: NodeJS.ProcessEnv,
  runDir: string,
): { env: Record<string, string>; denyFiles: string[]; toolEvent: Record<string, unknown> | null } {
  const c = connection;
  const out: Record<string, string> = { RELAY_URL: c.url, RELAY_TEAM: c.team, RELAY_AUTH: c.mode };
  const denyFiles: string[] = [];
  const toolEvent: Record<string, unknown> = { relay_url: c.url, relay_team: c.team, relay_auth: c.mode, state_dir: join(runDir, 'state') };
  if (c.mode === 'credential' && c.credentialsFile) {
    out.RELAY_CREDENTIALS_FILE = c.credentialsFile;
    toolEvent.credentials_file = c.credentialsFile;
    denyFiles.push(c.credentialsFile);
  } else if (c.mode === 'token') {
    let file = c.tokenFile;
    if (!file && c.token) {
      // Handed over as a file (mode 600, in the run's private directory), never in mcp.json.
      file = join(runDir, 'token');
      writeFileSync(file, `${c.token}\n`, { mode: 0o600, flag: 'wx' });
    }
    if (file) {
      out.RELAY_TOKEN_FILE = file;
      toolEvent.token_file = file;
      denyFiles.push(file);
    }
  } else if (c.mode === 'google') {
    if (c.gcloudAccount) {
      out.RELAY_GCLOUD_ACCOUNT = c.gcloudAccount;
      toolEvent.gcloud_account = c.gcloudAccount;
    }
    if (env.PATH) out.PATH = env.PATH;
    for (const [k, v] of Object.entries(env)) if (/^CLOUDSDK_[A-Z0-9_]+$/.test(k) && typeof v === 'string') out[k] = v;
  }
  return { env: out, denyFiles, toolEvent: c.mode === 'metadata' ? null : toolEvent };
}

/**
 * Everything one answerer run needs, written into `runDir` (a fresh mode-700 directory inside
 * the host's private directory): mcp.json, settings.json, tool-event.json (all mode 600), and
 * the command line, environment and prompt.
 */
export function planRun(p: {
  item: WorkItem;
  runDir: string;
  socket: { path: string; dir: string };
  scope: Scope;
  env: NodeJS.ProcessEnv;
  connection: HostConnection;
  member: string;
  dist: string;
  node: string;
  claudeBin: string;
  log?: (line: string) => void;
  token?: string;
  /** M10-SPEC §3: boundary mode, with the team's name and topic (owner-written; quoted in the rubric). */
  boundaries?: { teamName: string; topic: string };
  /** M11-SPEC §1: false offers the answerer no capability server (the background answerer). */
  capabilities?: boolean;
}): RunPlan {
  const { runDir, env, scope } = p;
  const boundary = p.boundaries ?? null;
  const stateDir = join(runDir, 'state');
  mkdirSync(stateDir, { mode: 0o700 });
  const relay = relayServerEnv(p.connection, env, runDir);
  let cwd = scope.path;
  // In boundary mode the answerer works in an empty private directory: nothing is read without the permission tool.
  if (!scope.qualifies || boundary) {
    cwd = join(runDir, 'work');
    mkdirSync(cwd, { mode: 0o700 });
  }
  const denyDirs = [p.socket.dir, ...relayCredentialDirs(env)];
  const cloudsdk = env.CLOUDSDK_CONFIG?.trim();
  if (p.connection.mode === 'google' && cloudsdk && isAbsolute(cloudsdk)) denyDirs.push(cloudsdk);
  const claudeConfig = env.CLAUDE_CONFIG_DIR?.trim();
  if (claudeConfig && isAbsolute(claudeConfig)) denyDirs.push(claudeConfig);

  // The capability server, when the member offers any (the same rules as bin/answerer).
  let capabilities: { script: string; env: Record<string, string> } | null = null;
  if (p.capabilities !== false) {
    try {
      const manifestPath = env.MANIFEST_PATH || defaultManifestPath();
      const { exposed } = exposedCapabilities(loadManifest(manifestPath), env);
      if (exposed.length > 0) {
        const capEnv: Record<string, string> = {
          ...relay.env,
          MANIFEST_PATH: manifestPath,
          ALLOW_PRODUCTION: env.ALLOW_PRODUCTION === 'true' ? 'true' : 'false',
        };
        for (const [k, v] of Object.entries(env)) {
          if (/^CAP_[A-Z][A-Z0-9_]*_(ENABLED|RUNNER)$/.test(k) && typeof v === 'string') capEnv[k] = v;
        }
        capabilities = { script: join(p.dist, 'capabilities.js'), env: capEnv };
      }
    } catch (err) {
      p.log?.(`capabilities not offered to this answer (${describeError(err)})`);
    }
  }

  const token = p.token ?? newToken();
  const mcpConfig = join(runDir, 'mcp.json');
  const settings = join(runDir, 'settings.json');
  const toolEventFile = relay.toolEvent ? join(runDir, 'tool-event.json') : null;
  const readTrailFile = join(runDir, 'read-trail.json');
  const write = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  write(mcpConfig, childMcpConfig({ node: p.node, answerTools: join(p.dist, 'answer-tools.js'), socket: p.socket.path, token, capabilities, boundaries: boundary !== null }));
  if (toolEventFile) write(toolEventFile, relay.toolEvent);
  // §7 item 1: the read-trail hook reaches the host with the run's token, from a file in the
  // host's private directory (denied to the answerer's own reads).
  write(readTrailFile, { socket: p.socket.path, token });
  write(
    settings,
    childSettings({
      scope,
      denyFiles: relay.denyFiles,
      denyDirs,
      readTrailHook: { node: p.node, script: join(p.dist, 'read-trail.js'), config: readTrailFile },
      boundaries: boundary !== null,
      ...(toolEventFile ? { toolEventHook: { node: p.node, script: join(p.dist, 'tool-event.js'), config: toolEventFile } } : {}),
    }),
  );
  const model = env.TEAM_RELAY_ANSWER_MODEL?.trim() || undefined;
  return {
    runDir,
    stateDir,
    cwd,
    denyDirs,
    token,
    bin: p.claudeBin,
    args: boundary
      ? childArgs({ mcpConfig, settings }, boundaryRubric({ member: p.member, teamName: boundary.teamName, topic: boundary.topic }), model, 'boundaries')
      : childArgs({ mcpConfig, settings }, rubric(p.member, scope), model),
    env: childEnv(env),
    stdin: buildPrompt(p.item),
    files: { mcpConfig, settings, toolEvent: toolEventFile, readTrail: readTrailFile },
  };
}

/** §3: why a draft waits (empty: it ships on its own). */
export function draftReasons(d: {
  needsApproval: boolean;
  reason: string | null;
  requested: string | null;
  approvalDuringRun: boolean;
  /** §7 item 1: base names of files read or searched whose names suggest secrets. */
  sensitiveReads?: readonly string[];
  /** §7 item 1: searches whose results were never reported. */
  openSearches?: number;
  text: string;
  data: Record<string, unknown> | null;
}): string[] {
  const reasons: string[] = [];
  // §7 item 9: what the answerer wrote is labelled as its own words.
  const words = (r: string) => ` (in the answerer's own words: "${singleLine(r, 200)}")`;
  if (d.needsApproval) reasons.push(`the answerer flagged it${d.reason ? words(d.reason) : ''}`);
  if (d.requested !== null) reasons.push(`the answerer asked for your approval${words(d.requested)}`);
  const secrets = screenDraft(d.text, d.data);
  if (secrets.length) reasons.push(`the secret screen found ${secrets.map((s) => s.kind).join(', ')}`);
  const sensitive = [...new Set(d.sensitiveReads ?? [])];
  if (sensitive.length) {
    const names = sensitive.slice(0, 3).map((n) => singleLine(n, 80)).join(', ');
    const more = sensitive.length > 3 ? ` and ${sensitive.length - 3} more` : '';
    reasons.push(`it read files whose names suggest secrets (${names}${more})`);
  }
  if ((d.openSearches ?? 0) > 0) reasons.push('what one of its searches read could not be recorded');
  if (d.approvalDuringRun) reasons.push('it needed your permission for a step while it worked');
  return reasons;
}

function defaultNotify(text: NoticeText): void {
  const cmd = notifyCommand(process.platform, text);
  if (!cmd) return;
  execFile(cmd.file, cmd.args, { timeout: 3000, windowsHide: true }, () => {});
}
