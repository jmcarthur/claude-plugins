import type { On } from "claude-code";
import { expect, mock, test, type TestBody } from "claude-code/testing";

import { ago, cardRows, focusables } from "./register";

type Dollar = Parameters<TestBody>[0];

const NOW = 1_800_000_000_000;
const ID = "session-1";

function world(on: On) {
  const clock = mock.clock(on, { now: NOW });
  const store = new Map<string, unknown>();
  const seen = {
    prompts: [] as string[],
    opened: [] as string[],
    focusAsked: [] as string[],
    // While set, a prompt is dropped, as a hook below may drop it.
    isDropping: false,
    // As Claude Code 2.1.323 does: while a turn runs, a plugin's prompt waits in the queue, its submit
    // unsettled; an interrupt discards it and sets a Stop, which refuses a plugin's prompt until the
    // person sends input. A plugin's submit counts as theirs while their press or Enter is dispatched.
    isRunning: false,
    isStopped: false,
    inGesture: false,
    queued: [] as (() => void)[],
    toasts: [] as string[],
    // While set, the store refuses a write that would take it past this many characters of JSON.
    storeLimit: undefined as number | undefined,
    // The session's id: a /clear goes on under a new one.
    sessionId: ID,
  };
  on("store.get", async ($, e) => ({ value: store.get(e.key) }) as never);
  on("store.set", async ($, e) => {
    if (
      seen.storeLimit !== undefined &&
      JSON.stringify({ ...Object.fromEntries(store), [e.key]: e.value })
        .length > seen.storeLimit
    )
      throw new Error("The store would be over 4 MiB.");
    store.set(e.key, e.value);
    return { value: undefined } as never;
  });
  on("store.delete", async ($, e) => {
    store.delete(e.key);
    return { value: undefined } as never;
  });
  on("session.start", async ($, e) => ({ cwd: e.cwd }));
  on("session.id", async () => ({ value: seen.sessionId }));
  on("tool.register", async ($, e) => ({ value: { tool: e.name } }) as never);
  on(
    "command.register",
    async ($, e) => ({ value: { command: e.name } }) as never,
  );
  on("ui.open", async ($, e) => {
    seen.opened.push(e.id);
    if (e.focus === true) seen.focusAsked.push(e.id);
    return { value: { isPlaced: true } } as never;
  });
  on("prompt.submit", async ($, e) => {
    if (seen.isDropping) return { drop: "Not now." } as never;
    const isPersons = e.origin?.kind === "composer" || seen.inGesture;
    if (seen.isStopped && !isPersons)
      return {
        drop: "the session was stopped and nobody has sent input since",
      } as never;
    seen.isStopped = false;
    if (seen.isRunning && e.origin?.kind !== "composer")
      return new Promise((resolve) =>
        seen.queued.push(() =>
          resolve({
            drop: "the prompt was removed from the queue before it ran",
          } as never),
        ),
      );
    seen.prompts.push(e.text);
    return { text: e.text, context: e.context };
  });
  // The dispatch of a press or Enter ends at its handler's first wait: here, its first write of state,
  // which every path that sends makes sooner or later.
  on("state.set", (async (
    $: unknown,
    e: never,
    next: (e: never) => unknown,
  ) => {
    seen.inGesture = false;
    return next(e);
  }) as never);
  on("ui.toast", async ($, e) => {
    seen.toasts.push(e.text);
    return { value: undefined } as never;
  });
  on("classic.Stop", async () => ({}));
  on("tool.call", async () => ({ result: "ran" }) as never);
  return { store, seen, clock };
}

const start = ($: Dollar) =>
  $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });

const prompt = async ($: Dollar, text: string, uuid: string) => {
  const entered = await $.prompt.submit({
    text,
    origin: { kind: "composer" },
  } as never);
  await $.session.append({
    message: { type: "user", role: "user", content: [{ type: "text", text }] },
    door: "prompt",
    origin: { kind: "composer" },
    uuid,
  } as never);
  return entered;
};

const reply = ($: Dollar, text: string, uuid: string) =>
  $.session.append({
    message: {
      type: "assistant",
      role: "assistant",
      content: [{ type: "text", text }],
    },
    door: "response",
    origin: { kind: "model", model: "claude-opus-5-5" },
    uuid,
  } as never);

const PANE = {
  plugin: "threads",
  component: "Pane",
  requestId: "threads",
  surface: "terminal",
  props: {
    title: "Threads",
    isFocused: false,
    bodyColumns: 50,
    placement: "dock",
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const;

test("the system prompt asks for a tag on every reply and threads instead of AskUserQuestion", async ($, on) => {
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
  expect(section.text).toContain("Tag every reply.");
  expect(section.text).toContain("each draws as a link that opens it");
  // The rule that a wait on the user is a question is stated once, and allows a status that waits.
  expect(
    section.text.split("Only open questions show as waiting"),
  ).toHaveLength(2);
  expect(section.text).toContain('may say it waits ("Waiting on q3"');
  expect(section.text).not.toContain("Ask before you say it waits");
  expect(section.text).toContain("never with AskUserQuestion");
  expect(section.text).toContain("without being asked");
  expect(section.text).toContain("ask them as a checklist of to-dos");
  expect(section.text).toContain("ask again at once with the remaining to-dos");
  expect((await composed(["bare"])).sections).toEqual([]);
});

test("AskUserQuestion is refused in the main session and left alone in a subagent", async ($, on) => {
  world(on);
  await start($);
  const main = await $.tool.call({
    tool: "AskUserQuestion",
    questions: [],
  } as never);
  expect(JSON.stringify(main)).toContain("mcp__threads__ask");
  const sub = await $.tool.call({
    tool: "AskUserQuestion",
    questions: [],
    agentId: "a1",
  } as never);
  expect(JSON.stringify(sub)).not.toContain("mcp__threads__ask");
});

test("AskUserQuestion is listed behind ToolSearch, its description saying to use mcp__threads__ask", async ($, on) => {
  world(on);
  on("tool.describe", async ($, e) => ({ description: e.description }));
  await start($);
  const out = await $.tool.describe({
    tool: "AskUserQuestion",
    description: "Ask the user questions.",
  } as never);
  expect(out.description).toContain("mcp__threads__ask");
  expect(out.isDeferred).toBe(true);
});

test("a plan explained under main and tagged with the question's thread shows in that thread's pane", async ($, on) => {
  const { seen } = world(on);
  await start($);
  const opened = await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    title: "Approve the parser plan",
  } as never);
  expect(JSON.stringify(opened)).toContain("Opened [[plan]]");
  expect(JSON.stringify(opened)).toContain(
    "If messages of the user's led to it",
  );
  await prompt($, "What's the plan?", "u1");
  await reply(
    $,
    "[[main]] [[plan]]\nThe plan: rewrite the lexer, then the parser.",
    "r1",
  );
  await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "plan",
    question: "Approve the plan?",
    options: ["Approve", "Revise"],
  } as never);
  // The question shows in the transcript and the band; the pane stays as the user left it.
  expect(seen.opened).not.toContain("threads");

  const list = await $.ui.mount(PANE);
  expect((await list.find({ type: "Button", key: "t:plan" }))?.text).toContain(
    "?1",
  );
  await list.press({ key: "t:plan" });
  const thread = await list.find({
    type: "Markdown",
    text: /rewrite the lexer/,
  });
  expect(thread).toBeDefined();
  expect(
    await list.find({ type: "Markdown", text: "Approve the plan?" }),
  ).toBeDefined();
  // The card's title on its top border names it, the id a button to its subthread.
  expect((await list.find({ type: "Button", key: "sub:q1" }))?.text).toContain(
    "q1",
  );
  // A pick is a draft until it is sent; the note joins it.
  await list.press({ key: "opt:q1:0" });
  expect(seen.prompts.at(-1)).toBe("What's the plan?");
  expect(
    (await list.find({ type: "Button", key: "opt:q1:0" }))?.text,
  ).toContain("(•) Approve");
  await list.press({ key: "opt:q1:1" });
  expect(
    (await list.find({ type: "Button", key: "opt:q1:0" }))?.text,
  ).toContain("( ) Approve");
  expect((await list.find({ type: "Button", key: "send" }))?.text).toContain(
    "Send 1 answer",
  );
  // The card's ✎ points the pane's one field at the question; Enter there keeps the note on the card,
  // and Send sends it with the picks.
  await list.press({ key: "note:q1" });
  expect(
    await list.find({ type: "Input", key: "msg:note:q1:1" }),
  ).toBeDefined();
  await list.input({ key: "msg:note:q1:1", text: "keep the old lexer" });
  expect(seen.prompts.at(-1)).toBe("What's the plan?");
  expect(
    await list.find({ type: "Text", text: /keep the old lexer/ }),
  ).toBeDefined();
  expect(await list.find({ type: "Input", key: "msg:plan:0" })).toBeDefined();
  await list.press({ key: "send" });
  expect(seen.prompts.at(-1)).toBe("[[plan]] q1: Revise (keep the old lexer)");
  // Sent, it waits on Claude, not the user: it leaves Waiting on you, and the history shows the answer.
  expect(await list.find({ type: "Button", key: "opt:q1:0" })).toBeUndefined();
  expect(
    await list.find({ type: "Text", text: "Waiting on you" }),
  ).toBeUndefined();
  expect(
    await list.find({ type: "Text", text: /Revise \(keep the old lexer\)/ }),
  ).toBeDefined();
  expect(await list.find({ type: "Button", key: "send" })).toBeUndefined();
  await list.input({ key: "msg:plan:0", text: "  " });
  await list.input({ key: "msg:plan:0", text: "One more thought" });
  expect(seen.prompts.at(-1)).toBe("[[plan]] One more thought");
  expect(await list.find({ type: "Input", key: "msg:plan:1" })).toBeDefined();
  await list.unmount();
});

test("a question card in the pane has no field of its own: its ✎ points the pane's field at it, and pressed again points it back", async ($, on) => {
  const { seen } = world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    title: "Plan",
  } as never);
  await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "plan",
    question: "Approve the plan?",
    options: ["Approve", "Revise"],
  } as never);
  const pane = await $.ui.mount(PANE);
  await pane.press({ key: "t:plan" });
  expect(
    (await pane.findAll({ type: "Input" })).map(
      (x) => (x as { key?: string }).key,
    ),
  ).toEqual(["msg:plan:0"]);
  const asked = seen.focusAsked.length;
  await pane.press({ key: "note:q1" });
  const field = await pane.find({ type: "Input", key: "msg:note:q1:1" });
  expect(
    (field as { props: Record<string, unknown> }).props.placeholder,
  ).toContain("Note for q1");
  // The press asks for the keyboard, which may be in the prompt, so that typing goes to the field.
  expect(seen.focusAsked.slice(asked)).toEqual(["threads"]);
  await pane.press({ key: "note:q1" });
  expect(await pane.find({ type: "Input", key: "msg:plan:0" })).toBeDefined();
  await pane.unmount();
});

test("notes kept for several questions go in one message: ✎ pressed again keeps what was typed, and the field opens on a kept note", async ($, on) => {
  const { seen } = world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    title: "Plan",
  } as never);
  await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "plan",
    question: "Approve the plan?",
    options: ["Approve", "Revise"],
  } as never);
  await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "plan",
    question: "Which lexer?",
  } as never);
  const pane = await $.ui.mount(PANE);
  await pane.press({ key: "t:plan" });
  await pane.press({ key: "opt:q1:0" });
  await pane.press({ key: "note:q1" });
  await pane.input({ key: "msg:note:q1:1", text: "with tests" });
  // Typed but not entered, the free answer is kept by pressing its ✎ again.
  await pane.press({ key: "note:q2" });
  await pane.input({
    key: "msg:note:q2:1",
    text: "the old one",
    kind: "change",
  });
  await pane.press({ key: "note:q2" });
  expect((await pane.find({ type: "Button", key: "note:q2" }))?.text).toContain(
    "Change the answer",
  );
  // Pointed at again, the field opens on the kept note.
  await pane.press({ key: "note:q1" });
  const field = await pane.find({ type: "Input", key: "msg:note:q1:2" });
  expect((field as { props: Record<string, unknown> }).props.value).toBe(
    "with tests",
  );
  // Entered unchanged, the note is kept, and the next pointing draws a field never drawn before: the
  // engine empties a field's text on Enter and keeps it by key, so a reused key would open empty.
  await pane.input({ key: "msg:note:q1:2", text: "with tests" });
  await pane.press({ key: "note:q1" });
  const again = await pane.find({ type: "Input", key: "msg:note:q1:3" });
  expect((again as { props: Record<string, unknown> }).props.value).toBe(
    "with tests",
  );
  // Moved straight to another card's ✎, what was typed is kept for the question the field was at.
  await pane.input({
    key: "msg:note:q1:3",
    text: "with more tests",
    kind: "change",
  });
  await pane.press({ key: "note:q2" });
  await pane.press({ key: "note:q2" });
  expect(
    await pane.find({ type: "Text", text: /with more tests/ }),
  ).toBeDefined();
  expect((await pane.find({ type: "Button", key: "send" }))?.text).toContain(
    "Send 2 answers",
  );
  await pane.press({ key: "send" });
  expect(seen.prompts.at(-1)).toBe(
    "[[plan]]\nq1: Approve (with more tests)\nq2: the old one",
  );
  await pane.unmount();
});

