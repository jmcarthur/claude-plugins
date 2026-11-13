import { expect, test } from "claude-code/testing";
import { readConfig } from "./options";
import { MINUTE } from "./time";

const MANIFEST_DEFAULTS = {
  compactNudgeTokens: 300000,
  keepaliveBudget: 1,
};

test("the manifest's defaults and unset options give the same config, with nothing to report", () => {
  const fromDefaults = readConfig(MANIFEST_DEFAULTS);
  const unset = readConfig({});
  expect(fromDefaults.problems).toEqual([]);
  expect(unset.problems).toEqual([]);
  expect(fromDefaults.config).toEqual(unset.config);
  expect(unset.config).toEqual({
    nudgeTokens: 300_000,
    cacheTtlOverride: undefined,
    keepaliveBudget: 1,
  });
});

test("valid values are used as given, and an empty number stands for its default", () => {
  const { config, problems } = readConfig({
    compactNudgeTokens: 0,
    keepaliveBudget: 2,
  });
  expect(problems).toEqual([]);
  expect(config.nudgeTokens).toBe(0);
  expect(config.keepaliveBudget).toBe(2);
});

test("a number out of range or not a number falls back to its default, a fraction of a whole number is rounded down, and each is reported", () => {
  const { config, problems } = readConfig({
    compactNudgeTokens: 1000.5,
    keepaliveBudget: -1,
  });
  expect(config).toMatchObject({
    nudgeTokens: 1000,
    keepaliveBudget: 1,
  });
  expect(problems).toEqual([
    "tidy: compactNudgeTokens 1000.5 must be a whole number; using 1000",
    "tidy: keepaliveBudget -1 must be a number at least 0; using 1",
  ]);
});

test("an empty cache lifetime is detected, 0 turns keep-alive off, and minutes become milliseconds", () => {
  expect(readConfig({ cacheTtlMinutes: "" }).config.cacheTtlOverride).toBe(
    undefined,
  );
  expect(readConfig({ cacheTtlMinutes: 0 }).config.cacheTtlOverride).toBe(0);
  expect(readConfig({ cacheTtlMinutes: 5 }).config.cacheTtlOverride).toBe(
    5 * MINUTE,
  );
  expect(readConfig({ cacheTtlMinutes: -1 }).problems).toEqual([
    "tidy: cacheTtlMinutes -1 must be a number at least 0; using none",
  ]);
});
