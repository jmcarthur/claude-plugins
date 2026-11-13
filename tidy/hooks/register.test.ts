import type { On, SessionRateLimit } from "claude-code";
import { expect, mock, test, type TestBody } from "claude-code/testing";
import { HOUR, MINUTE } from "./time";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const HOME = "/home/u";
const ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const DAY = 24 * HOUR;
const START = {
  cwd: "/work/project",
  surface: "terminal",
  isInteractive: true,
} as const;
// Runway's switch files, which tidy reads.
const LAST_SWITCH = `${HOME}/.claude/runway/switch/last-switch.json`;

type Setup = {
  stopBlock?: string;
  rateLimits?: SessionRateLimit[];
  contextTokens?: number;
  // The prompt size each main request reports, as cache reads.
  promptTokens?: number;
  files?: Record<string, { text?: string }>;
  settings?: Record<string, unknown>;
  env?: Record<string, string>;
};

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
  mock.env(on, { HOME, ...setup.env });
  const files = new Map(
    Object.entries(setup.files ?? {}).map(([path, f]) => [
      path,
      { text: f.text ?? "", mtimeMs: NOW },
    ]),
  );
  const seen = {
    toasts: [] as string[],
    prompts: [] as string[],
    compactions: [] as (string | undefined)[],
    forks: [] as string[],
  };
  const missing = (path: string) => ({ deny: `ENOENT: ${path}` });
  on("session.start", async ($, e) => ({ cwd: e.cwd }));
  on("session.id", async () => ({ value: ID }));
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
  on("tool.register", async ($, e) => ({ value: { tool: e.name } }) as never);
  on("ui.toast", async ($, e) => {
    seen.toasts.push(e.text);
    return { value: undefined };
  });
  on("prompt.submit", async ($, e) => {
    seen.prompts.push(e.text);
    return { text: e.text };
  });
  on("fs.read", async ($, e) =>
    files.has(e.path) ? { value: files.get(e.path)!.text } : missing(e.path),
  );
  on("fs.exists", async ($, e) => ({ value: files.has(e.path) }));
  on("fs.write", async ($, e) => {
    files.set(e.path, { text: e.text, mtimeMs: clock.now() });
    return { value: undefined };
  });
  on("process.run", async ($, e) => {
    if (e.argv[0] === "sh")
      appendLog(files, e.argv, e.init?.stdin ?? "", clock.now());
    return {
      value: {
        exitCode: e.argv[0] === "sh" ? 0 : 127,
        stdout: "",
        stderr: "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });
  on("classic.StopFailure", async () => ({}) as never);
  on(
    "classic.Stop",
    async () =>
      (setup.stopBlock === undefined
        ? {}
        : { block: setup.stopBlock }) as never,
  );
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
        cache_read_input_tokens: setup.promptTokens ?? 0,
        cache_creation_input_tokens: 0,
      },
    };
  });
  on("session.compact", async ($, e) => {
    seen.compactions.push(e.instructions);
    return { messages: [{ role: "user", text: "summary", toolUses: [] }] };
  });
  on("model.fork", async ($, e) => {
    seen.forks.push(e.prompt);
    return {
      value: {
        isAnswered: true,
        text: "ok",
        usage: {
          model: "claude-opus-5-5",
          input_tokens: 10,
          output_tokens: 1,
          cache_read_input_tokens: setup.promptTokens ?? 0,
          cache_creation_input_tokens: 0,
        },
      },
    } as never;
  });
  return { clock, files, seen };
}

const eventsOf = (files: Map<string, { text: string }>, name: string) =>
  (files.get(`${HOME}/.claude/tidy/${ID}.jsonl`)?.text ?? "")
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
const STOP = { stop_hook_active: false } as never;
const STOP_AGAIN = { stop_hook_active: true } as never;

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

