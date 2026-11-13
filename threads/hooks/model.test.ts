import { expect, test } from "claude-code/testing";

import {
  ask,
  changeThread,
  displayText,
  emptyBook,
  linkTags,
  fileUntagged,
  idleFor,
  isRead,
  isStale,
  markRow,
  rowThreads,
  joinPicks,
  openQuestions,
  promptContext,
  promptRefs,
  joinTurn,
  noteTyped,
  answerMessage,
  answerShape,
  answersIn,
  markSent,
  recordReply,
  settle,
  startTurn,
  stopProblems,
  waitsOnUser,
  subEntries,
  subUnread,
  markSeen,
  threadOf,
  historyOf,
  fromOf,
  unread,
  unfile,
  readBook,
  ordered,
  sortedBy,
  entryText,
  type Book,
  type Message,
} from "./model";

const opened = (b: Book, id: string, title = id) =>
  changeThread(b, { id, title }, 1).book;

// A book with a copy of each message in each thread holding it, each copy marked with the threads it
// came from where Claude filed it, and no ids.
const withCopies = (b: Book) => {
  const { messages: _, nextEntry: __, ...rest } = b;
  return {
    ...rest,
    threads: b.threads.map(({ events: _, ...t }) => ({
      ...t,
      entries: historyOf(b, t.id).map((x) => {
        if (x.kind === "event") {
          const { id: _, ...e } = x;
          return e;
        }
        const { id: _, threads: __, home: ___, sub, ...m } = x;
        const from = fromOf(x, t.id);
        const own = (sub ?? []).filter(
          (q) => b.questions.find((y) => y.id === q)?.thread === t.id,
        );
        return {
          ...m,
          ...(from === undefined ? {} : { from }),
          ...(own.length > 0 ? { sub: own } : {}),
        };
      }),
    })),
    turn: {
      ...b.turn,
      loose: (b.turn.loose ?? []).map((id) => {
        const m = b.messages.find((m) => m.id === id)!;
        return { text: m.text, uuid: m.uuid, at: m.at, in: m.home };
      }),
    },
  };
};

test("a reply's tag lines file each section under its threads; an untagged prompt goes under main alone", async () => {
  let b = opened(emptyBook(0), "parser");
  b = startTurn(b, "How should errors look?", "u1", 2);
  b = recordReply(
    b,
    "[[parser]]\nHere is the plan:\n1. Spans\n\n[[main]]\nOverall: on track.",
    "r1",
    3,
  );
  expect(
    historyOf(b, "parser").map((x) => [
      x.kind,
      entryText(x),
      (x as Message).uuid,
    ]),
  ).toEqual([
    ["event", "Opened.", undefined],
    ["reply", "Here is the plan:\n1. Spans", "r1"],
  ]);
  expect(historyOf(b, "main").map(entryText)).toEqual([
    "How should errors look?",
    "Overall: on track.",
  ]);
  expect(stopProblems(b)).toBeUndefined();
  // The note names its message by its opening words, since one user message can hold several.
  expect(promptContext(b, "How should errors look?")).toContain(
    'The message that begins "How should errors look?" has no tag, so it is filed under [[main]] alone.',
  );
  expect(
    promptContext(
      b,
      "How should errors look when the parser\n  meets a stray brace?",
    ),
  ).toContain(
    'The message that begins "How should errors look when the parser…" has no tag',
  );
  // Claude may file it under the thread it was about, marked as the main session's.
  const out = fileUntagged(b, ["parser"], 4, true);
  expect(out.isError).toBeUndefined();
  // In its place by time, before the reply that answered it.
  expect(
    historyOf(out.book, "parser").find((x) => x.kind === "prompt"),
  ).toEqual(
    expect.objectContaining({
      kind: "prompt",
      text: "How should errors look?",
      uuid: "u1",
      threads: ["main", "parser"],
      home: ["main"],
    }),
  );
  expect(fileUntagged(out.book, ["parser"], 5, true).message).toContain(
    "hold this turn's messages already",
  );
});

test("a tagged message is filed under other threads too, marked with the threads it was sent under", async () => {
  let b = opened(opened(emptyBook(0), "parser"), "lexer");
  b = startTurn(b, "[[parser]] Spans need the lexer's offsets", "u1", 2);
  expect(promptContext(b, "[[parser]] Spans")).toContain(
    "If it is about other threads too",
  );
  b = fileUntagged(b, ["lexer", "parser"], 3, true).book;
  expect(historyOf(b, "lexer").at(-1)).toEqual(
    expect.objectContaining({
      text: "[[parser]] Spans need the lexer's offsets",
      threads: ["parser", "lexer"],
      home: ["parser"],
    }),
  );
  expect(historyOf(b, "parser").filter((x) => x.kind === "prompt").length).toBe(
    1,
  );
  expect(historyOf(b, "main").some((x) => x.kind === "prompt")).toBe(false);
});

test("a later block of the same turn continues the threads its last tag named", async () => {
  let b = opened(emptyBook(0), "parser");
  b = startTurn(b, "go", "u1", 2);
  b = recordReply(b, "[[parser]]\nChecking the lexer.", "r1", 3);
  b = recordReply(b, "The lexer is fine.", "r2", 4);
  expect(historyOf(b, "parser").map(entryText).slice(-2)).toEqual([
    "Checking the lexer.",
    "The lexer is fine.",
  ]);
  expect(b.turn.untagged).toEqual([]);
});

test("one tag line files a section under several threads", async () => {
  let b = opened(opened(emptyBook(0), "a"), "b");
  b = startTurn(b, "go", "u1", 2);
  b = recordReply(b, "[[a]] [[b]]\nShared plan.", "r1", 3);
  expect(entryText(historyOf(b, "a").at(-1)!)).toBe("Shared plan.");
  expect(entryText(historyOf(b, "b").at(-1)!)).toBe("Shared plan.");
});

test("text before any tag line is untagged, the stop asks to file it, and filing clears it", async () => {
  let b = opened(emptyBook(0), "parser");
  b = startTurn(b, "go", "u1", 2);
  b = recordReply(b, "Some words.", "r1", 3);
  expect(b.turn.untagged).toEqual([{ text: "Some words.", uuid: "r1", at: 3 }]);
  expect(stopProblems(b)).toContain("mcp__threads__file");
  expect(stopProblems(b)).toContain("- “Some words.”");
  expect(stopProblems(b)).toContain("a tag in your thinking");
  const out = fileUntagged(b, ["parser"], 4);
  expect(out.isError).toBeUndefined();
  expect(historyOf(out.book, "parser").map(entryText).slice(-2)).toEqual([
    "Opened.",
    "Some words.",
  ]);
  expect((historyOf(out.book, "parser").at(-1)! as Message).uuid).toBe("r1");
  expect(stopProblems(out.book)).toBeUndefined();
});

// Two untagged blocks of a turn, about different threads.
const twoBlocks = () => {
  let b = opened(opened(emptyBook(0), "parser"), "lexer");
  b = startTurn(b, "go", "u1", 2);
  b = recordReply(b, "The parser drops a token.", "r1", 3);
  b = recordReply(b, "The lexer splits on tabs.\nSecond line.", "r2", 4);
  return b;
};

test("each untagged block files alone by a quote, and then the stop asks nothing", async () => {
  const b = twoBlocks();
  expect(stopProblems(b)).toContain("with quote: its opening words");
  let out = fileUntagged(b, ["lexer"], 5, false, "the lexer  SPLITS");
  expect(out.isError).toBeUndefined();
  expect(out.message).toBe(
    "Filed under [[lexer]]. 1 more block is still untagged.",
  );
  const filed = historyOf(out.book, "lexer").at(-1)! as Message;
  expect([filed.text, filed.uuid, filed.at]).toEqual([
    "The lexer splits on tabs.\nSecond line.",
    "r2",
    4,
  ]);
  expect(out.book.turn.untagged.map((p) => p.text)).toEqual([
    "The parser drops a token.",
  ]);
  expect(stopProblems(out.book)).toContain("- “The parser drops a token.”");
  out = fileUntagged(out.book, ["parser"], 6, false, "The parser drops");
  expect(out.message).toBe("Filed under [[parser]].");
  expect(entryText(historyOf(out.book, "parser").at(-1)!)).toBe(
    "The parser drops a token.",
  );
  expect(stopProblems(out.book)).toBeUndefined();
});

test("a quote that several untagged blocks hold is refused with the blocks", async () => {
  const out = fileUntagged(twoBlocks(), ["parser"], 5, false, "the");
  expect(out.isError).toBe(true);
  expect(out.message).toContain("2 blocks of this turn's untagged text");
  expect(out.message).toContain("- The parser drops a token.");
});

test("each route the stop names for untagged text files it", async () => {
  // No quote: every block, under the same threads.
  let out = fileUntagged(twoBlocks(), ["parser"], 5);
  expect(entryText(historyOf(out.book, "parser").at(-1)!)).toBe(
    "The parser drops a token.\n\nThe lexer splits on tabs.\nSecond line.",
  );
  expect(stopProblems(out.book)).toBeUndefined();
  // A quote of each listed block's opening words, as the stop quotes them.
  let b = twoBlocks();
  for (const line of stopProblems(b)!.matchAll(/^- “(.+)”$/gm)) {
    out = fileUntagged(b, ["parser"], 5, false, line[1]);
    expect(out.isError).toBeUndefined();
    b = out.book;
  }
  expect(stopProblems(b)).toBeUndefined();
  // One block: the stop offers the call with no quote alone.
  let one = opened(emptyBook(0), "parser");
  one = recordReply(startTurn(one, "go", "u1", 2), "Some words.", "r1", 3);
  expect(stopProblems(one)).not.toContain("with quote");
});

