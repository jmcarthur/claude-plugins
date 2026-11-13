import { expect, test } from "claude-code/testing";
import type { Account } from "./accounts";
import { HOUR, MINUTE } from "./limits";
import {
  coordinatorOf,
  isGone,
  isInScope,
  limitTarget,
  scopesInUse,
  soonestResetTarget,
  isNearLimit,
  isPending,
  parsePlan,
  parseRecord,
  proposeSwitch,
  scopedTarget,
  switchRecord,
  switchTarget,
  type SessionRecord,
  type SwitchInputs,
  type SwitchPlan,
} from "./switching";

const NOW = Date.parse("2026-10-12T17:00:00Z");
const window = (used: number, hours = 3) => ({
  used,
  resetsAt: NOW + hours * HOUR,
});
const account = (
  number: number,
  five: number,
  seven: number,
  isActive = false,
): Account => ({
  number,
  email: `${number}@x`,
  isActive,
  status: "ok",
  five: window(five),
  seven: window(seven, 80),
  scoped: [],
});
const record = (over: Partial<SessionRecord>): SessionRecord => ({
  sessionId: "a",
  project: "/p",
  updatedAt: NOW,
  ...over,
});
const FABLE = new Set(["Fable"]);
const NONE = new Set<string>();
// The longest switch wait, as switchMaxWaitMinutes gives it by default.
const WAIT = 30 * MINUTE;
const propose = (
  i: Omit<SwitchInputs, "maxWait" | "inUse"> &
    Partial<Pick<SwitchInputs, "maxWait" | "inUse">>,
) => proposeSwitch({ maxWait: WAIT, inUse: NONE, ...i });
const weeklyIn = (
  a: Account,
  hours: number,
  used = a.seven!.used,
): Account => ({
  ...a,
  seven: window(used, hours),
});
const plan: SwitchPlan = {
  id: "p1",
  from: 1,
  to: 2,
  reason: "near-limit",
  createdAt: NOW,
};

test("without a burn rate a window is near its limit only at 99%", () => {
  expect(isNearLimit(98, undefined, WAIT)).toBe(false);
  expect(isNearLimit(99, undefined, WAIT)).toBe(true);
});

test("among viable accounts whose weekly windows reset together, a switch near a limit goes to the one with the most room", () => {
  const accounts = [
    account(1, 92, 50, true),
    account(2, 40, 60),
    account(3, 20, 30),
    account(4, 10, 95),
  ];
  expect(switchTarget(accounts, NOW, {}, WAIT, NONE)).toBe(3);
  const proposal = propose({
    now: NOW,
    accounts,
    burnPerHour: { five: 30 },
  });
  expect(proposal).toEqual({
    from: 1,
    to: 3,
    reason: "near-limit",
    leaves: NOW + 3 * HOUR,
  });
});

test("no switch is planned short of a limit or without a viable account", () => {
  expect(
    propose({
      now: NOW,
      accounts: [account(1, 80, 50, true), account(2, 10, 10)],
      burnPerHour: {},
    }),
  ).toBe(undefined);
  expect(
    propose({
      now: NOW,
      accounts: [account(1, 99, 50, true), account(2, 99, 10)],
      burnPerHour: {},
    }),
  ).toBe(undefined);
});

test("a model-scoped limit plans a switch to its scoped target", () => {
  const active = {
    ...account(1, 10, 10, true),
    scoped: [{ label: "Fable", used: 93, resetsAt: NOW + 50 * HOUR }],
  };
  const proposal = propose({
    now: NOW,
    accounts: [active, account(2, 10, 10)],
    burnPerHour: { scoped: { Fable: 30 } },
    inUse: FABLE,
  });
  expect(proposal).toEqual({
    from: 1,
    to: 2,
    reason: "scoped:Fable",
    leaves: NOW + 50 * HOUR,
  });
});

