export type Window = { used: number; resetsAt: number };
export type ScopedLimit = { label: string; used: number; resetsAt: number };
// scoped holds each model-scoped limit's used percent by label. `at` is when
// the reading was taken (the response's time for headers, cswap's fetch time),
// not when runway sampled it, so a reading that stays the same adds no point.
export type Sample = {
  at: number;
  five?: number;
  seven?: number;
  account?: number;
  scoped?: Record<string, number>;
};
export type Usage = { five?: Window; seven?: Window; scoped: ScopedLimit[] };

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
// The percent at which a window stops work.
export const LAST_PERCENT = 99;
// cswap reports whole percents, so a reading that has not moved bounds the
// burn by one percent over the span it has held.
const READING_STEP = 1;

function burnOf(
  samples: readonly Sample[],
  value: (s: Sample) => number | undefined,
  now: number,
  horizon: number,
): number | undefined {
  const recent = samples
    .filter((s) => value(s) !== undefined && now - s.at <= horizon)
    .sort((a, b) => a.at - b.at);
  if (recent.length < 2) return undefined;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const span = last.at - first.at;
  if (span < 5 * MINUTE) return undefined;
  const delta = value(last)! - value(first)!;
  if (delta < 0) return undefined;
  return ((delta === 0 ? READING_STEP : delta) / span) * HOUR;
}

export type Burns = {
  five?: number;
  seven?: number;
  scoped?: Record<string, number>;
};

// The work's burn: each account's burn from its own samples (one account's
// percent is never diffed against another's), the highest across accounts.
// The work moves with the login, so after a switch the burn measured on the
// account it left still stands for it until it leaves the horizon.
export function workBurns(
  samples: readonly Sample[],
  labels: readonly string[],
  now: number,
  horizon: number,
): Burns {
  const accounts = [...new Set(samples.map((x) => x.account))];
  const highest = (burn: (mine: Sample[]) => number | undefined) => {
    const burns = accounts
      .map((a) => burn(samples.filter((x) => x.account === a)))
      .filter((b): b is number => b !== undefined);
    return burns.length === 0 ? undefined : Math.max(...burns);
  };
  const scoped: Record<string, number> = {};
  for (const label of labels) {
    const burn = highest((mine) =>
      burnOf(mine, (x) => x.scoped?.[label], now, horizon),
    );
    if (burn !== undefined) scoped[label] = burn;
  }
  return {
    five: highest((mine) => burnOf(mine, (x) => x.five, now, horizon)),
    seven: highest((mine) => burnOf(mine, (x) => x.seven, now, horizon)),
    scoped,
  };
}

export function mins(n: number): string {
  const total = Math.max(0, Math.round(n));
  if (total < 60) return `${total}m`;
  const [days, hours, minutes] = [
    Math.floor(total / 1440),
    Math.floor((total % 1440) / 60),
    total % 60,
  ];
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
}

export const hhmm = (at: number) =>
  `${new Date(at).toISOString().slice(11, 16)} UTC`;

export function exhaustedUntil(
  windows: readonly (Window | undefined)[],
  now: number,
): number | undefined {
  const exhausted = windows.filter(
    (w): w is Window =>
      w !== undefined && w.used >= LAST_PERCENT && w.resetsAt > now,
  );
  return exhausted.length === 0
    ? undefined
    : Math.max(...exhausted.map((w) => w.resetsAt));
}

// When the last of a reading's exhausted windows, all-models or model-specific, resets.
export function usageExhaustedUntil(
  usage: Usage,
  now: number,
): number | undefined {
  return exhaustedUntil([usage.five, usage.seven, ...usage.scoped], now);
}
