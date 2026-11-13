import { expect, test } from "claude-code/testing";
import { HOUR, MINUTE, workBurns, type Sample } from "./limits";

const NOW = Date.parse("2026-11-05T15:30:00Z");
const round = (n: number | undefined) =>
  n === undefined ? undefined : Math.round(n * 1000) / 1000;

test("the work's burn measured on the account it left stands after a switch, until it leaves the horizon", () => {
  const onOne: Sample[] = Array.from({ length: 10 }, (_, k) => ({
    at: NOW - 40 * MINUTE + k * 2 * MINUTE,
    seven: 70 + k,
    account: 1,
  }));
  const afterSwitch = [
    ...onOne,
    { at: NOW - 15 * MINUTE, seven: 0, account: 3 },
  ];
  expect(round(workBurns(afterSwitch, [], NOW, 45 * MINUTE).seven)).toBe(30);
  expect(
    workBurns(afterSwitch, [], NOW + HOUR, 45 * MINUTE).seven,
  ).toBeUndefined();
});

test("the highest account's burn is the work's, and one account's percent is never diffed against another's", () => {
  const samples: Sample[] = [
    { at: NOW - 30 * MINUTE, seven: 10, account: 1 },
    { at: NOW - 20 * MINUTE, seven: 90, account: 2 },
    { at: NOW - 10 * MINUTE, seven: 12, account: 1 },
    { at: NOW, seven: 92, account: 2 },
  ];
  expect(round(workBurns(samples, [], NOW, 45 * MINUTE).seven)).toBe(6);
});

test("samples recorded out of order give the burn of their reading times", () => {
  const samples: Sample[] = [
    { at: NOW, seven: 60 },
    { at: NOW - 30 * MINUTE, seven: 50 },
  ];
  expect(round(workBurns(samples, [], NOW, 45 * MINUTE).seven)).toBe(20);
});

test("a reading that has not moved bounds the burn by one percent over the span it held", () => {
  const samples: Sample[] = [
    { at: NOW - 40 * MINUTE, seven: 90 },
    { at: NOW - 20 * MINUTE, seven: 90 },
    { at: NOW, seven: 90 },
  ];
  expect(round(workBurns(samples, [], NOW, 45 * MINUTE).seven)).toBe(1.5);
  expect(
    workBurns(samples.slice(2), [], NOW, 45 * MINUTE).seven,
  ).toBeUndefined();
});
