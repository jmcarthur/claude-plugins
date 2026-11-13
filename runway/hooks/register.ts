import type {
  EngineInterface,
  Register,
  SessionMeasureInput,
  SessionRateLimit,
} from "claude-code";
import type { RunwaySnapshot } from "../types";
import {
  activeUsage,
  CSWAP_NOT_FOUND,
  defaultLoginCswap,
  isDefaultProfile,
  isInRotation,
  loginState,
  parseCswapList,
  parseLogin,
  poolOf,
  runsCswapAuto,
  setupProblems,
  viableAccounts,
  type Account,
  type LoginState,
  type Pool,
} from "./accounts";
import {
  compactBeforeLimitNote,
  longLimitWait,
  NEAR_LIMIT,
  type LimitReading,
} from "./limitnote";
import {
  exhaustedUntil,
  hhmm,
  HOUR,
  MINUTE,
  mins,
  usageExhaustedUntil,
  workBurns,
  type Burns,
  type Sample,
  type ScopedLimit,
  type Window,
} from "./limits";
import { appendLog, queue } from "./log";
import { readConfig, type Config } from "./options";
import { watchRemoteControl, type RemoteControlWatch } from "./remote";
import { retryDelay, revivalStep, type Reading } from "./revival";
import {
  coordinatorOf,
  isGone,
  isPending,
  limitTarget,
  parsePlan,
  parseRecord,
  proposeSwitch,
  scopedTarget,
  scopeOf,
  scopesInUse,
  switchRecord,
  USE_HORIZON,
  type SessionRecord,
  type SwitchPlan,
} from "./switching";

// The compact tool that the tidy plugin registers. Runway suggests compacting
// before a limit only while it is loaded: the model cannot run /compact itself.
const TIDY_COMPACT_TOOL = "mcp__tidy__compact";
const SAMPLE_SPACING = 2 * MINUTE;
const SAMPLE_HISTORY = 6 * HOUR;
const BURN_HORIZON = 45 * MINUTE;
const POOL_SPACING = 5 * MINUTE;
const SWITCH_TICK = 30_000;
const REVIVAL_TICK = MINUTE;
// After a switch at a limit, Claude Code's own retry gets a moment before
// runway resumes the session.
const RESUME_AFTER_SWITCH = 30_000;
const SAVE_SPACING = 10_000;
// Switches in the last hour before a third one that point to a loop: more
// than a limit or two calls for.
const SWITCH_WARNING_COUNT = 2;
const CSWAP_AUTO_NOTICE =
  "cswap auto is running, so runway does not switch accounts; stop it to let runway coordinate switches";
const SESSION_STATE = { plugin: "runway", key: "session" } as const;
const NEW_LOGIN_NOTICE =
  "runway holds account switching: Claude Code is logged in to an account that cswap does not manage; run /add-account to add it";

// A usage limit stopped the main turn. With another account to move to,
// runway switches (at once, or at `switchAt` when the first account
// recovers), then resumes the session. Without one, it resumes the session
// after `resetsAt` (or retries without it) in case Claude Code's
// auto-continue does not.
type Interruption = {
  at: number;
  resetsAt?: number;
  switchTo?: number;
  switchAt?: number;
  switchedAt?: number;
};

type State = {
  config: Config;
  sessionId?: string;
  logPath?: string;
  isDefaultProfile: boolean;
  notes: string[];
  isTurnRunning: boolean;
  // When the main turn started; turn.start fires for subagents too.
  turnAt: number;
  compactNotedFor?: number;
  accounts: Account[];
  pool?: Pool;
  isCswapAutoRunning?: boolean;
  // How Claude Code's login relates to the cswap accounts; runway switches
  // only while cswap holds it.
  login?: LoginState;
  // The login (email and organization) runway last ran `cswap add` for, or
  // offered to add: each login gets one try.
  loginHandled?: string;
  poolCheckedAt: number;
  lastFailure?: string;
  lastSwitchAt: number;
  lastResponseAt: number;
  interruption?: Interruption;
  // Resumes since the last turn that ended in an answer; each one doubles the
  // next retry delay.
  revivals: number;
  // When this session last requested each model id, main loop and subagents.
  models: Record<string, number>;
  remoteControl?: RemoteControlWatch;
  // The notices the status line can carry, by kind; statusLine picks one.
  notices: Partial<Record<NoticeKind, Notice>>;
  // What the status line shows now.
  statusText?: string;
};

// The status line carries notices only, one at a time, the most pressing first:
// a limit, a failed cswap command, a setup problem, a login cswap does not hold,
// a cswap auto loop, repeated switches, a resume that runway skipped. Each
// feature sets or clears its own kind, and the line is derived from them, so a
// notice goes when its cause does and comes back when one above it goes.
type NoticeKind = "limit" | "failure" | "setup" | "warning" | "resume";
type Notice = { text: string; at: number };
// A notice of something that happened, rather than of a state that lasts until
// runway clears it, shows this long.
const PASSING: Partial<Record<NoticeKind, number>> = {
  failure: HOUR,
  warning: HOUR,
  resume: HOUR,
};

async function home($: EngineInterface) {
  return (await $.env.get("HOME")) ?? "";
}

async function runs(
  $: EngineInterface,
  argv: string[],
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; output: string } | undefined> {
  try {
    const ran = await $.process.run(argv, { timeoutMs });
    return {
      exitCode: ran.exitCode,
      stdout: ran.stdout,
      output: (ran.stderr || ran.stdout).trim().slice(0, 500),
    };
  } catch {
    return undefined;
  }
}

async function removeFile($: EngineInterface, path: string) {
  await runs($, ["rm", "-f", path], 10_000);
}

async function logEvent(
  $: EngineInterface,
  s: State,
  event: Record<string, unknown>,
) {
  const path = s.logPath;
  if (!path) return;
  const line = JSON.stringify({
    at: new Date(await $.clock.now()).toISOString(),
    ...event,
  });
  await appendLog($, path, line);
}

function note($: EngineInterface, s: State, text: string) {
  s.notes.push(text);
  void save($, s);
  void logEvent($, s, {
    event: "note",
    text: text.split("\n")[0].slice(0, 200),
  });
}

function statusLine(s: State, now: number): string | undefined {
  const shown = (kind: NoticeKind) => {
    const n = s.notices[kind];
    const life = PASSING[kind];
    return n && (life === undefined || now - n.at < life) ? n.text : undefined;
  };
  return (
    shown("limit") ??
    shown("failure") ??
    shown("setup") ??
    (s.login?.kind === "new" ? NEW_LOGIN_NOTICE : undefined) ??
    (s.isCswapAutoRunning === true ? CSWAP_AUTO_NOTICE : undefined) ??
    shown("warning") ??
    shown("resume")
  );
}

