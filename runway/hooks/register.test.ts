import type { On, SessionRateLimit } from "claude-code";
import { expect, mock, test, type TestBody } from "claude-code/testing";
import { HOUR, MINUTE } from "./limits";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const HOME = "/home/u";
const ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const DAY = 24 * HOUR;
const START = {
  cwd: "/work/project",
  surface: "terminal",
  isInteractive: true,
} as const;
const SWITCH_DIR = `${HOME}/.claude/runway/switch`;
const PLAN = `${SWITCH_DIR}/plan.json`;
const LAST_SWITCH = `${SWITCH_DIR}/last-switch.json`;

type Ran = { exitCode: number; stdout?: string; stderr?: string };

type Setup = {
  rateLimits?: SessionRateLimit[];
  contextTokens?: number;
  // The tools the model can call; tidy's compact tool by default.
  tools?: string[];
  files?: Record<string, { text?: string }>;
  settings?: Record<string, unknown>;
  run?: (argv: readonly string[]) => Ran | undefined;
  env?: Record<string, string>;
};

function withoutEnvPrefix(argv: readonly string[]): string[] {
  if (argv[0] !== "env") return [...argv];
  let at = 1;
  while (argv[at] === "-u") at += 2;
  return argv.slice(at);
}

// The log's shell append (APPEND_LOG), on the mocked files: past the cap the
// log moves to <log>.1, then the lines are appended.
function appendLog(
  files: Map<string, { text: string; mtimeMs: number }>,
  argv: readonly string[],
  stdin: string,
  now: number,
) {
  const [path, cap] = [argv[4], Number(argv[5])];
  const log = files.get(path);
  if (log && log.text.length >= cap) {
    files.set(`${path}.1`, log);
    files.delete(path);
  }
  files.set(path, {
    text: (files.get(path)?.text ?? "") + stdin,
    mtimeMs: now,
  });
}

