# Development

This page is for working on the plugins themselves: the checks to run, then
notes per plugin. Each plugin's `docs/reference.md` describes its behavior.

## Checks

Run these before sending a change:

```
sh bin/typecheck
claude plugin test rootcause
claude plugin test runway
claude plugin test threads
claude plugin test tidy
python3 -m unittest discover -s rootcause/tests
python3 -m unittest discover -s runway/tests
python3 -m unittest discover -s tidy/tests
npx prettier --check .
```

- Format with `npx prettier --write .`. The repo's style is Prettier's, set by
  `.prettierrc`; `.prettierignore` leaves out the plugin types that Claude Code
  writes. Run it twice when a file still differs: on some long expressions
  Prettier needs a second pass.
- The type check takes a few seconds and fails on a type error. It runs
  `npx typescript` (nothing is installed globally) against the engine
  declarations that the bundled `plugin-authoring` skill unpacks under
  `${TMPDIR:-/tmp}/claude-<uid>/bundled-skills/`, so the skill must have loaded
  in some session since the last reboot.
- The `.claude-plugin/types` folder that each `tsconfig.json` extends exists
  only after an interactive session loads the plugin, so `tsc -p rootcause` does
  not work on a fresh clone. `claude plugin test` does not report all type
  errors.
- Run `claude plugin validate <plugin>` at release only: it is slow and does not
  check types.
- Change the version in `<plugin>/.claude-plugin/plugin.json` with each release
  that changes the plugin, so that installed copies update.

## Constraints for scripts and command text

- A plugin install may drop a script's exec bit, so hooks call a script through
  its interpreter (`python3 -I`, `sh`). The plugin's session start sets the exec
  bit on `rootcause/bin/rootcause`, which the agent runs bare. Repo scripts such
  as `bin/typecheck` run through `sh`.
- Claude Code asks for approval on a Bash command with a `{` followed by a quote
  before the next `}`, even under an allow rule. Text that tells the session to
  give a command structured input uses `key: value` lines, not JSON.

## rootcause

- `claude plugin test rootcause` runs the hooks module's tests. It runs only
  `*.test.ts` files, and a test file can import nothing but its own files and
  `claude-code`, so it cannot run the command's tests. Run those with
  `python3 -m unittest discover -s rootcause/tests`.
- The command check above ("Contains brace with quote character", Claude Code
  2.1.302) shapes the agent's prompt: a test checks every example in it against
  that pattern (`BRACE_WITH_QUOTE` in `rootcause/tests/test_rootcause.py`).
  Checked against 2.1.302 with
  `claude -p --permission-mode default --allowedTools 'Bash(rootcause:*)'`: the
  JSON heredoc was refused, and the text form of `start`, `answer` and
  `conclude` ran.
- To measure use, count the analysis files by status:

  ```
  python3 -c 'import collections, glob, json, os; print(collections.Counter(json.load(open(f))["status"] for f in glob.glob(os.path.expanduser("~/.claude/rootcause/analyses/*.json"))))'
  ```

## runway and tidy

- Each ships alone, so each has its own copy of the small helpers (logging,
  `home`, options parsing). They cooperate without a plugin dependency:
  - Runway gives its note to compact before a limit only while `$.tool.list()`
    lists tidy's `mcp__tidy__compact`.
  - Tidy reads the last switch time from runway's
    `~/.claude/runway/switch/last-switch.json`, and reads a usage limit from
    Claude Code's events itself.
- Facts they rely on that can change without an error:
  - claude-swap's `list --json` format and its `cswap auto` process name
    (`runway/hooks/accounts.ts`, checked against claude-swap 0.29.0).
  - No prompt cache lasts more than an hour (`LONGEST_CACHE_LIFETIME` in
    `runway/hooks/limitnote.ts`).
  - Claude Code's prompt-cache lifetime rules, checked against 2.1.296, and the
    cache price ratios: a read at 0.1 and a write at 1.25 or 2 times input for
    every model (`tidy/hooks/cache.ts`).
  - A model id falls in cswap's model-specific window whose label it contains,
    such as `claude-fable-5-1` in `Fable` (`isInScope` in
    `runway/hooks/switching.ts`).
  - A subagent's limit reaches the plugin as `classic.StopFailure` with
    `agent_id`, and the rate-limit headers carry no model-specific window.
  - A limit reaches the plugin as `classic.StopFailure` with `rate_limit`, or as
    a main turn ending in an error while a window shows at least 99%
    (`runway/hooks/register.ts`, `tidy/hooks/register.ts`).
  - `$.tool.list()` lists a tool that another plugin registered with
    `$.tool.register` (`hasCompactTool` in `runway/hooks/register.ts`).

