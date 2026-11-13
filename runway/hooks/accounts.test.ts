import { expect, test } from "claude-code/testing";
import {
  activeUsage,
  defaultLoginCswap,
  firstToRecover,
  isDefaultProfile,
  isInRotation,
  loginState,
  parseLogin,
  parseCswapList,
  poolOf,
  runsCswapAuto,
  setupProblems,
  viableAccounts,
} from "./accounts";

const NOW = Date.parse("2026-10-10T17:00:00Z");
const HOUR = 3_600_000;
const iso = (hours: number) => new Date(NOW + hours * HOUR).toISOString();
const listing = JSON.stringify({
  schemaVersion: 1,
  accounts: [
    {
      number: 1,
      email: "a@x",
      active: true,
      usageStatus: "ok",
      usage: {
        fiveHour: { pct: 97, resetsAt: iso(2) },
        sevenDay: { pct: 70, resetsAt: iso(84) },
      },
    },
    {
      number: 2,
      email: "b@x",
      active: false,
      usageStatus: "ok",
      usage: {
        fiveHour: { pct: 10, resetsAt: iso(4) },
        sevenDay: { pct: 30, resetsAt: iso(84) },
      },
    },
    {
      number: 3,
      email: "c@x",
      active: false,
      usageStatus: "ok",
      usage: { sevenDay: { pct: 95, resetsAt: iso(10) } },
    },
  ],
});

test("cswap listings parse into accounts with windows and model limits", () => {
  const accounts = parseCswapList(listing);
  expect(accounts.map((a) => a.isActive)).toEqual([true, false, false]);
  expect(accounts[1].five).toEqual({ used: 10, resetsAt: NOW + 4 * HOUR });
  expect(accounts[2].five).toBe(undefined);
  expect(parseCswapList("{}")).toEqual([]);
  const scoped = parseCswapList(
    JSON.stringify({
      accounts: [
        {
          number: 1,
          active: true,
          usageStatus: "ok",
          usage: { scoped: [{ name: "Fable", pct: 93, resetsAt: iso(50) }] },
        },
      ],
    }),
  );
  expect(scoped[0].scoped).toEqual([
    { label: "Fable", used: 93, resetsAt: NOW + 50 * HOUR },
  ]);
});

test("a pool counts the other accounts short of a limit, and one account is no pool", () => {
  const accounts = parseCswapList(listing);
  expect(poolOf(accounts, NOW)).toEqual({ viable: 2 });
  expect(
    poolOf(
      accounts.map((a) =>
        a.number === 3 ? { ...a, seven: { ...a.seven!, used: 99 } } : a,
      ),
      NOW,
    ),
  ).toEqual({ viable: 1 });
  expect(poolOf(accounts.slice(0, 1), NOW)).toBe(undefined);
  expect(viableAccounts(accounts, NOW, 95)).toHaveLength(1);
  expect(
    viableAccounts(
      accounts.filter((a) => a.number !== 2),
      NOW,
      95,
    ),
  ).toEqual([]);
});

test("setup problems name each unusable account and a pool too small to switch", () => {
  const accounts = parseCswapList(listing);
  expect(setupProblems(accounts)).toEqual([]);
  const problems = setupProblems([
    { ...accounts[0] },
    { ...accounts[1], status: "token_expired" },
  ]);
  expect(problems.length).toBe(2);
  expect(problems[0]).toContain("needs a new login (token expired)");
  expect(problems[0]).toContain("`cswap disable 2` to leave it out");
  expect(problems[1]).toContain("1 usable account;");
  expect(setupProblems([])[0]).toContain("0 usable accounts");
});

test("the active account's current windows come from cswap", () => {
  const accounts = parseCswapList(listing);
  expect(activeUsage(accounts, NOW)).toEqual({
    five: accounts[0].five,
    seven: accounts[0].seven,
    scoped: [],
  });
  expect(activeUsage(accounts, NOW + 3 * HOUR)?.five).toBe(undefined);
  expect(
    activeUsage(
      accounts.map((a) => ({ ...a, isActive: false })),
      NOW,
    ),
  ).toBe(undefined);
  expect(
    activeUsage([{ ...accounts[0], status: "foreign_credential" }], NOW),
  ).toBe(undefined);
});

