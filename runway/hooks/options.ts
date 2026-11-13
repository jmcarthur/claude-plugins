import type { PluginOptions } from "claude-code";
import { MINUTE } from "./limits";

export type Config = {
  // The smallest context for the note to compact before a limit; 0 gives none.
  compactBeforeLimitTokens: number;
  switching: boolean;
  switchMaxWait: number;
  remoteControlRestore: boolean;
  notifications: boolean;
};

type NumberRange = {
  fallback?: number;
  min: number;
  isInteger?: boolean;
};

const NUMBERS = {
  compactBeforeLimitTokens: { fallback: 300_000, min: 0, isInteger: true },
  switchMaxWaitMinutes: { fallback: 30, min: 0 },
} satisfies Record<string, NumberRange>;

type NumberOption = keyof typeof NUMBERS;
type Numbers = {
  [K in NumberOption]: (typeof NUMBERS)[K] extends { fallback: number }
    ? number
    : number | undefined;
};

function readNumbers(options: PluginOptions): {
  numbers: Numbers;
  problems: string[];
} {
  const numbers: Record<string, number | undefined> = {};
  const problems: string[] = [];
  for (const [name, range] of Object.entries(NUMBERS) as [
    NumberOption,
    NumberRange,
  ][]) {
    const given = options[name];
    const value =
      given === undefined || given === "" ? range.fallback : Number(given);
    if (value === undefined) {
      numbers[name] = undefined;
    } else if (!Number.isFinite(value) || value < range.min) {
      numbers[name] = range.fallback;
      problems.push(
        `runway: ${name} ${JSON.stringify(given)} must be a number at least ${range.min}; using ${range.fallback ?? "none"}`,
      );
    } else if (range.isInteger && !Number.isInteger(value)) {
      numbers[name] = Math.floor(value);
      problems.push(
        `runway: ${name} ${JSON.stringify(given)} must be a whole number; using ${Math.floor(value)}`,
      );
    } else {
      numbers[name] = value;
    }
  }
  return { numbers: numbers as Numbers, problems };
}

export function readConfig(options: PluginOptions): {
  config: Config;
  problems: string[];
} {
  const { numbers: n, problems } = readNumbers(options);
  return {
    problems,
    config: {
      compactBeforeLimitTokens: n.compactBeforeLimitTokens,
      switching: options.switching !== false,
      switchMaxWait: n.switchMaxWaitMinutes * MINUTE,
      remoteControlRestore: options.remoteControlRestore !== false,
      notifications: options.notifications !== false,
    },
  };
}
