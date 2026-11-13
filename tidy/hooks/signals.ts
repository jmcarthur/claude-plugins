import type { SessionRateLimit } from "claude-code";

// What tidy reads of usage limits and account switches, which runway manages:
// tidy works without runway, so it reads Claude Code's own events and, when
// they exist, runway's switch files, and never writes either.

// The percent at which a window stops work.
const LAST_PERCENT = 99;

// Whether the rate-limit headers show a 5-hour or weekly window used up, as a
// main turn that ends in an error without a StopFailure is read.
export function isExhausted(
  rateLimits: readonly SessionRateLimit[],
  now: number,
): boolean {
  return rateLimits.some(
    (l) =>
      (l.kind === "five_hour" || l.kind === "seven_day") &&
      l.percentUsed >= LAST_PERCENT &&
      l.resetsAt !== undefined &&
      Date.parse(l.resetsAt) > now,
  );
}

// The time of the last switch any runway session on this machine made, relative
// to the home folder.
export const LAST_SWITCH_FILE = ".claude/runway/switch/last-switch.json";

export function switchedAtOf(text: string): number {
  try {
    const at = JSON.parse(text)?.switchedAt;
    return typeof at === "number" ? at : 0;
  } catch {
    return 0;
  }
}

// A switch moves the default login only, so a session in another profile (such
// as one started with `cswap run`) keeps its cache through it.
export function isDefaultProfile(
  configDir: string | undefined,
  home: string,
): boolean {
  if (configDir === undefined || configDir === "") return true;
  return (
    normalizedPath(configDir.replace(/^~(?=\/|$)/, home)) ===
    normalizedPath(`${home}/.claude`)
  );
}

function normalizedPath(path: string): string {
  const segments = path.split("/").filter((x) => x !== "" && x !== ".");
  return `${path.startsWith("/") ? "/" : ""}${segments.join("/")}`;
}
