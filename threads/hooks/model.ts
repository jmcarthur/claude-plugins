import type {
  Book,
  Draft,
  Entry,
  EventType,
  Message,
  Question,
  QuestionOption,
  Piece,
  SortKey,
  Thread,
  ThreadEvent,
  Turn,
} from "../types";
import { claimSlots, statusParts } from "./color";

export type {
  Book,
  Draft,
  Entry,
  EventType,
  Message,
  Question,
  Piece,
  QuestionOption,
  Thread,
  ThreadEvent,
  Turn,
} from "../types";

// The threads of one session, as plain data, and every change to them as a pure function of the book and
// the time. The hooks module holds the book in `$.state` and calls these; the tests call them directly.

export const MAIN = "main";
// An open thread other than main that nobody has touched for this many prompts is named idle in the
// context each prompt carries, and an open question on such a thread is called stale, so that the
// session closes or retracts what is done (see idleFor and isStale).
const STALE_PROMPTS = 3;
// One entry's text, and one thread's history, are kept to these, so a long session's state stays small.
const MAX_ENTRY = 20_000;
const MAX_ENTRIES = 200;
// A closed thread keeps its latest entries alone: its outcome and what led to it.
const MAX_CLOSED_ENTRIES = 50;

// A thread's id, as a pattern's source: every pattern below that names a thread builds on it.
const TAG_ID = "[a-z0-9][a-z0-9-]{0,47}";
const ID = new RegExp(`^${TAG_ID}$`);
const TAG = new RegExp(`\\[\\[(${TAG_ID})\\]\\]`, "g");
const TAG_LINE = new RegExp(`^[ \\t]*(?:\\[\\[${TAG_ID}\\]\\][ \\t]*)+$`);
// What a prompt opens with to say what it answers: thread tags and question ids, as `[[parser]] q3: yes`.
const PROMPT_REF = new RegExp(
  `^[ \\t]*(?:\\[\\[(${TAG_ID})\\]\\]|(q\\d+)\\b)[ \\t]*[:,]?`,
);
// A line answering a question by its id, after any tags: the tags and id, the id, and the answer.
const ANSWER = `^([ \\t]*(?:\\[\\[${TAG_ID}\\]\\][ \\t]*)*(q\\d+)[ \\t]*:)(.*)$`;

// What a model tool answers. `note` goes to the model alone, after the message: for a routine
// refusal that the user need not see as an error.
export type Outcome = {
  book: Book;
  message: string;
  isError?: true;
  note?: string;
};

// A stored book in other shapes than Book's, which `readBook` reads: each thread holds a copy of
// every message it holds, marked with the threads it came from when filed there by Claude, and events
// have no id.
type StoredMessage = Omit<Message, "id" | "threads" | "home"> & {
  from?: string[] | string;
};
type StoredEvent = Omit<ThreadEvent, "id">;
type StoredEntry =
  | StoredMessage
  | StoredEvent
  // An event kept as its words, naming its question in the words and perhaps on the entry too.
  | {
      kind: "event";
      text: string;
      at: number;
      question?: string;
      read?: boolean;
    };
type StoredThread = Omit<Thread, "events"> & {
  entries: StoredEntry[];
  // When the user last had the thread open: entries before it were seen.
  seenAt?: number;
};
type StoredBook = Omit<
  Book,
  "threads" | "questions" | "turn" | "messages" | "nextEntry"
> & {
  threads: StoredThread[];
  // An option kept as its label alone.
  questions: (Omit<Question, "options"> & {
    options?: (QuestionOption | string)[];
  })[];
  turn: Omit<Turn, "untagged" | "loose" | "typed"> & {
    // A typed message kept as its text alone.
    typed?: (string | { text: string; turn: number })[];
    // Untagged text kept alone, without its row.
    untagged: (Piece | string)[];
    // The turn's messages of the user's as pieces, with the threads each was filed under; one kept
    // with no threads was untagged: main's.
    loose?: (Piece & { in?: string[] })[];
    // Untagged messages kept here until a section was filed.
    waiting?: Piece[];
  };
};

// An event kept in words, by its type and detail: the words of each type, the detail being the rest.
// Words matching none are kept as a note.
const WORDED_EVENTS: [RegExp, EventType][] = [
  [/^Opened\.$/, "opened"],
  [/^Reopened\.$/, "reopened"],
  [/^Reopened by a question asked in it\.$/, "reopened-by-ask"],
  [/^Renamed to “([\s\S]*)”\.$/, "renamed"],
  [/^Renamed to ([\s\S]*)$/, "renamed"],
  [/^Summary updated\.$/, "summary"],
  [/^Summary updated:\n([\s\S]*)$/, "summary"],
  [/^Status: ([\s\S]*)$/, "status"],
  [/^Closed: ([\s\S]*)$/, "closed"],
];
const WORDED_QUESTION_EVENT =
  /^(Asked|Revised|Answered|Retracted) (q\d+): ([\s\S]*)$/;

const typedEvent = (x: {
  text: string;
  at: number;
  question?: string;
  read?: boolean;
}): StoredEvent => {
  const base = {
    kind: "event" as const,
    at: x.at,
    ...(x.read === undefined ? {} : { read: x.read }),
  };
  const q = WORDED_QUESTION_EVENT.exec(x.text);
  if (q !== null)
    return {
      ...base,
      event: q[1].toLowerCase() as EventType,
      question: x.question ?? q[2],
      detail: q[3],
    };
  for (const [pattern, event] of WORDED_EVENTS) {
    const m = pattern.exec(x.text);
    if (m !== null)
      return {
        ...base,
        event,
        ...(m[1] === undefined ? {} : { detail: m[1] }),
      };
  }
  return { ...base, event: "note", detail: x.text };
};

// A thread's copy of an entry, read into one shape: an event typed, a message's `from` a list.
type Copy =
  | StoredEvent
  | (Omit<StoredMessage, "from"> & {
      kind: "prompt" | "reply";
      from?: string[];
    });

const readEntry = (x: StoredEntry, seenAt: number | undefined): Copy => {
  let y: Copy;
  if (x.kind === "event") y = "text" in x ? typedEvent(x) : x;
  else {
    const { from, ...rest } = x;
    y = from === undefined ? rest : { ...rest, from: [from].flat() };
  }
  // A thread's seenAt read every entry before it as seen; each entry keeps its own now.
  if (
    seenAt !== undefined &&
    y.kind !== "prompt" &&
    y.read === undefined &&
    y.at <= seenAt
  )
    y = { ...y, read: true };
  return y;
};

// A message's copies in a book of copies are the same message: the same part of the same row.
const copyKey = (x: { kind: string; uuid?: string; text: string }) =>
  `${x.kind}\n${x.uuid ?? ""}\n${x.text}`;

// The threads of a book that kept a copy of each message per thread, as threads of events and the
// messages kept once: each copy's thread holds the message, and the threads it was sent or written
// under are those holding a copy that names none it came from. Every message and event takes an id
// in the order of their times, ties in the order the threads held them.
const keptOnce = (
  threads: { id: string; entries: Copy[] }[],
): {
  messages: Message[];
  events: Map<string, ThreadEvent[]>;
  next: number;
} => {
  type Item = { at: number; ti: number; ei: number; copy: Copy };
  const items: Item[] = [];
  const groups = new Map<string, { first: Item; holders: [string, Copy][] }>();
  threads.forEach((t, ti) =>
    t.entries.forEach((copy, ei) => {
      const item = { at: copy.at, ti, ei, copy };
      if (copy.kind === "event") {
        items.push(item);
        return;
      }
      const k = copyKey(copy);
      const g = groups.get(k);
      if (g === undefined) {
        groups.set(k, { first: item, holders: [[t.id, copy]] });
        items.push(item);
      } else if (!g.holders.some(([id]) => id === t.id))
        g.holders.push([t.id, copy]);
    }),
  );
  items.sort((a, b) => a.at - b.at || a.ti - b.ti || a.ei - b.ei);
  const messages: Message[] = [];
  const events = new Map<string, ThreadEvent[]>();
  let id = 1;
  for (const item of items) {
    const { copy } = item;
    if (copy.kind === "event") {
      const tid = threads[item.ti].id;
      events.set(tid, [...(events.get(tid) ?? []), { ...copy, id: id++ }]);
      continue;
    }
    const { holders } = groups.get(copyKey(copy))!;
    const home = holders.filter(([, c]) => c.kind !== "event" && !c.from);
    const sub = [
      ...new Set(
        holders.flatMap(([, c]) => (c.kind === "event" ? [] : (c.sub ?? []))),
      ),
    ];
    const reads = holders.map(([, c]) => c.read);
    const read = reads.includes(true)
      ? true
      : reads.includes(false)
        ? false
        : undefined;
    const { from, sub: _, read: __, ...rest } = copy;
    messages.push({
      ...rest,
      id: id++,
      threads: holders.map(([tid]) => tid),
      home:
        home.length > 0 ? home.map(([tid]) => tid) : (from ?? [holders[0][0]]),
      ...(sub.length > 0 ? { sub } : {}),
      ...(read === undefined ? {} : { read }),
    });
  }
  return { messages, events, next: id };
};

// A book in Book's shapes, from any shape the store or the state may hold: a book `--resume` finds
// in the store, or the one in the plugin's state when the plugin's code is updated and loads again.
// One already in Book's shapes comes back as it was.
export const readBook = (book: StoredBook | KeptOnce): Book => {
  const b =
    "messages" in book && Array.isArray(book.messages)
      ? (book as KeptOnce)
      : keptOnceBook(book as StoredBook);
  const { typed, ...turn } = b.turn;
  return closedRead({
    ...b,
    turn: {
      ...turn,
      // A message typed while a turn ran, kept by its text alone, was typed in the turn the book is at.
      ...(typed === undefined
        ? {}
        : {
            typed: typed.map((t) =>
              typeof t === "string" ? { text: t, turn: b.turn.n } : t,
            ),
          }),
    },
  });
};