// Writes the derived line when it changed, or always when `force`d, as after
// a reload, where what the status line shows is not known.
function renderStatus(
  $: EngineInterface,
  s: State,
  now: number,
  force = false,
) {
  const line = statusLine(s, now);
  if (!force && line === s.statusText) return;
  s.statusText = line;
  $.ui.status(line);
}

async function setNotice(
  $: EngineInterface,
  s: State,
  kind: NoticeKind,
  text: string | undefined,
) {
  const now = await $.clock.now();
  if (text === undefined) delete s.notices[kind];
  else s.notices[kind] = { text, at: now };
  renderStatus($, s, now);
}

let savedSnapshot = "";

async function save($: EngineInterface, s: State) {
  const { config, ...kept } = s;
  const snapshot = JSON.stringify(kept);
  if (snapshot === savedSnapshot) return;
  savedSnapshot = snapshot;
  await $.state.set(SESSION_STATE, JSON.parse(snapshot) as RunwaySnapshot);
}

async function restore($: EngineInterface, s: State, sessionId: string) {
  const { value } = await $.state.get(SESSION_STATE);
  if (value?.sessionId === sessionId) Object.assign(s, value as Partial<State>);
}

// ---- Compaction before a limit ----

type Sourced = Pick<LimitReading, "source" | "readAt">;
type LiveUsage = {
  five?: Window & Sourced;
  seven?: Window & Sourced;
  scoped: (ScopedLimit & Sourced)[];
};

// The rate-limit headers describe the account of the last response, so after a
// switch they stand for the account the login left until a new response comes.
// Each window takes the newer of the headers and cswap's reading: an idle
// session's headers grow old, and a coordinator is chosen by id, not activity.
// Each window says where it was read; the model-specific ones come from cswap
// only. `headers` are the rate limits a caller already has, if any.
async function liveUsage(
  $: EngineInterface,
  s: State,
  now: number,
  headers?: readonly SessionRateLimit[],
): Promise<LiveUsage | undefined> {
  const fromCswap = activeUsage(s.accounts, now);
  const cswapRead: Sourced = {
    source: "cswap",
    readAt: s.accounts.find((a) => a.isActive)?.fetchedAt,
  };
  const viaCswap = <W extends Window>(w: W | undefined) =>
    w && { ...w, ...cswapRead };
  const scoped = (fromCswap?.scoped ?? []).map((l) => ({ ...l, ...cswapRead }));
  const rateLimits =
    s.lastResponseAt <= s.lastSwitchAt
      ? []
      : (headers ?? (await $.session.usage()).rateLimits);
  const window = (kind: string): (Window & Sourced) | undefined => {
    const r = rateLimits.find((l) => l.kind === kind);
    return r?.resetsAt && Date.parse(r.resetsAt) > now
      ? {
          used: r.percentUsed,
          resetsAt: Date.parse(r.resetsAt),
          source: "headers",
          readAt: s.lastResponseAt,
        }
      : undefined;
  };
  const newer = <W extends Window & Sourced>(
    headers: W | undefined,
    cswap: W | undefined,
  ) =>
    headers && (!cswap || (cswap.readAt ?? -Infinity) <= headers.readAt!)
      ? headers
      : cswap;
  const five = newer(window("five_hour"), viaCswap(fromCswap?.five));
  const seven = newer(window("seven_day"), viaCswap(fromCswap?.seven));
  return five || seven || fromCswap ? { five, seven, scoped } : undefined;
}

// Whether tidy's compact tool is loaded in this session: the note to compact
// names it, and without it the model has no way to compact.
async function hasCompactTool($: EngineInterface): Promise<boolean> {
  try {
    return (await $.tool.list()).some((t) => t.name === TIDY_COMPACT_TOOL);
  } catch {
    return false;
  }
}

// Notes once per window that usage windows near their limit reset after the
// prompt cache expires, while no other account can take the work. The note
// gives the readings; the session judges whether they stop its work. It comes
// only while tidy's compact tool is loaded, and is asked again once it is. It
// reads the context and rate limits that session.measure passes, and the
// burns only once a note is due.
async function checkLimitWait(
  $: EngineInterface,
  s: State,
  m: Pick<SessionMeasureInput, "context" | "rateLimits">,
) {
  const context = m.context.tokens;
  if (
    s.config.compactBeforeLimitTokens <= 0 ||
    context === undefined ||
    context < s.config.compactBeforeLimitTokens
  )
    return;
  const now = await $.clock.now();
  if (canSwitch(s) && viableAccounts(s.accounts, now, NEAR_LIMIT).length > 0)
    return;
  const usage = await liveUsage($, s, now, m.rateLimits);
  if (!usage) return;
  const recovery =
    canSwitch(s) && s.pool?.recovery && !s.pool.recovery.isActive
      ? s.pool.recovery
      : undefined;
  const readings = (burn: Burns): (LimitReading | undefined)[] => [
    usage.five && {
      ...usage.five,
      name: "5-hour, all models",
      burnPerHour: burn.five,
    },
    usage.seven && {
      ...usage.seven,
      name: "weekly, all models",
      burnPerHour: burn.seven,
    },
    ...usage.scoped.map(({ label, ...l }) => ({
      ...l,
      name: `${label} only`,
      burnPerHour: burn.scoped?.[label],
    })),
  ];
  const due = longLimitWait(readings({}), now, recovery?.at);
  if (!due || due.resetsAt === s.compactNotedFor) return;
  if (!(await hasCompactTool($))) return;
  const account = s.accounts.find((a) => a.isActive);
  const burn = burnsOf(s, await storedSamples($, now), now);
  const wait = longLimitWait(readings(burn), now, recovery?.at)!;
  s.compactNotedFor = wait.resetsAt;
  const iso = (at: number | undefined) =>
    at === undefined ? undefined : new Date(at).toISOString();
  await logEvent($, s, {
    event: "limit-note",
    context,
    account: account?.number,
    windows: wait.near.map((r) => ({
      name: r.name,
      used: r.used,
      resetsAt: iso(r.resetsAt),
      source: r.source,
      readAt: iso(r.readAt),
      burnPerHour: r.burnPerHour,
    })),
  });
  note(
    $,
    s,
    compactBeforeLimitNote(
      context,
      wait,
      now,
      {
        account: account && { number: account.number, email: account.email },
        canSwitch: canSwitch(s),
        recovery: recovery && { account: recovery.account, at: recovery.at },
      },
      TIDY_COMPACT_TOOL,
    ),
  );
}

