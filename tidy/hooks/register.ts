import type { EngineInterface, PromptOrigin, Register } from "claude-code";
import type { TidySnapshot } from "../types";
import {
  cacheLifetime,
  cachePolicy,
  coldCache,
  lifetimeMs,
  promptTokens,
  shouldPing,
  touched,
  uncached,
  type CachePolicy,
  type CacheState,
  type Lifetime,
  type LifetimeSignals,
} from "./cache";
import {
  boundaryNote,
  boundaryOf,
  isPersonsPrompt,
  nextWait,
  waitOf,
  workOf,
  type Wait,
} from "./compaction";
import { appendLog } from "./log";
import { readConfig, type Config } from "./options";
import {
  isDefaultProfile,
  isExhausted,
  LAST_SWITCH_FILE,
  switchedAtOf,
} from "./signals";
import { MINUTE } from "./time";

const COMPACT_TOOL = "mcp__tidy__compact";
const NUDGE_SPACING = 30 * MINUTE;
// A compaction still scheduled when the session restarts belongs to work long past.
const STALE_COMPACTION = 10 * MINUTE;
const KEEPALIVE_TICK = 30_000;
const KEEPALIVE_PROMPT = "Cache keep-alive. Reply with the single word: ok";
const SAVE_SPACING = 10_000;
const SESSION_STATE = { plugin: "tidy", key: "session" } as const;

const COMPACT_DESCRIPTION = `Compact this session's context without the user, then continue working.

Every turn re-reads the whole context, so a large context makes every later step, wake and peer message more expensive. But compacting costs a full read, a summary and a cache write of the files and skills that Claude Code re-attaches, loses detail, and may force files to be read again, so it pays only when enough model requests lie ahead. Call it at a boundary: work just recorded, a phase finished, a wait on background work about to begin, or a stop at a usage limit whose reset is more than an hour away (the cache expires during that wait, so compacting before the limit is cheaper than reading the whole context uncached after the reset). Write anything you still need from recent tool output to a file first, and use \`focus\` to name what the next steps need.

The compaction runs when the current turn ends. End the turn right after this call. The final message of the turn stays verbatim after the compaction, so put the next steps there. Give \`resume\` only when the session must keep working at once: tidy then submits it as the next prompt. Leave it out when the session will wait for background work, a scheduled wakeup or the user.`;

// A Stop hook that continues the turn (a /goal check, for one) would hold off
// the compaction until the work it asks for is done; tidy ends the turn
// instead and hands the hook's reason on after the compaction, in `continuation`.
type PendingCompaction = {
  focus?: string;
  resume?: string;
  continuation?: string;
  at: number;
  isDeferred?: boolean;
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
  pendingCompact?: PendingCompaction;
  boundary?: { text: string; at: number };
  // The wait on background work the session is in, and the work in flight at
  // the last turn end.
  wait?: Wait;
  inFlight?: string[];
  nudgedBoundaryAt?: number;
  lastNudgeAt: number;
  midTurnPromptAt?: number;
  heldPromptAt?: number;
  lastResponseAt: number;
  // When a usage limit stopped the main turn, until the next main turn starts.
  limitedAt?: number;
  // The main thread's prompt cache, kept warm while the session waits on
  // background work.
  cache: CacheState;
  cacheLifetime?: Lifetime;
};