// A closed thread with unread entries keeps its row above the closed fold. A book without
// `closedRead` marks the closed threads it holds read once, so that they do not all come back
// above the fold together.
const closedRead = (book: Book): Book => {
  const b = bounded(book);
  if (b.closedRead === true) return b;
  const closed = b.threads.filter((t) => t.status === "closed");
  return {
    ...(closed.length > 0
      ? markSeen(
          b,
          closed.map((t) => t.id),
        )
      : b),
    closedRead: true,
  };
};

// A book that keeps each message once, with a typed message perhaps as its text alone.
type KeptOnce = Omit<Book, "turn"> & {
  turn: Omit<Turn, "typed"> & {
    typed?: (string | { text: string; turn: number })[];
  };
};

// A book that keeps a copy of each message per thread, read as one that keeps each message once.
const keptOnceBook = (stored: StoredBook): KeptOnce => {
  const { waiting, loose, ...turn } = stored.turn;
  const copies = stored.threads.map(({ seenAt, ...t }) => ({
    id: t.id,
    entries: [
      ...t.entries.map((x) => readEntry(x, seenAt)),
      // Messages kept waiting go under main.
      ...(t.id === MAIN
        ? (waiting ?? []).map((w): Copy => ({ kind: "prompt", ...w }))
        : []),
    ],
  }));
  const { messages, events, next } = keptOnce(copies);
  // The turn's messages of the user's, by id: the one with the piece's text and row.
  const looseIds = (loose ?? []).flatMap((p) => {
    const m = messages.find(
      (m) => m.kind === "prompt" && m.text === p.text && m.uuid === p.uuid,
    );
    return m === undefined ? [] : [m.id];
  });
  return {
    ...stored,
    threads: stored.threads.map(({ seenAt: _, entries: __, ...t }) => ({
      ...t,
      events: events.get(t.id) ?? [],
    })),
    messages,
    nextEntry: next,
    questions: stored.questions.map(({ options, ...q }) => ({
      ...q,
      ...(options === undefined
        ? {}
        : {
            options: options.map((o) =>
              typeof o === "string" ? { label: o } : o,
            ),
          }),
      // A book of copies may keep an answer typed at the prompt with no picks, as a pane send of
      // nothing picked: only a checklist sent with none checked is that, with its own words.
      ...(q.sent?.picks?.length === 0 &&
      q.sent.note === undefined &&
      q.sent.text !== "none checked"
        ? { sent: { text: q.sent.text, at: q.sent.at } }
        : {}),
    })),
    turn: {
      ...turn,
      untagged: turn.untagged.map((p) =>
        typeof p === "string" ? { text: p, at: 0 } : p,
      ),
      ...(loose === undefined ? {} : { loose: looseIds }),
    },
  };
};

export const emptyBook = (now: number): Book => ({
  threads: [
    {
      id: MAIN,
      title: "The session as a whole",
      summary: "",
      status: "open",
      createdAt: now,
      updatedAt: now,
      touchedTurn: 0,
      events: [],
    },
  ],
  messages: [],
  nextEntry: 1,
  closedRead: true,
  questions: [],
  nextQuestion: 1,
  turn: { n: 0, active: [], touched: [], untagged: [] },
});

const isId = (id: string) => ID.test(id);

const tagsIn = (text: string): string[] => [
  ...new Set([...text.matchAll(TAG)].map((m) => m[1])),
];

// The threads and questions a prompt opens with, as `[[parser]] yes, go ahead`. A question's id names its thread too, so `q3: yes` is
// filed under q3's thread; an id that names no question is left as text.
export const promptRefs = (
  book: Book,
  text: string,
): { threads: string[]; questions: string[]; subs: string[] } => {
  const threads: string[] = [];
  const questions: string[] = [];
  // Questions a tag names, as `[[q3]] about this`: their subthreads, which the message does not answer.
  const subs: string[] = [];
  let rest = text;
  for (;;) {
    const m = PROMPT_REF.exec(rest);
    if (m === null) break;
    const named = m[1] === undefined ? undefined : questionNamed(book, m[1]);
    if (named !== undefined) {
      subs.push(named.id);
      threads.push(named.thread);
    } else if (m[1] !== undefined) threads.push(m[1]);
    else {
      const q = questionOf(book, m[2]);
      if (q === undefined) break;
      questions.push(q.id);
      threads.push(q.thread);
    }
    rest = rest.slice(m[0].length);
  }
  for (const id of answersIn(book, text)) {
    questions.push(id);
    threads.push(questionOf(book, id)?.thread ?? MAIN);
  }
  return {
    threads: [...new Set(threads)],
    questions: [...new Set(questions)],
    subs: [...new Set(subs)],
  };
};

// A question's id names its subthread: `[[q3]]` is q3's thread, within q3's subthread.
const questionNamed = (book: Book, id: string) =>
  /^q\d+$/.test(id) ? questionOf(book, id) : undefined;

// The threads that ids name, each once, with the subthreads of it they name, and whether one names the
// thread itself, not only its subthreads.
const targets = (
  book: Book,
  ids: string[],
): { thread: string; subs: string[]; whole: boolean }[] => {
  const out = new Map<string, { subs: string[]; whole: boolean }>();
  for (const id of ids) {
    const q = questionNamed(book, id);
    const thread = q?.thread ?? id;
    const at = out.get(thread) ?? { subs: [], whole: false };
    if (q === undefined) at.whole = true;
    else if (!at.subs.includes(q.id)) at.subs.push(q.id);
    out.set(thread, at);
  }
  return [...out].map(([thread, x]) => ({ thread, ...x }));
};

// Whether a question's subthread holds an entry: one filed under it, or one of the question's events.
const inSub = (x: Entry, question: string) =>
  x.kind === "event"
    ? x.question === question
    : x.sub?.includes(question) === true;

// Each thread's history, by its id: the messages it holds and its events, in the order of their ids.
// Found once per version of the book, whose values are never changed in place.
const histories = new WeakMap<Book, ReadonlyMap<string, Entry[]>>();
const historyIndex = (book: Book): ReadonlyMap<string, Entry[]> => {
  const found = histories.get(book);
  if (found !== undefined) return found;
  const held = new Map<string, Message[]>();
  for (const m of book.messages)
    for (const id of m.threads) {
      const ms = held.get(id);
      if (ms === undefined) held.set(id, [m]);
      else ms.push(m);
    }
  const index = new Map<string, Entry[]>();
  for (const t of book.threads) {
    const ms = held.get(t.id) ?? [];
    const es = t.events;
    const out: Entry[] = [];
    let i = 0;
    let j = 0;
    while (i < ms.length || j < es.length)
      out.push(
        j >= es.length || (i < ms.length && ms[i].id < es[j].id)
          ? ms[i++]
          : es[j++],
      );
    index.set(t.id, out);
  }
  histories.set(book, index);
  return index;
};

// A thread's history: the messages it holds and its events, in the order they came.
export const historyOf = (book: Book, id: string): Entry[] =>
  historyIndex(book).get(id) ?? [];

// A question's subthread: the entries of its thread that it holds.
export const subEntries = (book: Book, q: Question): Entry[] =>
  historyOf(book, q.thread).filter((x) => inSub(x, q.id));

// How many of a subthread's entries the user has not seen, in its thread, which they share.
export const subUnread = (book: Book, q: Question): number => {
  const t = threadOf(book, q.thread);
  return t === undefined
    ? 0
    : subEntries(book, q).filter((x) => !isRead(book, t, x)).length;
};

// The threads a message shows as from in a thread that holds it: those it was sent or written under,
// when Claude filed it there as well; none where it was sent or written.
export const fromOf = (m: Message, thread: string): string[] | undefined =>
  m.home.includes(thread) ? undefined : m.home;

// A place that holds a message: a thread, or a subthread within it.
export type Holder = { thread: string; question?: string };

// The places that hold a message, in the book's order of threads: each thread holding it, then each
// subthread it is in there. An event has none.
export const holdersOf = (book: Book, x: Entry): Holder[] =>
  x.kind === "event"
    ? []
    : book.threads
        .filter((t) => x.threads.includes(t.id))
        .flatMap((t) => [
          { thread: t.id },
          ...(x.sub ?? [])
            .filter((q) => questionOf(book, q)?.thread === t.id)
            .map((q) => ({ thread: t.id, question: q })),
        ]);

// Where an entry the view holds on is in a history, by its id: that entry, or else the first one after
// it.
export const findIn = (entries: Entry[], id: number | undefined): number => {
  if (id === undefined) return -1;
  const i = entries.findIndex((x) => x.id === id);
  return i >= 0 ? i : entries.findIndex((x) => x.id > id);
};

const withSubs = (x: Message, subs: string[]): Message => {
  const all = [...new Set([...(x.sub ?? []), ...subs])];
  return all.length > 0 ? { ...x, sub: all } : x;
};

const ANSWER_LINE = new RegExp(ANSWER, "gm");

// The questions a message answers line by line, each line opening with its id: `q3: yes`.
export const answersIn = (book: Book, text: string): string[] =>
  [...text.matchAll(ANSWER_LINE)]
    .map((m) => m[2])
    .filter((id) => book.questions.some((q) => q.id === id));

// A message's answer lines with the picks the user drafted on each question's card joined in, so that
// "q3: my note" goes out as "q3: JSON, SQLite (my note)"; and the questions whose drafts it used.
export const joinPicks = (
  book: Book,
  text: string,
  drafts: Record<string, Draft>,
): { text: string; used: string[] } => {
  const used: string[] = [];
  const lines = text.split("\n").map((line) => {
    const m = new RegExp(ANSWER).exec(line);
    if (m === null) return line;
    const q = questionOf(book, m[2]);
    const d = drafts[m[2]];
    if (q?.status !== "open" || d === undefined || used.includes(q.id))
      return line;
    if (d.picks.length === 0 && d.none !== true) return line;
    const answer = answerOf(q, { ...d, note: m[3].trim() });
    if (answer === undefined) return line;
    used.push(q.id);
    return `${m[1]} ${answer}`;
  });
  return { text: lines.join("\n"), used };
};