function world(on: On, setup: Setup = {}) {
  const clock = mock.clock(on, { now: NOW });
  const store = new Map<string, unknown>();
  const storeReads: string[] = [];
  on("store.get", async ($, e) => {
    storeReads.push(e.key);
    return { value: store.get(e.key) } as never;
  });
  on("store.set", async ($, e) => {
    store.set(e.key, e.value);
    return { value: undefined } as never;
  });
  mock.env(on, { HOME, ...setup.env });
  const files = new Map(
    Object.entries(setup.files ?? {}).map(([path, f]) => [
      path,
      { text: f.text ?? "", mtimeMs: NOW },
    ]),
  );
  const seen = {
    toasts: [] as string[],
    statuses: [] as (string | undefined)[],
    notifications: [] as string[],
    prompts: [] as string[],
    runs: [] as string[][],
    spawned: [] as string[][],
    writes: [] as string[],
    lists: [] as string[],
  };
  const missing = (path: string) => ({ deny: `ENOENT: ${path}` });
  on("session.start", async ($, e) => ({ cwd: e.cwd }));
  on("session.id", async () => ({ value: ID }));
  on("session.root", async () => ({ value: "/work/project" }) as never);
  on(
    "session.usage",
    async () =>
      ({
        value: {
          startedAt: NOW,
          rateLimits: setup.rateLimits ?? [],
          context: { tokens: setup.contextTokens ?? 100_000 },
        },
      }) as never,
  );
  on("settings.read", async () => ({ value: setup.settings ?? {} }) as never);
  on(
    "tool.list",
    async () =>
      ({
        value: (setup.tools ?? ["mcp__tidy__compact"]).map((name) => ({
          name,
          description: "",
          mcp: true,
        })),
      }) as never,
  );
  on(
    "command.register",
    async ($, e) => ({ value: { command: e.name } }) as never,
  );
  on("command.list", async () => ({ value: [] }) as never);
  on("ui.toast", async ($, e) => {
    seen.toasts.push(e.text);
    return { value: undefined };
  });
  on("ui.status", async ($, e) => {
    seen.statuses.push((e as { text?: string }).text);
    return { value: undefined };
  });
  on("ui.notify", async ($, e) => {
    seen.notifications.push(e.text);
    return { value: { isSent: true } } as never;
  });
  on("prompt.submit", async ($, e) => {
    seen.prompts.push(e.text);
    return { text: e.text };
  });
  on("fs.read", async ($, e) =>
    files.has(e.path) ? { value: files.get(e.path)!.text } : missing(e.path),
  );
  on("fs.exists", async ($, e) => ({ value: files.has(e.path) }));
  on("fs.list", async ($, e) => {
    seen.lists.push(e.path);
    const prefix = `${e.path}/`;
    const children = new Map<string, "file" | "dir">();
    for (const path of files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const [name, ...rest] = path.slice(prefix.length).split("/");
      children.set(name, rest.length > 0 ? "dir" : "file");
    }
    return {
      value: [...children].map(([name, kind]) => ({
        name,
        kind,
        size: 0,
        mtimeMs: NOW,
        isLink: false,
      })),
    };
  });
  on("fs.write", async ($, e) => {
    seen.writes.push(e.path);
    files.set(e.path, { text: e.text, mtimeMs: clock.now() });
    return { value: undefined };
  });
  on("session.measure", async () => ({ changed: [] }));
  on("classic.StopFailure", async () => ({}) as never);
  on("turn.start", async ($, e) => ({ turnId: e.turnId }) as never);
  on("turn.complete", async () => ({ text: "" }));
  on("turn.step", async function* ($, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: "",
      toolUses: [],
      stopReason: "end_turn" as const,
      usage: {
        model: "claude-opus-5-5",
        input_tokens: 10,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
  });
  on("process.run", async ($, e) => {
    if (e.argv[0] === "sh") {
      appendLog(files, e.argv, e.init?.stdin ?? "", clock.now());
      return {
        value: {
          exitCode: 0,
          stdout: "",
          stderr: "",
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      };
    }
    seen.spawned.push([...e.argv]);
    const argv = withoutEnvPrefix(e.argv);
    seen.runs.push(argv);
    const ran = setup.run?.(argv) ?? { exitCode: 127, stderr: "not found" };
    return {
      value: {
        exitCode: ran.exitCode,
        stdout: ran.stdout ?? "",
        stderr: ran.stderr ?? "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });
  return { clock, files, seen, store, storeReads };
}

const eventsOf = (files: Map<string, { text: string }>, name: string) =>
  (files.get(`${HOME}/.claude/runway/${ID}.jsonl`)?.text ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((e) => e.event === name);

const finishTurn = ($: Parameters<TestBody>[0], isAborted = false) =>
  $.turn.complete({
    reason: "answer",
    answer: "",
    durationMs: 1,
    turnId: "t",
    isAborted,
  });
const startTurn = ($: Parameters<TestBody>[0]) =>
  $.turn.start({ turnId: "t" } as never);
const contextOf = async ($: Parameters<TestBody>[0]) =>
  String(
    (await $.tool.call({ tool: "Read", file_path: "/work/project/a" }))
      .context ?? "",
  );
const usage = (rateLimits: SessionRateLimit[], tokens = 100_000) => ({
  context: { tokens, window: 1_000_000 },
  rateLimits,
  changed: [],
});

const steady: SessionRateLimit[] = [
  {
    kind: "five_hour",
    percentUsed: 10,
    resetsAt: new Date(NOW + 4 * HOUR).toISOString(),
  },
  {
    kind: "seven_day",
    percentUsed: 40,
    resetsAt: new Date(NOW + 4 * DAY).toISOString(),
  },
];
const nearLimit: SessionRateLimit[] = [
  {
    kind: "five_hour",
    percentUsed: 97,
    resetsAt: new Date(NOW + 2 * HOUR).toISOString(),
  },
  {
    kind: "seven_day",
    percentUsed: 40,
    resetsAt: new Date(NOW + 4 * DAY).toISOString(),
  },
];

// Two accounts; `five` gives each one's 5-hour use and reset.
type Five = Record<number, { pct: number; resetsIn: number }>;
const cswapList = (active: number, five: Five) =>
  JSON.stringify({
    accounts: Object.entries(five).map(([n, f]) => ({
      number: Number(n),
      email: `${n}@example.com`,
      active: Number(n) === active,
      usageStatus: "ok",
      usage: {
        fiveHour: {
          pct: f.pct,
          resetsAt: new Date(NOW + f.resetsIn).toISOString(),
        },
        sevenDay: { pct: 40, resetsAt: new Date(NOW + 4 * DAY).toISOString() },
      },
    })),
  });

// Claude Code's record of the account it is logged in to.
const CLAUDE_JSON = `${HOME}/.claude.json`;
const loginRecord = (email: string) =>
  JSON.stringify({ oauthAccount: { emailAddress: email } });
const loggedIn = (email: string) => ({
  [CLAUDE_JSON]: { text: loginRecord(email) },
});

// A switch logs Claude Code in to the account it moves to. `setup.run`
// answers first; what it leaves undefined, the world answers.
function cswapWorld(on: On, five: Five, setup: Setup = {}) {
  const list = { active: 1 };
  const w = world(on, {
    rateLimits: steady,
    ...setup,
    run: (argv) => {
      const own = setup.run?.(argv);
      if (own !== undefined) return own;
      if (argv[0] !== "cswap") return undefined;
      if (argv[1] === "switch" && /^\d+$/.test(argv[2]))
        list.active = Number(argv[2]);
      if (argv[1] === "switch" && w.files.has(CLAUDE_JSON))
        w.files.set(CLAUDE_JSON, {
          text: loginRecord(`${list.active}@example.com`),
          mtimeMs: NOW,
        });
      return {
        exitCode: 0,
        stdout: argv[1] === "list" ? cswapList(list.active, five) : "",
      };
    },
  });
  return { ...w, list };
}

const switchRuns = (runs: string[][]) =>
  runs.filter((argv) => argv[0] === "cswap" && argv[1] === "switch");
// The switch recorded where other runway sessions (plan.json) and tidy
// (last-switch.json) read it.
const recorded = (files: Map<string, { text: string }>) => ({
  plan: JSON.parse(files.get(PLAN)?.text ?? "null"),
  lastSwitch: JSON.parse(files.get(LAST_SWITCH)?.text ?? "null")?.switchedAt,
});

test(
  "settings out of range fall back to their defaults and are reported at session start",
  { options: { switchMaxWaitMinutes: -5 } },
  async ($, on) => {
    const { seen, files, clock } = world(on);
    await $.session.start(START);
    await clock.settle();
    expect(seen.toasts).toEqual([
      "runway: switchMaxWaitMinutes -5 must be a number at least 0; using 30",
    ]);
    expect(eventsOf(files, "options-ignored")).toHaveLength(1);
  },
);

test("valid settings start the session without a toast", async ($, on) => {
  const { seen, clock } = world(on);
  await $.session.start(START);
  await clock.settle();
  expect(seen.toasts).toEqual([]);
});

// ---- Compaction before a limit ----

test("a large context facing a limit wait longer than the cache gets one note to compact", async ($, on) => {
  const { clock } = world(on, {
    rateLimits: nearLimit,
    contextTokens: 300_000,
  });
  on("tool.call", async () => ({ result: "ok" }));
  await $.session.start(START);
  await startTurn($);
  for await (const _ of $.turn.step({
    turnId: "t",
    index: 0,
    model: "claude-opus-5-5",
    messageCount: 1,
  }));
  await $.session.measure(usage(nearLimit, 300_000));
  const note = await contextOf($);
  expect(note).toContain("[runway] Usage windows at 95% or more");
  expect(note).toContain(
    "- 5-hour, all models: 97% used, resets 14:00 UTC (in 2h); from the last response's rate-limit headers, 0m old.",
  );
  expect(note).toContain("Runway is not switching accounts");
  expect(note).toContain("The context is 300k tokens");
  expect(note).toContain("call mcp__tidy__compact");
  expect(note).not.toContain("will stop");
  await clock.advance(5 * MINUTE);
  await $.session.measure(usage(nearLimit, 300_000));
  expect(await contextOf($)).not.toContain("Usage windows at 95%");
});

test("the note to compact reads the context and rate limits that session.measure passes", async ($, on) => {
  world(on, { rateLimits: steady, contextTokens: 100_000 });
  on("tool.call", async () => ({ result: "ok" }));
  await $.session.start(START);
  await startTurn($);
  await respond($);
  await $.session.measure(usage(nearLimit, 300_000));
  expect(await contextOf($)).toContain("- 5-hour, all models: 97% used");
});

test("a measured context below the threshold reads no burn samples", async ($, on) => {
  const { storeReads } = world(on, { rateLimits: nearLimit });
  on("tool.call", async () => ({ result: "ok" }));
  await $.session.start(START);
  await startTurn($);
  await respond($);
  const before = storeReads.length;
  await $.session.measure(usage(nearLimit, 100_000));
  expect(storeReads.length).toBe(before);
});

test("a small context gets no note to compact before a limit", async ($, on) => {
  world(on, { rateLimits: nearLimit });
  on("tool.call", async () => ({ result: "ok" }));
  await $.session.start(START);
  for await (const _ of $.turn.step({
    turnId: "t",
    index: 0,
    model: "claude-opus-5-5",
    messageCount: 1,
  }));
  await $.session.measure(usage(nearLimit));
  expect(await contextOf($)).not.toContain("Usage windows at 95%");
});

test("no note to compact before a limit while tidy's compact tool is not loaded, and one once it is", async ($, on) => {
  const tools: string[] = [];
  const { files } = world(on, {
    rateLimits: nearLimit,
    contextTokens: 300_000,
    tools,
  });
  on("tool.call", async () => ({ result: "ok" }));
  await $.session.start(START);
  await startTurn($);
  for await (const _ of $.turn.step({
    turnId: "t",
    index: 0,
    model: "claude-opus-5-5",
    messageCount: 1,
  }));
  await $.session.measure(usage(nearLimit, 300_000));
  expect(await contextOf($)).not.toContain("Usage windows at 95%");
  expect(eventsOf(files, "limit-note")).toEqual([]);
  tools.push("mcp__tidy__compact");
  await $.session.measure(usage(nearLimit, 300_000));
  expect(await contextOf($)).toContain("Usage windows at 95%");
});

test(
  "compactBeforeLimitTokens 0 gives no note to compact before a limit",
  { options: { compactBeforeLimitTokens: 0 } },
  async ($, on) => {
    world(on, { rateLimits: nearLimit, contextTokens: 300_000 });
    on("tool.call", async () => ({ result: "ok" }));
    await $.session.start(START);
    await $.session.measure(usage(nearLimit, 300_000));
    expect(await contextOf($)).not.toContain("Usage windows at 95%");
  },
);

test("no note to compact before a limit while another account can take the work", async ($, on) => {
  const { clock } = cswapWorld(
    on,
    { 1: { pct: 97, resetsIn: 2 * HOUR }, 2: { pct: 10, resetsIn: 3 * HOUR } },
    { rateLimits: nearLimit, contextTokens: 300_000 },
  );
  on("tool.call", async () => ({ result: "ok" }));
  await $.session.start(START);
  await clock.settle();
  await $.session.measure(usage(nearLimit, 300_000));
  expect(await contextOf($)).not.toContain("Usage windows at 95%");
});

test("a full model-specific window gets a note that names it, its account and source, and logs the windows", async ($, on) => {
  const at = (ms: number) => new Date(NOW + ms).toISOString();
  const account = (n: number, active: boolean) => ({
    number: n,
    email: `${n}@example.com`,
    active,
    usageStatus: "ok",
    usage: {
      fiveHour: { pct: 10, resetsAt: at(3 * HOUR) },
      sevenDay: { pct: 96, resetsAt: at(20 * HOUR) },
      scoped: [{ name: "Fable", pct: 100, resetsAt: at(20 * HOUR) }],
    },
    usageFetchedAt: at(-3 * MINUTE),
  });
  const { clock, files } = world(on, {
    rateLimits: steady,
    contextTokens: 400_000,
    run: (argv) =>
      argv[0] === "cswap" && argv[1] === "list"
        ? {
            exitCode: 0,
            stdout: JSON.stringify({
              accounts: [account(1, true), account(2, false)],
            }),
          }
        : argv[0] === "cswap"
          ? { exitCode: 0, stdout: "" }
          : undefined,
  });
  on("tool.call", async () => ({ result: "ok" }));
  await $.session.start(START);
  await clock.settle();
  await $.session.measure(usage(steady, 400_000));
  const note = await contextOf($);
  expect(note).toContain("on account 1 (1@example.com)");
  expect(note).toContain(
    "- Fable only: 100% used, resets 08:00 UTC (in 20h); from cswap list, 3m old.",
  );
  expect(note).toContain("- weekly, all models: 96% used");
  expect(note).toContain("No other cswap account is below 95%");
  expect(note).not.toContain("will stop");
  expect(eventsOf(files, "limit-note")).toEqual([
    expect.objectContaining({
      account: 1,
      windows: [
        expect.objectContaining({
          name: "weekly, all models",
          used: 96,
          source: "cswap",
        }),
        expect.objectContaining({
          name: "Fable only",
          used: 100,
          source: "cswap",
        }),
      ],
    }),
  ]);
});

// ---- Account switching ----

test("switching switches as soon as it plans a switch near a limit", async ($, on) => {
  const { seen, clock, files } = cswapWorld(on, {
    1: { pct: 99, resetsIn: 3 * HOUR },
    2: { pct: 10, resetsIn: 3 * HOUR },
  });
  await $.session.start(START);
  await clock.settle();
  expect(switchRuns(seen.runs)).toEqual([["cswap", "switch", "2", "--json"]]);
  expect(recorded(files)).toEqual({
    plan: expect.objectContaining({ from: 1, to: 2, switchedAt: NOW }),
    lastSwitch: NOW,
  });
  expect(eventsOf(files, "switch-done")).toEqual([
    expect.objectContaining({ from: 1, to: 2, by: "runway" }),
  ]);
});

test(
  "switching false never plans or switches",
  { options: { switching: false } },
  async ($, on) => {
    const { seen, clock, files } = cswapWorld(on, {
      1: { pct: 99, resetsIn: 3 * HOUR },
      2: { pct: 10, resetsIn: 3 * HOUR },
    });
    await $.session.start(START);
    await clock.advance(10 * MINUTE);
    expect(files.has(PLAN)).toBe(false);
    expect(switchRuns(seen.runs)).toEqual([]);
  },
);

test("a cswap auto loop stops runway from switching, and the status line says so", async ($, on) => {
  const list = { active: 1 };
  const { seen, clock } = world(on, {
    run: (argv) => {
      if (argv[0] === "ps")
        return {
          exitCode: 0,
          stdout: "/home/u/.local/bin/cswap auto --interval 30",
        };
      if (argv[0] !== "cswap") return undefined;
      return {
        exitCode: 0,
        stdout:
          argv[1] === "list"
            ? cswapList(list.active, {
                1: { pct: 99, resetsIn: 3 * HOUR },
                2: { pct: 10, resetsIn: 3 * HOUR },
              })
            : "",
      };
    },
  });
  await $.session.start(START);
  await clock.settle();
  expect(switchRuns(seen.runs)).toEqual([]);
  expect(seen.statuses.at(-1)).toContain("cswap auto is running");
});

test("a coordinator closes a plan it never saw pending as cancelled, and wakes no session", async ($, on) => {
  const stray = {
    id: "stray",
    from: 2,
    to: 1,
    reason: "near-limit",
    createdAt: NOW - MINUTE,
  };
  const { seen, clock, files } = cswapWorld(
    on,
    { 1: { pct: 10, resetsIn: 3 * HOUR }, 2: { pct: 10, resetsIn: 3 * HOUR } },
    { files: { [PLAN]: { text: JSON.stringify(stray) } } },
  );
  await $.session.start(START);
  await clock.settle();
  const plan = JSON.parse(files.get(PLAN)!.text);
  expect([plan.switchedAt, typeof plan.cancelledAt]).toEqual([
    undefined,
    "number",
  ]);
  expect(eventsOf(files, "switch-cancelled").map((e) => e.id)).toEqual([
    "stray",
  ]);
  expect(seen.prompts).toEqual([]);
});

test("a limit with another account short of its limit switches at once, records the switch and resumes the session", async ($, on) => {
  const five = {
    1: { pct: 50, resetsIn: 3 * HOUR },
    2: { pct: 10, resetsIn: 3 * HOUR },
  };
  const { seen, clock, files } = cswapWorld(on, five);
  await $.session.start(START);
  await clock.settle();
  expect(switchRuns(seen.runs)).toEqual([]);
  five[1].pct = 100;
  await $.classic.StopFailure({ error: "rate_limit" } as never);
  expect(switchRuns(seen.runs)).toEqual([["cswap", "switch", "2", "--json"]]);
  expect(recorded(files)).toEqual({
    plan: expect.objectContaining({
      reason: "limit",
      from: 1,
      to: 2,
      switchedAt: NOW,
      left: [{ account: 1, until: NOW + 3 * HOUR }],
    }),
    lastSwitch: NOW,
  });
  await clock.advance(2 * MINUTE);
  expect(
    seen.prompts.filter((p) => p.includes("switched to account 2")),
  ).toHaveLength(1);
});

test("a subagent's limit neither switches nor marks the session stopped", async ($, on) => {
  const five = {
    1: { pct: 50, resetsIn: 3 * HOUR },
    2: { pct: 10, resetsIn: 3 * HOUR },
  };
  const { seen, clock, files } = cswapWorld(on, five);
  await $.session.start(START);
  await clock.settle();
  await startTurn($);
  await $.classic.StopFailure({
    error: "rate_limit",
    agent_id: "a1",
  } as never);
  await finishTurn($);
  await clock.advance(3 * HOUR);
  expect(switchRuns(seen.runs)).toEqual([]);
  expect(seen.prompts).toEqual([]);
  expect(eventsOf(files, "limit")).toEqual([]);
  expect(eventsOf(files, "stop-failure")).toEqual([
    expect.objectContaining({ error: "rate_limit", agentId: "a1" }),
  ]);
});

test("a limit with every account out waits for the first account to recover, switches to it, records the switch and resumes", async ($, on) => {
  const { seen, clock, files } = cswapWorld(on, {
    1: { pct: 100, resetsIn: 3 * HOUR },
    2: { pct: 99, resetsIn: HOUR },
  });
  await $.session.start(START);
  await clock.settle();
  await $.classic.StopFailure({ error: "rate_limit" } as never);
  expect(seen.statuses.at(-1)).toContain(
    "switches to account 2 and resumes at 13:00 UTC",
  );
  await clock.advance(30 * MINUTE);
  expect(switchRuns(seen.runs)).toEqual([]);
  await clock.advance(32 * MINUTE);
  expect(switchRuns(seen.runs)).toEqual([["cswap", "switch", "2", "--json"]]);
  expect(recorded(files)).toEqual({
    plan: expect.objectContaining({
      reason: "recovered",
      from: 1,
      to: 2,
      switchedAt: NOW + HOUR,
      left: [{ account: 1, until: NOW + 3 * HOUR }],
    }),
    lastSwitch: NOW + HOUR,
  });
  expect(
    seen.prompts.filter((p) => p.includes("switched to account 2")),
  ).toHaveLength(1);
  await clock.advance(HOUR);
  expect(seen.prompts).toHaveLength(1);
});

test("a session resumed by hand after a limit gets no resume prompt", async ($, on) => {
  const { seen, clock } = cswapWorld(on, {
    1: { pct: 100, resetsIn: 3 * HOUR },
    2: { pct: 99, resetsIn: HOUR },
  });
  await $.session.start(START);
  await clock.settle();
  await $.classic.StopFailure({ error: "rate_limit" } as never);
  await clock.advance(10 * MINUTE);
  await startTurn($);
  await finishTurn($);
  await clock.advance(HOUR);
  expect(seen.prompts).toEqual([]);
});

test("autoContinueAtUsageLimit false switches at a limit but does not resume", async ($, on) => {
  const five = {
    1: { pct: 50, resetsIn: 3 * HOUR },
    2: { pct: 10, resetsIn: 3 * HOUR },
  };
  const { seen, clock } = cswapWorld(on, five, {
    settings: { autoContinueAtUsageLimit: false },
  });
  await $.session.start(START);
  await clock.settle();
  five[1].pct = 100;
  await $.classic.StopFailure({ error: "rate_limit" } as never);
  await clock.advance(2 * MINUTE);
  expect(switchRuns(seen.runs).length).toBeGreaterThan(0);
  expect(seen.prompts).toEqual([]);
});

test("a session in another profile runs no cswap command and writes no switch record", async ($, on) => {
  const { seen, clock } = cswapWorld(
    on,
    { 1: { pct: 99, resetsIn: 3 * HOUR }, 2: { pct: 10, resetsIn: 3 * HOUR } },
    { env: { CLAUDE_CONFIG_DIR: "/tmp/prof" } },
  );
  await $.session.start(START);
  await clock.advance(10 * MINUTE);
  await $.classic.StopFailure({ error: "rate_limit" } as never);
  expect(seen.spawned.filter((argv) => argv.includes("cswap"))).toEqual([]);
  expect(
    seen.writes.filter((path) => path.startsWith(`${SWITCH_DIR}/`)),
  ).toEqual([]);
});

test("every cswap run, at session start and in /add-account, drops the profile variables", async ($, on) => {
  const { seen, clock } = cswapWorld(
    on,
    { 1: { pct: 10, resetsIn: 3 * HOUR }, 2: { pct: 10, resetsIn: 3 * HOUR } },
    { env: { CLAUDE_CONFIG_DIR: `${HOME}/.claude/` } },
  );
  await $.session.start(START);
  await clock.settle();
  await $.command.run({ command: "add-account" } as never);
  const runs = seen.spawned.filter((argv) => argv.includes("cswap"));
  expect(runs.map((argv) => argv[6])).toEqual(
    expect.arrayContaining(["list", "--version", "add"]),
  );
  expect(
    runs.every(
      (argv) =>
        argv.slice(0, 5).join(" ") ===
        "env -u CLAUDE_CONFIG_DIR -u CLAUDE_SECURESTORAGE_CONFIG_DIR",
    ),
  ).toBe(true);
});

test("a setup problem shows in the status line and sends one notification", async ($, on) => {
  const { seen, clock } = world(on, {
    run: (argv) =>
      argv[0] === "cswap" && argv[1] === "list"
        ? {
            exitCode: 0,
            stdout: JSON.stringify({
              accounts: [
                { number: 1, email: "a@x", active: true, usageStatus: "ok" },
                { number: 2, email: "b@x", usageStatus: "token_expired" },
              ],
            }),
          }
        : undefined,
  });
  await $.session.start(START);
  await clock.advance(11 * MINUTE);
  // The status line draws one line: it holds the problems themselves.
  expect(seen.statuses.at(-1)).toContain(
    "cswap account 2 (b@x) needs a new login (token expired)",
  );
  expect(seen.notifications[0]).toContain("runway cannot use all of them");
  expect(seen.notifications).toHaveLength(1);
});

test("a login that cswap's active account holds leaves switching as it is", async ($, on) => {
  const { seen, clock } = cswapWorld(
    on,
    { 1: { pct: 99, resetsIn: 3 * HOUR }, 2: { pct: 10, resetsIn: 3 * HOUR } },
    { files: loggedIn("1@example.com") },
  );
  await $.session.start(START);
  await clock.settle();
  expect(switchRuns(seen.runs)).toEqual([["cswap", "switch", "2", "--json"]]);
  expect(seen.runs).not.toContainEqual(["cswap", "add"]);
});

test("a login that no cswap account holds stops switching, and Claude offers /add-account once", async ($, on) => {
  const { seen, clock } = cswapWorld(
    on,
    { 1: { pct: 99, resetsIn: 3 * HOUR }, 2: { pct: 10, resetsIn: 3 * HOUR } },
    { files: loggedIn("new@example.com") },
  );
  on("tool.call", async () => ({ result: "ok" }));
  await $.session.start(START);
  await clock.advance(11 * MINUTE);
  expect(switchRuns(seen.runs)).toEqual([]);
  expect(seen.runs).not.toContainEqual(["cswap", "add"]);
  expect(seen.statuses.at(-1)).toContain("run /add-account");
  const context = await contextOf($);
  expect(context).toContain("new@example.com");
  expect(context).toContain("offer that they run /add-account");
  await clock.advance(11 * MINUTE);
  expect(await contextOf($)).toBe("");
});

test("a login to a cswap account that is not active gets `cswap add`, and switching goes on", async ($, on) => {
  const { seen, clock, list } = cswapWorld(
    on,
    { 1: { pct: 99, resetsIn: 3 * HOUR }, 2: { pct: 10, resetsIn: 3 * HOUR } },
    {
      files: loggedIn("2@example.com"),
      run: (argv) => {
        if (argv[0] !== "cswap" || argv[1] !== "add") return undefined;
        list.active = 2;
        return { exitCode: 0 };
      },
    },
  );
  await $.session.start(START);
  await clock.settle();
  expect(seen.runs).toContainEqual(["cswap", "add"]);
  expect(seen.toasts).toContain(
    "runway stored the new login of cswap account 2.",
  );
  // Account 2 is active and has room, so nothing calls for a switch.
  expect(switchRuns(seen.runs)).toEqual([]);
  expect(seen.notifications).toEqual([]);
});

test("a `cswap add` that fails holds switching, notifies, and is not tried again for the same login", async ($, on) => {
  const { seen, clock } = cswapWorld(
    on,
    { 1: { pct: 99, resetsIn: 3 * HOUR }, 2: { pct: 10, resetsIn: 3 * HOUR } },
    {
      files: loggedIn("2@example.com"),
      run: (argv) =>
        argv[0] === "cswap" && argv[1] === "add"
          ? { exitCode: 1, stderr: "credential drift" }
          : undefined,
    },
  );
  await $.session.start(START);
  await clock.advance(16 * MINUTE);
  expect(seen.runs.filter((a) => a[1] === "add")).toHaveLength(1);
  expect(switchRuns(seen.runs)).toEqual([]);
  expect(seen.notifications).toEqual([
    expect.stringContaining("credential drift"),
  ]);
});

test("a setup problem leaves the status line once its cause goes, as when the account is disabled", async ($, on) => {
  const second = { disabled: false };
  const { seen, clock } = world(on, {
    run: (argv) =>
      argv[0] === "cswap" && argv[1] === "list"
        ? {
            exitCode: 0,
            stdout: JSON.stringify({
              accounts: [
                { number: 1, email: "a@x", active: true, usageStatus: "ok" },
                { number: 2, email: "b@x", usageStatus: "ok" },
                {
                  number: 3,
                  email: "c@x",
                  usageStatus: "relogin_required",
                  ...(second.disabled ? { disabled: true } : {}),
                },
              ],
            }),
          }
        : undefined,
  });
  await $.session.start(START);
  await clock.advance(MINUTE);
  expect(seen.statuses.at(-1)).toContain("`cswap disable 3`");
  second.disabled = true;
  await clock.advance(6 * MINUTE);
  expect(seen.statuses.at(-1)).toBeUndefined();
});

test("a failed switch shows until a cswap command succeeds, and the notice it covered comes back", async ($, on) => {
  const state = { failing: true, active: 1 };
  const { seen, clock } = world(on, {
    run: (argv) => {
      if (argv[0] !== "cswap") return undefined;
      if (argv[1] === "switch") {
        if (state.failing) return { exitCode: 1, stderr: "lock held" };
        state.active = Number(argv[2]);
        return { exitCode: 0 };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          accounts: [
            {
              number: 1,
              email: "a@x",
              active: state.active === 1,
              usageStatus: "ok",
              usage: {
                sevenDay: {
                  pct: 99,
                  resetsAt: new Date(NOW + DAY).toISOString(),
                },
              },
            },
            {
              number: 2,
              email: "b@x",
              active: state.active === 2,
              usageStatus: "ok",
            },
            { number: 3, email: "c@x", usageStatus: "relogin_required" },
          ],
        }),
      };
    },
  });
  await $.session.start(START);
  await clock.settle();
  expect(seen.statuses.at(-1)).toContain("`cswap switch 2` failed");
  state.failing = false;
  await clock.advance(6 * MINUTE);
  // The switch went through: the setup problem it covered shows again.
  expect(state.active).toBe(2);
  expect(seen.statuses.at(-1)).toContain("`cswap disable 3`");
});

test("/add-account adds the logged-in subscription with cswap and says what that allows", async ($, on) => {
  const { seen, clock } = cswapWorld(on, {
    1: { pct: 10, resetsIn: 3 * HOUR },
    2: { pct: 10, resetsIn: 3 * HOUR },
  });
  await $.session.start(START);
  await clock.settle();
  const { text } = (await $.command.run({
    command: "add-account",
  } as never)) as { text: string };
  expect(seen.runs).toContainEqual(["cswap", "add"]);
  expect(text).toBe(
    "Added the logged-in subscription to claude-swap, which now manages 2 usable accounts.\nRunway switches to another subscription before a limit stops the session.",
  );
});

test("turn starts and ends within a tick of the last switch check read no session records", async ($, on) => {
  const { seen, clock } = cswapWorld(on, {
    1: { pct: 10, resetsIn: 3 * HOUR },
    2: { pct: 10, resetsIn: 3 * HOUR },
  });
  await $.session.start(START);
  await clock.settle();
  const before = seen.lists.length;
  expect(before).toBeGreaterThan(0);
  for (let k = 0; k < 5; k++) {
    await $.turn.start({ turnId: "t", agentId: `a${k}` } as never);
    await startTurn($);
    await finishTurn($);
  }
  await clock.settle();
  expect(seen.lists.length).toBe(before);
  await clock.advance(30_000);
  expect(seen.lists.length).toBeGreaterThan(before);
});

// ---- Resuming after a limit without a switch ----

const respond = async ($: Parameters<TestBody>[0]) => {
  for await (const _ of $.turn.step({
    turnId: "t",
    index: 0,
    model: "claude-opus-5-5",
    messageCount: 1,
  }));
};
const outFor = (hours: number): SessionRateLimit[] => [
  {
    kind: "five_hour",
    percentUsed: 100,
    resetsAt: new Date(NOW + hours * HOUR).toISOString(),
  },
  {
    kind: "seven_day",
    percentUsed: 40,
    resetsAt: new Date(NOW + 4 * DAY).toISOString(),
  },
];
const cleared = (prompts: string[]) =>
  prompts.filter((p) => p.includes("has cleared"));

test("without another account, runway resumes the session a little after the reset when auto-continue does not", async ($, on) => {
  const { seen, clock, files } = world(on, { rateLimits: outFor(1) });
  await $.session.start(START);
  await startTurn($);
  await respond($);
  await $.classic.StopFailure({ error: "rate_limit" } as never);
  await finishTurn($);
  expect(seen.statuses.at(-1)).toContain("it resumes at 13:00 UTC");
  await clock.advance(HOUR + MINUTE);
  expect(seen.prompts).toEqual([]);
  await clock.advance(2 * MINUTE);
  expect(cleared(seen.prompts)).toEqual([
    expect.stringContaining("interrupted work at 12:00 UTC has cleared"),
  ]);
  expect(seen.statuses.at(-1)).toBeUndefined();
  expect(eventsOf(files, "resume")).toHaveLength(1);
});

test("a session that auto-continue resumed at the reset gets no resume prompt from runway", async ($, on) => {
  const { seen, clock } = world(on, { rateLimits: outFor(1) });
  await $.session.start(START);
  await startTurn($);
  await respond($);
  await $.classic.StopFailure({ error: "rate_limit" } as never);
  await finishTurn($);
  await clock.advance(HOUR);
  await startTurn($);
  await finishTurn($);
  await clock.advance(HOUR);
  expect(seen.prompts).toEqual([]);
});

test("without a known reset, runway retries after ten minutes, then waits twice as long after each failed retry", async ($, on) => {
  const { seen, clock } = world(on, { rateLimits: steady });
  await $.session.start(START);
  await startTurn($);
  await $.classic.StopFailure({ error: "rate_limit" } as never);
  await finishTurn($);
  expect(seen.statuses.at(-1)).toContain("tries to resume it at 12:10 UTC");
  await clock.advance(11 * MINUTE);
  expect(cleared(seen.prompts)).toHaveLength(1);
  // The retry hits the limit again.
  await startTurn($);
  await $.classic.StopFailure({ error: "rate_limit" } as never);
  await finishTurn($, false);
  await clock.advance(11 * MINUTE);
  expect(cleared(seen.prompts)).toHaveLength(1);
  await clock.advance(10 * MINUTE);
  expect(cleared(seen.prompts)).toHaveLength(2);
});

test("a turn that ends in an error while a window shows exhausted counts as a limit without a StopFailure", async ($, on) => {
  const { seen, clock } = world(on, { rateLimits: outFor(1) });
  await $.session.start(START);
  await startTurn($);
  await respond($);
  await $.turn.complete({
    reason: "error",
    answer: "",
    durationMs: 1,
    turnId: "t",
    isAborted: false,
  } as never);
  await clock.advance(HOUR + 3 * MINUTE);
  expect(cleared(seen.prompts)).toHaveLength(1);
});

test("autoContinueAtUsageLimit false leaves the session stopped after the reset", async ($, on) => {
  const { seen, clock } = world(on, {
    rateLimits: outFor(1),
    settings: { autoContinueAtUsageLimit: false },
  });
  await $.session.start(START);
  await startTurn($);
  await respond($);
  await $.classic.StopFailure({ error: "rate_limit" } as never);
  await finishTurn($);
  await clock.advance(2 * HOUR);
  expect(seen.prompts).toEqual([]);
  expect(seen.statuses.at(-1)).toContain("autoContinueAtUsageLimit is off");
});

test("with cswap, a limit on the account that recovers first is resumed early once cswap reports it cleared", async ($, on) => {
  const five = {
    1: { pct: 50, resetsIn: 3 * HOUR },
    2: { pct: 100, resetsIn: 5 * HOUR },
  };
  const { seen, clock } = cswapWorld(on, five, { rateLimits: steady });
  await $.session.start(START);
  await clock.settle();
  five[1].pct = 100;
  await startTurn($);
  await $.classic.StopFailure({ error: "rate_limit" } as never);
  await finishTurn($);
  expect(seen.statuses.at(-1)).toContain("it resumes at 15:00 UTC");
  await clock.advance(9 * MINUTE);
  five[1].pct = 60;
  await clock.advance(10 * MINUTE);
  expect(cleared(seen.prompts)).toHaveLength(1);
  expect(switchRuns(seen.runs)).toEqual([]);
});

// ---- Proactive switching ----

// Accounts with weekly and optional Fable windows; `fiveHour` absent as on Ultra.
type Plan = Record<
  number,
  { seven: number; resetsIn: number; fable?: number; fableResetsIn?: number }
>;
const richList = (active: number, plan: Plan) =>
  JSON.stringify({
    accounts: Object.entries(plan).map(([n, a]) => ({
      number: Number(n),
      email: `${n}@example.com`,
      active: Number(n) === active,
      usageStatus: "ok",
      usage: {
        sevenDay: {
          pct: a.seven,
          resetsAt: new Date(NOW + a.resetsIn).toISOString(),
        },
        ...(a.fable === undefined
          ? {}
          : {
              scoped: [
                {
                  name: "Fable",
                  pct: a.fable,
                  resetsAt: new Date(
                    NOW + (a.fableResetsIn ?? a.resetsIn),
                  ).toISOString(),
                },
              ],
            }),
      },
      usageFetchedAt: new Date(NOW).toISOString(),
    })),
  });

function richWorld(on: On, plan: Plan, setup: Setup = {}) {
  const list = { active: 1 };
  const w = world(on, {
    rateLimits: [
      {
        kind: "seven_day",
        percentUsed: plan[1].seven,
        resetsAt: new Date(NOW + plan[1].resetsIn).toISOString(),
      },
    ],
    ...setup,
    run: (argv) => {
      if (argv[0] !== "cswap") return undefined;
      if (argv[1] === "switch" && /^\d+$/.test(argv[2]))
        list.active = Number(argv[2]);
      return {
        exitCode: 0,
        stdout: argv[1] === "list" ? richList(list.active, plan) : "",
      };
    },
  });
  return { ...w, list };
}

test("while no window is near its limit, runway switches to the account whose week resets sooner", async ($, on) => {
  const { clock, files, seen } = richWorld(on, {
    1: { seven: 30, resetsIn: 4 * DAY },
    2: { seven: 10, resetsIn: 2 * DAY },
  });
  await $.session.start(START);
  await clock.settle();
  expect(switchRuns(seen.runs)).toEqual([["cswap", "switch", "2", "--json"]]);
  expect(seen.runs.filter((argv) => argv[1] === "auto")).toEqual([]);
  expect(eventsOf(files, "switch-done")).toEqual([
    expect.objectContaining({ from: 1, to: 2, reason: "soonest-reset" }),
  ]);
});

const fableStep = async ($: Parameters<TestBody>[0], agentId?: string) => {
  for await (const _ of $.turn.step({
    turnId: "t",
    index: 0,
    model: "claude-fable-5-1",
    messageCount: 1,
    ...(agentId ? { agentId } : {}),
  }));
};

test("a subagent's request that hits a full Fable window switches to an account with Fable room and tells the session to retry", async ($, on) => {
  const { clock, files, seen } = richWorld(on, {
    1: { seven: 60, resetsIn: 1 * DAY, fable: 100 },
    2: { seven: 70, resetsIn: 2 * DAY, fable: 100 },
    3: { seven: 20, resetsIn: 3 * DAY, fable: 10 },
  });
  on("tool.call", async () => ({ result: "ok" }));
  await $.session.start(START);
  await clock.settle();
  // A full Fable window that nobody uses moves nothing.
  expect(switchRuns(seen.runs)).toEqual([]);
  const before = switchRuns(seen.runs).length;
  await startTurn($);
  await clock.settle();
  await fableStep($, "a1");
  await fableStep($, "a2");
  await clock.advance(10_000);
  await $.classic.StopFailure({ error: "rate_limit", agent_id: "a1" } as never);
  expect(switchRuns(seen.runs).slice(before)).toEqual([
    ["cswap", "switch", "3", "--json"],
  ]);
  expect(await contextOf($)).toContain(
    "[runway] A claude-fable-5-1 request from a subagent hit account 1's Fable limit. Runway switched every session to account 3, which has Fable room; retry the Fable work.",
  );
  expect(eventsOf(files, "scoped-limit")).toEqual([
    expect.objectContaining({
      scope: "Fable",
      from: 1,
      to: 3,
      outcome: "switched",
    }),
  ]);
  expect(recorded(files)).toEqual({
    plan: expect.objectContaining({
      reason: "limit:Fable",
      from: 1,
      to: 3,
      left: [{ account: 1, until: NOW + DAY }],
    }),
    lastSwitch: NOW + 10_000,
  });
  // A request that started before the switch hit the account it left: retry, no new switch.
  await $.classic.StopFailure({ error: "rate_limit", agent_id: "a2" } as never);
  expect(await contextOf($)).toContain(
    "but it started before runway switched accounts 0m ago; retry the Fable work.",
  );
  // A request that started after the switch hit the new account's limit, however soon.
  await fableStep($, "a3");
  await $.classic.StopFailure({ error: "rate_limit", agent_id: "a3" } as never);
  expect(await contextOf($)).toContain(
    "hit account 3's Fable limit. No other account has room",
  );
  // Fable is in use, so the coordinator does not move back to an account whose Fable is full.
  await clock.advance(5 * MINUTE);
  expect(switchRuns(seen.runs).slice(before)).toHaveLength(1);
});

test("a subagent's Fable limit with no account that has Fable room names the first reset and does not switch", async ($, on) => {
  const { clock, seen } = richWorld(on, {
    1: { seven: 60, resetsIn: 2 * DAY, fable: 100 },
    2: { seven: 60, resetsIn: 2 * DAY, fable: 100, fableResetsIn: 5 * HOUR },
  });
  on("tool.call", async () => ({ result: "ok" }));
  await $.session.start(START);
  await clock.settle();
  await startTurn($);
  await fableStep($, "a1");
  await $.classic.StopFailure({ error: "rate_limit", agent_id: "a1" } as never);
  expect(switchRuns(seen.runs)).toEqual([]);
  expect(await contextOf($)).toContain(
    "No other account has room in its Fable and all-models windows, so runway did not switch. The first Fable window to reset is account 2's, at 17:00 UTC.",
  );
});

test("a subagent's limit on an exhausted weekly window is left to the main turn", async ($, on) => {
  const { clock, seen } = richWorld(on, {
    1: { seven: 100, resetsIn: 2 * DAY, fable: 100 },
    2: { seven: 10, resetsIn: 3 * DAY, fable: 10 },
  });
  await $.session.start(START);
  await clock.settle();
  const before = switchRuns(seen.runs).length;
  await startTurn($);
  await fableStep($, "a1");
  await $.classic.StopFailure({ error: "rate_limit", agent_id: "a1" } as never);
  expect(switchRuns(seen.runs).length).toBe(before);
});

test("a main turn on Fable that hits its Fable limit switches to an account with Fable room, records the switch and resumes", async ($, on) => {
  const { clock, seen, files } = richWorld(on, {
    1: { seven: 60, resetsIn: 1 * DAY, fable: 100 },
    2: { seven: 10, resetsIn: 3 * DAY, fable: 100 },
    3: { seven: 50, resetsIn: 3 * DAY, fable: 10 },
  });
  await $.session.start(START);
  await clock.settle();
  await startTurn($);
  await fableStep($);
  await $.classic.StopFailure({ error: "rate_limit" } as never);
  await finishTurn($);
  expect(switchRuns(seen.runs)).toEqual([["cswap", "switch", "3", "--json"]]);
  expect(recorded(files)).toEqual({
    plan: expect.objectContaining({
      reason: "limit:Fable",
      from: 1,
      to: 3,
      switchedAt: NOW,
      left: [{ account: 1, until: NOW + DAY }],
    }),
    lastSwitch: NOW,
  });
  await clock.advance(2 * MINUTE);
  expect(
    seen.prompts.filter((p) => p.includes("switched to account 3")),
  ).toHaveLength(1);
});

// ---- What tidy reads ----

test("every switch writes its time to last-switch.json, which tidy reads", async ($, on) => {
  const five = {
    1: { pct: 50, resetsIn: 3 * HOUR },
    2: { pct: 10, resetsIn: 3 * HOUR },
  };
  const { clock, files } = cswapWorld(on, five);
  await $.session.start(START);
  await clock.settle();
  expect(files.has(LAST_SWITCH)).toBe(false);
  five[1].pct = 100;
  await $.classic.StopFailure({ error: "rate_limit" } as never);
  expect(JSON.parse(files.get(LAST_SWITCH)!.text)).toEqual({
    switchedAt: NOW,
    sessionId: ID,
  });
});

// ---- Usage readings ----

const weekly = (pct: number): SessionRateLimit[] => [
  {
    kind: "seven_day",
    percentUsed: pct,
    resetsAt: new Date(NOW + 4 * DAY).toISOString(),
  },
];

test("an idle session's old headers give way to cswap's newer reading", async ($, on) => {
  const clockOf: { now?: () => number } = {};
  const listed = (n: number, active: boolean, pct: number) => ({
    number: n,
    email: `${n}@example.com`,
    active,
    usageStatus: "ok",
    usage: {
      sevenDay: { pct, resetsAt: new Date(NOW + 4 * DAY).toISOString() },
    },
    usageFetchedAt: new Date(clockOf.now!() - MINUTE).toISOString(),
  });
  const w = world(on, {
    rateLimits: weekly(53),
    contextTokens: 400_000,
    run: (argv) =>
      argv[0] === "cswap" && argv[1] === "list"
        ? {
            exitCode: 0,
            stdout: JSON.stringify({
              accounts: [listed(1, true, 96), listed(2, false, 97)],
            }),
          }
        : argv[0] === "cswap"
          ? { exitCode: 0, stdout: "" }
          : undefined,
  });
  clockOf.now = () => w.clock.now();
  on("tool.call", async () => ({ result: "ok" }));
  await $.session.start(START);
  await startTurn($);
  for await (const _ of $.turn.step({
    turnId: "t",
    index: 0,
    model: "claude-opus-5-5",
    messageCount: 1,
  }));
  await finishTurn($);
  await w.clock.advance(HOUR);
  await w.clock.advance(HOUR);
  await $.session.measure(usage(weekly(53), 400_000));
  const context = await contextOf($);
  expect(context).toContain("- weekly, all models: 96% used, ");
  expect(context).toContain("from cswap list, 1m old");
});

test("a reading that does not change its time adds no burn samples", async ($, on) => {
  const { clock, store } = cswapWorld(on, {
    1: { pct: 10, resetsIn: 3 * HOUR },
    2: { pct: 10, resetsIn: 3 * HOUR },
  });
  await $.session.start(START);
  await startTurn($);
  for await (const _ of $.turn.step({
    turnId: "t",
    index: 0,
    model: "claude-opus-5-5",
    messageCount: 1,
  }));
  await finishTurn($);
  await clock.advance(HOUR);
  const samples = store.get("samples") as { at: number }[];
  expect(samples.map((x) => x.at)).toEqual([NOW]);
});

test("a near-limit switch records the account it left, and a third switch within an hour warns", async ($, on) => {
  const earlier = {
    id: "p0",
    from: 2,
    to: 1,
    reason: "near-limit",
    createdAt: NOW - 20 * MINUTE,
    switchedAt: NOW - 20 * MINUTE,
    recentSwitches: [NOW - 40 * MINUTE],
  };
  const { seen, clock, files } = cswapWorld(
    on,
    { 1: { pct: 99, resetsIn: 3 * HOUR }, 2: { pct: 10, resetsIn: 3 * HOUR } },
    { files: { [PLAN]: { text: JSON.stringify(earlier) } } },
  );
  await $.session.start(START);
  await clock.settle();
  expect(switchRuns(seen.runs)).toEqual([["cswap", "switch", "2", "--json"]]);
  expect(JSON.parse(files.get(PLAN)!.text)).toEqual(
    expect.objectContaining({
      from: 1,
      to: 2,
      left: [{ account: 1, until: NOW + 3 * HOUR }],
      recentSwitches: [NOW - 40 * MINUTE, NOW - 20 * MINUTE],
    }),
  );
  expect(seen.notifications).toEqual([
    expect.stringContaining("switched accounts 2 times in the last hour"),
  ]);
});

test("a switch at a limit counts toward the warning about repeated switches", async ($, on) => {
  const earlier = {
    id: "p0",
    from: 2,
    to: 1,
    reason: "near-limit",
    createdAt: NOW - 30 * MINUTE,
    switchedAt: NOW - 30 * MINUTE,
  };
  const five = {
    1: { pct: 50, resetsIn: 3 * HOUR },
    2: { pct: 10, resetsIn: 3 * HOUR },
    3: { pct: 10, resetsIn: 3 * HOUR },
  };
  const { seen, clock, files } = cswapWorld(on, five, {
    files: { [PLAN]: { text: JSON.stringify(earlier) } },
  });
  await $.session.start(START);
  await clock.settle();
  five[1].pct = 100;
  await $.classic.StopFailure({ error: "rate_limit" } as never);
  expect(recorded(files).plan).toEqual(
    expect.objectContaining({
      reason: "limit",
      to: 2,
      recentSwitches: [NOW - 30 * MINUTE],
    }),
  );
  // The next listing, five minutes on, shows account 2 near its limit.
  five[2].pct = 99;
  await clock.advance(5 * MINUTE);
  expect(switchRuns(seen.runs)).toEqual([
    ["cswap", "switch", "2", "--json"],
    ["cswap", "switch", "3", "--json"],
  ]);
  expect(seen.notifications).toEqual([
    expect.stringContaining("switched accounts 2 times in the last hour"),
  ]);
});

test("another session's switch at a limit holds this session's optional switch for an hour", async ($, on) => {
  const theirs = {
    id: "p1",
    from: 2,
    to: 1,
    reason: "limit",
    createdAt: NOW - 10 * MINUTE,
    switchedAt: NOW - 10 * MINUTE,
  };
  const { clock, seen } = richWorld(
    on,
    {
      1: { seven: 30, resetsIn: 4 * DAY },
      2: { seven: 10, resetsIn: 2 * DAY },
    },
    { files: { [PLAN]: { text: JSON.stringify(theirs) } } },
  );
  await $.session.start(START);
  await clock.settle();
  await clock.advance(30 * MINUTE);
  expect(switchRuns(seen.runs)).toEqual([]);
  await clock.advance(30 * MINUTE);
  expect(switchRuns(seen.runs)).toEqual([["cswap", "switch", "2", "--json"]]);
});