test("with no account short of a limit, the first account to recover is the one work waits for", () => {
  const accounts = parseCswapList(
    JSON.stringify({
      accounts: [
        {
          number: 1,
          active: true,
          usageStatus: "ok",
          usage: {
            fiveHour: { pct: 100, resetsAt: iso(3) },
            sevenDay: { pct: 60, resetsAt: iso(80) },
          },
        },
        {
          number: 2,
          active: false,
          usageStatus: "ok",
          usage: {
            fiveHour: { pct: 99, resetsAt: iso(1) },
            sevenDay: { pct: 50, resetsAt: iso(90) },
          },
        },
        {
          number: 3,
          active: false,
          usageStatus: "ok",
          usage: {
            fiveHour: { pct: 20, resetsAt: iso(4) },
            sevenDay: { pct: 100, resetsAt: iso(20) },
          },
        },
      ],
    }),
  );
  expect(poolOf(accounts, NOW)).toEqual({
    viable: 0,
    recovery: { account: 2, at: NOW + HOUR, isActive: false },
  });
  const nearlyOut = accounts.map((a) =>
    a.number === 3
      ? { ...a, seven: { used: 93, resetsAt: NOW + 20 * HOUR } }
      : a,
  );
  expect(firstToRecover(nearlyOut, NOW)).toEqual({
    account: 3,
    at: NOW,
    isActive: false,
  });
  const sameTime = accounts.map((a) =>
    a.number === 1 ? { ...a, five: { used: 100, resetsAt: NOW + HOUR } } : a,
  );
  expect(firstToRecover(sameTime, NOW)?.account).toBe(2);
});

test("a disabled account is never a switch target nor a setup problem, but the active one stays in rotation while disabled", () => {
  const [one, two, three] = parseCswapList(
    JSON.stringify({
      accounts: [
        {
          number: 1,
          active: true,
          usageStatus: "ok",
          usage: {
            fiveHour: { pct: 92, resetsAt: iso(2) },
            sevenDay: { pct: 20, resetsAt: iso(84) },
          },
        },
        {
          number: 2,
          active: false,
          usageStatus: "ok",
          disabled: true,
          usage: {
            fiveHour: { pct: 0, resetsAt: iso(4) },
            sevenDay: { pct: 10, resetsAt: iso(84) },
          },
        },
        {
          number: 3,
          active: false,
          usageStatus: "ok",
          usage: {
            fiveHour: { pct: 30, resetsAt: iso(4) },
            sevenDay: { pct: 40, resetsAt: iso(84) },
          },
        },
      ],
    }),
  );
  expect(
    viableAccounts([one, two, three], NOW, 90).map((a) => a.number),
  ).toEqual([3]);
  expect(setupProblems([one, { ...two, status: "token_expired" }])).toEqual([]);
  const full = [one, two, three].map((a) => ({
    ...a,
    five: { used: 100, resetsAt: NOW + (a.number === 2 ? 1 : a.number) * HOUR },
  }));
  expect(firstToRecover(full, NOW)?.account).toBe(1);
  expect(activeUsage([{ ...one, isDisabled: true }], NOW)?.five).toEqual(
    one.five,
  );
});

test("a cswap auto loop is told apart from single ticks, dry runs and other commands", () => {
  expect(
    runsCswapAuto(
      "/usr/bin/python3 /home/u/.local/bin/cswap auto --interval 30",
    ),
  ).toBe(true);
  expect(
    runsCswapAuto("bash\n/home/u/.local/bin/claude-swap --debug auto"),
  ).toBe(true);
  expect(runsCswapAuto("python3 -m claude_swap auto")).toBe(true);
  expect(
    runsCswapAuto("/home/u/.local/bin/cswap auto --once --threshold 90 --json"),
  ).toBe(false);
  expect(runsCswapAuto("cswap auto --dry-run")).toBe(false);
  expect(runsCswapAuto("cswap list --json\nvim auto.txt")).toBe(false);
});

test("a session is in the default profile without CLAUDE_CONFIG_DIR or with it naming ~/.claude", () => {
  expect(isDefaultProfile(undefined, "/home/u")).toBe(true);
  expect(isDefaultProfile("", "/home/u")).toBe(true);
  expect(isDefaultProfile("~/.claude/", "/home/u")).toBe(true);
  expect(isDefaultProfile("/home/u/./.claude", "/home/u")).toBe(true);
  expect(
    isDefaultProfile(
      "/home/u/.local/share/claude-swap/sessions/2-b@x",
      "/home/u",
    ),
  ).toBe(false);
  expect(isDefaultProfile("/elsewhere", "/home/u")).toBe(false);
});