export const optionsOf = (q: Question): QuestionOption[] => q.options ?? [];

// A draft's answer as one line's text: the picks, then the note; undefined when it says nothing.
export const answerOf = (q: Question, d: Draft | undefined) => {
  if (d === undefined) return undefined;
  const labels = new Set(optionsOf(q).map((o) => o.label));
  const checked = d.picks.filter((p) => labels.has(p)).join(", ");
  const picks =
    checked || (q.multiSelect && d.none === true ? "none checked" : "");
  const note = d.note.trim().replace(/\s*\n\s*/g, " ");
  const text = picks && note ? `${picks} (${note})` : picks || note;
  return text === "" ? undefined : text;
};

// The message answering a thread's drafted questions: its tag, then a line per answer.
export const answerMessage = (
  book: Book,
  thread: string,
  drafts: Record<string, Draft>,
): { text: string; answered: Sent[] } | undefined => {
  const answered = openQuestions(book, thread).flatMap((q) => {
    const d = drafts[q.id];
    const text = answerOf(q, d);
    if (text === undefined || d === undefined) return [];
    const labels = new Set(optionsOf(q).map((o) => o.label));
    const note = d.note.trim();
    return [
      {
        id: q.id,
        text,
        picks: d.picks.filter((p) => labels.has(p)),
        ...(note === "" ? {} : { note }),
      },
    ];
  });
  if (answered.length === 0) return undefined;
  const lines = answered.map((a) => `${a.id}: ${a.text}`);
  return {
    text:
      lines.length === 1
        ? `[[${thread}]] ${lines[0]}`
        : `[[${thread}]]\n${lines.join("\n")}`,
    answered,
  };
};

// An answer as sent: from the pane with the picks and note it was made of, or typed at the prompt
// with neither.
type Sent = { id: string; text: string; picks?: string[]; note?: string };

export const markSent = (book: Book, answered: Sent[], now: number): Book => ({
  ...book,
  questions: book.questions.map((q) => {
    const a = answered.find((a) => a.id === q.id);
    return a
      ? {
          ...q,
          sent: {
            text: a.text,
            at: now,
            ...(a.picks === undefined ? {} : { picks: a.picks }),
            ...(a.note === undefined ? {} : { note: a.note }),
          },
        }
      : q;
  }),
});

// Puts back what each question's `sent` was before a message that did not enter marked it.
export const restoreSent = (
  book: Book,
  was: Record<string, Question["sent"]>,
): Book => ({
  ...book,
  questions: book.questions.map((q) => {
    if (!(q.id in was)) return q;
    const { sent: _, ...rest } = q;
    const before = was[q.id];
    return before === undefined ? rest : { ...rest, sent: before };
  }),
});

// How an answered question reads back: the options picked, and the words beside them. An answer sent
// from the pane keeps its picks and note; one typed at the prompt shows the options its answer names,
// and the answer as Claude settled it.
export const answerShape = (
  q: Question,
): { picks: string[]; note?: string; answer?: string } => {
  const sent = q.sent;
  if (sent?.picks !== undefined)
    return {
      picks: sent.picks,
      ...(sent.note === undefined ? {} : { note: sent.note }),
    };
  const said = (q.resolution ?? "").toLowerCase();
  return {
    picks: optionsOf(q)
      .map((o) => o.label)
      .filter((l) => said.includes(l.toLowerCase())),
    ...(q.resolution === undefined ? {} : { answer: q.resolution }),
  };
};

export const threadOf = (book: Book, id: string) =>
  book.threads.find((t) => t.id === id);

// A question by its id, and within a thread when one is given.
export const questionOf = (
  book: Book,
  id: string | undefined,
  thread?: string,
): Question | undefined =>
  book.questions.find(
    (q) => q.id === id && (thread === undefined || q.thread === thread),
  );

// Threads as tags, `[[a]] [[b]]`, to name them in a message.
export const tagList = (ids: readonly string[]) =>
  ids.map((id) => `[[${id}]]`).join(" ");

// A line cut to `n` characters at most, an ellipsis marking a cut.
const clipLine = (text: string, n: number) =>
  text.length > n ? `${text.slice(0, n - 1)}…` : text;

// An event's text, as the history shows it: its type's words and its detail.
export const eventText = (e: ThreadEvent): string => {
  const d = e.detail ?? "";
  switch (e.event) {
    case "opened":
      return "Opened.";
    case "reopened":
      return "Reopened.";
    case "reopened-by-ask":
      return "Reopened by a question asked in it.";
    case "renamed":
      return `Renamed to “${d}”.`;
    case "summary":
      return e.detail === undefined
        ? "Summary updated."
        : `Summary updated:\n${d}`;
    case "status":
      return `Status: ${d}`;
    case "closed":
      return `Closed: ${d}`;
    case "asked":
      return `Asked ${e.question}: ${d}`;
    case "revised":
      return `Revised ${e.question}: ${d}`;
    case "answered":
      return `Answered ${e.question}: ${d}`;
    case "retracted":
      return `Retracted ${e.question}: ${d}`;
    case "note":
      return d;
  }
};

// An entry's text: a message's own, or an event's as drawn.
export const entryText = (x: Entry): string =>
  x.kind === "event" ? eventText(x) : x.text;

// Opening, reopening or renaming a thread is bookkeeping, not news: the list shows it, and what Claude
// says there comes as a reply. So are a summary edit, which says what the thread is, and a status
// change, which the list's status column shows already. A close's outcome is news, and so are a
// question's events and a reopening by a question.
const BOOKKEEPING: ReadonlySet<EventType> = new Set<EventType>([
  "opened",
  "reopened",
  "renamed",
  "summary",
  "status",
]);

// Whether the user has seen an entry; a thread's read status is its entries'. Their own messages are never
// news to them. A reply or an event is read once they marked it so: by opening a thread that holds it, or
// a reply by its mark in the main view, unless they marked it unread since. An event also counts read
// once a reply that came at or after it in the thread is read, so marking the replies read in the main
// view covers the events between them.
export const isRead = (book: Book, t: Thread, x: Entry): boolean => {
  if (x.kind === "prompt") return true;
  if (x.read !== undefined) return x.read;
  if (x.kind === "event" && BOOKKEEPING.has(x.event)) return true;
  return x.kind === "event" && x.at <= latestReadReply(book, t.id);
};

// The time of each thread's latest reply the user has read, found once per version of the book: the
// book's values are never changed in place, so a changed book is another object.
const latestRead = new WeakMap<Book, Map<string, number>>();
const latestReadReply = (book: Book, thread: string): number => {
  let byThread = latestRead.get(book);
  if (byThread === undefined) {
    byThread = new Map();
    latestRead.set(book, byThread);
  }
  let at = byThread.get(thread);
  if (at === undefined) {
    at = -Infinity;
    for (const r of historyOf(book, thread))
      if (r.kind === "reply" && r.read === true && r.at > at) at = r.at;
    byThread.set(thread, at);
  }
  return at;
};

// How many of the thread's entries the user has not seen.
export const unread = (book: Book, t: Thread): number =>
  historyOf(book, t.id).filter((x) => !isRead(book, t, x)).length;

// The threads holding sections of each transcript row's reply, by the row's uuid, in the book's order,
// each with whether it has read them all.
export const rowThreadsIndex = (
  book: Book,
): ReadonlyMap<string, { id: string; isRead: boolean }[]> => {
  const index = new Map<string, { id: string; isRead: boolean }[]>();
  for (const t of book.threads) {
    const own = new Map<string, boolean>();
    for (const x of historyOf(book, t.id))
      if (x.kind === "reply" && x.uuid !== undefined)
        own.set(x.uuid, (own.get(x.uuid) ?? true) && isRead(book, t, x));
    for (const [uuid, read] of own)
      index.set(uuid, [...(index.get(uuid) ?? []), { id: t.id, isRead: read }]);
  }
  return index;
};

// The threads holding sections of a transcript row's reply; empty when no thread holds one.
export const rowThreads = (
  book: Book,
  uuid: string,
): { id: string; isRead: boolean }[] => rowThreadsIndex(book).get(uuid) ?? [];

// Messages with a change made to those that `is` picks.
const withMessages = (
  book: Book,
  is: (m: Message) => boolean,
  change: (m: Message) => Message,
): Book =>
  book.messages.some(is)
    ? { ...book, messages: book.messages.map((m) => (is(m) ? change(m) : m)) }
    : book;

// The user marked a thread's sections of a transcript row read or unread, from the main view: those
// sections, which every other thread holding them shares.
export const markRow = (
  book: Book,
  uuid: string,
  thread: string,
  read: boolean,
): Book =>
  withMessages(
    book,
    (m) => m.kind === "reply" && m.uuid === uuid && m.threads.includes(thread),
    (m) => ({ ...m, read }),
  );

// The user opened these threads or subthreads: every entry they hold is read, and so each of those
// messages is wherever another thread holds it too. The other parts of the same row they have not seen.
export const markSeen = (book: Book, ids: string[]): Book => {
  // A subthread's id opens only the entries it holds.
  const scope = targets(book, ids);
  const inView = (thread: string, x: Entry) =>
    scope.some(
      (s) =>
        s.thread === thread && (s.whole || s.subs.some((q) => inSub(x, q))),
    );
  const isSeen = (x: Entry) => x.kind !== "prompt" && x.read !== true;
  const b = withMessages(
    book,
    (m) => isSeen(m) && m.threads.some((t) => inView(t, m)),
    (m) => ({ ...m, read: true }),
  );
  return {
    ...b,
    threads: b.threads.map((t) =>
      t.events.some((x) => isSeen(x) && inView(t.id, x))
        ? {
            ...t,
            events: t.events.map((x) =>
              isSeen(x) && inView(t.id, x) ? { ...x, read: true } : x,
            ),
          }
        : t,
    ),
  };
};