// ---- Account switching ----

// `line` is what the status line shows, which draws one line: by default the
// message's first. The notification goes once per message.
async function fail(
  $: EngineInterface,
  s: State,
  kind: NoticeKind,
  message: string,
  line = message.split("\n")[0],
) {
  await logEvent($, s, { event: "failure", message });
  await setNotice($, s, kind, line);
  if (message === s.lastFailure) return;
  s.lastFailure = message;
  if (s.config.notifications)
    void $.ui.notify(message, { title: "runway: account switching" });
}

async function runCswap($: EngineInterface, argv: string[], timeoutMs: number) {
  const ran = await runs($, defaultLoginCswap(argv), timeoutMs);
  return ran?.exitCode === CSWAP_NOT_FOUND ? undefined : ran;
}

// A run that cannot start (cswap gone since the listing) counts as not found.
async function cswap(
  $: EngineInterface,
  s: State,
  argv: string[],
): Promise<number> {
  const ran = await runCswap($, [...argv, "--json"], 120_000);
  if (ran === undefined) return CSWAP_NOT_FOUND;
  await logEvent($, s, {
    event: "cswap",
    argv,
    exitCode: ran.exitCode,
    stdout: ran.stdout.slice(0, 2000),
  });
  if (ran.exitCode === 1)
    await fail(
      $,
      s,
      "failure",
      `\`cswap ${argv.join(" ")}\` failed: ${ran.output.slice(0, 300)}`,
    );
  else if (ran.exitCode === 0) await setNotice($, s, "failure", undefined);
  s.poolCheckedAt = 0;
  return ran.exitCode;
}

let poolListing: Promise<void> | undefined;

// A caller waits for a listing in progress; one that began before a switch
// asked for a fresh one (poolCheckedAt 0) is not fresh enough. Between the
// last check for a listing in progress and the start of a new one there is no
// await, so that two callers never both start one.
async function refreshPool(
  $: EngineInterface,
  s: State,
  now: number,
): Promise<void> {
  if (!s.isDefaultProfile) return;
  for (;;) {
    if (poolListing) {
      if (s.poolCheckedAt !== 0) return poolListing;
      await poolListing.catch(() => undefined);
      continue;
    }
    if (now - s.poolCheckedAt < POOL_SPACING) return;
    s.poolCheckedAt = now;
    const listing: Promise<void> = listPool($, s, now).finally(() => {
      if (poolListing === listing) poolListing = undefined;
    });
    poolListing = listing;
    return listing;
  }
}

// A listing newer than any switch so far, for a caller about to switch or
// that just switched.
async function relistPool($: EngineInterface, s: State, now: number) {
  s.poolCheckedAt = 0;
  await refreshPool($, s, now);
}

// A failed listing says nothing new, so runway keeps what it knew. A reader
// of the state between two awaits sees the old listing or the new one whole.
async function listPool($: EngineInterface, s: State, now: number) {
  const listed = await runCswap($, ["list", "--json"], 60_000);
  if (listed?.exitCode !== 0) {
    if (listed)
      await logEvent($, s, {
        event: "cswap",
        argv: ["list"],
        exitCode: listed.exitCode,
        stdout: listed.output,
      });
    return;
  }
  let accounts = parseCswapList(listed.stdout);
  const read = s.config.switching ? await readLogin($) : undefined;
  let login = loginState(accounts, read?.login);
  // Each login gets one try at `cswap add` or one offer, so that a failing add
  // does not run at every listing.
  const isFirstTry = read !== undefined && s.loginHandled !== read.key;
  if (login.kind === "held") s.loginHandled = undefined;
  else if (isFirstTry) s.loginHandled = read.key;
  if (login.kind === "stale" && isFirstTry) {
    const stored = await storeLogin($, s, login.account);
    if (stored) {
      accounts = stored;
      login = loginState(accounts, read.login);
    }
  }
  if (login.kind === "new" && isFirstTry)
    note(
      $,
      s,
      `Claude Code is logged in to ${login.email}, an account that claude-swap (cswap) does not manage, so runway does not switch accounts until it is added. Tell the user, and offer that they run /add-account to add it; do not add it yourself.`,
    );
  const isCswapAutoRunning =
    accounts.length >= 2 && s.config.switching
      ? await checkSetup($, s, accounts)
      : undefined;
  s.accounts = accounts;
  s.login = login;
  s.isCswapAutoRunning = isCswapAutoRunning;
  s.pool = poolOf(accounts, now);
  renderStatus($, s, now);
}

async function readLogin($: EngineInterface) {
  const text = await $.fs.read(`${await home($)}/.claude.json`).catch(() => "");
  const login = parseLogin(text);
  return login && { login, key: `${login.email} ${login.organizationUuid}` };
}

// After /login to an account whose cswap credentials are out of date, `cswap
// add` stores the new login over them and makes the account active. Resolves
// the new listing, or undefined when cswap did not store it.
async function storeLogin(
  $: EngineInterface,
  s: State,
  account: number,
): Promise<Account[] | undefined> {
  const added = await runCswap($, ["add"], 60_000);
  await logEvent($, s, {
    event: "cswap",
    argv: ["add"],
    account,
    exitCode: added?.exitCode,
    stdout: added?.output,
  });
  if (added?.exitCode !== 0) {
    await fail(
      $,
      s,
      "failure",
      `\`cswap add\` did not store the new login of cswap account ${account}: ${added?.output.slice(0, 300) ?? "cswap did not run"}. Run \`cswap add\` yourself.`,
    );
    return undefined;
  }
  $.ui.toast(`runway stored the new login of cswap account ${account}.`);
  await setNotice($, s, "failure", undefined);
  const listed = await runCswap($, ["list", "--json"], 60_000);
  return listed?.exitCode === 0 ? parseCswapList(listed.stdout) : undefined;
}

async function checkSetup(
  $: EngineInterface,
  s: State,
  accounts: Account[],
): Promise<boolean> {
  const problems = setupProblems(accounts);
  if (problems.length > 0)
    await fail(
      $,
      s,
      "setup",
      `cswap manages ${accounts.length} accounts, and runway cannot use all of them:\n${problems.join("\n")}`,
      problems.join(" "),
    );
  else {
    s.lastFailure = undefined;
    await setNotice($, s, "setup", undefined);
  }
  return runsCswapAuto(
    (await runs($, ["ps", "-A", "-o", "args="], 30_000))?.stdout ?? "",
  );
}