test("a cswap run for the default login drops the profile variables cswap follows", () => {
  expect(defaultLoginCswap(["list", "--json"])).toEqual([
    "env",
    "-u",
    "CLAUDE_CONFIG_DIR",
    "-u",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "cswap",
    "list",
    "--json",
  ]);
});

test("the login is read from Claude Code's oauthAccount, and nothing else counts as one", () => {
  expect(
    parseLogin(
      JSON.stringify({
        oauthAccount: { emailAddress: "a@x", organizationUuid: "org-a" },
      }),
    ),
  ).toEqual({ email: "a@x", organizationUuid: "org-a" });
  expect(
    parseLogin(JSON.stringify({ oauthAccount: { emailAddress: "a@x" } })),
  ).toEqual({ email: "a@x", organizationUuid: "" });
  expect(parseLogin(JSON.stringify({ oauthAccount: {} }))).toBe(undefined);
  expect(parseLogin("not json")).toBe(undefined);
});

test("cswap holds a login only on its active account, matched by email and organization", () => {
  const accounts = [
    {
      number: 1,
      email: "a@x",
      organizationUuid: "org-a",
      isActive: true,
      status: "ok" as const,
      scoped: [],
    },
    {
      number: 2,
      email: "a@x",
      organizationUuid: "org-b",
      isActive: false,
      status: "ok" as const,
      scoped: [],
    },
  ];
  const login = (organizationUuid: string) => ({
    email: "a@x",
    organizationUuid,
  });
  expect(loginState(accounts, login("org-a"))).toEqual({ kind: "held" });
  expect(loginState(accounts, login("org-b"))).toEqual({
    kind: "stale",
    account: 2,
  });
  expect(loginState(accounts, login("org-c"))).toEqual({
    kind: "new",
    email: "a@x",
  });
  expect(loginState(accounts, undefined)).toEqual({ kind: "held" });
});

// The shape of `cswap list --json` from cswap 0.29.0, one row per usageStatus,
// with invented accounts and figures. Only an ok row carries `usage`; the
// others carry `usage: null` and, when cswap had one, a display-only
// `lastGoodUsage`.
const realShape = JSON.stringify({
  schemaVersion: 1,
  activeAccountNumber: 1,
  accounts: [
    ["ok", true],
    ["token_expired", false],
    ["relogin_required", false],
    ["foreign_credential", false],
    ["no_credentials", false],
    ["api_key", false],
    ["keychain_unavailable", false],
    ["unavailable", false],
    ["some_future_status", false],
  ].map(([status, active], k) => ({
    number: k + 1,
    email: `user${k + 1}@example.com`,
    organizationName: `Org ${k + 1}`,
    organizationUuid: `org-${k + 1}`,
    isOrganization: true,
    active,
    usageStatus: status,
    loginExpiresAt: iso(24 * 10),
    ...(status === "ok"
      ? {
          usage: {
            sevenDay: { pct: 40, resetsAt: iso(80), countdown: "3d 8h" },
            scoped: [{ pct: 5, resetsAt: iso(80), name: "Fable" }],
          },
          usageFetchedAt: iso(-0.01),
          usageAgeSeconds: 36,
        }
      : {
          usage: null,
          lastGoodUsage: { sevenDay: { pct: 10, resetsAt: iso(-20) } },
          lastGoodFetchedAt: iso(-48),
        }),
  })),
});

test("in cswap's real listing, only ok rows can take work, and only the statuses a login fixes are problems", () => {
  const accounts = parseCswapList(realShape);
  expect(accounts.map((a) => a.status)).toEqual([
    "ok",
    "token_expired",
    "relogin_required",
    "foreign_credential",
    "no_credentials",
    "api_key",
    "keychain_unavailable",
    "unavailable",
    "unknown",
  ]);
  expect(accounts[0].seven?.used).toBe(40);
  expect(accounts[0].organizationUuid).toBe("org-1");
  expect(accounts[2].seven).toBe(undefined);
  expect(accounts.filter(isInRotation).map((a) => a.number)).toEqual([1]);
  expect(viableAccounts(accounts, NOW)).toEqual([]);
  expect(setupProblems(accounts)).toEqual([
    expect.stringContaining(
      "cswap account 2 (user2@example.com) needs a new login (token expired): /login to it",
    ),
    expect.stringContaining(
      "cswap account 3 (user3@example.com) needs a new login (relogin required): /login to it",
    ),
    expect.stringContaining("(slot 4). Run /add-account"),
    expect.stringContaining(
      "cswap account 5 (user5@example.com) needs a new login (no credentials): /login to it",
    ),
  ]);
});