test("Send takes what the field holds for its question, typed and not entered, and a typed free answer alone can be sent", async ($, on) => {
  const { seen } = world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    title: "Plan",
  } as never);
  await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "plan",
    question: "Which lexer?",
  } as never);
  const pane = await $.ui.mount(PANE);
  await pane.press({ key: "t:plan" });
  await pane.press({ key: "note:q1" });
  expect(await pane.find({ type: "Button", key: "send" })).toBeUndefined();
  await pane.input({
    key: "msg:note:q1:1",
    text: "the old one",
    kind: "change",
  });
  expect((await pane.find({ type: "Button", key: "send" }))?.text).toContain(
    "Send 1 answer",
  );
  await pane.press({ key: "send" });
  expect(seen.prompts.at(-1)).toBe("[[plan]] q1: the old one");
  // With options, what is typed goes beside the picks.
  await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "plan",
    question: "Approve?",
    options: ["Approve", "Revise"],
  } as never);
  await pane.press({ key: "opt:q2:0" });
  await pane.press({ key: "note:q2" });
  const field = (await pane.findAll({ type: "Input" }))[0] as { key: string };
  await pane.input({ key: field.key, text: "with tests", kind: "change" });
  await pane.press({ key: "send" });
  expect(seen.prompts.at(-1)).toBe("[[plan]] q2: Approve (with tests)");
  await pane.unmount();
});

test("a message half typed in the thread's field is still there after the field is pointed at a question and back", async ($, on) => {
  const { seen } = world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    title: "Plan",
  } as never);
  await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "plan",
    question: "Approve?",
    options: ["Approve", "Revise"],
  } as never);
  const pane = await $.ui.mount(PANE);
  await pane.press({ key: "t:plan" });
  await pane.input({
    key: "msg:plan:0",
    text: "half a thought",
    kind: "change",
  });
  // Pointed at the question and back, by ✎ again or by Enter on the note, the field returns to the
  // thread's own key, whose text the engine kept.
  await pane.press({ key: "note:q1" });
  expect(
    await pane.find({ type: "Input", key: "msg:note:q1:1" }),
  ).toBeDefined();
  await pane.press({ key: "note:q1" });
  expect(await pane.find({ type: "Input", key: "msg:plan:0" })).toBeDefined();
  await pane.press({ key: "note:q1" });
  await pane.input({ key: "msg:note:q1:2", text: "with tests" });
  expect(await pane.find({ type: "Input", key: "msg:plan:0" })).toBeDefined();
  // The thread's field moves on only when it sends.
  await pane.input({ key: "msg:plan:0", text: "half a thought, whole now" });
  expect(seen.prompts.at(-1)).toBe("[[plan]] half a thought, whole now");
  expect(await pane.find({ type: "Input", key: "msg:plan:1" })).toBeDefined();
  await pane.unmount();
});

test("the field pointed at a question points back at the thread when the pane moves to another", async ($, on) => {
  world(on);
  await start($);
  for (const id of ["a", "b"])
    await $.tool.call({
      tool: "mcp__threads__thread",
      id,
      title: id,
    } as never);
  await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "a",
    question: "First?",
  } as never);
  await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "b",
    question: "Second?",
  } as never);
  const pane = await $.ui.mount(PANE);
  await pane.press({ key: "t:a" });
  await pane.press({ key: "note:q1" });
  await pane.press({ key: "t:a" });
  await pane.press({ key: "t:b" });
  const field = (await pane.findAll({ type: "Input" }))[0] as {
    key: string;
    props: Record<string, unknown>;
  };
  expect(field.props.placeholder).toBe("Message this thread…");
  // A message typed in b's field is no note of q1's, wherever the field goes next.
  await pane.input({ key: field.key, text: "hello b", kind: "change" });
  await pane.press({ key: "note:q2" });
  await pane.press({ key: "t:b" });
  await pane.press({ key: "t:a" });
  expect(await pane.find({ type: "Text", text: /hello b/ })).toBeUndefined();
  expect((await pane.find({ type: "Button", key: "note:q1" }))?.text).toContain(
    "Answer q1",
  );
  await pane.unmount();
});

test("sending a question's answer from its subthread points the field back at the subthread", async ($, on) => {
  const { seen } = world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "db",
    title: "Cache store",
  } as never);
  await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "db",
    question: "Which store?",
    options: ["JSON", "SQLite"],
  } as never);
  const pane = await $.ui.mount(PANE);
  await pane.press({ key: "t:db" });
  await pane.press({ key: "sub:q1" });
  await pane.press({ key: "opt:q1:1" });
  await pane.press({ key: "note:q1" });
  const placeholder = async () =>
    (
      (await pane.findAll({ type: "Input" }))[0] as {
        props: Record<string, unknown>;
      }
    ).props.placeholder;
  expect(await placeholder()).toContain("Note for q1");
  await pane.press({ key: "send" });
  expect(seen.prompts.at(-1)).toBe("[[db]] q1: SQLite");
  expect(await placeholder()).toBe("Reply to q1…");
  await pane.unmount();
});

test("each prompt carries the open threads and questions for the model", async ($, on) => {
  world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    title: "Approve the plan",
  } as never);
  await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "plan",
    question: "Approve?",
  } as never);
  const entered = await prompt($, "[[plan]] yes", "u1");
  const context = (entered as { context?: readonly string[] }).context ?? [];
  expect(context.join("\n")).toContain("- q1 in [[plan]]: Approve?");
  expect(context.join("\n")).toContain(
    'The user filed the message that begins "[[plan]] yes" under [[plan]].',
  );
});

test("the turn's end is held once for an untagged reply, and not after it is filed", async ($, on) => {
  world(on);
  await start($);
  await prompt($, "hi", "u1");
  await reply($, "Untagged words.", "r1");
  const held = await $.classic.Stop({ stop_hook_active: false } as never);
  expect(held.block).toContain("mcp__threads__file");
  expect(
    (await $.classic.Stop({ stop_hook_active: true } as never)).block,
  ).toBeUndefined();
  const filed = await $.tool.call({
    tool: "mcp__threads__file",
    threads: ["main"],
  } as never);
  expect(JSON.stringify(filed)).toContain("Filed under [[main]]");
  expect(
    (await $.classic.Stop({ stop_hook_active: false } as never)).block,
  ).toBeUndefined();
});

test("a tool error reaches the model as a refusal", async ($, on) => {
  world(on);
  await start($);
  const out = await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "nope",
    question: "?",
  } as never);
  expect(JSON.stringify(out)).toContain("No thread [[nope]]");
});

test("the band names the threads waiting on the user, and draws nothing when none wait", async ($, on) => {
  world(on);
  on("ui.render", async ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>engine</Text>;
  });
  await start($);
  const BAND = {
    plugin: "threads",
    component: "AbovePrompt",
    requestId: "band",
    surface: "terminal",
    props: {
      hasSurvey: false,
      isCollapsed: false,
      isWorking: false,
      maxRows: 5,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 5 },
      view: {},
    },
  } as const;
  const empty = await $.ui.mount(BAND as never);
  expect((await empty.find({ type: "Text" }))?.text).toBe("engine");
  await empty.unmount();
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    title: "Plan",
  } as never);
  await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "plan",
    question: "Approve?",
  } as never);
  const band = await $.ui.mount(BAND as never);
  // A list by default: a bullet per thread with its question ids and first question.
  expect(
    await band.find({ type: "Text", text: /1 question waiting on you/ }),
  ).toBeDefined();
  expect(await band.find({ type: "Button", key: "band:plan" })).toBeDefined();
  expect(await band.find({ type: "Text", text: "Approve?" })).toBeDefined();
  // Folded, one line with the ids alone; the toggle brings the list back.
  await band.press({ key: "band:fold" });
  expect(
    await band.find({ type: "Text", text: /Waiting on you/ }),
  ).toBeDefined();
  expect(await band.find({ type: "Text", text: / \?1$/ })).toBeDefined();
  expect(await band.find({ type: "Text", text: "Approve?" })).toBeUndefined();
  await band.press({ key: "band:fold" });
  expect(await band.find({ type: "Text", text: "Approve?" })).toBeDefined();
  await band.unmount();
});

test("the book is kept in the store under the session at each turn's end, a few seconds after a change, and at the session's end", async ($, on) => {
  const { store, clock } = world(on);
  on("session.end", async () => ({ sessionId: ID }) as never);
  await start($);
  const saved = () =>
    (
      store.get(`book:${ID}`) as { threads: { id: string }[] } | undefined
    )?.threads.map((t) => t.id);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    title: "Plan",
  } as never);
  // Each change is not a write of its own: the store holds one file for every session's book.
  expect(saved()).toBeUndefined();
  await $.classic.Stop({ stop_hook_active: false } as never);
  expect(saved()).toEqual(["main", "plan"]);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "lexer",
    title: "Lexer",
  } as never);
  expect(saved()).toEqual(["main", "plan"]);
  await clock.advance(5_000);
  expect(saved()).toEqual(["main", "plan", "lexer"]);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "docs",
    title: "Docs",
  } as never);
  await $.session.end({ reason: "exit" } as never);
  expect(saved()).toEqual(["main", "plan", "lexer", "docs"]);
});

test("after /clear, main's age is blank until the new session's first change dates it, and the store's index lists the new session", async ($, on) => {
  const { store, seen, clock } = world(on);
  on("session.end", async () => ({ sessionId: ID }) as never);
  // The engine gives the session after /clear the state's initial values, which the kit does not: here
  // the book reads as never written until the plugin writes it again.
  let isCleared = false;
  on(
    "state.get",
    { plugin: "threads", key: "book" } as never,
    async ($, e, next) =>
      isCleared
        ? ({ value: { value: undefined, version: 0 } } as never)
        : next(e),
  );
  on(
    "state.set",
    { plugin: "threads", key: "book" } as never,
    async ($, e, next) => {
      if (!isCleared) return next(e);
      isCleared = false;
      const { ifVersion: _, ...write } = e as never as Record<string, unknown>;
      return next(write as never);
    },
  );
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    title: "Plan",
  } as never);
  await $.session.end({ reason: "clear" } as never);
  isCleared = true;
  seen.sessionId = "session-2";
  const rows = async () => {
    const pane = await $.ui.mount(PANE);
    const main = (await pane.find({ type: "Button", key: "t:main" }))?.text;
    const plan = await pane.find({ type: "Button", key: "t:plan" });
    await pane.unmount();
    return { main: main?.trimEnd(), hasPlan: plan !== undefined };
  };
  // Undated, main draws no age rather than one counted from 1970.
  expect(await rows()).toEqual({
    main: expect.stringMatching(/main The session as a whole$/),
    hasPlan: false,
  });
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "lexer",
    title: "Lexer",
  } as never);
  await clock.advance(2 * 60_000);
  expect((await rows()).main).toMatch(/ 2m$/);
  await $.classic.Stop({ stop_hook_active: false } as never);
  expect(Object.keys(store.get("sessions") as object)).toContain("session-2");
});

test("an age fits its 4 cells for any time, and an undated one draws nothing", () => {
  const now = 1_800_000_000_000;
  expect(ago(now, 0)).toBe("");
  const minute = 60_000;
  for (const back of [
    0,
    1,
    59.4,
    59.6,
    61,
    47.6 * 60,
    48 * 60,
    999.4 * 1440,
    999.6 * 1440,
    1e6 * 1440,
    now / minute - 1,
  ])
    expect(ago(now, now - back * minute).length).toBeLessThanOrEqual(4);
  expect([
    ago(now, now - 5 * minute),
    ago(now, now - 3 * 60 * minute),
    ago(now, now - 3 * 1440 * minute),
    ago(now, now - 2000 * 1440 * minute),
    ago(now, 1),
  ]).toEqual(["5m", "3h", "3d", "5y", "57y"]);
});

test("a resumed session in a new process gets its book back from the store", async ($, on) => {
  const { store } = world(on);
  store.set(`book:${ID}`, {
    threads: [
      {
        id: "main",
        title: "The session as a whole",
        summary: "",
        status: "open",
        createdAt: 0,
        updatedAt: 0,
        touchedTurn: 0,
        entries: [],
      },
      {
        id: "plan",
        title: "Approve the plan",
        summary: "Waiting.",
        status: "open",
        createdAt: 0,
        updatedAt: 0,
        touchedTurn: 0,
        entries: [],
      },
    ],
    questions: [],
    nextQuestion: 1,
    // Untagged text stored as strings, which the book reads as pieces.
    turn: { n: 2, active: [], touched: [], untagged: ["Old words."] },
  });
  await start($);
  const list = await $.ui.mount(PANE);
  expect((await list.find({ type: "Button", key: "t:plan" }))?.text).toContain(
    "Approve the plan",
  );
  await list.unmount();
  expect(
    (await $.classic.Stop({ stop_hook_active: false } as never)).block,
  ).toContain("- “Old words.”");
});

test("the transcript draws a reply's tag lines as links, and a summary's as markers", async ($, on) => {
  world(on);
  let drawn = "";
  on("ui.render", async ($, e) => {
    drawn = (e.props as { text?: string }).text ?? "";
    const { Text } = $.ui.resolve(e);
    return <Text>engine</Text>;
  });
  const mount = (isSummary?: true) =>
    $.ui.mount({
      plugin: "threads",
      component: "AssistantMessage",
      requestId: "r1",
      surface: "terminal",
      props: {
        text: "[[plan]]\nThe plan, see [[main]].",
        isFirstOfReply: true,
        ...(isSummary ? { isSummary } : {}),
      },
    } as never);
  const row = await mount();
  // The bullet every terminal draws as text, never as an emoji.
  expect(await row.find({ type: "Text", text: "●" })).toBeDefined();
  expect((await row.find({ key: "tags" }))?.text).toBe(
    "[▸ plan](https://threads.invalid/0/plan)\nThe plan, see [\\[\\[main\\]\\]](https://threads.invalid/ref/main).",
  );
  await row.unmount();
  const summary = await mount(true);
  expect(drawn).toBe("`▸ plan`\nThe plan, see [[main]].");
  await summary.unmount();
});

