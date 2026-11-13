import { expect, test, type TestBody } from "claude-code/testing";

test("the system prompt points to the agent, except in a bare prompt", async ($, on) => {
  on("prompt.compose", async () => ({ sections: [] }));
  const composed = (traits: string[]) =>
    $.prompt.compose({
      model: "claude-opus-5-5",
      promptModel: "claude-opus-5-5",
      surfaces: [],
      tools: [],
      outputStyle: null,
      traits,
    } as never);
  const [section] = (await composed([])).sections;
  expect(section).toEqual(
    expect.objectContaining({
      id: "rootcause:method",
      text: expect.stringContaining("Start the `rootcause:rootcause` agent"),
    }),
  );
  expect(section.text).not.toMatch(
    /rootcause (start|answer|conclude|abandon|list)/,
  );
  expect((await composed(["bare"])).sections).toEqual([]);
});

test("the system prompt asks for the agent on corrections and on a cause that comes back", async ($, on) => {
  on("prompt.compose", async () => ({ sections: [] }));
  const [section] = (
    await $.prompt.compose({
      model: "claude-opus-5-5",
      promptModel: "claude-opus-5-5",
      surfaces: [],
      tools: [],
      outputStyle: null,
      traits: [],
    } as never)
  ).sections;
  expect(section.text).toContain(
    "Do the same when the user corrects your work, such as a document, plan, brief or scope, and when a cause you already answered comes back.",
  );
  expect(section.text).toContain(
    "A new or stricter target, preference or scope from the user is not a correction",
  );
  expect(section.text).toContain(
    "for a defect or a correction when it would add nothing",
  );
});