function canSwitch(s: State): boolean {
  return (
    s.config.switching &&
    s.isDefaultProfile &&
    s.pool !== undefined &&
    !s.isCswapAutoRunning &&
    (s.login === undefined || s.login.kind === "held")
  );
}

function activeAccount(s: State): number | undefined {
  return s.accounts.find((a) => a.isActive)?.number;
}

// The samples are shared by every session and tagged by account. Each is
// stamped with its reading's time, and a reading adds a point only when it is
// SAMPLE_SPACING newer than the account's last point for that window, so a
// frozen reading draws no line and a fresh one after it draws no false jump.
async function recordSample(
  $: EngineInterface,
  now: number,
  account: number | undefined,
  usage: LiveUsage | undefined,
): Promise<Sample[]> {
  const kept = await storedSamples($, now);
  const mine = kept.filter((x) => x.account === account);
  const added = new Map<number, Sample>();
  const add = (
    reading: Sourced & { used: number },
    value: (x: Sample) => number | undefined,
    put: (x: Sample) => void,
  ) => {
    const at = reading.readAt;
    if (at === undefined || at > now) return;
    const last = Math.max(
      -Infinity,
      ...mine.filter((x) => value(x) !== undefined).map((x) => x.at),
    );
    if (at - last < SAMPLE_SPACING) return;
    const sample = added.get(at) ?? { at, account };
    put(sample);
    added.set(at, sample);
  };
  if (usage?.five)
    add(
      usage.five,
      (x) => x.five,
      (x) => (x.five = usage.five!.used),
    );
  if (usage?.seven)
    add(
      usage.seven,
      (x) => x.seven,
      (x) => (x.seven = usage.seven!.used),
    );
  for (const l of usage?.scoped ?? [])
    if (l.resetsAt > now)
      add(
        l,
        (x) => x.scoped?.[l.label],
        (x) => (x.scoped = { ...x.scoped, [l.label]: l.used }),
      );
  if (added.size === 0) return kept;
  kept.push(...added.values());
  await $.store.set("samples", kept);
  return kept;
}

async function storedSamples($: EngineInterface, now: number) {
  const stored = ((await $.store.get("samples")) as Sample[] | undefined) ?? [];
  return stored.filter((x) => now - x.at <= SAMPLE_HISTORY);
}

// Every switching decision judges accounts at the work's burn (workBurns).
function burnsOf(s: State, samples: readonly Sample[], now: number) {
  const labels = [
    ...new Set(s.accounts.flatMap((a) => a.scoped.map((l) => l.label))),
  ];
  return workBurns(samples, labels, now, BURN_HORIZON);
}

async function burnRates($: EngineInterface, s: State, now: number) {
  const usage = await liveUsage($, s, now);
  return burnsOf(s, await recordSample($, now, activeAccount(s), usage), now);
}

// Every runway session on this machine shares one folder, so that they have one
// coordinator and one plan, and never switch at once.
let switchDirPath: string | undefined;

async function switchDir($: EngineInterface) {
  return (switchDirPath ??= `${await home($)}/.claude/runway/switch`);
}

// The time of the last switch this machine's runway sessions made, at a limit
// or by plan, for tidy, whose keep-alive takes the cache as gone after it.
// plan.json records every switch too, but a plan pending in it hides the last
// one's time until it closes.
async function writeLastSwitch($: EngineInterface, s: State) {
  await $.fs
    .write(
      `${await switchDir($)}/last-switch.json`,
      JSON.stringify({ switchedAt: s.lastSwitchAt, sessionId: s.sessionId }),
    )
    .catch(() => undefined);
}

function recordPath(dir: string, sessionId: string) {
  return `${dir}/sessions/${sessionId}.json`;
}

async function readPlan(
  $: EngineInterface,
  dir: string,
): Promise<SwitchPlan | undefined> {
  return parsePlan(await $.fs.read(`${dir}/plan.json`).catch(() => ""));
}

async function writePlan($: EngineInterface, dir: string, plan: SwitchPlan) {
  await $.fs.write(`${dir}/plan.json`, JSON.stringify(plan));
}

async function liveSessions(
  $: EngineInterface,
  dir: string,
  now: number,
): Promise<SessionRecord[]> {
  const entries = await $.fs.list(`${dir}/sessions`).catch(() => []);
  const records = await Promise.all(
    entries.map(async (entry) => {
      const path = `${dir}/sessions/${entry.name}`;
      const record =
        entry.kind === "file"
          ? parseRecord(await $.fs.read(path).catch(() => ""))
          : undefined;
      if (!record || !isGone(record, now)) return record;
      await removeFile($, path);
      return undefined;
    }),
  );
  return records.filter((r): r is SessionRecord => r !== undefined);
}

function recentModels(s: State, now: number): Record<string, number> {
  s.models = Object.fromEntries(
    Object.entries(s.models).filter(([, at]) => now - at <= USE_HORIZON),
  );
  return s.models;
}

async function writeRecord(
  $: EngineInterface,
  s: State,
  dir: string,
  sessionId: string,
  now: number,
) {
  await $.fs.write(
    recordPath(dir, sessionId),
    JSON.stringify({
      sessionId,
      project: await $.session.root(),
      updatedAt: now,
      models: recentModels(s, now),
    } satisfies SessionRecord),
  );
}

// The model-specific windows that live sessions use, this one's own use included.
async function inUseNow(
  $: EngineInterface,
  s: State,
  now: number,
): Promise<Set<string>> {
  const own: SessionRecord = {
    sessionId: s.sessionId ?? "",
    project: "",
    updatedAt: now,
    models: recentModels(s, now),
  };
  const live = await liveSessions($, await switchDir($), now);
  return scopesInUse([...live, own], s.accounts, now);
}

let isTendingSwitch = false;
let lastTendAt = -Infinity;