test("a reference in a reply's prose is a link that opens its thread or its question's subthread in the pane", async ($, on) => {
  const { seen } = world(on);
  let engine = 0;
  on("ui.render", async ($, e) => {
    engine += 1;
    const { Text } = $.ui.resolve(e);
    return <Text>engine</Text>;
  });
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    title: "Plan",
  } as never);
  await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "plan",
    question: "Approve?",
    options: ["Yes", "No"],
  } as never);
  const mount = (text: string, requestId: string) =>
    $.ui.mount({
      plugin: "threads",
      component: "AssistantMessage",
      requestId,
      surface: "terminal",
      props: { text, isFirstOfReply: true },
    } as never);
  // A reply with no tag line and no reference is the engine's to draw.
  const plain = await mount("Nothing to link, not even [[nope]].", "r0");
  expect(engine).toBe(1);
  await plain.unmount();
  // One that names a thread or question in its prose draws here, with its bullet and the links.
  const row = await mount("As [[plan]] says, q1 waits.", "r1");
  expect(engine).toBe(1);
  expect(await row.find({ type: "Text", text: "●" })).toBeDefined();
  expect((await row.find({ key: "tags" }))?.text).toBe(
    "As [\\[\\[plan\\]\\]](https://threads.invalid/ref/plan) says, [q1](https://threads.invalid/ref/q1) waits.",
  );
  await row.press({
    key: "tags",
    link: { href: "https://threads.invalid/ref/q1" },
  } as never);
  expect(seen.opened).toContain("threads");
  const pane = await $.ui.mount(PANE);
  expect(
    await pane.find({ type: "Text", text: /^q1 in \[\[plan\]\]/ }),
  ).toBeDefined();
  await row.press({
    key: "tags",
    link: { href: "https://threads.invalid/ref/plan" },
  } as never);
  expect(
    await pane.find({ type: "Text", text: /^\[\[plan\]\] · open/ }),
  ).toBeDefined();
  // A summary of a reply keeps the engine's drawing, its references as written.
  const summary = $.ui.mount({
    plugin: "threads",
    component: "AssistantMessage",
    requestId: "r2",
    surface: "terminal",
    props: { text: "See q1.", isFirstOfReply: true, isSummary: true },
  } as never);
  await (await summary).unmount();
  expect(engine).toBe(2);
  await Promise.all([row, pane].map((m) => m.unmount()));
});

// A person's wheel over the docked pane's body, at a row of it.
const wheel = ($: Dollar, by: number, row?: number) =>
  $.ui.scroll({
    component: "Pane",
    requestId: "threads",
    offset: 0,
    by,
    bodyRows: 40,
    contentRows: 40,
    origin: { kind: "person" },
    ...(row === undefined ? {} : { pointer: { row, column: 3 } }),
  } as never);

test("docked, an open thread shows below the list, whose window keeps its titles pinned and its row in view, and a divider resizes it", async ($, on) => {
  const { store, clock } = world(on);
  on("ui.focus", { plugin: "*" } as never, async () => ({}) as never);
  await start($);
  const ids = Array.from(
    { length: 20 },
    (_, i) => `t${String(i + 1).padStart(2, "0")}`,
  );
  for (const id of ids)
    await $.tool.call({ tool: "mcp__threads__thread", id, title: id } as never);
  const pane = await $.ui.mount(PANE);
  const rows = async () => {
    const out: string[] = [];
    for (const id of ["main", ...ids])
      if (await pane.find({ type: "Button", key: `t:${id}` })) out.push(id);
    return out;
  };
  // The list alone fills the pane: all 21 rows fit.
  expect(await rows()).toHaveLength(21);
  await pane.press({ key: "t:t20" });
  // Open, the thread's view takes the foot, and the list its window above: a third of the pane,
  // moved to show the open thread's row.
  expect(
    await pane.find({ type: "Text", text: /^\[\[t20\]\] · open/ }),
  ).toBeDefined();
  expect(await rows()).toEqual(ids.slice(8, 20));
  expect(
    await pane.find({ type: "Text", text: /open · .* closed/ }),
  ).toBeDefined();
  expect(await pane.find({ key: "sort:id" })).toBeDefined();
  expect(
    await pane.find({ in: "divider", text: "9 above · 0 below" }),
  ).toBeDefined();
  // A double rule in the text's own color, not dim.
  const bar = (await pane.findAll({ in: "divider", type: "Text" }))[0];
  expect(bar?.text).toMatch(/^══ 9 above · 0 below ═+$/);
  expect(bar?.props.dimColor ?? false).toBe(false);
  // The open thread's id is drawn inverted in the list above it, and no other.
  const inverted = async (id: string) =>
    (await pane.findAll({ type: "Text" })).some(
      (x) => x.text?.trimEnd() === id && x.props.inverse === true,
    );
  expect(await inverted("t20")).toBe(true);
  expect(await inverted("t19")).toBe(false);
  // The thread's field stays the pane's first focusable.
  expect(focusables(await pane.drawn())[0]).toMatch(/^msg:t20:/);
  // The wheel over the list scrolls its window; over the thread's view, the view.
  await wheel($, -3, 4);
  expect(await rows()).toEqual(ids.slice(5, 17));
  await wheel($, -2, 30);
  expect(await rows()).toEqual(ids.slice(5, 17));
  // Dragged up four rows, the divider gives the list four fewer.
  await pane.pointer({ type: "down", x: 3, y: 0, button: "left" });
  await pane.pointer({ type: "move", x: 3, y: -4, button: "left" });
  await pane.pointer({ type: "up", x: 3, y: 0, button: "left" });
  expect(await rows()).toEqual(ids.slice(5, 13));
  expect(
    await pane.find({ in: "divider", text: "6 above · 7 below" }),
  ).toBeDefined();
  // The round button gives the list back the size it takes by itself, and is dim while it has it.
  const isAuto = async () =>
    (await pane.find({ key: "split:auto" }))?.props.dimColor === true;
  expect(await isAuto()).toBe(false);
  await pane.press({ key: "split:auto" });
  expect(await rows()).toHaveLength(12);
  expect(await isAuto()).toBe(true);
  // Held to a row at least, and to what the pane holds below the list at most.
  await pane.pointer({ type: "move", x: 3, y: -100, button: "left" });
  expect(await rows()).toHaveLength(1);
  await pane.pointer({ type: "move", x: 3, y: 100, button: "left" });
  expect(await rows()).toHaveLength(21);
  await pane.pointer({ type: "move", x: 3, y: -1, button: "left" });
  // The store keeps it, a moment after the last change, for every session; the round button forgets it.
  expect(store.get("listRows")).toBeUndefined();
  await clock.advance(1_000);
  expect(store.get("listRows")).toBe(20);
  await pane.press({ key: "split:auto" });
  expect(store.get("listRows")).toBeUndefined();
  await pane.pointer({ type: "move", x: 3, y: 8, button: "left" });
  expect(await rows()).toHaveLength(20);
  // The scroll keys move what the focus ring is on.
  await pane.pointer({ type: "move", x: 3, y: -12, button: "left" });
  const before = await rows();
  await $.ui.focus({
    component: "Pane",
    requestId: "threads",
    plugin: "threads",
    element: `t:${before[0]}`,
    origin: { kind: "person" },
  } as never);
  await wheel($, 2);
  expect((await rows())[0]).not.toBe(before[0]);
  const scrolled = await rows();
  await $.ui.focus({
    component: "Pane",
    requestId: "threads",
    plugin: "threads",
    element: "msg:t20:0",
    origin: { kind: "person" },
  } as never);
  await wheel($, 2);
  expect(await rows()).toEqual(scrolled);
  // Another thread opened from elsewhere, here a reference in a reply, brings its row into view.
  expect(await rows()).not.toContain("t01");
  const row = await $.ui.mount({
    plugin: "threads",
    component: "AssistantMessage",
    requestId: "r1",
    surface: "terminal",
    props: { text: "See [[t01]].", isFirstOfReply: true },
  } as never);
  await row.press({
    key: "tags",
    link: { href: "https://threads.invalid/ref/t01" },
  } as never);
  expect(await rows()).toContain("t01");
  await row.unmount();
  await pane.unmount();
});

test("docked, the list alone keeps its titles pinned and scrolls its rows; inline, the pane shows the list or the thread alone", async ($, on) => {
  const { store } = world(on);
  store.set("listRows", 5);
  await start($);
  const ids = Array.from(
    { length: 30 },
    (_, i) => `t${String(i + 1).padStart(2, "0")}`,
  );
  for (const id of ids)
    await $.tool.call({ tool: "mcp__threads__thread", id, title: id } as never);
  const pane = await $.ui.mount({
    ...PANE,
    props: { ...PANE.props, scroll: { offset: 0, bodyRows: 20 } },
  } as never);
  const has = async (key: string) =>
    (await pane.find({ type: "Button", key })) !== undefined;
  expect(await has("t:main")).toBe(true);
  expect(await has("t:t30")).toBe(false);
  await wheel($, 20, 10);
  expect(await has("t:main")).toBe(false);
  expect(await has("t:t30")).toBe(true);
  expect(
    await pane.find({ type: "Text", text: /open · .* closed/ }),
  ).toBeDefined();
  expect(await has("sort:age")).toBe(true);
  // The rows another session set for the list above a thread.
  await pane.press({ key: "t:t30" });
  expect(
    (await pane.findAll({ type: "Button" })).filter((x) =>
      x.key?.startsWith("t:"),
    ),
  ).toHaveLength(5);
  await pane.unmount();
  const inline = await $.ui.mount({
    ...PANE,
    props: { ...PANE.props, placement: "inline" },
  } as never);
  expect(await inline.find({ key: "t:t30" })).toBeUndefined();
  expect(await inline.find({ type: "Client" })).toBeUndefined();
  expect(
    await inline.find({ type: "Text", text: /^\[\[t30\]\] · open/ }),
  ).toBeDefined();
  await inline.unmount();
  // A docked pane too short for both shows the thread alone.
  const short = await $.ui.mount({
    ...PANE,
    props: { ...PANE.props, scroll: { offset: 0, bodyRows: 12 } },
  } as never);
  expect(await short.find({ key: "t:t30" })).toBeUndefined();
  expect(await short.find({ type: "Client" })).toBeUndefined();
  await short.unmount();
});

test("Back and Forward in the pane go through the places it showed, as a browser's do", async ($, on) => {
  world(on);
  await start($);
  for (const id of ["plan", "other"])
    await $.tool.call({ tool: "mcp__threads__thread", id, title: id } as never);
  await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "plan",
    question: "Approve?",
  } as never);
  await prompt($, "go", "p1");
  await reply($, "[[plan]]\nSee [[other]].", "r1");
  const pane = await $.ui.mount(PANE);
  const where = async () =>
    (await pane.find({ type: "Text", text: / · (open|closed|asked)/ }))?.text ??
    "list";
  const isDim = async (move: "back" | "forward") =>
    (await pane.find({ type: "Button", key: `hist:${move}` }))?.props
      .dimColor === true;
  // At the start there is nowhere to go either way: both are dim and do nothing.
  expect(await isDim("back")).toBe(true);
  expect(await isDim("forward")).toBe(true);
  await pane.press({ key: "hist:back" });
  expect(await where()).toBe("list");
  await pane.press({ key: "t:plan" });
  await pane.press({ key: "sub:q1" });
  expect(await where()).toMatch(/^q1 in \[\[plan\]\]/);
  // A link in the main view is a new place too.
  const row = await $.ui.mount({
    plugin: "threads",
    component: "AssistantMessage",
    requestId: "r1",
    surface: "terminal",
    props: { text: "[[plan]]\nSee [[other]].", isFirstOfReply: true },
  } as never);
  await row.press({
    key: "tags",
    link: { href: "https://threads.invalid/ref/other" },
  } as never);
  expect(await where()).toMatch(/^\[\[other\]\]/);
  expect(await isDim("back")).toBe(false);
  expect(await isDim("forward")).toBe(true);
  await pane.press({ key: "hist:back" });
  expect(await where()).toMatch(/^q1 in \[\[plan\]\]/);
  await pane.press({ key: "hist:back" });
  expect(await where()).toMatch(/^\[\[plan\]\]/);
  await pane.press({ key: "hist:back" });
  expect(await where()).toBe("list");
  expect(await isDim("back")).toBe(true);
  expect(await isDim("forward")).toBe(false);
  await pane.press({ key: "hist:forward" });
  await pane.press({ key: "hist:forward" });
  expect(await where()).toMatch(/^q1 in \[\[plan\]\]/);
  // A new place drops the places ahead.
  await pane.press({ key: "back" });
  expect(await where()).toMatch(/^\[\[plan\]\]/);
  expect(await isDim("forward")).toBe(true);
  await pane.press({ key: "hist:forward" });
  expect(await where()).toMatch(/^\[\[plan\]\]/);
  await pane.press({ key: "hist:back" });
  expect(await where()).toMatch(/^q1 in \[\[plan\]\]/);
  await Promise.all([row, pane].map((m) => m.unmount()));
});

