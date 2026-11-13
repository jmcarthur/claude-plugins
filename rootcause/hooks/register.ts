import type { EngineInterface, Register } from "claude-code";

const SECTION_ID = "rootcause:method";

const SECTION = `# Root causes

When something behaves wrongly (a bug, a wrong result, a failing or flaky check, the user saying something is wrong) and you have not checked its cause, find the cause before you change code to fix it or add a retry, guard, timeout or special case. Do the same when the user corrects your work, such as a document, plan, brief or scope, and when a cause you already answered comes back. A new or stricter target, preference or scope from the user is not a correction, unless your work went against something the user had already said or something its purpose plainly needed: adopt it, say in one line what set the old one, and go on. An evident cause is usually only the first answer, and a defect can have more than one cause. Start the \`rootcause:rootcause\` agent, and brief it with:
- the symptom as you observed it;
- the user's words about it, verbatim;
- what was already tried, and what it showed;
- any cause you suspect, marked as a guess.
Brief one agent with several symptoms when they may share causes: the same area, the same time window, or the same kind of failure. Give unrelated problems separate agents, since batching them only fills the agent's context. Send a related symptom that turns up later to the running agent, which adds it to its analysis.
It returns a report of the causes it found and the steps it recommends fixing at. Then you make the fix:
- Fix at the deepest step whose change is in proportion to the effects it removes and within your remit. Your fixes must cover every cause that is enough alone to cause the defect: fix that cause, or a step between it and the symptom.
- A guard, retry, special case or longer timeout that hides a cause you could fix is not a fix. Add one only alongside the real fix, or with the user's agreement.
- If a cause is a design that an earlier session chose, judge it and change it when the report says to: it is yours. If a cause is a decision the user made or asked for, and that decision may be the mistake, say so and ask the user before you build around it.
- The report also says what would have avoided the defect: a design, interface, check or process that made it easy to make or slow to find. Make the changes it marks worth it when they are yours and small; propose the others to the user.
- In your report to the user, give the causes, each fix of the report with what you changed for it or that you did not and why, the deeper causes you left alone, and what would have avoided the defect.

Do not start the agent for a defect or a correction when it would add nothing: its cause is already known and you checked it in one step, or an agent or the work under way is already answering the question it would ask. Say so in your report to the user, with the cause and your reason.`;

// The agent's walk should drive its checking: each check's result goes into the analysis as soon as it
// settles a cause. Agents tend instead to record hypotheses, investigate everything, and record it all at the
// end. So in an agent that runs the command, count the other tool calls since its last `rootcause` command:
// a note at NOTE_AFTER, and a refusal from DENY_AFTER on, until it runs the command again.
const NOTE_AFTER = 6;
const DENY_AFTER = 10;
const RECORDS = /^\s*rootcause\s/;
const STARTS = /^\s*rootcause\s+start\b/;
const STARTED = /Started (rc-\d{8}-[0-9a-f]{6})\./;

const recordNow = (n: number) =>
  `[rootcause] ${n} tool calls since your last \`rootcause\` command. Record what your checks have shown now: give the step's causes again with each hypothesis marked checked or refuted and its evidence, and add any cause you found, before you check further. The user follows the analysis live in a web page and sees only what you have recorded, so a check you have not recorded is invisible to them.`;

// An analysing agent may start helpers for independent checks. They run at medium effort, on Opus or (rarely)
// Sonnet and never Haiku. An unset effort inherits the agent's high one, and an unset model can resolve to an
// agent type's own or a configured default, so the hook sets both. A fork cannot take an effort, so it is refused.
// Helpers bring back evidence; the analysis stays with the agent that started them.
const HELPER_EFFORT = "medium";
const HELPER_MODELS = ["opus", "sonnet"];

const helperSet = (changed: string[]) =>
  `[rootcause] Helpers run with effort: medium and model: opus (sonnet only for purely mechanical work, never haiku). This one was started with ${changed.join(" and ")}; set them yourself next time.`;
const noFork =
  "[rootcause] Do not fork a helper: a fork cannot run at medium effort. Start a fresh agent with model: opus and effort: medium, and brief it with the question, where to look and what evidence to bring back.";
const helperNoRecord =
  "[rootcause] You are a helper of a root cause analysis. Do not run `rootcause` commands: bring back the evidence you found (what you ran or read, and what it showed), and the agent that started you records it.";

const staleNote = (listing: string) =>
  `[rootcause] These root cause analyses of this project have been open for more than a day:\n${listing}\nTell the user about them once, and ask whether to finish each (a rootcause agent continues it, briefed with its id) or abandon it (\`rootcause abandon ID\` with a reason). An analysis left open is a finding nobody acts on.`;

const giveLink = (url: string) =>
  `[rootcause] The user can follow this session's root cause analyses live in a browser, at ${url}. Give the user this link in your next reply.`;