// Every session's runway writes only its own record; only the coordinator
// writes the plan and switches, at once: a switch empties every session's
// prompt cache whether or not busy sessions pause first. Turn starts and ends
// call it too, so a call within a tick of the last run is skipped, unless the
// pool was never listed (or a switch asked for a new listing) or a limit is
// pending.
async function tendSwitch($: EngineInterface, s: State) {
  const sessionId = s.sessionId;
  if (isTendingSwitch || sessionId === undefined || !s.isDefaultProfile) return;
  const now = await $.clock.now();
  if (
    now - lastTendAt < SWITCH_TICK &&
    s.poolCheckedAt !== 0 &&
    s.interruption === undefined
  )
    return;
  if (isTendingSwitch) return;
  lastTendAt = now;
  isTendingSwitch = true;
  try {
    await refreshPool($, s, now);
    if (!s.pool) return;
    const dir = await switchDir($);
    const plan = await readPlan($, dir);
    noteSwitch(s, plan);
    await writeRecord($, s, dir, sessionId, now);
    if (!canSwitch(s)) return;
    const live = await liveSessions($, dir, now);
    if (coordinatorOf(live) !== sessionId) return;
    noteSwitch(s, await coordinate($, s, dir, plan, live, now));
  } finally {
    isTendingSwitch = false;
  }
}

async function coordinate(
  $: EngineInterface,
  s: State,
  dir: string,
  plan: SwitchPlan | undefined,
  live: SessionRecord[],
  now: number,
): Promise<SwitchPlan | undefined> {
  const active = activeAccount(s);
  if (active === undefined) return plan;
  // The account moved outside the plan, by hand or by another session.
  if (
    plan &&
    plan.switchedAt === undefined &&
    plan.cancelledAt === undefined &&
    plan.from !== active
  )
    return closePlan($, s, dir, plan, now, "cancelled");
  // isPending narrows `plan`; the carried fields come from the last plan
  // however it ended.
  const last: SwitchPlan | undefined = plan;
  const inUse = scopesInUse(live, s.accounts, now);
  const burns = await burnRates($, s, now);
  const proposal = proposeSwitch({
    now,
    accounts: s.accounts,
    burnPerHour: burns,
    inUse,
    maxWait: s.config.switchMaxWait,
    lastSwitchAt: s.lastSwitchAt || undefined,
    left: last?.left,
  });
  if (isPending(plan, active)) {
    if (!proposal) return closePlan($, s, dir, plan, now, "cancelled");
    // The planned target can fill up while a failed switch waits to be tried again.
    return switchFor(
      $,
      s,
      dir,
      proposal.reason === plan.reason ? { ...plan, to: proposal.to } : plan,
      live,
      now,
    );
  }
  if (!proposal) return plan;
  const created = switchRecord(last, proposal, now);
  const recentSwitches = created.recentSwitches ?? [];
  await writePlan($, dir, created);
  await logEvent($, s, {
    event: "switch-plan",
    ...created,
    sessions: live.length,
    inUse: [...inUse],
    burns,
    accounts: s.accounts.map((a) => ({
      number: a.number,
      five: a.five,
      seven: a.seven,
      scoped: a.scoped,
      fetchedAt: a.fetchedAt,
    })),
  });
  if (recentSwitches.length >= SWITCH_WARNING_COUNT)
    await fail(
      $,
      s,
      "warning",
      `runway has switched accounts ${recentSwitches.length} times in the last hour and plans another (${proposal.reason}, ${proposal.from} to ${proposal.to}); each switch empties every session's prompt cache. See the switch-plan events in ${s.logPath}.`,
    );
  return switchFor($, s, dir, created, live, now);
}

// Two sessions can both coordinate for a moment while the set of sessions
// changes, so the active account is read afresh right before switching.
// Switches run one at a time: the coordinator's plan and a limit seen by a
// session can call for the same switch at once.
const serially = queue();

async function switchFor(
  $: EngineInterface,
  s: State,
  dir: string,
  plan: SwitchPlan,
  live: SessionRecord[],
  now: number,
): Promise<SwitchPlan> {
  return serially(() => switchForPlan($, s, dir, plan, live, now));
}

async function switchForPlan(
  $: EngineInterface,
  s: State,
  dir: string,
  plan: SwitchPlan,
  live: SessionRecord[],
  now: number,
): Promise<SwitchPlan> {
  await relistPool($, s, now);
  const active = activeAccount(s);
  if (active !== undefined && active !== plan.from)
    return closePlan(
      $,
      s,
      dir,
      { ...plan, to: active },
      now,
      "switched",
      "elsewhere",
      live,
    );
  return (await switchAccount($, s, plan)) ?? plan;
}

// The one way runway switches accounts, whatever calls for it: `cswap
// switch`, then the record of the switch where every session reads it.
// plan.json holds it as a closed plan, carried on from the last one (the
// accounts a switch near or at a limit left, and the switches of the last
// hour): every runway session reads it, so that each sees every switch.
// last-switch.json holds its time, for tidy. `sw` is the coordinator's pending
// plan, or what a limit calls for. Resolves the record, or undefined when cswap
// failed. Callers run it within `serially`.
async function switchAccount(
  $: EngineInterface,
  s: State,
  sw: SwitchPlan | { reason: string; to: number; leaves?: number },
): Promise<SwitchPlan | undefined> {
  const from = activeAccount(s);
  if ((await cswap($, s, ["switch", String(sw.to)])) !== 0) return undefined;
  const now = await $.clock.now();
  s.lastSwitchAt = now;
  await writeLastSwitch($, s);
  await relistPool($, s, now);
  const dir = await switchDir($);
  const plan =
    "id" in sw
      ? sw
      : // 0 for a login that no cswap account was active on.
        switchRecord(await readPlan($, dir), { from: from ?? 0, ...sw }, now);
  const moved = activeAccount(s);
  const to = moved === undefined || moved === from ? sw.to : moved;
  return closePlan($, s, dir, { ...plan, to }, now, "switched", "runway");
}

async function closePlan(
  $: EngineInterface,
  s: State,
  dir: string,
  plan: SwitchPlan,
  now: number,
  how: "switched" | "cancelled",
  by?: string,
  live?: SessionRecord[],
): Promise<SwitchPlan> {
  const closed =
    how === "switched"
      ? { ...plan, switchedAt: now }
      : { ...plan, cancelledAt: now };
  await writePlan($, dir, closed);
  await logEvent($, s, {
    event: how === "switched" ? "switch-done" : "switch-cancelled",
    id: plan.id,
    from: plan.from,
    to: plan.to,
    reason: plan.reason,
    ...(by ? { by } : {}),
    ...(live ? { sessions: live.length } : {}),
  });
  return closed;
}

// Another session's switch moves this session's login too.
function noteSwitch(s: State, plan: SwitchPlan | undefined) {
  if (plan?.switchedAt === undefined || plan.switchedAt <= s.lastSwitchAt)
    return;
  s.lastSwitchAt = plan.switchedAt;
  s.poolCheckedAt = 0;
}