test("a quote that no untagged block holds still finds a filed message", async () => {
  let b = opened(emptyBook(0), "parser");
  b = recordReply(
    startTurn(b, "go", "u1", 2),
    "[[parser]]\nFiled words.",
    "r1",
    3,
  );
  b = recordReply(startTurn(b, "next", "u2", 4), "Loose words.", "r2", 5);
  const out = fileUntagged(b, ["main"], 6, false, "Filed words");
  expect(out.message).toContain(
    "Filed that section of your reply under [[main]]",
  );
  expect(out.book.turn.untagged.map((p) => p.text)).toEqual(["Loose words."]);
});

test("untagged text stored as strings reads as pieces, and still files and quotes", async () => {
  let b = opened(emptyBook(0), "parser");
  const kept = withCopies(b);
  b = readBook({
    ...kept,
    turn: { ...kept.turn, untagged: ["Old words.\nSecond line."] },
  });
  expect(b.turn.untagged).toEqual([
    { text: "Old words.\nSecond line.", at: 0 },
  ]);
  expect(stopProblems(b)).toContain("- “Old words.”");
  const out = fileUntagged(b, ["parser"], 4);
  expect(entryText(historyOf(out.book, "parser").at(-1)!)).toBe(
    "Old words.\nSecond line.",
  );
});

test("a book in other stored shapes reads in Book's shapes, and one in them comes back the same", () => {
  let b = opened(opened(emptyBook(0), "parser"), "lexer");
  b = ask(b, { thread: "parser", question: "Which?", options: ["A"] }, 2).book;
  b = ask(b, { thread: "parser", question: "Why?" }, 3).book;
  b = ask(b, { thread: "parser", question: "None?", options: ["A"] }, 3).book;
  b = recordReply(startTurn(b, "go", "u1", 4), "[[parser]]\nOn it.", "r1", 5);
  expect(readBook(b)).toEqual(b);
  const kept = withCopies(b);
  const old = {
    ...kept,
    threads: kept.threads.map((t) =>
      t.id === "parser"
        ? {
            ...t,
            // Read status as one time, and an event's question in its text alone.
            seenAt: 5,
            entries: [
              ...historyOf(b, "parser").map((x) =>
                x.kind === "event"
                  ? { kind: "event" as const, text: entryText(x), at: x.at }
                  : x,
              ),
              { kind: "prompt" as const, text: "go", at: 6, from: "main" },
              { kind: "reply" as const, text: "Later.", uuid: "r2", at: 7 },
            ],
          }
        : t,
    ),
    // An option as its label, and answers typed at the prompt kept with no picks.
    questions: kept.questions.map((q, i) => ({
      ...q,
      ...(i === 0 ? { options: ["A"] } : {}),
      ...(i === 1 ? { sent: { text: "q2: because", at: 6, picks: [] } } : {}),
      ...(i === 2 ? { sent: { text: "none checked", at: 6, picks: [] } } : {}),
    })),
    turn: {
      ...kept.turn,
      loose: [{ text: "go", uuid: "u1", at: 4 }],
      waiting: [{ text: "Old message", uuid: "w1", at: 1 }],
    },
  };
  const up = readBook(old);
  const entries = historyOf(up, "parser");
  expect(
    entries.filter((x) => x.kind === "event").map((x) => x.question),
  ).toEqual([undefined, "q1", "q2", "q3"]);
  expect(fromOf(entries.at(-2) as Message, "parser")).toEqual(["main"]);
  expect(entries.find((x) => entryText(x) === "On it.")!.read).toBe(true);
  expect(entries.at(-1)!.read).toBeUndefined();
  expect(unread(up, threadOf(up, "parser")!)).toBe(1);
  expect(up.questions[0].options).toEqual([{ label: "A" }]);
  expect(up.questions[1].sent).toEqual({ text: "q2: because", at: 6 });
  expect(up.questions[2].sent?.picks).toEqual([]);
  expect(up.turn.loose).toEqual([
    up.messages.find((m) => m.text === "go" && m.uuid === "u1")!.id,
  ]);
  expect("waiting" in up.turn).toBe(false);
  // In its place by time, before the turn's.
  expect(historyOf(up, "main")[0]).toMatchObject({
    kind: "prompt",
    text: "Old message",
    uuid: "w1",
    at: 1,
    threads: ["main"],
    home: ["main"],
  });
});

const rendering = (text: string) =>
  `<system-reminder>\nThe user sent a new message while you were working:\n${text}\n\nThis is how Claude Code surfaces messages the user sends mid-turn.\n</system-reminder>`;

test("an untagged message typed mid-turn joins main when its row comes", async () => {
  let b = opened(emptyBook(0), "parser");
  b = recordReply(startTurn(b, "go", "u1", 2), "[[parser]]\nWorking.", "r1", 3);
  b = noteTyped(b, "Also check the lexer.");
  expect(joinTurn(b, rendering("something else"), "a0", 4)).toBe(b);
  b = joinTurn(b, rendering("Also check the lexer."), "a1", 4);
  expect(entryText(historyOf(b, "parser").at(-1)!)).toBe("Working.");
  expect(
    b.turn.loose?.map((id) => b.messages.find((m) => m.id === id)?.text),
  ).toEqual(["go", "Also check the lexer."]);
  expect(historyOf(b, "main").at(-1)).toEqual(
    expect.objectContaining({
      kind: "prompt",
      text: "Also check the lexer.",
      uuid: "a1",
    }),
  );
  expect(b.turn.typed).toBeUndefined();
});

test("a mid-turn message with tags is filed under them, not Claude's text", async () => {
  let b = opened(opened(emptyBook(0), "parser"), "lexer");
  b = startTurn(b, "[[parser]] go", "u1", 2);
  expect(entryText(historyOf(b, "parser").at(-1)!)).toBe("[[parser]] go");
  b = joinTurn(
    noteTyped(b, "[[lexer]] and this"),
    rendering("[[lexer]] and this"),
    "a2",
    5,
  );
  expect(entryText(historyOf(b, "lexer").at(-1)!)).toBe("[[lexer]] and this");
  // Claude's text before its own first tag line belongs to no thread: the stop asks to have it filed.
  b = recordReply(b, "On it.", "r2", 6);
  expect(entryText(historyOf(b, "lexer").at(-1)!)).toBe("[[lexer]] and this");
  expect(b.turn.untagged.map((p) => p.text)).toEqual(["On it."]);
});

test("a message typed mid-turn that came too late to join starts the next turn and is not kept", async () => {
  let b = noteTyped(startTurn(emptyBook(0), "go", "u1", 2), "next thing");
  b = startTurn(b, "next thing", "u2", 3);
  expect(b.turn.typed).toBeUndefined();
  expect(b.turn.prompt?.text).toBe("next thing");
});

test("a prompt that opens with a tag is filed under it; Claude's text goes under its own tag lines alone", async () => {
  let b = opened(emptyBook(0), "parser");
  b = startTurn(b, "[[parser]] q1: yes, go ahead", "u1", 2);
  expect(historyOf(b, "parser").at(-1)).toEqual(
    expect.objectContaining({
      kind: "prompt",
      text: "[[parser]] q1: yes, go ahead",
    }),
  );
  b = recordReply(b, "Going ahead.", "r1", 3);
  expect(historyOf(b, "parser").at(-1)!.kind).toBe("prompt");
  expect(stopProblems(b)).toBeDefined();
  // After Claude's own tag line, its later text in the turn continues under that thread.
  b = recordReply(b, "[[parser]]\nStarted.", "r2", 4);
  b = recordReply(b, "Still going.", "r3", 5);
  expect(entryText(historyOf(b, "parser").at(-1)!)).toBe("Still going.");
  expect(promptContext(b, "[[parser]] yes")).toContain(
    'The user filed the message that begins "[[parser]] yes" under [[parser]].',
  );
});

test("a tag naming an unknown thread opens it untitled, and the stop asks for a title", async () => {
  let b = startTurn(emptyBook(0), "go", "u1", 2);
  b = recordReply(b, "[[lexer-bug]]\nFound it.", "r1", 3);
  expect(threadOf(b, "lexer-bug")).toEqual(
    expect.objectContaining({ isUntitled: true, status: "open" }),
  );
  expect(stopProblems(b)).toContain("[[lexer-bug]] with no title");
  b = changeThread(
    b,
    { id: "lexer-bug", title: "Lexer drops a token", summary: "Found." },
    4,
  ).book;
  expect(threadOf(b, "lexer-bug")!.isUntitled).toBeUndefined();
  expect(stopProblems(b)).toBeUndefined();
});

test("a tag naming a closed thread files under it and leaves it closed; a question there reopens it", async () => {
  let b = opened(emptyBook(0), "parser");
  b = changeThread(b, { id: "parser", close: "Shipped." }, 2).book;
  b = recordReply(
    startTurn(b, "thanks", "u2", 3),
    "[[parser]]\nClosed: shipped.",
    "r2",
    4,
  );
  expect(threadOf(b, "parser")).toEqual(
    expect.objectContaining({ status: "closed", outcome: "Shipped." }),
  );
  expect(entryText(historyOf(b, "parser").at(-1)!)).toBe("Closed: shipped.");
  b = ask(b, { thread: "parser", question: "One more?" }, 5).book;
  expect(threadOf(b, "parser")).toEqual(
    expect.objectContaining({ status: "open", outcome: undefined }),
  );
});