// The open questions that wait on the user: an answer sent from the pane or typed at the prompt leaves
// nothing for them to do until Claude settles it or revises it.
export const waitingOn = (book: Book, thread?: string) =>
  openQuestions(book, thread).filter((q) => q.sent === undefined);

export const openQuestions = (book: Book, thread?: string) =>
  book.questions.filter(
    (q) => q.status === "open" && (thread === undefined || q.thread === thread),
  );

// How many prompts a thread has gone without a tag or a change; none for a thread that is not there.
const idleTurns = (book: Book, t: Thread | undefined) =>
  t === undefined ? 0 : book.turn.n - t.touchedTurn;

// Whether a thread's status names an open question, of any thread, that it waits on.
const namesOpenQuestion = (book: Book, t: Thread) =>
  t.state !== undefined &&
  openQuestions(book).some((q) => new RegExp(`\\b${q.id}\\b`).test(t.state!));

const finishedTurn = (book: Book) => book.finishedTurn ?? -1;

// How many prompts an open thread other than main has gone without a tag or a change, when that makes it
// idle; undefined when it does not. Idleness catches a thread whose work finished elsewhere and that
// nobody closed. A thread that waits on the user (an open question of its own, or one its status names)
// is not such a thread, and one whose status was set while it was idle is named again only after a
// thread closes or a question is settled, which may have finished it.
export const idleFor = (book: Book, t: Thread): number | undefined => {
  const n = idleTurns(book, t);
  if (t.status !== "open" || t.id === MAIN || n < STALE_PROMPTS)
    return undefined;
  if (waitingOn(book, t.id).length > 0 || namesOpenQuestion(book, t))
    return undefined;
  if (t.heldAt !== undefined && finishedTurn(book) <= t.heldAt)
    return undefined;
  return n;
};

// An open question is stale when its thread sat untouched for STALE_PROMPTS prompts after a thread
// closed or a question was settled since its thread was last touched: work moved on, and it may no
// longer matter. A question that only waits, with nothing finished since, is not stale.
export const isStale = (book: Book, q: Question) => {
  const t = threadOf(book, q.thread);
  return (
    q.status === "open" &&
    t !== undefined &&
    idleTurns(book, t) >= STALE_PROMPTS &&
    finishedTurn(book) >= t.touchedTurn
  );
};

// A thread's group in the list: main, then the open threads, then the closed ones.
const rank = (t: Thread) => (t.id === MAIN ? 0 : t.status === "open" ? 1 : 2);