test("each session start sets the exec bit of the command, which a plugin install may drop", async ($, on) => {
  const runs: string[][] = [];
  on("session.start", async ($, e) => ({ cwd: e.cwd }));
  on("process.run", async ($, e) => {
    runs.push([...e.argv]);
    return {
      value: {
        exitCode: 0,
        stdout: "",
        stderr: "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });
  await $.session.start({
    cwd: "/work",
    surface: "terminal",
    isInteractive: true,
  });
  expect(runs[0]).toEqual([
    "chmod",
    "a+x",
    expect.stringMatching(/\/bin\/rootcause$/),
  ]);
});

// A stand-in for the engine below the plugin: the session id, the toasts, and `rootcause serve`, which prints
// the session's page when it registers the session and nothing for an unknown one with --if-known.
function engine(on: Parameters<TestBody>[1], known: Set<string>) {
  const state = {
    session: "session-a",
    runs: [] as string[][],
    toasts: [] as string[],
    stale: "",
  };
  const ran = (stdout: string) => ({
    value: {
      exitCode: 0,
      stdout,
      stderr: "",
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  });
  on("session.id", async () => ({ value: state.session }));
  on(
    "ui.toast",
    async ($, e) => (state.toasts.push(e.text), { value: undefined }),
  );
  on("session.start", async ($, e) => ({ cwd: e.cwd }));
  on("process.run", async ($, e) => {
    const argv = [...e.argv];
    if (argv[1] === "list") return ran(`${state.stale}\n`);
    if (argv[1] !== "serve") return ran("");
    state.runs.push(argv.slice(1));
    const session = argv[argv.indexOf("--session") + 1];
    if (argv.includes("--if-known") && !known.has(session)) return ran("");
    known.add(session);
    return ran(`http://127.0.0.1:7391/s/${session}\n`);
  });
  on("tool.call", async ($, e) => {
    const command = e.tool === "Bash" ? e.command : "";
    if (command.includes("symptom: none"))
      return {
        isError: true,
        result: "Give symptom",
        text: "Give symptom: what behaves wrongly, as it was observed.",
      };
    if (
      command.startsWith("rootcause start") &&
      command.split("symptom:").length > 2
    )
      return {
        result: {
          stdout:
            "Started rc-20261020-4b8e1d. Symptoms S1, S2: the steps of S1 are numbered 1, 1.2.",
        },
        text: "Started rc-20261020-4b8e1d. Symptoms S1, S2: the steps of S1 are numbered 1, 1.2.",
      };
    if (command.startsWith("rootcause start"))
      return {
        result: { stdout: "Started rc-20261020-3f9a2c. Why does this happen?" },
        text: "Started rc-20261020-3f9a2c. Why does this happen?",
      };
    return { result: "ok" };
  });
  return state;
}

const start = (symptom: string) => ({
  tool: "Bash",
  command: `rootcause start <<'EOF'\nsymptom: ${symptom}\nEOF`,
});

test("the first analysis of a session registers it with the web UI, and the user and the main session get its page once", async ($, on) => {
  const state = engine(on, new Set());
  const call = (input: Record<string, unknown>, agentId?: string) =>
    $.tool.call({ ...input, agentId } as never);
  expect((await call(start("none"), "rc")).isError).toBe(true);
  expect(state.runs).toEqual([]);
  await call(start("The export drops a row"), "rc");
  expect(state.runs).toEqual([
    [
      "serve",
      "--detach",
      "--session",
      "session-a",
      "--claim",
      "rc-20261020-3f9a2c",
    ],
  ]);
  expect(state.toasts).toEqual([
    expect.stringContaining("http://127.0.0.1:7391/s/session-a"),
  ]);
  expect(
    (await call({ tool: "Read", file_path: "/x" }, "rc")).context ?? [],
  ).toEqual([]);
  expect((await call({ tool: "Read", file_path: "/x" })).context).toEqual([
    expect.stringMatching(
      /live in a browser, at http:\/\/127\.0\.0\.1:7391\/s\/session-a\. Give the user this link in your next reply\.$/,
    ),
  ]);
  await call(start("Another symptom"), "rc2");
  expect(state.runs).toHaveLength(2);
  expect(state.toasts).toHaveLength(1);
  expect((await call({ tool: "Read", file_path: "/x" })).context ?? []).toEqual(
    [],
  );
});

test("a start with several symptoms registers its analysis too, and add-symptom counts as recording", async ($, on) => {
  const state = engine(on, new Set());
  const call = (input: Record<string, unknown>, agentId?: string) =>
    $.tool.call({ ...input, agentId } as never);
  await call(
    {
      tool: "Bash",
      command:
        "rootcause start <<'EOF'\nsymptom: The export drops a row\nsymptom: The import skips a row\nEOF",
    },
    "rc",
  );
  expect(state.runs).toEqual([
    [
      "serve",
      "--detach",
      "--session",
      "session-a",
      "--claim",
      "rc-20261020-4b8e1d",
    ],
  ]);
  for (let i = 0; i < 9; i++)
    await call({ tool: "Read", file_path: "/x" }, "rc");
  await call(
    {
      tool: "Bash",
      command:
        "rootcause add-symptom rc-20261020-4b8e1d <<'EOF'\nsymptom: The total is one short\nEOF",
    },
    "rc",
  );
  expect(state.runs).toHaveLength(1);
  expect(
    (await call({ tool: "Read", file_path: "/x" }, "rc")).deny,
  ).toBeUndefined();
});

test("the system prompt asks for one agent for symptoms that may share causes, and separate ones for unrelated problems", async ($, on) => {
  on("prompt.compose", async () => ({ sections: [] }));
  const [section] = (
    await $.prompt.compose({
      model: "claude-opus-5-5",
      promptModel: "claude-opus-5-5",
      surfaces: [],
      tools: [],
      outputStyle: null,
      traits: [],
    } as never)
  ).sections;
  expect(section.text).toContain(
    "Brief one agent with several symptoms when they may share causes",
  );
  expect(section.text).toContain("Give unrelated problems separate agents");
  expect(section.text).toContain(
    "to the running agent, which adds it to its analysis",
  );
});

test("a session that goes on under a new id, after a /clear, gets its own page and a new note", async ($, on) => {
  const state = engine(on, new Set());
  const call = (input: Record<string, unknown>, agentId?: string) =>
    $.tool.call({ ...input, agentId } as never);
  await call(start("First"), "rc");
  await call({ tool: "Read", file_path: "/x" });
  state.session = "session-b";
  await call(start("Second"), "rc");
  expect(state.runs.at(-1)).toEqual([
    "serve",
    "--detach",
    "--session",
    "session-b",
    "--claim",
    "rc-20261020-3f9a2c",
  ]);
  expect(state.toasts).toEqual([
    expect.stringContaining("/s/session-a"),
    expect.stringContaining("/s/session-b"),
  ]);
  expect(
    (await call({ tool: "Read", file_path: "/x" })).context?.[0],
  ).toContain("/s/session-b");
});

test("a resumed session with analyses registers its new process and shows its page, with no note, and an unknown one nothing", async ($, on) => {
  const state = engine(on, new Set(["session-a"]));
  const call = (input: Record<string, unknown>, agentId?: string) =>
    $.tool.call({ ...input, agentId } as never);
  await $.session.start({
    cwd: "/work",
    surface: "terminal",
    isInteractive: true,
  });
  expect(state.runs).toEqual([
    ["serve", "--detach", "--session", "session-a", "--if-known"],
  ]);
  expect(state.toasts).toEqual([
    expect.stringContaining("http://127.0.0.1:7391/s/session-a"),
  ]);
  await call(start("After the resume"), "rc");
  expect(state.toasts).toHaveLength(1);
  expect((await call({ tool: "Read", file_path: "/x" })).context ?? []).toEqual(
    [],
  );
  state.session = "session-new";
  await $.session.start({
    cwd: "/work",
    surface: "terminal",
    isInteractive: true,
  });
  expect(state.runs.at(-1)).toEqual([
    "serve",
    "--detach",
    "--session",
    "session-new",
    "--if-known",
  ]);
  expect(state.toasts).toHaveLength(1);
});

test("an agent that runs the command is told, then refused, when it investigates long without recording", async ($, on) => {
  on("tool.call", async () => ({ result: "ok" }));
  const call = (input: Record<string, unknown>, agentId?: string) =>
    $.tool.call({ ...input, agentId } as never);
  const read = (agentId?: string) =>
    call({ tool: "Read", file_path: "/x" }, agentId);
  for (let i = 0; i < 20; i++)
    expect((await read("other")).deny).toBeUndefined();
  for (let i = 0; i < 20; i++) expect((await read()).deny).toBeUndefined();
  await call(
    { tool: "Bash", command: "rootcause start <<'EOF'\nsymptom: s\nEOF" },
    "rc",
  );
  for (let i = 1; i < 6; i++)
    expect((await read("rc")).context ?? []).toEqual([]);
  expect((await read("rc")).context).toEqual([
    expect.stringContaining("6 tool calls since your last `rootcause` command"),
  ]);
  for (let i = 7; i < 10; i++) expect((await read("rc")).deny).toBeUndefined();
  expect((await read("rc")).deny).toContain("9 tool calls");
  expect((await read("rc")).deny).toContain("9 tool calls");
  expect(
    (
      await call(
        { tool: "Bash", command: "rootcause answer rc-1 <<'EOF'\nEOF" },
        "rc",
      )
    ).deny,
  ).toBeUndefined();
  expect((await read("rc")).deny).toBeUndefined();
  expect((await read("rc")).context ?? []).toEqual([]);
  for (let i = 0; i < 12; i++) await read("rc");
  expect(
    (
      await call(
        { tool: "Bash", command: "rootcause conclude rc-1 <<'EOF'\nEOF" },
        "rc",
      )
    ).deny,
  ).toBeUndefined();
});

// The engine below the plugin for helpers: it records each Agent call as it reaches the tool, and a spawn answers
// the helper's id.
function helperEngine(on: Parameters<TestBody>[1]) {
  const agentCalls: Record<string, unknown>[] = [];
  on("tool.call", async ($, e) => {
    if (e.tool === "Agent") agentCalls.push({ ...e });
    return { result: "ok" };
  });
  on("agent.spawn", async () => ({
    model: "claude-opus-5-5",
    agentId: "helper",
  }));
  return agentCalls;
}

const spawn = (parentAgentId?: string) => ({
  tool_use_id: "t",
  prompt: "p",
  description: "d",
  subagentType: "general-purpose",
  provider: { plugin: "engine", tier: "core" },
  parentModel: "claude-opus-5-5",
  parentAgentId,
  background: false,
  fork: false,
});
const agentCall = (input: Record<string, unknown>) => ({
  tool: "Agent",
  description: "check",
  prompt: "look",
  ...input,
});

test("an analysing agent starts helpers at medium effort, on opus or sonnet: other settings are rewritten", async ($, on) => {
  const agentCalls = helperEngine(on);
  const call = (input: Record<string, unknown>, agentId?: string) =>
    $.tool.call({ ...input, agentId } as never);
  await call(start("s"), "rc");
  const right = await call(
    agentCall({ model: "opus", effort: "medium" }),
    "rc",
  );
  expect(right.context ?? []).toEqual([]);
  expect(agentCalls.at(-1)).toEqual(
    expect.objectContaining({ model: "opus", effort: "medium" }),
  );
  await call(agentCall({ model: "sonnet", effort: "medium" }), "rc");
  expect(agentCalls.at(-1)).toEqual(
    expect.objectContaining({ model: "sonnet", effort: "medium" }),
  );
  const unset = await call(agentCall({}), "rc");
  expect(agentCalls.at(-1)).toEqual(
    expect.objectContaining({ model: "opus", effort: "medium" }),
  );
  expect(unset.context).toEqual([
    expect.stringContaining("started with no effort and no model"),
  ]);
  await call(agentCall({ model: "haiku", effort: "high" }), "rc");
  expect(agentCalls.at(-1)).toEqual(
    expect.objectContaining({ model: "opus", effort: "medium" }),
  );
  await call(agentCall({ model: "sonnet", effort: "low" }), "rc");
  expect(agentCalls.at(-1)).toEqual(
    expect.objectContaining({ model: "sonnet", effort: "medium" }),
  );
  const fork = await call(agentCall({ subagent_type: "fork" }), "rc");
  expect(fork.deny).toContain("Do not fork a helper");
});

test("the Agent calls of other agents and of the main session are untouched", async ($, on) => {
  const agentCalls = helperEngine(on);
  const call = (input: Record<string, unknown>, agentId?: string) =>
    $.tool.call({ ...input, agentId } as never);
  await call(agentCall({ model: "haiku", effort: "high" }), "other");
  await call(agentCall({ model: "haiku" }));
  await call(agentCall({ subagent_type: "fork" }), "other");
  expect(agentCalls).toHaveLength(3);
  expect(agentCalls[0]).toEqual(
    expect.objectContaining({ model: "haiku", effort: "high" }),
  );
  expect(agentCalls[1]).toEqual(expect.objectContaining({ model: "haiku" }));
  expect(agentCalls[1].effort).toBeUndefined();
});

test("a helper is not counted between records, and may not run the command", async ($, on) => {
  helperEngine(on);
  const call = (input: Record<string, unknown>, agentId?: string) =>
    $.tool.call({ ...input, agentId } as never);
  await call(start("s"), "rc");
  await $.agent.spawn(spawn("rc") as never);
  for (let i = 0; i < 20; i++) {
    const read = await call({ tool: "Read", file_path: "/x" }, "helper");
    expect(read.deny).toBeUndefined();
    expect(read.context ?? []).toEqual([]);
  }
  const ran = await call(start("mine"), "helper");
  expect(ran.deny).toContain("You are a helper of a root cause analysis");
  for (let i = 0; i < 20; i++)
    expect(
      (await call({ tool: "Read", file_path: "/x" }, "helper")).deny,
    ).toBeUndefined();
  expect(
    (await call({ tool: "Read", file_path: "/x" }, "rc")).context ?? [],
  ).toEqual([]);
});

test("a spawn outside an analysing agent starts no helper", async ($, on) => {
  helperEngine(on);
  const call = (input: Record<string, unknown>, agentId?: string) =>
    $.tool.call({ ...input, agentId } as never);
  await $.agent.spawn(spawn("other") as never);
  await $.agent.spawn(spawn() as never);
  expect((await call(start("s"), "helper")).deny).toBeUndefined();
});

test("a session starts with this project's analyses left open for more than a day, once, to tell the user", async ($, on) => {
  const state = engine(on, new Set());
  const call = (input: Record<string, unknown>, agentId?: string) =>
    $.tool.call({ ...input, agentId } as never);
  state.stale =
    "rc-20261020-5c7d2e (open since 2026-10-20: The export drops a row)";
  await $.session.start({
    cwd: "/work",
    surface: "terminal",
    isInteractive: true,
  });
  const first = (await call({ tool: "Read", file_path: "/x" })).context ?? [];
  expect(first).toEqual([
    expect.stringContaining("rc-20261020-5c7d2e (open since 2026-10-20"),
  ]);
  expect(first[0]).toContain("Tell the user about them once");
  expect((await call({ tool: "Read", file_path: "/x" })).context ?? []).toEqual(
    [],
  );
  state.stale = "";
  await $.session.start({
    cwd: "/work",
    surface: "terminal",
    isInteractive: true,
  });
  expect((await call({ tool: "Read", file_path: "/x" })).context ?? []).toEqual(
    [],
  );
});

const STALE_LINE =
  "rc-20261020-5c7d2e (open since 2026-10-20: The export drops a row)\n";

test("a session start lists the stale analyses and registers the session together, after the chmod", async ($, on) => {
  const steps: string[] = [];
  let served = false;
  on("session.id", async () => ({ value: "session-a" }));
  on("ui.toast", async () => ({ value: undefined }));
  on("session.start", async ($, e) => ({ cwd: e.cwd }));
  on("tool.call", async () => ({ result: "ok" }));
  on("process.run", async ($, e) => {
    const step = e.argv[0] === "chmod" ? "chmod" : e.argv[1];
    steps.push(`${step} start`);
    if (step === "serve") served = true;
    // The listing waits a while for the server step, which starts only after it ends when the two run in turn.
    if (step === "list")
      for (let i = 0; i < 1000 && !served; i++) await Promise.resolve();
    steps.push(`${step} end`);
    return {
      value: {
        exitCode: 0,
        stdout: step === "list" ? STALE_LINE : "",
        stderr: "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });
  await $.session.start({
    cwd: "/work",
    surface: "terminal",
    isInteractive: true,
  });
  expect(steps.slice(0, 2)).toEqual(["chmod start", "chmod end"]);
  expect(steps.indexOf("serve start")).toBeLessThan(steps.indexOf("list end"));
  expect(
    (await $.tool.call({ tool: "Read", file_path: "/x" } as never))
      .context?.[0],
  ).toContain(`open for more than a day:\n${STALE_LINE}`);
});