const LIMIT_STATUS = "A usage limit stopped the session";

// The model each loop last requested and when the request started, by agent
// id ("" for the main loop).
type Request = { model: string; at: number };
const lastModels = new Map<string, Request>();

// The model-specific window a rate-limited request on `model` hit: the model
// is in one of the active account's windows, and its all-models windows have
// room (an account without it serves no model).
async function scopedLimitOf(
  $: EngineInterface,
  s: State,
  model: string | undefined,
  now: number,
): Promise<string | undefined> {
  const label =
    model === undefined
      ? undefined
      : scopeOf(
          model,
          s.accounts.find((a) => a.isActive),
        );
  if (label === undefined) return undefined;
  const usage = await liveUsage($, s, now);
  return usage && exhaustedUntil([usage.five, usage.seven], now) !== undefined
    ? undefined
    : label;
}

async function scopedSwitchTarget(
  $: EngineInterface,
  s: State,
  scope: string,
  now: number,
): Promise<number | undefined> {
  const inUse = await inUseNow($, s, now);
  inUse.add(scope);
  const burns = burnsOf(s, await storedSamples($, now), now);
  return scopedTarget(
    scope,
    s.accounts,
    now,
    burns,
    s.config.switchMaxWait,
    inUse,
  );
}

// Moves every session off `from`, whose `scope` window is full, to an account
// with room in it. Resolves the account the work is on afterwards, or
// undefined when there is none to move to; another switch may have moved it
// already.
function switchForScope(
  $: EngineInterface,
  s: State,
  scope: string,
  from: number | undefined,
  now: number,
): Promise<number | undefined> {
  return serially(async () => {
    await relistPool($, s, now);
    const active = activeAccount(s);
    if (active !== undefined && active !== from) return active;
    const to = await scopedSwitchTarget($, s, scope, now);
    if (to === undefined) return undefined;
    const leaves = s.accounts
      .find((a) => a.isActive)
      ?.scoped.find((l) => l.label === scope)?.resetsAt;
    return (await switchAccount($, s, { reason: `limit:${scope}`, to, leaves }))
      ?.to;
  });
}

// The account whose `scope` window resets first, among those in rotation.
function firstScopeReset(s: State, scope: string, now: number) {
  return s.accounts
    .filter(isInRotation)
    .flatMap((a) => {
      const w = a.scoped.find((l) => l.label === scope);
      return w && w.resetsAt > now
        ? [{ account: a.number, at: w.resetsAt }]
        : [];
    })
    .sort((x, y) => x.at - y.at)[0];
}

let isHandlingModelLimit = false;

// A subagent's request hit a model-specific limit while the account has
// all-models room: runway switches every session to an account with room in
// that window at once, as at a main turn's limit, and tells the session to
// retry. A limit of the all-models windows is the main turn's to meet. A
// request that started before the last switch hit the account it left.
async function noteSubagentLimit(
  $: EngineInterface,
  s: State,
  request: Request | undefined,
) {
  if (isHandlingModelLimit || !canSwitch(s)) return;
  isHandlingModelLimit = true;
  try {
    const now = await $.clock.now();
    await relistPool($, s, now);
    if (!canSwitch(s)) return;
    const model = request?.model;
    const scope = await scopedLimitOf($, s, model, now);
    if (scope === undefined) return;
    const from = activeAccount(s);
    if (request && request.at < s.lastSwitchAt) {
      await logEvent($, s, {
        event: "scoped-limit",
        model,
        scope,
        outcome: "before-switch",
      });
      note(
        $,
        s,
        `[runway] A ${model} request from a subagent hit a ${scope} limit, but it started before runway switched accounts ${mins((now - s.lastSwitchAt) / MINUTE)} ago; retry the ${scope} work.`,
      );
      return;
    }
    const hit = `[runway] A ${model} request from a subagent hit account ${from}'s ${scope} limit.`;
    // Other sessions' coordinator reads this record: with the use in it, it
    // does not move back to an account whose window is full.
    if (s.sessionId)
      await writeRecord($, s, await switchDir($), s.sessionId, now);
    const to = await switchForScope($, s, scope, from, now);
    if (to !== undefined) {
      await logEvent($, s, {
        event: "scoped-limit",
        model,
        scope,
        from,
        to,
        outcome: "switched",
      });
      note(
        $,
        s,
        `${hit} Runway switched every session to account ${to}, which has ${scope} room; retry the ${scope} work.`,
      );
      return;
    }
    const first = firstScopeReset(s, scope, now);
    await logEvent($, s, {
      event: "scoped-limit",
      model,
      scope,
      from,
      outcome: "no-target",
    });
    note(
      $,
      s,
      `${hit} No other account has room in its ${scope} and all-models windows, so runway did not switch.` +
        (first
          ? ` The first ${scope} window to reset is account ${first.account}'s, at ${hhmm(first.at)}.`
          : ""),
    );
  } finally {
    isHandlingModelLimit = false;
  }
}