// Main first, then the open threads and the closed ones, each in the order they were opened: activity
// never moves a row, so the list holds still under the person's pointer, and a new thread comes last.
export const ordered = (book: Book): Thread[] =>
  [...book.threads].sort(
    (a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt,
  );

// The threads sorted by a list column, ascending or descending: main first, then open, then closed, and
// within each the column's order, ties in the order they were opened. Age ascends from the newest.
export const sortedBy = (
  book: Book,
  sort?: { by: SortKey; desc: boolean },
): Thread[] => {
  const base = ordered(book);
  if (sort === undefined) return base;
  const key = (t: Thread): string | number =>
    sort.by === "waiting"
      ? waitingOn(book, t.id).length
      : sort.by === "id"
        ? t.id
        : sort.by === "title"
          ? t.title.toLowerCase()
          : sort.by === "status"
            ? stateOf(t).toLowerCase()
            : -t.updatedAt;
  const cmp = (a: Thread, b: Thread) => {
    const x = key(a);
    const y = key(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };
  return [...base].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (sort.desc ? -cmp(a, b) : cmp(a, b)) ||
      a.createdAt - b.createdAt,
  );
};

// A reply's text split at its tag lines: what comes before the first one, and each section after one, with
// the threads its tag line names. The tag lines themselves are dropped.
export const sections = (
  text: string,
): { lead: string; sections: { ids: string[]; text: string }[] } => {
  const lines = text.split("\n");
  const out: { ids: string[]; text: string[] }[] = [];
  const lead: string[] = [];
  for (const line of lines) {
    if (TAG_LINE.test(line)) out.push({ ids: tagsIn(line), text: [] });
    else (out.length > 0 ? out[out.length - 1].text : lead).push(line);
  }
  return {
    lead: lead.join("\n").trim(),
    sections: out.map((s) => ({ ids: s.ids, text: s.text.join("\n").trim() })),
  };
};

const clip = (text: string) =>
  text.length <= MAX_ENTRY
    ? text
    : `${text.slice(0, MAX_ENTRY)}\n\n…(${text.length - MAX_ENTRY} more characters in the transcript)`;

const withThread = (
  book: Book,
  id: string,
  change: (t: Thread) => Thread,
): Book => ({
  ...book,
  threads: book.threads.map((t) => (t.id === id ? change(t) : t)),
});

// A thread changed now, and tagged or changed this turn: whatever held it from being named idle is
// over.
const touched = (book: Book, id: string, now: number): Book =>
  withThread(book, id, ({ heldAt: _, ...t }) => ({
    ...t,
    updatedAt: now,
    touchedTurn: book.turn.n,
  }));

// A message's subthreads set to a list, none when it is empty.
const withSub = (m: Message, sub: string[]): Message => {
  const { sub: _, ...rest } = m;
  return sub.length > 0 ? { ...rest, sub } : rest;
};

// Keeps each of these threads' histories to MAX_ENTRIES, or MAX_CLOSED_ENTRIES once closed, so a long
// session's state stays small: past that a thread lets go of its oldest messages and events, a message
// no thread holds any more goes, and so does a settled question no history shows any more.
const trimmed = (book: Book, ids: string[]): Book => {
  let b = book;
  let isCut = false;
  for (const id of new Set(ids)) {
    const t = threadOf(b, id);
    const limit = t?.status === "closed" ? MAX_CLOSED_ENTRIES : MAX_ENTRIES;
    const h = historyOf(b, id);
    if (h.length <= limit) continue;
    isCut = true;
    const keep = h[h.length - limit].id;
    const left = (m: Message) => m.id < keep && m.threads.includes(id);
    b = withThread(
      withMessages(b, left, (m) => ({
        ...withSub(
          m,
          (m.sub ?? []).filter((q) => questionOf(b, q)?.thread !== id),
        ),
        threads: m.threads.filter((t) => t !== id),
      })),
      id,
      (t) => ({ ...t, events: t.events.filter((e) => e.id >= keep) }),
    );
    b = { ...b, messages: b.messages.filter((m) => m.threads.length > 0) };
  }
  return isCut ? pruned(b) : b;
};

// The book without the settled questions that no event of its thread's history names any more: a
// settled question is drawn only from its events, as its card where it was answered or retracted. An
// open question stays whatever its history holds; ids are never reused, as `nextQuestion` only grows.
const pruned = (book: Book): Book => {
  const shown = new Set(
    book.threads.flatMap((t) =>
      t.events.flatMap((e) => (e.question === undefined ? [] : [e.question])),
    ),
  );
  const gone = new Set(
    book.questions
      .filter((q) => q.status !== "open" && !shown.has(q.id))
      .map((q) => q.id),
  );
  if (gone.size === 0) return book;
  return withMessages(
    { ...book, questions: book.questions.filter((q) => !gone.has(q.id)) },
    (m) => m.sub?.some((q) => gone.has(q)) === true,
    (m) =>
      withSub(
        m,
        (m.sub ?? []).filter((q) => !gone.has(q)),
      ),
  );
};

// A book kept to its bounds, as `trimmed` keeps each change: a stored book that is past them is
// bounded once when it is read.
const bounded = (book: Book): Book =>
  pruned(
    trimmed(
      book,
      book.threads.map((t) => t.id),
    ),
  );

// An event of a thread as it happens now, its detail kept to MAX_ENTRY.
type NewEvent = Omit<ThreadEvent, "id" | "kind" | "at">;

// Adds events to a thread's history, in order.
const addEvents = (
  book: Book,
  thread: string,
  events: NewEvent[],
  now: number,
): Book => {
  if (events.length === 0) return book;
  const made: ThreadEvent[] = events.map((e, i) => ({
    kind: "event",
    ...e,
    ...(e.detail === undefined ? {} : { detail: clip(e.detail) }),
    at: now,
    id: book.nextEntry + i,
  }));
  return trimmed(
    {
      ...withThread(book, thread, (t) => ({
        ...t,
        events: [...t.events, ...made],
      })),
      nextEntry: book.nextEntry + made.length,
    },
    [thread],
  );
};

// Makes sure each thread exists and is open: a tag naming an unknown thread opens it untitled, and one
// naming a closed thread files under it and leaves it closed (a closing note is tagged with its thread),
// unless `reopen` says the change needs the thread open, as a new question does.
const ensure = (
  book: Book,
  ids: string[],
  now: number,
  reopen = false,
): Book => {
  let b = book;
  for (const { thread: id } of targets(book, ids)) {
    const t = threadOf(b, id);
    if (t === undefined) {
      b = {
        ...b,
        threads: [
          ...b.threads,
          {
            id,
            title: id,
            summary: "",
            status: "open",
            createdAt: now,
            updatedAt: now,
            touchedTurn: b.turn.n,
            isUntitled: true,
            events: [],
          },
        ],
      };
    } else if (t.status === "closed" && reopen) {
      b = withThread(b, id, (t) => ({
        ...t,
        status: "open",
        outcome: undefined,
        updatedAt: now,
      }));
      b = addEvents(b, id, [{ event: "reopened-by-ask" }], now);
    }
  }
  return b;
};

// A new message, before the book gives it an id and threads.
type NewMessage = Omit<Message, "id" | "threads" | "home" | "sub">;

// Files a new message under threads, which it was sent or written under, noting each thread the turn
// touched. An id that names a question files under its thread, in its subthread.
const file = (
  book: Book,
  ids: string[],
  entry: NewMessage,
  now: number,
): Book => {
  const to = targets(book, ids);
  if (to.length === 0) return book;
  const threads = to.map((x) => x.thread);
  let b = ensure(book, threads, now);
  const m = withSubs(
    {
      ...entry,
      text: clip(entry.text),
      id: b.nextEntry,
      threads,
      home: threads,
    },
    to.flatMap((x) => x.subs),
  );
  b = { ...b, messages: [...b.messages, m], nextEntry: b.nextEntry + 1 };
  for (const id of threads) {
    b = touched(b, id, now);
    if (!b.turn.touched.includes(id))
      b = { ...b, turn: { ...b.turn, touched: [...b.turn.touched, id] } };
  }
  return trimmed(b, threads);
};

// A user prompt in the main conversation starts a turn. A prompt that opens with tags is filed
// under its threads at once; an untagged one is filed under main alone, and Claude may file it under
// threads as well. Claude's replies go where its own tag lines say: the prompt's tags set none of them.
// A turn starts with a prompt row: the person's text, or undefined for a row that is not their
// words (a background task's notification, another session's message), which no thread files.
export const startTurn = (
  book: Book,
  text: string | undefined,
  uuid: string | undefined,
  now: number,
): Book => {
  const said = text?.trim();
  const refs = text === undefined ? undefined : promptRefs(book, text);
  const tagged = refs?.threads ?? [];
  // The subthreads it is filed in: those its tags name, and those of the questions it answers.
  const subs = refs === undefined ? [] : [...refs.subs, ...refs.questions];
  const piece = said === undefined ? undefined : { text: said, uuid, at: now };
  // A message typed while the last turn ran that came too late to join it starts this turn instead.
  // One typed before that never joined, and never will: it is let go.
  const typed = (book.turn.typed ?? []).filter(
    (t) => t.turn === book.turn.n && t.text !== said,
  );
  let b: Book = {
    ...book,
    turn: {
      n: book.turn.n + 1,
      active: [],
      touched: [],
      untagged: [],
      prompt: piece,
      typed: typed.length > 0 ? typed : undefined,
    },
  };
  if (piece !== undefined && piece.text !== "") {
    const id = b.nextEntry;
    b = file(
      b,
      tagged.length > 0 ? [...tagged, ...subs] : [MAIN],
      { kind: "prompt", ...piece },
      now,
    );
    b = { ...b, turn: { ...b.turn, loose: [id] } };
  }
  // A message that answers a question by its id leaves it waiting on Claude, not the user. One sent
  // from the pane is marked already, with its picks; one typed has none, so it reads back as settled.
  if (refs !== undefined && said !== undefined) {
    const words = said.replace(/\s+/g, " ");
    const reply = clipLine(words, 200);
    b = markSent(
      b,
      refs.questions
        .filter((id) => questionOf(b, id)?.sent === undefined)
        .map((id) => ({ id, text: reply })),
      now,
    );
  }
  return b;
};

// A message the user typed while a turn runs, as `prompt.submit` sees it, kept until its row joins.
export const noteTyped = (book: Book, text: string): Book =>
  text.trim() === ""
    ? book
    : {
        ...book,
        turn: {
          ...book.turn,
          typed: [
            ...(book.turn.typed ?? []),
            { text: text.trim(), turn: book.turn.n },
          ],
        },
      };

// The row of a message that joined the running turn: the engine's rendering of it, which holds the typed
// text. It is filed as a prompt under the threads it opens with, or the turn's own; with neither, it waits
// for the turn's next section. A rendering that holds no noted text is left alone.
export const joinTurn = (
  book: Book,
  rendered: string,
  uuid: string | undefined,
  now: number,
): Book => {
  const typed = book.turn.typed ?? [];
  const at = typed.findIndex((t) => rendered.includes(t.text));
  if (at === -1) return book;
  const { text } = typed[at];
  const left = typed.filter((_, i) => i !== at);
  let b: Book = {
    ...book,
    turn: { ...book.turn, typed: left.length > 0 ? left : undefined },
  };
  const named = promptRefs(b, text);
  const refs = named.threads;
  const to = refs.length > 0 ? refs : [MAIN];
  const id = b.nextEntry;
  b = file(
    b,
    [...to, ...named.subs, ...named.questions],
    { kind: "prompt", text, uuid, at: now },
    now,
  );
  return { ...b, turn: { ...b.turn, loose: [...(b.turn.loose ?? []), id] } };
};

// One block of a reply in the main conversation. Text before its first tag line continues the threads
// of Claude's last tag line this turn; with none yet, it is the turn's untagged text, which the stop
// check asks to have filed. A user's tagged prompt does not count: the topic may have moved.
export const recordReply = (
  book: Book,
  text: string,
  uuid: string | undefined,
  now: number,
): Book => {
  const { lead, sections: parts } = sections(text);
  let b = book;
  if (lead !== "") {
    if (b.turn.active.length > 0)
      b = file(
        b,
        b.turn.active,
        { kind: "reply", text: lead, uuid, at: now },
        now,
      );
    else
      b = {
        ...b,
        turn: {
          ...b.turn,
          untagged: [...b.turn.untagged, { text: lead, uuid, at: now }],
        },
      };
  }
  for (const part of parts) {
    if (part.text !== "")
      b = file(
        b,
        part.ids,
        { kind: "reply", text: part.text, uuid, at: now },
        now,
      );
    else b = ensure(b, part.ids, now);
    b = { ...b, turn: { ...b.turn, active: part.ids } };
  }
  return b;
};

// The refusal of a call that names no thread, or a thread by a malformed id; undefined when it is fine.
const idsRefusal = (book: Book, ids: string[]): Outcome | undefined =>
  ids.length === 0 || ids.some((id) => !isId(id))
    ? {
        book,
        isError: true,
        message:
          "Give one or more thread ids: lowercase letters, digits and hyphens.",
      }
    : undefined;

// The message of an id, as the book holds it now.
const messageOf = (book: Book, id: number) =>
  book.messages.find((m) => m.id === id);

// Files a message the book holds already under more threads and subthreads, in its place in their
// histories: a thread that holds it takes it into the subthreads named, and one that does not takes it
// too, where it shows as from the threads it was sent or written under. Says where it went, by the
// names given.
const fileAgain = (
  book: Book,
  ids: string[],
  id: number,
  now: number,
): { book: Book; to: string[] } => {
  let b = book;
  const to: string[] = [];
  const is = (m: Message) => m.id === id;
  for (const { thread, subs, whole } of targets(book, ids)) {
    const m = messageOf(b, id);
    if (m === undefined) break;
    const isHeld = m.threads.includes(thread);
    if (isHeld || m.home.includes(thread)) {
      const missing = subs.filter((q) => m.sub?.includes(q) !== true);
      if (!isHeld || missing.length === 0) continue;
      b = withMessages(b, is, (x) => withSubs(x, missing));
      b = touched(b, thread, now);
      to.push(...missing);
      continue;
    }
    b = ensure(b, [thread], now);
    b = withMessages(b, is, (x) =>
      withSubs({ ...x, threads: [...x.threads, thread] }, subs),
    );
    b = trimmed(touched(b, thread, now), [thread]);
    to.push(...(whole ? [thread] : []), ...subs);
  }
  return { book: b, to };
};

// Files the user's untagged messages of this turn, which went under main, under threads as well,
// marked as the main session's.
const filePrompts = (book: Book, ids: string[], now: number): Outcome => {
  const loose = (book.turn.loose ?? []).flatMap((id) => {
    const m = messageOf(book, id);
    return m === undefined ? [] : [m];
  });
  if (loose.length === 0)
    return { book, message: "This turn has no message of the user's to file." };
  // Messages sent while the turn runs join it: which of them a thread is about is the model's to say.
  if (loose.length > 1)
    return {
      book,
      message: "Filed nothing yet.",
      note: `[threads] mcp__threads__file filed nothing: this turn holds ${loose.length} messages of the user's: ${loose
        .map((p) => `"${clipLine(p.text.replace(/\s+/g, " "), 60)}"`)
        .join(
          ", ",
        )}. File each one the thread is about with quote: words from it (prompts: true with quote, to file only the user's).`,
    };
  let b = book;
  let filed = 0;
  for (const m of loose) {
    // Each thread takes a message once: not where it was sent, nor where it was filed before.
    const out = fileAgain(b, ids, m.id, now);
    b = out.book;
    if (out.to.length > 0) filed += 1;
  }
  return {
    book: b,
    message:
      filed === 0
        ? "Those threads hold this turn's messages already."
        : `Filed ${filed} of the user's messages under ${tagList(ids)} too.`,
  };
};

const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

// The one message of the user's, or section of Claude's reply, whose text holds the quoted words; or the
// refusal saying why there is not one.
const findQuoted = (
  book: Book,
  quote: string,
  prompts: boolean,
): { entry: Message } | { refusal: string } => {
  const words = squash(quote);
  if (words === "") return { refusal: "Give some words from the message." };
  const matches = book.messages.filter(
    (m) => (!prompts || m.kind === "prompt") && squash(m.text).includes(words),
  );
  if (matches.length === 0)
    return {
      refusal: `No ${prompts ? "message of the user's" : "message or reply section"} in any thread holds "${quote}". Quote its words exactly as they were written.`,
    };
  if (matches.length > 1)
    return {
      refusal: `${matches.length} messages hold "${quote}". Quote more of the one you mean:\n${matches
        .slice(0, 5)
        .map((x) => {
          const w = x.text.replace(/\s+/g, " ");
          return `- ${x.kind === "prompt" ? "the user's" : "yours"} in ${tagList(x.home)}: ${clipLine(w, 80)}`;
        })
        .join("\n")}`,
    };
  return { entry: matches[0] };
};

const whoOf = (x: Message) =>
  x.kind === "prompt" ? "the user's message" : "that section of your reply";

// Files an earlier message of the user's, or a section of Claude's reply, under more threads: the one
// whose text holds the quoted words. It goes where its time puts it in each thread's history, shown as
// from the threads it was sent or written under, and keeps its read state.
const fileEarlier = (
  book: Book,
  ids: string[],
  quote: string,
  now: number,
  prompts: boolean,
): Outcome => {
  const hit = findQuoted(book, quote, prompts);
  if ("refusal" in hit) return { book, isError: true, message: hit.refusal };
  const { entry } = hit;
  const out = fileAgain(book, ids, entry.id, now);
  if (out.to.length === 0)
    return { book, message: `Those threads hold ${whoOf(entry)} already.` };
  return {
    book: out.book,
    message: `Filed ${whoOf(entry)} under ${tagList(out.to)} too.`,
  };
};

// Takes a message or reply section filed under threads by mistake out of them: the one whose text holds
// the quoted words. It stays where it was sent or written; a question's id takes it out of that subthread.
export const unfile = (
  book: Book,
  ids: string[],
  quote: string,
  now: number,
  prompts = false,
): Outcome => {
  const refused = idsRefusal(book, ids);
  if (refused !== undefined) return refused;
  const hit = findQuoted(book, quote, prompts);
  if ("refusal" in hit) return { book, isError: true, message: hit.refusal };
  const { entry } = hit;
  const kept: string[] = [];
  const out: string[] = [];
  let b = book;
  for (const { thread, subs, whole } of targets(book, ids)) {
    const m = messageOf(b, entry.id);
    if (m === undefined || !m.threads.includes(thread)) continue;
    if (whole && m.home.includes(thread)) kept.push(thread);
    const dropWhole = whole && !m.home.includes(thread);
    // Taken out of a thread, it leaves the thread's subthreads too.
    const leaves = (q: string) =>
      dropWhole ? questionOf(b, q)?.thread === thread : subs.includes(q);
    b = withMessages(
      b,
      (x) => x.id === m.id,
      (x) => ({
        ...withSub(
          x,
          (x.sub ?? []).filter((q) => !leaves(q)),
        ),
        threads: dropWhole ? x.threads.filter((t) => t !== thread) : x.threads,
      }),
    );
    b = withThread(b, thread, (t) => ({ ...t, updatedAt: now }));
    if (dropWhole) out.push(thread);
    out.push(...subs.filter((q) => m.sub?.includes(q)));
  }
  b = { ...b, messages: b.messages.filter((m) => m.threads.length > 0) };
  const parts = [
    out.length > 0 && `Took ${whoOf(entry)} out of ${tagList(out)}.`,
    kept.length > 0 &&
      `It stays in ${tagList(kept)}, where it was ${entry.kind === "prompt" ? "sent" : "written"}.`,
  ].filter((x): x is string => typeof x === "string");
  return {
    book: b,
    message:
      parts.length > 0
        ? parts.join(" ")
        : `Those threads do not hold ${whoOf(entry)}.`,
  };
};

export const fileUntagged = (
  book: Book,
  ids: string[],
  now: number,
  prompts = false,
  quote?: string,
): Outcome => {
  const refused = idsRefusal(book, ids);
  if (refused !== undefined) return refused;
  if (quote !== undefined && !prompts) {
    const hit = findUntagged(book, quote);
    if ("refusal" in hit) return { book, isError: true, message: hit.refusal };
    if (hit.piece !== undefined) return fileBlocks(book, ids, [hit.piece], now);
  }
  if (quote !== undefined) return fileEarlier(book, ids, quote, now, prompts);
  if (prompts) return filePrompts(book, ids, now);
  if (book.turn.untagged.length === 0)
    return { book, message: "This turn has no untagged text to file." };
  return fileBlocks(book, ids, book.turn.untagged, now);
};

// The one block of this turn's untagged text that holds the quoted words, the refusal when several do,
// or neither when none does, for the quote to look among filed messages instead.
const findUntagged = (
  book: Book,
  quote: string,
): { piece?: Piece } | { refusal: string } => {
  const words = squash(quote);
  if (words === "") return {};
  const matches = book.turn.untagged.filter((p) =>
    squash(p.text).includes(words),
  );
  if (matches.length > 1)
    return {
      refusal: `${matches.length} blocks of this turn's untagged text hold "${quote}". Quote more of the one you mean:\n${matches
        .slice(0, 5)
        .map((p) => `- ${clipLine(p.text.replace(/\s+/g, " "), 80)}`)
        .join("\n")}`,
    };
  return { piece: matches[0] };
};

// Files blocks of this turn's untagged text under threads as one reply section, and takes them out of
// the untagged text. Once none is left, the turn's later replies go under these threads too.
const fileBlocks = (
  book: Book,
  ids: string[],
  pieces: Piece[],
  now: number,
): Outcome => {
  let b = file(
    book,
    ids,
    {
      kind: "reply",
      text: pieces.map((p) => p.text).join("\n\n"),
      uuid: pieces.find((p) => p.uuid)?.uuid,
      at: pieces.length === 1 ? pieces[0].at : now,
    },
    now,
  );
  const untagged = book.turn.untagged.filter((p) => !pieces.includes(p));
  b = {
    ...b,
    turn: {
      ...b.turn,
      untagged,
      ...(untagged.length === 0 ? { active: ids } : {}),
    },
  };
  const left =
    untagged.length === 0
      ? ""
      : ` ${untagged.length} more ${untagged.length === 1 ? "block is" : "blocks are"} still untagged.`;
  return { book: b, message: `Filed under ${tagList(ids)}.${left}` };
};

export type ThreadArgs = {
  id: string;
  title?: string;
  summary?: string;
  state?: string;
  close?: string;
  reopen?: boolean;
};

// A thread's status as drawn: main has none, even a stored one.
export const stateOf = (t: Thread): string =>
  t.id === MAIN ? "" : (t.state ?? "");

// The leading verb of each thread's status, "" for a thread with none.
export const verbsOf = (book: Book): string[] =>
  book.threads.map((t) => statusParts(stateOf(t)).verb);

// -ing words that are not verbs, so a status cannot start with them.
const ING_NOUNS = new Set([
  "nothing",
  "something",
  "anything",
  "everything",
  "pending",
  "morning",
  "string",
  "thing",
]);

// Why a status does not start with what is happening on the thread now, or undefined when it does.
export const statusProblem = (state: string): string | undefined => {
  const verb = statusParts(state.trim()).verb;
  if (
    state.trim() === "" ||
    (/ing$/i.test(verb) && !ING_NOUNS.has(verb.toLowerCase()))
  )
    return undefined;
  return `A status says what is happening on the thread now, starting with a present-tense verb as if after an implied "I am" ("Testing the fix.", "Waiting on the build."), never what is done: the history keeps that. "${state.trim()}" starts with "${verb || state.trim().split(/\s/)[0]}". Give it again in that form.`;
};

export const changeThread = (
  book: Book,
  args: ThreadArgs,
  now: number,
): Outcome => {
  const { id } = args;
  const fail = (message: string): Outcome => ({ book, isError: true, message });
  if (!isId(id))
    return fail(
      "A thread id is lowercase letters, digits and hyphens, at most 48.",
    );
  if (args.close !== undefined && args.reopen)
    return fail("Give close or reopen, not both.");
  const existing = threadOf(book, id);
  if (existing === undefined && /^q\d+$/.test(id))
    return fail(
      `${id} is how questions are named, and a question's id names its subthread: give the thread another id.`,
    );
  if (existing === undefined && !args.title?.trim())
    return fail(`No thread [[${id}]] yet: give a title to open it.`);
  if (id === MAIN && args.state !== undefined)
    return fail(
      "[[main]] takes no status: it is the session as a whole, and its summary says where the session stands. Give a status to the thread whose work it is.",
    );
  const problem =
    args.state === undefined ? undefined : statusProblem(args.state);
  if (problem !== undefined) return fail(problem);
  if (args.close !== undefined && id === MAIN)
    return fail("[[main]] is the session itself and stays open.");
  if (args.close !== undefined && !args.close.trim())
    return fail("Give the outcome the thread closes with.");
  let b = existing === undefined ? ensure(book, [id], now) : book;
  const events: NewEvent[] = [];
  b = withThread(b, id, (t) => {
    let next: Thread = { ...t, updatedAt: now, touchedTurn: b.turn.n };
    if (args.title?.trim()) {
      if (existing !== undefined && t.title !== args.title.trim())
        events.push({ event: "renamed", detail: args.title.trim() });
      next = { ...next, title: args.title.trim(), isUntitled: undefined };
    }
    // Each edit of the summary or the status shows in the history, so the thread's age follows it.
    if (args.summary !== undefined) {
      if (existing !== undefined && t.summary !== args.summary.trim())
        events.push({ event: "summary", detail: args.summary.trim() });
      next = { ...next, summary: args.summary.trim() };
    }
    if (args.state !== undefined) {
      const state = args.state.trim();
      if (existing !== undefined && (t.state ?? "") !== state)
        events.push({ event: "status", detail: state });
      next = { ...next, state: state === "" ? undefined : state };
      // A status set for an idle thread answers the reminder until something finishes.
      if (existing !== undefined && idleFor(book, existing) !== undefined)
        next = { ...next, heldAt: finishedTurn(book) };
    }
    if (args.reopen && t.status === "closed") {
      const { heldAt: _, ...reopened } = next;
      next = { ...reopened, status: "open", outcome: undefined };
      events.push({ event: "reopened" });
    }
    if (args.close !== undefined) {
      next = { ...next, status: "closed", outcome: args.close.trim() };
      events.push({ event: "closed", detail: args.close.trim() });
    }
    if (existing === undefined) events.unshift({ event: "opened" });
    return next;
  });
  b = addEvents(b, id, events, now);
  if (args.close !== undefined) b = { ...b, finishedTurn: b.turn.n };
  let message =
    existing === undefined
      ? `Opened [[${id}]].`
      : args.close !== undefined
        ? `Closed [[${id}]].`
        : `Updated [[${id}]].`;
  // A new thread holds the messages that led to it, as well as what comes next.
  if (
    args.close === undefined &&
    (existing === undefined || existing.isUntitled)
  )
    message += ` If messages of the user's led to it, file them under it: mcp__threads__file with prompts: true when this turn holds one message of the user's, or with quote for each one it is about.`;
  if (args.close !== undefined) {
    const left = openQuestions(b, id);
    if (left.length > 0)
      message += ` It still has open questions (${left.map((q) => q.id).join(", ")}): settle them.`;
  }
  // A status change may bring a verb into use or end one's use: the verbs' color slots follow.
  b = {
    ...b,
    verbSlots: claimSlots(b.verbSlots, verbsOf(b)),
  };
  return { book: b, message };
};

export type AskArgs = {
  thread: string;
  question: string;
  context?: string;
  // Each a label, or an object with a label; anything else is dropped.
  options?: unknown[];
  // `checklist` lets the user pick any of the options; `choice`, the default, one.
  kind?: string;
  // The id of an open question this one replaces in place, as clarified.
  revise?: string;
};

const optionArg = (o: unknown): QuestionOption | undefined => {
  if (typeof o === "string")
    return o.trim() === "" ? undefined : { label: o.trim() };
  if (o === null || typeof o !== "object") return undefined;
  const { label, description, preview, recommended } = o as Record<
    string,
    unknown
  >;
  if (typeof label !== "string" || label.trim() === "") return undefined;
  return {
    label: label.trim(),
    description:
      typeof description === "string" && description.trim() !== ""
        ? description.trim()
        : undefined,
    preview:
      typeof preview === "string" && preview.trim() !== ""
        ? preview
        : undefined,
    ...(recommended === true ? { recommended: true as const } : {}),
  };
};

export const ask = (book: Book, args: AskArgs, now: number): Outcome => {
  const fail = (message: string): Outcome => ({ book, isError: true, message });
  if (!isId(args.thread))
    return fail("Give the id of the thread the question belongs to.");
  if (!args.question?.trim()) return fail("Give the question.");
  const t = threadOf(book, args.thread);
  if (t === undefined)
    return fail(
      `No thread [[${args.thread}]]: open it with mcp__threads__thread first, or ask under an open one.`,
    );
  if (
    args.kind !== undefined &&
    args.kind !== "choice" &&
    args.kind !== "checklist"
  )
    return fail("kind is choice (pick one) or checklist (pick any).");
  const old = questionOf(book, args.revise);
  if (args.revise !== undefined) {
    if (old === undefined) return fail(`No question ${args.revise}.`);
    if (old.status !== "open")
      return fail(
        `${old.id} is already ${old.status}: ask a new question instead.`,
      );
    if (old.thread !== args.thread)
      return fail(`${old.id} is in [[${old.thread}]], not [[${args.thread}]].`);
  }
  const id = old?.id ?? `q${book.nextQuestion}`;
  const options = (args.options ?? [])
    .map(optionArg)
    .filter((o): o is QuestionOption => o !== undefined)
    .filter((o, i, all) => all.findIndex((x) => x.label === o.label) === i);
  const isChecklist = args.kind === "checklist" && options.length > 0;
  const recommended = options.filter((o) => o.recommended).length;
  if (!isChecklist && recommended > 1)
    return fail(
      "A choice takes one recommended option at most: mark only the one you recommend.",
    );
  const q: Question = {
    id,
    thread: args.thread,
    text: args.question.trim(),
    context: args.context?.trim() || undefined,
    options: options.length > 0 ? options : undefined,
    multiSelect: isChecklist ? true : undefined,
    status: "open",
    askedAt: old?.askedAt ?? now,
    ...(old === undefined ? {} : { revision: (old.revision ?? 0) + 1 }),
  };
  let b: Book =
    old === undefined
      ? {
          ...book,
          questions: [...book.questions, q],
          nextQuestion: book.nextQuestion + 1,
        }
      : {
          ...book,
          questions: book.questions.map((x) => (x.id === id ? q : x)),
        };
  b = ensure(b, [args.thread], now, true);
  const event = old === undefined ? "asked" : "revised";
  // A choice with no recommendation leaves the user to weigh it alone: say so, so the next ask names one.
  const nudge =
    !isChecklist && options.length > 0 && recommended === 0
      ? ` No option is marked recommended: unless you truly have no view, revise ${id} with recommended: true on the one you recommend.`
      : "";
  b = addEvents(
    touched(b, args.thread, now),
    args.thread,
    [{ event, detail: q.text, question: id }],
    now,
  );
  return {
    book: b,
    message:
      old === undefined
        ? `Asked ${id} in [[${args.thread}]]. Write the question in your reply too, under that thread's tag and its own, as the tag line \`[[${args.thread}]] [[${id}]]\`, citing ${id}. Tag what you say about it later with [[${id}]] too, so its subthread holds it.${nudge}`
        : `Revised ${id} in [[${args.thread}]] (revision ${q.revision}); it waits on the user again. Say in your reply, under that thread's tag, what changed.${nudge}`,
  };
};

export type SettleArgs = {
  question: string;
  answer?: string;
  retract?: string;
};

export const settle = (book: Book, args: SettleArgs, now: number): Outcome => {
  const fail = (message: string): Outcome => ({ book, isError: true, message });
  const q = questionOf(book, args.question);
  if (q === undefined) return fail(`No question ${args.question}.`);
  const answer = args.answer?.trim();
  const retract = args.retract?.trim();
  if (!answer === !retract)
    return fail("Give either answer or retract, with its text.");
  const status = answer ? "answered" : "retracted";
  const resolution = (answer ?? retract) as string;
  if (q.status === status)
    return { book, message: `${q.id} was already ${q.status}.` };
  // Settled the other way before: the settle was a mistake, so its event reads as the new one.
  if (q.status !== "open")
    return {
      book: withThread(
        {
          ...book,
          questions: book.questions.map((x) =>
            x.id === q.id ? { ...x, status, resolution } : x,
          ),
        },
        q.thread,
        (t) => ({
          ...t,
          updatedAt: now,
          events: t.events.map((e) =>
            e.question === q.id &&
            (e.event === "answered" || e.event === "retracted")
              ? { ...e, event: status, detail: resolution }
              : e,
          ),
        }),
      ),
      message: `${q.id} was ${q.status}; now ${status}.`,
    };
  let b: Book = {
    ...book,
    questions: book.questions.map((x) =>
      x.id === q.id ? { ...x, status, resolution, settledAt: now } : x,
    ),
    finishedTurn: book.turn.n,
  };
  b = addEvents(
    touched(b, q.thread, now),
    q.thread,
    [
      {
        event: status,
        detail: resolution,
        question: q.id,
        // Settling what the user sent records their own act, which is no news to them.
        ...(answer && q.sent !== undefined ? { read: true } : {}),
      },
    ],
    now,
  );
  // A status still naming the question says the thread waits on what is now done.
  const state = threadOf(b, q.thread)?.state;
  const stale =
    state !== undefined && new RegExp(`\\b${q.id}\\b`).test(state)
      ? ` [[${q.thread}]]'s status still reads "${state}": update it now with mcp__threads__thread status, to what is happening on it now.`
      : "";
  return { book: b, message: `${q.id} ${status}.${stale}` };
};

// What the model reads beside each of the user's prompts: the open threads and the questions waiting on
// the user, so it settles what the prompt answers and drops what went stale.
export const promptContext = (
  book: Book,
  prompt: string,
  isPersons = true,
  // The questions whose answers the pane sent and the session has not seen yet: a queued message
  // arrives after the context of whatever prompt goes before it, so a hint must not tell its answer
  // first.
  pending: readonly string[] = [],
): string => {
  const open = ordered(book).filter((t) => t.status === "open");
  const lines = [
    `[threads] Open threads: ${open.map((t) => `[[${t.id}]] ${t.title}`).join("; ")}.`,
  ];
  const idle = open.flatMap((t) => {
    const n = idleFor(book, t);
    return n === undefined ? [] : [`[[${t.id}]] (${n} prompts)`];
  });
  if (idle.length > 0)
    lines.push(
      `Idle threads: ${idle.join(", ")}. If the work of one is done, here or under another thread, close it with its outcome. If its status no longer says what is happening on it, update the status. One whose status is still accurate needs nothing. Never write a message in a thread only to say that nothing changed.`,
    );
  const waiting = openQuestions(book);
  const refs = promptRefs(book, prompt);
  if (waiting.length > 0) {
    lines.push("Questions waiting on the user:");
    for (const q of waiting)
      lines.push(
        `- ${q.id} in [[${q.thread}]]: ${q.text}${
          // The prompt that carries the reply delivers it: its context need not repeat it, and a queued
          // prompt's context reaches the model before the prompt does.
          q.sent !== undefined &&
          !refs.questions.includes(q.id) &&
          !pending.includes(q.id)
            ? ` (the user replied: "${q.sent.text}"; settle it with that answer, which may be one they proposed rather than one of its options; if they asked about it instead, or proposed something you need to work out with them first, answer them and revise it with mcp__threads__ask revise: ${q.id}, so that it says what you clarified, with their proposal among its options, and waits on them again)`
            : ""
        }${
          isStale(book, q)
            ? ` (stale: its thread has been idle for ${idleTurns(book, threadOf(book, q.thread))} prompts since other work finished; retract it if it no longer matters, and otherwise leave it as it is)`
            : ""
        }`,
      );
  }
  // The message is named by its opening words: Claude Code can send several prompts as one user
  // message (one an interrupt cut off, then the next), with only the last one's context.
  const named = `The message that begins "${clipLine(prompt.trim().replace(/\s+/g, " "), 40).replace(/ …$/, "…")}"`;
  if (isPersons)
    lines.push(
      `${
        refs.threads.length > 0
          ? `The user filed ${named.replace(/^The/, "the")} under ${tagList(refs.threads)}.`
          : `${named} has no tag, so it is filed under [[main]] alone.`
      } If it is about other threads too, file it there as well (mcp__threads__file with prompts: true; with quote and words from it, when the turn holds other messages of the user's or for an earlier one).`,
    );
  if (refs.questions.length > 0)
    lines.push(
      `${named} answers ${refs.questions.join(", ")}, each on its line: settle each with that answer, unless the answer asks for more. An answer may be one the user proposed rather than one of the options. Where it asks about the question instead, or proposes something you need to work out with them first, answer it, then revise the question with mcp__threads__ask revise: ${refs.questions.join(" or ")}, so that it says what you clarified, with their proposal among its options, and waits on the user again.`,
    );
  lines.push(
    "Before you go on, settle (mcp__threads__settle) each question this message answers or makes moot, and close (mcp__threads__thread) each thread that is done; when there is none, go on.",
  );
  return lines.join("\n");
};

// Whether a status says its thread waits on the user ("Waiting on the user's look", "Awaiting your
// call", "Needs your review"): only open questions show as waiting on the user, marked beside the
// status, so such a thread needs one. The user must be what it waits on, not a word further on
// ("Waiting on the build, then reporting to you"); waiting on anything else is a status like any.
export const waitsOnUser = (state: string) =>
  /\b(?:(?:wait\w*|blocked)\s+(?:on|for)|await\w*|needs?)\s+(?:the user\b|you\b|your\b)/i.test(
    state,
  );

// The open threads whose status says they wait on the user and that ask nothing.
const unaskedWaits = (book: Book): Thread[] =>
  book.threads.filter(
    (t) =>
      t.status === "open" &&
      waitsOnUser(stateOf(t)) &&
      openQuestions(book, t.id).length === 0,
  );

const UNASKED =
  "Only open questions show as waiting on the user, marked beside the status: ask what you wait on with mcp__threads__ask (a checklist of to-dos for a check or a look, a choice for a decision), or, if nothing waits on them, change the status to what does.";

// What the end of a turn still needs: untagged text to file, threads a tag opened without a title,
// replies of the user's to questions that Claude neither settled nor revised, and threads whose status
// says they wait on the user with no open question. A question in `pending` has its answer still in
// the pane's outbox, which has not reached Claude yet, so it waits. Undefined when nothing is missing.
export const stopProblems = (
  book: Book,
  pending: readonly string[] = [],
): string | undefined => {
  const problems: string[] = [];
  if (book.turn.untagged.length > 0) {
    const quoted = book.turn.untagged.map((p) => {
      const line = p.text.split("\n")[0];
      return `- “${clipLine(line, 80)}”`;
    });
    problems.push(
      `Your reply text this turn has ${quoted.length === 1 ? "this block" : "these blocks"} before any [[thread]] tag line, so no thread holds ${quoted.length === 1 ? "it" : "them"}:\n${quoted.join("\n")}\nOnly tag lines in reply text count: a tag in your thinking, or a section you planned but did not write, files nothing. Call mcp__threads__file with the threads this text was about and no quote to file it all there${quoted.length === 1 ? "" : ", or, to file a block alone, with quote: its opening words"}. If a section you meant to write is not among the quoted text, write it now under its tag. From now on, start every reply with a tag line.`,
    );
  }
  const untitled = book.threads.filter(
    (t) => t.isUntitled && t.status === "open",
  );
  if (untitled.length > 0)
    problems.push(
      `A tag opened ${untitled.map((t) => `[[${t.id}]]`).join(", ")} with no title. Give each a title and summary with mcp__threads__thread, or file its text under an existing thread.`,
    );
  const replied = book.questions.filter(
    (q) =>
      q.status === "open" && q.sent !== undefined && !pending.includes(q.id),
  );
  if (replied.length > 0) {
    const listed = replied.map((q) => {
      const line = q.sent!.text.split("\n")[0];
      return `- ${q.id} in [[${q.thread}]]: “${clipLine(line, 80)}”`;
    });
    problems.push(
      `The user replied to ${replied.length === 1 ? "this question" : "these questions"}, and you neither settled nor revised ${replied.length === 1 ? "it" : "them"}:\n${listed.join("\n")}\nA question with a reply no longer shows as waiting on the user. Settle each the reply answers (mcp__threads__settle with its answer, or a retraction with their words if they tabled or deferred it). Where they asked about it or asked for something instead of answering, answer them and revise it with mcp__threads__ask revise: its id, so it waits on them again.`,
    );
  }
  const unasked = unaskedWaits(book);
  if (unasked.length > 0)
    problems.push(
      `${unasked.length === 1 ? "This thread's status says it waits" : "These threads' statuses say they wait"} on the user, with no open question:\n${unasked.map((t) => `- [[${t.id}]]: “${stateOf(t)}”`).join("\n")}\n${UNASKED}`,
    );
  return problems.length > 0 ? `[threads] ${problems.join("\n")}` : undefined;
};

// The links' address, which goes nowhere: a press on one is the plugin's to handle.
const TAG_HREF = "https://threads.invalid/";

// A line that opens or closes a fenced code block, and its fence.
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
// What a line's inline references leave alone: code spans, links and autolinks, and bare addresses.
const NOT_PROSE =
  /(`+)[^`][\s\S]*?\1|!?\[[^\]]*\]\([^)]*\)|<[^>\s]+>|https?:\/\/\S+/g;