test("opening a thread needs a title, and main never closes", async () => {
  const b = emptyBook(0);
  expect(changeThread(b, { id: "x" }, 1).isError).toBe(true);
  expect(changeThread(b, { id: "Bad Id", title: "t" }, 1).isError).toBe(true);
  expect(changeThread(b, { id: "main", close: "done" }, 1).isError).toBe(true);
});

test("closing a thread with open questions says to settle them", async () => {
  let b = opened(emptyBook(0), "parser");
  b = ask(b, { thread: "parser", question: "Approve?" }, 2).book;
  expect(
    changeThread(b, { id: "parser", close: "Done." }, 3).message,
  ).toContain("q1");
});

test("a question is asked under an existing thread, settled once, and leaves the waiting list", async () => {
  let b = opened(emptyBook(0), "parser");
  expect(ask(b, { thread: "nope", question: "?" }, 2).isError).toBe(true);
  const asked = ask(
    b,
    {
      thread: "parser",
      question: "Approve the plan?",
      options: ["Approve", " ", "Revise"],
    },
    2,
  );
  expect(asked.message).toContain("q1");
  b = asked.book;
  expect(openQuestions(b)).toEqual([
    expect.objectContaining({
      id: "q1",
      options: [{ label: "Approve" }, { label: "Revise" }],
      status: "open",
    }),
  ]);
  expect(settle(b, { question: "q1" }, 3).isError).toBe(true);
  expect(
    settle(b, { question: "q1", answer: "a", retract: "r" }, 3).isError,
  ).toBe(true);
  b = settle(b, { question: "q1", answer: "Approve" }, 3).book;
  expect(openQuestions(b)).toEqual([]);
  expect(entryText(historyOf(b, "parser").at(-1)!)).toBe(
    "Answered q1: Approve",
  );
  expect(settle(b, { question: "q1", answer: "Again" }, 4).message).toContain(
    "already answered",
  );
  // Settled the wrong way: settling it the other way corrects it, its event and all.
  const fixed = settle(b, { question: "q1", retract: "Tabled" }, 4);
  expect(fixed.message).toContain("now retracted");
  expect(fixed.book.questions[0]).toMatchObject({
    status: "retracted",
    resolution: "Tabled",
  });
  const events = historyOf(fixed.book, "parser").filter(
    (e) => e.kind === "event" && /^(Answered|Retracted) q1/.test(entryText(e)),
  );
  expect(events.map(entryText)).toEqual(["Retracted q1: Tabled"]);
});

test("a question that only waits is never stale, however long its thread sits", async () => {
  let b = opened(opened(emptyBook(0), "parser"), "other");
  b = ask(b, { thread: "parser", question: "Approve?" }, 2).book;
  for (let i = 0; i < 6; i++)
    b = recordReply(
      startTurn(b, `p${i}`, `u${i}`, 3 + i),
      "[[other]]\nwork",
      `r${i}`,
      3 + i,
    );
  expect(isStale(b, b.questions[0])).toBe(false);
  expect(promptContext(b, "hi")).not.toContain("(stale");
});

test("a question whose thread sat idle for three prompts after other work finished is called stale in the prompt's context", async () => {
  let b = opened(opened(opened(emptyBook(0), "parser"), "other"), "done");
  b = ask(b, { thread: "parser", question: "Approve?" }, 2).book;
  b = changeThread(b, { id: "done", close: "Released." }, 2).book;
  for (let i = 0; i < 3; i++) {
    expect(isStale(b, b.questions[0])).toBe(false);
    b = recordReply(
      startTurn(b, `p${i}`, `u${i}`, 3 + i),
      "[[other]]\nwork",
      `r${i}`,
      3 + i,
    );
  }
  expect(isStale(b, b.questions[0])).toBe(true);
  const context = promptContext(b, "hi");
  expect(context).toContain("- q1 in [[parser]]: Approve? (stale");
  expect(context).toContain("mcp__threads__settle");
});

test("an open thread other than main that sat idle for three prompts is named in the prompt's context", async () => {
  let b = opened(opened(emptyBook(0), "rules"), "other");
  for (let i = 0; i < 3; i++) {
    expect(promptContext(b, "hi")).not.toContain("Idle threads");
    b = recordReply(
      startTurn(b, `p${i}`, `u${i}`, 3 + i),
      "[[other]]\nwork",
      `r${i}`,
      3 + i,
    );
  }
  expect(idleFor(b, threadOf(b, "rules")!)).toBe(3);
  expect(idleFor(b, threadOf(b, "main")!)).toBeUndefined();
  const context = promptContext(b, "hi");
  expect(context).toContain("Idle threads: [[rules]] (3 prompts).");
  expect(context).not.toContain("[[other]] (");
  expect(context).not.toContain("[[main]] (");
  // Updating its summary touches it, and a closed thread is never idle.
  b = changeThread(
    b,
    { id: "rules", summary: "Waits on the release." },
    7,
  ).book;
  expect(idleFor(b, threadOf(b, "rules")!)).toBeUndefined();
});

// Prompts that each tag [[other]] alone, from turn `from`.
const quietPrompts = (book: Book, count: number, from: number) => {
  let b = book;
  for (let i = from; i < from + count; i++)
    b = recordReply(
      startTurn(b, `p${i}`, `u${i}`, 3 + i),
      "[[other]]\nwork",
      `r${i}`,
      3 + i,
    );
  return b;
};

test("a thread that waits on the user is never idle: an open question of its own, or one its status names", async () => {
  let b = opened(opened(opened(emptyBook(0), "rules"), "other"), "gate");
  b = ask(b, { thread: "rules", question: "Approve?" }, 2).book;
  b = changeThread(b, { id: "gate", state: "Waiting on q1." }, 2).book;
  b = quietPrompts(b, 6, 0);
  expect(idleFor(b, threadOf(b, "rules")!)).toBeUndefined();
  expect(idleFor(b, threadOf(b, "gate")!)).toBeUndefined();
  expect(promptContext(b, "hi")).not.toContain("Idle threads");
  // Once the question is settled, both may go idle again.
  b = settle(b, { question: "q1", answer: "Yes" }, 20).book;
  b = quietPrompts(b, 3, 6);
  expect(idleFor(b, threadOf(b, "rules")!)).toBe(3);
  expect(idleFor(b, threadOf(b, "gate")!)).toBe(9);
});

test("an idle thread whose status is set is named again only after a thread closes elsewhere, and the threshold", async () => {
  let b = opened(opened(opened(emptyBook(0), "rules"), "other"), "done");
  b = quietPrompts(b, 3, 0);
  expect(idleFor(b, threadOf(b, "rules")!)).toBe(3);
  b = changeThread(
    b,
    { id: "rules", state: "Holding behind the release." },
    7,
  ).book;
  b = quietPrompts(b, 6, 3);
  expect(idleFor(b, threadOf(b, "rules")!)).toBeUndefined();
  expect(promptContext(b, "hi")).not.toContain("[[rules]] (");
  b = changeThread(b, { id: "done", close: "Released." }, 20).book;
  expect(idleFor(b, threadOf(b, "rules")!)).toBe(6);
  // A tag ends the hold: from then on the plain threshold counts.
  b = recordReply(startTurn(b, "p9", "u9", 30), "[[rules]]\nmore", "r9", 30);
  b = changeThread(b, { id: "rules", state: "Holding again." }, 31).book;
  b = quietPrompts(b, 3, 10);
  expect(idleFor(b, threadOf(b, "rules")!)).toBe(3);
});

test("the idle line says what needs nothing, and that a thread takes no message saying nothing changed", async () => {
  let b = opened(opened(emptyBook(0), "rules"), "other");
  b = quietPrompts(b, 3, 0);
  const line = promptContext(b, "hi")
    .split("\n")
    .find((l) => l.startsWith("Idle threads"))!;
  expect(line).toContain("status is still accurate needs nothing");
  expect(line).toContain(
    "Never write a message in a thread only to say that nothing changed",
  );
});

test("the transcript draws tag lines as markers and leaves inline references alone", async () => {
  expect(displayText("[[a]] [[b]]\nSee [[c]] for more.")).toBe(
    "`▸ a` `▸ b`\nSee [[c]] for more.",
  );
});

test("a reply's references to known threads and questions in its prose are links, its tag lines and code left alone", async () => {
  let b = opened(emptyBook(0), "plan");
  b = ask(b, { thread: "plan", question: "Approve?" }, 2).book;
  const H = "https://threads.invalid/";
  const linked = linkTags(
    [
      "[[plan]]",
      "See [[plan]] and q1, or [[q1]]; not [[nope]], q9, faq1 or q1-x.",
      "In code `[[plan]] q1`, a [link to q1](https://x.invalid/q1) and https://x.invalid/[[plan]].",
      "```",
      "[[plan]] q1",
      "```",
      "After the fence, q1.",
    ].join("\n"),
    b,
  );
  expect(linked.text.split("\n")).toEqual([
    `[▸ plan](${H}0/plan)`,
    `See [\\[\\[plan\\]\\]](${H}ref/plan) and [q1](${H}ref/q1), or [\\[\\[q1\\]\\]](${H}ref/q1); not [[nope]], q9, faq1 or q1-x.`,
    "In code `[[plan]] q1`, a [link to q1](https://x.invalid/q1) and https://x.invalid/[[plan]].",
    "```",
    "[[plan]] q1",
    "```",
    `After the fence, [q1](${H}ref/q1).`,
  ]);
  expect(linked.refs).toEqual({
    [`${H}ref/plan`]: { thread: "plan" },
    [`${H}ref/q1`]: { thread: "plan", question: "q1" },
  });
  // Without the book, nothing names a known thread.
  expect(linkTags("See [[plan]].").refs).toEqual({});
});

