import { atom, derive, read, update } from "claude-code";
import type {
  EngineEventOf,
  EngineInterface,
  Register,
  RenderInput,
  Timer,
} from "claude-code";

type SessionAppendInput = EngineEventOf["session.append"];
type ToolCallInput = EngineEventOf["tool.call"];
type PaneInput = RenderInput<"Pane">;

import type { Outgoing, PaneView, Place, SortKey, Split, View } from "../types";
import { statusParts, verbColors } from "./color";
import {
  answerMessage,
  answersIn,
  answerOf,
  answerShape,
  ask,
  changeThread,
  displayText,
  emptyBook,
  entryText,
  eventText,
  fileUntagged,
  joinTurn,
  joinPicks,
  noteTyped,
  markRow,
  markSeen,
  markSent,
  optionsOf,
  ordered,
  sortedBy,
  stateOf,
  MAIN,
  promptContext,
  promptRefs,
  recordReply,
  settle,
  unfile,
  startTurn,
  stopProblems,
  rowThreadsIndex,
  isRead,
  subEntries,
  subUnread,
  findIn,
  linkTags,
  sectionTarget,
  holdersOf,
  historyOf,
  fromOf,
  threadOf,
  readBook,
  unread,
  verbsOf,
  waitingOn,
  questionOf,
  tagList,
  type Book,
  type Draft,
  type Entry,
  type Outcome,
  type Question,
  type Ref,
  type Thread,
} from "./model";

const PANE = "threads";
const TITLE = "Threads";
// Rows the docked message field takes at the pane's foot: a rule and the field.
const FIELD_ROWS = 2;
// Rows of a summary the docked head shows before it cuts the rest behind Details.
const SUMMARY_ROWS = 4;
// Each session's book is also kept in `$.store` under its id, so `--resume` in a new process finds it.
// Books untouched for this long are dropped from the store.
const KEEP_MS = 30 * 24 * 3600_000;
const INDEX = "sessions";

const book = atom({ plugin: "threads", key: "book" } as const, emptyBook(0), {
  shape: "book-1",
});
const view = atom(
  { plugin: "threads", key: "view" } as const,
  { selected: null, showClosed: false } as View,
  { shape: "view-3" },
);
const paneView = atom(
  { plugin: "threads", key: "paneView" } as const,
  {} as PaneView,
  { shape: "pane-view-1" },
);
const split = atom({ plugin: "threads", key: "split" } as const, {} as Split, {
  shape: "split-1",
});
// The store's key for the list's rows above a thread, kept for every session.
const LIST_ROWS = "listRows";
const drafts = atom(
  { plugin: "threads", key: "drafts" } as const,
  {} as Record<string, Draft>,
  { shape: "drafts-1" },
);
// Moves on every AGE_TICK so that the thread list, which alone reads it, redraws its ages.
const AGE_TICK = 30_000;
const tick = atom({ plugin: "threads", key: "tick" } as const, 0, {
  shape: "tick-1",
});
// The threads holding each reply row's sections, which every reply row of the transcript draws from:
// computed once per version of the book, not once per row.
const replyThreads = derive([book], rowThreadsIndex);
// What the pane sent that no prompt row holds yet, drawn dim in its threads until one does.
const outbox = atom(
  { plugin: "threads", key: "outbox" } as const,
  [] as Outgoing[],
  { shape: "outbox-2" },
);

const TOOL = {
  thread: "mcp__threads__thread",
  ask: "mcp__threads__ask",
  settle: "mcp__threads__settle",
  file: "mcp__threads__file",
} as const;
const OWN_TOOLS: ReadonlySet<string> = new Set(Object.values(TOOL));

// The one statement of what a status holds, used by the method and both tool descriptions.
const STATUS_RULE =
  'The status is one short line saying what is happening on the thread now, starting with a present-tense verb as if after an implied "I am" ("Testing the fix.", "Waiting on the build."); never what is done, which the history keeps; keep it short.';

const SECTION_ID = "threads:method";
const SECTION = `# Threads

This session keeps its lines of thought as threads. The user reads them in a pane beside the chat, often after being away, so each thread must make sense on its own. A thread's history holds every part of your replies tagged with it, and the user's messages filed under it.

- Tag every reply. Start it with a line holding only a thread's tag, such as \`[[main]]\` or \`[[parser-errors]]\`, and start a new tag line wherever the reply moves to another thread. A line of several tags (\`[[a]] [[b]]\`) files the section under each. Text before a turn's first tag line belongs to no thread. An inline \`[[id]]\` in a sentence refers to that thread, and a question's id (q3) to that question: in the transcript each draws as a link that opens it in the pane, so name threads and questions that way wherever you mention them.
- \`[[main]]\` is the session as a whole: its goal and overall progress. Open a thread with \`mcp__threads__thread\` (a short kebab-case id and a title) whenever a question or a piece of work comes up that can be settled on its own, and file under it the messages of the user's that led to it, from this turn or earlier ones (\`mcp__threads__file\`), so that it holds what it answers. Give it a summary and a status. The summary says what the thread is: what it is about or for (the question it answers or the work it does, and why), in a few sentences a reader coming back cold can follow; change it when the thread's scope changes. ${STATUS_RULE} Keep it current without being asked: update it the moment what is happening changes (you start the next step, or the user answers a question it waits on), so it never says it waits on something already done. The list shows every thread's status and a change is not unread, so a status update is how you report progress: prefer it to a progress message in the thread, and write a message only for what the user needs to read. Subagents and background jobs belong to the thread whose work they do: tag what you say about them with it.
- Put what a thread needs in that thread. When a question depends on something explained elsewhere (a plan, a diff, findings), tag that explanation with both threads, or restate it under the thread that asks.
- Each question has a subthread of its own within its thread, named by its id: the question, its answers, and what is said about it. Tag a section about a question with its id beside its thread's tag, such as \`[[parser-errors]] [[q3]]\`, when you ask it, clarify it or discuss it; the user's messages that open with \`q3:\` or \`[[q3]]\` go there by themselves. To add an earlier message, give the id to \`mcp__threads__file\`. A question's id never names a thread.
- Ask the user every question with \`mcp__threads__ask\`, never with AskUserQuestion, giving the context needed to answer it cold. A question is free text, a choice (pick one option) or a checklist (check any of them): give options for the last two, and kind checklist for a checklist. Mark the option you recommend with recommended: true, one per choice, and say why in its description; leave it off only when you truly have no view. When the user asks about a question instead of answering it, answer them, then revise the question with \`mcp__threads__ask\` (revise: its id), giving the whole question again with what you clarified in its text, context or options, so that it waits on them again as it should now read.
- When you wait on the user to do things themselves (run a command, log in, review a file, try something out), ask them as a checklist of to-dos under the thread that waits, one option per to-do, saying in each what to do and how. When the user sends the ones done, settle the question with them and, if any are left, ask again at once with the remaining to-dos and any new ones; retract it when nothing is left to do. Ask it under the thread it settles: a decision of its own (which library, whether to approve a plan) gets a thread of its own, opened first, not \`[[main]]\`. Write the question in your reply as well, under its thread's tag, with its id (q3).
- Whenever a thread waits on the user (a decision, a confirmation, a check, their verdict on an explanation, a look, a reload, a yes: anything that blocks on them), ask it with \`mcp__threads__ask\` in the same step. Only open questions show as waiting on the user, in the pane and in the band above the prompt when it is on, so a wait with no question goes unseen. The status says what is happening on the thread and may say it waits ("Waiting on q3", "Awaiting the build"); one that says it waits on the user with no open question holds the turn until you ask or change it.
- Keep the threads current without being asked. When the user answers a question, or the work makes it moot, settle it at once with \`mcp__threads__settle\` (its answer, or a retraction with the reason), and update its thread's status in the same step. A question the user tables, declines or defers is retracted, not answered. When you open a thread for a piece of work, say in its summary what finishes it (merged, released, the user confirms the result). When work finishes (a release, a confirmed result, a closed thread), check every open thread that it finishes, not only the threads this turn is tagged with, and close each with \`mcp__threads__thread\` and its outcome, or update its status with what is left; tag the text that reports a thread finishing with that thread too. The prompt's context names threads idle for a few prompts: close each that is done, and update the status of one whose status no longer says what is happening. One whose status is still accurate needs nothing: never write a message in a thread only to say that nothing changed.
- The user may open a message with a thread's tag, or a question's id (\`q3: yes\`), to say what it answers; messages sent from a thread in the pane open with its tag. A message with neither is filed under \`[[main]]\` alone. When a message of the user's is about other threads as well, file it there too with \`mcp__threads__file\` (prompts: true), where it shows as sent under its own threads. To file an earlier message, or a section of an earlier reply, under another thread, give \`quote\` with words from it.`;

const ASK_REFUSED =
  "[threads] Do not use AskUserQuestion in this session: every call is refused. Ask the user with mcp__threads__ask instead, under the thread the question belongs to, with the context needed to answer it cold and the options; then write the question in your reply under that thread's tag and end the turn.";

const THREAD_DESCRIPTION =
  "Open, update or close one thread of this session. A new id needs a title. Set summary to what the thread is, about or for (the question or work, and why), in a few sentences a reader coming back cold can follow, and status: " +
  STATUS_RULE +
  " The list shows the status, so keep it current as the work moves, in place of progress messages; neither change marks the thread unread. A wait on the user is an open question (ask), which the list counts beside the thread. close takes the outcome the thread closes with; reopen opens a closed thread again.";
const ASK_DESCRIPTION =
  "Ask the user a question under a thread. Use this for every question to the user, instead of AskUserQuestion. Give context: what the user needs to answer it cold (the plan, the trade-off, what each option leads to). Give options when the answer is a choice, each with a label, a description of what it means or leads to, and, where seeing it helps, a Markdown preview (a code sketch, a mockup, a diff), and mark the one you recommend with recommended: true; set kind to choice (pick one, the default) or checklist (pick any: which of these to do, which files to keep, or the user's own to-dos that you wait on, re-asked with what is left after each answer). The user can always add a note or answer in their own words. The question waits in the thread's pane and does not block the turn: the answer comes as a later message. Returns the question's id; write the question in your reply too, under the thread's tag, citing the id. With revise: an open question's id, it replaces that question in place instead, after the user asked about it.";
const SETTLE_DESCRIPTION =
  "Settle a question once the user answered it (answer: the answer as they gave it) or once it no longer needs answering (retract: why). Answer only when the reply answers what the question asked. When the user tables, declines or defers it, or says they cannot or will not answer it, retract it with their words as the reason, and ask again later if it still matters. Settle each question as soon as it is answered or moot, without being asked. To correct a question settled the wrong way, settle it again the other way.";
