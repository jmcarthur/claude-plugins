# claude-plugins

Plugins for Claude Code that keep long sessions on track.

| Plugin                           | What it does                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| [rootcause](rootcause/README.md) | Finds the root causes of a defect before the session fixes it, and shows them as a live graph.     |
| [runway](runway/README.md)       | Switches subscriptions before a usage limit stops the work, and resumes a session a limit stopped. |
| [threads](threads/README.md)     | Keeps a session's lines of thought as threads, with their questions, in a pane beside the chat.    |
| [tidy](tidy/README.md)           | Lets the model compact its own context, and keeps the prompt cache warm during background work.    |

Each works alone. With both runway and tidy installed, runway also suggests
compacting with tidy's tool before a long usage limit, and tidy takes the prompt
cache as gone after runway switches accounts.

## Install

The plugins need Claude Code 2.1.323 or later, the version they are tested with:
they use its plugin hooks modules, which change between releases.

```
claude plugin marketplace add jmcarthur/claude-plugins
claude plugin install rootcause@jmcarthur
claude plugin install runway@jmcarthur
claude plugin install threads@jmcarthur
claude plugin install tidy@jmcarthur
```

Install only the ones you want, then run `/reload-plugins` in each open session.

To update, run `/plugin marketplace update jmcarthur`, then `/reload-plugins`.
To install from a local clone, give `claude plugin marketplace add` the clone's
path.

## Contributing

Pull requests are welcome at
[jmcarthur/claude-plugins](https://github.com/jmcarthur/claude-plugins). A
merged pull request is applied upstream and comes back here with the next
update. [DEVELOPMENT.md](DEVELOPMENT.md) covers the checks to run.

## License

MIT. See [LICENSE](LICENSE).