test("a prompt that opens with a question's id is filed under its thread and said to answer it", async () => {
  let b = opened(emptyBook(0), "plan");
  b = ask(b, { thread: "plan", question: "Approve?" }, 2).book;
  expect(promptRefs(b, "q1: yes")).toEqual({
    threads: ["plan"],
    questions: ["q1"],
    subs: [],
  });
  expect(promptRefs(b, "[[main]] q1, q9 yes")).toEqual({
    threads: ["main", "plan"],
    questions: ["q1"],
    subs: [],
  });
  expect(promptRefs(b, "q12 is odd")).toEqual({
    threads: [],
    questions: [],
    subs: [],
  });
  const context = promptContext(b, "q1: yes");
  expect(context).toContain(
    'The user filed the message that begins "q1: yes" under [[plan]].',
  );
  expect(context).toContain(
    'The message that begins "q1: yes" answers q1, each on its line',
  );
  b = startTurn(b, "q1: yes", "u1", 3);
  expect(entryText(historyOf(b, "plan").at(-1)!)).toBe("q1: yes");
});

test("options take a label alone or with a description and a preview, and only real choices are kept", async () => {
  const b = opened(emptyBook(0), "db");
  const q = ask(
    b,
    {
      thread: "db",
      question: "Which store?",
      options: [
        "JSON",
        {
          label: "SQLite",
          description: "Safe under concurrency.",
          preview: "```sql\ncreate table c;\n```",
        },
        { label: "" },
        42,
        "JSON",
      ],
      kind: "checklist",
    },
    1,
  ).book.questions[0];
  expect(q.options).toEqual([
    { label: "JSON" },
    {
      label: "SQLite",
      description: "Safe under concurrency.",
      preview: "```sql\ncreate table c;\n```",
    },
  ]);
  expect(q.multiSelect).toBe(true);
});

test("a thread's drafts become one message, a line per answered question, picks before the note", async () => {
  let b = opened(emptyBook(0), "db");
  b = ask(
    b,
    { thread: "db", question: "Which?", options: ["JSON", "SQLite"] },
    1,
  ).book;
  b = ask(b, { thread: "db", question: "Why?" }, 1).book;
  b = ask(b, { thread: "db", question: "Untouched?" }, 1).book;
  expect(answerMessage(b, "db", {})).toBeUndefined();
  const one = answerMessage(b, "db", {
    q1: { picks: ["SQLite", "Bogus"], note: "" },
  });
  expect(one?.text).toBe("[[db]] q1: SQLite");
  const both = answerMessage(b, "db", {
    q1: { picks: ["SQLite"], note: "keep a JSON\nexport" },
    q2: { picks: [], note: "Concurrency." },
    q3: { picks: [], note: "  " },
  });
  expect(both?.text).toBe(
    "[[db]]\nq1: SQLite (keep a JSON export)\nq2: Concurrency.",
  );
  expect(answersIn(b, both!.text)).toEqual(["q1", "q2"]);
  expect(promptRefs(b, both!.text)).toEqual({
    threads: ["db"],
    questions: ["q1", "q2"],
    subs: [],
  });
  b = markSent(b, both!.answered, 5);
  expect(b.questions.map((q) => q.sent?.text)).toEqual([
    "SQLite (keep a JSON export)",
    "Concurrency.",
    undefined,
  ]);
});

test("a question is a choice by default, a checklist when asked, and no other kind", async () => {
  const b = opened(emptyBook(0), "db");
  const options = ["JSON", "SQLite"];
  expect(
    ask(b, { thread: "db", question: "?", options }, 1).book.questions[0]
      .multiSelect,
  ).toBeUndefined();
  expect(
    ask(b, { thread: "db", question: "?", options, kind: "choice" }, 1).book
      .questions[0].multiSelect,
  ).toBeUndefined();
  expect(
    ask(b, { thread: "db", question: "?", options, kind: "checklist" }, 1).book
      .questions[0].multiSelect,
  ).toBe(true);
  expect(
    ask(b, { thread: "db", question: "?", kind: "checklist" }, 1).book
      .questions[0].multiSelect,
  ).toBeUndefined();
  expect(
    ask(b, { thread: "db", question: "?", options, kind: "ranking" }, 1)
      .isError,
  ).toBe(true);
});

test("an answer typed at the prompt takes the picks drafted on its card, and only an open question's", async () => {
  let b = opened(emptyBook(0), "db");
  b = ask(
    b,
    {
      thread: "db",
      question: "Which?",
      options: ["JSON", "SQLite"],
      kind: "checklist",
    },
    2,
  ).book;
  b = ask(b, { thread: "db", question: "Why?" }, 3).book;
  const drafts = { q1: { picks: ["JSON", "SQLite"], note: "" } };
  expect(joinPicks(b, "q1: both, for now", drafts)).toEqual({
    text: "q1: JSON, SQLite (both, for now)",
    used: ["q1"],
  });
  expect(joinPicks(b, "[[db]] q1:", drafts).text).toBe(
    "[[db]] q1: JSON, SQLite",
  );
  expect(joinPicks(b, "q2: speed\nq1: ok", drafts).text).toBe(
    "q2: speed\nq1: JSON, SQLite (ok)",
  );
  expect(joinPicks(b, "about q1: nothing", drafts).used).toEqual([]);
  b = settle(b, { question: "q1", answer: "JSON" }, 4).book;
  expect(joinPicks(b, "q1: again", drafts).used).toEqual([]);
});

test("a choice names one recommended option at most, and is nudged when it names none", async () => {
  const b = opened(emptyBook(0), "db");
  const one = ask(
    b,
    {
      thread: "db",
      question: "Which?",
      options: [{ label: "JSON" }, { label: "SQLite", recommended: true }],
    },
    2,
  );
  expect(one.isError).toBeUndefined();
  expect(one.book.questions[0].options).toEqual([
    { label: "JSON", description: undefined, preview: undefined },
    {
      label: "SQLite",
      description: undefined,
      preview: undefined,
      recommended: true,
    },
  ]);
  expect(one.message).not.toContain("recommended");
  const two = ask(
    b,
    {
      thread: "db",
      question: "Which?",
      options: [
        { label: "JSON", recommended: true },
        { label: "SQLite", recommended: true },
      ],
    },
    2,
  );
  expect(two.isError).toBe(true);
  const both = ask(
    b,
    {
      thread: "db",
      question: "Which?",
      kind: "checklist",
      options: [
        { label: "JSON", recommended: true },
        { label: "SQLite", recommended: true },
      ],
    },
    2,
  );
  expect(both.isError).toBeUndefined();
  const none = ask(
    b,
    { thread: "db", question: "Which?", options: ["JSON", "SQLite"] },
    2,
  );
  expect(none.message).toContain("No option is marked recommended");
  const free = ask(b, { thread: "db", question: "Why?" }, 2);
  expect(free.message).not.toContain("recommended");
});

test("a row's mark per thread covers that thread's sections, and the same section where another thread holds it", async () => {
  let b = opened(opened(emptyBook(0), "a"), "b");
  b = recordReply(
    startTurn(b, "go", "p1", 2),
    "[[a]] [[b]]\nShared.\n\n[[b]]\nOnly b.",
    "r1",
    3,
  );
  expect(rowThreads(b, "r1")).toEqual([
    { id: "a", isRead: false },
    { id: "b", isRead: false },
  ]);
  b = markRow(b, "r1", "a", true);
  expect(rowThreads(b, "r1")).toEqual([
    { id: "a", isRead: true },
    { id: "b", isRead: false },
  ]);
  b = markRow(b, "r1", "b", true);
  expect(rowThreads(b, "r1").every((x) => x.isRead)).toBe(true);
  expect(rowThreads(b, "nope")).toEqual([]);
});