test("a full model-specific window that no session uses plans no switch", () => {
  const active = {
    ...account(1, 10, 10, true),
    scoped: [{ label: "Fable", used: 100, resetsAt: NOW + 50 * HOUR }],
  };
  expect(
    propose({
      now: NOW,
      accounts: [active, account(2, 10, 10)],
      burnPerHour: {},
    }),
  ).toBeUndefined();
});

const fable = (a: Account, used: number): Account => ({
  ...a,
  scoped: [{ label: "Fable", used, resetsAt: NOW + 50 * HOUR }],
});

test("a window is near its limit when its burn reaches 99% within the longest wait and the margin", () => {
  expect(isNearLimit(95, 2, WAIT)).toBe(false);
  expect(isNearLimit(85, 24, WAIT)).toBe(true);
  expect(isNearLimit(85, 23, WAIT)).toBe(false);
  expect(isNearLimit(85, 23, 60 * MINUTE)).toBe(true);
  expect(isNearLimit(99, 0.1, WAIT)).toBe(true);
  expect(isNearLimit(98, undefined, WAIT)).toBe(false);
  expect(isNearLimit(98, 0, WAIT)).toBe(false);
});

// Account 1's weekly reading stands at 90% through an idle stretch: a fixed
// threshold for a zero burn would switch it away.
test("a weekly reading that stands still at 90% plans no switch", () => {
  const accounts = [
    weeklyIn(account(1, 10, 90, true), 75),
    weeklyIn(account(2, 0, 0), 81),
    weeklyIn(account(3, 0, 2), 79),
  ];
  expect(
    propose({ now: NOW, accounts, burnPerHour: { seven: 1.5 } }),
  ).toBeUndefined();
  expect(propose({ now: NOW, accounts, burnPerHour: {} })).toBeUndefined();
});

test("a weekly window at 95% with a slow burn plans no switch", () => {
  const accounts = [account(1, 20, 95, true), account(2, 10, 10)];
  expect(
    propose({
      now: NOW,
      accounts,
      burnPerHour: { seven: 1 },
    }),
  ).toBeUndefined();
});

test("a five-hour window at 85% with a fast burn plans a switch before 99%", () => {
  const accounts = [account(1, 85, 30, true), account(2, 10, 10)];
  expect(
    propose({
      now: NOW,
      accounts,
      burnPerHour: { five: 30 },
    }),
  ).toEqual({
    from: 1,
    to: 2,
    reason: "near-limit",
    leaves: NOW + 3 * HOUR,
  });
});

test("without a burn rate only 99% starts the plan, and a zero burn never does", () => {
  const at = (five: number) => [account(1, five, 30, true), account(2, 10, 10)];
  expect(
    propose({
      now: NOW,
      accounts: at(98),
      burnPerHour: {},
    }),
  ).toBeUndefined();
  expect(
    propose({
      now: NOW,
      accounts: at(99),
      burnPerHour: {},
    })?.reason,
  ).toBe("near-limit");
  expect(
    propose({
      now: NOW,
      accounts: at(98),
      burnPerHour: { five: 0 },
    }),
  ).toBeUndefined();
});

test("a target that the active burn would take near its limit at once is passed over", () => {
  const accounts = [
    account(1, 90, 30, true),
    account(2, 82, 10),
    account(3, 60, 70),
  ];
  const burn = { five: 30 };
  expect(switchTarget(accounts, NOW, burn, WAIT, NONE)).toBe(3);
  expect(propose({ now: NOW, accounts, burnPerHour: burn })?.to).toBe(3);
  expect(
    propose({
      now: NOW,
      accounts: accounts.slice(0, 2),
      burnPerHour: burn,
    }),
  ).toBeUndefined();
  // After the switch, the target is not near its limit at the same burn.
  const to = account(3, 60, 70, true);
  expect(
    propose({
      now: NOW,
      accounts: [account(1, 90, 30), to],
      burnPerHour: burn,
    }),
  ).toBeUndefined();
});

const resetsIn = (a: Account, hours: number | undefined): Account => ({
  ...a,
  seven: hours === undefined ? undefined : window(a.seven!.used, hours),
});