// A reference in prose: a thread's or question's `[[id]]`, or a question's bare id, as `q3`.
const INLINE_REF = new RegExp(
  `\\[\\[(${TAG_ID})\\]\\]|(?<![\\w-])(q\\d+)(?![\\w-])`,
  "g",
);

// Where a reference in prose goes: a thread, or a question's subthread within its thread.
export type Ref = { thread: string; question?: string };

// A line of prose with each reference that names a known thread or question written as a link, its
// text as written; the links, by href, are added to `refs`. Code spans and links are left alone.
const linkRefsIn = (
  line: string,
  book: Book,
  refs: Record<string, Ref>,
): string => {
  const link = (prose: string) =>
    prose.replace(INLINE_REF, (all: string, tag?: string, bare?: string) => {
      const id = (tag ?? bare) as string;
      const q = questionNamed(book, id);
      const thread =
        q?.thread ??
        (tag !== undefined && threadOf(book, tag) !== undefined
          ? tag
          : undefined);
      if (thread === undefined) return all;
      const href = `${TAG_HREF}ref/${id}`;
      refs[href] = q === undefined ? { thread } : { thread, question: q.id };
      return `[${all.replace(/[[\]\\]/g, "\\$&")}](${href})`;
    });
  let out = "";
  let at = 0;
  for (const m of line.matchAll(NOT_PROSE)) {
    out += link(line.slice(at, m.index)) + m[0];
    at = (m.index ?? 0) + m[0].length;
  }
  return out + link(line.slice(at));
};