## threads

- Facts it relies on that can change without an error, checked against the
  transcript of a live session on 2.1.322. The register test "real row shapes"
  pins them.
  - A reply reaches the plugin as `session.append` rows on the door `response`,
    one per response, whose text blocks are all its reply text. Thinking is
    stored redacted, so text the model only thought never arrives.
  - A typed prompt is a row on the door `prompt` holding the typed text alone.
    The context a `prompt.submit` hook attaches is a `hook_additional_context`
    attachment row of its own.
  - A message typed while a turn runs raises `prompt.submit` with `turnId` and
    joins the turn as an attachment row named `queued_command`, whose content is
    the engine's rendering, which contains the typed text.
  - A plugin's own `$.prompt.submit` does not run its own `prompt.submit` hook.
  - A transcript message's `ui.render` `requestId` is its row's `uuid`, which
    `$.ui.scroll` takes.
  - `classic.Stop` with `block` continues the turn.
- A pane has one text field, at its foot, unframed. The engine's `Input` wraps
  and grows only while the boxes around it inset it by 2 columns or less; past
  that it stays one row and cuts its text with an ellipsis. Keep every `Input`
  out of padded or bordered Boxes.
- Pane fields stay uncontrolled: no `value` that echoes what `onInput` stored.
  The echo lands a key or more behind fast typing, and the engine takes a
  changed value over what was typed since, so keys are lost.
- The engine keeps a field's text by its key, across redraws and unmounts,
  empties it on Enter, and draws `value` only when it differs from what it last
  drew under that key. A field that must open on `value`, as a question's field
  opens on its kept note, needs a key never drawn before: `fieldKey` takes a
  generation per target. A note's moves on each time the field is pointed at it;
  a thread's or subthread's only when its field sends, so pointing at a question
  and back returns to the thread's key, with what was typed there.
- How the engine treats a plugin's `$.prompt.submit` after an interrupt, checked
  on Claude Code 2.1.323; its declarations do not say it.
  - Interrupting a turn (Esc or Ctrl+C) sets a Stop for the session and discards
    every plugin prompt queued behind the turn. A queued `$.prompt.submit` then
    settles with a drop, and nothing shows it to the person. A typed prompt
    queued the same way goes back into the prompt box.
  - While the Stop stands, every plugin submit is dropped at once. A typed
    prompt lifts it, and so does a plugin submit made while the person's press
    or Enter is still dispatched.
  - That dispatch ends at the handler's first wait. So the pane calls
    `$.prompt.submit` before it awaits anything (`submit`, the field's `send`,
    `sendAnswers`), building the message from what it last drew. Words that do
    not enter go back into their field, or the prompt box, with a toast. The
    register tests' fake engine models the Stop and the queue.
- An optional live check, `python3 -I threads/tests/live/pane_focus.py`, runs a
  real Claude Code session on a small model in tmux and checks that the pane's
  field keeps the keyboard while questions are filed above it. It spends usage
  and takes about two minutes; `threads/tests/live/README.md` describes it.
  - `--fast` checks fields with keys sent as fast as tmux can, and with a text
    past twice the field's width.
  - `--notes` keeps a note through a card's ✎ by mouse and checks that each
    reopening shows it, which the unit tests cannot see.
  - `--links` clicks a thread's and a question's reference in a reply's prose in
    the transcript and checks that each opens the pane there, then ← and →.
  - `--split` drags the divider between the list and the thread by mouse, and
    presses its round auto-size button.
- The README's GIF in `threads/docs/media/` comes from
  `python3 -I threads/docs/media/record.py`. It runs a real Claude Code session
  in kitty on a virtual X display (Xvfb) on a copy of
  `threads/docs/media/project/`, types the request, and works the pane with the
  mouse while ffmpeg records it. It spends usage, and Claude's replies differ
  from run to run, so look at each frame before keeping a take. Record again
  after a change to how the pane draws.