test("an earlier message or reply section is filed under another thread by quoting it, in its place in time", async () => {
  let b = opened(opened(emptyBook(0), "parser", "Parser"), "lexer", "Lexer");
  b = startTurn(b, "[[parser]] Split the tokens by kind", "u1", 2);
  b = recordReply(
    b,
    "[[parser]]\nSplitting by kind.\n\n[[lexer]]\nTokens take one pass.",
    "r1",
    3,
  );
  b = startTurn(b, "[[lexer]] File my last message here too", "u2", 4);
  // This turn's messages hold nothing new; the earlier one is reached by its words.
  expect(fileUntagged(b, ["lexer"], 5, true).message).toContain("already");
  let out = fileUntagged(b, ["lexer"], 5, true, "split  the TOKENS by kind");
  expect(out.isError).toBeUndefined();
  expect(out.message).toBe("Filed the user's message under [[lexer]] too.");
  b = out.book;
  expect(
    historyOf(b, "lexer").map((x) => [
      x.kind,
      entryText(x),
      x.kind === "event" ? undefined : fromOf(x, "lexer"),
    ]),
  ).toEqual([
    ["event", "Opened.", undefined],
    ["prompt", "[[parser]] Split the tokens by kind", ["parser"]],
    ["reply", "Tokens take one pass.", undefined],
    ["prompt", "[[lexer]] File my last message here too", undefined],
  ]);
  expect(fileUntagged(b, ["lexer"], 6, true, "Split the").message).toContain(
    "already",
  );
  // A section of an earlier reply, with its read state.
  b = markRow(b, "r1", "parser", true);
  out = fileUntagged(b, ["lexer"], 6, false, "Splitting by kind");
  expect(out.message).toBe(
    "Filed that section of your reply under [[lexer]] too.",
  );
  // In its place among the sections of its reply, which it came before.
  expect(historyOf(out.book, "lexer").map(entryText)).toEqual([
    "Opened.",
    "[[parser]] Split the tokens by kind",
    "Splitting by kind.",
    "Tokens take one pass.",
    "[[lexer]] File my last message here too",
  ]);
  expect(historyOf(out.book, "lexer")[2]).toEqual(
    expect.objectContaining({
      kind: "reply",
      text: "Splitting by kind.",
      home: ["parser"],
      read: true,
    }),
  );
  // Words in more than one message, or in none, file nothing.
  out = fileUntagged(b, ["lexer"], 6, false, "kind");
  expect(out.isError).toBe(true);
  expect(out.message).toContain("2 messages hold");
  expect(fileUntagged(b, ["lexer"], 6, true, "kind").isError).toBeUndefined();
  expect(fileUntagged(b, ["lexer"], 6, false, "nowhere").isError).toBe(true);
});

test("a reply that proposes something else is told apart from an answer", async () => {
  let b = opened(emptyBook(0), "plan");
  b = ask(
    b,
    {
      thread: "plan",
      question: "Which?",
      options: [{ label: "A" }, { label: "B" }],
    },
    1,
  ).book;
  b = startTurn(b, "q1: what about C instead?", "u1", 2);
  const context = promptContext(b, "q1: what about C instead?");
  // The prompt carrying the reply says so itself, once.
  expect(context).toContain(
    "one the user proposed rather than one of the options",
  );
  expect(context).toContain("with their proposal among its options");
  expect(context).not.toContain("the user replied");
});

test("a question's id names its subthread: tagged sections, its answers and its events, all within its thread", async () => {
  let b = opened(emptyBook(0), "db", "Cache store");
  b = ask(b, { thread: "db", question: "Which store?" }, 1).book;
  const q = () => b.questions.find((q) => q.id === "q1")!;
  b = startTurn(b, "go on", "u1", 2);
  b = recordReply(
    b,
    "[[db]]\nThe plan.\n\n[[db]] [[q1]]\nq1: which store?",
    "r1",
    3,
  );
  b = startTurn(b, "q1: what about backups?", "u2", 4);
  b = recordReply(b, "[[q1]]\nSQLite backs up as a file.", "r2", 5);
  b = startTurn(b, "[[q1]] side note", "u3", 6);
  // No thread is opened by the tag: everything is in db, and the subthread is what it holds.
  expect(threadOf(b, "q1")).toBeUndefined();
  expect(subEntries(b, q()).map(entryText)).toEqual([
    "Asked q1: Which store?",
    "q1: which store?",
    "q1: what about backups?",
    "SQLite backs up as a file.",
    "[[q1]] side note",
  ]);
  expect(historyOf(b, "db").some((x) => entryText(x) === "The plan.")).toBe(
    true,
  );
  // A tag is not an answer: only the q1: message was sent.
  expect(q().sent?.text).toBe("q1: what about backups?");
  // Its read state is its thread's: opening the subthread reads only what it holds.
  expect(subUnread(b, q())).toBe(3);
  b = markSeen(b, ["q1"]);
  expect(subUnread(b, q())).toBe(0);
  expect(
    historyOf(b, "db").find((x) => entryText(x) === "The plan.")!.read,
  ).toBeUndefined();
  // Claude files an earlier message into it by its id: the thread's own entry joins the subthread.
  const out = fileUntagged(b, ["q1"], 7, false, "The plan");
  expect(out.message).toBe(
    "Filed that section of your reply under [[q1]] too.",
  );
  expect(
    historyOf(out.book, "db").filter((x) => entryText(x) === "The plan."),
  ).toHaveLength(1);
  expect(subEntries(out.book, q()).map(entryText)).toContain("The plan.");
  expect(
    fileUntagged(out.book, ["q1"], 8, false, "The plan").message,
  ).toContain("already");
  // A question's id is not a thread's.
  expect(changeThread(b, { id: "q7", title: "Q" }, 9).isError).toBe(true);
});

test("a thread opened on the user's own messages is not unread until Claude says something there", () => {
  let b = startTurn(emptyBook(0), "Make the cards stand out", "p1", 1);
  b = changeThread(b, { id: "cards", title: "Cards" }, 2).book;
  expect(unread(b, threadOf(b, "cards")!)).toBe(0);
  b = changeThread(b, { id: "cards", title: "Question cards" }, 3).book;
  expect(unread(b, threadOf(b, "cards")!)).toBe(0);
  // Its close carries the outcome, which is news.
  b = changeThread(b, { id: "cards", close: "Shipped." }, 4).book;
  expect(unread(b, threadOf(b, "cards")!)).toBe(1);
  b = changeThread(b, { id: "cards", reopen: true }, 5).book;
  expect(unread(b, threadOf(b, "cards")!)).toBe(1);
});

test("summary and status edits show in the history but are no news; the same again adds nothing", () => {
  let b = changeThread(
    emptyBook(0),
    { id: "cards", title: "Cards", summary: "Start." },
    1,
  ).book;
  expect(historyOf(b, "cards").map(entryText)).toEqual(["Opened."]);
  b = changeThread(b, { id: "cards", summary: "Halfway." }, 2).book;
  const t = threadOf(b, "cards")!;
  expect(historyOf(b, "cards").at(-1)).toEqual({
    kind: "event",
    event: "summary",
    detail: "Halfway.",
    at: 2,
    id: 2,
  });
  // In the history, but no news: the summary says what the thread is.
  expect(unread(b, t)).toBe(0);
  b = changeThread(b, { id: "cards", summary: "Halfway." }, 3).book;
  expect(historyOf(b, "cards")).toHaveLength(2);
  // A status change is no news either: the list's status column shows it.
  b = changeThread(b, { id: "cards", state: "Waiting on q1." }, 4).book;
  expect(threadOf(b, "cards")!.state).toBe("Waiting on q1.");
  expect(entryText(historyOf(b, "cards").at(-1)!)).toBe(
    "Status: Waiting on q1.",
  );
  expect(unread(b, threadOf(b, "cards")!)).toBe(0);
  b = changeThread(b, { id: "cards", state: "Waiting on q1." }, 5).book;
  expect(historyOf(b, "cards")).toHaveLength(3);
});

test("the end of a turn is held for a reply to a question that was neither settled nor revised", () => {
  let b = changeThread(emptyBook(0), { id: "ui", title: "UI" }, 1).book;
  b = ask(
    b,
    { thread: "ui", question: "Colors?", options: ["Fine", "Change"] },
    2,
  ).book;
  b = markSent(
    b,
    [{ id: "q1", text: "q1: I need more threads first", picks: [] }],
    3,
  );
  // Still queued in the pane's outbox, the reply has not reached Claude: no hold yet.
  expect(stopProblems(b, ["q1"])).toBeUndefined();
  expect(stopProblems(b)).toContain(
    "- q1 in [[ui]]: “q1: I need more threads first”",
  );
  expect(stopProblems(b)).toContain("revise: its id");
  // Revised, it waits on the user again; settled, it is done: either ends the hold.
  const revised = ask(
    b,
    {
      thread: "ui",
      question: "Colors, now with more threads?",
      options: ["Fine", "Change"],
      revise: "q1",
    },
    4,
  ).book;
  expect(stopProblems(revised)).toBeUndefined();
  const settled = settle(b, { question: "q1", answer: "Fine" }, 4).book;
  expect(stopProblems(settled)).toBeUndefined();
});

test("settling a question the thread's status names asks for a new status", () => {
  let b = changeThread(emptyBook(0), { id: "ui", title: "UI" }, 1).book;
  b = ask(
    b,
    { thread: "ui", question: "Ring?", options: ["Yes", "No"] },
    2,
  ).book;
  b = changeThread(
    b,
    { id: "ui", state: "Waiting on q1, the user's pick." },
    3,
  ).book;
  expect(settle(b, { question: "q1", answer: "Yes" }, 4).message).toContain(
    `[[ui]]'s status still reads "Waiting on q1, the user's pick."`,
  );
  b = changeThread(b, { id: "ui", state: "Building it; q10 later." }, 5).book;
  expect(settle(b, { question: "q1", answer: "Yes" }, 6).message).toBe(
    "q1 answered.",
  );
});

test("main takes no status", () => {
  const out = changeThread(emptyBook(0), { id: "main", state: "Working." }, 1);
  expect(out.isError).toBe(true);
  expect(out.message).toContain("[[main]] takes no status");
});