test(
  "settings out of range fall back to their defaults and are reported at session start",
  { options: { keepaliveBudget: -5 } },
  async ($, on) => {
    const { seen, files, clock } = world(on);
    await $.session.start(START);
    await clock.settle();
    expect(seen.toasts).toEqual([
      "tidy: keepaliveBudget -5 must be a number at least 0; using 1",
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

// ---- Compaction ----

test("a compact call schedules the compaction for the end of the turn, and the resume prompt follows it", async ($, on) => {
  const { seen, clock } = world(on);
  await $.session.start(START);
  await startTurn($);
  expect(
    String(
      (
        await $.tool.call({
          tool: "mcp__tidy__compact",
          focus: "next steps",
          resume: "Continue from NOTES.md",
        })
      ).result,
    ),
  ).toContain("scheduled");
  expect(seen.compactions).toEqual([]);
  await finishTurn($);
  await clock.advance(1000);
  expect(seen.compactions).toEqual(["next steps"]);
  expect(seen.prompts).toEqual(["Continue from NOTES.md"]);
});

test("a subagent cannot compact the session", async ($, on) => {
  world(on);
  await $.session.start(START);
  expect(
    String(
      (
        await $.tool.call({
          tool: "mcp__tidy__compact",
          agentId: "a1",
        } as never)
      ).result,
    ),
  ).toContain("Only the main session");
});

test("an interrupted turn drops the scheduled compaction", async ($, on) => {
  const { seen, clock } = world(on);
  on("tool.call", async () => ({ result: "ok" }));
  await $.session.start(START);
  await startTurn($);
  await $.tool.call({ tool: "mcp__tidy__compact" });
  await finishTurn($, true);
  await clock.advance(1000);
  expect(seen.compactions).toEqual([]);
  expect(await contextOf($)).toContain("scheduled compaction was dropped");
});

const GOAL_NOT_MET = "The goal is not met: two tests still fail.";

test("a Stop hook that continues the turn after a compact call ends it instead, and its reason follows the compaction", async ($, on) => {
  const { seen, clock } = world(on, { stopBlock: GOAL_NOT_MET });
  await $.session.start(START);
  await $.tool.call({ tool: "mcp__tidy__compact", focus: "next steps" });
  expect((await $.classic.Stop(STOP)).block).toBeUndefined();
  await finishTurn($);
  await clock.advance(1000);
  expect(seen.prompts).toEqual([expect.stringContaining(GOAL_NOT_MET)]);
});

test("the held reason follows the compaction's resume prompt", async ($, on) => {
  const { seen, clock } = world(on, { stopBlock: GOAL_NOT_MET });
  await $.session.start(START);
  await $.tool.call({
    tool: "mcp__tidy__compact",
    resume: "Continue from NOTES.md",
  });
  await $.classic.Stop(STOP);
  await finishTurn($);
  await clock.advance(1000);
  expect(seen.prompts).toEqual([
    expect.stringMatching(/^Continue from NOTES\.md\n\n.*The goal is not met/s),
  ]);
});

test("a Stop hook continues the turn as usual when no compaction is scheduled", async ($, on) => {
  world(on, { stopBlock: GOAL_NOT_MET });
  await $.session.start(START);
  expect((await $.classic.Stop(STOP)).block).toBe(GOAL_NOT_MET);
});

function turnEndWorld(on: On, setup: Setup = {}) {
  const w = world(on, { contextTokens: 300_000, ...setup });
  on("tool.call", async () => ({ result: "ok" }) as never);
  return w;
}

test("a recorded boundary gives the compaction advice once, as a block at the end of the turn, not mid-turn", async ($, on) => {
  const { files, clock } = turnEndWorld(on);
  await $.session.start(START);
  await startTurn($);
  expect(
    String(
      (await $.tool.call({ tool: "Bash", command: "git commit -am 'x'" }))
        .context ?? "",
    ),
  ).not.toContain("compaction");
  expect((await $.classic.Stop(STOP)).block).toMatch(
    /compaction point: work was just recorded, and the context is 300k tokens.*say in one line why not/,
  );
  expect((await $.classic.Stop(STOP_AGAIN)).block).toBeUndefined();
  await finishTurn($);
  await clock.advance(MINUTE);
  await startTurn($);
  expect((await $.classic.Stop(STOP)).block).toBeUndefined();
  expect(eventsOf(files, "compaction-prompt")).toEqual([
    expect.objectContaining({ context: 300_000 }),
  ]);
});

const waitingOn = (...ids: string[]) =>
  ({
    stop_hook_active: false,
    background_tasks: ids.map((id) => ({
      id,
      type: id.startsWith("m") ? "monitor" : "subagent",
      status: "running",
      description: id,
    })),
  }) as never;

test("a turn that ends waiting on a default-background agent gives the compaction advice, at most once every 30 minutes", async ($, on) => {
  const { files, clock } = turnEndWorld(on);
  await $.session.start(START);
  await startTurn($);
  await $.tool.call({ tool: "Agent", prompt: "build", description: "build" });
  expect((await $.classic.Stop(waitingOn("a"))).block).toMatch(
    /compaction point: the turn ends with background work in flight \(1 subagent\)/,
  );
  await finishTurn($);
  await clock.advance(10 * MINUTE);
  await startTurn($);
  expect((await $.classic.Stop(waitingOn("b"))).block).toBeUndefined();
  await finishTurn($);
  // The wait on b, held off by the spacing, gets its advice once the spacing allows.
  await clock.advance(30 * MINUTE);
  await startTurn($);
  expect((await $.classic.Stop(waitingOn("b"))).block).toContain(
    "compaction point",
  );
  await finishTurn($);
  await startTurn($);
  expect((await $.classic.Stop(STOP)).block).toBeUndefined();
  expect(eventsOf(files, "compaction-prompt")).toHaveLength(2);
});

test("long-lived background work gives the compaction advice once for its wait, through wakes and the person's new requests", async ($, on) => {
  const { files, clock } = turnEndWorld(on);
  await $.session.start(START);
  await startTurn($);
  expect((await $.classic.Stop(waitingOn("m1"))).block).toContain(
    "compaction point",
  );
  await finishTurn($);
  for (let k = 0; k < 3; k++) {
    await clock.advance(40 * MINUTE);
    await $.prompt.submit({
      text: "<task-notification>",
      origin: { kind: "task-notification" },
      wait: false,
    });
    await startTurn($);
    expect((await $.classic.Stop(waitingOn("m1"))).block).toBeUndefined();
    await finishTurn($);
  }
  // A new request from the person ends the wait; the monitor still running starts no new one.
  await clock.advance(40 * MINUTE);
  await $.prompt.submit({
    text: "Check the logs.",
    origin: { kind: "composer" },
    wait: false,
  });
  await startTurn($);
  expect((await $.classic.Stop(waitingOn("m1"))).block).toBeUndefined();
  await finishTurn($);
  // New work starts a new wait.
  await startTurn($);
  expect((await $.classic.Stop(waitingOn("m1", "a"))).block).toContain(
    "compaction point",
  );
  expect(eventsOf(files, "compaction-prompt")).toHaveLength(2);
});

test(
  "a small context or compactNudgeTokens 0 gives no compaction advice at a boundary",
  { options: { compactNudgeTokens: 0 } },
  async ($, on) => {
    turnEndWorld(on);
    await $.session.start(START);
    await startTurn($);
    await $.tool.call({ tool: "Bash", command: "git commit -m x" });
    expect((await $.classic.Stop(STOP)).block).toBeUndefined();
  },
);

test("a compact call is refused once for a message the user typed during the turn, naming its time and not its words", async ($, on) => {
  const { files } = turnEndWorld(on);
  await $.session.start(START);
  await startTurn($);
  await $.prompt.submit({
    text: "Can you also check the tests?",
    origin: { kind: "composer" },
    wait: false,
    turnId: "t",
  });
  const held = String(
    (await $.tool.call({ tool: "mcp__tidy__compact", focus: "next" })).result,
  );
  expect(held).toContain("a user message at 12:00 UTC");
  expect(held).not.toContain("skill");
  expect(
    String(
      (await $.tool.call({ tool: "mcp__tidy__compact", focus: "next" })).result,
    ),
  ).toContain("scheduled");
  expect(eventsOf(files, "compact-held")).toHaveLength(1);
});

test("a message sent from the threads pane during the turn holds the compaction too", async ($, on) => {
  turnEndWorld(on);
  await $.session.start(START);
  await startTurn($);
  await $.prompt.submit({
    text: "Wait, use the other branch.",
    origin: { kind: "plugin", name: "threads", asUser: true },
    wait: false,
    turnId: "t",
  });
  expect(
    String(
      (await $.tool.call({ tool: "mcp__tidy__compact", focus: "next" })).result,
    ),
  ).toContain("may be unanswered");
});

test("a message that started the turn does not hold the compaction", async ($, on) => {
  turnEndWorld(on);
  await $.session.start(START);
  await $.prompt.submit({
    text: "Go on.",
    origin: { kind: "composer" },
    wait: false,
  });
  await startTurn($);
  expect(
    String(
      (await $.tool.call({ tool: "mcp__tidy__compact", focus: "next" })).result,
    ),
  ).toContain("scheduled");
});

// ---- Cache keep-alive ----

const BACKGROUND = {
  stop_hook_active: false,
  background_tasks: [
    { id: "b", type: "shell", status: "running", description: "build" },
  ],
} as never;

// A main turn whose one request reads `promptTokens` from the cache, ending with `stop`.
async function turnThatEnds($: Parameters<TestBody>[0], stop = BACKGROUND) {
  await startTurn($);
  for await (const _ of $.turn.step({
    turnId: "t",
    index: 0,
    model: "claude-opus-5-5",
    messageCount: 1,
  }));
  await $.classic.Stop(stop);
  await finishTurn($);
}

test("a session that waits on background work forks a ping just before its cache expires, and logs it", async ($, on) => {
  const { seen, clock, files } = world(on, {
    rateLimits: steady,
    promptTokens: 200_000,
  });
  await $.session.start(START);
  await turnThatEnds($);
  await clock.advance(54 * MINUTE);
  expect(seen.forks).toEqual([]);
  await clock.advance(MINUTE);
  expect(seen.forks).toEqual([
    "Cache keep-alive. Reply with the single word: ok",
  ]);
  expect(eventsOf(files, "keepalive")).toEqual([
    expect.objectContaining({ ping: 1, context: 200_010 }),
  ]);
  await clock.advance(55 * MINUTE);
  expect(seen.forks.length).toBe(2);
});

test("no ping for a session that waits only for the user", async ($, on) => {
  const { seen, clock } = world(on, {
    rateLimits: steady,
    promptTokens: 200_000,
  });
  await $.session.start(START);
  await turnThatEnds($, STOP);
  await clock.advance(2 * HOUR);
  expect(seen.forks).toEqual([]);
});

test("a small context is left to expire", async ($, on) => {
  const { seen, clock } = world(on, {
    rateLimits: steady,
    promptTokens: 5_000,
  });
  await $.session.start(START);
  await turnThatEnds($);
  await clock.advance(2 * HOUR);
  expect(seen.forks).toEqual([]);
});

// A quarter of a rewrite buys five pings of a one-hour cache, which keeps the
// simulated wait short.
test(
  "pings stop once their reads would cost the budget's share of a rewrite",
  { options: { keepaliveBudget: 0.25 } },
  async ($, on) => {
    const { seen, clock } = world(on, {
      rateLimits: steady,
      promptTokens: 200_000,
    });
    await $.session.start(START);
    await turnThatEnds($);
    for (let hours = 0; hours < 7; hours++) await clock.advance(HOUR);
    expect(seen.forks.length).toBe(5);
  },
);

test("a new turn ends the wait and starts a new ping budget", async ($, on) => {
  const { seen, clock } = world(on, {
    rateLimits: steady,
    promptTokens: 200_000,
  });
  await $.session.start(START);
  await turnThatEnds($);
  await clock.advance(30 * MINUTE);
  await turnThatEnds($);
  await clock.advance(54 * MINUTE);
  expect(seen.forks).toEqual([]);
  await clock.advance(MINUTE);
  expect(seen.forks.length).toBe(1);
});

test("after a compaction nothing is pinged until a request caches the new context", async ($, on) => {
  const { seen, clock } = world(on, {
    rateLimits: steady,
    promptTokens: 200_000,
  });
  await $.session.start(START);
  await turnThatEnds($);
  await $.session.compact({
    trigger: "manual",
    messages: [{ role: "user", text: "hello", toolUses: [] }],
  } as never);
  await clock.advance(2 * HOUR);
  expect(seen.forks).toEqual([]);
});

test("after an account switch that runway records, nothing is pinged, because the new account holds no cache", async ($, on) => {
  const { seen, clock, files } = world(on, {
    rateLimits: steady,
    promptTokens: 200_000,
  });
  await $.session.start(START);
  await turnThatEnds($);
  await clock.advance(10 * MINUTE);
  files.set(LAST_SWITCH, {
    text: JSON.stringify({ switchedAt: clock.now(), sessionId: "other" }),
    mtimeMs: clock.now(),
  });
  await clock.advance(HOUR);
  await clock.advance(HOUR);
  expect(seen.forks).toEqual([]);
});

test("a switch before the last request leaves its cache warm", async ($, on) => {
  const { seen, clock } = world(on, {
    rateLimits: steady,
    promptTokens: 200_000,
    files: {
      [LAST_SWITCH]: { text: JSON.stringify({ switchedAt: NOW - MINUTE }) },
    },
  });
  await $.session.start(START);
  await turnThatEnds($);
  await clock.advance(55 * MINUTE);
  expect(seen.forks.length).toBe(1);
});

test("a session in another profile keeps its cache through a switch", async ($, on) => {
  const { seen, clock } = world(on, {
    rateLimits: steady,
    promptTokens: 200_000,
    env: { CLAUDE_CONFIG_DIR: "/tmp/prof" },
    files: {
      [LAST_SWITCH]: {
        text: JSON.stringify({ switchedAt: NOW + 30 * MINUTE }),
      },
    },
  });
  await $.session.start(START);
  await turnThatEnds($);
  await clock.advance(55 * MINUTE);
  expect(seen.forks.length).toBe(1);
});

test("a usage limit that stops the main turn pauses keep-alive until the next main turn", async ($, on) => {
  const { seen, clock } = world(on, {
    rateLimits: steady,
    promptTokens: 200_000,
  });
  await $.session.start(START);
  await turnThatEnds($);
  await $.classic.StopFailure({ error: "rate_limit" } as never);
  await clock.advance(2 * HOUR);
  expect(seen.forks).toEqual([]);
  await turnThatEnds($);
  await clock.advance(55 * MINUTE);
  expect(seen.forks.length).toBe(1);
});

test("a main turn that ends in an error while a window shows used up pauses keep-alive", async ($, on) => {
  const { seen, clock } = world(on, {
    rateLimits: [
      {
        kind: "five_hour",
        percentUsed: 100,
        resetsAt: new Date(NOW + 3 * HOUR).toISOString(),
      },
    ],
    promptTokens: 200_000,
  });
  await $.session.start(START);
  await turnThatEnds($);
  await $.turn.complete({
    reason: "error",
    answer: "",
    durationMs: 1,
    turnId: "t",
    isAborted: false,
  } as never);
  await clock.advance(2 * HOUR);
  expect(seen.forks).toEqual([]);
});

test("a subagent's limit does not pause keep-alive", async ($, on) => {
  const { seen, clock } = world(on, {
    rateLimits: steady,
    promptTokens: 200_000,
  });
  await $.session.start(START);
  await turnThatEnds($);
  await $.classic.StopFailure({
    error: "rate_limit",
    agent_id: "a1",
  } as never);
  await clock.advance(55 * MINUTE);
  expect(seen.forks.length).toBe(1);
});

test(
  "cacheTtlMinutes 0 turns keep-alive off",
  { options: { cacheTtlMinutes: 0 } },
  async ($, on) => {
    const { seen, clock } = world(on, {
      rateLimits: steady,
      promptTokens: 200_000,
    });
    await $.session.start(START);
    await turnThatEnds($);
    await clock.advance(2 * HOUR);
    expect(seen.forks).toEqual([]);
  },
);

test("a five-minute cache, set by Claude Code's variable, is pinged every four minutes", async ($, on) => {
  const { seen, clock } = world(on, {
    rateLimits: steady,
    promptTokens: 200_000,
    env: { FORCE_PROMPT_CACHING_5M: "1" },
  });
  await $.session.start(START);
  await turnThatEnds($);
  await clock.advance(4 * MINUTE);
  expect(seen.forks.length).toBe(1);
  await clock.advance(4 * MINUTE);
  expect(seen.forks.length).toBe(2);
});

test("caching turned off in Claude Code keeps nothing warm", async ($, on) => {
  const { seen, clock } = world(on, {
    rateLimits: steady,
    promptTokens: 200_000,
    env: { DISABLE_PROMPT_CACHING: "1" },
  });
  await $.session.start(START);
  await turnThatEnds($);
  await clock.advance(2 * HOUR);
  expect(seen.forks).toEqual([]);
});
