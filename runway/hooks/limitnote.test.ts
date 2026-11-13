import { expect, test } from "claude-code/testing";
import { HOUR, MINUTE } from "./limits";
import {
  compactBeforeLimitNote,
  longLimitWait,
  type LimitReading,
} from "./limitnote";

const NOW = Date.parse("2026-10-12T17:00:00Z");

test("a window near its limit is a long wait only when the reset or the first recovery outlasts the cache", () => {
  const near = { used: 96, resetsAt: NOW + 3 * HOUR };
  expect(longLimitWait([near], NOW)).toEqual({
    resetsAt: near.resetsAt,
    until: near.resetsAt,
    near: [near],
  });
  expect(longLimitWait([{ used: 96, resetsAt: NOW + 50 * MINUTE }], NOW)).toBe(
    undefined,
  );
  expect(longLimitWait([{ used: 80, resetsAt: NOW + 3 * HOUR }], NOW)).toBe(
    undefined,
  );
  expect(longLimitWait([near], NOW, NOW + 30 * MINUTE)).toBe(undefined);
  expect(
    longLimitWait(
      [near, undefined, { used: 99, resetsAt: NOW + 2 * HOUR }],
      NOW,
    )?.resetsAt,
  ).toBe(near.resetsAt);
});

const fable: LimitReading = {
  name: "Fable only",
  used: 100,
  resetsAt: NOW + 18 * HOUR,
  source: "cswap",
  readAt: NOW - 2 * MINUTE,
};
const weekly: LimitReading = {
  name: "weekly, all models",
  used: 95,
  resetsAt: NOW + 18 * HOUR,
  source: "headers",
  readAt: NOW - MINUTE,
  burnPerHour: 0.5,
};

test("the limit note gives each window's scope, account, use, reset, source, age and burn, and claims no stop", () => {
  const note = compactBeforeLimitNote(
    422_000,
    longLimitWait([weekly, fable], NOW)!,
    NOW,
    { account: { number: 3, email: "a@example.com" }, canSwitch: true },
    "mcp__tidy__compact",
  );
  expect(note).toContain("on account 3 (a@example.com)");
  expect(note).toContain(
    "- weekly, all models: 95% used, resets 11:00 UTC (in 18h); from the last response's rate-limit headers, 1m old; at the recent burn (0.5%/h) it reaches 100% at 03:00 UTC.",
  );
  expect(note).toContain(
    "- Fable only: 100% used, resets 11:00 UTC (in 18h); from cswap list, 2m old.",
  );
  expect(note).toContain("No other cswap account is below 95%");
  expect(note).toContain("not a forecast that this session stops");
  expect(note).toContain("422k tokens");
  expect(note).toContain("call mcp__tidy__compact at a stopping point");
  expect(note).not.toContain("will stop");
});

// Runway does not know the cache's lifetime (five minutes on some setups), so
// the note claims none: every wait it names outlasts the longest, an hour.
test("the limit note claims no cache lifetime, and comes only for a wait past the longest one", () => {
  const note = compactBeforeLimitNote(
    300_000,
    longLimitWait([weekly], NOW)!,
    NOW,
    { canSwitch: false },
    "mcp__tidy__compact",
  );
  expect(note).not.toContain("one-hour");
  expect(note).toContain("no prompt cache lasts more than an hour");
  expect(
    longLimitWait([{ ...weekly, resetsAt: NOW + HOUR }], NOW),
  ).toBeUndefined();
  expect(
    longLimitWait([{ ...weekly, resetsAt: NOW + HOUR + MINUTE }], NOW),
  ).toBeDefined();
});

test("the limit note says when a window lasts to its reset, and claims nothing about other accounts without switching", () => {
  const note = compactBeforeLimitNote(
    300_000,
    longLimitWait([{ ...weekly, burnPerHour: 0.1 }], NOW)!,
    NOW,
    { canSwitch: false },
    "mcp__tidy__compact",
  );
  expect(note).toContain("(0.1%/h) it lasts to its reset");
  expect(note).toContain("Runway is not switching accounts");
  expect(note).not.toContain("No other cswap account");
  expect(note).not.toContain("on account");
});