test("a tag in the main view opens its thread at the section, and a shared message links to its other threads", async ($, on) => {
  const { seen } = world(on);
  await start($);
  for (const id of ["plan", "other"])
    await $.tool.call({ tool: "mcp__threads__thread", id, title: id } as never);
  await prompt($, "go", "p1");
  const text = "[[plan]]\nStep one.\n\n[[plan]] [[other]]\nShared.";
  await reply($, text, "r1");
  const row = await $.ui.mount({
    plugin: "threads",
    component: "AssistantMessage",
    requestId: "r1",
    surface: "terminal",
    props: { text, isFirstOfReply: true },
  } as never);
  await row.press({
    key: "tags",
    link: { href: "https://threads.invalid/1/other" },
  } as never);
  expect(seen.opened).toContain("threads");
  const pane = await $.ui.mount(PANE);
  // Opened at the section, marked, with the other thread holding it a press away.
  const anchor = await pane.find({ key: "anchor" });
  expect(anchor?.text).toContain("Shared.");
  expect(anchor?.text).toContain("▶");
  expect(await pane.find({ key: "home" })).toBeUndefined();
  const also = (await pane.findAll({ type: "Button" })).find((x) =>
    x.key?.startsWith("also:"),
  );
  expect(also?.text).toBe("[[plan]]");
  await pane.press({ key: also!.key! });
  expect((await pane.find({ key: "anchor" }))?.text).toContain("Shared.");
  expect(
    await pane.find({ type: "Text", text: /^\[\[plan\]\] · open/ }),
  ).toBeDefined();
  // In plan, only the shared message links elsewhere: Step one. is plan's alone.
  const links = (await pane.findAll({ type: "Button" })).filter((x) =>
    x.key?.startsWith("also:"),
  );
  expect(links.map((x) => x.text)).toEqual(["[[other]]"]);
  await Promise.all([row, pane].map((m) => m.unmount()));
});

test("a checklist question toggles its picks and shows the preview of the last one picked", async ($, on) => {
  const { seen } = world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "db",
    title: "Cache store",
  } as never);
  await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "db",
    question: "Which stores?",
    kind: "checklist",
    options: [
      { label: "JSON", description: "No dependencies." },
      { label: "SQLite", preview: "create table cache" },
    ],
  } as never);
  const pane = await $.ui.mount(PANE);
  await pane.press({ key: "t:db" });
  expect(
    await pane.find({ type: "Text", text: "No dependencies." }),
  ).toBeDefined();
  await pane.press({ key: "opt:q1:0" });
  await pane.press({ key: "opt:q1:1" });
  expect(
    (await pane.find({ type: "Button", key: "opt:q1:0" }))?.text,
  ).toContain("[x] JSON");
  expect(
    await pane.find({ type: "Markdown", text: "create table cache" }),
  ).toBeDefined();
  await pane.press({ key: "opt:q1:1" });
  expect(
    await pane.find({ type: "Markdown", text: "create table cache" }),
  ).toBeUndefined();
  await pane.press({ key: "opt:q1:1" });
  await pane.press({ key: "send" });
  expect(seen.prompts.at(-1)).toBe("[[db]] q1: JSON, SQLite");
  // A checklist may be sent with nothing checked, while nothing is.
  await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "db",
    question: "Which did you clear?",
    kind: "checklist",
    options: ["Cache dir", "Lock file"],
  } as never);
  await pane.press({ key: "opt:q2:0" });
  expect(await pane.find({ type: "Button", key: "none:q2" })).toBeUndefined();
  await pane.press({ key: "opt:q2:0" });
  await pane.press({ key: "none:q2" });
  expect(seen.prompts.at(-1)).toBe("[[db]] q2: none checked");
  // Settled, each shows in the history as the question with its picks marked.
  await $.tool.call({
    tool: "mcp__threads__settle",
    question: "q1",
    answer: "JSON, SQLite",
  } as never);
  await $.tool.call({
    tool: "mcp__threads__settle",
    question: "q2",
    answer: "none checked",
  } as never);
  expect(await pane.find({ type: "Text", text: "[x] JSON" })).toBeDefined();
  expect(await pane.find({ type: "Text", text: "[x] SQLite" })).toBeDefined();
  expect(
    await pane.find({ type: "Text", text: "[ ] Lock file" }),
  ).toBeDefined();
  expect(
    await pane.find({ type: "Text", text: "None checked." }),
  ).toBeDefined();
  // Retracted, it draws the same way under a gray Retracted, with the reason and no picks guessed from it.
  await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "db",
    question: "Which cache to drop?",
    kind: "checklist",
    options: ["Disk", "Memory"],
  } as never);
  await $.tool.call({
    tool: "mcp__threads__settle",
    question: "q3",
    retract: "Tabled: Disk and Memory both wait on data",
  } as never);
  expect(await pane.find({ type: "Text", text: "Retracted" })).toBeDefined();
  expect(await pane.find({ type: "Text", text: "[ ] Disk" })).toBeDefined();
  expect(
    await pane.find({ type: "Text", text: /Retracted: Tabled/ }),
  ).toBeDefined();
  // Settled the wrong way, an answered question corrected to retracted redraws as Retracted, the
  // user's picks still marked.
  await $.tool.call({
    tool: "mcp__threads__settle",
    question: "q1",
    retract: "Tabled",
  } as never);
  expect(
    await pane.find({ type: "Text", text: "Retracted: Tabled" }),
  ).toBeDefined();
  expect(await pane.find({ type: "Text", text: "[x] JSON" })).toBeDefined();
  await pane.unmount();
});

test("the thread list lines its rows up in columns sized to the pane", async ($, on) => {
  world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "db",
    title: "A very long title that will not fit the column",
  } as never);
  await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "db",
    question: "Which?",
  } as never);
  const pane = await $.ui.mount(PANE);
  const rows = [
    (await pane.find({ type: "Button", key: "t:main" }))!.text,
    (await pane.find({ type: "Button", key: "t:db" }))!.text,
  ];
  expect(rows[0].length).toBe(rows[1].length);
  expect(rows[0]).toMatch(/ now$/);
  expect(rows[0].length).toBeLessThanOrEqual(PANE.props.bodyColumns);
  expect(rows[1]).toContain("…");
  // The count of questions waiting leads the row, beside the toggle that unfolds them.
  expect(rows[1].startsWith("?1")).toBe(true);
  await pane.unmount();
});

test("the thread list shows each thread's status in a column, cut to fit, and drops it before it would cut a title", async ($, on) => {
  world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "db",
    title: "Database",
    status: "Waiting on the migration review, then the release.",
  } as never);
  const wide = await $.ui.mount({
    ...PANE,
    props: { ...PANE.props, bodyColumns: 80 },
  });
  const db = (await wide.find({ type: "Button", key: "t:db" }))!.text;
  const main = (await wide.find({ type: "Button", key: "t:main" }))!.text;
  expect(db).toContain("Database");
  expect(db).toContain("Waiting on the migration");
  expect(db.length).toBe(main.length);
  expect(db.length).toBeLessThanOrEqual(80);
  expect(JSON.stringify(await wide.drawn())).toMatch(/"status +"/);
  await wide.unmount();
  const narrow = await $.ui.mount({
    ...PANE,
    props: { ...PANE.props, bodyColumns: 54 },
  });
  // Too narrow for a useful status beside the whole longest title: the titles keep the room.
  const cut = (await narrow.find({ type: "Button", key: "t:db" }))!.text;
  expect(cut).not.toContain("Waiting");
  const whole = (await narrow.find({ type: "Button", key: "t:main" }))!.text;
  expect(whole).toContain("The session as a whole");
  expect(JSON.stringify(await narrow.drawn())).not.toMatch(/"status +"/);
  await narrow.unmount();
});

test("pressing a column title sorts the list by it, again turns it round, and the title shows which", async ($, on) => {
  world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "beta",
    title: "Beta",
  } as never);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "alpha",
    title: "Alpha",
  } as never);
  const pane = await $.ui.mount({
    ...PANE,
    props: { ...PANE.props, bodyColumns: 80 },
  });
  const order = async () =>
    (await pane.findAll({ type: "Button" }))
      .map((x) => (x as { key?: string }).key ?? "")
      .filter((k) => k.startsWith("t:"));
  expect(await order()).toEqual(["t:main", "t:beta", "t:alpha"]);
  await pane.press({ key: "sort:id" });
  expect(await order()).toEqual(["t:main", "t:alpha", "t:beta"]);
  expect((await pane.find({ type: "Button", key: "sort:id" }))!.text).toContain(
    "id▲",
  );
  await pane.press({ key: "sort:id" });
  expect(await order()).toEqual(["t:main", "t:beta", "t:alpha"]);
  expect((await pane.find({ type: "Button", key: "sort:id" }))!.text).toContain(
    "id▼",
  );
  expect(
    (await pane.find({ type: "Button", key: "sort:title" }))!.text,
  ).not.toMatch(/[▲▼]/);
  await pane.unmount();
});

test("real row shapes: the prompt row's own text, a context row, a turn of thinking and tools, a mid-turn message, a pane-sent answer", async ($, on) => {
  const { store } = world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    title: "Plan",
  } as never);
  const append = (row: object) => $.session.append(row as never);
  // The book as the store keeps it, which a turn's end writes.
  type Kept = {
    turn: { n: number; prompt?: { text: string }; untagged: unknown[] };
    messages: {
      kind: string;
      text: string;
      uuid?: string;
      threads: string[];
      home: string[];
    }[];
  };
  let held: Kept = undefined as never;
  const book = () => held;
  const look = async () => {
    await $.classic.Stop({ stop_hook_active: true } as never);
    held = store.get(`book:${ID}`) as Kept;
  };
  // A typed prompt: prompt.submit attaches context, which arrives as a row of its own.
  await $.prompt.submit({
    text: "Plan the parser",
    origin: { kind: "composer" },
  } as never);
  await append({
    message: {
      type: "user",
      role: "user",
      content: [{ type: "text", text: "Plan the parser" }],
    },
    door: "prompt",
    origin: { kind: "composer" },
    uuid: "p1",
  });
  await append({
    message: {
      type: "attachment",
      name: "hook_additional_context",
      content: [{ type: "text", text: "[threads] Open threads: ..." }],
    },
    door: "attachment",
    origin: { kind: "plugin", name: "threads" },
    uuid: "c1",
  });
  // A response of thinking and tool calls holds no reply text.
  await append({
    message: {
      type: "assistant",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "x" },
        { type: "tool_use", id: "t1", name: "Bash", input: {} },
      ],
    },
    door: "response",
    origin: { kind: "model", model: "claude-opus-5-5" },
    uuid: "r1",
  });
  await reply($, "[[plan]]\nDrafting.", "r2");
  // A message typed over the running turn joins it as a queued_command attachment.
  await $.prompt.submit({
    text: "Keep the old lexer",
    turnId: "turn-1",
    origin: { kind: "composer" },
  } as never);
  // A background task's notification is delivered the same way, and is not the person's message.
  const notice =
    "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>";
  await $.prompt.submit({
    text: notice,
    turnId: "turn-1",
    origin: { kind: "task-notification" },
  } as never);
  await append({
    message: {
      type: "attachment",
      name: "queued_command",
      content: [{ type: "text", text: notice }],
    },
    door: "attachment",
    origin: { kind: "task-notification" },
    uuid: "n1row",
  });
  await append({
    message: {
      type: "attachment",
      name: "queued_command",
      content: [
        {
          type: "text",
          text: "<system-reminder>\nThe user sent a new message while you were working:\nKeep the old lexer\n\nThis is how Claude Code surfaces messages the user sends mid-turn.\n</system-reminder>",
        },
      ],
    },
    door: "attachment",
    origin: { kind: "composer" },
    uuid: "q1row",
  });
  // The messages a thread holds, in order.
  const heldBy = (id: string) =>
    book().messages.filter((m) => m.threads.includes(id));
  await look();
  // Untagged, the prompt and the mid-turn message go under main alone.
  expect(heldBy("plan").at(-1)).toEqual(
    expect.objectContaining({ kind: "reply", text: "Drafting.", uuid: "r2" }),
  );
  expect(
    heldBy("main")
      .filter((x) => x.kind === "prompt")
      .map((x) => [x.text, x.uuid]),
  ).toEqual([
    ["Plan the parser", "p1"],
    ["Keep the old lexer", "q1row"],
  ]);
  // Filed under plan as well, they show there as from the main session. The turn holds two of the
  // user's messages, so each is named by quote.
  for (const quote of ["Plan the parser", "Keep the old lexer"])
    await $.tool.call({
      tool: "mcp__threads__file",
      threads: ["plan"],
      prompts: true,
      quote,
    } as never);
  await look();
  expect(
    heldBy("plan")
      .filter((x) => !x.home.includes("plan"))
      .map((x) => [x.text, x.home]),
  ).toEqual([
    ["Plan the parser", ["main"]],
    ["Keep the old lexer", ["main"]],
  ]);
  const pane = await $.ui.mount(PANE);
  await pane.press({ key: "t:plan" });
  expect(await pane.find({ type: "Text", text: "in [[main]]" })).toBeDefined();
  await pane.unmount();
  await look();
  expect(book().turn.untagged).toEqual([]);
  // The pane's own prompt reaches the plugin as a row alone: its prompt.submit hook does not run on it.
  await append({
    message: {
      type: "user",
      role: "user",
      content: [{ type: "text", text: "[[plan]] q1: Approve" }],
    },
    door: "prompt",
    origin: { kind: "plugin", name: "threads", asUser: true },
    uuid: "p2",
  });
  await look();
  expect(book().turn.prompt?.text).toBe("[[plan]] q1: Approve");
  expect(heldBy("plan").at(-1)).toEqual(
    expect.objectContaining({
      kind: "prompt",
      text: "[[plan]] q1: Approve",
      uuid: "p2",
    }),
  );
  // A notification that starts a turn of its own starts it with no prompt,
  // filed nowhere.
  await append({
    message: {
      type: "user",
      role: "user",
      content: [{ type: "text", text: notice }],
    },
    door: "prompt",
    origin: { kind: "task-notification" },
    uuid: "n2row",
  });
  await look();
  expect(book().turn.prompt).toBeUndefined();
  expect(
    book().messages.some((x) => x.text.includes("task-notification")),
  ).toBe(false);
});