test("a target whose weekly window resets sooner beats one with more room, and an unknown reset goes last", () => {
  const burn = { five: 30 };
  const accounts = [
    account(1, 90, 30, true),
    resetsIn(account(2, 60, 50), 10),
    account(3, 10, 10),
    resetsIn(account(4, 0, 0), undefined),
  ];
  expect(switchTarget(accounts, NOW, burn, WAIT, NONE)).toBe(2);
  expect(propose({ now: NOW, accounts, burnPerHour: burn })?.to).toBe(2);
  // The time filter comes first: at 85% the sooner reset would be near its limit at once.
  expect(
    switchTarget(
      [accounts[0], resetsIn(account(2, 85, 50), 10), account(3, 10, 10)],
      NOW,
      burn,
      WAIT,
      NONE,
    ),
  ).toBe(3);
  expect(
    switchTarget(
      [
        accounts[0],
        resetsIn(account(2, 10, 0), 90),
        resetsIn(account(4, 0, 0), undefined),
      ],
      NOW,
      burn,
      WAIT,
      NONE,
    ),
  ).toBe(2);
  expect(
    switchTarget(
      [
        accounts[0],
        resetsIn(account(2, 10, 10), 10),
        resetsIn(account(3, 5, 5), 10),
      ],
      NOW,
      burn,
      WAIT,
      NONE,
    ),
  ).toBe(3);
});

test("a scoped target ranks by the reset of its model limit, else by its weekly one", () => {
  const limit = (a: Account, used: number, hours?: number): Account => ({
    ...a,
    scoped:
      hours === undefined
        ? []
        : [{ label: "Fable", used, resetsAt: NOW + hours * HOUR }],
  });
  const active = fable(account(1, 10, 10, true), 95);
  expect(
    scopedTarget(
      "Fable",
      [
        active,
        limit(account(2, 10, 10), 50, 20),
        limit(account(3, 10, 10), 0, 60),
      ],
      NOW,
      {},
      WAIT,
      FABLE,
    ),
  ).toBe(2);
  expect(
    scopedTarget(
      "Fable",
      [
        active,
        limit(account(2, 10, 10), 50, 100),
        resetsIn(limit(account(3, 10, 10), 0), 20),
      ],
      NOW,
      {},
      WAIT,
      FABLE,
    ),
  ).toBe(3);
  expect(
    scopedTarget(
      "Fable",
      [
        active,
        limit(account(2, 10, 10), 82, 20),
        limit(account(3, 10, 10), 0, 60),
      ],
      NOW,
      { scoped: { Fable: 30 } },
      WAIT,
      FABLE,
    ),
  ).toBe(3);
});

test("a model-scoped limit plans a switch on its own burn, and without one only at 99%", () => {
  const accounts = [
    fable(account(1, 10, 10, true), 85),
    fable(account(2, 10, 10), 20),
  ];
  expect(
    propose({
      now: NOW,
      inUse: FABLE,
      accounts,
      burnPerHour: {},
    }),
  ).toBeUndefined();
  expect(
    propose({
      now: NOW,
      inUse: FABLE,
      accounts,
      burnPerHour: { scoped: { Fable: 1 } },
    }),
  ).toBeUndefined();
  expect(
    propose({
      now: NOW,
      inUse: FABLE,
      accounts,
      burnPerHour: { scoped: { Fable: 30 } },
    }),
  ).toEqual({
    from: 1,
    to: 2,
    reason: "scoped:Fable",
    leaves: NOW + 50 * HOUR,
  });
  const slowAt98 = [
    fable(account(1, 10, 10, true), 98),
    fable(account(2, 10, 10), 20),
  ];
  expect(
    propose({
      now: NOW,
      inUse: FABLE,
      accounts: slowAt98,
      burnPerHour: { scoped: { Fable: 1 } },
    }),
  ).toBeUndefined();
  expect(
    propose({
      now: NOW,
      inUse: FABLE,
      accounts: slowAt98,
      burnPerHour: {},
    }),
  ).toBeUndefined();
  expect(
    propose({
      now: NOW,
      inUse: FABLE,
      accounts: [fable(account(1, 10, 10, true), 99), slowAt98[1]],
      burnPerHour: {},
    })?.reason,
  ).toBe("scoped:Fable");
});

