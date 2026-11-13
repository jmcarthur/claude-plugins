import { current, usedOf, viableAccounts, type Account } from "./accounts";
import { HOUR, LAST_PERCENT, MINUTE, type Burns, type Window } from "./limits";

export type { Burns };

export type SessionRecord = {
  sessionId: string;
  project: string;
  updatedAt: number;
  // When the session last requested each model id, main loop and subagents.
  models?: Record<string, number>;
};

// An account that a switch near a limit left: no optional switch moves back
// to it until the window it was near resets.
export type Left = { account: number; until: number };

export type SwitchPlan = {
  id: string;
  from: number;
  to: number;
  reason: string;
  createdAt: number;
  switchedAt?: number;
  cancelledAt?: number;
  // Carried from plan to plan, since plan.json holds only the last one.
  left?: Left[];
  // When the plans of the last hour switched.
  recentSwitches?: number[];
};

// `leaves` is when the window that made the switch necessary resets; absent
// for an optional switch.
export type Proposal = Pick<SwitchPlan, "from" | "to" | "reason"> & {
  leaves?: number;
};

export type SwitchInputs = {
  now: number;
  accounts: readonly Account[];
  // The work's burn (workBurns), the same for every account judged.
  burnPerHour: Burns;
  // The labels of the model-specific windows that live sessions use.
  inUse: ReadonlySet<string>;
  maxWait: number;
  // The last switch, for the spacing of optional switches.
  lastSwitchAt?: number;
  left?: readonly Left[];
};

const SESSION_GONE_AFTER = 5 * MINUTE;
const SWITCH_MARGIN = 5 * MINUTE;
const LONGEST_WAIT = 30 * MINUTE;
// An optional switch empties every session's prompt cache, so it waits for the
// cache's life after any switch.
const OPTIONAL_SWITCH_SPACING = HOUR;

// A model is in use for an hour after its last request: past the prompt
// cache's life a session pays a full read anyway.
export const USE_HORIZON = HOUR;

// A model id is in a model-specific window when the window's label appears in
// it: claude-fable-5-1 in "Fable".
export function isInScope(model: string, label: string): boolean {
  return model.toLowerCase().includes(label.toLowerCase());
}

// The labels, among those the accounts name, of the windows that some live
// session requested a model in within USE_HORIZON.
export function scopesInUse(
  live: readonly SessionRecord[],
  accounts: readonly Account[],
  now: number,
): Set<string> {
  const labels = new Set(accounts.flatMap((a) => a.scoped.map((l) => l.label)));
  const models = live.flatMap((r) =>
    Object.entries(r.models ?? {})
      .filter(([, at]) => now - at <= USE_HORIZON)
      .map(([model]) => model),
  );
  return new Set(
    [...labels].filter((l) => models.some((m) => isInScope(m, l))),
  );
}

// The label of the model-specific window a model falls in on this account.
export function scopeOf(model: string, account: Account | undefined) {
  return account?.scoped.find((l) => isInScope(model, l.label))?.label;
}

