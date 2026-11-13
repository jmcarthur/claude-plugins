# runway

Runway keeps a Claude Code session working through usage limits. With several
subscriptions, it switches to another before a limit stops the work. When a
limit stops a turn anyway, it switches or waits, then resumes the session if
Claude Code's own auto-continue does not.

## Install

```
claude plugin marketplace add jmcarthur/claude-plugins
claude plugin install runway@jmcarthur
```

Then run `/reload-plugins` in each open session. The
[top-level README](../README.md#install) covers updating.

Switching uses [claude-swap](https://github.com/realiti4/claude-swap) (`cswap`),
which `/add-account` installs for you. Without it, runway still resumes a
session that a limit stopped.

## Quick start

1. Run `/add-account`. It installs claude-swap if needed (with uv or pipx) and
   adds the subscription you are logged in to.
2. Run `/login` for another subscription (without `/logout` first), then
   `/add-account` again. Repeat for each subscription.
3. Work as usual. When a usage window would reach 99% within about 35 minutes,
   runway switches every session on the machine to another subscription.

When a subscription's login expires, `/login` to it again: runway stores the new
login in claude-swap. To leave a subscription out, run `cswap disable N`.

## How it works

- Runway tracks how fast the work uses each window (5-hour, weekly, and
  model-specific ones such as Fable) and switches before one fills. It picks an
  account that has room in both its 5-hour and weekly windows, and that would
  not near either limit at the current pace. Among those, it takes the one whose
  weekly window resets soonest, because that unused room is lost first.
- When a limit stops a turn, runway switches at once, or waits for the first
  account to recover, then prompts the session to continue.
- Without another account, it resumes the session a little after the reset, if
  auto-continue has not.
- A switch moves every session on the machine, so the sessions share one plan,
  and only one of them switches before a limit.
- Setup problems and failed switches show in the status line and in a desktop
  notification.
- With [tidy](../tidy/README.md), a large session that faces a long limit gets a
  note to compact before it stops, to try to avoid a large cache miss.

Runway logs its events to `~/.claude/runway/<session-id>.jsonl`.

## Settings

Set these in `/config`, or under `pluginConfigs["runway@jmcarthur"].options` in
`~/.claude/settings.json`. An empty or out-of-range number gives its default,
and a toast at session start names it.

| Setting                    | Default | Meaning                                                                |
| -------------------------- | ------- | ---------------------------------------------------------------------- |
| `compactBeforeLimitTokens` | 300000  | Smallest context for the note to compact before a limit. 0 stops it.   |
| `switching`                | true    | Switch accounts with cswap before a limit.                             |
| `switchMaxWaitMinutes`     | 30      | Switch when a window would reach 99% within this many minutes, plus 5. |
| `remoteControlRestore`     | true    | Turn Remote Control on again after a switch.                           |
| `notifications`            | true    | Desktop notification when switching fails.                             |

## More

The [reference](docs/reference.md) covers the details: how runway measures the
burn and picks an account, switches that make room before a weekly reset, model
limits, new logins, the resume schedule, and the note to compact.