test("docked, a long summary is cut in the pinned head, and Details shows it whole in place of the history", async ($, on) => {
  world(on);
  await start($);
  const long = Array.from(
    { length: 8 },
    (_, i) => `Sentence ${i + 1} of a summary that runs on for a while.`,
  ).join(" ");
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "db",
    title: "Cache store",
    summary: long,
  } as never);
  const pane = await $.ui.mount(PANE);
  await pane.press({ key: "t:db" });
  const head = await pane.find({ type: "Markdown", text: /^Sentence 1/ });
  expect(head?.text.endsWith("…")).toBe(true);
  expect(await pane.find({ type: "Text", text: "History" })).toBeDefined();
  await pane.press({ key: "details" });
  expect(await pane.find({ type: "Markdown", text: long })).toBeDefined();
  expect(await pane.find({ type: "Text", text: "History" })).toBeUndefined();
  await pane.press({ key: "details" });
  expect(await pane.find({ type: "Text", text: "History" })).toBeDefined();
  await pane.unmount();
});

test("the transcript draws nothing for a threads call that went through", async ($, on) => {
  world(on);
  on("ui.render", async ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>engine row</Text>;
  });
  const drawn = async (
    component: "ToolUse" | "ToolResult",
    props: Record<string, unknown>,
  ) => {
    const row = await $.ui.mount({
      plugin: "threads",
      component,
      requestId: "t1",
      surface: "terminal",
      props: { tool_use_id: "t1", input: {}, output: "ok", ...props },
    } as never);
    const engine = await row.find({ type: "Text", text: "engine row" });
    await row.unmount();
    return engine !== undefined;
  };
  const call = { isRunning: false, isErrored: false, isInterrupted: false };
  expect(await drawn("ToolUse", { ...call, tool: "mcp__threads__ask" })).toBe(
    false,
  );
  expect(
    await drawn("ToolResult", { tool: "mcp__threads__file", isErrored: false }),
  ).toBe(false);
  expect(
    await drawn("ToolUse", {
      ...call,
      tool: "mcp__threads__ask",
      isErrored: true,
    }),
  ).toBe(true);
  expect(
    await drawn("ToolResult", { tool: "mcp__threads__ask", isErrored: true }),
  ).toBe(true);
  expect(
    await drawn("ToolUse", {
      ...call,
      tool: "mcp__threads__settle",
      isExpanded: true,
    }),
  ).toBe(true);
  expect(await drawn("ToolUse", { ...call, tool: "Bash" })).toBe(true);
});

test("the list marks a thread ◌ while a message sent to it from the pane has not reached Claude", async ($, on) => {
  world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    title: "The plan",
    status: "Testing the plan.",
  } as never);
  const pane = await $.ui.mount({
    ...PANE,
    props: { ...PANE.props, bodyColumns: 80 },
  });
  expect(
    (await pane.find({ type: "Button", key: "t:plan" }))!.text,
  ).not.toContain("◌");
  await pane.press({ key: "t:plan" });
  await pane.input({ key: "msg:plan:0", text: "One more thought" });
  await pane.press({ key: "t:plan" });
  const row = (await pane.find({ type: "Button", key: "t:plan" }))!.text;
  expect(row).toContain("◌ Testing the plan.");
  // The ring has a column of its own: the verbs of marked and unmarked rows line up.
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "other",
    title: "Other",
    status: "Building it.",
  } as never);
  const other = (await pane.find({ type: "Button", key: "t:other" }))!.text;
  const plan = (await pane.find({ type: "Button", key: "t:plan" }))!.text;
  expect(other.indexOf("Building")).toBe(plan.indexOf("Testing"));
  expect(
    (await pane.find({ type: "Button", key: "t:main" }))!.text,
  ).not.toContain("◌");
  await $.session.append({
    message: {
      type: "user",
      role: "user",
      content: [{ type: "text", text: "[[plan]] One more thought" }],
    },
    door: "prompt",
    origin: { kind: "plugin", name: "threads", asUser: true },
    uuid: "u1",
  } as never);
  expect(
    (await pane.find({ type: "Button", key: "t:plan" }))!.text,
  ).not.toContain("◌");
  await pane.unmount();
});

test("a message sent from the pane draws dim in its thread until its row is recorded", async ($, on) => {
  world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    title: "The plan",
  } as never);
  const pane = await $.ui.mount(PANE);
  await pane.press({ key: "t:plan" });
  await pane.input({ key: "msg:plan:0", text: "One more thought" });
  expect(
    await pane.find({ type: "Text", text: /not seen by Claude yet/ }),
  ).toBeDefined();
  expect(
    await pane.find({ type: "Text", text: "[[plan]] One more thought" }),
  ).toBeDefined();
  await $.session.append({
    message: {
      type: "user",
      role: "user",
      content: [{ type: "text", text: "[[plan]] One more thought" }],
    },
    door: "prompt",
    origin: { kind: "plugin", name: "threads", asUser: true },
    uuid: "u1",
  } as never);
  expect(
    await pane.find({ type: "Text", text: /not seen by Claude yet/ }),
  ).toBeUndefined();
  expect(
    await pane.find({ type: "Markdown", text: "[[plan]] One more thought" }),
  ).toBeDefined();
  await pane.unmount();
});

test("the thread list marks a thread unread until the user has had it open", async ($, on) => {
  const { clock } = world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "demo",
    title: "Demo",
  } as never);
  const pane = await $.ui.mount(PANE);
  const rowText = async () =>
    (await pane.find({ type: "Button", key: "t:demo" }))?.text ?? "";
  // Opened, it holds no news yet; what Claude says there is.
  expect(await rowText()).not.toContain("●");
  await reply($, "[[demo]]\nStarted.", "r-demo");
  expect(await rowText()).toContain("●");
  expect(await pane.find({ type: "Text", text: /1 unread/ })).toBeDefined();
  await pane.press({ key: "t:demo" });
  await pane.press({ key: "t:demo" });
  expect(await rowText()).not.toContain("●");
  expect(await pane.find({ type: "Text", text: /0 unread/ })).toBeDefined();
  await clock.advance(60_000);
  await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "demo",
    question: "Go on?",
  } as never);
  expect(await rowText()).toContain("●");
  await pane.unmount();
});

test("the band names unread threads other than main, until the user has had them open", async ($, on) => {
  world(on);
  on("ui.render", async ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>engine</Text>;
  });
  await start($);
  const BAND = {
    plugin: "threads",
    component: "AbovePrompt",
    requestId: "band",
    surface: "terminal",
    props: {
      hasSurvey: false,
      isCollapsed: false,
      isWorking: false,
      maxRows: 5,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 5 },
      view: {},
    },
  } as const;
  // Main gains entries with every reply, so it alone never raises the band.
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "main",
    summary: "Going.",
  } as never);
  const quiet = await $.ui.mount(BAND as never);
  expect((await quiet.find({ type: "Text" }))?.text).toBe("engine");
  await quiet.unmount();
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    title: "The plan",
  } as never);
  await reply($, "[[plan]]\nStarted.", "r-plan");
  const band = await $.ui.mount(BAND as never);
  expect(await band.find({ type: "Text", text: /1 unread/ })).toBeDefined();
  expect(await band.find({ type: "Button", key: "band:plan" })).toBeDefined();
  expect(await band.find({ type: "Text", text: "The plan" })).toBeDefined();
  await band.unmount();
  const pane = await $.ui.mount(PANE);
  await pane.press({ key: "t:plan" });
  await pane.press({ key: "t:plan" });
  await pane.unmount();
  const after = await $.ui.mount(BAND as never);
  expect((await after.find({ type: "Text" }))?.text).toBe("engine");
  await after.unmount();
});

test("the thread list redraws its ages as time passes, with nothing else changing", async ($, on) => {
  const { clock } = world(on);
  await start($);
  const pane = await $.ui.mount(PANE);
  const age = async () =>
    (await pane.find({ type: "Button", key: "t:main" }))?.text ?? "";
  expect(await age()).toContain("now");
  await clock.advance(5 * 60_000);
  expect(await age()).toContain("5m");
  await pane.unmount();
});

test("a reply in the transcript shows a mark per thread it is unread in, gone once read, and a thread whose replies are all read is read", async ($, on) => {
  const { clock } = world(on);
  on("ui.render", async ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>engine</Text>;
  });
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    title: "Plan",
  } as never);
  await clock.advance(1000);
  await prompt($, "go", "p1");
  await reply($, "[[plan]]\nStep one.\n\n[[main]]\nAside.", "r1");
  await clock.advance(1000);
  await prompt($, "more", "p2");
  await reply($, "[[plan]]\nStep two.", "r2");
  const row = (requestId: string) =>
    $.ui.mount({
      plugin: "threads",
      component: "AssistantMessage",
      requestId,
      surface: "terminal",
      // A summary row, drawn by the engine, marks its threads below it.
      props: { text: "[[plan]]\nStep.", isFirstOfReply: true, isSummary: true },
    } as never);
  const pane = await $.ui.mount(PANE);
  const planRow = async () =>
    (await pane.find({ type: "Button", key: "t:plan" }))?.text ?? "";
  expect(await planRow()).toContain("●");
  const r1 = await row("r1");
  const mark = async (r: typeof r1, id: string) =>
    (await r.find({ type: "Button", key: `read:${id}` }))?.text;
  // A mark per thread the reply files an unread section under, each on its own.
  expect(await mark(r1, "plan")).toBe("○ plan");
  expect(await mark(r1, "main")).toBe("○ main");
  expect(await r1.find({ type: "Text", text: "unread:" })).toBeDefined();
  await r1.press({ key: "read:plan" });
  expect(await mark(r1, "plan")).toBeUndefined();
  expect(await mark(r1, "main")).toBe("○ main");
  // The plan's opening event and its first reply are read; its second reply is not yet.
  expect(await planRow()).toContain("●");
  const r2 = await row("r2");
  expect(await mark(r2, "main")).toBeUndefined();
  await r2.press({ key: "read:plan" });
  expect(await planRow()).not.toContain("●");
  // With every thread's sections read, the row draws no marks at all.
  expect(await r2.find({ type: "Text", text: "unread:" })).toBeUndefined();
  // Marking plan left main's own section of r1 unread, until its own mark is pressed.
  await r1.press({ key: "read:main" });
  expect(await r1.find({ type: "Text", text: "unread:" })).toBeUndefined();
  // A row no thread holds gets no mark.
  const other = await row("x9");
  expect(await other.find({ type: "Text", text: "unread:" })).toBeUndefined();
  await Promise.all([r1, r2, other, pane].map((m) => m.unmount()));
});

test("a question draws where Claude asked it in the transcript, to answer there", async ($, on) => {
  const { seen } = world(on);
  const filled: string[] = [];
  let box = "";
  on("prompt.fill", async ($, e) => {
    filled.push(e.text);
    box = e.mode === "append" ? box + e.text : e.text;
    return { isFilled: true } as never;
  });
  on(
    "prompt.read",
    async () => ({ value: { text: box, cursor: box.length } }) as never,
  );
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "db",
    title: "Cache store",
  } as never);
  const output = await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "db",
    question: "Which store?",
    options: [{ label: "JSON" }, { label: "SQLite" }],
  } as never);
  const row = await $.ui.mount({
    plugin: "threads",
    component: "ToolUse",
    requestId: "t1",
    surface: "terminal",
    props: {
      tool_use_id: "t1",
      tool: "mcp__threads__ask",
      input: {},
      output,
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
    },
  } as never);
  expect(
    await row.find({ type: "Text", text: /Waiting on you/ }),
  ).toBeDefined();
  expect(await row.find({ type: "Button", key: "send:q1" })).toBeUndefined();
  // No field: a transcript row never holds the keyboard. The note goes in the prompt box instead.
  await row.press({ key: "opt:q1:0" });
  await row.press({ key: "note:q1" });
  expect(filled).toEqual(["q1: "]);
  // Started in the prompt, the answer goes from there alone: no Send button, and no second line.
  expect(await row.find({ type: "Button", key: "send:q1" })).toBeUndefined();
  await row.press({ key: "note:q1" });
  expect(filled).toEqual(["q1: "]);
  // The picks stay on the card, to change while the note is written, and join the note when it goes.
  expect((await row.find({ type: "Button", key: "opt:q1:0" }))?.text).toContain(
    "(•) JSON",
  );
  await row.press({ key: "opt:q1:1" });
  expect((await row.find({ type: "Button", key: "opt:q1:1" }))?.text).toContain(
    "(•) SQLite",
  );
  await prompt($, "q1: fast lookups", "u1");
  expect(seen.prompts.at(-1)).toBe("q1: SQLite (fast lookups)");
  expect(await row.find({ type: "Text", text: /you replied/ })).toBeDefined();
  await $.tool.call({
    tool: "mcp__threads__settle",
    question: "q1",
    answer: "SQLite",
  } as never);
  expect(
    await row.find({ type: "Text", text: /answered: SQLite/ }),
  ).toBeDefined();
  expect(await row.find({ type: "Button", key: "opt:q1:0" })).toBeUndefined();
  await row.unmount();
});

