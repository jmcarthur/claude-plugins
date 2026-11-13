import { HOUR, MINUTE } from "./limits";

// Claude Code's auto-continue fires at the announced reset; runway waits this
// much longer, and resumes the session only if nothing resumed it first.
const REVIVAL_GRACE = 2 * MINUTE;
const FIRST_RETRY = 10 * MINUTE;

// Without a known reset, or for a limit that cswap reports cleared early, each
// failed resume makes the next wait twice as long, up to an hour.
export function retryDelay(retries: number): number {
  return Math.min(HOUR, FIRST_RETRY * 2 ** retries);
}

// What a fresh reading of the active account says: exhausted until a time,
// not exhausted (undefined until), or no reading at all (undefined).
export type Reading = { exhaustedUntil?: number } | undefined;

export type RevivalStep = { step: "wait" | "revive"; resetsAt?: number };

// The reading is taken only once the retry delay has passed, since it may run cswap.
export async function revivalStep(
  i: { at: number; resetsAt?: number },
  now: number,
  retries: number,
  read: () => Promise<Reading>,
): Promise<RevivalStep> {
  if (i.resetsAt !== undefined && now >= i.resetsAt + REVIVAL_GRACE)
    return { step: "revive" };
  if (now - i.at < retryDelay(retries)) return { step: "wait" };
  const reading = await read();
  if (reading?.exhaustedUntil !== undefined)
    return { step: "wait", resetsAt: reading.exhaustedUntil };
  if (reading) return { step: "revive" };
  return { step: i.resetsAt === undefined ? "revive" : "wait" };
}
