import { expect, test } from "claude-code/testing";
import { MINUTE } from "./limits";
import { watchRemoteControl } from "./remote";

const NOW = Date.parse("2026-10-12T18:00:00Z");

test("Remote Control that was on before a switch is restored once it shows off", () => {
  const switched = watchRemoteControl({ account: 1, isOn: true }, 2, true, NOW);
  expect(switched.action).toBeUndefined();
  const dropped = watchRemoteControl(switched.watch, 2, false, NOW + MINUTE);
  expect(dropped.action).toBe("restore");
  expect(
    watchRemoteControl(dropped.watch, 2, true, NOW + 2 * MINUTE).action,
  ).toBeUndefined();
});

test("Remote Control is left alone when it was off before the switch or did not drop", () => {
  expect(
    watchRemoteControl({ account: 1, isOn: false }, 2, false, NOW).action,
  ).toBeUndefined();
  expect(
    watchRemoteControl({ account: 1, isOn: true }, 1, false, NOW).action,
  ).toBeUndefined();
  const waiting = watchRemoteControl({ account: 1, isOn: true }, 2, true, NOW);
  expect(
    watchRemoteControl(waiting.watch, 2, true, NOW + 11 * MINUTE).action,
  ).toBe("give-up");
});
