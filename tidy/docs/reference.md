# tidy reference

How tidy works, in detail. For what it does and how to start, see the
[README](../README.md).

## Compaction

- **The compact tool.** The model can call `mcp__tidy__compact` to compact its
  own context.
  - The compaction runs when the turn ends, and the turn's final message stays
    verbatim after it. With `resume`, tidy submits that prompt after the
    compaction.
  - If you sent a message during the turn (typed, over Remote Control, or from a
    plugin that sends it as yours, such as the threads pane), tidy refuses the
    call once. The model then answers your message before the summary can drop
    it.
  - If another Stop hook (a `/goal` check, for one) continues the turn, tidy
    ends the turn anyway and passes the hook's reason on after the compaction.
- **At a boundary.** When the context is at least `compactNudgeTokens`, tidy
  asks the model once, at the end of the turn, to compact before a wait or after
  recorded work (a commit or push). It asks at most once every 30 minutes.
  - A wait is what Claude Code reports in flight when the turn ends: background
    work of any kind (subagents, which run in the background by default, shells,
    monitors, workflows) or a scheduled wakeup.
  - Tidy asks once per wait. A wait goes on through the turns that end with any
    of its work still in flight, and ends when all of it has ended or you send a
    new request.
  - Work that was already in flight at the last turn end starts no new wait, so
    a long-lived monitor, dev server or `/loop` asks once.
- **Before a limit.** Tidy does not suggest compacting before a limit itself.
  With [runway](../../runway/README.md) installed as well, runway tells the
  model when a usage window near its limit resets after the prompt cache
  expires, and the model can compact with tidy's tool before the stop.

Tidy never compacts on its own, so keep autocompact as a backstop.

## Cache keep-alive

When a turn ends with background work in flight (a background shell or agent, a
workflow, a monitor) or a wakeup scheduled, the session waits. Its prompt cache
expires after an hour (five minutes on some setups), and the turn that the
work's report starts would then write the whole context to the cache again.
While the session waits, tidy reads the cache just before it expires with a
one-line fork of the main thread (`$.model.fork`), so that the cache stays warm.

- **Cost cap.** A read costs a tenth of a cache write's price per token, and an
  hour's write costs twice the input price, so one write buys 20 pings (12 for
  the five-minute cache). Tidy stops after `keepaliveBudget` writes' worth of
  pings in one wait and lets the cache expire. However long the wait lasts, this
  costs at most about twice what the best choice would have cost in hindsight.
- **When it pings.** Tidy pings only between turns, only for a context of 20k
  tokens or more, and never for a session that waits only for you.
  - A new main request ends the wait and starts a new budget.
  - After a compaction the cache holds nothing, so tidy pings nothing until a
    request caches the context again.
  - While a usage limit stops the session, which tidy reads from Claude Code's
    own events, it pings nothing until the next main turn starts.
- **After an account switch.** A switch moves the login to an account whose
  cache holds nothing of the session. When runway switches accounts, it records
  the time in `~/.claude/runway/switch/`. Tidy reads it there, never writes it,
  and pings nothing until a request caches the context again. Without runway
  there are no such files and nothing to read.
- **Lifetime.** Tidy detects the lifetime as Claude Code chooses it: an hour for
  a subscriber, five minutes otherwise, none with `DISABLE_PROMPT_CACHING`, and
  the choices of `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL` and
  `ENABLE_PROMPT_CACHING_1H`. Claude Code also drops a subscriber to five
  minutes while it draws extra usage, which no plugin API reports. If you
  usually draw extra usage, set `cacheTtlMinutes` to 5.

Each ping is a `keepalive` event in the log, with its usage: a ping whose
`cache_read_input_tokens` is near zero found the cache already gone.

Tidy logs its events to `~/.claude/tidy/<session-id>.jsonl`. Past 5 MB the log
moves to `<session-id>.jsonl.1`, replacing the one before.