// A limit stopped the main turn. Runway moves to an account with room at
// once (for a model-specific limit, one with room in that window), or, with
// none, waits for the first account to recover. When this account recovers
// first, or runway cannot switch, it resumes the session itself if Claude
// Code's auto-continue does not.
async function noteLimit($: EngineInterface, s: State) {
  const now = await $.clock.now();
  // One limit can report twice in a turn (StopFailure and the turn's error).
  if (s.interruption && s.interruption.at >= s.turnAt) return;
  if (canSwitch(s)) await relistPool($, s, now);
  const pool = canSwitch(s) ? s.pool : undefined;
  const scope = pool
    ? await scopedLimitOf($, s, lastModels.get("")?.model, now)
    : undefined;
  if (scope !== undefined) {
    const from = activeAccount(s);
    const to = await switchForScope($, s, scope, from, now);
    if (to !== undefined) {
      await logEvent($, s, {
        event: "scoped-limit",
        model: lastModels.get("")?.model,
        scope,
        from,
        to,
        outcome: "switched",
      });
      s.interruption = { at: now, switchedAt: now };
      await setNotice(
        $,
        s,
        "limit",
        `${LIMIT_STATUS} at its ${scope} limit; switched to account ${to}, resuming shortly`,
      );
      return;
    }
  }
  const recovery = scope === undefined ? pool?.recovery : undefined;
  if (
    pool &&
    pool.viable === 0 &&
    recovery &&
    !recovery.isActive &&
    recovery.at > now
  ) {
    s.interruption = {
      at: now,
      switchTo: recovery.account,
      switchAt: recovery.at,
    };
    await setNotice(
      $,
      s,
      "limit",
      `${LIMIT_STATUS}; runway switches to account ${recovery.account} and resumes at ${hhmm(recovery.at)}`,
    );
    return;
  }
  const to =
    !pool || scope !== undefined
      ? undefined
      : pool.viable > 0
        ? limitTarget(
            s.accounts,
            now,
            burnsOf(s, await storedSamples($, now), now),
            await inUseNow($, s, now),
          )
        : recovery && !recovery.isActive
          ? recovery.account
          : undefined;
  const usage = await liveUsage($, s, now);
  // The account the switch leaves is out until its all-models windows reset.
  const leaves = usage && exhaustedUntil([usage.five, usage.seven], now);
  if (
    to !== undefined &&
    (await serially(() => switchAccount($, s, { reason: "limit", to, leaves })))
  ) {
    s.interruption = { at: now, switchedAt: now };
    await setNotice(
      $,
      s,
      "limit",
      `${LIMIT_STATUS}; switched accounts with cswap, resuming shortly`,
    );
    return;
  }
  const resetsAt = usage && usageExhaustedUntil(usage, now);
  s.interruption = { at: now, ...(resetsAt === undefined ? {} : { resetsAt }) };
  await logEvent($, s, {
    event: "limit",
    resetsAt:
      resetsAt === undefined ? undefined : new Date(resetsAt).toISOString(),
    revivals: s.revivals,
  });
  await setNotice(
    $,
    s,
    "limit",
    resetsAt === undefined
      ? `${LIMIT_STATUS}; runway tries to resume it at ${hhmm(now + retryDelay(s.revivals))}`
      : `${LIMIT_STATUS}; it resumes at ${hhmm(resetsAt)}`,
  );
}

// A main turn that ended in an error while a window shows exhausted, in case no
// StopFailure came.
async function noteErrorTurn($: EngineInterface, s: State) {
  const now = await $.clock.now();
  const usage = await liveUsage($, s, now);
  if (usage && usageExhaustedUntil(usage, now) !== undefined)
    await noteLimit($, s);
}

async function clearLimitStatus($: EngineInterface, s: State) {
  await setNotice($, s, "limit", undefined);
}

// cswap's latest reading of the active account; undefined without cswap.
function freshReading(s: State, now: number): Reading {
  const usage = s.isDefaultProfile ? activeUsage(s.accounts, now) : undefined;
  return usage && { exhaustedUntil: usageExhaustedUntil(usage, now) };
}

async function resumeIfDue($: EngineInterface, s: State) {
  const i = s.interruption;
  if (!i || s.isTurnRunning) return;
  // The user or auto-continue already resumed the session.
  if (s.turnAt > i.at) {
    s.interruption = undefined;
    await clearLimitStatus($, s);
    return;
  }
  const now = await $.clock.now();
  const isSwitch = i.switchTo !== undefined || i.switchedAt !== undefined;
  if (isSwitch && i.switchedAt === undefined) {
    if (i.switchAt !== undefined && now < i.switchAt) return;
    if (!canSwitch(s) || i.switchTo === undefined) {
      // Switching went away while the session waited; wait for the limit instead.
      s.interruption = {
        at: i.at,
        ...(i.switchAt === undefined ? {} : { resetsAt: i.switchAt }),
      };
      return;
    }
    // The coordinator may have switched to it already, once its window reset.
    await relistPool($, s, now);
    const to = i.switchTo;
    if (activeAccount(s) !== to) {
      const left = s.accounts.find((a) => a.isActive);
      const leaves = left && exhaustedUntil([left.five, left.seven], now);
      const reason = "recovered";
      if (!(await serially(() => switchAccount($, s, { reason, to, leaves }))))
        return;
    }
    i.switchedAt = now;
  }
  if (isSwitch && now - i.switchedAt! < RESUME_AFTER_SWITCH) return;
  if (!isSwitch) {
    const step = await revivalStep(i, now, s.revivals, async () => {
      await refreshPool($, s, now);
      return freshReading(s, now);
    });
    if (step.resetsAt !== undefined) i.resetsAt = step.resetsAt;
    if (step.step === "wait") return;
  }
  s.interruption = undefined;
  await clearLimitStatus($, s);
  if ((await $.settings.read()).autoContinueAtUsageLimit === false) {
    await logEvent($, s, {
      event: "resume-skipped",
      interruptedAt: new Date(i.at).toISOString(),
    });
    await setNotice(
      $,
      s,
      "resume",
      `${isSwitch ? "Runway switched accounts after a usage limit" : "The usage limit cleared"}. autoContinueAtUsageLimit is off, so runway does not resume the session.`,
    );
    return;
  }
  let what = `The usage limit that interrupted work at ${hhmm(i.at)} has cleared.`;
  if (isSwitch) {
    await relistPool($, s, now);
    what = `Runway switched to account ${activeAccount(s) ?? "(unknown)"} after the usage limit that interrupted work at ${hhmm(i.at)}.`;
  }
  s.revivals++;
  await logEvent($, s, {
    event: "resume",
    interruptedAt: new Date(i.at).toISOString(),
    ...(isSwitch ? { switchedTo: activeAccount(s) } : {}),
    revivals: s.revivals,
  });
  void $.prompt.submit({
    text: `[runway] ${what} Continue the interrupted work, and do not repeat work that is already done. If nothing was left unfinished, reply only "Nothing to resume."`,
  });
}

// The engine shows whether Remote Control is on only in the command's typeahead line.
async function tendRemoteControl($: EngineInterface, s: State) {
  if (!s.config.remoteControlRestore) return;
  const account = activeAccount(s);
  const command = (await $.command.list()).find(
    (c) => c.name === "remote-control",
  );
  if (account === undefined || command === undefined) return;
  const { watch, action } = watchRemoteControl(
    s.remoteControl,
    account,
    command.description.startsWith("Disconnect"),
    await $.clock.now(),
  );
  s.remoteControl = watch;
  if (action === "give-up")
    await logEvent($, s, { event: "remote-control-not-dropped", account });
  if (action !== "restore") return;
  await logEvent($, s, { event: "remote-control-restore", account });
  void $.command.run({ command: "remote-control" }).catch((error) =>
    logEvent($, s, {
      event: "remote-control-restore-failed",
      error: String(error),
    }),
  );
}

