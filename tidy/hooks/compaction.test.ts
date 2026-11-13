import { expect, test } from "claude-code/testing";
import {
  boundaryOf,
  isPersonsPrompt,
  nextWait,
  waitOf,
  workOf,
} from "./compaction";

const bash = (input: { command: string; run_in_background?: boolean }) => ({
  tool: "Bash" as const,
  tool_use_id: "t",
  ...input,
});

test("a tool call's boundary is recorded work, and nothing else", () => {
  for (const command of [
    "git commit -m x",
    "git push origin main",
    "hg commit -m x",
    "jj commit -m x",
    "jj git push",
    "darcs record -a -m x",
    "darcs push -a",
  ])
    expect(boundaryOf(bash({ command }))).toContain("recorded");
  expect(boundaryOf(bash({ command: "git status" }))).toBe(undefined);
  expect(boundaryOf(bash({ command: "ls", run_in_background: true }))).toBe(
    undefined,
  );
  expect(
    boundaryOf({
      tool: "Agent",
      tool_use_id: "t",
      prompt: "git commit -m x",
      description: "x",
    } as never),
  ).toBe(undefined);
});

test("a turn's wait is the background work in flight at its end, or a scheduled wakeup", () => {
  expect(
    waitOf({
      background_tasks: [
        { id: "a", type: "subagent" },
        { id: "b", type: "shell" },
        { id: "c", type: "subagent" },
      ],
      session_crons: [{ id: "w" }],
    }),
  ).toBe(
    "the turn ends with background work in flight (2 subagent, 1 shell), so the session will wait for it",
  );
  expect(
    waitOf({ background_tasks: [], session_crons: [{ id: "w" }] }),
  ).toContain("wakeup scheduled");
  expect(waitOf({ background_tasks: [], session_crons: [] })).toBe(undefined);
  expect(waitOf({})).toBe(undefined);
});

test("a person's prompt is one typed, sent over the bridge or by the SDK host, or sent by a plugin as the person's, and not a slash command", () => {
  expect(isPersonsPrompt({ kind: "composer" } as never, "hi")).toBe(true);
  expect(isPersonsPrompt({ kind: "bridge" } as never, "hi")).toBe(true);
  expect(isPersonsPrompt({ kind: "sdk" }, "hi")).toBe(true);
  expect(
    isPersonsPrompt({ kind: "plugin", name: "threads", asUser: true }, "hi"),
  ).toBe(true);
  expect(isPersonsPrompt({ kind: "plugin", name: "runway" }, "go on")).toBe(
    false,
  );
  expect(isPersonsPrompt({ kind: "composer" } as never, " /compact")).toBe(
    false,
  );
  expect(isPersonsPrompt({ kind: "notification" } as never, "done")).toBe(
    false,
  );
});

test("a wait lasts while any of its work is in flight, and only work new since the last turn end starts one", () => {
  const work = workOf({
    background_tasks: [{ id: "m", type: "monitor" }],
    session_crons: [{ id: "l" }],
  });
  expect(work).toEqual(["task:m", "cron:l"]);
  const started = nextWait(undefined, [], work, 1);
  expect(started).toEqual({ work, at: 1 });
  // The same work at later turn ends is the same wait, with the work that joined it.
  expect(nextWait(started, work, [...work, "task:s"], 2)).toEqual({
    work: [...work, "task:s"],
    at: 1,
  });
  // Ended (by the person's new request) while its work runs on: no new wait for that work.
  expect(nextWait(undefined, work, work, 3)).toBe(undefined);
  // All of its work ended: new work starts a new wait, and none ends it.
  expect(nextWait(started, work, ["task:n"], 4)).toEqual({
    work: ["task:n"],
    at: 4,
  });
  expect(nextWait(started, work, [], 5)).toBe(undefined);
});
