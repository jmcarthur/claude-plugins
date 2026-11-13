# Live pane check

An optional check, run by hand, that the threads pane's message field keeps the
keyboard in a live Claude Code session while questions are filed above it. Its
extra checks cover notes, references, the divider and fast typing, by mouse and
keys, against the real engine rather than the unit tests' stand-in.

It needs `tmux` and a working `claude` on the `PATH`. It runs a real Claude Code
session on a small model, so each run spends some of your usage. It writes to
`/tmp/pane-focus-scratch` and to `projects/-tmp-pane-focus-scratch` under the
Claude Code config folder (`$CLAUDE_CONFIG_DIR`, or `~/.claude`), and removes
both when it ends, unless you pass `--keep`. The pane keeps its list size and
the probe session's threads in the plugin's store. A plugin loaded from a folder
has a store of its own, `plugins/store/threads_inline-*.json` under the config
folder, and the run puts those files back as it found them when it ends, unless
you pass `--keep`. An installed threads plugin's store is not touched.

From the repository root:

```
python3 -I threads/tests/live/pane_focus.py [--plugin DIR] [--model MODEL] [--keep] [--notes] [--links] [--split] [--fast]
```

- `--plugin DIR`: the threads plugin folder to load. It defaults to the folder
  that holds this script's `tests/`.
- `--model MODEL`: the model Claude Code runs on, `haiku` by default.
- `--keep`: leave the session running to look at by eye, with
  `tmux -L pane-focus attach`. End it with `tmux -L pane-focus kill-server`, and
  remove the two folders above yourself.

## What it does

- It starts Claude Code in a tmux server of its own (`tmux -L pane-focus`), in
  `/tmp/pane-focus-scratch`.
- It uses project settings only, so no installed plugin loads, an installed
  threads included: only the folder given by `--plugin`.
- It opens thread `probe` in the docked pane and Tabs to the field.
- From the field it sends a message asking Claude to ask five questions under
  `probe`, one every few seconds.
- Meanwhile it types one letter a second into the field, and checks the screen
  after each letter.

A run takes about two minutes.

## Results

- Exit 0, a pass, ends
  `PASS: all N letters reached the field while 5 questions were filed above it`.
  After every letter the field showed `⏎ send` and every letter typed so far,
  and the main prompt was empty.
- Exit 1, a failure, prints `FAIL` on each letter that landed elsewhere.
- Exit 2, inconclusive: too few questions arrived while it typed to tell, or
  `--fast` found no empty field.

## Extra checks

Each of these runs after a pass, in this order. A failure exits 1, and the
checks after it do not run.

- `--notes` works by mouse clicks (SGR escapes through tmux).
  - It presses the last card's ✎, types `hello` and presses Enter, then picks
    the card's `( ) Yes`.
  - It then reopens the note twice, pressing Enter on it unchanged each time.
    Each reopening must show `hello` in the field.
  - The engine keeps a field's text by key and empties it on Enter, so a field
    reopened under a key it already drew opens empty. Only a live run catches
    this.
- `--links` checks references in the transcript.
  - From the field it asks Claude for a reply that names the thread and its
    first question in its prose (`REFLINK see [[probe]] and q1 here.`).
  - From the pane's list it clicks `[[probe]]` in the reply, which must open the
    thread. From the list again it clicks the question's id, which must open its
    subthread.
  - A reference drawn with its escapes showing, or not as a link, fails to be
    found or to open.
  - It then clicks the pane's ← twice, which must show the list and then the
    thread, and → once, which must show the list again. The list counts as shown
    alone while no thread's view is under it.
- `--split` checks the divider, with the thread open under the list.
  - It first presses the divider's round ● button, which sizes the list
    automatically: the list's rows are kept in the plugin's store from run to
    run, so a run can start with another size.
  - It drags the divider up a row by mouse: an SGR press, a motion with the left
    button held, and a release, through tmux. The divider must move up a row.
  - It then presses ● again, which must move the divider back down.
- `--fast` checks fast typing.
  - It Tabs to up to three empty fields. In each it types
    `the quick brown fox jumps` with no delay between keys, then sends as many
    backspaces.
  - It then types a text past twice the field's width.
  - A field passes when it shows the whole short text, then nothing, and then
    the long text's end, wrapped rather than cut with an ellipsis.
  - This catches races that need keys under about 40 ms apart, such as a field
    whose drawn value lags its typing.
