import { expect, test } from "claude-code/testing";
import { MINUTE } from "./limits";
import { readConfig } from "./options";

const MANIFEST_DEFAULTS = {
  compactBeforeLimitTokens: 300000,
  switching: true,
  switchMaxWaitMinutes: 30,
  remoteControlRestore: true,
  notifications: true,
};

test("the manifest's defaults and unset options give the same config, with nothing to report", () => {
  const fromDefaults = readConfig(MANIFEST_DEFAULTS);
  const unset = readConfig({});
  expect(fromDefaults.problems).toEqual([]);
  expect(unset.problems).toEqual([]);
  expect(fromDefaults.config).toEqual(unset.config);
  expect(unset.config).toEqual({
    compactBeforeLimitTokens: 300_000,
    switching: true,
    switchMaxWait: 30 * MINUTE,
    remoteControlRestore: true,
    notifications: true,
  });
});

test("valid values are used as given, and an empty number stands for its default", () => {
  const { config, problems } = readConfig({
    compactBeforeLimitTokens: 0,
    switchMaxWaitMinutes: 5,
    switching: false,
  });
  expect(problems).toEqual([]);
  expect(config.compactBeforeLimitTokens).toBe(0);
  expect(config.switchMaxWait).toBe(5 * MINUTE);
  expect(config.switching).toBe(false);
});

test("a number out of range or not a number falls back to its default, a fraction of a whole number is rounded down, and each is reported", () => {
  const { config, problems } = readConfig({
    compactBeforeLimitTokens: 1000.5,
    switchMaxWaitMinutes: "soon",
  });
  expect(config).toMatchObject({
    compactBeforeLimitTokens: 1000,
    switchMaxWait: 30 * MINUTE,
  });
  expect(problems).toEqual([
    "runway: compactBeforeLimitTokens 1000.5 must be a whole number; using 1000",
    'runway: switchMaxWaitMinutes "soon" must be a number at least 0; using 30',
  ]);
});
