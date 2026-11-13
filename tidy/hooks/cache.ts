import { HOUR, MINUTE } from "./time";

export type Lifetime = "5m" | "1h" | "off";

export type LifetimeEnv =
  | "DISABLE_PROMPT_CACHING"
  | "FORCE_PROMPT_CACHING_5M"
  | "CLAUDE_CODE_PROMPT_CACHE_TTL"
  | "ENABLE_PROMPT_CACHING_1H"
  | "ENABLE_PROMPT_CACHING_1H_BEDROCK"
  | "CLAUDE_CODE_USE_BEDROCK"
  | "CLAUDE_CODE_USE_VERTEX"
  | "CLAUDE_CODE_USE_FOUNDRY";

export type LifetimeSignals = {
  env: Partial<Record<LifetimeEnv, string>>;
  settingTtl: unknown;
  isSubscriber: boolean;
};

const isTruthy = (value: string | undefined) =>
  value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
const asLifetime = (value: unknown): Lifetime | undefined =>
  value === "5m" || value === "1h" ? value : undefined;

// The main conversation's lifetime as Claude Code chooses it (2.1.296). Claude
// Code also drops a subscriber to five minutes while it draws extra usage,
// which no plugin API reports: the cacheTtlMinutes setting covers that.
export function cacheLifetime({
  env,
  settingTtl,
  isSubscriber,
}: LifetimeSignals): Lifetime {
  if (isTruthy(env.DISABLE_PROMPT_CACHING)) return "off";
  if (isTruthy(env.FORCE_PROMPT_CACHING_5M)) return "5m";
  const chosen =
    asLifetime(env.CLAUDE_CODE_PROMPT_CACHE_TTL?.trim()) ??
    asLifetime(settingTtl);
  if (chosen) return chosen;
  const isBedrock = isTruthy(env.CLAUDE_CODE_USE_BEDROCK);
  if (
    isTruthy(env.ENABLE_PROMPT_CACHING_1H) ||
    (isBedrock && isTruthy(env.ENABLE_PROMPT_CACHING_1H_BEDROCK))
  )
    return "1h";
  const isThirdParty =
    isBedrock ||
    isTruthy(env.CLAUDE_CODE_USE_VERTEX) ||
    isTruthy(env.CLAUDE_CODE_USE_FOUNDRY);
  return isSubscriber && !isThirdParty ? "1h" : "5m";
}

export function lifetimeMs(lifetime: Lifetime): number {
  return lifetime === "1h" ? HOUR : lifetime === "5m" ? 5 * MINUTE : 0;
}

// Every current Claude model reads its cache at 0.1 times the input price; a
// write costs 1.25 times for the five-minute lifetime and 2 times for the hour.
const CACHE_READ_COST = 0.1;
const KEEPALIVE_MIN_TOKENS = 20_000;

export type CachePolicy = {
  ttl: number;
  margin: number;
  minTokens: number;
  writeCost: number;
  readCost: number;
  budget: number;
};

// A ttl of 0 keeps nothing warm.
export function cachePolicy(ttl: number, budget: number): CachePolicy {
  return {
    ttl,
    margin: Math.min(5 * MINUTE, ttl / 5),
    minTokens: KEEPALIVE_MIN_TOKENS,
    writeCost: ttl > 5 * MINUTE ? 2 : 1.25,
    readCost: CACHE_READ_COST,
    budget,
  };
}

// lastTouchAt is the last request that read or wrote the main thread's cache:
// a main turn's, or a keep-alive ping's. contextTokens is 0 while nothing is
// cached (after a compaction or an account switch, until the next request).
export type CacheState = {
  lastTouchAt: number;
  contextTokens: number;
  pings: number;
  hasBackgroundWork: boolean;
};

export const coldCache = (): CacheState => ({
  lastTouchAt: 0,
  contextTokens: 0,
  pings: 0,
  hasBackgroundWork: false,
});

// Ski rental: keep paying for reads until they add up to one rewrite (times
// the budget), then let the cache go. With a budget of 1, no ping schedule can
// cost more than twice the best one in hindsight, without knowing how long the
// wait will last.
export function maxPings(p: CachePolicy): number {
  return Math.floor((p.budget * p.writeCost) / p.readCost);
}

// Whether a session that waits on background work, between turns, keeps its
// cache warm through the wait: the caller rules out a running turn or
// compaction.
export function keepsWarm(c: CacheState, p: CachePolicy): boolean {
  return (
    p.ttl > 0 &&
    c.hasBackgroundWork &&
    c.contextTokens >= p.minTokens &&
    c.pings < maxPings(p)
  );
}

export function shouldPing(
  c: CacheState,
  p: CachePolicy,
  now: number,
): boolean {
  return keepsWarm(c, p) && now - c.lastTouchAt >= p.ttl - p.margin;
}

// After a compaction or an account switch, nothing caches the context until
// the next request writes it, so there is nothing to keep warm before then.
export function uncached(c: CacheState, now: number): CacheState {
  return { ...c, lastTouchAt: now, contextTokens: 0, pings: 0 };
}

// A main request read or wrote the cache: a new wait starts from it.
export function touched(
  c: CacheState,
  now: number,
  contextTokens: number,
): CacheState {
  return { ...c, lastTouchAt: now, contextTokens, pings: 0 };
}

export function promptTokens(u: {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): number {
  return (
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0)
  );
}
