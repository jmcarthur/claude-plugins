// The contract of the threads plugin's state: the session's book of threads, and what the pane shows.
// Self-contained, as the engine requires; hooks/model.ts imports these.

// A message, kept once in the book whatever holds it: the user's prompt, or a section of Claude's reply.
export type Message = {
  // Its place in the order of all that happened in the session, which is the order of every history
  // that holds it: a message's or an event's id is the book's `nextEntry` when it came.
  id: number;
  kind: "prompt" | "reply";
  text: string;
  at: number;
  // The transcript row it came from, for scrolling to it.
  uuid?: string;
  // The threads that hold it.
  threads: string[];
  // The threads it was sent or written under (main for an untagged message of the user's). In a thread
  // Claude filed it under as well, it shows as from these.
  home: string[];
  // The questions whose subthreads hold it as well as their threads: a section tagged [[q3]], a message
  // answering q3, or one Claude filed under q3.
  sub?: string[];
  // The user has seen it (opened a thread or subthread holding it, or marked its transcript row read),
  // or marked it unread again; absent, they have not.
  read?: boolean;
};

// What happened to a thread, which its history shows as an event. "reopened" is the thread tool's,
// "reopened-by-ask" a question's asked in a closed thread; "note" is an event stored in words that
// name none of these, shown as it was written.
export type EventType =
  | "opened"
  | "reopened"
  | "reopened-by-ask"
  | "renamed"
  | "summary"
  | "status"
  | "closed"
  | "asked"
  | "revised"
  | "answered"
  | "retracted"
  | "note";

// An event of a thread's history, its text drawn from its type and detail.
export type ThreadEvent = {
  // As a message's: its place in the order of all that happened.
  id: number;
  kind: "event";
  event: EventType;
  at: number;
  // What the event says beyond its type: the new title, summary or status, the outcome a thread closed
  // with, the question asked or revised, the answer or the reason a question was retracted, or a
  // note's words. A summary event without one was stored with no summary, and draws without it.
  detail?: string;
  // The question an asked, revised, answered or retracted event is about.
  question?: string;
  // As a message's: the user has seen it, or marked it unread again; absent, they have not.
  read?: boolean;
};

export type Entry = Message | ThreadEvent;

export type Thread = {
  id: string;
  title: string;
  summary: string;
  // One short line: where the thread stands now. Its changes are news; the summary's are not.
  state?: string;
  status: "open" | "closed";
  outcome?: string;
  createdAt: number;
  updatedAt: number;
  // The user prompt count when the thread was last tagged or changed.
  touchedTurn: number;
  // The book's finishedTurn when the thread's status was set while it was idle: it is not idle again
  // until a thread closes or a question is settled after that. A tag clears it.
  heldAt?: number;
  // Opened by a tag, not by the thread tool, so it still needs a title.
  isUntitled?: true;
  // What happened to the thread. Its history is these and the messages it holds, in the order of their
  // ids.
  events: ThreadEvent[];
};

// One choice of a question: its label, what it means, and a Markdown preview shown while it is picked.
export type QuestionOption = {
  label: string;
  description?: string;
  preview?: string;
  // The option Claude recommends: at most one of a choice's, any of a checklist's.
  recommended?: true;
};

export type Question = {
  id: string;
  thread: string;
  text: string;
  context?: string;
  options?: QuestionOption[];
  multiSelect?: true;
  status: "open" | "answered" | "retracted";
  askedAt: number;
  // What the user last sent as the answer from the pane: its text, and the picks and note it was made of.
  sent?: { text: string; at: number; picks?: string[]; note?: string };
  resolution?: string;
  settledAt?: number;
  // How many times Claude revised it in place, after the user asked about it; absent, never.
  revision?: number;
};

// The user's answer to a question while they compose it in the pane: the options picked and a note,
// which is the whole answer when nothing is picked; none marks a checklist sent with nothing checked.
// inPrompt: the user started the answer in the prompt box from the main view, so it goes from there.
export type Draft = {
  picks: string[];
  note: string;
  none?: true;
  inPrompt?: true;
};

// A piece of text with the transcript row it came from.
export type Piece = { text: string; uuid?: string; at: number };

// The turn in progress: its prompt, the threads its replies are filed under now, the threads it touched,
// and the reply text that came before any tag line.
export type Turn = {
  n: number;
  active: string[];
  touched: string[];
  untagged: Piece[];
  prompt?: Piece;
  // Messages the user typed while a turn ran, by their text and the turn's number, until their row
  // joins the turn; past the turn after it, a message that never joined is let go.
  typed?: { text: string; turn: number }[];
  // The user's messages of the turn, by id, which Claude may file under other threads too.
  loose?: number[];
};

