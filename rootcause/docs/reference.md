# rootcause reference

How rootcause works, in detail. For what it does and how to start, see the
[README](../README.md).

- [Why](#why)
- [How it works](#how-it-works)
- [The command](#the-command)
- [The flow](#the-flow)
- [State](#state)
- [Permissions](#permissions)
- [The web UI](#the-web-ui)
- [How the hooks keep the agent on track](#how-the-hooks-keep-the-agent-on-track)

## Why

A rule such as "find the cause before you fix it" in `CLAUDE.md` is easy to
ignore. Nothing brings it up at the moment a session finds a bug. Nothing makes
the steps separate, so a guess can pass as a checked cause inside one thought.
And nothing records the causes, so the user cannot see them.

## How it works

A short section of the system prompt tells the main session when to start the
`rootcause:rootcause` agent, what to put in its brief, and the rules for the fix
that the session then makes.

- The section asks for the agent also when the user corrects the session's work
  (a document, plan, brief or scope), and when a cause the session already
  answered comes back.
- A new or stricter target or preference from the user is not a correction,
  unless the work went against something the user had already said or its
  purpose plainly needed: the session adopts it and says in one line what set
  the old one.
- The session skips the agent when it would add nothing: the cause is already
  known and checked in one step, or an agent or the work under way is already
  answering that question. It then says so in its report, with the cause and the
  reason.

The agent investigates each step itself: it reads code, runs checks and
reproduces the symptom. It treats any cause in its brief as a hypothesis to
check. It does not make the fix: it returns the report and the steps it
recommends fixing at, and the main session makes the fix. Its prompt holds the
whole method, and the `rootcause` command enforces the steps.

## The command

The plugin's `bin/rootcause` is a Python 3 program (standard library only).
Claude Code puts the plugin's `bin/` on the PATH of the session and of its
subagents. It runs only with its exec bit set, and a plugin install may drop the
exec bit, so the hooks module sets the bit at each session start. A fresh clone
or an install then needs no `chmod`.

The plugin registers no tools, so no session carries their names or schemas.
Only the agent's prompt describes the command.

Each subcommand but `check`, `list` and `serve` reads its input on stdin as
`key: value` lines, which the agent gives in a quoted heredoc so that its text
needs no escaping:

```
rootcause answer rc-20261017-3f9a2c <<'EOF'
cause: The writer truncates on close
evidence: Ran strace on the export: ftruncate on close
status: checked
effects: none
reach: outside
EOF
```

A `cause` or `same` line starts a cause, and the lines after it belong to it.
`effects` takes one line per effect, or `effects: none`. `conclude` takes a
`leftAlone:` line with a step and a `reason:` line under it per branch end. An
indented line continues the value above it. The same input as one JSON object
also works, but see Permissions.

`check`, `list` and `serve` never read stdin: in a Bash call that holds a
heredoc anywhere, Claude Code leaves stdin open, and a read would wait forever.
The reply goes to stdout. A refusal goes to stderr, says what was wrong, asks
the open question again, and exits 1. `rootcause --help` lists the input shapes.

## The flow

1. `start` takes the symptom and asks "Why does this happen, or, for a fact
   about the project or its history, why is it like this? Give every cause you
   find, each with its evidence, whether you checked it, what else it affects
   (look at callers and other uses), and whether you can change it; say whether
   all are needed together, any one is enough, or each makes part of it."
2. `answer` takes all the causes of one step in one call, and the analysis grows
   into a tree of causes. Each entry gives its cause, evidence, status, effects
   and reach, with an optional weight. The reply first echoes what it recorded
   (how the causes combine, and each one's reach), so that a slip is visible at
   once. The replies walk each branch to its end before the next, and say which
   cause they ask about.
   - A `hypothesis` gets "How would you check it?" The walk does not go below it
     until the session gives the step's causes again with it `checked`.
   - A `refuted` cause stays in the record and the report, as ruled out, and is
     never walked.
   - A `supported` cause is backed by evidence but not proven: the check that
     would prove it cannot be run.
     - It cites at least one evidence item (`cites: E1, E2`), and gives `proof`,
       the check that would prove it, and `unprovable`, why that check cannot be
       run (the data is gone, the event cannot be reproduced, it needs access
       the session lacks).
     - An `unprovable` of a few words, or one that names only effort ("would
       take too long"), is refused.
     - A supported cause has reach `changeable`: the walk goes on below it as
       below a checked one, and it can neither end a branch nor be fixed. A fix
       goes on a checked cause below it; missing logging that keeps a cause from
       being checked is such a cause.
   - An `evidence E1: ...` line anywhere in an answer defines an evidence item
     once for the analysis. Any cause may cite it, so one fact that backs
     several causes shows once. An item given again with the same text changes
     nothing; with other text it is refused.
   - Each supported cause on a fix's path from the symptom is an unproven link.
     The reply that asks for conclude, `check`, and the report say for each fix
     that rests on any how many and which ("Rests on 2 unproven links: 1.2,
     1.2.1"). The tree path counts; a `same` does not add one.
   - `changeable` gets "And why does that happen, or why is it like this? If a
     past decision explains it, why was that decision made?" The walk asks to
     answer history only from the record, and to end a branch whose cause it
     cannot tell as `stop`.
   - `fix` marks where to change. It carries the fix: the change, which the
     report prints; whether it removes the cause or only hides it (a guard,
     retry, special case or longer timeout); and why it is in proportion. A fix
     that only hides the cause needs a reason: the cause cannot be removed, or
     the user agreed. A fix does not end its branch: the walk asks for its
     causes too.
   - `design` is code that works as an earlier session or author designed it. It
     asks "Why does it work this way?": the entry gives the design's purpose and
     a verdict. `change` carries a fix like `fix`, counts as one, and asks why
     it was designed so in the first place; `keep` carries the reason the
     purpose outweighs this symptom and the other defects of its kind, and ends
     the branch.
   - A branch ends only at a cause left alone: `outside`, `decision`, `needed`,
     a kept design, or `stop`. A `stop` is a cause the session could change but
     leaves alone because the change is out of proportion, no deeper cause is
     worth naming, or it cannot tell the deeper cause.
   - `decision`, a choice the user made or asked for, asks "Could this decision
     be the mistake? If it may be, say so. If it is the user's, including
     something they asked for, ask them before you build around it."
   - `combine: parts` says the step is made of parts that each make some of it:
     slices of a time or size, groups of failures, wrong pieces of an output,
     points of a correction.
     - The answer says how the parts cover the whole (`coverage`), and each part
       says how much it makes (`share`) and what it would be if it were right,
       worked out from the purpose (`need`). A part that is what its purpose
       needs is `needed`.
     - Every part is walked to its own end, even when a fix beside the whole
       covers the symptom, and a parts step counts as covered only when each
       part is fixed, needed or kept as a design.
   - An entry `same: 1.2` names a cause already in the tree. It is not walked
     again, and counts as that step for coverage.

   Causes given again for a step revise its list. This is also how a cause found
   later is added; the reply says so, and the walk returns to it.

3. `check` says what `conclude` would refuse, without closing the analysis: a
   cause that no fix covers, and the branch ends that need a reason in
   `leftAlone`.
4. `conclude` refuses until every branch has ended and the fixes cover the
   symptom. Causes that are each enough alone need a fix each, or one at a step
   above them; of causes needed all together, one fix can be enough.
   - It takes `leftAlone`: the reason for each branch end, and refuses until
     every end has one. For a `stop`, the reason names the deeper change
     considered and why it is out of proportion, or says the cause cannot be
     told and what was searched.
   - It also takes `avoidable`: what made the defect easy to make or slow to
     find, each with the change that would prevent defects of its kind, whether
     it is worth it, and why, or none.
   - The reply is the report: the symptom, and one line per step, numbered 1,
     1.1, 1.2.1, with its weight, how its causes combine, and where it was
     fixed, left alone or ruled out. It gives each supported cause's proof and
     why it cannot be run, the unproven links each fix rests on, and the
     evidence items with the steps that cite them, then how it could have been
     avoided. Its last line names the analysis file, which holds the evidence.
5. `abandon` closes an open analysis without a conclusion, for a misread symptom
   or a duplicate. The reply records the reason.
6. `list` lists the open analyses. `list --stale` lists only this project's
   analyses that have been open for more than a day, and prints nothing when
   none is.

### Several symptoms

One analysis can hold several symptoms that may share causes, so that one agent
researches them together and finds a shared cause once. The main session briefs
one agent with several symptoms when they may share causes (the same area, time
window or kind of failure), and separate agents for unrelated problems, since
batching those only fills the agent's context.

- `start` takes one `symptom:` line per symptom (or `"symptom": [...]` in JSON).
  `add-symptom ID` adds more to an open analysis, for a problem that turns up
  later; the main session can send it to the running agent.
- Numbering: the first symptom's steps are 1, 1.2, 1.2.1, as in an analysis with
  one symptom. A later symptom is S2, S3, and its steps S2.1, S2.1.2. So the
  first symptom numbers its steps as if it were alone, and adding a symptom
  renumbers no step that `same`, `leftAlone` or a link already names. `step: S2`
  gives the causes of symptom S2; `step: 0` and `S1` both name the first
  symptom, and `S1.2` is read as 1.2.
- The walk takes each symptom in turn, to its ends. A `same` may name a step
  under another symptom: the shared cause is one step that each symptom reaches.
  The rule that a `same` names no ancestor holds as with a single symptom.
- `check` and `conclude` need fixes that cover every symptom, and a `leftAlone`
  reason for every branch end under any symptom. The report gives each symptom's
  tree, then the fixes that each symptom reaches, whether it shares causes with
  the others, and the shared causes (the steps a `same` names across symptoms).
  A symptom that turns out unrelated stays in the analysis and is concluded with
  it; the agent says so in its report.
- The record keeps the first symptom as `symptom` and `why`, as with a single
  symptom, and the others in `moreSymptoms`, each with its `symptom`, `added`
  time and `why`.

The plugin makes no model calls of its own. Its hooks watch the agent's tool
calls (see "How the hooks keep the agent on track") and its `rootcause start`
calls, for the web UI. At the start of each session they also run
`rootcause list --stale`: when an analysis of this project has been open for
more than a day, the main session's next tool call carries a note that lists it,
and Claude asks you whether to finish each one or abandon it. A start with
several symptoms replies `Started <id>.` as one with a single symptom does, so
the hook registers it the same way.

## State

Each analysis is one JSON file, `~/.claude/rootcause/analyses/<id>.json`. Set
`ROOTCAUSE_DIR` to use another folder in place of `~/.claude/rootcause`. An id
such as `rc-20261017-3f9a2c` is the start date and a random suffix, so it is
unique without a session. Several analyses can be open at once, from any
session. Each command writes the file whole, through a temporary file and a
rename.

`start` records the Claude Code session id (`CLAUDE_CODE_SESSION_ID`) in the
file as `session`, and `answer` records on each cause when it was `added` and
last `revised` (UTC). A cause that a revised step keeps, matched by its text,
keeps its `added` time.

A file keeps its analysis after it closes, with `status` set to `concluded` or
`abandoned` and the time it `closed`.

## Permissions

With an allow rule such as `Bash(rootcause:*)`, the agent's `rootcause` calls
run without prompts in the default mode as well as in auto mode. Claude Code
asks about any command whose text has a `{` followed by a quote before the next
`}`, even under an allow rule. A heredoc of JSON always has one, so the agent
gives the `key: value` form and writes no `{`.

## The web UI

A browser shows the analyses as they change, at `http://127.0.0.1:7391` (set
`ROOTCAUSE_PORT` for another port). The server listens on 127.0.0.1 only, and
refuses a request whose `Host` is not `127.0.0.1` or `localhost`.

- `/` lists every analysis, newest first with a link to its session's page, or
  grouped by session; a toggle at the top switches, and the page remembers it.
  Each session's card starts collapsed: click its header to open or close it. A
  card opens by itself when a new analysis appears in it.
- A session shows by its name (one you or Claude Code gave it, else its title)
  and its working directory, read from its transcript and Claude Code's live
  registry, both undocumented files. Without a name it shows its short id.
- `/s/<session id>` lists one session's analyses: symptom, status and start. An
  analysis with several symptoms shows the first, and "and 2 more".
- `/a/<id>` shows one analysis, the symptom at the top. The conclusion (the
  fixes, each with the unproven links it rests on, what was left alone, and how
  it could have been avoided) shows in a panel on the right.

On `/a/<id>`, the Tree | DAG | Outline | Matrix toggle in the header picks the
layout, and `L` cycles through the four:

- DAG, the default, draws a shared step as one box with an edge from each step
  that names it, and orders rows to cut crossings, so siblings may leave step
  order.
- Tree (`?layout=tree` in the URL) draws a tree instead, where a `same` entry is
  a small pill with a dashed arrow to its step.
- Outline (`?layout=outline`) draws no graph, for an analysis too large to read
  as one. It lists the steps as an indented page in step order, each with its
  full cause text, its chips and its evidence as green tags. A click on a step's
  caret folds its causes. The evidence is listed at the end.
- Matrix (`?layout=matrix`) draws no graph either. It has a row per step and a
  column per evidence item, with a dot where the step cites the item, and each
  item's count of citing steps below.

In the two graph layouts:

- Each box is a cause: its step number, its status and reach, and its `cause`
  text. A badge under a step says how its causes combine (ALL, ANY or PARTS).
- The color of a box shows its place in the order the causes were added, from
  dark violet (oldest) to yellow (newest), on the viridis scale, evenly spaced
  by rank rather than by time. The legend gives the first and last times.
- A hypothesis has a dashed border, a supported cause a dotted one, a refuted
  cause is faded and struck through, and a fix has a thick border.
- An evidence item is a small green hexagon under the causes that cite it, with
  a dotted green link from each. The items and their links stay out until the
  Evidence button (or `E`, or `?evidence=on`) shows them.
- Drag to pan, scroll to zoom, `F` or the Fit button to fit.
- With several symptoms, the tree layout puts their trees side by side, and a
  `same` across them is a pill and arrow as within one. The DAG layout has a
  source per symptom, and a shared cause is one box with an edge from each.

Also on `/a/<id>`:

- A click on a box opens everything the agent recorded for it; Esc or a click
  outside closes it, and the URL's `#1.2` opens step 1.2.
- The title shows the first symptom and "and N more"; `#S2` opens symptom S2,
  `#S2.1` its first step.
- A click on an evidence item, or `#E1`, opens it with the causes that cite it.

Every page updates as the files change (server-sent events, polled twice a
second). A graph keeps its pan and zoom and an open step across updates, and
outlines new causes for a few seconds. A record without times shows times
estimated from its log.

### The server

`rootcause serve` runs the server in the foreground. The hooks module starts it:
when an agent's `rootcause start` succeeds, it runs
`rootcause serve --detach --session <session id> --claim <id>`.

- That registers the session, the analysis, and the Claude Code process that
  runs the command (the nearest ancestor whose executable path names `claude`,
  else `CLAUDE_PID`) in `~/.claude/rootcause/sessions/<session id>.json`.
- It then binds the port and forks the server into the background; if the port
  is taken, a server already runs, and it does nothing more. It prints the
  session's page.
- The first time in a session, the hooks module shows that URL in a toast, and
  adds a note to the main session's next tool call result that asks it to give
  the user the link. A `/clear` goes on under a new session id, so its first
  analysis gets its own page and note.

The server stays up while a registered Claude Code process runs or a page is
open, and exits 5 minutes after neither is so. It checks every 30 seconds, by
pid and the process's start time, so a reused pid does not count. A process that
died drops out of its session's registration; the session's analyses stay
listed.

At each session start the hooks module runs
`rootcause serve --detach --session <session id> --if-known`. For a session with
analyses, such as one resumed in a new process (`claude --resume`,
`--continue`), that registers the new process, starts the server if it stopped,
and the toast shows the same URL. For another session it does nothing. This
assumes that a resumed session keeps its id, which the hook API does not say; a
resumed session that comes back under a new id gets a page of its own for its
new analyses.

A session that the user backgrounds goes on in a new process under a new session
id, and no hook event says so. Claude Code's own registry,
`~/.claude/sessions/<pid>.json`, does: the old process's entry gets
`parkedJobId`, and the new one's `jobId` has the same value. That registry is
not a documented interface (checked with 2.1.304).

- The server reads it at each check, and `serve` reads it at each call. Each
  link found goes into the old session's file as `continuedAs`, since the old
  entry goes when its process exits.
- A session's page lists the analyses of every session it continued as or from,
  and a registered session whose continuation's process runs keeps the server
  up.
- If the registry changes, a backgrounded session's new analyses get a page of
  their own, and the old page stops at the backgrounding.

### The log

Each analysis also keeps a log beside its record,
`~/.claude/rootcause/analyses/<id>.log`. Every `rootcause` call appends its
input and its reply, refusals too, so a terminal can follow it as well:

```
tail -f "$(ls -t ~/.claude/rootcause/analyses/*.log | head -1)"
```

## How the hooks keep the agent on track

Agents tend to record their hypotheses, investigate everything, and record it
all at the end. The hooks module counts each agent's tool calls since its last
`rootcause` command: at 6 it adds a reminder to record what the checks showed,
and from 10 on it refuses the call until the agent runs the command again. Only
agents that have run a `rootcause` command are counted.

The agent can start helper subagents for independent checks that take many
calls, so that it can keep to the analysis. Helpers bring back evidence; the
agent records it and judges the causes. The hooks module enforces the helper
settings:

- When an agent that has run a `rootcause` command calls the Agent tool, the
  module rewrites the call to `effort: medium`, and to `model: opus` unless the
  call asks for `opus` or `sonnet`, and tells the agent what it changed. An
  unset effort would inherit the agent's `high`, and an unset model can resolve
  to an agent type's own model, such as Haiku.
- A fork cannot take an effort, so the module refuses it.
- A helper's tool calls are not counted, and the module refuses any `rootcause`
  command from a helper.