test("a scoped target must last at the active burn in that limit and in its windows", () => {
  const burn = { five: 30, scoped: { Fable: 30 } };
  const active = fable(account(1, 10, 10, true), 90);
  expect(
    scopedTarget(
      "Fable",
      [active, fable(account(2, 10, 10), 82), fable(account(3, 10, 10), 60)],
      NOW,
      burn,
      WAIT,
      FABLE,
    ),
  ).toBe(3);
  expect(
    scopedTarget(
      "Fable",
      [active, fable(account(2, 10, 10), 82), fable(account(3, 85, 10), 0)],
      NOW,
      burn,
      WAIT,
      FABLE,
    ),
  ).toBeUndefined();
  expect(
    propose({
      now: NOW,
      accounts: [active, fable(account(2, 10, 10), 82)],
      burnPerHour: burn,
    }),
  ).toBeUndefined();
  // After the switch, the target is not near its scoped limit at the same burn.
  expect(
    propose({
      now: NOW,
      accounts: [
        fable(account(1, 10, 10), 90),
        fable(account(3, 10, 10, true), 60),
      ],
      burnPerHour: burn,
    }),
  ).toBeUndefined();
});

test("a plan is pending until it switches or another switch moves the active account", () => {
  expect(isPending(plan, 1)).toBe(true);
  expect(isPending(plan, 3)).toBe(false);
  expect(isPending({ ...plan, switchedAt: NOW }, 1)).toBe(false);
  expect(isPending(undefined, 1)).toBe(false);
});

test("the live session with the smallest id coordinates, and a silent session is gone after five minutes", () => {
  expect(
    coordinatorOf([record({ sessionId: "c" }), record({ sessionId: "b" })]),
  ).toBe("b");
  expect(coordinatorOf([])).toBe(undefined);
  expect(isGone(record({ updatedAt: NOW - 5 * MINUTE }), NOW)).toBe(false);
  expect(isGone(record({ updatedAt: NOW - 5 * MINUTE - 1 }), NOW)).toBe(true);
});

test("records and plans that do not parse are ignored", () => {
  expect(parseRecord(JSON.stringify(record({})))).toEqual(record({}));
  expect(parseRecord('{"sessionId": 3}')).toBe(undefined);
  expect(parseRecord("not json")).toBe(undefined);
  expect(parsePlan(JSON.stringify(plan))).toEqual(plan);
  expect(parsePlan("{}")).toBe(undefined);
});

test("a cancelled plan is no longer pending", () => {
  expect(isPending(plan, 1)).toBe(true);
  expect(isPending({ ...plan, cancelledAt: NOW }, 1)).toBe(false);
});

test("short of a limit, a sooner weekly reset proposes a switch", () => {
  const accounts = [account(1, 20, 40, true), weeklyIn(account(2, 0, 30), 40)];
  expect(propose({ now: NOW, accounts, burnPerHour: {} })).toEqual({
    from: 1,
    to: 2,
    reason: "soonest-reset",
  });
  const later = [account(1, 20, 40, true), weeklyIn(account(2, 0, 30), 90)];
  expect(
    propose({
      now: NOW,
      accounts: later,
      burnPerHour: {},
    }),
  ).toBeUndefined();
});

test("a soonest-reset switch passes over an account whose window in use is full, and never moves back to one", () => {
  const active = fable(account(1, 10, 10, true), 10);
  const fullSoonest = fable(weeklyIn(account(2, 10, 10), 40), 100);
  const roomLater = fable(weeklyIn(account(3, 10, 10), 60), 10);
  const accounts = [active, fullSoonest, roomLater];
  expect(soonestResetTarget(accounts, NOW, {}, WAIT, NONE)).toBe(2);
  expect(soonestResetTarget(accounts, NOW, {}, WAIT, FABLE)).toBe(3);
  // On account 2 after a Fable limit moved the work away from it: no way back
  // while Fable is in use.
  const moved = [
    fable(weeklyIn(account(1, 10, 10), 40), 100),
    fable(weeklyIn(account(3, 10, 10, true), 60), 10),
  ];
  expect(soonestResetTarget(moved, NOW, {}, WAIT, FABLE)).toBe(undefined);
  expect(soonestResetTarget(moved, NOW, {}, WAIT, NONE)).toBe(1);
});