// A reply's text for the main view with each tag line drawn as links, one per thread or question it
// names, that go to the section below it there; and the links, by href, with what each names. A tag
// whose thread holds the row unread reads `● plan`: the dot marks that thread's sections of the row read,
// and the name goes to the section, as `▸ plan` does once it is read. A question's tag is its thread's.
// In the prose, given the book, each `[[id]]` or question id (`q3`) that names a thread or question it
// holds is a link too, in `refs`, that opens that thread or the question's subthread; code is left alone.
export const linkTags = (
  text: string,
  book?: Book,
  unread: ReadonlySet<string> = new Set(),
): {
  text: string;
  links: Record<string, { section: number; id: string }>;
  marks: Record<string, string>;
  refs: Record<string, Ref>;
  tagged: string[];
} => {
  const links: Record<string, { section: number; id: string }> = {};
  const marks: Record<string, string> = {};
  const refs: Record<string, Ref> = {};
  const tagged = new Set<string>();
  let section = -1;
  // The fence of the code block the line is in, if it is in one.
  let fence: string | undefined;
  const lines = text.split("\n").map((line) => {
    // A tag line is one wherever it stands, as `sections` splits the reply.
    if (!TAG_LINE.test(line)) {
      const f = FENCE.exec(line)?.[1];
      if (fence !== undefined) {
        if (f !== undefined && f[0] === fence[0] && f.length >= fence.length)
          fence = undefined;
        return line;
      }
      if (f !== undefined) {
        fence = f;
        return line;
      }
      return book === undefined ? line : linkRefsIn(line, book, refs);
    }
    section += 1;
    return tagsIn(line)
      .map((id) => {
        const href = `${TAG_HREF}${section}/${id}`;
        links[href] = { section, id };
        const thread =
          (book === undefined ? undefined : questionNamed(book, id)?.thread) ??
          id;
        tagged.add(thread);
        if (!unread.has(thread)) return `[▸ ${id}](${href})`;
        const mark = `${TAG_HREF}read/${thread}`;
        marks[mark] = thread;
        return `[●](${mark}) [${id}](${href})`;
      })
      .join(" ");
  });
  return { text: lines.join("\n"), links, marks, refs, tagged: [...tagged] };
};

// The entry a section of a reply row was filed as in a thread, or in a question's subthread within its
// thread, for going to it from the section's tag.
export const sectionTarget = (
  book: Book,
  uuid: string,
  text: string,
  section: number,
  id: string,
): { thread: string; question?: string; anchor?: number } | undefined => {
  const q = questionNamed(book, id);
  const thread = q?.thread ?? id;
  const t = threadOf(book, thread);
  if (t === undefined) return undefined;
  const part = sections(text).sections[section];
  const own = historyOf(book, thread).filter(
    (x): x is Message => x.kind === "reply" && x.uuid === uuid,
  );
  const x =
    own.find((x) => part !== undefined && x.text === clip(part.text)) ?? own[0];
  return {
    thread,
    question: q?.id,
    anchor: x?.id,
  };
};

// A reply's text as the transcript draws it in a summary: each tag line becomes a marker naming its
// threads.
export const displayText = (text: string): string =>
  text
    .split("\n")
    .map((line) =>
      TAG_LINE.test(line)
        ? tagsIn(line)
            .map((id) => `\`▸ ${id}\``)
            .join(" ")
        : line,
    )
    .join("\n");