export function parseRecord(text: string): SessionRecord | undefined {
  try {
    const r = JSON.parse(text);
    return typeof r?.sessionId === "string" && typeof r.updatedAt === "number"
      ? (r as SessionRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

export function parsePlan(text: string): SwitchPlan | undefined {
  try {
    const p = JSON.parse(text);
    return typeof p?.id === "string" &&
      typeof p.from === "number" &&
      typeof p.to === "number"
      ? (p as SwitchPlan)
      : undefined;
  } catch {
    return undefined;
  }
}

export function isGone(r: SessionRecord, now: number): boolean {
  return now - r.updatedAt > SESSION_GONE_AFTER;
}

export function coordinatorOf(
  live: readonly SessionRecord[],
): string | undefined {
  return live.map((r) => r.sessionId).sort()[0];
}

// A window is near its limit when its burn takes it to LAST_PERCENT within the
// longest wait plus the margin, so that the switch still fits before it. A
// window without a burn yet is near it only at LAST_PERCENT: a guessed percent
// would switch early on the weekly window and late on the 5-hour one.
export function isNearLimit(
  used: number,
  burnPerHour: number | undefined,
  maxWait: number,
): boolean {
  if (used >= LAST_PERCENT) return true;
  if (!burnPerHour) return false;
  return (
    ((LAST_PERCENT - used) / burnPerHour) * HOUR <= maxWait + SWITCH_MARGIN
  );
}

// The all-models windows of an account that are near their limit at the
// work's burn. This is the one judgment of whether an account lasts: near-limit
// asks it of the active account and every target filter of a candidate, with
// the same burn, so that no switch can be undone by another rule.
function nearWindows(
  a: Account,
  now: number,
  burns: Burns,
  maxWait: number,
): Window[] {
  return (["five", "seven"] as const).flatMap((key) => {
    const w = current(a[key], now);
    return w && isNearLimit(w.used, burns[key], maxWait) ? [w] : [];
  });
}

// A viable account that would not be near a limit at once at the work's
// burn, so that the switch does not trigger another.
function targets(
  accounts: readonly Account[],
  now: number,
  burns: Burns,
  maxWait: number,
): Account[] {
  return viableAccounts(accounts, now).filter(
    (a) => nearWindows(a, now, burns, maxWait).length === 0,
  );
}

const scopedWindow = (a: Account, label: string, now: number) =>
  current(
    a.scoped.find((l) => l.label === label),
    now,
  );

function hasScopeRoom(
  a: Account,
  label: string,
  now: number,
  burns: Burns,
  maxWait: number,
): boolean {
  const w = scopedWindow(a, label, now);
  return !w || !isNearLimit(w.used, burns.scoped?.[label], maxWait);
}

type Ranking = {
  now: number;
  burns: Burns;
  maxWait: number;
  inUse: ReadonlySet<string>;
};

// Whether an account has room in every model-specific window in use.
function fits(a: Account, r: Ranking): boolean {
  return [...r.inUse].every((l) =>
    hasScopeRoom(a, l, r.now, r.burns, r.maxWait),
  );
}

// Targets ranked: room in every scope in use first; then the soonest reset,
// because each account's unused allowance is lost at its own reset (an
// unknown or past one last); then, among equal resets, the least flexible
// room (the least room in scopes not in use), so that room other work can use
// is kept; then the most room; then the account number.
function rank(
  accounts: readonly Account[],
  r: Ranking,
  resetOf: (a: Account) => number | undefined,
  used: (a: Account) => number,
): Account[] {
  const reset = (a: Account) => resetOf(a) ?? Infinity;
  const flexible = (a: Account) =>
    a.scoped
      .filter((l) => !r.inUse.has(l.label) && current(l, r.now))
      .reduce((sum, l) => sum + Math.max(0, 100 - l.used), 0);
  return [...accounts].sort(
    (a, b) =>
      Number(fits(b, r)) - Number(fits(a, r)) ||
      reset(a) - reset(b) ||
      flexible(a) - flexible(b) ||
      used(a) - used(b) ||
      a.number - b.number,
  );
}

const weeklyReset = (now: number) => (a: Account) =>
  current(a.seven, now)?.resetsAt;

// The target a switch near or at an all-models limit moves to.
export function switchTarget(
  accounts: readonly Account[],
  now: number,
  burns: Burns,
  maxWait: number,
  inUse: ReadonlySet<string>,
): number | undefined {
  return rank(
    targets(accounts, now, burns, maxWait),
    { now, burns, maxWait, inUse },
    weeklyReset(now),
    (a) => usedOf(a, now),
  )[0]?.number;
}

// The target a switch at a limit of the main turn moves to: one that lasts at
// the work's burn if any, else any account short of its limit.
export function limitTarget(
  accounts: readonly Account[],
  now: number,
  burns: Burns,
  inUse: ReadonlySet<string>,
): number | undefined {
  return (
    switchTarget(accounts, now, burns, LONGEST_WAIT, inUse) ??
    switchTarget(accounts, now, {}, LONGEST_WAIT, inUse)
  );
}

// The account to move to while no window is near its limit: the ranked
// target, when its weekly window resets sooner than the active one's. An
// unknown reset of the active account is no reason to move.
export function soonestResetTarget(
  accounts: readonly Account[],
  now: number,
  burns: Burns,
  maxWait: number,
  inUse: ReadonlySet<string>,
): number | undefined {
  const active = accounts.find((a) => a.isActive);
  if (!active) return undefined;
  const r = { now, burns, maxWait, inUse };
  const resetOf = weeklyReset(now);
  const activeReset = resetOf(active);
  if (activeReset === undefined) return undefined;
  const best = rank(targets(accounts, now, burns, maxWait), r, resetOf, (a) =>
    usedOf(a, now),
  )[0];
  return best && fits(best, r) && (resetOf(best) ?? Infinity) < activeReset
    ? best.number
    : undefined;
}

// The target a switch for a model-specific window moves to, which must also
// have room in that window; the window's own reset ranks it, else the weekly one.
export function scopedTarget(
  label: string,
  accounts: readonly Account[],
  now: number,
  burns: Burns,
  maxWait: number,
  inUse: ReadonlySet<string>,
): number | undefined {
  const lasts = targets(accounts, now, burns, maxWait).filter((a) =>
    hasScopeRoom(a, label, now, burns, maxWait),
  );
  return rank(
    lasts,
    { now, burns, maxWait, inUse },
    (a) => scopedWindow(a, label, now)?.resetsAt ?? weeklyReset(now)(a),
    (a) => scopedWindow(a, label, now)?.used ?? 0,
  )[0]?.number;
}

export function proposeSwitch(i: SwitchInputs): Proposal | undefined {
  const active = i.accounts.find((a) => a.isActive);
  if (!active) return undefined;
  const { maxWait, inUse } = i;
  for (const l of active.scoped) {
    if (!inUse.has(l.label)) continue;
    if (hasScopeRoom(active, l.label, i.now, i.burnPerHour, maxWait)) continue;
    const to = scopedTarget(
      l.label,
      i.accounts,
      i.now,
      i.burnPerHour,
      maxWait,
      inUse,
    );
    if (to !== undefined)
      return {
        from: active.number,
        to,
        reason: `scoped:${l.label}`,
        leaves: l.resetsAt,
      };
  }
  const near = nearWindows(active, i.now, i.burnPerHour, maxWait);
  if (near.length === 0) {
    if (
      i.lastSwitchAt !== undefined &&
      i.now - i.lastSwitchAt < OPTIONAL_SWITCH_SPACING
    )
      return undefined;
    const isLeft = (a: Account) =>
      (i.left ?? []).some((l) => l.account === a.number && l.until > i.now);
    const to = soonestResetTarget(
      i.accounts.filter((a) => a.isActive || !isLeft(a)),
      i.now,
      i.burnPerHour,
      maxWait,
      inUse,
    );
    return to === undefined
      ? undefined
      : { from: active.number, to, reason: "soonest-reset" };
  }
  const to = switchTarget(i.accounts, i.now, i.burnPerHour, maxWait, inUse);
  return to === undefined
    ? undefined
    : {
        from: active.number,
        to,
        reason: "near-limit",
        leaves: Math.max(...near.map((w) => w.resetsAt)),
      };
}

// The plan that records a switch made now, carried on from the last plan,
// since plan.json holds only one: the accounts that switches near or at a
// limit left, until their windows reset (`from` until `leaves`, if given),
// and the switches of the last hour, which the warning about repeated
// switches counts.
export function switchRecord(
  last: SwitchPlan | undefined,
  { leaves, ...switched }: Proposal,
  now: number,
): SwitchPlan {
  return {
    id: `${now}-${switched.from}-${switched.to}`,
    ...switched,
    createdAt: now,
    left: [
      ...(last?.left ?? []).filter((l) => l.until > now),
      ...(leaves === undefined
        ? []
        : [{ account: switched.from, until: leaves }]),
    ],
    recentSwitches: [
      ...(last?.recentSwitches ?? []),
      ...(last?.switchedAt === undefined ? [] : [last.switchedAt]),
    ].filter((at, k, all) => now - at < HOUR && all.indexOf(at) === k),
  };
}

export function isPending(
  plan: SwitchPlan | undefined,
  activeAccount: number | undefined,
): plan is SwitchPlan {
  return (
    plan !== undefined &&
    plan.switchedAt === undefined &&
    plan.cancelledAt === undefined &&
    plan.from === activeAccount
  );
}