async function home($: EngineInterface) {
  return (await $.env.get("HOME")) ?? "";
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

let savedSnapshot = "";

async function save($: EngineInterface, s: State) {
  const { config, ...kept } = s;
  const snapshot = JSON.stringify(kept);
  if (snapshot === savedSnapshot) return;
  savedSnapshot = snapshot;
  await $.state.set(SESSION_STATE, JSON.parse(snapshot) as TidySnapshot);
}

async function restore($: EngineInterface, s: State, sessionId: string) {
  const { value } = await $.state.get(SESSION_STATE);
  if (value?.sessionId === sessionId) Object.assign(s, value as Partial<State>);
}

// ---- Compaction ----

// Refuses the compact tool once for a message the user typed during this turn.
// Expected false positives: a message the session already answered (one extra call).
// Expected false negatives: Claude Code's own autocompaction, which this cannot hold.
async function compactHold(
  $: EngineInterface,
  s: State,
): Promise<string | undefined> {
  const at = s.midTurnPromptAt;
  if (at === undefined || at < s.turnAt || s.heldPromptAt === at)
    return undefined;
  s.heldPromptAt = at;
  await logEvent($, s, {
    event: "compact-held",
    messageAt: new Date(at).toISOString(),
  });
  return `[tidy] Not scheduled: a user message at ${new Date(at).toISOString().slice(11, 16)} UTC came in during this turn and may be unanswered; the summary can drop it. Read it, answer it in your final message or name it in focus, then call ${COMPACT_TOOL} again.`;
}

// A message typed over a running turn reaches the model mid-turn, where a
// compaction in the same turn can drop it. A new request from the person ends
// the wait on background work: the turn it starts is not part of the wait.
async function notePrompt(
  $: EngineInterface,
  s: State,
  e: { text: string; origin: PromptOrigin; turnId?: string; wait: boolean },
) {
  if (!isPersonsPrompt(e.origin, e.text)) return;
  s.wait = undefined;
  if (e.turnId !== undefined && !e.wait)
    s.midTurnPromptAt = await $.clock.now();
}

// The compaction advice at the turn's end, the one moment compacting costs no
// unfinished work; once per boundary. The boundary is the wait the turn ends
// in (once per wait, however many turns it spans), else work recorded during
// the turn.
// Expected false positives: a boundary with more work right after it (a one-line reply).
// Expected false negatives: work recorded by a tool other than boundaryOf's
// version-control commands.
async function boundaryBlock(
  $: EngineInterface,
  s: State,
  wait: string | undefined,
): Promise<string | undefined> {
  if (s.config.nudgeTokens <= 0) return undefined;
  const now = await $.clock.now();
  const recorded = s.boundary;
  const b = [
    wait && s.wait ? { text: wait, at: s.wait.at } : undefined,
    recorded && recorded.at >= s.turnAt ? recorded : undefined,
  ].find((x) => x !== undefined && x.at !== s.nudgedBoundaryAt);
  if (!b || now - s.lastNudgeAt < NUDGE_SPACING) return undefined;
  const context = (await $.session.usage()).context.tokens;
  if (context === undefined || context < s.config.nudgeTokens) return undefined;
  s.nudgedBoundaryAt = b.at;
  s.lastNudgeAt = now;
  await logEvent($, s, { event: "compaction-prompt", context });
  return boundaryNote(b.text, context, COMPACT_TOOL);
}

let isCompactionRunning = false;

// The job stays in s.pendingCompact, which survives a plugin reload, until it ends.
async function runPendingCompaction($: EngineInterface, s: State) {
  const job = s.pendingCompact;
  if (!job || isCompactionRunning) return;
  isCompactionRunning = true;
  try {
    if (await runCompaction($, s, job)) s.pendingCompact = undefined;
  } finally {
    isCompactionRunning = false;
    await save($, s);
  }
}

// Resolves false when a turn started first, which leaves the job for that turn's end.
async function runCompaction(
  $: EngineInterface,
  s: State,
  job: PendingCompaction,
): Promise<boolean> {
  let lastError = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    // A queued message or wake can start a turn the moment the calling turn
    // ends, and $.session.compact rejects while a turn runs.
    if (s.isTurnRunning) {
      if (!job.isDeferred)
        note(
          $,
          s,
          "[tidy] A new turn started before the scheduled compaction could run, so it runs when this turn ends.",
        );
      job.isDeferred = true;
      return false;
    }
    try {
      const result = await $.session.compact({ instructions: job.focus });
      await logEvent($, s, {
        event: "compact",
        focus: job.focus,
        skip: result.skip,
      });
      if (result.skip)
        note($, s, `[tidy] Compaction was skipped: ${result.skip}.`);
      const followUp = followUpOf(job);
      if (followUp === undefined) return true;
      if (s.isTurnRunning) {
        note(
          $,
          s,
          `[tidy] Another turn started right after the compaction, so tidy did not submit the resume prompt as a turn of its own. The resume prompt was: ${followUp}`,
        );
        return true;
      }
      void $.prompt.submit({ text: followUp });
      return true;
    } catch (error) {
      lastError = String(error);
      await logEvent($, s, {
        event: "compact-rejected",
        error: lastError,
        isTurnRunning: s.isTurnRunning,
      });
      await $.clock.sleep(2000);
    }
  }
  note(
    $,
    s,
    `[tidy] Compaction failed: ${lastError}. Call the compact tool again at the next boundary.`,
  );
  if (job.continuation !== undefined && !s.isTurnRunning)
    void $.prompt.submit({ text: continuationPrompt(job.continuation) });
  return true;
}