test("no transcript row the plugin draws holds a field, since a transcript row never takes the keys", async ($, on) => {
  world(on);
  on("ui.render", async ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>engine</Text>;
  });
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "db",
    title: "Cache store",
  } as never);
  await prompt($, "go", "p1");
  await reply($, "[[db]]\nWhich?", "r1");
  const free = await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "db",
    question: "Why?",
  } as never);
  const choice = await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "db",
    question: "Which?",
    kind: "checklist",
    options: [{ label: "JSON" }, { label: "SQLite" }],
  } as never);
  const call = {
    tool_use_id: "t1",
    tool: "mcp__threads__ask",
    input: {},
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
  };
  const rows: [string, Record<string, unknown>, string][] = [
    ["ToolUse", { ...call, output: free }, "t1"],
    ["ToolUse", { ...call, output: choice }, "t2"],
    ["ToolResult", { ...call, output: choice }, "t2"],
    [
      "AssistantMessage",
      { text: "[[db]]\nWhich?", isFirstOfReply: true },
      "r1",
    ],
    [
      "UserMessage",
      { text: "go", origin: { kind: "composer" }, isExpanded: false },
      "p1",
    ],
  ];
  for (const [component, props, requestId] of rows) {
    const row = await $.ui.mount({
      plugin: "threads",
      component,
      requestId,
      surface: "terminal",
      props,
    } as never);
    expect(await row.find({ type: "Input" })).toBeUndefined();
    expect(await row.find({ type: "Select" })).toBeUndefined();
    await row.unmount();
  }
});

test("a question the user replied to leaves Waiting on you, and a revision brings it back as clarified", async ($, on) => {
  world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "db",
    title: "Cache store",
  } as never);
  const asked = await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "db",
    question: "Which store?",
    options: [{ label: "JSON" }, { label: "SQLite" }],
  } as never);
  const toolRow = (output: unknown, requestId: string) =>
    $.ui.mount({
      plugin: "threads",
      component: "ToolUse",
      requestId,
      surface: "terminal",
      props: {
        tool_use_id: "t",
        tool: "mcp__threads__ask",
        input: {},
        output,
        isRunning: false,
        isErrored: false,
        isInterrupted: false,
      },
    } as never);
  const first = await toolRow(asked, "t1");
  const pane = await $.ui.mount(PANE);
  const listRow = async () =>
    (await pane.find({ type: "Button", key: "t:db" }))?.text ?? "";
  expect(await listRow()).toContain("?1");
  // Asked about at the prompt, it waits on Claude, and the context says how to clear it.
  const entered = await prompt($, "q1: what is the difference?", "u1");
  const context = (
    (entered as { context?: readonly string[] }).context ?? []
  ).join("\n");
  expect(context).toContain("revise: q1");
  expect(await listRow()).not.toContain("?1");
  expect(await first.find({ type: "Text", text: /you replied/ })).toBeDefined();
  // Revised, it keeps its id, waits on the user again, and the first row points to the new one.
  const revised = await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "db",
    question: "Which store: JSON (no dependencies) or SQLite (fast lookups)?",
    options: [{ label: "JSON" }, { label: "SQLite" }],
    revise: "q1",
  } as never);
  expect(JSON.stringify(revised)).toContain("Revised q1");
  expect(await listRow()).toContain("?1");
  expect(
    await first.find({ type: "Text", text: /was revised below/ }),
  ).toBeDefined();
  const second = await toolRow(revised, "t2");
  expect(
    await second.find({ type: "Markdown", text: /fast lookups/ }),
  ).toBeDefined();
  expect(await second.find({ type: "Button", key: "opt:q1:0" })).toBeDefined();
  // A settled question cannot be revised.
  await $.tool.call({
    tool: "mcp__threads__settle",
    question: "q1",
    answer: "SQLite",
  } as never);
  const late = await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "db",
    question: "Again?",
    revise: "q1",
  } as never);
  expect(JSON.stringify(late)).toContain("already answered");
  await Promise.all([first, second, pane].map((m) => m.unmount()));
});

test("the note button adds its line below what the prompt box holds, never over it", async ($, on) => {
  world(on);
  let box = "draft about something else";
  on("prompt.fill", async ($, e) => {
    box = e.mode === "append" ? box + e.text : e.text;
    return { isFilled: true } as never;
  });
  on(
    "prompt.read",
    async () => ({ value: { text: box, cursor: box.length } }) as never,
  );
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "db",
    title: "Cache store",
  } as never);
  const output = await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "db",
    question: "Why?",
  } as never);
  const row = await $.ui.mount({
    plugin: "threads",
    component: "ToolUse",
    requestId: "t1",
    surface: "terminal",
    props: {
      tool_use_id: "t1",
      tool: "mcp__threads__ask",
      input: {},
      output,
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
    },
  } as never);
  await row.press({ key: "note:q1" });
  expect(box).toBe("draft about something else\nq1: ");
  await row.unmount();
});

test("opening a thread marks each of its messages read, in every thread that holds it", async ($, on) => {
  world(on);
  on("ui.render", async ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>engine</Text>;
  });
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    title: "Plan",
  } as never);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "other",
    title: "Other",
  } as never);
  await prompt($, "go", "p1");
  await reply($, "[[plan]] [[other]]\nShared.", "r1");
  await prompt($, "more", "p2");
  await reply($, "[[other]]\nOnly other.", "r2");
  const pane = await $.ui.mount(PANE);
  const listRow = async (id: string) =>
    (await pane.find({ type: "Button", key: `t:${id}` }))?.text ?? "";
  expect(await listRow("other")).toContain("●");
  await pane.press({ key: "t:plan" });
  await pane.press({ key: "t:plan" });
  // The shared reply is read in other too, so its row has no mark for other; other's own reply is unread.
  const row = await $.ui.mount({
    plugin: "threads",
    component: "AssistantMessage",
    requestId: "r1",
    surface: "terminal",
    props: { text: "Shared.", isFirstOfReply: true },
  } as never);
  expect(await row.find({ type: "Button", key: "read:other" })).toBeUndefined();
  expect(await listRow("other")).toContain("●");
  await pane.press({ key: "t:other" });
  await pane.press({ key: "t:other" });
  expect(await listRow("other")).not.toContain("●");
  await Promise.all([row, pane].map((m) => m.unmount()));
});

test("the recommended option is marked on the question's card", async ($, on) => {
  world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "db",
    title: "Cache store",
  } as never);
  await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "db",
    question: "Which store?",
    options: [{ label: "JSON" }, { label: "SQLite", recommended: true }],
  } as never);
  const pane = await $.ui.mount(PANE);
  await pane.press({ key: "t:db" });
  expect(
    (await pane.find({ type: "Button", key: "opt:q1:1" }))?.text,
  ).toContain("SQLite (recommended)");
  expect(
    (await pane.find({ type: "Button", key: "opt:q1:0" }))?.text,
  ).not.toContain("recommended");
  await pane.unmount();
});

test("a thread opens at its first unread message, under a divider, and at its latest once all is read", async ($, on) => {
  world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    title: "Plan",
  } as never);
  for (let i = 1; i <= 6; i++) {
    await prompt($, `go ${i}`, `p${i}`);
    await reply($, `[[plan]]\nRead ${i}.`, `r${i}`);
  }
  const pane = await $.ui.mount({
    ...PANE,
    props: { ...PANE.props, scroll: { offset: 0, bodyRows: 20 } },
  } as never);
  await pane.press({ key: "t:plan" });
  await pane.press({ key: "t:plan" });
  for (let i = 7; i <= 14; i++) {
    await prompt($, `go ${i}`, `p${i}`);
    await reply($, `[[plan]]\nNew ${i}.`, `r${i}`);
  }
  await pane.press({ key: "t:plan" });
  const order = (await pane.findAll({})).flatMap((x) =>
    x.key === "unread"
      ? ["divider"]
      : x.type === "Markdown" && /^(Read|New) \d+\.$/.test(x.text)
        ? [x.text]
        : [],
  );
  // The divider sits above the first unread message, and the history reaches back past it.
  expect(
    order.slice(order.indexOf("divider") - 1, order.indexOf("divider") + 2),
  ).toEqual(["Read 6.", "divider", "New 7."]);
  // Docked, the view is lifted so the divider shows, not held at the latest message.
  expect(
    await pane.find({ type: "Text", text: /▾ \d+ more rows/ }),
  ).toBeDefined();
  // Messages that come while it is open, however many, and one filed in its place above, leave the
  // divider above the same message.
  for (let i = 15; i <= 30; i++) {
    await prompt($, `go ${i}`, `p${i}`);
    await reply($, `[[plan]]\nNew ${i}.`, `r${i}`);
  }
  await prompt($, "[[plan]] file go 1 here", "p31");
  await $.tool.call({
    tool: "mcp__threads__file",
    threads: ["plan"],
    quote: "go 1",
    prompts: true,
  } as never);
  const after = (await pane.findAll({})).flatMap((x) =>
    x.key === "unread"
      ? ["divider"]
      : x.type === "Markdown" && /^(Read|New) \d+\.$/.test(x.text)
        ? [x.text]
        : [],
  );
  expect(
    after.slice(after.indexOf("divider") - 1, after.indexOf("divider") + 2),
  ).toEqual(["Read 6.", "divider", "New 7."]);
  // Opened again with all of it read, it shows its latest, with no divider.
  await pane.press({ key: "t:plan" });
  await pane.press({ key: "t:plan" });
  expect(await pane.find({ key: "unread" })).toBeUndefined();
  expect(
    await pane.find({ type: "Text", text: /▾ \d+ more rows/ }),
  ).toBeUndefined();
  await pane.unmount();
});

test("above an open thread or subthread, the list draws its id inverted, and pressing it closes the view", async ($, on) => {
  world(on);
  await start($);
  for (const id of ["db", "ui"])
    await $.tool.call({ tool: "mcp__threads__thread", id, title: id } as never);
  await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "db",
    question: "Which store?",
  } as never);
  const pane = await $.ui.mount(PANE);
  const inverted = async () =>
    (await pane.findAll({ type: "Text" }))
      .filter((x) => x.props.inverse === true)
      .map((x) => x.text?.trimEnd());
  expect(await inverted()).toEqual([]);
  await pane.press({ key: "t:ui" });
  expect(await inverted()).toEqual(["ui"]);
  // A subthread's own row when it is shown, its thread's when folded away.
  await pane.press({ key: "x:db" });
  await pane.press({ key: "s:q1" });
  expect(await inverted()).toEqual(["q1"]);
  await pane.press({ key: "x:db" });
  expect(await inverted()).toEqual(["db"]);
  // The open row's press closes the view; the head has no way back to the list, which it sits under.
  expect(await pane.find({ key: "home" })).toBeUndefined();
  await pane.press({ key: "t:db" });
  expect(await inverted()).toEqual([]);
  expect(
    await pane.find({ type: "Text", text: /^\[\[db\]\] · open/ }),
  ).toBeUndefined();
  await pane.press({ key: "t:ui" });
  await pane.press({ key: "t:ui" });
  expect(await inverted()).toEqual([]);
  await pane.unmount();
});

test("a closed thread stays above the fold until read, and a read one shows only while the fold is open", async ($, on) => {
  world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    title: "Plan",
  } as never);
  const pane = await $.ui.mount(PANE);
  const viewing = async () =>
    (await pane.find({ type: "Text", text: /^\[\[plan\]\] · / })) !== undefined;
  await pane.press({ key: "t:plan" });
  expect(await viewing()).toBe(true);
  // Closed while the user reads it, with the fold folded, it holds news: its row stays above the
  // fold and its view stays.
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    close: "Done.",
  } as never);
  expect(await viewing()).toBe(true);
  expect(await pane.find({ key: "t:plan" })).toBeDefined();
  // Left, it is read, and moves into the folded fold.
  await pane.press({ key: "t:plan" });
  expect(await viewing()).toBe(false);
  expect(await pane.find({ key: "t:plan" })).toBeUndefined();
  // Opened again, here by Back, it opens the fold so its row shows.
  await pane.press({ key: "hist:back" });
  expect(await viewing()).toBe(true);
  expect(await pane.find({ key: "t:plan" })).toBeDefined();
  // Folding the fold hides it again.
  await pane.press({ key: "closed" });
  expect(await viewing()).toBe(false);
  // Closed while the view shows it, even with nothing unread, it stays until the user leaves it.
  await pane.press({ key: "closed" });
  await pane.press({ key: "t:plan" });
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    reopen: true,
  } as never);
  await pane.press({ key: "t:plan" });
  await pane.press({ key: "t:plan" });
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    close: "Done at last.",
  } as never);
  expect(await viewing()).toBe(true);
  expect(await pane.find({ key: "t:plan" })).toBeDefined();
  await pane.press({ key: "t:plan" });
  expect(await viewing()).toBe(false);
  // Closed while the fold is open, it stays.
  await pane.press({ key: "t:plan" });
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    reopen: true,
  } as never);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    close: "Done again.",
  } as never);
  expect(await viewing()).toBe(true);
  await pane.unmount();
});