async function installCswap($: EngineInterface): Promise<string | undefined> {
  for (const installer of [
    ["uv", "tool", "install", "claude-swap"],
    ["pipx", "install", "claude-swap"],
  ]) {
    const ran = await runs($, installer, 300_000);
    if (ran === undefined) continue;
    if (ran.exitCode !== 0)
      return `\`${installer.join(" ")}\` failed: ${ran.output}`;
    if ((await runCswap($, ["--version"], 30_000))?.exitCode === 0)
      return undefined;
    return `\`${installer.join(" ")}\` installed claude-swap, but \`cswap\` is not on this session's PATH. Add the installer's bin directory to PATH, restart Claude Code, and run /add-account again.`;
  }
  return "claude-swap needs uv or pipx to install. Install uv (https://docs.astral.sh/uv/), or run `pipx install claude-swap` yourself, then run /add-account again.";
}

async function addAccount($: EngineInterface, s: State): Promise<string> {
  const done: string[] = [];
  if ((await runCswap($, ["--version"], 30_000))?.exitCode !== 0) {
    const problem = await installCswap($);
    if (problem) return problem;
    done.push("Installed claude-swap.");
  }
  const added = await runCswap($, ["add"], 60_000);
  if (added?.exitCode !== 0)
    return [
      ...done,
      `\`cswap add\` failed: ${added?.output ?? "cswap did not run"}`,
    ].join("\n");
  s.poolCheckedAt = 0;
  const listed = await runCswap($, ["list", "--json"], 60_000);
  const usable = (
    listed?.exitCode === 0 ? parseCswapList(listed.stdout) : []
  ).filter(isInRotation).length;
  done.push(
    `Added the logged-in subscription to claude-swap, which now manages ${usable} usable account${usable === 1 ? "" : "s"}.`,
  );
  done.push(
    usable < 2
      ? "To switch between subscriptions, log in to another one with /login (without /logout first) and run /add-account again."
      : !s.config.switching
        ? "Account switching is off in the runway settings (switching), so runway does not switch between them."
        : "Runway switches to another subscription before a limit stops the session.",
  );
  return done.join("\n");
}

export const register: Register = (on, options) => {
  const { config, problems } = readConfig(options);
  const s: State = {
    config,
    isDefaultProfile: true,
    notes: [],
    isTurnRunning: false,
    turnAt: 0,
    accounts: [],
    notices: {},
    poolCheckedAt: 0,
    lastSwitchAt: 0,
    models: {},
    lastResponseAt: 0,
    revivals: 0,
  };

  on("session.start", async ($, e, next) => {
    const result = await next(e);
    const [, id, h, configDir] = await Promise.all([
      $.command.register({
        name: "add-account",
        description:
          "Add the logged-in subscription to claude-swap, installing it if needed, so runway can switch between subscriptions.",
      }),
      $.session.id(),
      home($),
      $.env.get("CLAUDE_CONFIG_DIR"),
    ]);
    await restore($, s, id);
    s.sessionId = id;
    s.logPath = `${h}/.claude/runway/${id}.jsonl`;
    s.isDefaultProfile = isDefaultProfile(configDir, h);
    // A session resumed in another profile, such as with `cswap run`, may have left a record.
    if (!s.isDefaultProfile)
      await removeFile($, recordPath(await switchDir($), id));
    if (problems.length > 0) {
      $.ui.toast(problems.join("\n"));
      await logEvent($, s, { event: "options-ignored", problems });
    }
    $.clock.every(SAVE_SPACING, () => void save($, s));
    $.clock.every(SWITCH_TICK, () => void tendSwitch($, s));
    $.clock.every(SWITCH_TICK, () => void tendRemoteControl($, s));
    // Passing notices expire between the changes that render the line.
    $.clock.every(
      SWITCH_TICK,
      () => void $.clock.now().then((now) => renderStatus($, s, now)),
    );
    renderStatus($, s, await $.clock.now(), true);
    $.clock.every(REVIVAL_TICK, () => void resumeIfDue($, s));
    void tendSwitch($, s);
    return result;
  });

  on("session.end", async ($, e, next) => {
    if (s.sessionId)
      await removeFile($, recordPath(await switchDir($), s.sessionId));
    return next(e);
  });

  on("command.run", { command: "add-account" }, async ($) => ({
    text: await addAccount($, s),
  }));

  on("tool.call", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId !== undefined) return result;
    if (s.notes.length === 0 || result.deny !== undefined) return result;
    const delivered = s.notes;
    s.notes = [];
    return { ...result, context: [...(result.context ?? []), ...delivered] };
  }).catch(($, e, next) => next(e));

  on("session.measure", async ($, e, next) => {
    const result = await next(e);
    await checkLimitWait($, s, e);
    return result;
  });

  // StopFailure fires for a subagent's failed request too (with agent_id); only
  // the main turn's limit stops the session.
  on("classic.StopFailure", async ($, e, next) => {
    await logEvent($, s, {
      event: "stop-failure",
      error: e.error,
      details: e.error_details,
      ...(e.agent_id === undefined ? {} : { agentId: e.agent_id }),
    });
    if (e.error === "rate_limit" && e.agent_id === undefined)
      await noteLimit($, s);
    else if (e.error === "rate_limit")
      await noteSubagentLimit($, s, lastModels.get(e.agent_id!));
    return next(e);
  });

  on("turn.step", async function* ($, e, next) {
    const requestedAt = await $.clock.now();
    lastModels.set(e.agentId ?? "", { model: e.model, at: requestedAt });
    s.models[e.model] = requestedAt;
    const result = yield* next(e);
    if (e.agentId === undefined && result.usage)
      s.lastResponseAt = await $.clock.now();
    return result;
  });

  on("turn.start", async ($, e, next) => {
    if (e.agentId === undefined) {
      s.turnAt = await $.clock.now();
      s.isTurnRunning = true;
      // The person is back at work: a skipped resume is no longer news.
      await setNotice($, s, "resume", undefined);
    }
    void tendSwitch($, s);
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId !== undefined) return result;
    s.isTurnRunning = false;
    if (e.reason === "error") await noteErrorTurn($, s);
    // However the engine reports a turn that a limit stopped, it does not count
    // as working again.
    const isLimited =
      s.interruption !== undefined && s.interruption.at >= s.turnAt;
    if (e.reason === "answer" && !isLimited) s.revivals = 0;
    void tendSwitch($, s);
    await save($, s);
    return result;
  });
};