test("targets rank room in every window in use first, then the soonest reset, then the least flexible room", () => {
  const active = account(1, 95, 10, true);
  const fullFable = fable(weeklyIn(account(2, 10, 10), 40), 100);
  const fableRoom = fable(weeklyIn(account(3, 10, 10), 40), 10);
  expect(
    switchTarget([active, fableRoom, fullFable], NOW, {}, WAIT, NONE),
  ).toBe(2);
  expect(
    switchTarget([active, fableRoom, fullFable], NOW, {}, WAIT, FABLE),
  ).toBe(3);
  // Without room in Fable anywhere, the all-models room still wins.
  expect(switchTarget([active, fullFable], NOW, {}, WAIT, FABLE)).toBe(2);
});

test("a switch at a limit takes a target that lasts, else any account short of its limit", () => {
  const accounts = [account(1, 100, 50, true), account(2, 80, 10)];
  expect(limitTarget(accounts, NOW, { five: 60 }, new Set())).toBe(2);
  expect(limitTarget([account(1, 100, 50, true)], NOW, {}, new Set())).toBe(
    undefined,
  );
});

test("an account without a 5-hour window (Ultra) is a target and plans on its weekly window", () => {
  const ultra = (a: Account): Account => ({ ...a, five: undefined });
  expect(
    switchTarget(
      [account(1, 95, 50, true), ultra(account(2, 0, 20))],
      NOW,
      {},
      WAIT,
      NONE,
    ),
  ).toBe(2);
  expect(
    propose({
      now: NOW,
      accounts: [ultra(account(1, 0, 99, true)), ultra(account(2, 0, 20))],
      burnPerHour: {},
    }),
  ).toEqual(expect.objectContaining({ to: 2, reason: "near-limit" }));
});

test("a window is in use when a live session requested a model in it within the hour", () => {
  expect(isInScope("claude-fable-5-1", "Fable")).toBe(true);
  expect(isInScope("claude-opus-5-5", "Fable")).toBe(false);
  const accounts = [fable(account(1, 10, 10, true), 50)];
  expect(
    scopesInUse(
      [record({ models: { "claude-fable-5-1": NOW - 30 * MINUTE } })],
      accounts,
      NOW,
    ),
  ).toEqual(FABLE);
  expect(
    scopesInUse(
      [
        record({ models: { "claude-fable-5-1": NOW - 2 * HOUR } }),
        record({ sessionId: "b", models: { "claude-opus-5-5": NOW } }),
      ],
      accounts,
      NOW,
    ),
  ).toEqual(new Set());
});

// A switching loop: account 1 at 82% weekly, burning fast; 2 and 3 empty, 1
// resetting soonest.
const loopAccounts = (active: number) => [
  {
    ...weeklyIn(account(1, 0, 82), 88),
    five: undefined,
    isActive: active === 1,
  },
  {
    ...weeklyIn(account(2, 0, 0), 94),
    five: undefined,
    isActive: active === 2,
  },
  {
    ...weeklyIn(account(3, 0, 0), 92),
    five: undefined,
    isActive: active === 3,
  },
];

test("a near-limit switch is not undone by soonest-reset at the same work burn", () => {
  const burn = { seven: 40 };
  const away = propose({
    now: NOW,
    accounts: loopAccounts(1),
    burnPerHour: burn,
  });
  expect(away).toMatchObject({ from: 1, to: 3, reason: "near-limit" });
  expect(
    propose({
      now: NOW + 2 * HOUR,
      accounts: loopAccounts(3),
      burnPerHour: burn,
    }),
  ).toBeUndefined();
});

