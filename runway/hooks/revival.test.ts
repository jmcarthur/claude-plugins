import { expect, test } from "claude-code/testing";
import { HOUR, MINUTE } from "./limits";
import { retryDelay, revivalStep } from "./revival";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const none = async () => undefined;

test("the retry delay doubles from ten minutes up to an hour", () => {
  expect([0, 1, 2, 3, 9].map(retryDelay)).toEqual([
    10 * MINUTE,
    20 * MINUTE,
    40 * MINUTE,
    HOUR,
    HOUR,
  ]);
});

test("a known reset is resumed two minutes after it, and not before even past the retry delay", async () => {
  const i = { at: NOW, resetsAt: NOW + HOUR };
  expect((await revivalStep(i, NOW + HOUR + MINUTE, 0, none)).step).toBe(
    "wait",
  );
  expect((await revivalStep(i, NOW + HOUR + 2 * MINUTE, 0, none)).step).toBe(
    "revive",
  );
});

test("an unknown reset is retried after the delay", async () => {
  expect((await revivalStep({ at: NOW }, NOW + 9 * MINUTE, 0, none)).step).toBe(
    "wait",
  );
  expect(
    (await revivalStep({ at: NOW }, NOW + 10 * MINUTE, 0, none)).step,
  ).toBe("revive");
  expect(
    (await revivalStep({ at: NOW }, NOW + 10 * MINUTE, 1, none)).step,
  ).toBe("wait");
});

test("a fresh reading clears a limit early, or names its reset", async () => {
  const i = { at: NOW, resetsAt: NOW + 3 * HOUR };
  expect(await revivalStep(i, NOW + 10 * MINUTE, 0, async () => ({}))).toEqual({
    step: "revive",
  });
  expect(
    await revivalStep({ at: NOW }, NOW + 10 * MINUTE, 0, async () => ({
      exhaustedUntil: NOW + HOUR,
    })),
  ).toEqual({ step: "wait", resetsAt: NOW + HOUR });
  let isRead = false;
  await revivalStep(i, NOW + 5 * MINUTE, 0, async () => ((isRead = true), {}));
  expect(isRead).toBe(false);
});
