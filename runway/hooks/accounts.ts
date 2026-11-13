import {
  exhaustedUntil,
  LAST_PERCENT,
  type ScopedLimit,
  type Usage,
  type Window,
} from "./limits";

// The usageStatus values of `cswap list --json` (cswap 0.29.0). Only an "ok"
// row carries a usage reading that decisions may rest on; any other value,
// including one a newer cswap adds, reads as "unknown".
export const CSWAP_STATUSES = [
  "ok",
  "token_expired",
  "api_key",
  "keychain_unavailable",
  "relogin_required",
  "foreign_credential",
  "no_credentials",
  "unavailable",
] as const;
export type CswapStatus = (typeof CSWAP_STATUSES)[number] | "unknown";

const statusOf = (s: unknown): CswapStatus =>
  CSWAP_STATUSES.find((k) => k === s) ?? "unknown";

export type Account = {
  number: number;
  email: string;
  organizationUuid?: string;
  isActive: boolean;
  isDisabled?: boolean;
  status: CswapStatus;
  five?: Window;
  seven?: Window;
  scoped: ScopedLimit[];
  // When cswap last read this account's usage.
  fetchedAt?: number;
};

// Every figure covers the accounts in rotation only. recovery is the account
// work waits for when none has room.
export type Pool = { viable: number; recovery?: Recovery };

export type Recovery = { account: number; at: number; isActive: boolean };

function toWindow(w: unknown): Window | undefined {
  if (!w || typeof w !== "object") return undefined;
  const { pct, resetsAt } = w as { pct?: unknown; resetsAt?: unknown };
  if (typeof pct !== "number") return undefined;
  const at =
    typeof resetsAt === "number"
      ? resetsAt * 1000
      : typeof resetsAt === "string"
        ? Date.parse(resetsAt)
        : NaN;
  return Number.isNaN(at) ? undefined : { used: pct, resetsAt: at };
}

function toScoped(w: unknown): ScopedLimit[] {
  const window = toWindow(w);
  const name = (w as { name?: unknown }).name;
  return window && typeof name === "string" ? [{ label: name, ...window }] : [];
}

function fetchedAt(at: unknown): { fetchedAt?: number } {
  const ms = typeof at === "string" ? Date.parse(at) : NaN;
  return Number.isNaN(ms) ? {} : { fetchedAt: ms };
}

export function parseCswapList(text: string): Account[] {
  try {
    const accounts = JSON.parse(text).accounts;
    if (!Array.isArray(accounts)) return [];
    return accounts.map((a) => ({
      number: a.number,
      email: a.email,
      ...(typeof a.organizationUuid === "string"
        ? { organizationUuid: a.organizationUuid }
        : {}),
      isActive: a.active === true,
      ...(a.disabled === true ? { isDisabled: true } : {}),
      status: statusOf(a.usageStatus),
      five: toWindow(a.usage?.fiveHour),
      seven: toWindow(a.usage?.sevenDay),
      scoped: Array.isArray(a.usage?.scoped)
        ? a.usage.scoped.flatMap(toScoped)
        : [],
      ...fetchedAt(a.usageFetchedAt),
    }));
  } catch {
    return [];
  }
}

// A window that has not reset yet.
export const current = <W extends Window>(w: W | undefined, now: number) =>
  w && w.resetsAt > now ? w : undefined;

// The higher use of an account's current all-models windows.
export const usedOf = (a: Account, now: number) =>
  Math.max(current(a.five, now)?.used ?? 0, current(a.seven, now)?.used ?? 0);

function headroom(w: Window | undefined, now: number, below: number): boolean {
  return current(w, now) === undefined || w!.used < below;
}

// The other accounts in rotation with room in both all-models windows: below
// `below` percent, by default short of the limit.
export function viableAccounts(
  accounts: readonly Account[],
  now: number,
  below = LAST_PERCENT,
): Account[] {
  return accounts.filter(
    (a) =>
      !a.isActive &&
      isInRotation(a) &&
      headroom(a.five, now, below) &&
      headroom(a.seven, now, below),
  );
}

// The session runs in Claude Code's default profile, whose login every switch
// moves. A session in any other CLAUDE_CONFIG_DIR (such as one started with
// `cswap run`) takes no part in switching.
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

// cswap follows CLAUDE_CONFIG_DIR (and CLAUDE_SECURESTORAGE_CONFIG_DIR for the
// credential), so a cswap run that reads or moves the default login must not
// inherit them. `env` exits 127 when cswap is not on PATH.
export const CSWAP_NOT_FOUND = 127;

export function defaultLoginCswap(argv: readonly string[]): string[] {
  return [
    "env",
    "-u",
    "CLAUDE_CONFIG_DIR",
    "-u",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "cswap",
    ...argv,
  ];
}

export function poolOf(
  accounts: readonly Account[],
  now: number,
): Pool | undefined {
  if (accounts.length < 2) return undefined;
  const viable = viableAccounts(accounts, now);
  const recovery =
    viable.length === 0 ? firstToRecover(accounts, now) : undefined;
  return { viable: viable.length, ...(recovery ? { recovery } : {}) };
}