const FILE_DESCRIPTION =
  "File this turn's untagged reply text (written before any [[thread]] tag line) under the threads it was about. With prompts: true, file instead the user's message of this turn under these threads as well, for a message that is about them too; it shows there as sent under its own threads. When the turn holds several messages of the user's (sent while it ran), give quote for each one instead. With quote: words from an earlier message of the user's or section of your reply, from any turn, file that one under these threads as well, in its place in their history. A question's id (q3) among the threads files into its subthread, within its thread. With unfile: true and quote, take a message filed there by mistake out of these threads instead; it stays where it was sent or written. Do not repeat the text.";

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : undefined;
const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const textOf = (content: readonly unknown[]): string =>
  content
    .map((block) =>
      block !== null &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .filter((t) => t !== "")
    .join("\n\n");

// The book lives in `$.state`; the store's copy serves only `--resume` in a new process, and the store
// is one file that holds every session's book. So a change marks the copy stale, and it is written at
// the end of each turn, at the session's end, and at most FLUSH_MS after a change in between.
const FLUSH_MS = 5_000;
const keeping: { isStale: boolean; timer?: Timer; sessionId?: string } = {
  isStale: false,
};

// The session's id, read once: a session that ends forgets it, for the one after /clear.
async function sessionIdOf($: EngineInterface) {
  keeping.sessionId ??= await $.session.id();
  return keeping.sessionId;
}

// Writes the book to the store when the copy there is stale.
async function save($: EngineInterface) {
  keeping.timer?.cancel();
  keeping.timer = undefined;
  if (!keeping.isStale) return;
  keeping.isStale = false;
  const id = await sessionIdOf($);
  const b = await read($, book);
  // The store is one file of every session's book, held to 4 MiB in all: when this book does not fit,
  // the books of the sessions started longest ago make room for it, one at a time.
  for (;;) {
    try {
      await $.store.set(`book:${id}`, b);
      return;
    } catch (error) {
      const index = ((await $.store.get(INDEX)) ?? {}) as Record<
        string,
        number
      >;
      const oldest = Object.entries(index)
        .filter(([sid]) => sid !== id)
        .sort((x, y) => x[1] - y[1])[0]?.[0];
      if (oldest === undefined) throw error;
      await $.store.delete(`book:${oldest}`);
      const { [oldest]: _, ...rest } = index;
      await $.store.set(INDEX, rest);
    }
  }
}

function markStale($: EngineInterface) {
  keeping.isStale = true;
  keeping.timer ??= $.clock.after(FLUSH_MS, () => {
    keeping.timer = undefined;
    void save($).catch(() => undefined);
  });
}

async function change(
  $: EngineInterface,
  fn: (b: Book, now: number) => Book,
): Promise<Book> {
  const now = await $.clock.now();
  const b = await update($, book, (b) => fn(b, now));
  markStale($);
  return b;
}

async function apply(
  $: EngineInterface,
  fn: (b: Book, now: number) => Outcome,
): Promise<Outcome> {
  let outcome: Outcome | undefined;
  await change($, (b, now) => {
    outcome = fn(b, now);
    return outcome.book;
  });
  return outcome as Outcome;
}

// Brings back the book `--resume` left in the store, and forgets books nobody touched for a month.
async function restore($: EngineInterface) {
  const id = await sessionIdOf($);
  const now = await $.clock.now();
  const current = await read($, book);
  const isFresh = current.turn.n === 0 && current.threads.length === 1;
  const stored = (await $.store.get(`book:${id}`)) as
    Parameters<typeof readBook>[0] | undefined;
  // A book in the store or in the state, in any shape either may hold, reads in Book's shapes.
  if (isFresh && stored && Array.isArray(stored.threads))
    await update($, book, () => readBook(stored));
  // The book's initial value is made before any clock: date a fresh session's main by its start.
  else if (isFresh && current.threads[0].createdAt === 0)
    await update($, book, (b) => ({
      ...b,
      threads: b.threads.map((t) =>
        t.createdAt === 0 ? { ...t, createdAt: now, updatedAt: now } : t,
      ),
    }));
  else {
    await update($, book, (b) => readBook(b));
    // Updated code that loads again finds the book in the state; the pending write went with the code
    // that unloaded.
    if (!isFresh) markStale($);
  }
  // The list's rows above a thread, as the person last set them in any session.
  const listRows = await $.store.get(LIST_ROWS);
  if (typeof listRows === "number")
    await update($, split, (s) => ({ ...s, listRows }));
  const index = ((await $.store.get(INDEX)) ?? {}) as Record<string, number>;
  const kept: Record<string, number> = { [id]: now };
  for (const [sid, at] of Object.entries(index)) {
    if (sid === id) continue;
    if (now - at > KEEP_MS) await $.store.delete(`book:${sid}`);
    else kept[sid] = at;
  }
  await $.store.set(INDEX, kept);
}

// A card's first line, its title: the bold id, a button to the question's subthread unless the card is
// drawn there already, and once settled, Answered or Retracted with its age.
const cardTitle = (
  ui: Ui,
  q: Question,
  key: string,
  onOpen: (() => void) | undefined,
  state?: { text: string; color?: string; dim?: boolean; ago?: string },
) => {
  const { Box, Button, Text } = ui;
  return (
    <Box flexDirection="row" marginBottom={1}>
      {onOpen === undefined ? (
        <Text bold>{q.id}</Text>
      ) : (
        <Button key={key} plain onPress={onOpen}>
          <Text bold>{q.id}</Text>
        </Button>
      )}
      {state !== undefined && <Text dimColor> ─ </Text>}
      {state !== undefined && (
        <Text bold color={state.color} dimColor={state.dim}>
          {state.text}
        </Text>
      )}
      {state?.ago !== undefined && <Text dimColor> · {state.ago}</Text>}
    </Box>
  );
};

// A status with its leading verb in the verb's own color and the rest dim.
const statusText = (
  ui: Ui,
  text: string,
  key: string,
  colorOf: (verb: string) => string,
) => {
  const { Text } = ui;
  const { verb, rest } = statusParts(text);
  return [
    <Text key={`${key}:v`} color={colorOf(verb)}>
      {verb}
    </Text>,
    <Text key={`${key}:r`} dimColor>
      {rest}
    </Text>,
  ];
};

// A text cut or padded to exactly `width` cells, an ellipsis marking a cut.
const fit = (text: string, width: number) =>
  text.length <= width
    ? text.padEnd(width)
    : `${text.slice(0, Math.max(0, width - 1))}…`;

const ago = (now: number, at: number) => {
  const m = Math.max(0, Math.round((now - at) / 60_000));
  return m < 1
    ? "now"
    : m < 60
      ? `${m}m`
      : m < 48 * 60
        ? `${Math.round(m / 60)}h`
        : `${Math.round(m / 1440)}d`;
};

// Shows a thread at its first unread message, under the Unread line, or at its latest when it has none: a
// docked thread scrolls itself (lift 0 is its foot), and an inline pane is moved to the Unread line or its end.
// Entering a thread or leaving it, the user has seen what it holds.
// With a question, it shows the question's subthread within the thread, which reads only what it holds.
// It is a new place in the pane's history, unless `move` says it is Back or Forward.
// A closed thread's row stays among the open threads' while it is unread, and while the view
// shows it, if it was unread when the user opened it; read and left, it moves into the closed fold.
function isAboveFold(b: Book, v: View, t: Thread): boolean {
  return t.status === "open" || unread(b, t) > 0 || v.keptUp === t.id;
}

// A thread Claude closes while the view shows it stays in the view, its row above the fold, until
// the user leaves it.
async function keepClosedInView($: EngineInterface, id: string | undefined) {
  const [v, b] = await Promise.all([read($, view), read($, book)]);
  if (id === undefined || v.selected !== id) return;
  if (threadOf(b, id)?.status === "closed")
    await update($, view, (w) => ({ ...w, keptUp: id }));
}

// The view shows only a thread whose row the list shows: a closed one in the fold only while the
// fold is open. Folding the fold with a read closed thread open leaves the view.
async function hideFolded($: EngineInterface) {
  const [v, b] = await Promise.all([read($, view), read($, book)]);
  const t = v.selected === null ? undefined : threadOf(b, v.selected);
  if (t !== undefined && !isAboveFold(b, v, t) && !v.showClosed)
    await select($, null);
}

async function select(
  $: EngineInterface,
  id: string | null,
  question?: string,
  anchor?: number,
  move?: Move,
) {
  const was = await read($, view);
  // The field points back at the new view's own thread, keeping what was typed as the note it was for.
  await keepTyped($, was);
  const left = was.question ?? was.selected;
  const b = await read($, book);
  const parent = id === null ? undefined : threadOf(b, id);
  const q =
    question === undefined || id === null
      ? undefined
      : questionOf(b, question, id);
  const entries =
    parent === undefined
      ? []
      : q === undefined
        ? historyOf(b, parent.id)
        : subEntries(b, q);
  const firstAt =
    parent === undefined ? -1 : entries.findIndex((x) => !isRead(b, parent, x));
  const first = firstAt >= 0 ? entries[firstAt] : undefined;
  // Opening marks the thread read, so a closed thread that was above the fold is kept there until
  // the user leaves it.
  const keptUp =
    parent?.status === "closed" && isAboveFold(b, was, parent)
      ? parent.id
      : undefined;
  const seen = [left, q?.id ?? id].filter((x): x is string => x !== null);
  if (seen.length > 0) await change($, (b) => markSeen(b, seen));
  await update($, paneView, () => ({
    lift: 0,
    details: false,
    toUnread: first !== undefined || anchor !== undefined ? true : undefined,
  }));
  await update($, view, (v) => ({
    ...v,
    ...travelled(v, { selected: id, question: q?.id }, move),
    // A closed thread in the fold has its row in the list only while the fold is open, so opening
    // one opens it.
    ...(parent?.status === "closed" && keptUp === undefined
      ? { showClosed: true }
      : {}),
    keptUp,
    selected: id,
    question: q?.id,
    noteFor: undefined,
    unreadFrom: first?.id,
    anchor,
  }));
  if (id === null) return;
  if (anchor !== undefined || first !== undefined)
    await $.ui
      .scroll({
        in: PANE,
        to: { key: anchor !== undefined ? ANCHOR : UNREAD },
        block: "start",
      })
      .catch(() => undefined);
  else await toEnd($);
}

const ANCHOR = "anchor";

// How the pane reached a place: by Back or Forward, or else as a new place.
type Move = "back" | "forward";

// How many places Back and Forward each keep.
const MAX_PLACES = 50;

const placeOf = (v: View): Place => ({
  selected: v.selected,
  ...(v.question === undefined ? {} : { question: v.question }),
});

const isSame = (a: Place, b: Place) =>
  a.selected === b.selected && a.question === b.question;

// The pane's history once it goes from the view's place to another: Back takes the latest place
// behind and puts this one ahead, Forward the other way round, and a new place goes behind with
// nothing left ahead, as a browser's does. Staying put changes nothing.
const travelled = (
  v: View,
  to: Place,
  move?: Move,
): Pick<View, "back" | "forward"> => {
  const here = placeOf(v);
  const back = v.back ?? [];
  const forward = v.forward ?? [];
  if (move === "back")
    return {
      back: back.slice(0, -1),
      forward: [...forward, here].slice(-MAX_PLACES),
    };
  if (move === "forward")
    return {
      back: [...back, here].slice(-MAX_PLACES),
      forward: forward.slice(0, -1),
    };
  if (isSame(here, to)) return { back, forward };
  return { back: [...back, here].slice(-MAX_PLACES), forward: [] };
};

// Goes Back or Forward in the pane's history, when there is a place that way.
async function travel($: EngineInterface, move: Move) {
  const v = await read($, view);
  const to = (move === "back" ? v.back : v.forward)?.at(-1);
  if (to !== undefined)
    await select($, to.selected, to.question, undefined, move);
}

// The pane's Back and Forward, ← and →: each dim, and pressing it does nothing, while there is no
// place that way, so the two keep their places in the focus ring.
const travelButtons = ($: EngineInterface, ui: Ui, v: View) => {
  const { Button } = ui;
  const button = (move: Move, glyph: string) => {
    const isOpen = ((move === "back" ? v.back : v.forward) ?? []).length > 0;
    return (
      <Button
        key={`hist:${move}`}
        plain
        dimColor={!isOpen}
        onPress={() => void (isOpen ? travel($, move) : undefined)}
      >
        {glyph}
      </Button>
    );
  };
  return [button("back", "←"), button("forward", "→")];
};

// The keys of a drawing's focusable elements, in the order the ring walks them.
export const focusables = (el: unknown, out: string[] = []): string[] => {
  if (Array.isArray(el)) {
    for (const x of el) focusables(x, out);
    return out;
  }
  if (el === null || typeof el !== "object") return out;
  const x = el as {
    type?: unknown;
    props?: { key?: unknown };
    children?: unknown;
  };
  if (x.type === "Button" || x.type === "Input" || x.type === "Select")
    out.push(typeof x.props?.key === "string" ? x.props.key : "");
  focusables(x.children, out);
  return out;
};

// The bullet opening a reply. Claude Code draws ⏺ on macOS and ● elsewhere, where ⏺ can draw as an
// emoji; a plugin cannot read the platform, so ●, which every terminal draws as text.
const BULLET = "●";

// Opens the pane at a message in a thread or subthread, from the main view.
async function jumpTo(
  $: EngineInterface,
  thread: string,
  question: string | undefined,
  anchor: number,
) {
  await select($, thread, question, anchor);
  await $.ui.open({ id: PANE, title: TITLE });
  await $.ui
    .scroll({ in: PANE, to: { key: ANCHOR }, block: "start" })
    .catch(() => undefined);
}

const UNREAD = "unread";

// What the pane's field writes to: a question's note while pointed at it, else the subthread's question
// or the thread.
const fieldTarget = (v: View) =>
  v.noteFor !== undefined ? `note:${v.noteFor}` : `${v.question ?? v.selected}`;

// The key of the pane's message field: its target, and the target's generation. The engine keeps a
// field's text by its key, across redraws and unmounts, empties it on Enter, and draws `value` only when
// it differs from what it last drew under that key. So a note's field, which must open on the kept
// note, takes a key never drawn before each time it is pointed at; a thread's field moves on only when
// it sends, and pointing at a question and back returns to its own key, with what was typed there.
const fieldKey = (v: View) =>
  `msg:${fieldTarget(v)}:${v.fieldGens?.[fieldTarget(v)] ?? 0}`;

// The view's field generations with a target's moved on, so its field draws under a fresh key.
const bumpGen = (v: View, target: string) => ({
  ...v.fieldGens,
  [target]: (v.fieldGens?.[target] ?? 0) + 1,
});

// What the pane's field holds as typed, by the field's key: kept outside every atom, so a key typed
// draws nothing, and read only when the card's ✎ keeps the note it holds.
let typed: { key: string; text: string } | undefined;

// What the field holds as typed for the question it is pointed at, when it was typed under the key the
// view draws now; undefined when nothing was.
const typedFor = (v: View): string | undefined =>
  v.noteFor !== undefined && typed?.key === fieldKey(v)
    ? typed.text
    : undefined;

// Keeps what the field holds, typed and not entered, as the note of the question it is pointed at, as
// Enter does.
async function keepTyped($: EngineInterface, v: View) {
  const text = typedFor(v);
  if (v.noteFor !== undefined && text !== undefined)
    await note($, v.noteFor, text.trim());
}

// Points the pane's field at a question for its note, or back at the thread when it was already, and
// puts the keyboard there. Moved on, it keeps what the field holds as the note of the question it was at, as Enter
// does.
async function noteIn($: EngineInterface, q: Question) {
  // What was typed for the question it was pointed at is kept, whichever card's ✎ moves it.
  await keepTyped($, await read($, view));
  const v = await update($, view, (w) => ({
    ...w,
    noteFor: w.noteFor === q.id ? undefined : q.id,
    // Pointed at, the note's field opens on the kept note; pointed back, the thread's keeps its text.
    ...(w.noteFor === q.id ? {} : { fieldGens: bumpGen(w, `note:${q.id}`) }),
  }));
  typed = undefined;
  // A press in the pane leaves the keyboard where it was, often in the prompt: the pane asks for it
  // first. The engine grants it only over an empty prompt, so typed text there is never taken from.
  await $.ui.open({ id: PANE, title: TITLE, focus: true });
  await $.ui
    .focus({ requestId: PANE, key: fieldKey(v) })
    .catch(() => undefined);
}

// Opens the pane at the thread, or the question's subthread, that a reference in a reply names.
async function openRef($: EngineInterface, ref: Ref) {
  await select($, ref.thread, ref.question);
  await $.ui.open({ id: PANE, title: TITLE, focus: true });
}

// Opens a question's subthread, from its card in the pane or in the main view, which opens the pane.
async function openSubthread(
  $: EngineInterface,
  q: Question,
  site: "pane" | "transcript",
) {
  await select($, q.thread, q.id);
  if (site === "transcript") await $.ui.open({ id: PANE, title: TITLE });
}

// Moves the pane's window to its end: a nicety that a surface with no window to move refuses.
const toEnd = ($: EngineInterface) =>
  $.ui.scroll({ in: PANE, to: "end" }).catch(() => undefined);

// Rows a block of text takes at a width, roughly: Markdown wraps at words, so a little more than cut.
const rowsOf = (text: string, cols: number) =>
  text
    .split("\n")
    .reduce(
      (n, line) =>
        n + Math.max(1, Math.ceil(line.length / Math.max(1, cols - 4))),
      0,
    );

// The first rows of a long text, cut at a word with an ellipsis, as Markdown wraps it roughly.
const cutRows = (text: string, cols: number, rows: number) => {
  const width = Math.max(1, cols - 4);
  const kept: string[] = [];
  let left = rows;
  for (const line of text.split("\n")) {
    const need = Math.max(1, Math.ceil(line.length / width));
    if (need <= left) {
      kept.push(line);
      left -= need;
      continue;
    }
    const room = left * width - 1;
    const cut = line.slice(0, room);
    const atWord = cut.lastIndexOf(" ");
    kept.push(`${atWord > room / 2 ? cut.slice(0, atWord) : cut}…`);
    break;
  }
  return kept.join("\n");
};

type Ui = ReturnType<EngineInterface["ui"]["resolve"]>;

// A question's draft before anything is picked or noted.
const NO_DRAFT: Draft = { picks: [], note: "" };

// What a kept note is called on its card: the whole answer when the question has no options.
const notePrefix = (q: Question) =>
  optionsOf(q).length === 0 ? "Answer: " : "Note: ";

// The kept note a card in the pane draws under its options: none while the field is pointed at it.
const keptNote = (q: Question, d: Draft | undefined, noteFor?: string) =>
  noteFor === q.id || d === undefined || d.note.trim() === ""
    ? undefined
    : d.note.trim();

// Rows a question's card takes in the pane, roughly, as `questionCard` draws it.
export const cardRows = (
  q: Question,
  d: Draft | undefined,
  noteFor: string | undefined,
  cols: number,
) => {
  const note = keptNote(q, d, noteFor);
  const options = optionsOf(q);
  return (
    // The frame and the ✎ row, the title and the blank under it, and the text.
    5 +
    rowsOf(q.text, cols) +
    // A kept note, and the blank under it.
    (note === undefined ? 0 : 1 + rowsOf(`${notePrefix(q)}${note}`, cols)) +
    rowsOf(q.context ?? "", cols) +
    // "Pick one:" between blank lines, then each option.
    (options.length === 0 ? 0 : 3) +
    options.reduce(
      (m, o) => m + 2 + (o.description ? rowsOf(o.description, cols) : 0),
      0,
    )
  );
};

// An option's mark on a card: a checklist's box, or a choice's radio.
const markOf = (q: Question, isPicked: boolean) =>
  q.multiSelect ? (isPicked ? "[x]" : "[ ]") : isPicked ? "(•)" : "( )";

// The label of a card's ✎ button before a note is kept: an answer for a question without options,
// else a note, said to go with the picks once there are some.
const noteLabel = (q: Question, d: Draft, inPrompt: boolean) => {
  const where = inPrompt ? " in the prompt" : "";
  return optionsOf(q).length === 0
    ? `✎ Answer ${q.id}${where}…`
    : d.picks.length > 0
      ? `✎ Add a note${where}; it goes with what you picked…`
      : `✎ Note, or an answer of your own${inPrompt ? "," : ""}${where}…`;
};

// An open question as the user answers it: its text and context, its options to pick, a preview of the
// last one picked, and a ✎ button for a note or an answer of their own. In the pane the button points
// the pane's one field at the question. The transcript draws the card where Claude asked it, and a
// transcript row never holds the keyboard (only a pane and the band, when it is on, do), so there the button starts
// "q1: " in the prompt box for the note, and the picks made on the card join it when it is sent.
function questionCard(
  $: EngineInterface,
  ui: Ui,
  q: Question,
  draft: Draft | undefined,
  site: "pane" | "transcript",
  inSubthread = false,
  noteFor?: string,
) {
  const { Box, Button, Markdown, Text } = ui;
  const d = draft ?? NO_DRAFT;
  const options = optionsOf(q);
  const preview = options
    .filter((o) => d.picks.includes(o.label) && o.preview)
    .at(-1)?.preview;
  // In the pane, each question waiting draws in a frame of its own, to tell it from the next one and
  // from the messages around it.
  const title = cardTitle(
    ui,
    q,
    `sub:${q.id}`,
    inSubthread ? undefined : () => void openSubthread($, q, site),
  );
  return (
    <Box
      key={`q:${q.id}`}
      flexDirection="column"
      {...(site === "pane"
        ? { borderStyle: "round", borderColor: "warning", paddingX: 1 }
        : {})}
    >
      {site === "pane" && title}
      <Markdown text={site === "pane" ? q.text : `**${q.id}** ${q.text}`} />
      {site !== "pane" && !inSubthread && (
        <Box>
          <Button
            key={`sub:${q.id}`}
            plain
            dimColor
            onPress={() => void openSubthread($, q, site)}
          >
            ▸ {q.id}'s subthread
          </Button>
        </Box>
      )}
      {q.context && <Markdown text={q.context} />}
      {options.length > 0 && (
        <Box marginY={1}>
          <Text dimColor>{q.multiSelect ? "Check any:" : "Pick one:"}</Text>
        </Box>
      )}
      {options.map((o, i) => {
        const isPicked = d.picks.includes(o.label);
        // A blank line under each option parts it from the next, and the last from the note.
        return (
          <Box flexDirection="column" marginBottom={1}>
            <Button
              key={`opt:${q.id}:${i}`}
              plain
              onPress={() => void pick($, q, o.label)}
            >
              {markOf(q, isPicked)} <Text bold={isPicked}>{o.label}</Text>
              {o.recommended && <Text color="success"> (recommended)</Text>}
            </Button>
            {o.description && (
              <Box paddingLeft={4}>
                <Text dimColor>{o.description}</Text>
              </Box>
            )}
          </Box>
        );
      })}
      {q.multiSelect && d.picks.length === 0 && (
        <Box>
          <Button
            key={`none:${q.id}`}
            label="Send with none checked"
            onPress={() => void sendNone($, q)}
          />
        </Box>
      )}
      {preview && (
        <Box borderStyle="round" paddingX={1}>
          <Markdown text={preview} />
        </Box>
      )}
      {site === "transcript" ? (
        <Box>
          <Button
            key={`note:${q.id}`}
            plain
            dimColor
            onPress={() => void answerInPrompt($, q)}
          >
            {noteLabel(q, d, true)}
          </Button>
        </Box>
      ) : (
        // The pane has one text field, at its foot: this points it at the question, so what is typed
        // there is kept as the note, to go with the picks when the thread's answers are sent. A field
        // in the card would sit inside its frame, and the engine cuts a field inset over 2 columns at
        // one row instead of wrapping it.
        <Box flexDirection="column">
          {keptNote(q, d, noteFor) !== undefined && (
            <Box marginBottom={1}>
              <Text>
                <Text dimColor>{notePrefix(q)}</Text>
                {keptNote(q, d, noteFor)}
              </Text>
            </Box>
          )}
          <Box>
            <Button
              key={`note:${q.id}`}
              plain
              dimColor={noteFor !== q.id}
              onPress={() => void noteIn($, q)}
            >
              {noteFor === q.id
                ? "✎ Writing below; Enter or press again to keep it"
                : d.note.trim() !== ""
                  ? options.length === 0
                    ? "✎ Change the answer…"
                    : "✎ Change the note…"
                  : noteLabel(q, d, false)}
            </Button>
          </Box>
        </Box>
      )}
    </Box>
  );
}

// Puts "q1: " in the prompt box for the user's note, on a line below what the box holds, never over it,
// and not again while a line answers the question. The picks stay on the card, to change until the
// message goes, when the prompt hook joins them to the note. From then on the answer goes from the
// prompt alone: the main view's card shows no Send answer, and says to send it from the prompt.
async function answerInPrompt($: EngineInterface, q: Question) {
  const box = await $.prompt.read();
  const has = answersIn(await read($, book), box.text).includes(q.id);
  const filled = has
    ? { isFilled: true }
    : box.text.trim() === ""
      ? await $.prompt.fill({ text: `${q.id}: ` })
      : await $.prompt.fill({
          text: `${box.text.endsWith("\n") ? "" : "\n"}${q.id}: `,
          mode: "append",
        });
  if (filled.isFilled)
    await update($, drafts, (all) => ({
      ...all,
      [q.id]: {
        ...(all[q.id] ?? NO_DRAFT),
        inPrompt: true as const,
      },
    }));
}

// The docked thread view scrolls itself above a message field pinned at its foot. Its render notes
// here how far its content may lift, which the scroll hook clamps to.
const foot = { pinned: false, maxLift: 0, lift: 0 };

// The docked list scrolls its rows in a window of its own under its pinned titles. Its render notes
// here the row the window starts at, the most it may, its rows and all the list's rows.
const listWin = { lift: 0, max: 0, rows: 0, lines: 0 };

// How the docked pane was last laid out: the rows from its top through the divider that are the
// list's (all of them while no thread is open), and the most rows the list may take above a thread.
const layout = { docked: false, listBottom: 0, maxListRows: 1 };

// Where the person last put the pane's focus ring: on the list (its rows, its titles, the divider's
// buttons) or on the thread's view.
let focusIn: "list" | "view" = "view";
const LIST_KEYS = /^(?:t|s|x|xs|sort|split):|^closed$/;

// Rows the thread's view keeps at least below the list: its head, a row or two of history, the field.
const MIN_VIEW_ROWS = 10;

// The rows the list takes above a thread: as the person set them by dragging the divider, else its own
// rows up to a third of the pane, within what the pane holds.
const listRowsFor = (sp: Split, bodyRows: number) =>
  Math.max(
    1,
    Math.min(
      sp.listRows ?? Math.max(3, Math.floor((bodyRows - 3) / 3)),
      bodyRows - 3 - MIN_VIEW_ROWS,
    ),
  );

// Waits this long after the last resize before the store keeps it, so a drag writes it once.
const KEEP_SPLIT_MS = 1_000;
let splitTimer: Timer | undefined;

// Sets the rows the list takes above a thread, within what the pane holds and what the list has, and
// keeps them in the store.
async function resize($: EngineInterface, rows: number) {
  const n = Math.max(1, Math.min(Math.round(rows), layout.maxListRows));
  const sp = await read($, split);
  if (sp.listRows === n) return;
  await update($, split, (s) => ({ ...s, listRows: n }));
  splitTimer?.cancel();
  splitTimer = $.clock.after(KEEP_SPLIT_MS, () => {
    splitTimer = undefined;
    void $.store.set(LIST_ROWS, n).catch(() => undefined);
  });
}

// Gives the list back the rows it takes by itself, and forgets the set size in every session.
async function autoSize($: EngineInterface) {
  splitTimer?.cancel();
  splitTimer = undefined;
  await update($, split, (s) => ({ ...s, listRows: undefined }));
  await $.store.delete(LIST_ROWS).catch(() => undefined);
}

async function pick($: EngineInterface, q: Question, label: string) {
  await update($, drafts, (all) => {
    const d = all[q.id] ?? NO_DRAFT;
    const isPicked = d.picks.includes(label);
    const picks = q.multiSelect
      ? isPicked
        ? d.picks.filter((p) => p !== label)
        : [...d.picks, label]
      : isPicked
        ? []
        : [label];
    return {
      ...all,
      [q.id]: {
        picks,
        note: d.note,
        ...(d.inPrompt ? { inPrompt: true as const } : {}),
      },
    };
  });
}

// Sets a question's drafted note, as the pane's field sends it.
async function note($: EngineInterface, id: string, text: string) {
  await update($, drafts, (all) => ({
    ...all,
    [id]: { ...(all[id] ?? NO_DRAFT), note: text },
  }));
}

// Sends a checklist with nothing checked, beside the thread's other drafted answers.
async function sendNone($: EngineInterface, q: Question) {
  await update($, drafts, (all) => ({
    ...all,
    [q.id]: { picks: [], note: all[q.id]?.note ?? "", none: true as const },
  }));
  await sendAnswers($, q.thread);
}

// Sends the thread's drafted answers as one message of the person's own, marks them sent, and clears
// their drafts; the questions stay open until the session settles them.
async function sendAnswers($: EngineInterface, thread: string) {
  // What the field holds for the question it is pointed at goes too, entered or not.
  await keepTyped($, await read($, view));
  const ds = await read($, drafts);
  const message = answerMessage(await read($, book), thread, ds);
  if (message === undefined) return;
  const ids = message.answered.map((a) => a.id);
  await update($, drafts, (all) =>
    Object.fromEntries(Object.entries(all).filter(([id]) => !ids.includes(id))),
  );
  // A field pointed at a question now sent points back at the view's own thread or subthread.
  await update($, view, (v) => ({
    ...v,
    noteFor:
      v.noteFor !== undefined && ids.includes(v.noteFor)
        ? undefined
        : v.noteFor,
  }));
  await update($, paneView, (p) => ({ ...p, lift: 0 }));
  await change($, (b, now) => markSent(b, message.answered, now));
  await submit($, message.text, "answers", ids);
}

// Sends text as the person's own message, kept in the outbox until its prompt row is recorded, with
// where it was sent from and the questions it answers; a prompt that does not enter (a hook's drop)
// leaves it at once.
async function submit(
  $: EngineInterface,
  text: string,
  kind: Outgoing["kind"],
  questions: string[],
) {
  const out: Outgoing = {
    text: text.trim(),
    at: await $.clock.now(),
    kind,
    questions,
  };
  await update($, outbox, (o) => [...o, out]);
  const entered = await $.prompt.submit({ text, asUser: true });
  if (entered.drop !== undefined)
    await update($, outbox, (o) =>
      o.filter((x) => x.at !== out.at || x.text !== out.text),
    );
}

// The questions that messages in the outbox answer: their answers have not reached Claude yet.
const awaited = (out: readonly Outgoing[]) => out.flatMap((x) => x.questions);

// Drops what the outbox holds of a prompt row's text: a row may hold several queued messages.
async function unsend($: EngineInterface, rendered: string) {
  const o = await read($, outbox);
  if (o.some((x) => rendered.includes(x.text)))
    await update($, outbox, (o) => o.filter((x) => !rendered.includes(x.text)));
}

async function openPane($: EngineInterface, id?: string | null) {
  if (id !== undefined) await select($, id);
  const opened = await $.ui.open({ id: PANE, title: TITLE });
  if (id) await toEnd($);
  return opened;
}

// Whether a prompt is the person's own words: typed, sent from their phone or the SDK host, or
// sent by a plugin as theirs (this one's pane). A background task's notification, another
// session's message or a scheduled prompt arrives as a prompt too, and is no one's message.
const isPersons = (origin: { kind: string; asUser?: true }) =>
  origin.kind === "composer" ||
  origin.kind === "bridge" ||
  origin.kind === "sdk" ||
  (origin.kind === "plugin" && origin.asUser === true);

async function recordRow($: EngineInterface, e: SessionAppendInput) {
  const m = e.message;
  // The prompt row holds the text as typed: the context a hook attaches is a row of its own.
  if (e.door === "prompt" && m.type === "user" && !m.isMeta) {
    const text = isPersons(e.origin) ? textOf(m.content) : undefined;
    await change($, (b, now) => startTurn(b, text, e.uuid, now));
    if (text !== undefined) await unsend($, text);
  } else if (m.type === "attachment" && m.name === "queued_command") {
    const rendered = textOf(m.content);
    await change($, (b, now) => joinTurn(b, rendered, e.uuid, now));
    await unsend($, rendered);
  } else if (e.door === "response" && m.type === "assistant") {
    const text = textOf(m.content);
    if (text.trim() !== "")
      await change($, (b, now) => recordReply(b, text, e.uuid, now));
  }
}

// The model's tools serve the main conversation alone: a subagent's work belongs to the thread of the
// reply that started it. Each reads its call's fields, applies its change to the book, and answers
// with the outcome's message, an error as a refusal, and its note as context only the model reads.
async function modelTool(
  $: EngineInterface,
  e: ToolCallInput,
  fn: (x: Record<string, unknown>, b: Book, now: number) => Outcome,
) {
  if (e.agentId !== undefined)
    return {
      deny: "Only the main session keeps threads. Report back to it instead.",
    };
  const x = e as Record<string, unknown>;
  const out = await apply($, (b, now) => fn(x, b, now));
  return out.isError
    ? { deny: out.message }
    : {
        result: out.message,
        ...(out.note === undefined ? {} : { context: [out.note] }),
      };
}

// A model tool's call the plugin failed on.
const failed = () => ({
  deny: "[threads] The threads plugin failed on this call; go on without it and tell the user.",
});

// Rows the thread view's parts take at a width, roughly: its head; from the history's entry at an index
// to the content's foot (the Unread line, if it is there, the messages, those sent and not seen yet, and
// the questions); and the whole content, which Details replaces with the whole summary.
function viewRows(o: {
  t: Thread;
  entries: Entry[];
  pending: Outgoing[];
  questions: Question[];
  ds: Record<string, Draft>;
  noteFor?: string;
  divider?: number;
  cols: number;
  docked: boolean;
  brief: string;
  long: boolean;
  details: boolean;
}) {
  const { t, cols, divider } = o;
  const head =
    5 +
    (stateOf(t) ? rowsOf(`Status: ${stateOf(t)}`, cols) : 0) +
    (o.details ? 0 : t.summary === "" ? 1 : rowsOf(o.brief, cols)) +
    (o.long ? 1 : 0);
  const questionRows = o.questions.reduce(
    (n, q) => n + cardRows(q, o.ds[q.id], o.noteFor, cols),
    o.questions.length > 0 ? 2 : 0,
  );
  const from = (at: number) =>
    (divider !== undefined && divider >= at ? 2 : 0) +
    [
      ...o.entries.slice(at).map(entryText),
      ...o.pending.map((x) => x.text),
    ].reduce((n, text) => n + 2 + rowsOf(text, cols), 0) +
    questionRows;
  const total = o.details
    ? rowsOf(t.summary, cols)
    : (o.docked ? 0 : head) +
      (t.status === "closed" && t.outcome ? 1 + rowsOf(t.outcome, cols) : 0) +
      2 +
      from(0);
  return { head, from, total };
}

// The pane's list of threads, in columns, each with its subthreads when unfolded.
async function listView(
  $: EngineInterface,
  e: PaneInput,
  ui: Ui,
  b: Book,
  v: View,
  now: number,
  colorOf: (verb: string) => string,
  // Docked, the rows the list's window may take, and whether it sits above a thread's view.
  win?: { rows: number; split: boolean },
) {
  const { Box, Button, Text } = ui;
  const [, out] = await Promise.all([read($, tick), read($, outbox)]);
  const all = sortedBy(b, v.sort);
  const above = all.filter((x) => isAboveFold(b, v, x));
  const openCount = all.filter((x) => x.status === "open").length;
  // The threads holding a message of the user's that Claude has not seen yet: sent from the pane
  // and still queued. A ◌ marks them, as ● marks what the user has not seen.
  const unseen = new Set(
    out.flatMap((x) => {
      const to = promptRefs(b, x.text).threads;
      return to.length > 0 ? to : [MAIN];
    }),
  );
  const folded = all.filter((x) => !isAboveFold(b, v, x));
  const waiting = waitingOn(b).length;
  // Columns: a toggle for the thread's subthreads, the questions waiting beside it, id, title, age;
  // the title takes what the others leave. A subthread's id is indented under its thread's.
  const cols = e.props.bodyColumns;
  const idW = Math.min(
    24,
    Math.max(
      4,
      ...all.map((x) => x.id.length),
      ...b.questions.map((q) => q.id.length + 2),
    ),
  );
  const waitW = 3;
  const ageW = 4;
  // Title and status share what the other columns leave. Titles come first: a title is never cut
  // to make room for a status, so the status column shows only when some thread has a status and
  // at least `minW` cells are left past the longest title.
  const rest = Math.max(8, cols - 4 - idW - waitW - ageW - 3);
  const minW = 16;
  const hasStatus = all.some((x) => stateOf(x) !== "");
  const titleNeed = Math.max(minW, ...all.map((x) => x.title.length));
  const statusShown = hasStatus && rest - 1 - titleNeed >= minW;
  const titleW = statusShown ? titleNeed : rest;
  const statusW = statusShown ? rest - 1 - titleW : 0;
  const firstLine = (text: string) => text.split("\n")[0];
  const fresh = above.filter((x) => unread(b, x) > 0).length;
  const expanded = v.expanded ?? [];
  const settledShown = v.settledShown ?? [];
  const toggle = (list: "expanded" | "settledShown", id: string) =>
    void update($, view, (w) => {
      const ids = w[list] ?? [];
      return {
        ...w,
        [list]: ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
      };
    });
  // A column's title, a button that sorts the list by it: pressed again, it turns the order round.
  // The sort column's title is bold and carries ▲ ascending or ▼ descending.
  const header = (by: SortKey, name: string, width: number, right = false) => {
    const isSorted = v.sort?.by === by;
    const label = `${name}${isSorted ? (v.sort!.desc ? "▼" : "▲") : ""}`;
    return (
      <Button
        key={`sort:${by}`}
        plain
        dimColor={!isSorted}
        onPress={() =>
          void update($, view, (w) => ({
            ...w,
            sort: {
              by,
              desc: w.sort?.by === by ? !w.sort.desc : false,
            },
          }))
        }
      >
        <Text bold={isSorted}>
          {right ? label.padStart(width) : fit(label, width)}
        </Text>
      </Button>
    );
  };
  // Above a thread's view, the list draws the id of what is open below it inverted: the subthread's
  // row when it is shown, its thread's otherwise.
  const shown = (q: Question | undefined) =>
    q !== undefined &&
    expanded.includes(q.thread) &&
    (q.status === "open" || settledShown.includes(q.thread));
  const isHere = (id: string) =>
    win?.split === true &&
    (v.question === undefined
      ? v.selected === id
      : v.question === id ||
        (v.selected === id && !shown(questionOf(b, v.question))));
  const subRow = (q: Question) => {
    const isNew = subUnread(b, q) > 0;
    const isWaiting = q.status === "open" && q.sent === undefined;
    const isSettled = q.status !== "open";
    return (
      <Box key={`srow:${q.id}`} flexDirection="row">
        <Text>{"  "}</Text>
        <Button
          key={`s:${q.id}`}
          plain
          // The open row's press closes the view below.
          onPress={() =>
            void (isHere(q.id) ? select($, null) : select($, q.thread, q.id))
          }
        >
          <Text color="warning">{fit(isWaiting ? "?" : "", waitW)}</Text>{" "}
          <Text color="suggestion">{isNew ? "● " : "  "}</Text>
          <Text>{"  "}</Text>
          <Text dimColor={isSettled} inverse={isHere(q.id)}>
            {fit(q.id, idW - 2)}
          </Text>{" "}
          <Text bold={isNew} dimColor={isSettled}>
            {fit(firstLine(q.text), statusShown ? rest : titleW)}
          </Text>{" "}
          <Text dimColor>
            {ago(now, q.askedAt).slice(0, ageW).padStart(ageW)}
          </Text>
        </Button>
      </Box>
    );
  };
  const row = (x: Thread) => {
    const n = waitingOn(b, x.id).length;
    const isClosed = x.status === "closed";
    const isNew = unread(b, x) > 0;
    const qs = b.questions.filter((q) => q.thread === x.id);
    const isOpen = expanded.includes(x.id);
    const live = qs.filter((q) => q.status === "open");
    const settled = qs.filter((q) => q.status !== "open");
    // One row each: the thread's, then when unfolded its open questions', the settled toggle's and
    // the settled ones'.
    return [
      <Box key={`trow:${x.id}`} flexDirection="row">
        {qs.length > 0 ? (
          <Button
            key={`x:${x.id}`}
            plain
            dimColor
            onPress={() => toggle("expanded", x.id)}
          >
            {isOpen ? "▾ " : "▸ "}
          </Button>
        ) : (
          <Text>{"  "}</Text>
        )}
        <Button
          key={`t:${x.id}`}
          plain
          onPress={() => void select($, isHere(x.id) ? null : x.id)}
        >
          <Text color="warning">{fit(n > 0 ? `?${n}` : "", waitW)}</Text>{" "}
          <Text color="suggestion">
            {isNew ? "● " : !statusShown && unseen.has(x.id) ? "◌ " : "  "}
          </Text>
          <Text bold={isNew} dimColor={isClosed} inverse={isHere(x.id)}>
            {fit(x.id, idW)}
          </Text>{" "}
          <Text bold={isNew} dimColor={isClosed}>
            {fit(x.title, titleW)}
          </Text>{" "}
          {statusShown && (
            <Text color="suggestion">{unseen.has(x.id) ? "◌ " : "  "}</Text>
          )}
          {statusShown &&
            statusText(
              ui,
              `${fit(firstLine(stateOf(x)), statusW - 2)} `,
              `st:${x.id}`,
              // A verb cut to fit keeps its whole word's color.
              () => colorOf(statusParts(stateOf(x)).verb),
            )}
          <Text dimColor>
            {ago(now, x.updatedAt).slice(0, ageW).padStart(ageW)}
          </Text>
        </Button>
      </Box>,
      ...(isOpen ? live.map(subRow) : []),
      ...(isOpen && settled.length > 0
        ? [
            <Box key={`xsrow:${x.id}`} flexDirection="row">
              <Text>{" ".repeat(7 + waitW)}</Text>
              <Button
                key={`xs:${x.id}`}
                plain
                dimColor
                onPress={() => toggle("settledShown", x.id)}
              >
                {settledShown.includes(x.id) ? "▾" : "▸"} {settled.length}{" "}
                settled
              </Button>
            </Box>,
          ]
        : []),
      ...(isOpen && settledShown.includes(x.id) ? settled.map(subRow) : []),
    ];
  };
  // Every row under the column titles, one row each, and where each thread's own row is among them.
  const lines: ReturnType<typeof row> = [];
  const rowAt = new Map<string, number>();
  const add = (x: Thread) => {
    rowAt.set(x.id, lines.length);
    lines.push(...row(x));
  };
  above.forEach(add);
  if (folded.length > 0)
    lines.push(
      <Box key="closedrow" flexDirection="row">
        <Button
          key="closed"
          plain
          onPress={() =>
            void update($, view, (v) => ({
              ...v,
              showClosed: !v.showClosed,
            })).then(() => hideFolded($))
          }
        >
          {v.showClosed ? "▾" : "▸"} {folded.length} closed
        </Button>
      </Box>,
    );
  if (v.showClosed) folded.forEach(add);
  const stats = (
    <Box flexDirection="row" gap={1}>
      {win?.split !== true && travelButtons($, ui, v)}
      <Text dimColor>
        {openCount} open · {fresh} unread · {waiting} waiting on you ·{" "}
        {all.length - openCount} closed
      </Text>
    </Box>
  );
  const titles = (
    <Box flexDirection="row">
      <Text>{"  "}</Text>
      {header("waiting", "?", waitW)}
      <Text>{"   "}</Text>
      {header("id", "id", idW)}
      <Text> </Text>
      {header("title", "title", titleW)}
      <Text> </Text>
      {statusShown && <Text>{"  "}</Text>}
      {statusShown && header("status", "status", statusW - 2)}
      {statusShown && <Text> </Text>}
      {header("age", "age", ageW, true)}
    </Box>
  );
  if (win === undefined)
    return (
      <Box flexDirection="column">
        {stats}
        {titles}
        {lines}
      </Box>
    );
  // Docked, the stats line and the column titles stay pinned, and the rows scroll in a window of
  // their own below them: as many as fit, up to `win.rows`, from the row `listLift` names. When the
  // pane moved to another thread since the list last scrolled, the window moves the least that shows
  // that thread's row.
  const rows = Math.max(1, Math.min(win.rows, lines.length));
  const max = Math.max(0, lines.length - rows);
  const sp = await read($, split);
  let lift = Math.max(0, Math.min(sp.listLift ?? 0, max));
  const at = v.selected === null ? undefined : rowAt.get(v.selected);
  if (at !== undefined && sp.listFor !== v.selected) {
    if (at < lift) lift = at;
    else if (at >= lift + rows) lift = at - rows + 1;
  }
  listWin.lift = lift;
  listWin.max = max;
  listWin.rows = rows;
  listWin.lines = lines.length;
  return (
    <Box flexDirection="column" flexShrink={0}>
      {stats}
      {titles}
      <Box
        flexDirection="column"
        height={rows}
        flexShrink={0}
        overflow="hidden"
      >
        {lines.slice(lift, lift + rows)}
      </Box>
    </Box>
  );
}

// The pane's view of one thread, or of a question's subthread within it: its head, its history and
// the questions waiting, and the pane's one field.
async function threadView(
  $: EngineInterface,
  e: PaneInput,
  ui: Ui,
  b: Book,
  v: View,
  t0: Thread,
  now: number,
  colorOf: (verb: string) => string,
  // The rows the view takes: the pane's, or what the list leaves above it.
  bodyRows: number,
  // Whether the list sits above it, which closes it: then the head has no way back to the list.
  split = false,
) {
  const { Box, Button, Input, Markdown, Text } = ui;
  // A question's subthread draws as a thread of its own: the entries of its thread that it holds.
  const sq =
    v.question === undefined ? undefined : questionOf(b, v.question, t0.id);
  const t: Thread =
    sq === undefined
      ? t0
      : { ...t0, title: `${sq.id}: ${sq.text.split("\n")[0]}`, summary: "" };
  // The whole history is drawn, to scroll through.
  const entries = sq === undefined ? historyOf(b, t0.id) : subEntries(b, sq);
  // A thread shows the questions waiting on the user; a subthread shows its question while it is open,
  // replied to or not, since it is what the subthread is about.
  const questions =
    sq === undefined ? waitingOn(b, t.id) : sq.status === "open" ? [sq] : [];
  // Sent from the pane and not seen by Claude yet: filed where its row will be.
  const [out, ds, p] = await Promise.all([
    read($, outbox),
    read($, drafts),
    read($, paneView),
  ]);
  const pending = out.filter((x) => {
    const refs = promptRefs(b, x.text);
    if (sq !== undefined)
      return [...refs.subs, ...refs.questions].includes(sq.id);
    const to = refs.threads;
    return (to.length > 0 ? to : [MAIN]).includes(t.id);
  });
  // Where the Unread line goes: above the first entry unread when the user opened the thread, found by its
  // id, or else above the first one after it.
  const boundary = findIn(entries, v.unreadFrom);
  // The message it was opened at, from a tag: held at the top in place of the Unread line.
  const anchorAt = findIn(entries, v.anchor);
  const divider = boundary >= 0 ? boundary : undefined;
  const anchored = anchorAt >= 0 ? anchorAt : undefined;
  // Sends the person's words as their own message, filed by its prefix; a fresh field takes the next.
  const send = async (prefix: string, words: string) => {
    if (words.trim() === "") return;
    await update($, paneView, (p) => ({ ...p, lift: 0, toUnread: false }));
    await update($, view, (v) => ({
      ...v,
      fieldGens: bumpGen(v, fieldTarget(v)),
    }));
    const text = `${prefix}${words.trim()}`;
    await submit(
      $,
      text,
      sq === undefined ? "thread" : "subthread",
      sq === undefined ? promptRefs(b, text).questions : [sq.id],
    );
  };
  // A question counts as drafted with what the field holds for it, typed and not entered yet, so a
  // free answer typed alone can be sent: the field draws no value of its own.
  const typedNote = typedFor(v);
  const draftOf = (q: Question): Draft | undefined =>
    typedNote !== undefined && q.id === v.noteFor
      ? { ...(ds[q.id] ?? NO_DRAFT), note: typedNote }
      : ds[q.id];
  const drafted = questions.filter(
    (q) => answerOf(q, draftOf(q)) !== undefined,
  ).length;
  const who = (x: Entry) =>
    x.kind === "prompt" ? "You" : x.kind === "reply" ? "Claude" : "·";
  // The other threads and subthreads that hold a message, to go to it there: not the one shown.
  const elsewhere = (x: Entry) =>
    holdersOf(b, x).filter((place) =>
      sq === undefined
        ? !(place.thread === t.id && place.question === undefined)
        : place.question !== sq.id,
    );

  // Pointed at a question by its card's ✎ button, the field holds that question's note, and Enter
  // keeps it on the card, to go with the picks when Send sends the thread's answers.
  const noting = questions.find((q) => q.id === v.noteFor);
  const field = (
    <Input
      key={fieldKey(v)}
      {...(noting !== undefined && ds[noting.id]?.note
        ? { value: ds[noting.id].note }
        : {})}
      onInput={(text) => {
        const key = fieldKey(v);
        const wasEmpty = typed?.key !== key || typed.text.trim() === "";
        typed = { key, text };
        // Typing draws nothing, except where a note's field fills or empties: whether its question
        // can be sent changes, so the Send button redraws.
        if (noting !== undefined && wasEmpty !== (text.trim() === ""))
          void update($, paneView, (p) => ({
            ...p,
            typing: text.trim() === "" ? undefined : key,
          }));
      }}
      placeholder={
        noting !== undefined
          ? optionsOf(noting).length === 0
            ? `Answer ${noting.id}…`
            : `Note for ${noting.id}, sent with your picks…`
          : sq === undefined
            ? "Message this thread…"
            : `Reply to ${sq.id}…`
      }
      submitLabel="send"
      onSubmit={(words) =>
        void (noting !== undefined
          ? note($, noting.id, words.trim()).then(() =>
              update($, view, (w) => ({
                ...w,
                noteFor: undefined,
              })),
            )
          : send(sq === undefined ? `[[${t.id}]] ` : `${sq.id}: `, words))
      }
    />
  );
  // Docked, the thread's head (title and summary) is pinned at the top and the message field at the
  // foot. Between them the history and questions scroll, latest at the bottom: the content sits at
  // the region's foot and lifts by the rows scrolled up. A long summary shows its first rows in the
  // head, and Details shows it whole in the scrolling region instead.
  const cols = e.props.bodyColumns;
  const docked = e.props.placement === "dock";
  const long = docked && rowsOf(t.summary, cols) > SUMMARY_ROWS;
  const details = long && p.details === true;
  const brief = long ? cutRows(t.summary, cols, SUMMARY_ROWS) : t.summary;
  const rows = viewRows({
    t,
    entries,
    pending,
    questions,
    ds,
    noteFor: v.noteFor,
    divider,
    cols,
    docked,
    brief,
    long,
    details,
  });
  const region = bodyRows - FIELD_ROWS - (docked ? rows.head : 0);
  const maxLift = Math.max(0, rows.total - region);
  // Lifted so that the Unread line sits at the region's top, or at the foot when what follows it fits.
  const held = anchored ?? divider;
  const unreadLift =
    held === undefined ? 0 : Math.max(0, rows.from(held) - region);
  foot.pinned = docked;
  foot.maxLift = maxLift;
  const lift = Math.min(
    p.toUnread === true && !details ? unreadLift : (p.lift ?? 0),
    maxLift,
  );
  foot.lift = lift;
  const head = threadHead(
    $,
    ui,
    v,
    t,
    sq,
    now,
    colorOf,
    brief,
    long,
    details,
    split,
  );
  // The whole summary reads from its top: lifted all the way is its top, as the history's is.
  const content = details ? (
    <Box flexDirection="column" flexShrink={0} marginTop={lift - maxLift}>
      <Markdown text={t.summary} />
    </Box>
  ) : (
    <Box
      flexDirection="column"
      gap={1}
      flexShrink={0}
      marginBottom={docked ? -lift : 0}
    >
      {!docked && head}
      {sq === undefined && t.status === "closed" && t.outcome && (
        <Markdown text={`**Closed:** ${t.outcome}`} />
      )}
      <Box flexDirection="column" gap={1}>
        <Text bold>History</Text>
        {entries.length === 0 && pending.length === 0 && (
          <Text dimColor>Nothing yet.</Text>
        )}
        {entries.flatMap((x, i) => {
          const settled = answeredOf(b, x);
          const others = elsewhere(x);
          const from = x.kind === "event" ? undefined : fromOf(x, t.id);
          return [
            ...(i === divider
              ? [
                  <Box key={UNREAD} flexShrink={0}>
                    <Text color="warning">
                      {"─ Unread ".padEnd(Math.max(10, cols - 2), "─")}
                    </Text>
                  </Box>,
                ]
              : []),
            settled !== undefined ? (
              answeredCard($, ui, settled, x, `${i}`, now, sq !== undefined)
            ) : x.kind === "event" &&
              x.event === "summary" &&
              x.detail !== undefined ? (
              // A summary edit shows the summary as it then read, so the history keeps every version.
              <Box flexDirection="column">
                <Text dimColor>{ago(now, x.at)} · Summary updated</Text>
                <Box paddingLeft={2}>
                  <Markdown text={x.detail} />
                </Box>
              </Box>
            ) : x.kind === "event" && x.event === "status" ? (
              <Text>
                <Text dimColor>{ago(now, x.at)} · Status: </Text>
                {statusText(ui, x.detail ?? "", `ev:${i}`, colorOf)}
              </Text>
            ) : x.kind === "event" ? (
              <Text dimColor>
                {ago(now, x.at)} · {eventText(x)}
              </Text>
            ) : (
              <Box
                key={i === anchored ? ANCHOR : `e:${i}`}
                flexDirection="column"
              >
                <Box flexDirection="row" gap={1}>
                  {i === anchored && <Text color="warning">▶</Text>}
                  <Text
                    bold
                    color={x.kind === "prompt" ? "suggestion" : "claude"}
                  >
                    {who(x)}
                  </Text>
                  {from !== undefined && (
                    <Text color="suggestion">in {tagList(from)}</Text>
                  )}
                  <Text dimColor>{ago(now, x.at)}</Text>
                  {others.length > 0 && <Text dimColor>also</Text>}
                  {others.map((place) => (
                    <Button
                      key={`also:${i}:${place.question ?? place.thread}`}
                      plain
                      onPress={() =>
                        void select($, place.thread, place.question, x.id)
                      }
                    >
                      <Text color="suggestion">
                        [[{place.question ?? place.thread}]]
                      </Text>
                    </Button>
                  ))}
                  {x.uuid !== undefined && (
                    <Button
                      key={`go:${t.id}:${i}`}
                      plain
                      dimColor
                      onPress={() =>
                        void $.ui.scroll({
                          to: { requestId: x.uuid as string },
                          block: "start",
                        })
                      }
                    >
                      → transcript
                    </Button>
                  )}
                </Box>
                {from !== undefined ? (
                  <Box paddingLeft={2}>
                    <Markdown text={x.text} />
                  </Box>
                ) : (
                  <Markdown text={x.text} />
                )}
              </Box>
            ),
          ];
        })}
        {pending.map((x) => (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text bold dimColor>
                You
              </Text>
              <Text dimColor>{ago(now, x.at)} · not seen by Claude yet</Text>
            </Box>
            <Text dimColor>{x.text}</Text>
          </Box>
        ))}
      </Box>
      {questions.length > 0 && (
        <Box flexDirection="column" gap={1}>
          {sq?.sent !== undefined ? (
            <Text dimColor>
              You replied; waiting on Claude to settle or revise it
            </Text>
          ) : (
            <Text bold color="warning">
              Waiting on you
            </Text>
          )}
          {questions.map((q) =>
            questionCard(
              $,
              ui,
              q,
              ds[q.id],
              "pane",
              sq !== undefined,
              v.noteFor,
            ),
          )}
          {drafted > 0 && (
            <Button
              key="send"
              variant="primary"
              label={`Send ${drafted} answer${drafted === 1 ? "" : "s"}`}
              onPress={() => void sendAnswers($, t.id)}
            />
          )}
        </Box>
      )}
    </Box>
  );
  // The field comes first in the tree and draws last, at the foot: the engine keeps a pane's focus
  // by its place among the focusable elements, so a message or card filed above the field must
  // not move that place. The ring wraps, so Tab still walks the screen's order.
  if (!docked)
    return (
      <Box flexDirection="column-reverse" gap={1}>
        {field}
        {content}
      </Box>
    );
  return (
    <Box flexDirection="column-reverse" height={bodyRows} flexShrink={0}>
      <Box flexDirection="column" flexShrink={0}>
        <Text dimColor>
          {lift > 0
            ? `─ ▾ ${lift} more rows `.padEnd(cols, "─")
            : "─".repeat(cols)}
        </Text>
        {field}
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {head}
        <Box flexShrink={0}>
          <Text dimColor>{"─".repeat(cols)}</Text>
        </Box>
        <Box
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          overflow="hidden"
          justifyContent={details ? "flex-start" : "flex-end"}
        >
          {content}
        </Box>
      </Box>
    </Box>
  );
}

// The question a settled question's event is about, while it still stands as that event says.
const answeredOf = (b: Book, x: Entry) => {
  if (x.kind !== "event") return undefined;
  const q = questionOf(b, x.question);
  return q !== undefined && q.status === x.event ? q : undefined;
};

// A settled question's event draws as the question, its picks marked, with the words beside them:
// answered in green, retracted in gray with the reason and whatever the user had sent. Its id opens
// its subthread, unless the card is drawn there.
function answeredCard(
  $: EngineInterface,
  ui: Ui,
  q: Question,
  x: Entry,
  n: string,
  now: number,
  inSubthread: boolean,
) {
  const { Box, Markdown, Text } = ui;
  const isRetracted = q.status === "retracted";
  const shape = isRetracted
    ? {
        picks: q.sent?.picks ?? [],
        ...(q.sent?.note === undefined ? {} : { note: q.sent.note }),
      }
    : answerShape(q);
  const replied =
    isRetracted && q.sent !== undefined && q.sent.picks === undefined
      ? q.sent.text
      : undefined;
  const options = optionsOf(q);
  const title = cardTitle(
    ui,
    q,
    `sub:${q.id}:${n}`,
    inSubthread ? undefined : () => void select($, q.thread, q.id),
    isRetracted
      ? { text: "Retracted", dim: true, ago: ago(now, x.at) }
      : { text: "Answered", color: "success", ago: ago(now, x.at) },
  );
  return (
    <Box
      key={`answered:${n}`}
      flexDirection="column"
      borderStyle="round"
      borderDimColor
      paddingX={1}
    >
      {title}
      <Markdown text={q.text} />
      {options.map((o) => {
        const isPicked = shape.picks.includes(o.label);
        return (
          <Text dimColor={!isPicked} bold={isPicked}>
            {markOf(q, isPicked)} {o.label}
            {o.recommended ? " (recommended)" : ""}
          </Text>
        );
      })}
      {!isRetracted &&
        q.multiSelect &&
        shape.picks.length === 0 &&
        !("answer" in shape && shape.answer) && (
          <Text dimColor>None checked.</Text>
        )}
      {shape.note && <Text>Note: {shape.note}</Text>}
      {replied && <Markdown text={`**You replied:** ${replied}`} />}
      {"answer" in shape && shape.answer && (
        <Markdown text={`**Answer:** ${shape.answer}`} />
      )}
      {isRetracted && q.resolution && (
        <Text dimColor>Retracted: {q.resolution}</Text>
      )}
    </Box>
  );
}

// The head of the thread view, pinned at the top when docked: Back and Forward, the way up, the title, the line under
// it, the status, and the summary, cut to its first rows when long, with Details to show it whole.
function threadHead(
  $: EngineInterface,
  ui: Ui,
  v: View,
  t: Thread,
  sq: Question | undefined,
  now: number,
  colorOf: (verb: string) => string,
  brief: string,
  long: boolean,
  details: boolean,
  split: boolean,
) {
  const { Box, Button, Markdown, Text } = ui;
  // Below the list, a press on the open row there closes the view, so the head leads only up to the
  // subthread's thread.
  const home = split ? (
    []
  ) : (
    <Button key="home" plain onPress={() => void select($, null)}>
      ‹ All threads
    </Button>
  );
  return (
    <Box flexDirection="column" gap={1} flexShrink={0}>
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          {travelButtons($, ui, v)}
          {sq === undefined
            ? home
            : [
                home,
                <Button key="back" plain onPress={() => void select($, t.id)}>
                  ‹ [[{t.id}]]
                </Button>,
              ]}
        </Box>
        <Text bold>{t.title}</Text>
        <Text dimColor>
          {sq === undefined
            ? `[[${t.id}]] · ${t.status} · ${ago(now, t.updatedAt)}`
            : `${sq.id} in [[${t.id}]] · ${sq.status} · asked ${ago(now, sq.askedAt)}`}
        </Text>
        {sq === undefined && stateOf(t) && (
          <Text>
            <Text bold color="warning">
              Status:
            </Text>{" "}
            {statusText(ui, stateOf(t), "head", colorOf)}
          </Text>
        )}
      </Box>
      <Box flexDirection="column">
        {details || sq !== undefined ? null : t.summary !== "" ? (
          <Markdown text={brief} />
        ) : (
          <Text dimColor>No summary yet.</Text>
        )}
        {long && (
          <Button
            key="details"
            plain
            dimColor
            onPress={() =>
              void update($, paneView, (p) => ({
                ...p,
                details: !details,
                toUnread: false,
                // Opened, the whole summary shows from its top; closed, the history from its latest.
                lift: details ? 0 : Number.MAX_SAFE_INTEGER,
              }))
            }
          >
            {details ? "▾ hide details" : "▸ details"}
          </Button>
        )}
      </Box>
    </Box>
  );
}

export const register: Register = (on, options) => {
  // The band above the prompt shows unless the user turns it off: off, it draws nothing.
  const showsBand = options.band !== false;
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    await restore($);
    $.clock.every(AGE_TICK, () => void update($, tick, (n) => n + 1));
    const object = (
      properties: Record<string, unknown>,
      required: string[],
    ) => ({
      type: "object",
      properties,
      required,
    });
    // The model's tools and the command, registered together: each is its own dispatch.
    await Promise.all([
      $.tool.register({
        name: "thread",
        description: THREAD_DESCRIPTION,
        isDeferred: false,
        inputSchema: object(
          {
            id: {
              type: "string",
              description: "Short kebab-case id, such as parser-errors.",
            },
            title: {
              type: "string",
              description: "What the thread is about, in a few words.",
            },
            summary: {
              type: "string",
              description:
                "What the thread is: what it is about or for, and why, in a few sentences a reader coming back cold can follow. Not where it stands; that is status.",
            },
            status: {
              type: "string",
              description:
                STATUS_RULE +
                " The list shows it, so update it whenever the work moves on, in place of a progress message; a change is not unread.",
            },
            close: {
              type: "string",
              description: "The outcome the thread closes with.",
            },
            reopen: {
              type: "boolean",
              description: "Open a closed thread again.",
            },
          },
          ["id"],
        ),
      }),
      $.tool.register({
        name: "ask",
        description: ASK_DESCRIPTION,
        isDeferred: false,
        inputSchema: object(
          {
            thread: {
              type: "string",
              description: "The id of the thread the question belongs to.",
            },
            question: {
              type: "string",
              description: "The question, in one or two sentences.",
            },
            context: {
              type: "string",
              description: "Markdown: what the user needs to answer it cold.",
            },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: {
                    type: "string",
                    description: "The choice, in 1-5 words.",
                  },
                  description: {
                    type: "string",
                    description: "What it means or leads to.",
                  },
                  preview: {
                    type: "string",
                    description:
                      "Optional Markdown shown while it is picked: a code sketch, a mockup, a diff.",
                  },
                  recommended: {
                    type: "boolean",
                    description:
                      "True on the option you recommend: one per choice, unless you truly have no view.",
                  },
                },
                required: ["label"],
              },
              description: "The choices, when the answer is a choice: 2-6.",
            },
            kind: {
              type: "string",
              enum: ["choice", "checklist"],
              description:
                "choice: the user picks one option (the default). checklist: the user checks any of them.",
            },
            revise: {
              type: "string",
              description:
                "The id of an open question to replace in place, keeping its id, once you clarified it: give the whole question again as it should now read.",
            },
          },
          ["thread", "question"],
        ),
      }),
      $.tool.register({
        name: "settle",
        description: SETTLE_DESCRIPTION,
        isDeferred: false,
        inputSchema: object(
          {
            question: {
              type: "string",
              description: "The question's id, such as q3.",
            },
            answer: {
              type: "string",
              description:
                "The user's answer, only when it answers what the question asked.",
            },
            retract: {
              type: "string",
              description:
                "Why the question no longer needs an answer: it is moot, or the user tabled, declined or deferred it (their words).",
            },
          },
          ["question"],
        ),
      }),
      $.tool.register({
        name: "file",
        description: FILE_DESCRIPTION,
        isDeferred: false,
        inputSchema: object(
          {
            threads: {
              type: "array",
              items: { type: "string" },
              description: "The ids of the threads the text was about.",
            },
            prompts: {
              type: "boolean",
              description:
                "File the user's messages of this turn, not your untagged text.",
            },
            quote: {
              type: "string",
              description:
                "Words quoted exactly from an earlier message of the user's or section of your reply, from any turn: file that one instead. With prompts: true, only the user's messages count.",
            },
            unfile: {
              type: "boolean",
              description:
                "With quote: take that message out of these threads, where it was filed by mistake, instead of filing it.",
            },
          },
          ["threads"],
        ),
      }),
      $.command.register({
        name: "threads",
        description:
          "Show this session's threads in a pane; give a thread id to open that thread",
        argumentHint: "[thread id]",
      }),
    ]);
    return result;
  });

  on("prompt.compose", async ($, e, next) => {
    const result = await next(e);
    if (e.traits.includes("bare")) return result;
    return {
      sections: [
        ...result.sections,
        { id: SECTION_ID, text: SECTION, scope: "session" as const },
      ],
    };
  });

  on("command.run", { command: "threads" }, async ($, e) => {
    const id = e.args.trim().replace(/^\[\[|\]\]$/g, "");
    const b = await read($, book);
    if (id !== "" && threadOf(b, id) === undefined)
      return { text: `No thread [[${id}]] in this session.` };
    const opened = await openPane($, id === "" ? null : id);
    return {
      text: opened.isPlaced
        ? "Threads pane opened."
        : `Threads pane not shown: ${opened.reason}.`,
    };
  });

  on("tool.call", { tool: TOOL.thread }, async ($, e) => {
    const result = await modelTool($, e, (x, b, now) =>
      changeThread(
        b,
        {
          id: str(x.id) ?? "",
          title: str(x.title),
          summary: str(x.summary),
          state: str(x.status),
          close: str(x.close),
          reopen: x.reopen === true,
        },
        now,
      ),
    );
    await keepClosedInView($, str((e as Record<string, unknown>).id));
    return result;
  }).catch(failed);

  // The pane is left as the user left it: the question draws in the transcript, and in the band when
  // it is on.
  on("tool.call", { tool: TOOL.ask }, async ($, e) =>
    modelTool($, e, (x, b, now) =>
      ask(
        b,
        {
          thread: str(x.thread) ?? "",
          question: str(x.question) ?? "",
          context: str(x.context),
          options: Array.isArray(x.options) ? x.options : undefined,
          kind: str(x.kind),
          revise: str(x.revise),
        },
        now,
      ),
    ),
  ).catch(failed);

  on("tool.call", { tool: TOOL.settle }, async ($, e) =>
    modelTool($, e, (x, b, now) =>
      settle(
        b,
        {
          question: str(x.question) ?? "",
          answer: str(x.answer),
          retract: str(x.retract),
        },
        now,
      ),
    ),
  ).catch(failed);

  on("tool.call", { tool: TOOL.file }, async ($, e) =>
    modelTool($, e, (x, b, now) => {
      const quote = str(x.quote);
      const ids = strings(x.threads) ?? [];
      if (x.unfile !== true)
        return fileUntagged(b, ids, now, x.prompts === true, quote);
      return quote === undefined
        ? {
            book: b,
            isError: true,
            message: "To unfile, give quote: words from the message.",
          }
        : unfile(b, ids, quote, now, x.prompts === true);
    }),
  ).catch(failed);

  // AskUserQuestion stays out of the model's way: listed behind ToolSearch, its description says to ask
  // with mcp__threads__ask, and a call in the main session is refused with the same words.
  on("tool.describe", { tool: "AskUserQuestion" }, async ($, e, next) => {
    await next(e);
    return { description: ASK_REFUSED, isDeferred: true };
  }).catch(($, e, next) => next(e));

  on("tool.call", { tool: "AskUserQuestion" }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e);
    return { deny: ASK_REFUSED };
  }).catch(($, e, next) => next(e));

  on("prompt.submit", async ($, e0, next) => {
    if (e0.command !== undefined || e0.isMeta) return next(e0);
    const [b, ds, out] = await Promise.all([
      read($, book),
      read($, drafts),
      read($, outbox),
    ]);
    // An answer typed at the prompt takes the picks still drafted on its question's card.
    let e = e0;
    // A subthread's field sends the person's own words, which take none of the picks on the card.
    const isOwnWords = out.some(
      (x) => x.kind === "subthread" && x.text === e0.text.trim(),
    );
    if (isPersons(e0.origin) && !isOwnWords) {
      const joined = joinPicks(b, e0.text, ds);
      if (joined.used.length > 0) e = { ...e0, text: joined.text };
      // The drafts it sent, and those whose answer was started in the prompt, are done with.
      const done = new Set([
        ...joined.used,
        ...answersIn(b, e0.text).filter((id) => ds[id]?.inPrompt),
      ]);
      if (done.size > 0)
        await update($, drafts, (all) =>
          Object.fromEntries(
            Object.entries(all).filter(([id]) => !done.has(id)),
          ),
        );
    }
    // A message typed over a running turn joins it as an attachment row, which holds the text only
    // inside the engine's rendering: note the text, to know the row when it comes.
    if (e.turnId !== undefined && isPersons(e.origin))
      await change($, (b) => noteTyped(b, e.text));
    return next({
      ...e,
      context: [
        ...(e.context ?? []),
        promptContext(b, e.text, isPersons(e.origin), awaited(out)),
      ],
    });
  }).catch(($, e, next) => next(e));

  on("session.end", async ($, e, next) => {
    await save($);
    keeping.sessionId = undefined;
    return next(e);
  }).catch(($, e, next) => next(e));

  on("session.append", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId !== undefined) return result;
    // The row is stored by now: a failure here costs the book this row, never the row itself.
    try {
      await recordRow($, e);
    } catch (error) {
      $.ui.log(
        `threads: row ${e.uuid} (${e.door}) is missing from the threads: ${String(error)}`,
        { to: "debug" },
      );
    }
    return result;
  }).catch(($, e, next) => next(e));

  on("classic.Stop", async ($, e, next) => {
    const result = await next(e);
    await save($).catch(() => undefined);
    if (result.block !== undefined || e.stop_hook_active) return result;
    const pending = awaited(await read($, outbox));
    const problem = await read($, book).then(
      (b) => stopProblems(b, pending),
      () => undefined,
    );
    return problem === undefined ? result : { ...result, block: problem };
  }).catch(($, e, next) => next(e));

  // In the transcript, each tag line of a reply draws as a marker naming its threads, and below a reply
  // the threads hold, a mark per thread that the user presses to mark its sections read, or unread again.
  on("ui.render", { component: "AssistantMessage" }, async ($, e, next) => {
    const text = e.props.text;
    const shown = displayText(text);
    // A reply with tag lines draws its text here, the tags as links to the section in each thread; a
    // summary of a reply keeps the engine's drawing, which marks it so, with the tags as plain markers.
    const b0 = await read($, book);
    // The threads whose sections of the reply are unread: marked on their tags, or, for one the reply
    // names by no tag (or a summary's), in a row below it.
    const unread = (
      (await read($, replyThreads)).get(e.requestId) ?? []
    ).filter((x) => !x.isRead);
    const linked = linkTags(text, b0, new Set(unread.map((x) => x.id)));
    // A reply that names a thread or question in its prose draws its text here too, each reference a
    // link that opens it.
    const isOwn =
      e.props.isSummary !== true &&
      (shown !== text || Object.keys(linked.refs).length > 0);
    const row = !isOwn
      ? await next(
          shown === text ? e : { ...e, props: { ...e.props, text: shown } },
        )
      : (() => {
          const { Box, Markdown, Text } = $.ui.resolve(e);
          return (
            <Box flexDirection="row">
              <Box width={2} flexShrink={0}>
                <Text>{e.props.isFirstOfReply ? BULLET : ""}</Text>
              </Box>
              <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                <Markdown
                  key="tags"
                  text={linked.text}
                  pressableLinks={[
                    ...Object.keys(linked.links),
                    ...Object.keys(linked.marks),
                    ...Object.keys(linked.refs),
                  ]}
                  onLinkPress={(link) => {
                    const ref = linked.refs[link.href];
                    if (ref !== undefined) {
                      void openRef($, ref);
                      return;
                    }
                    const mark = linked.marks[link.href];
                    if (mark !== undefined) {
                      void change($, (b) =>
                        markRow(b, e.requestId, mark, true),
                      );
                      return;
                    }
                    const to = linked.links[link.href];
                    if (to === undefined) return;
                    void (async () => {
                      const target = sectionTarget(
                        await read($, book),
                        e.requestId,
                        text,
                        to.section,
                        to.id,
                      );
                      if (target === undefined) return;
                      if (target.anchor === undefined) {
                        await select($, target.thread, target.question);
                        await $.ui.open({ id: PANE, title: TITLE });
                      } else
                        await jumpTo(
                          $,
                          target.thread,
                          target.question,
                          target.anchor,
                        );
                    })();
                  }}
                />
              </Box>
            </Box>
          );
        })();
    // A mark per thread whose sections of the reply are unread and have no tag drawn to mark; pressed,
    // they are read and it goes.
    const below = unread.filter((x) => !isOwn || !linked.tagged.includes(x.id));
    if (below.length === 0) return row;
    const { Box, Button, Text } = $.ui.resolve(e);
    return (
      <Box flexDirection="column">
        {row}
        <Box flexDirection="row" justifyContent="flex-end" gap={2}>
          <Text dimColor>unread:</Text>
          {below.map(({ id }) => (
            <Button
              key={`read:${id}`}
              plain
              onPress={() =>
                void change($, (b) => markRow(b, e.requestId, id, true))
              }
            >
              ○ {id}
            </Button>
          ))}
        </Box>
      </Box>
    );
  });

  // The transcript draws nothing for a threads call that went through: the
  // tagged reply and the pane show what it did. A failed call keeps its row, and
  // the full transcript (ctrl+o) shows every call.
  const quiet = (p: {
    tool: string;
    isErrored: boolean;
    isInterrupted?: boolean;
    isExpanded?: boolean;
  }) =>
    OWN_TOOLS.has(p.tool) &&
    !p.isErrored &&
    p.isInterrupted !== true &&
    p.isExpanded !== true;

  // An ask that went through draws its question where Claude asked it, to answer there as in the pane:
  // open, the card with its options and field; settled, a line saying how.
  on("ui.render", { component: "ToolUse" }, async ($, e, next) => {
    if (!quiet(e.props)) return next(e);
    const ui = $.ui.resolve(e);
    const { Box, Button, Text } = ui;
    // The question by the id its result names, or else the latest one asked with the call's words.
    const q = await (async () => {
      if (e.props.tool !== TOOL.ask) return undefined;
      const b = await read($, book);
      const id = /(?:Asked|Revised) (q\d+) in/.exec(
        JSON.stringify(e.props.output ?? ""),
      )?.[1];
      const input = (e.props.input ?? {}) as Record<string, unknown>;
      return id !== undefined
        ? questionOf(b, id)
        : b.questions.findLast(
            (q) => q.thread === input.thread && q.text === input.question,
          );
    })();
    if (q === undefined) return <Box />;
    // The row of an earlier revision points down to the latest, which draws the question.
    const revision = Number(
      /\(revision (\d+)\)/.exec(JSON.stringify(e.props.output ?? ""))?.[1] ?? 0,
    );
    const where = <Text dimColor> in [[{q.thread}]]</Text>;
    if (q.status !== "open")
      return (
        <Box flexDirection="row">
          <Text dimColor>
            {q.status === "answered" ? "✓" : "✗"} {q.id}
          </Text>
          {where}
          <Text dimColor>
            {" "}
            {q.status}: {q.resolution ?? ""}
          </Text>
        </Box>
      );
    if (revision !== (q.revision ?? 0))
      return (
        <Box flexDirection="row">
          <Text dimColor>↓ {q.id}</Text>
          {where}
          <Text dimColor> was revised below</Text>
        </Box>
      );
    if (q.sent !== undefined)
      return (
        <Box flexDirection="row">
          <Text dimColor>↻ {q.id}</Text>
          {where}
          <Text dimColor>
            {" "}
            you replied: {q.sent.text} · Claude has not settled it yet
          </Text>
        </Box>
      );
    const ds = await read($, drafts);
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Box flexDirection="row">
          <Text color="warning">? Waiting on you</Text>
          {where}
        </Box>
        {questionCard($, ui, q, ds[q.id], "transcript")}
        {ds[q.id]?.inPrompt ? (
          <Text dimColor>
            Send it from the prompt: what is picked here when you send goes with
            it.
          </Text>
        ) : (
          answerOf(q, ds[q.id]) !== undefined && (
            <Box>
              <Button
                key={`send:${q.id}`}
                variant="primary"
                label="Send answer"
                onPress={() => void sendAnswers($, q.thread)}
              />
            </Box>
          )
        )}
      </Box>
    );
  });

  on("ui.render", { component: "ToolResult" }, async ($, e, next) => {
    if (!quiet(e.props)) return next(e);
    const { Box } = $.ui.resolve(e);
    return <Box />;
  });

  // The band names the threads waiting on the user, with their questions, and the threads they have not
  // read. Main is left out of the unread, since every reply lands there, and so is the thread the pane
  // has open.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (!showsBand || e.props.hasSurvey) return next(e);
    const b = await read($, book);
    const v = await read($, view);
    const waiting = waitingOn(b);
    const byThread = new Map<string, Question[]>();
    for (const q of waiting)
      byThread.set(q.thread, [...(byThread.get(q.thread) ?? []), q]);
    const isNew = (t: Thread) =>
      t.status === "open" &&
      t.id !== "main" &&
      t.id !== v.selected &&
      unread(b, t) > 0;
    const fresh = new Set(
      ordered(b)
        .filter(isNew)
        .map((t) => t.id),
    );
    for (const id of fresh) if (!byThread.has(id)) byThread.set(id, []);
    if (byThread.size === 0) return next(e);
    const { Box, Button, Text } = $.ui.resolve(e);
    const folded = v.bandFolded === true;
    const cols = e.props.bodyColumns;
    // How many questions of a thread wait on the user, as the pane's list counts them.
    const ids = (qs: Question[]) => (qs.length > 0 ? `?${qs.length}` : "");
    // A thread's marks after its id: its count of questions waiting, then a dot when unread.
    const marks = (id: string, qs: Question[]) =>
      [ids(qs), fresh.has(id) ? "●" : ""].filter((x) => x !== "").join(" ");
    const markText = (id: string, qs: Question[]) => [
      qs.length > 0 && (
        <Text key="q" dimColor>
          {" "}
          {ids(qs)}
        </Text>
      ),
      fresh.has(id) && (
        <Text key="new" color="suggestion">
          {" ●"}
        </Text>
      ),
    ];
    const counts = [
      waiting.length > 0 &&
        `${waiting.length} question${waiting.length === 1 ? "" : "s"} waiting on you`,
      fresh.size > 0 && `${fresh.size} unread`,
    ]
      .filter((x): x is string => typeof x === "string")
      .join(" · ");
    const icon =
      waiting.length > 0 ? (
        <Text color="warning">? </Text>
      ) : (
        <Text color="suggestion">● </Text>
      );
    // The toggle sits at the far right of the band's first row in both layouts, after a gap that takes
    // what the row leaves, so folding and unfolding it reads as one button that stays in place.
    const gap = <Box key="band:gap" flexGrow={1} minWidth={1} />;
    const toggle = (
      <Button
        key="band:fold"
        plain
        dimColor
        onPress={() =>
          void update($, view, (v) => ({ ...v, bandFolded: !folded }))
        }
      >
        {folded ? "▸ list" : "▾ one line"}
      </Button>
    );
    const open = (id: string, label: string) => (
      <Button key={`band:${id}`} plain onPress={() => void openPane($, id)}>
        {label}
      </Button>
    );

    if (folded) {
      // One line: "? Waiting on you  parser q2 · docs q7 q8 ● · plan ●  +2 more  ▸ list",
      // with as many threads as fit the width.
      const label = waiting.length > 0 ? "Waiting on you " : "Unread ";
      const more = (n: number) => `  +${n} more`;
      let width = 2 + label.length + "  ▸ list".length;
      const shown: [string, Question[]][] = [];
      for (const [id, qs] of byThread) {
        const m = marks(id, qs);
        const w =
          (shown.length > 0 ? 3 : 0) + id.length + (m ? 1 + m.length : 0);
        const left = byThread.size - shown.length - 1;
        const reserve = left > 0 ? more(left).length : 0;
        if (shown.length > 0 && width + w + reserve > cols) break;
        shown.push([id, qs]);
        width += w;
      }
      const hidden = byThread.size - shown.length;
      return (
        <Box flexDirection="row">
          {icon}
          <Text dimColor>{label}</Text>
          {shown.map(([id, qs], i) => (
            <Box key={`band:row:${id}`} flexDirection="row">
              {i > 0 && <Text dimColor> · </Text>}
              {open(id, id)}
              {markText(id, qs)}
            </Box>
          ))}
          {hidden > 0 && <Text dimColor>{more(hidden)}</Text>}
          {gap}
          {toggle}
        </Box>
      );
    }

    // A list: a header row, then a bullet per thread with its marks and its first question, or its
    // title when none waits, as many as the band's rows hold.
    const room = Math.max(1, e.props.maxRows - 1);
    const all = [...byThread];
    const shown = all.length > room ? all.slice(0, room - 1) : all;
    const hidden = all.length - shown.length;
    // Columns, as the pane's list has them: the questions waiting, a dot when unread, the thread's id,
    // and its first question or title in what the others leave.
    const idW = Math.min(24, Math.max(...shown.map(([id]) => id.length)));
    const qW = Math.min(
      16,
      Math.max(0, ...shown.map(([, qs]) => ids(qs).length)),
    );
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Box flexDirection="row">
            {icon}
            <Text dimColor>{counts}</Text>
          </Box>
          {gap}
          {toggle}
        </Box>
        {shown.map(([id, qs]) => {
          const textW = Math.max(
            0,
            cols - 2 - (qW > 0 ? qW + 1 : 0) - 2 - idW - 2,
          );
          const text =
            qs.length > 0 ? qs[0].text : (threadOf(b, id)?.title ?? "");
          return (
            <Box key={`band:row:${id}`} flexDirection="row">
              <Text>{"  "}</Text>
              {qW > 0 && <Text color="warning">{`${fit(ids(qs), qW)} `}</Text>}
              <Text color="suggestion">{fresh.has(id) ? "● " : "  "}</Text>
              {open(id, fit(id, idW))}
              <Text>{"  "}</Text>
              <Text dimColor={qs.length === 0}>
                {fit(text.split("\n")[0], textW).trimEnd()}
              </Text>
            </Box>
          );
        })}
        {hidden > 0 && <Text dimColor>{`    +${hidden} more`}</Text>}
      </Box>
    );
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e);
    const [b, v, now] = await Promise.all([
      read($, book),
      read($, view),
      $.clock.now(),
    ]);
    const t0 = v.selected === null ? undefined : threadOf(b, v.selected);
    // Each verb in use keeps the slot the book gave it; a book without
    // `verbSlots` takes them fresh.
    const colorOf = verbColors(verbsOf(b), b.verbSlots);
    const bodyRows = e.props.scroll.bodyRows;
    layout.docked = e.props.placement === "dock";
    // Inline, the pane shows the list or a thread, and the engine scrolls it.
    if (!layout.docked)
      return t0 === undefined
        ? listView($, e, ui, b, v, now, colorOf)
        : threadView($, e, ui, b, v, t0, now, colorOf, bodyRows);
    // Docked, the list alone fills the pane under its pinned titles.
    if (t0 === undefined) {
      layout.listBottom = Number.MAX_SAFE_INTEGER;
      return listView($, e, ui, b, v, now, colorOf, {
        rows: bodyRows - 2,
        split: false,
      });
    }
    // Too short to hold both, the pane shows the open thread alone.
    if (bodyRows < 4 + MIN_VIEW_ROWS) {
      layout.listBottom = 0;
      return threadView($, e, ui, b, v, t0, now, colorOf, bodyRows);
    }
    // With a thread open, the list sits above its view, the divider between them: drag it to give
    // the list fewer rows or more, or press its ● to size the list automatically again.
    const { Box, Button, Text } = ui;
    // A surface with no Client draws the rule, and keeps the ● button.
    const Client = "Client" in ui ? ui.Client : undefined;
    const sp = await read($, split);
    const list = await listView($, e, ui, b, v, now, colorOf, {
      rows: listRowsFor(sp, bodyRows),
      split: true,
    });
    const listRows = listWin.rows;
    layout.listBottom = 2 + listRows + 1;
    layout.maxListRows = Math.max(
      1,
      Math.min(bodyRows - 3 - MIN_VIEW_ROWS, listWin.lines),
    );
    const cols = e.props.bodyColumns;
    const above = listWin.lift;
    const below = listWin.lines - listWin.lift - listRows;
    const label = above + below > 0 ? ` ${above} above · ${below} below ` : "";
    const divider = (
      <Box key="split" flexDirection="row" flexShrink={0} height={1}>
        {Client === undefined ? (
          <Box flexGrow={1} height={1} overflow="hidden">
            <Text>{`══${label}`.padEnd(cols - 4, "═")}</Text>
          </Box>
        ) : (
          <Client
            key="divider"
            module="./divider.tsx"
            props={{ listRows, columns: cols - 4, label }}
            height={1}
            flexGrow={1}
          />
        )}
        <Text> </Text>
        {/* Like a window's zoom button: back to the size the list takes by itself. Dim while it has it. */}
        <Button
          key="split:auto"
          label="Size the list automatically"
          plain
          dimColor={sp.listRows === undefined}
          onPress={() => void autoSize($)}
        >
          <Text color="success">●</Text>
        </Button>
      </Box>
    );
    const thread = await threadView(
      $,
      e,
      ui,
      b,
      v,
      t0,
      now,
      colorOf,
      bodyRows - layout.listBottom,
      true,
    );
    // The thread's view comes first in the tree and draws last, at the foot, so that its field stays
    // the pane's first focusable, as the view alone keeps it.
    return (
      <Box flexDirection="column-reverse" height={bodyRows}>
        {thread}
        {divider}
        {list}
      </Box>
    );
  });

  // Docked, the pane scrolls its own content: the list's window when the wheel is over the list or the
  // focus ring is on it, or the list alone shows; else the thread view, lifted or lowered.
  on(
    "ui.scroll",
    { component: "Pane", requestId: PANE },
    async ($, e, next) => {
      const [v, p] = await Promise.all([read($, view), read($, paneView)]);
      if (!layout.docked) {
        if (v.selected === null || !foot.pinned) return next(e);
      } else if (
        v.selected === null ||
        (e.origin.kind === "person" &&
          (e.pointer !== undefined
            ? e.pointer.row < layout.listBottom
            : focusIn === "list" && layout.listBottom > 0))
      ) {
        const lift = Math.max(0, Math.min(listWin.max, listWin.lift + e.by));
        const sp = await read($, split);
        if (lift !== sp.listLift || sp.listFor !== v.selected)
          await update($, split, (s) => ({
            ...s,
            listLift: lift,
            listFor: v.selected,
          }));
        return {};
      }
      // From where it is drawn: held at the Unread line, the view's own lift is not where it shows.
      const lift = Math.max(0, Math.min(foot.maxLift, foot.lift - e.by));
      if (lift !== (p.lift ?? 0) || p.toUnread === true)
        await update($, paneView, (w) => ({ ...w, lift, toUnread: false }));
      return {};
    },
  ).catch(($, e, next) => next(e));

  // Where the focus ring goes in the pane decides what the scroll keys move.
  on("ui.focus", { component: "Pane", requestId: PANE }, async ($, e, next) => {
    focusIn =
      e.element !== undefined && LIST_KEYS.test(e.element) ? "list" : "view";
    return next(e);
  }).catch(($, e, next) => next(e));

  // The divider's drag: its surface module posts the rows the list would take with the divider under
  // the pointer.
  on("ui.message", { component: "Pane", requestId: PANE }, async ($, e) => {
    const rows = (e.data as { listRows?: unknown } | null)?.listRows;
    if (
      e.element === "divider" &&
      typeof rows === "number" &&
      Number.isFinite(rows)
    )
      await resize($, rows);
    return {};
  }).catch(() => ({}));
};