test("sortedBy sorts by a column, ascending or descending, main first and closed last", () => {
  let b = emptyBook(0);
  b = changeThread(
    b,
    { id: "zeta", title: "Alpha", state: "Testing." },
    1,
  ).book;
  b = changeThread(
    b,
    { id: "alpha", title: "Zulu", state: "Building." },
    2,
  ).book;
  b = changeThread(b, { id: "mid", title: "Mike" }, 3).book;
  b = changeThread(b, { id: "old", title: "Old", close: "Done." }, 4).book;
  const ids = (sort?: Parameters<typeof sortedBy>[1]) =>
    sortedBy(b, sort).map((t) => t.id);
  expect(ids()).toEqual(ordered(b).map((t) => t.id));
  expect(ids({ by: "id", desc: false })).toEqual([
    "main",
    "alpha",
    "mid",
    "zeta",
    "old",
  ]);
  expect(ids({ by: "id", desc: true })).toEqual([
    "main",
    "zeta",
    "mid",
    "alpha",
    "old",
  ]);
  expect(ids({ by: "title", desc: false })).toEqual([
    "main",
    "zeta",
    "mid",
    "alpha",
    "old",
  ]);
  expect(ids({ by: "status", desc: false })).toEqual([
    "main",
    "mid",
    "alpha",
    "zeta",
    "old",
  ]);
  // Age ascends from the newest.
  expect(ids({ by: "age", desc: false })).toEqual([
    "main",
    "mid",
    "alpha",
    "zeta",
    "old",
  ]);
  b = ask(b, { thread: "zeta", question: "Which?" }, 5).book;
  expect(ids({ by: "waiting", desc: true })[1]).toBe("zeta");
});

test("a prompt carrying an answer gets no hint repeating it; a later prompt does, until it is settled", () => {
  let b = changeThread(emptyBook(0), { id: "ages", title: "Ages" }, 1).book;
  b = ask(
    b,
    { thread: "ages", question: "Which?", options: ["A", "B"] },
    2,
  ).book;
  b = markSent(b, [{ id: "q1", text: "q1: A (and log it)", picks: ["A"] }], 3);
  expect(promptContext(b, "[[ages]] q1: A (and log it)")).not.toContain(
    "the user replied",
  );
  // Sent from the pane and still queued, it reaches the model after other prompts' context: no hint yet.
  expect(promptContext(b, "<task-notification>", false, ["q1"])).not.toContain(
    "the user replied",
  );
  expect(promptContext(b, "Something else")).toContain(
    'the user replied: "q1: A (and log it)"',
  );
});

test("prompts: true files the turn's one message, and, when the user sent more while it ran, asks the model alone which", () => {
  let b = changeThread(emptyBook(0), { id: "cards", title: "Cards" }, 1).book;
  b = startTurn(b, "Show it all", "p1", 2);
  b = joinTurn(
    noteTyped(b, "Make the cards stand out"),
    "Make the cards stand out",
    "p2",
    3,
  );
  // A routine refusal: the user sees a plain result, and the model reads why in the note.
  const out = fileUntagged(b, ["cards"], 4, true);
  expect(out.isError).toBeUndefined();
  expect(out.book).toBe(b);
  expect(out.message).toBe("Filed nothing yet.");
  expect(out.note).toContain('"Show it all"');
  expect(out.note).toContain("quote");
  const quoted = fileUntagged(b, ["cards"], 4, true, "cards stand out");
  expect(quoted.isError).toBeFalsy();
  expect(
    historyOf(quoted.book, "cards")
      .filter((e) => e.kind === "prompt")
      .map(entryText),
  ).toEqual(["Make the cards stand out"]);
});

test("unfile takes a message filed by mistake out of a thread or subthread, never out of where it was sent", () => {
  let b = changeThread(emptyBook(0), { id: "cards", title: "Cards" }, 1).book;
  b = changeThread(b, { id: "plan", title: "Plan" }, 1).book;
  b = ask(b, { thread: "plan", question: "Go?" }, 1).book;
  b = startTurn(b, "[[plan]] Show it all", "p1", 2);
  b = fileUntagged(b, ["cards", "q1"], 3, true, "Show it all").book;
  const has = (id: string) =>
    historyOf(b, id).some((e) => entryText(e) === "[[plan]] Show it all");
  expect(has("cards")).toBe(true);
  const out = unfile(b, ["cards", "q1", "plan"], "show it all", 4, true);
  expect(out.isError).toBeFalsy();
  b = out.book;
  expect(has("cards")).toBe(false);
  expect(has("plan")).toBe(true);
  expect(
    (
      historyOf(b, "plan").find(
        (e) => entryText(e) === "[[plan]] Show it all",
      ) as Message
    ).sub,
  ).toBeUndefined();
  expect(out.message).toContain(
    "Took the user's message out of [[cards]] [[q1]]",
  );
  expect(out.message).toContain("It stays in [[plan]], where it was sent.");
  expect(unfile(b, ["cards"], "nothing like it", 5).isError).toBe(true);
});

test("threads list in the order they were opened, however busy each one is", () => {
  let b = changeThread(emptyBook(0), { id: "first", title: "First" }, 1).book;
  b = changeThread(b, { id: "second", title: "Second" }, 2).book;
  b = changeThread(b, { id: "first", summary: "Busy now." }, 3).book;
  b = recordReply(startTurn(b, "go", "p1", 4), "[[first]]\nMore.", "r1", 5);
  expect(ordered(b).map((t) => t.id)).toEqual(["main", "first", "second"]);
});

test("a status that waits on the user with no open question is flagged at the stop, until a question asks it", () => {
  expect(waitsOnUser("Waiting on the user's look at the diagrams.")).toBe(true);
  expect(waitsOnUser("Awaiting your call on the cut.")).toBe(true);
  expect(waitsOnUser("Waiting on CI.")).toBe(false);
  expect(waitsOnUser("Building what the user asked.")).toBe(false);
  expect(waitsOnUser("Waiting on the build, then reporting to you.")).toBe(
    false,
  );
  expect(waitsOnUser("Waiting for the agent your request started.")).toBe(
    false,
  );
  expect(waitsOnUser("Needs your review.")).toBe(true);
  expect(waitsOnUser("Awaiting your call.")).toBe(true);
  expect(waitsOnUser("Blocked on you: the login.")).toBe(true);
  expect(waitsOnUser("Waiting for the user to log in.")).toBe(true);
  let b = opened(emptyBook(0), "flow");
  const set = changeThread(
    b,
    { id: "flow", state: "Waiting on the user's look at the diagrams." },
    2,
  );
  // The tool's own answer says nothing of it: an ask in the same parallel step lands after it.
  expect(set.message).not.toContain("no open question");
  b = set.book;
  expect(stopProblems(b)).toContain(
    "- [[flow]]: “Waiting on the user's look at the diagrams.”",
  );
  b = ask(
    b,
    { thread: "flow", question: "Do the diagrams read well?" },
    3,
  ).book;
  expect(stopProblems(b)).toBeUndefined();
  b = changeThread(b, { id: "flow", state: "Waiting on CI." }, 4).book;
  b = settle(b, { question: "q1", answer: "Yes." }, 5).book;
  expect(stopProblems(b)).toBeUndefined();
});

test("an answer reads back with its picks and note when sent from the pane, and as settled when typed", () => {
  let b = opened(emptyBook(0), "db");
  b = ask(
    b,
    {
      thread: "db",
      question: "Which stores?",
      kind: "checklist",
      options: ["JSON", "SQLite"],
    },
    2,
  ).book;
  b = ask(
    b,
    {
      thread: "db",
      question: "Which stores now?",
      kind: "checklist",
      options: ["JSON", "SQLite"],
    },
    3,
  ).book;
  const q = (id: string) => b.questions.find((x) => x.id === id)!;
  // From the pane: the picks and the note it was made of.
  const sent = answerMessage(b, "db", {
    q1: { picks: ["SQLite"], note: "for now" },
  })!;
  b = markSent(b, sent.answered, 4);
  b = startTurn(b, sent.text, "u1", 5);
  b = settle(b, { question: "q1", answer: "SQLite" }, 6).book;
  expect(answerShape(q("q1"))).toEqual({ picks: ["SQLite"], note: "for now" });
  // Typed at the prompt: no picks of its own, so the options its answer names, and the answer.
  b = startTurn(b, "q2: json and sqlite both", "u2", 7);
  expect(q("q2").sent?.text).toBe("q2: json and sqlite both");
  expect(q("q2").sent?.picks).toBeUndefined();
  b = settle(b, { question: "q2", answer: "JSON and SQLite" }, 8).book;
  expect(answerShape(q("q2"))).toEqual({
    picks: ["JSON", "SQLite"],
    answer: "JSON and SQLite",
  });
});

