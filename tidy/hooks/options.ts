import type { PluginOptions } from "claude-code";
import { MINUTE } from "./time";

export type Config = {
  nudgeTokens: number;
  // undefined detects the lifetime as Claude Code chooses it; 0 keeps nothing warm.
  cacheTtlOverride: number | undefined;
  keepaliveBudget: number;
};

type NumberRange = {
  fallback?: number;
  min: number;
  isInteger?: boolean;
};

const NUMBERS = {
  compactNudgeTokens: { fallback: 300_000, min: 0, isInteger: true },
  cacheTtlMinutes: { min: 0 },
  keepaliveBudget: { fallback: 1, min: 0 },
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
        `tidy: ${name} ${JSON.stringify(given)} must be a number at least ${range.min}; using ${range.fallback ?? "none"}`,
      );
    } else if (range.isInteger && !Number.isInteger(value)) {
      numbers[name] = Math.floor(value);
      problems.push(
        `tidy: ${name} ${JSON.stringify(given)} must be a whole number; using ${Math.floor(value)}`,
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
      nudgeTokens: n.compactNudgeTokens,
      cacheTtlOverride:
        n.cacheTtlMinutes === undefined
          ? undefined
          : n.cacheTtlMinutes * MINUTE,
      keepaliveBudget: n.keepaliveBudget,
    },
  };
}