// The account that can work again first when none has room; an account short
// of exhaustion can work at once. Of accounts that recover together, the least
// used has the most work left in it.
export function firstToRecover(
  accounts: readonly Account[],
  now: number,
): Recovery | undefined {
  const recoveries = accounts
    .filter(isInRotation)
    .map((a) => ({
      account: a.number,
      isActive: a.isActive,
      at: exhaustedUntil([a.five, a.seven], now) ?? now,
      used: usedOf(a, now),
    }))
    .sort(
      (x, y) =>
        x.at - y.at ||
        x.used - y.used ||
        Number(y.isActive) - Number(x.isActive),
    );
  const first = recoveries[0];
  return (
    first && { account: first.account, at: first.at, isActive: first.isActive }
  );
}

const AUTO_FLAGS_THAT_DO_NOT_SWITCH = ["--once", "--dry-run", "--help", "-h"];

// A `cswap auto` polling loop in `ps -A -o args=` output. A single tick
// (--once) ends at once, and a dry run never switches.
export function runsCswapAuto(processes: string): boolean {
  return processes.split("\n").some((line) => {
    const words = line.trim().split(/\s+/);
    const at = words.findIndex(
      (w) =>
        /(^|\/)(cswap|claude-swap)$/.test(w) ||
        w === "claude_swap" ||
        w === "claude_swap.cli",
    );
    if (at < 0) return false;
    const rest = words.slice(at + 1);
    return (
      rest.find((w) => !w.startsWith("-")) === "auto" &&
      !rest.some((w) => AUTO_FLAGS_THAT_DO_NOT_SWITCH.includes(w))
    );
  });
}

// The statuses that a login fixes. An expired token on the active account is
// one cswap renews itself.
const NEEDS_LOGIN: readonly CswapStatus[] = [
  "no_credentials",
  "token_expired",
  "relogin_required",
  "foreign_credential",
];

function needsLogin(a: Account): boolean {
  return (
    NEEDS_LOGIN.includes(a.status) &&
    !(a.isActive && a.status === "token_expired")
  );
}

// Only an account with a current reading can take work: an allow-list, so
// that a status cswap adds later never makes a switch target.
function isUsable(a: Account): boolean {
  return a.status === "ok";
}

// `cswap disable` holds an account out of rotation: runway never switches to
// it. The account the session is on still spends, so it stays in while active.
export function isInRotation(a: Account): boolean {
  return isUsable(a) && (a.isActive || a.isDisabled !== true);
}

// A disabled account is the user's choice, and a failed reading passes, so
// neither is a problem to report. Each problem is one line, since the status
// line shows them all on one.
export function setupProblems(accounts: readonly Account[]): string[] {
  const problems = accounts
    .filter((a) => !a.isDisabled && needsLogin(a))
    .map((a) =>
      a.status === "foreign_credential"
        ? `Claude Code is logged in to an account that cswap does not manage (slot ${a.number}). Run /add-account to add it.`
        : `cswap account ${a.number} (${a.email}) needs a new login (${a.status.replace(/_/g, " ")}): /login to it, and runway stores the login in cswap, or run \`cswap disable ${a.number}\` to leave it out.`,
    );
  const usable = accounts.filter((a) => a.isDisabled || !needsLogin(a)).length;
  if (usable < 2) {
    problems.push(
      `cswap has ${usable} usable account${usable === 1 ? "" : "s"}; switching needs two. To add one, /login to it (without /logout first), then run /add-account.`,
    );
  }
  return problems;
}

export function activeUsage(
  accounts: readonly Account[],
  now: number,
): Usage | undefined {
  const active = accounts.find((a) => a.isActive && isUsable(a));
  if (!active) return undefined;
  return {
    five: current(active.five, now),
    seven: current(active.seven, now),
    scoped: active.scoped.filter((l) => l.resetsAt > now),
  };
}

// The account Claude Code's default profile is logged in to, from the
// `oauthAccount` of `~/.claude.json`, the file cswap reads it from too. cswap
// keys an account by email and organization, so runway matches them the same
// way.
export type Login = { email: string; organizationUuid: string };

export function parseLogin(text: string): Login | undefined {
  try {
    const o = JSON.parse(text)?.oauthAccount;
    return typeof o?.emailAddress === "string" && o.emailAddress !== ""
      ? {
          email: o.emailAddress,
          organizationUuid:
            typeof o.organizationUuid === "string" ? o.organizationUuid : "",
        }
      : undefined;
  } catch {
    return undefined;
  }
}

// How the login relates to what cswap holds. `held`: cswap's active account
// is the login, with usable credentials. `stale`: the login is a cswap
// account whose stored credentials are out of date or not the active one, as
// after /login to an account that needs a new login; `cswap add` stores the
// new login over it. `new`: no cswap account is the login. A switch in either
// of the last two would replace a login that cswap has not stored.
export type LoginState =
  | { kind: "held" }
  | { kind: "stale"; account: number }
  | { kind: "new"; email: string };

export function loginState(
  accounts: readonly Account[],
  login: Login | undefined,
): LoginState {
  if (login === undefined) return { kind: "held" };
  const held = accounts.find(
    (a) =>
      a.email === login.email &&
      (a.organizationUuid ?? "") === login.organizationUuid,
  );
  if (held === undefined) return { kind: "new", email: login.email };
  return held.isActive && !needsLogin(held)
    ? { kind: "held" }
    : { kind: "stale", account: held.number };
}
