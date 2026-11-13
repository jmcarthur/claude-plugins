import { expect, test } from "claude-code/testing";
import { APPEND_LOG, appendLog } from "./log";

const ran = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  isStdoutTruncated: false,
  isStderrTruncated: false,
};

test("log lines are appended by one shell run per batch, which rotates the log past 5 MB", async () => {
  const runs: { argv: readonly string[]; stdin?: string }[] = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const $ = {
    process: {
      run: async (argv: readonly string[], init?: { stdin?: string }) => {
        runs.push({ argv, stdin: init?.stdin });
        if (runs.length === 1) await held;
        return ran;
      },
    },
  } as never;
  const first = appendLog($, "/logs/s.jsonl", "a");
  for (let k = 0; k < 10 && runs.length === 0; k++) await Promise.resolve();
  // Lines that come while the first write is under way go together in the next.
  const rest = [
    appendLog($, "/logs/s.jsonl", "b"),
    appendLog($, "/logs/s.jsonl", "c"),
  ];
  release();
  await Promise.all([first, ...rest]);
  expect(runs).toEqual([
    {
      argv: ["sh", "-c", APPEND_LOG, "sh", "/logs/s.jsonl", "5242880"],
      stdin: "a\n",
    },
    {
      argv: ["sh", "-c", APPEND_LOG, "sh", "/logs/s.jsonl", "5242880"],
      stdin: "b\nc\n",
    },
  ]);
});

test("a log line that the shell cannot write is dropped without an error", async () => {
  const $ = {
    process: {
      run: async () => {
        throw new Error("no sh");
      },
    },
  } as never;
  await appendLog($, "/logs/s.jsonl", "a");
});