test("a question's subthread lists under its thread, opens to what it holds, and its field answers in the user's words", async ($, on) => {
  const { seen } = world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "db",
    title: "Cache store",
  } as never);
  await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "db",
    question: "Which store?",
    options: [{ label: "JSON" }, { label: "SQLite", recommended: true }],
  } as never);
  await prompt($, "go", "p1");
  await reply($, "[[db]]\nThe plan.\n\n[[db]] [[q1]]\nq1: which store?", "r1");
  await prompt($, "[[q1]] tell me more", "p2");
  await reply($, "[[q1]]\nSQLite is one file.", "r2");
  const pane = await $.ui.mount(PANE);
  // Collapsed, the list shows the thread alone; expanded, a row per open question under it.
  expect(await pane.find({ key: "s:q1" })).toBeUndefined();
  expect((await pane.find({ key: "x:db" }))?.text).toContain("▸");
  await pane.press({ key: "x:db" });
  const sub = (await pane.find({ key: "s:q1" }))?.text ?? "";
  expect(sub).toContain("q1");
  expect(sub).toContain("Which store?");
  expect(sub).toContain("●");
  expect(sub).toContain("?");
  await pane.press({ key: "s:q1" });
  const says = async (text: string) =>
    (await pane.find({ type: "Markdown", text })) !== undefined;
  expect(await says("SQLite is one file.")).toBe(true);
  expect(await says("[[q1]] tell me more")).toBe(true);
  expect(await says("The plan.")).toBe(false);
  expect((await pane.find({ key: "back" }))?.text).toContain("[[db]]");
  expect(await pane.find({ key: "home" })).toBeUndefined();
  // The field sends its words as an answer to the question, beside the card and its picks.
  await pane.press({ key: "opt:q1:0" });
  await pane.input({ key: "msg:q1:0", text: "what about backups?" });
  expect(seen.prompts.at(-1)).toBe("q1: what about backups?");
  // Replied to, the question stays in its subthread, said to wait on Claude, as it leaves Waiting on you.
  await $.session.append({
    message: {
      type: "user",
      role: "user",
      content: [{ type: "text", text: "q1: what about backups?" }],
    },
    door: "prompt",
    origin: { kind: "composer" },
    uuid: "p3",
  } as never);
  expect(await pane.find({ key: "opt:q1:0" })).toBeDefined();
  expect(
    await pane.find({ type: "Text", text: /waiting on Claude/ }),
  ).toBeDefined();
  // Back goes to the thread, and its open row in the list closes it, the subthreads folded as left.
  await pane.press({ key: "back" });
  expect(await says("The plan.")).toBe(true);
  // In the thread, the replied question has left Waiting on you; the list still leads to it.
  expect(await pane.find({ key: "sub:q1" })).toBeUndefined();
  await pane.press({ key: "t:db" });
  expect(await pane.find({ key: "s:q1" })).toBeDefined();
  // From a subthread, its open row closes it too.
  await pane.press({ key: "s:q1" });
  await pane.press({ key: "s:q1" });
  expect(await pane.find({ key: "s:q1" })).toBeDefined();
  await pane.press({ key: "x:db" });
  expect(await pane.find({ key: "s:q1" })).toBeUndefined();
  await pane.unmount();
});

test("the band lines its rows up in columns: questions waiting, unread dot, id, then text", async ($, on) => {
  world(on);
  await start($);
  for (const [id, title] of [
    ["plan", "Plan"],
    ["database-cache", "Cache store"],
  ])
    await $.tool.call({ tool: "mcp__threads__thread", id, title } as never);
  for (const question of ["Approve?", "Ship it?"])
    await $.tool.call({
      tool: "mcp__threads__ask",
      thread: "plan",
      question,
    } as never);
  await prompt($, "go", "p1");
  await reply($, "[[database-cache]]\nNews.", "r1");
  const band = await $.ui.mount({
    plugin: "threads",
    component: "AbovePrompt",
    requestId: "band",
    surface: "terminal",
    props: {
      hasSurvey: false,
      isCollapsed: false,
      isWorking: false,
      maxRows: 5,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 5 },
      view: {},
    },
  } as never);
  const plan = (await band.find({ key: "band:row:plan" }))!.text;
  const db = (await band.find({ key: "band:row:database-cache" }))!.text;
  expect(plan.indexOf("?2")).toBe(2);
  expect(plan.indexOf("plan")).toBe(db.indexOf("database-cache"));
  expect(plan.indexOf("Approve?")).toBe(db.indexOf("Cache store"));
  expect(db.indexOf("●")).toBe(plan.indexOf("plan") - 2);
  await band.unmount();
});

test("the user's own acts are no news: an answer sent from the pane, settled after they left, leaves no dot; Claude's reply does", async ($, on) => {
  world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    title: "Plan",
  } as never);
  await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "plan",
    question: "Approve?",
    options: [{ label: "Approve" }, { label: "Revise" }],
  } as never);
  const pane = await $.ui.mount(PANE);
  const dot = async () =>
    ((await pane.find({ key: "t:plan" }))?.text ?? "").includes("●");
  await pane.press({ key: "t:plan" });
  await pane.press({ key: "opt:q1:0" });
  await pane.press({ key: "send" });
  await pane.press({ key: "t:plan" });
  expect(await dot()).toBe(false);
  await $.session.append({
    message: {
      type: "user",
      role: "user",
      content: [{ type: "text", text: "[[plan]] q1: Approve" }],
    },
    door: "prompt",
    origin: { kind: "plugin", asUser: true },
    uuid: "p1",
  } as never);
  expect(await dot()).toBe(false);
  await $.tool.call({
    tool: "mcp__threads__settle",
    question: "q1",
    answer: "Approve",
  } as never);
  expect(await dot()).toBe(false);
  // Claude's reply after it is its own new text, and news.
  await reply($, "[[plan]]\nApproved; going ahead.", "r1");
  expect(await dot()).toBe(true);
  await pane.unmount();
});

test("a tag in the main view carries its thread's unread mark: the dot marks it read, the name opens it", async ($, on) => {
  world(on);
  await start($);
  for (const id of ["plan", "other"])
    await $.tool.call({ tool: "mcp__threads__thread", id, title: id } as never);
  await prompt($, "go", "p1");
  const text = "Lead.\n\n[[plan]]\nStep.\n\n[[other]]\nAside.";
  await reply($, text, "r1");
  const row = await $.ui.mount({
    plugin: "threads",
    component: "AssistantMessage",
    requestId: "r1",
    surface: "terminal",
    props: { text, isFirstOfReply: true },
  } as never);
  const tags = async () => (await row.find({ key: "tags" }))?.text ?? "";
  expect(await tags()).toContain(
    "[●](https://threads.invalid/read/plan) [plan](https://threads.invalid/0/plan)",
  );
  // Marked on the tag, a thread draws no mark below the reply.
  expect(await row.find({ key: "read:plan" })).toBeUndefined();
  await row.press({
    key: "tags",
    link: { href: "https://threads.invalid/read/plan" },
  } as never);
  expect(await tags()).toContain("[▸ plan](https://threads.invalid/0/plan)");
  expect(await tags()).toContain("[●](https://threads.invalid/read/other)");
  await row.unmount();
});

test("the pane's field is its first focusable, inline and docked, whatever is filed above it", async ($, on) => {
  world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    title: "Plan",
  } as never);
  // The engine keeps a pane's focus by its place among the focusable elements, so the field's place
  // must not move as messages and cards are filed above it.
  for (const placement of ["dock", "inline"] as const) {
    const pane = await $.ui.mount({
      ...PANE,
      props: { ...PANE.props, placement },
    } as never);
    await pane.press({ key: "t:plan" });
    const first = async () => focusables(await pane.drawn())[0];
    expect(await first()).toMatch(/^msg:plan:/);
    await reply($, `[[plan]]\nA reply ${placement}.`, `r-${placement}`);
    await $.tool.call({
      tool: "mcp__threads__ask",
      thread: "plan",
      question: `Which ${placement}?`,
      options: ["A", "B"],
    } as never);
    expect(await first()).toMatch(/^msg:plan:/);
    // A question's subthread too.
    await pane.press({ key: placement === "dock" ? "t:plan" : "home" });
    const q = placement === "dock" ? "q1" : "q2";
    await pane.press({ key: `x:plan` });
    await pane.press({ key: `s:${q}` });
    expect(await first()).toMatch(new RegExp(`^msg:${q}:`));
    await pane.press({ key: placement === "dock" ? `s:${q}` : "home" });
    await pane.press({ key: `x:plan` });
    await pane.unmount();
  }
});

test("a thread draws its whole history, its first message too", async ($, on) => {
  world(on);
  await start($);
  for (let i = 1; i <= 20; i++) {
    await prompt($, `[[plan]] go ${i}`, `p${i}`);
    await reply($, `[[plan]]\nDone ${i}.`, `r${i}`);
  }
  const pane = await $.ui.mount(PANE);
  await pane.press({ key: "t:plan" });
  await pane.press({ key: "t:plan" });
  await pane.press({ key: "t:plan" });
  expect(await pane.find({ type: "Markdown", text: /Done 1\./ })).toBeDefined();
  await pane.unmount();
});

test("a summary edit shows in the thread's history with the summary as it then read", async ($, on) => {
  world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    title: "Plan",
    summary: "First.",
  } as never);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    summary: "Second, **bold**.",
  } as never);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    summary: "Third.",
  } as never);
  const pane = await $.ui.mount(PANE);
  await pane.press({ key: "t:plan" });
  expect(
    await pane.findAll({ type: "Text", text: /· Summary updated$/ }),
  ).toHaveLength(2);
  expect(
    await pane.find({ type: "Markdown", text: "Second, **bold**." }),
  ).toBeDefined();
  await pane.unmount();
});

test("a thread's id in the list is bold only while it is unread", async ($, on) => {
  world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    title: "Plan",
  } as never);
  const pane = await $.ui.mount(PANE);
  const id = async () =>
    (await pane.findAll({ type: "Text" })).find(
      (x) => x.text?.trimEnd() === "plan",
    );
  expect((await id())?.props).toMatchObject({ bold: false });
  await reply($, "[[plan]]\nStarted.", "r1");
  expect((await id())?.props).toMatchObject({ bold: true });
  await pane.unmount();
});

test("a thread's status shows at its top, under the title", async ($, on) => {
  world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    title: "Plan",
    summary: "Builds the parser.",
    status: "Waiting on q1.",
  } as never);
  const pane = await $.ui.mount(PANE);
  await pane.press({ key: "t:plan" });
  expect(
    await pane.find({ type: "Text", text: /^Status: Waiting on q1\.$/ }),
  ).toBeDefined();
  expect(
    await pane.find({ type: "Markdown", text: "Builds the parser." }),
  ).toBeDefined();
  await pane.unmount();
});

test("a card's row estimate counts its kept note only while the card draws it, with the card's label", () => {
  const free = {
    id: "q1",
    thread: "plan",
    text: "Which lexer?",
    status: "open" as const,
    askedAt: 0,
  };
  const choice = { ...free, id: "q2", options: [{ label: "Approve" }] };
  const note = "x".repeat(39);
  const bare = cardRows(free, undefined, undefined, 50);
  // "Answer: " and 39 characters wrap past 46 columns; "Note: " and 39 fit in one.
  expect(cardRows(free, { picks: [], note }, undefined, 50)).toBe(bare + 3);
  expect(cardRows(free, { picks: [], note }, "q1", 50)).toBe(bare);
  const plain = cardRows(choice, undefined, undefined, 50);
  expect(cardRows(choice, { picks: [], note }, undefined, 50)).toBe(plain + 2);
  expect(cardRows(choice, { picks: [], note }, "q2", 50)).toBe(plain);
});

test("an answer typed at the prompt reads back on its settled card as the answer, and retracted as what the user replied", async ($, on) => {
  world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "db",
    title: "Cache store",
  } as never);
  for (const question of ["Which stores?", "Which to drop?"])
    await $.tool.call({
      tool: "mcp__threads__ask",
      thread: "db",
      question,
      kind: "checklist",
      options: ["JSON", "SQLite"],
    } as never);
  await prompt($, "q1: sqlite only", "u1");
  await prompt($, "q2: not sure yet", "u2");
  await $.tool.call({
    tool: "mcp__threads__settle",
    question: "q1",
    answer: "SQLite",
  } as never);
  await $.tool.call({
    tool: "mcp__threads__settle",
    question: "q2",
    retract: "Tabled until the data is in",
  } as never);
  const pane = await $.ui.mount(PANE);
  await pane.press({ key: "t:db" });
  expect(await pane.find({ type: "Text", text: "[x] SQLite" })).toBeDefined();
  expect(
    await pane.find({ type: "Markdown", text: "**Answer:** SQLite" }),
  ).toBeDefined();
  expect(
    await pane.find({ type: "Text", text: "None checked." }),
  ).toBeUndefined();
  expect(
    await pane.find({
      type: "Markdown",
      text: "**You replied:** q2: not sure yet",
    }),
  ).toBeDefined();
  await pane.unmount();
});