test("each event is kept as its type and detail, its text drawn from them, and settling again edits them", () => {
  let b = changeThread(
    emptyBook(0),
    { id: "db", title: "Store", summary: "Pick one." },
    1,
  ).book;
  b = changeThread(
    b,
    {
      id: "db",
      title: "Cache store",
      summary: "Pick a store.",
      state: "Asking.",
    },
    2,
  ).book;
  b = ask(b, { thread: "db", question: "Which store?" }, 3).book;
  b = settle(b, { question: "q1", answer: "SQLite" }, 4).book;
  b = changeThread(b, { id: "db", close: "SQLite it is." }, 5).book;
  b = changeThread(b, { id: "db", reopen: true }, 6).book;
  b = changeThread(b, { id: "db", close: "Done." }, 7).book;
  b = ask(b, { thread: "db", question: "Backups?" }, 8).book;
  const events = () => historyOf(b, "db").filter((x) => x.kind === "event");
  expect(events().map(({ at: _, id: __, ...e }) => e)).toEqual([
    { kind: "event", event: "opened" },
    { kind: "event", event: "renamed", detail: "Cache store" },
    { kind: "event", event: "summary", detail: "Pick a store." },
    { kind: "event", event: "status", detail: "Asking." },
    { kind: "event", event: "asked", detail: "Which store?", question: "q1" },
    { kind: "event", event: "answered", detail: "SQLite", question: "q1" },
    { kind: "event", event: "closed", detail: "SQLite it is." },
    { kind: "event", event: "reopened" },
    { kind: "event", event: "closed", detail: "Done." },
    { kind: "event", event: "reopened-by-ask" },
    { kind: "event", event: "asked", detail: "Backups?", question: "q2" },
  ]);
  expect(events().map(entryText)).toEqual([
    "Opened.",
    "Renamed to “Cache store”.",
    "Summary updated:\nPick a store.",
    "Status: Asking.",
    "Asked q1: Which store?",
    "Answered q1: SQLite",
    "Closed: SQLite it is.",
    "Reopened.",
    "Closed: Done.",
    "Reopened by a question asked in it.",
    "Asked q2: Backups?",
  ]);
  // Bookkeeping is a set of types: what the thread is, and where it stands, are no news.
  const t = threadOf(b, "db")!;
  expect(events().map((e) => isRead(b, t, e))).toEqual([
    true,
    true,
    true,
    true,
    false,
    false,
    false,
    true,
    false,
    false,
    false,
  ]);
  // Settled again the other way, the event takes the new type and words in place.
  b = settle(b, { question: "q1", retract: "Tabled." }, 9).book;
  expect(events()[5]).toMatchObject({
    kind: "event",
    event: "retracted",
    detail: "Tabled.",
    question: "q1",
    at: 4,
  });
});

test("a status starts with what is happening now, never with what is done", () => {
  let b = changeThread(emptyBook(0), { id: "plan", title: "Plan" }, 1).book;
  for (const state of [
    "Merged the branch; cleaning up the tests next.",
    "3 tests left to fix.",
    "A root-cause agent is looking at it.",
    "Waits on the build.",
    "Nothing left to do.",
  ]) {
    const out = changeThread(b, { id: "plan", state }, 2);
    expect(out.isError).toBe(true);
    expect(out.message).toContain(state);
    expect(threadOf(out.book, "plan")!.state).toBeUndefined();
  }
  for (const state of [
    "Testing the fix.",
    "Waiting on q3, the user's check.",
    "Awaiting the build.",
    "Holding the turn open for the test.",
    "Root-causing the field bug in a background agent.",
    "",
  ]) {
    const out = changeThread(b, { id: "plan", state }, 2);
    expect(out.isError).toBeFalsy();
    b = out.book;
  }
});

test("a book whose events are words reads with each event typed, drawn in the same words and read as it was", () => {
  // Events as text, a question's named on the entry too.
  const kept = {
    threads: [
      {
        id: "main",
        title: "The session as a whole",
        summary: "",
        status: "open",
        createdAt: 1,
        updatedAt: 1,
        touchedTurn: 0,
        entries: [],
      },
      {
        id: "db",
        title: "Cache store",
        summary: "Pick a store.",
        state: "Asking.",
        status: "open",
        createdAt: 1,
        updatedAt: 9,
        touchedTurn: 1,
        entries: [
          { kind: "event", text: "Opened.", at: 1 },
          { kind: "event", text: "Renamed to “Cache store”.", at: 2 },
          { kind: "event", text: "Summary updated:\nPick a store.", at: 2 },
          { kind: "event", text: "Summary updated.", at: 2 },
          { kind: "event", text: "Status: Asking.", at: 2 },
          {
            kind: "event",
            text: "Asked q1: Which store?",
            at: 3,
            question: "q1",
          },
          {
            kind: "prompt",
            text: "q1: SQLite",
            uuid: "u1",
            at: 4,
            sub: ["q1"],
          },
          {
            kind: "event",
            text: "Answered q1: SQLite",
            at: 5,
            question: "q1",
            read: true,
          },
          { kind: "event", text: "Closed: Chosen.", at: 6 },
          { kind: "event", text: "Reopened.", at: 7 },
          { kind: "event", text: "Reopened by a reply tagged with it.", at: 8 },
          { kind: "event", text: "Reopened by a question asked in it.", at: 9 },
          { kind: "event", text: "Retracted q2: Moot.", at: 9 },
        ],
      },
    ],
    questions: [
      {
        id: "q1",
        thread: "db",
        text: "Which store?",
        status: "answered",
        askedAt: 3,
        sent: { text: "q1: SQLite", at: 4 },
        resolution: "SQLite",
        settledAt: 5,
      },
    ],
    nextQuestion: 3,
    turn: { n: 1, active: [], touched: [], untagged: [] },
  };
  const up = readBook(kept as Parameters<typeof readBook>[0]);
  const old = kept.threads[1].entries;
  const entries = historyOf(up, "db");
  // Each draws as it was written, and reads as read or unread as it did.
  expect(entries.map(entryText)).toEqual(
    old.map((x) => ("text" in x ? x.text : "")),
  );
  expect(entries.map((x) => (x.kind === "event" ? x.event : x.kind))).toEqual([
    "opened",
    "renamed",
    "summary",
    "summary",
    "status",
    "asked",
    "prompt",
    "answered",
    "closed",
    "reopened",
    "note",
    "reopened-by-ask",
    "retracted",
  ]);
  expect(entries[3]).toEqual({ kind: "event", event: "summary", at: 2, id: 4 });
  expect(entries[12]).toMatchObject({
    kind: "event",
    event: "retracted",
    question: "q2",
    detail: "Moot.",
    at: 9,
  });
  expect(entries.some((x) => x.kind === "event" && "text" in x)).toBe(false);
  const t = threadOf(up, "db")!;
  expect(entries.filter((x) => !isRead(up, t, x)).map(entryText)).toEqual([
    "Asked q1: Which store?",
    "Closed: Chosen.",
    "Reopened by a reply tagged with it.",
    "Reopened by a question asked in it.",
    "Retracted q2: Moot.",
  ]);
  expect(subEntries(up, up.questions[0]).map(entryText)).toEqual([
    "Asked q1: Which store?",
    "q1: SQLite",
    "Answered q1: SQLite",
  ]);
  // Read once, a book reads back the same.
  expect(readBook(up)).toEqual(up);
});

test("a message filed under several threads is kept once: read anywhere it is read everywhere, and filing and unfiling edit where it is held", () => {
  let b = opened(opened(emptyBook(0), "plan"), "lexer");
  b = ask(b, { thread: "plan", question: "Go?" }, 1).book;
  b = startTurn(b, "go", "u1", 2);
  b = recordReply(
    b,
    "[[plan]] [[lexer]]\nShared plan.\n\n[[plan]]\nOwn.",
    "r1",
    3,
  );
  const shared = () => b.messages.find((m) => m.text === "Shared plan.")!;
  expect(b.messages.map((m) => m.text)).toEqual(["go", "Shared plan.", "Own."]);
  expect(shared()).toMatchObject({
    threads: ["plan", "lexer"],
    home: ["plan", "lexer"],
  });
  // Filed under main and q1's subthread, it is still one message.
  b = fileUntagged(b, ["main", "q1"], 4, false, "Shared plan").book;
  expect(b.messages).toHaveLength(3);
  expect(shared()).toMatchObject({
    threads: ["plan", "lexer", "main"],
    home: ["plan", "lexer"],
    sub: ["q1"],
  });
  expect(fromOf(shared(), "main")).toEqual(["plan", "lexer"]);
  expect(fromOf(shared(), "plan")).toBeUndefined();
  // One read flag: opening lexer reads it in plan and main too, and nothing else of the row.
  b = markSeen(b, ["lexer"]);
  expect(shared().read).toBe(true);
  expect(b.messages.find((m) => m.text === "Own.")!.read).toBeUndefined();
  expect(unread(b, threadOf(b, "main")!)).toBe(0);
  // Unfiled from main, it leaves main and the subthread; where it was written it stays.
  const out = unfile(b, ["main", "q1", "plan"], "Shared plan", 5);
  expect(out.message).toContain("It stays in [[plan]], where it was written.");
  b = out.book;
  expect(shared()).toMatchObject({ threads: ["plan", "lexer"] });
  expect(shared().sub).toBeUndefined();
  expect(historyOf(b, "main").map(entryText)).toEqual(["go"]);
});

test("a thread keeps its latest 200 entries, and a message no thread holds any more goes", () => {
  let b = opened(opened(emptyBook(0), "a"), "b");
  b = startTurn(b, "go", "u1", 2);
  b = recordReply(b, "[[a]]\nOnly a.\n\n[[a]] [[b]]\nShared.", "r0", 3);
  for (let i = 1; i <= 200; i++)
    b = recordReply(b, `[[a]]\nA ${i}.`, `r${i}`, 3 + i);
  expect(historyOf(b, "a")).toHaveLength(200);
  expect(historyOf(b, "a")[0]).toMatchObject({ text: "A 1." });
  // Out of a, the shared section stays in b; a's own oldest went.
  expect(b.messages.find((m) => m.text === "Shared.")!.threads).toEqual(["b"]);
  expect(b.messages.some((m) => m.text === "Only a.")).toBe(false);
  expect(b.messages).toHaveLength(202);
});

