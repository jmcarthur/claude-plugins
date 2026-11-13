import { hhmm, HOUR, MINUTE, mins, type Window } from "./limits";

// The note that suggests compacting before a usage limit stops the work for
// longer than the prompt cache lasts. Runway gives it only while tidy's compact
// tool is loaded, since it needs the usage, burn and other-account readings
// that runway keeps.

export const NEAR_LIMIT = 95;
// The longest prompt-cache lifetime Claude Code gives (an hour; five minutes
// or none on some setups). Runway does not detect the lifetime: a wait past
// the longest one outlasts the cache whatever it is.
const LONGEST_CACHE_LIFETIME = HOUR;

// A window as the compaction note reports it: which limit it is, and where
// and when runway read it.
export type LimitReading = Window & {
  name: string;
  source: "headers" | "cswap";
  readAt?: number;
  burnPerHour?: number;
};

export type LimitWait<W extends Window = Window> = {
  resetsAt: number;
  until: number;
  near: W[];
};

// The windows near their limit, when the longest wait for one of them to
// reset (or for the first account to recover) outlasts any prompt cache.
// Whether a window stops the session is the session's call: a window for one
// model family stops only work on it, and one below 100% stops nothing yet.
export function longLimitWait<W extends Window>(
  windows: readonly (W | undefined)[],
  now: number,
  recoveryAt?: number,
): LimitWait<W> | undefined {
  const near = windows.filter(
    (w): w is W => w !== undefined && w.used >= NEAR_LIMIT && w.resetsAt > now,
  );
  if (near.length === 0) return undefined;
  const resetsAt = Math.max(...near.map((w) => w.resetsAt));
  const until =
    recoveryAt === undefined ? resetsAt : Math.min(resetsAt, recoveryAt);
  return until - now > LONGEST_CACHE_LIFETIME
    ? { resetsAt, until, near }
    : undefined;
}

const percent = (n: number) => `${Math.round(n * 10) / 10}%`;
const SOURCES = {
  headers: "the last response's rate-limit headers",
  cswap: "cswap list",
} as const;

function describeReading(r: LimitReading, now: number): string {
  const read =
    r.readAt === undefined
      ? `from ${SOURCES[r.source]}`
      : `from ${SOURCES[r.source]}, ${mins((now - r.readAt) / MINUTE)} old`;
  let burn = "";
  if (r.burnPerHour !== undefined && r.used < 100) {
    const fullAt =
      r.burnPerHour > 0 ? now + ((100 - r.used) / r.burnPerHour) * HOUR : NaN;
    burn =
      Number.isNaN(fullAt) || fullAt >= r.resetsAt
        ? `; at the recent burn (${percent(r.burnPerHour)}/h) it lasts to its reset`
        : `; at the recent burn (${percent(r.burnPerHour)}/h) it reaches 100% at ${hhmm(fullAt)}`;
  }
  return `- ${r.name}: ${percent(r.used)} used, resets ${hhmm(r.resetsAt)} (in ${mins((r.resetsAt - now) / MINUTE)}); ${read}${burn}.`;
}

export type LimitContext = {
  account?: { number: number; email: string };
  // Whether runway switches accounts for this session. The note comes only
  // when no other account has room.
  canSwitch: boolean;
  recovery?: { account: number; at: number };
};

// `tool` is the compact tool that tidy registers: the model cannot run /compact itself.
export function compactBeforeLimitNote(
  contextTokens: number,
  wait: LimitWait<LimitReading>,
  now: number,
  c: LimitContext,
  tool: string,
): string {
  const whose = c.account
    ? ` on account ${c.account.number} (${c.account.email})`
    : "";
  const others = c.canSwitch
    ? `No other cswap account is below ${NEAR_LIMIT}% in its 5-hour and weekly windows` +
      (c.recovery
        ? `; account ${c.recovery.account} is the first to have room again, at ${hhmm(c.recovery.at)}.`
        : ".")
    : "Runway is not switching accounts for this session.";
  return [
    `[runway] Usage windows at ${NEAR_LIMIT}% or more${whose} that reset more than an hour from now:`,
    ...wait.near.map((r) => describeReading(r, now)),
    others,
    "These are readings, not a forecast that this session stops: a window for one model family stops only work on that family, and a window below 100% stops nothing until it fills. " +
      `The context is ${Math.round(contextTokens / 1000)}k tokens. If you expect work on a model that one of these windows covers to stop until then, and to continue after it, call ${tool} at a stopping point before the stop: no prompt cache lasts more than an hour, so the first turn after the stop reads the whole context uncached. ` +
      "A compaction that fails leaves the context as it was.",
  ].join("\n");
}