// The web UI: `rootcause serve --detach` registers the session and the Claude Code process it runs in,
// starts the shared server unless it already runs, and prints the session's page. The server outlives the
// call, and stays up while a registered session's process runs or a page is open.
async function serve(
  $: EngineInterface,
  args: string[],
): Promise<string | undefined> {
  const ran = await $.process
    .run([`${$.plugin.root}/bin/rootcause`, "serve", "--detach", ...args], {
      timeoutMs: 15_000,
    })
    .catch(() => undefined);
  return ran?.exitCode === 0
    ? ran.stdout.trim().split("\n").pop() || undefined
    : undefined;
}

export const register: Register = (on) => {
  // The agents that run an analysis (they ran a `rootcause` command), each with its tool calls since it last
  // recorded, and the helpers they started, which neither record nor count.
  const sinceRecord = new Map<string, number>();
  const helpers = new Set<string>();
  // The sessions whose page the user was given, and the notes that wait for the main session's next tool call.
  // A /clear goes on under a new session id, whose first analysis is a new first use.
  const linked = new Set<string>();
  const notes: string[] = [];

  on("tool.call", async ($, e, next) => {
    const agent = e.agentId;
    if (agent === undefined) {
      const result = await next(e);
      if (notes.length === 0 || result.deny !== undefined) return result;
      return {
        ...result,
        context: [...(result.context ?? []), ...notes.splice(0)],
      };
    }
    if (e.tool === "Bash" && RECORDS.test(e.command)) {
      if (helpers.has(agent)) return { deny: helperNoRecord };
      sinceRecord.set(agent, 0);
      if (!STARTS.test(e.command)) return next(e);
      const result = await next(e);
      const started =
        result.deny === undefined && result.isError !== true
          ? STARTED.exec(result.result.stdout)
          : null;
      if (started === null) return result;
      const session = await $.session.id();
      const url = await serve($, ["--session", session, "--claim", started[1]]);
      if (url !== undefined && !linked.has(session)) {
        linked.add(session);
        $.ui.toast(`Root cause analyses, live: ${url}`, { timeoutMs: 15_000 });
        notes.push(giveLink(url));
      }
      return result;
    }
    const count = sinceRecord.get(agent);
    if (count === undefined) return next(e);
    const n = count + 1;
    if (n >= DENY_AFTER) return { deny: recordNow(count) };
    let call = e;
    const extra: string[] = [];
    if (e.tool === "Agent") {
      if (e.subagent_type === "fork") return { deny: noFork };
      const changed: string[] = [];
      if (e.effort !== HELPER_EFFORT)
        changed.push(
          e.effort === undefined ? "no effort" : `effort: ${e.effort}`,
        );
      if (!HELPER_MODELS.includes(e.model ?? ""))
        changed.push(e.model === undefined ? "no model" : `model: ${e.model}`);
      if (changed.length > 0) {
        call = {
          ...e,
          effort: HELPER_EFFORT,
          model: HELPER_MODELS.includes(e.model ?? "") ? e.model : "opus",
        };
        extra.push(helperSet(changed));
      }
    }
    sinceRecord.set(agent, n);
    const result = await next(call);
    if (result.deny !== undefined) return result;
    if (n >= NOTE_AFTER) extra.push(recordNow(n));
    return extra.length === 0
      ? result
      : { ...result, context: [...(result.context ?? []), ...extra] };
  }).catch(($, e, next) => next(e));

  // A spawn inside an analysing agent is one of its helpers.
  on("agent.spawn", async ($, e, next) => {
    const result = await next(e);
    if (
      e.parentAgentId !== undefined &&
      sinceRecord.has(e.parentAgentId) &&
      result.deny === undefined &&
      result.agentId !== undefined
    )
      helpers.add(result.agentId);
    return result;
  }).catch(($, e, next) => next(e));

  on("session.start", async ($, e, next) => {
    const result = await next(e);
    // A plugin install may drop the exec bit, and a plugin's bin/ command runs
    // only with it, so set it here: a clone or an install then needs no chmod.
    await $.process
      .run(["chmod", "a+x", `${$.plugin.root}/bin/rootcause`], {
        timeoutMs: 10_000,
      })
      .catch(() => undefined);
    // The two steps below need the exec bit and not each other, so they run together.
    const session = await $.session.id();
    const [stale, url] = await Promise.all([
      // Analyses of this project left open: an analysis left open is a finding nobody acts on. The command
      // prints nothing when none is.
      $.process
        .run([`${$.plugin.root}/bin/rootcause`, "list", "--stale"], {
          timeoutMs: 15_000,
        })
        .then(
          (ran) => (ran.exitCode === 0 ? ran.stdout.trim() : ""),
          () => "",
        ),
      // A session resumed in a new process: register that process, so the server stays up while it runs, and
      // start the server if it stopped. The page and its URL are the same, so the main session needs no note.
      serve($, ["--session", session, "--if-known"]),
    ]);
    if (stale !== "") notes.push(staleNote(stale));
    if (url !== undefined) {
      linked.add(session);
      $.ui.toast(`Root cause analyses, live: ${url}`, { timeoutMs: 15_000 });
    }
    return result;
  });

  on("prompt.compose", async ($, e, next) => {
    const result = await next(e);
    if (e.traits.includes("bare")) return result;
    return {
      sections: [
        ...result.sections,
        { id: SECTION_ID, text: SECTION, scope: "session" as const },
      ],
    };
  });
};