test("a book with a copy of each message in each thread holding it reads with each message kept once", () => {
  const kept = {
    threads: [
      {
        id: "main",
        title: "The session as a whole",
        summary: "",
        status: "open",
        createdAt: 1,
        updatedAt: 6,
        touchedTurn: 1,
        entries: [
          { kind: "prompt", text: "Plan it", uuid: "u1", at: 2 },
          { kind: "reply", text: "Shared.", uuid: "r1", at: 4, from: ["plan"] },
        ],
      },
      {
        id: "plan",
        title: "Plan",
        summary: "",
        status: "open",
        createdAt: 1,
        updatedAt: 6,
        touchedTurn: 1,
        entries: [
          { kind: "event", event: "opened", at: 1 },
          {
            kind: "event",
            event: "asked",
            detail: "Go?",
            question: "q1",
            at: 1,
          },
          {
            kind: "prompt",
            text: "Plan it",
            uuid: "u1",
            at: 2,
            from: ["main"],
          },
          {
            kind: "reply",
            text: "Shared.",
            uuid: "r1",
            at: 4,
            sub: ["q1"],
            read: true,
          },
          { kind: "reply", text: "Own.", uuid: "r1", at: 4 },
          { kind: "event", event: "status", detail: "Planning.", at: 5 },
        ],
      },
      {
        id: "lexer",
        title: "Lexer",
        summary: "",
        status: "open",
        createdAt: 1,
        updatedAt: 6,
        touchedTurn: 1,
        entries: [
          { kind: "event", event: "opened", at: 1 },
          { kind: "reply", text: "Shared.", uuid: "r1", at: 4, read: true },
        ],
      },
    ],
    questions: [
      { id: "q1", thread: "plan", text: "Go?", status: "open", askedAt: 1 },
    ],
    nextQuestion: 2,
    turn: {
      n: 1,
      active: ["plan"],
      touched: ["main", "plan"],
      untagged: [],
      loose: [{ text: "Plan it", uuid: "u1", at: 2, in: ["main"] }],
    },
  };
  const up = readBook(kept as Parameters<typeof readBook>[0]);
  expect(up.messages.map(({ id: _, ...m }) => m)).toEqual([
    {
      kind: "prompt",
      text: "Plan it",
      uuid: "u1",
      at: 2,
      threads: ["main", "plan"],
      home: ["main"],
    },
    {
      kind: "reply",
      text: "Shared.",
      uuid: "r1",
      at: 4,
      threads: ["main", "plan", "lexer"],
      home: ["plan", "lexer"],
      sub: ["q1"],
      read: true,
    },
    {
      kind: "reply",
      text: "Own.",
      uuid: "r1",
      at: 4,
      threads: ["plan"],
      home: ["plan"],
    },
  ]);
  // Each history reads as it did, in its order, from the threads it came from where filed.
  for (const t of kept.threads)
    expect(historyOf(up, t.id).map(entryText)).toEqual(
      t.entries.map((x) =>
        "text" in x ? x.text : entryText({ ...x, id: 0 } as never),
      ),
    );
  expect(
    historyOf(up, "main").map((x) =>
      x.kind === "event" ? undefined : fromOf(x, "main"),
    ),
  ).toEqual([undefined, ["plan", "lexer"]]);
  // Ids follow the order things came, and the next one comes after them all.
  const ids = [...up.messages, ...up.threads.flatMap((t) => t.events)].map(
    (x) => x.id,
  );
  expect(new Set(ids).size).toBe(ids.length);
  expect(up.nextEntry).toBe(Math.max(...ids) + 1);
  expect(up.turn.loose).toEqual([up.messages[0].id]);
  expect(threadOf(up, "plan")!.events.map((e) => e.event)).toEqual([
    "opened",
    "asked",
    "status",
  ]);
  expect("entries" in threadOf(up, "plan")!).toBe(false);
  expect(subEntries(up, up.questions[0]).map(entryText)).toEqual([
    "Asked q1: Go?",
    "Shared.",
  ]);
  expect(readBook(up)).toEqual(up);
});

test("whether an answer reached Claude goes by the questions a message answers, not by its words", () => {
  let b = opened(emptyBook(0), "ui");
  b = ask(b, { thread: "ui", question: "Ship it?" }, 1).book;
  b = ask(b, { thread: "ui", question: "Tag it?" }, 2).book;
  // Both answered "yes": q1 reached Claude, q2 is still in the pane's outbox.
  b = markSent(b, [{ id: "q1", text: "yes" }], 3);
  b = markSent(b, [{ id: "q2", text: "yes", picks: [] }], 4);
  const held = stopProblems(b, ["q2"]);
  expect(held).toContain("- q1 in [[ui]]: “yes”");
  expect(held).not.toContain("- q2 in [[ui]]");
  // The prompt carrying q2's answer delivers q2's, and says nothing of q1's, which a hint still repeats.
  const context = promptContext(b, "[[ui]] q2: yes", true);
  expect(context).toContain(
    '- q1 in [[ui]]: Ship it? (the user replied: "yes"',
  );
  expect(context).not.toContain("Tag it? (the user replied");
});

test("a message typed while a turn ran that never joined is let go a turn later, and typed text stored alone is dated to its turn", () => {
  let b = startTurn(emptyBook(0), "go", "u1", 1);
  b = noteTyped(noteTyped(b, "first"), "second");
  // The turn ends before either joins: the first starts the next turn, the second may still join it.
  b = startTurn(b, "first", "u2", 2);
  expect(b.turn.typed).toEqual([{ text: "second", turn: 1 }]);
  // It never did: the turn after lets it go, and keeps what was typed in the turn that just ended.
  b = noteTyped(b, "third");
  b = startTurn(b, "next", "u3", 3);
  expect(b.turn.typed).toEqual([{ text: "third", turn: 2 }]);
  b = startTurn(b, "later", "u4", 4);
  expect(b.turn.typed).toBeUndefined();
  // A typed message stored as its text alone.
  const kept = { ...b, turn: { ...b.turn, n: 7, typed: ["old"] } };
  expect(readBook(kept).turn.typed).toEqual([{ text: "old", turn: 7 }]);
  const up = readBook(kept);
  expect(readBook(up)).toEqual(up);
});

test("a closed thread keeps its latest 50 entries, and a settled question its history no longer shows goes", () => {
  let b = opened(opened(emptyBook(0), "old"), "other");
  b = ask(b, { thread: "old", question: "Early?" }, 1).book;
  b = settle(b, { question: "q1", answer: "Yes." }, 1).book;
  b = ask(b, { thread: "old", question: "Still open?" }, 1).book;
  b = startTurn(b, "go", "u1", 2);
  b = recordReply(b, "[[old]] [[other]] [[q1]]\nShared.", "r0", 2);
  for (let i = 1; i <= 60; i++)
    b = recordReply(b, `[[old]]\nStep ${i}.`, `r${i}`, 2 + i);
  // Open, it keeps all of it.
  expect(historyOf(b, "old")).toHaveLength(65);
  b = changeThread(b, { id: "old", close: "Done." }, 70).book;
  const h = historyOf(b, "old");
  expect(h).toHaveLength(50);
  expect(entryText(h.at(-1)!)).toBe("Closed: Done.");
  // The settled question went with its events; the open one stays, and ids go on from where they were.
  expect(b.questions.map((q) => q.id)).toEqual(["q2"]);
  expect(b.messages.find((m) => m.text === "Shared.")).toMatchObject({
    threads: ["other"],
  });
  expect(b.messages.find((m) => m.text === "Shared.")!.sub).toBeUndefined();
  b = ask(b, { thread: "other", question: "Next?" }, 71).book;
  expect(b.questions.at(-1)!.id).toBe("q3");
});

test("a stored book past its bounds is bounded once when read: a closed thread to its latest 50 entries", () => {
  let b = opened(emptyBook(0), "old");
  b = startTurn(b, "go", "u1", 2);
  for (let i = 1; i <= 60; i++)
    b = recordReply(b, `[[old]]\nStep ${i}.`, `r${i}`, 2 + i);
  // Stored closed, with its whole history.
  const kept = {
    ...b,
    threads: b.threads.map((t) =>
      t.id === "old"
        ? { ...t, status: "closed" as const, outcome: "Done." }
        : t,
    ),
  };
  expect(historyOf(kept, "old")).toHaveLength(61);
  const up = readBook(kept);
  expect(historyOf(up, "old")).toHaveLength(50);
  expect(readBook(up)).toEqual(up);
});

test("a book without closedRead marks its closed threads read once on loading, and a new book never does", () => {
  let b = opened(opened(emptyBook(0), "parser"), "lexer");
  b = recordReply(startTurn(b, "go", "u1", 2), "[[parser]]\nShipped.", "r1", 3);
  b = recordReply(b, "[[lexer]]\nStill open.", "r2", 4);
  b = changeThread(b, { id: "parser", close: "Shipped." }, 5).book;
  const { closedRead: _, ...old } = b;
  const up = readBook(old);
  expect(up.closedRead).toBe(true);
  expect(unread(up, threadOf(up, "parser")!)).toBe(0);
  expect(unread(up, threadOf(up, "lexer")!)).toBeGreaterThan(0);
  // A thread closed after that keeps its unread entries.
  const later = changeThread(up, { id: "lexer", close: "Done." }, 6).book;
  expect(unread(readBook(later), threadOf(later, "lexer")!)).toBeGreaterThan(0);
});