function followUpOf(job: PendingCompaction): string | undefined {
  const parts = [
    job.resume,
    job.continuation === undefined
      ? undefined
      : continuationPrompt(job.continuation),
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? undefined : parts.join("\n\n");
}

function continuationPrompt(reason: string): string {
  return `[tidy] A Stop hook continued the turn that the compaction needed to end. Tidy ended that turn for the compaction, and passes on what the hook said: ${reason}`;
}

// ---- Cache keep-alive ----

async function isSubscriber($: EngineInterface, s: State): Promise<boolean> {
  const { rateLimits } = await $.session.usage();
  if (rateLimits.some((l) => l.kind === "five_hour" || l.kind === "seven_day"))
    return true;
  // Tidy is for subscriptions: without a response yet, assume one.
  return s.lastResponseAt === 0;
}

// The environment is fixed for the process, so it is read once, at session start.
let lifetimeEnv: LifetimeSignals["env"] = {};

async function readLifetimeEnv($: EngineInterface) {
  lifetimeEnv = {
    DISABLE_PROMPT_CACHING: await $.env.get("DISABLE_PROMPT_CACHING"),
    FORCE_PROMPT_CACHING_5M: await $.env.get("FORCE_PROMPT_CACHING_5M"),
    CLAUDE_CODE_PROMPT_CACHE_TTL: await $.env.get(
      "CLAUDE_CODE_PROMPT_CACHE_TTL",
    ),
    ENABLE_PROMPT_CACHING_1H: await $.env.get("ENABLE_PROMPT_CACHING_1H"),
    ENABLE_PROMPT_CACHING_1H_BEDROCK: await $.env.get(
      "ENABLE_PROMPT_CACHING_1H_BEDROCK",
    ),
    CLAUDE_CODE_USE_BEDROCK: await $.env.get("CLAUDE_CODE_USE_BEDROCK"),
    CLAUDE_CODE_USE_VERTEX: await $.env.get("CLAUDE_CODE_USE_VERTEX"),
    CLAUDE_CODE_USE_FOUNDRY: await $.env.get("CLAUDE_CODE_USE_FOUNDRY"),
  };
}

async function refreshCacheLifetime($: EngineInterface, s: State) {
  const [settings, isSubscribed] = await Promise.all([
    $.settings.read(),
    isSubscriber($, s),
  ]);
  const lifetime = cacheLifetime({
    env: lifetimeEnv,
    settingTtl: settings.promptCacheTtl,
    isSubscriber: isSubscribed,
  });
  if (lifetime === s.cacheLifetime) return;
  s.cacheLifetime = lifetime;
  await logEvent($, s, {
    event: "cache-lifetime",
    lifetime,
    override: s.config.cacheTtlOverride,
  });
}

function keepAlivePolicy(s: State): CachePolicy {
  const override = s.config.cacheTtlOverride;
  const ttl = override ?? lifetimeMs(s.cacheLifetime ?? "1h");
  return cachePolicy(ttl, s.config.keepaliveBudget);
}

// The last account switch that runway recorded; 0 without one.
async function lastSwitchAt($: EngineInterface, s: State): Promise<number> {
  if (!s.isDefaultProfile) return 0;
  const path = `${await home($)}/${LAST_SWITCH_FILE}`;
  return switchedAtOf(await $.fs.read(path).catch(() => ""));
}

// While the session waits on background work, a fork of the main thread reads
// its cache just before it expires, so the turn that the work's report starts
// need not write the whole context again.
async function keepCacheWarm($: EngineInterface, s: State) {
  if (s.isTurnRunning || isCompactionRunning || s.limitedAt !== undefined)
    return;
  const now = await $.clock.now();
  if (!shouldPing(s.cache, keepAlivePolicy(s), now)) return;
  // A switch moved the login to another account, whose cache holds nothing of
  // this session. Read only before a ping: until a request caches the context
  // again, a switch since the last one changes nothing else.
  const switchedAt = await lastSwitchAt($, s);
  if (switchedAt > s.cache.lastTouchAt) {
    s.cache = uncached(s.cache, switchedAt);
    return;
  }
  s.cache.lastTouchAt = now;
  s.cache.pings++;
  const reply = await $.model.fork({ prompt: KEEPALIVE_PROMPT });
  await logEvent($, s, {
    event: "keepalive",
    ping: s.cache.pings,
    context: s.cache.contextTokens,
    ...(reply.isAnswered ? { usage: reply.usage } : { failed: reply.reason }),
  });
}

export const register: Register = (on, options) => {
  const { config, problems } = readConfig(options);
  const s: State = {
    config,
    isDefaultProfile: true,
    notes: [],
    isTurnRunning: false,
    turnAt: 0,
    lastNudgeAt: 0,
    lastResponseAt: 0,
    cache: coldCache(),
  };

  on("session.start", async ($, e, next) => {
    const result = await next(e);
    const compactTool = $.tool.register({
      name: "compact",
      description: COMPACT_DESCRIPTION,
      isDeferred: false,
      inputSchema: {
        type: "object",
        properties: {
          resume: {
            type: "string",
            description:
              "Only when the session must keep working at once: the prompt it continues with after compaction. Leave it out when the session will wait; the final message of the turn carries the next steps.",
          },
          focus: {
            type: "string",
            description:
              "What the summary must keep or stress, as typed after /compact.",
          },
        },
      },
    });
    const [id, h, configDir] = await Promise.all([
      $.session.id(),
      home($),
      $.env.get("CLAUDE_CONFIG_DIR"),
      readLifetimeEnv($),
      compactTool,
    ]);
    await restore($, s, id);
    s.sessionId = id;
    s.logPath = `${h}/.claude/tidy/${id}.jsonl`;
    s.isDefaultProfile = isDefaultProfile(configDir, h);
    if (problems.length > 0) {
      $.ui.toast(problems.join("\n"));
      await logEvent($, s, { event: "options-ignored", problems });
    }
    if (
      s.pendingCompact &&
      (await $.clock.now()) - s.pendingCompact.at > STALE_COMPACTION
    )
      s.pendingCompact = undefined;
    if (s.pendingCompact && !s.isTurnRunning)
      $.clock.after(500, () => void runPendingCompaction($, s));
    $.clock.every(SAVE_SPACING, () => void save($, s));
    $.clock.every(KEEPALIVE_TICK, () => void keepCacheWarm($, s));
    await refreshCacheLifetime($, s);
    return result;
  });

  on("tool.call", { tool: COMPACT_TOOL }, async ($, e) => {
    if (e.agentId !== undefined) {
      return {
        result:
          "Only the main session compacts this way. A subagent should finish its task and return a concise report instead.",
      };
    }
    const held = await compactHold($, s);
    if (held) return { result: held };
    const resume =
      typeof e.resume === "string" && e.resume.trim() !== ""
        ? e.resume
        : undefined;
    s.pendingCompact = {
      focus: typeof e.focus === "string" ? e.focus : undefined,
      resume,
      at: await $.clock.now(),
    };
    return {
      result:
        "Compaction is scheduled for the end of this turn. End the turn now. Your final message stays verbatim after the compaction: " +
        (resume
          ? "keep it short, because the resume prompt carries the next step."
          : "name the next steps and where the state lives, because nothing else starts the session again until its next wake."),
    };
  });

  on("tool.call", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId !== undefined) return result;
    const boundary = result.isError ? undefined : boundaryOf(e);
    if (boundary) s.boundary = { text: boundary, at: await $.clock.now() };
    if (s.notes.length === 0 || result.deny !== undefined) return result;
    const delivered = s.notes;
    s.notes = [];
    return { ...result, context: [...(result.context ?? []), ...delivered] };
  }).catch(($, e, next) => next(e));

  // StopFailure fires for a subagent's failed request too (with agent_id); only
  // the main turn's limit stops the session.
  on("classic.StopFailure", async ($, e, next) => {
    if (e.error === "rate_limit" && e.agent_id === undefined)
      s.limitedAt ??= await $.clock.now();
    return next(e);
  });

  // Blocks the end of a turn once per boundary with the compaction advice. A
  // block from another Stop hook while a compaction is scheduled is held for
  // after the compaction.
  on("classic.Stop", async ($, e, next) => {
    const wait = waitOf(e);
    s.cache.hasBackgroundWork = wait !== undefined;
    const work = workOf(e);
    s.wait = nextWait(s.wait, s.inFlight ?? [], work, await $.clock.now());
    s.inFlight = work;
    const result = await next(e);
    if (isCompactionRunning) return result;
    if (result.block === undefined) {
      const block =
        e.stop_hook_active || s.pendingCompact
          ? undefined
          : await boundaryBlock($, s, wait);
      return block === undefined ? result : { ...result, block };
    }
    if (!s.pendingCompact) return result;
    s.pendingCompact.continuation = result.block;
    await logEvent($, s, { event: "continuation-held" });
    const { block: _, ...ended } = result;
    return ended;
  });

  // A compaction of the main conversation, by anyone, leaves nothing cached
  // until the next request writes the new context.
  on("session.compact", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId === undefined && e.trigger !== "precompute" && !result.skip)
      s.cache = uncached(s.cache, await $.clock.now());
    return result;
  });

  on("prompt.submit", async ($, e, next) => {
    await notePrompt($, s, e);
    return next(e);
  });

  on("turn.step", async function* ($, e, next) {
    const result = yield* next(e);
    if (e.agentId === undefined && result.usage) {
      s.lastResponseAt = await $.clock.now();
      s.cache = touched(s.cache, s.lastResponseAt, promptTokens(result.usage));
    }
    return result;
  });

  on("turn.start", async ($, e, next) => {
    if (e.agentId === undefined) {
      s.turnAt = await $.clock.now();
      s.isTurnRunning = true;
      // A new main turn resumes the session, whether the person, Claude Code's
      // auto-continue or runway started it; if it hits the limit again, its
      // StopFailure says so.
      s.limitedAt = undefined;
      // The Stop at this turn's end says again what it leaves running; a turn
      // that a limit stops has no Stop and leaves nothing to keep warm.
      s.cache.hasBackgroundWork = false;
    }
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId !== undefined) return result;
    s.isTurnRunning = false;
    await refreshCacheLifetime($, s);
    // A main turn that ended in an error while a window shows exhausted, in
    // case no StopFailure came.
    if (e.reason === "error" && s.limitedAt === undefined) {
      const now = await $.clock.now();
      if (isExhausted((await $.session.usage()).rateLimits, now))
        s.limitedAt = now;
    }
    if (s.pendingCompact && e.isAborted && !isCompactionRunning) {
      s.pendingCompact = undefined;
      note(
        $,
        s,
        "[tidy] The turn was interrupted, so the scheduled compaction was dropped.",
      );
    } else if (s.pendingCompact)
      $.clock.after(500, () => void runPendingCompaction($, s));
    await save($, s);
    return result;
  });
};
