import type { EngineInterface } from "claude-code";

// Runs each task after the last one has settled, whether it failed or not.
export function queue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.then(run, run);
    tail = next.catch(() => undefined);
    return next;
  };
}

// A session's log past this size moves to <log>.1, replacing the one before,
// so that it keeps at most about twice this much.
export const LOG_CAP = 5 * 1024 * 1024;

// $.fs has no append. This appends standard input to the file $1 after
// moving it to $1.1 once it holds $2 bytes or more.
export const APPEND_LOG =
  'f=$1; mkdir -p "${f%/*}" && { [ ! -f "$f" ] || [ $(wc -c < "$f") -lt "$2" ] || mv -f "$f" "$f.1"; } && cat >> "$f"';

// Appends a line to a log with one shell run per batch: the lines that come
// while a write is under way go together in the next one. Resolves once the
// line is written, or dropped if the shell cannot run.
const writing = queue();
let batch: string[] = [];

export async function appendLog(
  $: EngineInterface,
  path: string,
  line: string,
) {
  batch.push(line);
  await writing(async () => {
    if (batch.length === 0) return;
    const lines = batch;
    batch = [];
    await $.process.run(["sh", "-c", APPEND_LOG, "sh", path, String(LOG_CAP)], {
      stdin: `${lines.join("\n")}\n`,
    });
  }).catch(() => undefined);
}