test("a book whose events are words, left in the store, comes back typed and draws in the same words", async ($, on) => {
  const { store } = world(on);
  const thread = (id: string, entries: object[]) => ({
    id,
    title: id === "main" ? "The session as a whole" : "Cache store",
    summary: "",
    status: "open",
    createdAt: 0,
    updatedAt: 0,
    touchedTurn: 0,
    entries,
  });
  store.set(`book:${ID}`, {
    threads: [
      thread("main", []),
      thread("db", [
        { kind: "event", text: "Opened.", at: 1 },
        { kind: "event", text: "Summary updated:\nPick a **store**.", at: 2 },
        { kind: "event", text: "Status: Asking.", at: 2 },
        {
          kind: "event",
          text: "Asked q1: Which store?",
          at: 3,
          question: "q1",
        },
        { kind: "event", text: "Answered q1: SQLite", at: 4, question: "q1" },
      ]),
    ],
    questions: [
      {
        id: "q1",
        thread: "db",
        text: "Which store?",
        status: "answered",
        askedAt: 3,
        resolution: "SQLite",
        settledAt: 4,
      },
    ],
    nextQuestion: 2,
    turn: { n: 1, active: [], touched: [], untagged: [] },
  });
  await start($);
  const pane = await $.ui.mount(PANE);
  // The answer is news, as it was in the store: the thread is unread.
  expect((await pane.find({ type: "Button", key: "t:db" }))?.text).toContain(
    "●",
  );
  await pane.press({ key: "t:db" });
  expect(
    await pane.find({ type: "Text", text: /· Summary updated$/ }),
  ).toBeDefined();
  expect(
    await pane.find({ type: "Markdown", text: "Pick a **store**." }),
  ).toBeDefined();
  expect(await pane.find({ type: "Text", text: /· Opened\.$/ })).toBeDefined();
  expect(
    await pane.find({ type: "Text", text: /Status: Asking\./ }),
  ).toBeDefined();
  // The settled question's event draws as its card.
  expect(
    await pane.find({ type: "Markdown", text: "**Answer:** SQLite" }),
  ).toBeDefined();
  await pane.unmount();
  // Kept again, the book holds its events typed.
  await $.classic.Stop({ stop_hook_active: true } as never);
  const kept = store.get(`book:${ID}`) as {
    threads: { id: string; events: { event?: string; text?: string }[] }[];
  };
  expect(
    kept.threads.find((t) => t.id === "db")!.events.map((x) => x.event),
  ).toEqual(["opened", "summary", "status", "asked", "answered"]);
  expect(
    kept.threads.find((t) => t.id === "db")!.events.some((x) => "text" in x),
  ).toBe(false);
});

test("a book with a copy of a message in each thread, left in the store, comes back with it kept once and drawn the same", async ($, on) => {
  const { store } = world(on);
  const thread = (id: string, entries: object[]) => ({
    id,
    title: id,
    summary: "",
    status: "open",
    createdAt: 0,
    updatedAt: 0,
    touchedTurn: 0,
    entries,
  });
  store.set(`book:${ID}`, {
    threads: [
      thread("main", [{ kind: "prompt", text: "Plan it", uuid: "u1", at: 2 }]),
      thread("plan", [
        { kind: "event", event: "opened", at: 1 },
        { kind: "prompt", text: "Plan it", uuid: "u1", at: 2, from: ["main"] },
        { kind: "reply", text: "Shared.", uuid: "r1", at: 3 },
      ]),
      thread("other", [
        { kind: "event", event: "opened", at: 1 },
        { kind: "reply", text: "Shared.", uuid: "r1", at: 3 },
      ]),
    ],
    questions: [],
    nextQuestion: 1,
    turn: { n: 1, active: [], touched: [], untagged: [] },
  });
  await start($);
  const pane = await $.ui.mount(PANE);
  await pane.press({ key: "t:plan" });
  // The message filed from main shows as from there, and the shared one links to its other thread.
  expect(await pane.find({ type: "Text", text: "in [[main]]" })).toBeDefined();
  const links = (await pane.findAll({ type: "Button" })).filter((x) =>
    x.key?.startsWith("also:"),
  );
  expect(links.map((x) => x.text)).toEqual(["[[main]]", "[[other]]"]);
  await pane.unmount();
  await $.classic.Stop({ stop_hook_active: true } as never);
  const kept = store.get(`book:${ID}`) as {
    messages: { text: string; threads: string[] }[];
  };
  expect(kept.messages.map((m) => [m.text, m.threads])).toEqual([
    ["Plan it", ["main", "plan"]],
    ["Shared.", ["plan", "other"]],
  ]);
});

test("a pane answer still on its way holds no stop, and the same short words answering another question do not hide it", async ($, on) => {
  const { seen } = world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "ui",
    title: "UI",
  } as never);
  for (const question of ["Ship it?", "Tag it?"])
    await $.tool.call({
      tool: "mcp__threads__ask",
      thread: "ui",
      question,
    } as never);
  const pane = await $.ui.mount(PANE);
  await pane.press({ key: "t:ui" });
  const answer = async (id: string) => {
    await pane.press({ key: `note:${id}` });
    await pane.input({ key: `msg:note:${id}:1`, text: "yes" });
    await pane.press({ key: "send" });
  };
  // q2's answer reaches the session as its row; q1's, the same words, is still queued.
  await answer("q2");
  expect(seen.prompts.at(-1)).toBe("[[ui]] q2: yes");
  await $.session.append({
    message: {
      type: "user",
      role: "user",
      content: [{ type: "text", text: "[[ui]] q2: yes" }],
    },
    door: "prompt",
    origin: { kind: "plugin", name: "threads", asUser: true },
    uuid: "p1",
  } as never);
  await answer("q1");
  expect(seen.prompts.at(-1)).toBe("[[ui]] q1: yes");
  await pane.unmount();
  const block = (await $.classic.Stop({ stop_hook_active: false } as never))
    .block;
  expect(block).toContain("- q2 in [[ui]]: “yes”");
  expect(block).not.toContain("- q1 in [[ui]]");
});

test("a message the pane sends that a hook drops comes back to its field, and the reason shows", async ($, on) => {
  const { seen } = world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    title: "Plan",
  } as never);
  const pane = await $.ui.mount(PANE);
  await pane.press({ key: "t:plan" });
  seen.isDropping = true;
  await pane.input({ key: "msg:plan:0", text: "go ahead" });
  expect(
    await pane.find({ type: "Text", text: /not seen by Claude yet/ }),
  ).toBeUndefined();
  expect(
    (await pane.find({ type: "Input", key: "msg:plan:2" }))?.props.value,
  ).toBe("go ahead");
  expect(seen.toasts.at(-1)).toContain("not sent (Not now.)");
  // Sent again, it goes, and the field after it is empty.
  seen.isDropping = false;
  await pane.input({ key: "msg:plan:2", text: "go ahead" });
  expect(seen.prompts.at(-1)).toBe("[[plan]] go ahead");
  expect(
    (await pane.find({ type: "Input", key: "msg:plan:3" }))?.props.value,
  ).toBeUndefined();
  await pane.unmount();
});

test("a pane message queued behind a turn that an interrupt discards comes back, and the next send lifts the Stop", async ($, on) => {
  const { seen, clock } = world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    title: "Plan",
  } as never);
  const pane = await $.ui.mount(PANE);
  await pane.press({ key: "t:plan" });
  seen.isRunning = true;
  const sending = pane.input({ key: "msg:plan:0", text: "go ahead" });
  await clock.settle();
  expect(seen.queued).toHaveLength(1);
  // The person interrupts: the queued prompt is discarded, and a Stop stands.
  seen.isRunning = false;
  seen.isStopped = true;
  for (const discard of seen.queued.splice(0)) discard();
  await sending;
  expect(
    (await pane.find({ type: "Input", key: "msg:plan:2" }))?.props.value,
  ).toBe("go ahead");
  expect(seen.toasts.at(-1)).toContain("removed from the queue");
  // Enter in the pane is the person's input: it lifts the Stop, and the message goes.
  seen.inGesture = true;
  await pane.input({ key: "msg:plan:2", text: "go ahead" });
  expect(seen.prompts.at(-1)).toBe("[[plan]] go ahead");
  expect(seen.isStopped).toBe(false);
  await pane.unmount();
});

test("answers sent while a Stop stands go at once; dropped ones are drafted again and not marked sent", async ($, on) => {
  const { seen } = world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    title: "Plan",
  } as never);
  await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "plan",
    question: "Which lexer?",
    options: [{ label: "Old" }, { label: "New" }],
  } as never);
  const pane = await $.ui.mount(PANE);
  await pane.press({ key: "t:plan" });
  await pane.press({ key: "opt:q1:1" });
  seen.isDropping = true;
  await pane.press({ key: "send" });
  expect(seen.toasts.at(-1)).toContain("answers were not sent (Not now.)");
  expect((await pane.find({ type: "Button", key: "send" }))?.text).toContain(
    "Send 1 answer",
  );
  // Not marked sent: the turn's end does not count it as an answer on its way.
  const held = await $.classic.Stop({ stop_hook_active: false } as never);
  expect(held.block ?? "").not.toContain("q1 in [[plan]]");
  seen.isDropping = false;
  seen.isStopped = true;
  seen.inGesture = true;
  await pane.press({ key: "send" });
  expect(seen.prompts.at(-1)).toBe("[[plan]] q1: New");
  expect(seen.isStopped).toBe(false);
  await pane.unmount();
});

test("when the store is full, the books of the sessions started longest ago make room for this one's", async ($, on) => {
  const { store, seen } = world(on);
  const big = { filler: "x".repeat(3000) };
  store.set("sessions", { old1: NOW - 2 * 86_400_000, old2: NOW - 86_400_000 });
  store.set("book:old1", big);
  store.set("book:old2", big);
  await start($);
  seen.storeLimit = 6000;
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    title: "Plan",
  } as never);
  await $.classic.Stop({ stop_hook_active: true } as never);
  expect(store.has("book:old1")).toBe(false);
  expect(store.has("book:old2")).toBe(true);
  expect(Object.keys(store.get("sessions") as object).sort()).toEqual([
    "old2",
    ID,
  ]);
  expect(
    (store.get(`book:${ID}`) as { threads: { id: string }[] }).threads.map(
      (t) => t.id,
    ),
  ).toEqual(["main", "plan"]);
});

test(
  "the band turned off draws the engine's own, with questions waiting and threads unread",
  { options: { band: false } },
  async ($, on) => {
    world(on);
    on("ui.render", async ($, e) => {
      const { Text } = $.ui.resolve(e);
      return <Text>engine</Text>;
    });
    await start($);
    await $.tool.call({
      tool: "mcp__threads__thread",
      id: "plan",
      title: "Plan",
    } as never);
    await $.tool.call({
      tool: "mcp__threads__ask",
      thread: "plan",
      question: "Approve?",
    } as never);
    await prompt($, "go", "p1");
    await reply($, "[[plan]]\nNews.", "r1");
    const band = await $.ui.mount({
      plugin: "threads",
      component: "AbovePrompt",
      requestId: "band",
      surface: "terminal",
      props: {
        hasSurvey: false,
        isCollapsed: false,
        isWorking: false,
        maxRows: 5,
        bodyColumns: 80,
        scroll: { offset: 0, bodyRows: 5 },
      },
    } as never);
    expect(await band.find({ type: "Text", text: "engine" })).toBeDefined();
    expect(await band.find({ key: "band:plan" })).toBeUndefined();
    await band.unmount();
  },
);

test("the band's fold toggle sits at the far right of its first row, after a gap, in both layouts", async ($, on) => {
  world(on);
  await start($);
  await $.tool.call({
    tool: "mcp__threads__thread",
    id: "plan",
    title: "Plan",
  } as never);
  await $.tool.call({
    tool: "mcp__threads__ask",
    thread: "plan",
    question: "Approve?",
  } as never);
  const band = await $.ui.mount({
    plugin: "threads",
    component: "AbovePrompt",
    requestId: "band",
    surface: "terminal",
    props: {
      hasSurvey: false,
      isCollapsed: false,
      isWorking: false,
      maxRows: 5,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 5 },
    },
  } as never);
  type Node = {
    type?: string;
    props?: { key?: string; flexGrow?: number };
    children?: unknown[];
  };
  // The row holding the toggle, and what ends it: the last two of its children.
  const ending = async () => {
    const find = (n: unknown): Node | undefined => {
      const x = n as Node;
      if (x === null || typeof x !== "object") return undefined;
      if (x.children?.some((c) => (c as Node)?.props?.key === "band:fold"))
        return x;
      for (const c of x.children ?? []) {
        const hit = find(c);
        if (hit !== undefined) return hit;
      }
      return undefined;
    };
    const row = find(await band.drawn());
    return (row?.children ?? [])
      .slice(-2)
      .map((c) => [
        (c as Node).type,
        (c as Node).props?.key,
        (c as Node).props?.flexGrow,
      ]);
  };
  const expected = [
    ["Box", "band:gap", 1],
    ["Button", "band:fold", undefined],
  ];
  expect(await ending()).toEqual(expected);
  expect((await band.find({ key: "band:fold" }))?.text).toContain("one line");
  await band.press({ key: "band:fold" });
  expect((await band.find({ key: "band:fold" }))?.text).toContain("list");
  expect(await ending()).toEqual(expected);
  await band.unmount();
});