test("soonest-reset never moves back to an account a near-limit switch left, until that window resets", () => {
  const left = [{ account: 1, until: NOW + 88 * HOUR }];
  const from3 = (now: number) =>
    propose({
      now,
      accounts: loopAccounts(3),
      burnPerHour: {},
      left,
    });
  expect(from3(NOW + 2 * HOUR)).toBeUndefined();
  expect(from3(NOW)?.to).toBeUndefined();
  expect(
    propose({
      now: NOW,
      accounts: loopAccounts(3),
      burnPerHour: {},
      left: [{ account: 1, until: NOW - 1 }],
    })?.to,
  ).toBe(1);
});

test("soonest-reset waits an hour after any switch", () => {
  const at = (lastSwitchAt: number) =>
    propose({
      now: NOW,
      accounts: loopAccounts(3),
      burnPerHour: {},
      lastSwitchAt,
    })?.to;
  expect(at(NOW - 30 * MINUTE)).toBeUndefined();
  expect(at(NOW - HOUR)).toBe(1);
});

test("an active account with no current weekly reading gives no soonest-reset", () => {
  const accounts = loopAccounts(3).map((a) =>
    a.isActive ? { ...a, seven: undefined } : a,
  );
  expect(soonestResetTarget(accounts, NOW, {}, WAIT, NONE)).toBeUndefined();
});

// For any accounts and one work burn, the account a proposal moves to never
// proposes moving straight back, whatever the rule.
test("no proposal is undone by the next one at the same burn", () => {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const pct = () => Math.floor(rand() * 100);
  let checked = 0;
  for (let round = 0; round < 3000; round++) {
    const n = 2 + Math.floor(rand() * 3);
    const accounts: Account[] = Array.from({ length: n }, (_, k) => ({
      ...fable(
        weeklyIn(account(k + 1, pct(), pct()), 1 + Math.floor(rand() * 160)),
        pct(),
      ),
      isActive: k === 0,
    }));
    const maybe = () => (rand() < 0.3 ? undefined : rand() * 60);
    const burns = {
      five: maybe(),
      seven: maybe(),
      scoped: (rand() < 0.5 ? {} : { Fable: rand() * 60 }) as Record<
        string,
        number
      >,
    };
    const inUse = rand() < 0.5 ? FABLE : new Set<string>();
    const first = propose({
      now: NOW,
      accounts,
      burnPerHour: burns,
      inUse,
    });
    if (!first) continue;
    const moved = accounts.map((a) => ({
      ...a,
      isActive: a.number === first.to,
    }));
    const next = propose({
      now: NOW,
      accounts: moved,
      burnPerHour: burns,
      inUse,
    });
    checked++;
    expect(
      next?.to === first.from ? { first, next, accounts, burns } : undefined,
    ).toBeUndefined();
  }
  expect(checked).toBeGreaterThan(100);
});

test("a switch's record carries the accounts left and the last hour's switches on from the last plan", () => {
  const last: SwitchPlan = {
    ...plan,
    switchedAt: NOW - 20 * MINUTE,
    left: [
      { account: 3, until: NOW + HOUR },
      { account: 4, until: NOW - 1 },
    ],
    recentSwitches: [NOW - 2 * HOUR, NOW - 50 * MINUTE],
  };
  expect(
    switchRecord(
      last,
      { from: 2, to: 1, reason: "limit", leaves: NOW + 3 * HOUR },
      NOW,
    ),
  ).toEqual({
    id: `${NOW}-2-1`,
    from: 2,
    to: 1,
    reason: "limit",
    createdAt: NOW,
    left: [
      { account: 3, until: NOW + HOUR },
      { account: 2, until: NOW + 3 * HOUR },
    ],
    recentSwitches: [NOW - 50 * MINUTE, NOW - 20 * MINUTE],
  });
  expect(
    switchRecord(undefined, { from: 1, to: 2, reason: "soonest-reset" }, NOW),
  ).toEqual(expect.objectContaining({ left: [], recentSwitches: [] }));
});
