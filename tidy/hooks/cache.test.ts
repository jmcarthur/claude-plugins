import { expect, test } from "claude-code/testing";
import {
  cacheLifetime,
  cachePolicy,
  keepsWarm,
  lifetimeMs,
  maxPings,
  shouldPing,
  touched,
  uncached,
  type CacheState,
} from "./cache";
import { HOUR, MINUTE } from "./time";

const hour = cachePolicy(HOUR, 1);
const waiting: CacheState = {
  lastTouchAt: 0,
  contextTokens: 200_000,
  pings: 0,
  hasBackgroundWork: true,
};

test("a session waiting on background work is pinged just before its cache expires", () => {
  expect(shouldPing(waiting, hour, 54 * MINUTE)).toBe(false);
  expect(shouldPing(waiting, hour, 55 * MINUTE)).toBe(true);
  const five = cachePolicy(5 * MINUTE, 1);
  expect(shouldPing(waiting, five, 3 * MINUTE)).toBe(false);
  expect(shouldPing(waiting, five, 4 * MINUTE)).toBe(true);
});

test("no pings without background work, for a small context, or with keep-alive off", () => {
  expect(
    shouldPing({ ...waiting, hasBackgroundWork: false }, hour, 55 * MINUTE),
  ).toBe(false);
  expect(
    shouldPing({ ...waiting, contextTokens: 10_000 }, hour, 55 * MINUTE),
  ).toBe(false);
  expect(shouldPing(waiting, cachePolicy(0, 1), 55 * MINUTE)).toBe(false);
  expect(shouldPing(waiting, cachePolicy(HOUR, 0), 55 * MINUTE)).toBe(false);
});

test("pings stop once their reads would cost more than the budget's rewrites", () => {
  expect(maxPings(hour)).toBe(20);
  expect(maxPings(cachePolicy(5 * MINUTE, 1))).toBe(12);
  expect(maxPings(cachePolicy(HOUR, 2))).toBe(40);
  expect(keepsWarm({ ...waiting, pings: 19 }, hour)).toBe(true);
  expect(keepsWarm({ ...waiting, pings: 20 }, hour)).toBe(false);
});

test("a compaction or switch leaves nothing to keep warm until a request touches the cache again", () => {
  const cold = uncached({ ...waiting, pings: 7 }, 10 * MINUTE);
  expect(keepsWarm(cold, hour)).toBe(false);
  const warm = touched(cold, 20 * MINUTE, 50_000);
  expect(warm).toEqual({
    lastTouchAt: 20 * MINUTE,
    contextTokens: 50_000,
    pings: 0,
    hasBackgroundWork: true,
  });
  expect(shouldPing(warm, hour, 75 * MINUTE)).toBe(true);
});

test("the lifetime follows Claude Code's variables, setting and plan", () => {
  const base = { env: {}, settingTtl: undefined, isSubscriber: true };
  expect(cacheLifetime(base)).toBe("1h");
  expect(cacheLifetime({ ...base, isSubscriber: false })).toBe("5m");
  expect(cacheLifetime({ ...base, env: { DISABLE_PROMPT_CACHING: "1" } })).toBe(
    "off",
  );
  expect(
    cacheLifetime({ ...base, env: { FORCE_PROMPT_CACHING_5M: "true" } }),
  ).toBe("5m");
  expect(
    cacheLifetime({ ...base, env: { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" } }),
  ).toBe("5m");
  expect(cacheLifetime({ ...base, settingTtl: "5m" })).toBe("5m");
  expect(
    cacheLifetime({
      ...base,
      isSubscriber: false,
      env: { ENABLE_PROMPT_CACHING_1H: "1" },
    }),
  ).toBe("1h");
  expect(
    cacheLifetime({ ...base, env: { CLAUDE_CODE_USE_BEDROCK: "1" } }),
  ).toBe("5m");
  expect([lifetimeMs("1h"), lifetimeMs("5m"), lifetimeMs("off")]).toEqual([
    HOUR,
    5 * MINUTE,
    0,
  ]);
});
