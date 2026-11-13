# threads reference

How threads works, in detail. For what it does and how to start, see the
[README](../README.md).

- [Why](#why)
- [Parts of the pane](#parts-of-the-pane)
- [How it works](#how-it-works)
- [Using it](#using-it)
- [State](#state)
- [Known limits](#known-limits)

## Why

A long session mixes several lines of thought in one transcript. When you come
back, Claude reminds you that it waits for answers, but the context of each
question is somewhere above, often explained under another topic. Plugins that
keep a list of open questions show the question without its context, and leave
Claude to keep the list current, which it forgets to do.

## Parts of the pane

The rest of this page uses these names. From the top of the docked pane:

- **List:** every thread, in rows. Its **stats line** (counts, and ← → when no
  thread view is below) and **column titles** stay at the top. Each thread has a
  **thread row**; ▸ beside it unfolds a **subthread row** per question. The
  **closed fold**, `▸ n closed`, holds the closed threads you have read.
- **Divider:** the `══ n above · n below ══ ●` rule between the list and the
  thread view, when both show.
- **Thread view:** one thread, or one question's **subthread**. At the top, its
  **head**: ← →, the way back (`‹ [[thread]]` from a subthread), the title, an
  info line, `Status:` and the summary. Below that come the **history** (its
  messages and events), the **question cards** waiting on you, and, at the foot,
  the **field** to message it.

Outside the pane, the **band** is the rows above the prompt box, and the **main
view** is the chat transcript. Inline, or docked and too short for both, the
pane shows the list or the thread view, not both.

## How it works

- **Threads.** A session has a flat set of threads. `main` is the session as a
  whole and is always open.
  - Claude opens a thread for each question or piece of work that can be settled
    on its own.
  - It keeps a summary of what the thread is, and a one-line status of what is
    happening on it now. The status starts with a verb as if after "I am"
    ("Waiting on q3", "Testing the fix"), and never says what is done.
  - It closes the thread with its outcome when it is done.
- **Tags.** Claude starts every reply with a tag line such as `[[parser]]`, and
  writes a new tag line where the reply moves to another thread.
  - A line of several tags files the section under each, so an explanation that
    a question depends on can sit in both threads.
  - An inline `[[id]]` refers to a thread, and a question's id such as `q3` to a
    question.
  - In the transcript each tag line draws as a marker. Each reference in the
    prose (outside code) to a thread or question the session has is a link that
    opens the pane at it.
  - Claude's calls to the threads tools draw nothing there unless one fails;
    ctrl+o still shows them all.
- **History.** A thread's history holds the full text of every reply section
  tagged with it, your messages filed under it, and its events (opened, renamed,
  asked, answered, summary updated, status, closed, reopened).
  - A new summary shows there as it then read, and a new status shows too;
    neither marks the thread unread.
  - A thread's age is that of its latest entry.
  - A message is filed under the threads it opens with: its tags, a question's
    id, or the thread you sent it from in the pane. One with none of these is
    filed under `main` alone.
  - When a message is about other threads as well, Claude files it there too.
    There it shows indented under `in [[parser]]`, naming the threads it was
    sent under.
  - An answered question shows in the history as the question, its picks marked,
    with your note. A retracted one shows the same way under a gray Retracted,
    with the reason.
  - Each entry links back to its transcript row.
  - Only your own messages count as prompts: a background task's notification,
    another session's message or a scheduled prompt is filed nowhere.
- **Questions.** Claude asks every question with the `ask` tool, under a thread,
  with the context needed to answer it cold. A choice comes with options, their
  descriptions and previews.
  - Claude marks the option it recommends **(recommended)**, one per choice, and
    is reminded when it leaves the mark off.
  - A question is free text, a choice (pick one) or a checklist (check any).
  - The question does not block the turn; your answer comes as a later message.
  - In the main view the question draws where Claude asked it, with its options
    as in the pane, and **Send answer** sends it from there.
  - The main view takes no typing, so **✎ Note…** adds a `q1: ` line to the
    prompt box, below anything already there, for your note. From then on the
    answer goes from the prompt alone, and the card hides **Send answer**. What
    you pick on the card until you send joins the note, as
    `q1: SQLite (your note)`.
  - Once Claude settles the question, that spot says how.
  - Once you have answered, whether from the pane, the main view or the prompt
    with `q1: …`, the question leaves **Waiting on you**, the `?n` counts and
    the band (when it is on). It waits on Claude until Claude settles it, and
    the history shows your answer.
  - When your reply asks about the question instead, Claude answers and revises
    the question in place, keeping its id, so that it reads as clarified and
    waits on you again. In the main view, the first spot points down to the
    revision.
  - What Claude waits on you to do yourself comes as a checklist of to-dos.
    Check off the ones done and send, and Claude asks again with what is left
    and anything new.
  - Threads lists AskUserQuestion behind ToolSearch, with a description that
    says to ask with the `ask` tool, and refuses every call to it in the main
    session with the same words.
- **Upkeep.** Each of your prompts carries the open threads and questions for
  Claude.
  - A thread other than `main` is named idle after three prompts with no tag or
    change, so that Claude closes it if its work is done or updates a status
    that no longer holds. An idle thread whose status still holds needs nothing,
    and Claude is told never to write a message in a thread only to say that
    nothing changed.
  - A thread that waits on you, with an open question of its own or one its
    status names, is never idle. Once Claude sets the status of an idle thread,
    it is named again only after a thread closes or a question is settled.
  - A question is flagged stale when its thread sat idle for three prompts after
    other work finished (a thread closed or a question settled), so that Claude
    retracts it if it no longer matters.
  - The prompt asks Claude to settle what your message answers or makes moot.
  - Claude is told to say in a thread's summary what finishes it. When work
    finishes, it is told to check every open thread the work finishes, not only
    the ones the turn is tagged with.
  - A turn is held once at its end when it leaves one of these, so that Claude
    deals with it:
    - Reply text with no tag: Claude files the text.
    - A tag that opened a thread without a title.
    - A reply of yours to a question, neither settled nor revised. A question
      with a reply stops showing as waiting on you, so a reply that asked about
      it instead of answering would otherwise hide it.
    - A thread whose status says it waits on you ("Waiting on the user's look")
      with no open question. Only questions show as waiting on you, so Claude
      asks one or changes the status.

The model's tools serve the main session only: a subagent's or background job's
work belongs to the thread of the reply that started it.

- `mcp__threads__thread`: open, update or close a thread.
- `mcp__threads__ask`: ask a question.
- `mcp__threads__settle`: answer a question, or retract one that is moot or that
  the user tabled. Settling it again the other way corrects a mistake.
- `mcp__threads__file`: file a turn's untagged text, or the user's messages of
  the turn, under threads. Given words quoted from it, it files an earlier
  message or reply section under more threads, in its place in their history.
  With `unfile`, it takes a quoted one out of threads it was filed under by
  mistake.

## Using it

- **Opening the pane.** `/threads` opens the pane beside the chat (the terminal
  docks it in fullscreen from 110 columns); `/threads <id>` opens one thread.
  The pane opens only when you open it: a question shows in the main view, and
  in the band when it is on.
- **Back and Forward.** **←** and **→**, at the top of the list and of a thread,
  go Back and Forward through what the pane showed (the list, a thread, a
  question's subthread), as a browser's do.
  - Going anywhere new, from the pane, the band, or a tag or reference in the
    main view, drops the places ahead.
  - Each is dim, and does nothing, while there is nowhere to go that way.
- **The list's columns.** The list lines its rows up in columns: `?n` for the
  questions waiting on you, beside the toggle that unfolds them, then id, title,
  status and age.
  - The status is cut to fit. Its column is dropped when no thread has one or
    the pane is too narrow. `main` has no status.
  - A `◌` marks a thread holding a message you sent from the pane that has not
    reached Claude yet. It has a column of its own before the status, so the
    verbs stay aligned, or sits in the dot column when the status column is
    dropped.
  - A status's leading verb takes a color hashed from the word, one of 24 (12
    hues at two lightnesses). Verbs in use never share one: a new verb whose
    color is taken moves on to the next free one. A verb keeps its color for as
    long as some thread's status starts with it.
- **Sorting.** Threads keep the order they were opened in until you press a
  column's title. The list then sorts by that column, and pressing it again
  turns the order round.
  - The sort column's title is bold, with ▲ for ascending or ▼ for descending.
  - Age ascends from the newest.
- **Closed threads** fold under a row at the end once you have read them. A
  closed thread with anything unread keeps its row among the open threads, dim,
  and stays there while you read it; it moves into the fold when you leave it. A
  thread closed while you have it open stays in the view, its row above the
  fold, until you leave it. A read closed thread shows in the pane only while
  the fold is open: folding it hides one, and opening one opens the fold.
- **Unread.** A `●` and a bold id and title mark a thread unread: it holds a
  reply or an event you have not seen.
  - Each message is read or unread on its own, and a thread is read when all of
    its messages are.
  - Opening a thread in the pane marks every message in it read, in every other
    thread that holds the same message too.
  - In the main view, a reply's tag reads `● plan` while plan holds its sections
    unread. Pressing the `●` marks them read, and the same section where another
    thread holds it too, and the tag reads `▸ plan` again.
  - A thread the reply files sections under with no tag line drawn (its lead
    text, or a summary row) gets its mark in an `unread:` row below it instead,
    such as `○ plan`.
  - A read reply covers the events before it in its thread.
- **Scrolling the list.** Docked, the list's stats line and column titles stay
  at the top of the pane, and its rows scroll under them: by the wheel over
  them, or the scroll keys while the focus is on the list.
  - With a thread open, the list keeps a window of rows above the thread. The
    window moves to show that thread's row when it opens.
  - The open thread's id is drawn inverted (a subthread's own id when its row is
    unfolded). Pressing that row again closes the thread.
  - The divider between them says how many rows are out of view. Drag it to give
    the list fewer rows or more. The round **●** at its end, like a window's
    zoom button, gives the list back its automatic size: its own rows, up to a
    third of the pane. It is dim while the list has that size. The list's rows
    are kept for every session.
  - Inline, or docked too short for both, the pane shows the list or a thread
    view, and the head's **‹ All threads** goes back to the list.
- **The thread view** shows its head, its history, latest last, the question
  cards waiting on you, and the field to message the thread.
  - It opens at its first message you had not read, under an `─ Unread` line
    that stays while the thread is open, or at the latest when you had read it
    all.
  - Docked, the head stays at the top and the field at the foot, and the history
    and question cards scroll between them.
  - A summary longer than four rows is cut there; **▸ details** shows it whole.
  - What you send from the pane goes out as your own message, opening with the
    thread's tag. It shows dim at the foot of the history, marked not seen by
    Claude yet, until it reaches the session: at once when Claude is idle, or
    when the running turn ends.
  - A message that does not reach the session comes back to the field, or to the
    prompt box when the field holds something else, and a toast says why.
    Interrupting a turn discards what the pane queued behind it, so a message
    sent while Claude was working comes back this way. Answers sent from cards
    are drafted on their cards again.
- **Question cards.** A question works like AskUserQuestion, except that it
  waits in its thread instead of stopping the session.
  - Its options show their descriptions. A choice takes one pick, `( )`, and a
    checklist any number, `[ ]`. The preview of the option you picked shows
    below them.
  - Each card's **✎ Note…** points the pane's one field at the question, for a
    note or an answer of your own, and moves the keyboard there unless the
    prompt holds text. Enter, or ✎ pressed again, keeps what you typed on the
    card and points the field back at the thread. ✎ on a kept note opens the
    field on it to change it.
  - Picks and notes are drafts until you press **Send** (Send 2 answers). It
    sends every drafted answer of the thread as one message, a line per question
    (`q3: SQLite (keep a JSON export)`).
  - A checklist with nothing checked has **Send with none checked**.
  - A sent answer shows under its question until Claude settles it.
- **The pane and the transcript.** **→ transcript** scrolls to a history entry's
  row.
  - The other way, a reply's tag lines in the main view are links (`▸ plan`).
    Each opens the pane at that section in the thread, or in a question's
    subthread, marked `▶`.
  - A reference in a reply's prose, `[[plan]]` or `q3`, opens that thread or the
    question's subthread.
  - A message that other threads or subthreads hold too shows them after its
    time, `also [[other]]`, each a press away from the same message there.
- **The band** above the prompt, unless the `band` setting turns it off, lists
  the threads with questions waiting on you and the open threads you have not
  read.
  - A thread with questions gets a row with how many wait (`?2`) and the first
    one's text. An unread thread is marked `●`, with its title.
  - Its rows are in columns as in the pane's list: `?n`, `●`, thread id, text.
  - `main` never counts as unread there, and neither does the thread the pane
    has open.
  - Pressing a row opens its thread in the pane. **▾ one line** folds the band
    to a single line of thread names and question ids, and **▸ list** unfolds
    it.
- **Answering at the prompt.** To say what a message typed at the prompt
  answers, start it with the thread's tag, `[[parser]] yes, go ahead`, or a
  question's id, `q3: yes`, which names its thread too.
- **Subthreads.** Each question has a subthread within its thread. It holds the
  question's events, your messages that answer it (`q3: …`) or open with
  `[[q3]]`, and the sections Claude tags `[[q3]]` beside the thread's own tag.
  - Claude can file an earlier message there by giving `q3` to
    `mcp__threads__file`.
  - In the list, **▸** by a thread with questions unfolds a row per open
    question, with `?` while it waits on you and `●` while it holds news, and a
    `▸ n settled` row for the rest.
  - In the pane, a question's card opens with a line naming it, with Answered or
    Retracted once it is settled (`q3 ─ Answered · 2m`). Pressing the id opens
    the subthread; in the main view, **▸ q3's subthread** does.
  - A subthread shows the question's card and its history, with a field that
    sends `q3: …` in your own words, apart from the card's picks.
  - **‹ [[thread]]** goes back to its thread, and, where the list is not above
    it, **‹ All threads** to the list.
  - Its messages are its thread's, so reading them in either place reads them in
    both.

## State

A session's threads, with their questions and messages, are kept in the
session's plugin state and in the plugin store under the session id, so
`--resume` brings them back. `/clear` starts a new session with only `main`.

- The store's copy is written at the end of each turn, at the session's end, and
  a few seconds after a change in between.
- A session's threads that nobody touched for 30 days are dropped.
- They stay bounded:
  - Each message is kept once, however many threads hold it.
  - A thread keeps its latest 200 entries, and a closed one its latest 50.
  - A settled question goes once its history stops showing it.
  - A message typed while a turn ran, and never delivered to that turn, is
    dropped a turn later.
- The store is one file for every session, held to 4 MiB. When a session's
  threads do not fit, those of the sessions started longest ago make room.

## Known limits

- The tags are plain text in the replies, so a session without the plugin shows
  them as typed.
- Text Claude only thinks, and never writes as reply text, files nothing. When a
  turn is held for untagged text, the hold quotes that text.