export type Book = {
  threads: Thread[];
  // Every message any thread holds, each once, in the order of their ids.
  messages: Message[];
  // The id the next message or event takes.
  nextEntry: number;
  questions: Question[];
  nextQuestion: number;
  turn: Turn;
  // The user prompt count when a thread last closed or a question was last settled: the events that can
  // finish other work, after which a quiet thread may be done.
  finishedTurn?: number;
  // Each status verb in use and its palette slot, by the lowercased verb. A verb keeps its slot while
  // any thread's status starts with it; once none does, it is dropped and may get another on return.
  verbSlots?: Record<string, number>;
  // Set once the book's closed threads were marked read on loading; see closedRead in model.ts.
  closedRead?: true;
};

// A column the thread list can be sorted by.
export type SortKey = "waiting" | "id" | "title" | "status" | "age";

// A place the pane showed: the list (selected null), a thread, or a question's subthread within it.
export type Place = { selected: string | null; question?: string };

// What the pane shows: the list of threads, or one thread with its history.
export type View = {
  selected: string | null;
  showClosed: boolean;
  // A closed thread the user opened while it was unread: its row stays above the closed fold
  // until the view leaves it.
  keptUp?: string;
  // The band draws one line instead of a list.
  bandFolded?: boolean;
  // The first entry in the open thread's history that was unread when the user opened it, by its id,
  // where a divider marks the boundary: an index would move as messages are filed above it.
  unreadFrom?: number;
  // The message the view was opened at, by its id, from its tag in the main view or another thread's
  // history: held at the top, as the divider is, until the person scrolls or sends.
  anchor?: number;
  // The question whose subthread the pane shows, within the selected thread.
  question?: string;
  // The threads whose subthreads the list shows, and those showing their settled ones too.
  expanded?: string[];
  settledShown?: string[];
  // The column the list is sorted by, and whether descending; absent, the order threads were opened in.
  sort?: { by: SortKey; desc: boolean };
  // The question the pane's field writes the note of, pointed there by the question's ✎ button.
  noteFor?: string;
  // Each field target's generation, part of the field's key, by target (a thread or subthread, or
  // `note:q3` for a question's note); absent, 0. A thread's or subthread's moves on when its field
  // sends, so it opens empty; a note's each time the field is pointed at it, so it opens on the kept
  // note. Pointing at a question and back returns to the thread's own key, whose text the engine kept.
  fieldGens?: Record<string, number>;
  // The places the pane showed before this one, latest last, which Back returns to, and those Back
  // left, latest last, which Forward goes to again; a new place drops the forward ones. Absent, none.
  back?: Place[];
  forward?: Place[];
};

// What the open thread's view draws from that nothing but the pane reads, kept apart from View, which
// the band reads too: so a wheel tick, or a key typed, redraws the pane alone.
export type PaneView = {
  // Rows the docked thread view is scrolled up from its latest, above the pinned message field.
  lift?: number;
  // The docked thread view keeps the unread divider, or the message it was opened at, at its top,
  // until the person scrolls or sends.
  toUnread?: boolean;
  // The docked thread view shows its whole summary, scrolling, in place of the history.
  details?: boolean;
  // The key of the field while what is typed in it for a question's note, not entered yet, is not empty:
  // written as it fills or empties, so the pane redraws whether the question can be sent.
  typing?: string;
};

// How the docked pane splits between the list of threads above and the open thread's view below.
export type Split = {
  // The rows the list's window takes above the thread's view, as the person last set them; absent,
  // a third of the pane. Kept in the plugin store too, for every session.
  listRows?: number;
  // The first row the list's window shows, 0 at the top.
  listLift?: number;
  // The thread that was open when the list last scrolled: once another is, the window moves to show
  // its row.
  listFor?: string | null;
};

// A message the pane sent as the person's that the session has not recorded yet: Claude has not seen it.
export type Outgoing = {
  text: string;
  at: number;
  // Where the pane sent it from: a thread's field, a subthread's field (an answer to its question in
  // the person's own words, which takes none of the picks drafted on the question's card), or Send
  // answers (a line per drafted answer, picks joined already).
  kind: "thread" | "subthread" | "answers";
  // The questions it answers, which wait for it to reach Claude.
  questions: string[];
};

declare module "claude-code" {
  interface PluginState {
    threads: {
      book: Shaped<Book>;
      view: Shaped<View>;
      paneView: Shaped<PaneView>;
      split: Shaped<Split>;
      drafts: Shaped<Record<string, Draft>>;
      outbox: Shaped<Outgoing[]>;
      // Counts the pane's age ticks; its value means nothing.
      tick: Shaped<number>;
    };
  }
}
