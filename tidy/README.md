# tidy

Tidy looks after a Claude Code session's context. It gives the model a tool to
compact its own context, suggests compacting at natural boundaries, and keeps
the prompt cache warm while the session waits on background work, so that the
work's report does not pay to cache the whole context again.

## Install

```
claude plugin marketplace add jmcarthur/claude-plugins
claude plugin install tidy@jmcarthur
```

Then run `/reload-plugins` in each open session. Tidy needs no setup. The
[top-level README](../README.md#install) covers updating.

## Quick start

1. Ask the model to compact: "compact your context, then carry on with the
   tests". It calls `mcp__tidy__compact`, and the compaction runs when the turn
   ends.
2. Work as usual. Once the context reaches 300k tokens, tidy asks the model to
   compact at the end of a turn that recorded work (a commit, say) or that
   starts a wait on background work.
3. Start background work that outlasts the prompt cache, such as a long build in
   a background shell. Tidy keeps the cache warm while it runs.

Tidy never compacts on its own, so keep autocompact on as a backstop.

## How it works

- A compaction through the tool runs when the turn ends, and the turn's final
  message stays verbatim after it. Given `resume`, tidy submits that prompt
  after the compaction.
- Tidy suggests compacting at most once every 30 minutes, and once per wait.
- While the session waits on background work or a scheduled wakeup, tidy reads
  the cache just before it expires. Per wait, it spends at most
  `keepaliveBudget` cache writes' worth of reads.
- With [runway](../runway/README.md), runway can tell the model to compact
  before a long usage limit, and tidy knows the cache is gone after runway
  switches accounts.

Tidy logs its events to `~/.claude/tidy/<session-id>.jsonl`.

## Settings

Set these in `/config`, or under `pluginConfigs["tidy@jmcarthur"].options` in
`~/.claude/settings.json`. An empty or out-of-range number gives its default,
and a toast at session start names it.

| Setting              | Default | Meaning                                                                   |
| -------------------- | ------- | ------------------------------------------------------------------------- |
| `compactNudgeTokens` | 300000  | Smallest context for a compaction suggestion at a boundary. 0 stops them. |
| `cacheTtlMinutes`    | empty   | Overrides the detected cache lifetime, in minutes. 0 stops keep-alive.    |
| `keepaliveBudget`    | 1       | Most that keep-alive may spend in one wait, in cache writes. 0 stops it.  |

## More

The [reference](docs/reference.md) covers the details: what counts as a boundary
and a wait, how a message you send during the turn is protected, the
keep-alive's cost cap, and how tidy detects the cache's lifetime.
