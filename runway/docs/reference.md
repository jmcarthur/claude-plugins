# runway reference

How runway works, in detail. For what it does and how to start, see the
[README](../README.md).

- [Setup and notices](#setup-and-notices)
- [Account switching](#account-switching)
- [Resuming after a limit](#resuming-after-a-limit)
- [Compacting before a limit](#compacting-before-a-limit)

## Setup and notices

Runway switches accounts with
[claude-swap](https://github.com/realiti4/claude-swap) (`cswap`) when it manages
two or more. `/add-account` installs claude-swap if needed (with uv or pipx) and
adds the logged-in account. For each other account, `/login` (not `/logout`) and
run `/add-account` again. Without claude-swap, runway still resumes a session
that a limit stopped.

Setup problems, such as an account whose login expired, show in the status line
and in a desktop notification. Runway never reports an account you take out of
rotation with `cswap disable N`. The status line shows one notice at a time, the
most pressing, and drops each once its cause is gone; a failed cswap command
shows until one succeeds, for at most an hour.

## Account switching

- **Model use.** Runway notes which models each session requests, its subagents'
  included. A model-specific window (such as Fable) is _in use_ for an hour
  after a request on a model in it, in any session.
- **Readings and burn.** For each window runway takes the newer of the last
  response's rate-limit headers and cswap's reading, so an idle session's old
  headers do not stand in for the account.
  - A reading adds a point to the burn only when its own time is new.
  - The burn is the work's: each account's burn comes from its own readings, and
    the work's is the highest across accounts in the last 45 minutes, so it
    carries over a switch.
  - cswap reports whole percents, so a reading that has not moved counts as at
    most one percent over the time it held.
- **Choosing an account.** Runway picks the account itself and switches with
  `cswap switch`.
  - The target must be short of 99% in its 5-hour and weekly windows, and must
    not be near its own limit at the work's burn. This is the same judgment that
    makes the active account near its limit, so no rule moves back to an account
    another rule just left.
  - Among those, runway prefers one with room in every model-specific window in
    use, then the one whose weekly window resets soonest, because its room is
    lost first.
  - An account without room in its all-models windows serves no model, so that
    room always decides first.
- **Before a limit.** When a 5-hour or weekly window, or a model-specific window
  in use, would reach 99% at its burn rate within `switchMaxWaitMinutes` plus 5
  minutes, runway switches.
  - Without a burn rate yet, only 99% starts the switch: a fixed percent below
    it would switch hours early on the weekly window.
  - A full model-specific window that no session uses causes no switch.
- **Sooner reset.** While no window is near its limit, runway also switches to
  the chosen account when its weekly window resets sooner than the active one's,
  so that its room is used before it is lost.
  - It never moves to an account whose model-specific window in use is full,
    nor, until that window resets, to an account that a switch near a limit
    left.
  - It waits an hour after any switch, and does not move while the active
    account's weekly reset is unknown.
- **Repeated switches.** A third switch within an hour shows a warning in the
  status line and a notification. Each `switch-plan` event in the log carries
  the accounts' readings and the burns it was decided on.
- **At a model limit.** When a request, the main turn's or a subagent's, hits a
  model-specific limit while the account still has all-models room, runway
  switches at once to an account with room in that window and tells the session
  to retry, or tells it which account's window resets first.
- **At a limit.** When a limit has stopped the main turn, runway switches at
  once to the chosen account. If none has room, it waits for the first account
  to recover and switches to it. In both cases it then prompts the session to
  continue, unless `autoContinueAtUsageLimit` is off or the session already
  resumed. For a limit where the current account recovers first, see
  [Resuming after a limit](#resuming-after-a-limit).
- **Several sessions.** A switch moves the login of every session on the machine
  and empties their prompt caches.
  - The sessions share records and a plan in `~/.claude/runway/switch/`, and
    only the session with the lowest id switches before a limit. Runway runs one
    switch at a time.
  - Runway records every switch, planned or at a limit, in the plan, so that
    every session sees it. After a switch, every session reads its rate-limit
    headers as those of the account it left, starts the hour of waiting before
    an optional switch, and counts the switch toward the repeated-switch
    warning. No switch moves back to an account that a switch at a limit left
    until that account recovers.
  - Each switch also writes its time to `last-switch.json` there, which
    [tidy](../../tidy/README.md) reads.
- **Remote Control.** A switch drops Remote Control. If it was on, runway turns
  it on again once the session shows it as off.
- **A new login.** Runway compares the account Claude Code is logged in to (the
  `oauthAccount` of `~/.claude.json`) with cswap's accounts, by email and
  organization. It switches only while that account is cswap's active one, so a
  switch never replaces a login that cswap has not stored.
  - After `/login` to an account whose cswap login expired or that is not the
    active one, runway runs `cswap add`, which stores the new login and makes
    the account active, and says so in a toast. If `cswap add` fails, a
    notification says why, and runway does not try again for that login.
  - After `/login` to an account that cswap does not manage, the status line
    says so, and Claude offers you `/add-account`.

Runway never switches to an account that `cswap disable` took out of rotation.
Do not run `cswap auto` alongside runway; while a `cswap auto` loop runs, runway
does not switch, and the status line says so. A session whose
`CLAUDE_CONFIG_DIR` names another folder than `~/.claude` (such as one started
with `cswap run`) takes no part in switching.

## Resuming after a limit

When a limit stops the main turn and runway does not switch, it waits for Claude
Code's auto-continue and steps in when that does not come:

- With a known reset (from the session's rate-limit readings, or cswap's),
  runway prompts the session to continue 2 minutes after the reset, if no turn
  started since the limit.
- Without one, it tries after 10 minutes, and after each try that hits the limit
  again it waits twice as long, up to an hour.
- With cswap, a limit that cswap reports cleared before its reset is resumed
  early, on the same schedule.

The status line says when runway will resume. Runway does nothing while
`autoContinueAtUsageLimit` is off. The `stop-failure` events in the log keep
Claude Code's error details, which show when its auto-continue fails.

## Compacting before a limit

Runway tells the model once about the usage windows at 95% or more that reset
more than an hour later, when no other account has room. An hour is the longest
prompt-cache lifetime; runway does not detect the session's own.

For each window, the note gives its scope (all models, or one model family),
account, use, reset, where runway read it and how long ago, and when it would
fill at the recent burn. The model judges whether its work will stop, since it
knows which models it will use, and compacts before the stop if it will.

The model cannot run `/compact` itself, so runway gives this note only while
tidy's compact tool, `mcp__tidy__compact`, is loaded in the session, and names
that tool in it. Without tidy, runway still switches and resumes, and gives no
note. The note needs a context of at least `compactBeforeLimitTokens`, runway's
own setting: tidy's `compactNudgeTokens` sets only its suggestions at a
boundary.

Runway logs its events to `~/.claude/runway/<session-id>.jsonl`. Past 5 MB the
log moves to `<session-id>.jsonl.1`, replacing the one before.
