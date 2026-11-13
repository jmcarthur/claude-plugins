import type { Frozen, PromptOrigin, ToolCallEnvelope } from "claude-code";

// The version-control commands that count as recorded work, one row per tool:
// `record` saves a change, `publish` sends recorded work elsewhere.
const VCS_COMMANDS = {
  git: { record: "commit", publish: "push" },
  hg: { record: "commit|ci", publish: "push" },
  jj: { record: "commit|describe|squash", publish: String.raw`git\s+push` },
  darcs: { record: "record|rec|amend", publish: "push" },
} as const;

const RECORDS = new RegExp(
  String.raw`\b(${Object.entries(VCS_COMMANDS)
    .map(([tool, v]) => String.raw`${tool}\s+(${v.record}|${v.publish})`)
    .join("|")})\b`,
);

// Recorded work is the one boundary a tool call shows. A wait is read at the
// turn's end instead, from what Claude Code reports in flight: a tool's input
// misses waits it does not name, such as an Agent call that runs in the
// background by default.
export function boundaryOf(e: Frozen<ToolCallEnvelope>): string | undefined {
  return e.tool === "Bash" && RECORDS.test(e.command)
    ? "work was just recorded"
    : undefined;
}

// What the Stop hook reports in flight, by Claude Code's own account.
export type InFlight = {
  background_tasks?: readonly { id: string; type: string }[];
  session_crons?: readonly { id: string }[];
};

// The background work in flight at a turn's end, by id: tasks and scheduled wakeups.
export function workOf(e: InFlight): string[] {
  return [
    ...(e.background_tasks ?? []).map((t) => `task:${t.id}`),
    ...(e.session_crons ?? []).map((c) => `cron:${c.id}`),
  ];
}

// A wait on background work, from the turn end that first has it in flight.
export type Wait = { work: string[]; at: number };

// The wait a turn's end is part of, given the work in flight at the last turn
// end and now. A wait goes on while any of its work is in flight, and the work
// in flight then joins it; it ends when all of its work has ended (or, in the
// caller, when the person sends a new request). Only work that was not in
// flight at the last turn end starts a new wait, so a long-lived task (a
// monitor, a dev server, a /loop) is one wait, not one per turn.
export function nextWait(
  wait: Wait | undefined,
  lastWork: readonly string[],
  work: readonly string[],
  now: number,
): Wait | undefined {
  if (wait && wait.work.some((id) => work.includes(id)))
    return { ...wait, work: [...work] };
  return work.some((id) => !lastWork.includes(id))
    ? { work: [...work], at: now }
    : undefined;
}

// The wait a turn ends on: background work in flight, or a wakeup scheduled.
export function waitOf(e: InFlight): string | undefined {
  const tasks = e.background_tasks ?? [];
  if (tasks.length > 0) {
    const counts = new Map<string, number>();
    for (const t of tasks) counts.set(t.type, (counts.get(t.type) ?? 0) + 1);
    const what = [...counts].map(([type, n]) => `${n} ${type}`).join(", ");
    return `the turn ends with background work in flight (${what}), so the session will wait for it`;
  }
  if ((e.session_crons?.length ?? 0) > 0)
    return "the turn ends with a wakeup scheduled, so the session may idle until it fires";
  return undefined;
}

export function boundaryNote(
  boundary: string,
  contextTokens: number,
  tool: string,
): string {
  return (
    `[tidy] Before this turn ends: compaction point: ${boundary}, and the context is ${Math.round(contextTokens / 1000)}k tokens. ` +
    `Call ${tool} with a focus naming what the next steps need, or say in one line why not, then end the turn.\nTidy asks this once; it will not block again for it.`
  );
}

// A message from the person, not a slash command, a task notification or a
// wake: typed, sent over the bridge or by the SDK host, or sent by a plugin as
// the person's own words (the threads pane, for one). The threads plugin's
// isPersons is the same rule.
export function isPersonsPrompt(origin: PromptOrigin, text: string): boolean {
  const isPersons =
    origin.kind === "composer" ||
    origin.kind === "bridge" ||
    origin.kind === "sdk" ||
    (origin.kind === "plugin" && origin.asUser === true);
  return isPersons && !text.trimStart().startsWith("/");
}
