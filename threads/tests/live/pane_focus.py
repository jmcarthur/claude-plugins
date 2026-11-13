"""Checks, in a live Claude Code session, that the threads pane's message field keeps the keyboard
while questions are filed above it.

It starts Claude Code in tmux with only the given threads plugin loaded, opens a thread, focuses the
pane's field, sends from the field a message asking Claude to ask several questions under the
thread with pauses between them, and types one letter a second into the field meanwhile. After every
letter it captures the screen and checks that the field holds every letter typed so far and that
the main prompt holds none.

    python3 -I threads/tests/live/pane_focus.py [--plugin DIR] [--model haiku] [--keep] [--notes]
        [--links] [--split] [--fast]

DIR defaults to the threads plugin folder that holds this script.

It runs on a tmux server of its own (tmux -L pane-focus). --keep leaves the session running for a
look by eye, `tmux -L pane-focus attach`; end it with `tmux -L pane-focus kill-server` and remove
/tmp/pane-focus-scratch and the session's transcript folder, projects/-tmp-pane-focus-scratch under
the Claude Code config folder ($CLAUDE_CONFIG_DIR, or ~/.claude).

The pane keeps its list size in the plugin's store. A plugin loaded from a folder has a store of its
own (plugins/store/threads_inline-*.json under the config folder); the run puts those files back as
it found them when it ends, unless --keep.

Exits 0 on a pass, 1 on a failure, 2 when no question arrived while typing, or when --fast found no
empty field (inconclusive).
"""

import argparse
import json
import os
import re
import shutil
import string
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SESSION = "pane-focus"
SCRATCH = "/tmp/pane-focus-scratch"
CONFIG = os.path.expanduser(os.environ.get("CLAUDE_CONFIG_DIR") or "~/.claude")
TRANSCRIPTS = os.path.join(CONFIG, "projects", "-tmp-pane-focus-scratch")
STORE = os.path.join(CONFIG, "plugins", "store")
STORE_PREFIX = "threads_inline-"
QUESTIONS = 5
FAST = False
NOTES = False
LINKS = False
SPLIT = False
LETTERS = string.ascii_lowercase + string.ascii_uppercase  # no digits: a digit can be a hotkey


def tmux(*args, check=True):
    return subprocess.run(
        ["tmux", "-L", SESSION, *args], check=check, capture_output=True, text=True
    ).stdout


def screen():
    return tmux("capture-pane", "-p", "-t", SESSION)


def keys(*k):
    tmux("send-keys", "-t", SESSION, *k)


def literal(text):
    tmux("send-keys", "-t", SESSION, "-l", text)


def wait_for(pred, what, timeout=90.0):
    end = time.time() + timeout
    while time.time() < end:
        s = screen()
        if pred(s):
            return s
        time.sleep(0.5)
    sys.exit(f"timed out waiting for {what}; last screen:\n{screen()}")


PLACEHOLDERS = ("", "Message this thread…")


def field(s):
    """The pane's focused field's text, or None when no field shows the focused hint."""
    for line in s.splitlines():
        if "⏎ send" in line:
            text = line[: line.index("⏎ send")]
            text = text[text.rfind("│") + 1 :].strip()
            return "" if text in PLACEHOLDERS or text.startswith(NOTE_PLACEHOLDERS) else text
    return None


NOTE_PLACEHOLDERS = ("Note for q", "Answer q")


def click(row, col):
    """A left click at a 0-based screen row and column, as SGR mouse press and release."""
    literal(f"\x1b[<0;{col + 1};{row + 1}M\x1b[<0;{col + 1};{row + 1}m")


def click_last(s, mark):
    """Clicks the last place the screen shows mark; False when it shows none."""
    rows = [(r, l.index(mark)) for r, l in enumerate(s.splitlines()) if mark in l]
    if not rows:
        return False
    click(*rows[-1])
    return True


def prompt(s):
    """The main prompt's text: the last row that starts with the prompt mark."""
    rows = [l for l in s.splitlines() if l.startswith("❯")]
    return rows[-1][1:].strip() if rows else None


def asked(s):
    return sum(f"Probe {i}?" in s for i in range(1, QUESTIONS + 1))


def main():
    ap = argparse.ArgumentParser()
    # This script is at threads/tests/live: the plugin's folder is two up.
    ap.add_argument("--plugin", default=os.path.join(HERE, "..", ".."))
    ap.add_argument("--model", default="haiku")
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--notes", action="store_true",
                    help="after the run, keep a note on the last card through its ✎ by mouse, "
                         "reopen it, Enter it unchanged, and check each reopening shows the note")
    ap.add_argument("--links", action="store_true",
                    help="after the run, have Claude name the thread and a question in a reply's prose, "
                         "and click each reference in the transcript, checking the pane opens it")
    ap.add_argument("--split", action="store_true",
                    help="after the run, drag the divider between the list and the open thread "
                         "by mouse, and press its round ● button, checking the divider moves each time")
    ap.add_argument("--fast", action="store_true",
                    help="after the run, Tab to each empty field and type into it with no delay "
                         "between keys, then backspace it empty, checking what the field shows")
    a = ap.parse_args()
    global FAST, NOTES, LINKS, SPLIT
    FAST, NOTES, LINKS, SPLIT = a.fast, a.notes, a.links, a.split
    plugin = os.path.abspath(a.plugin)

    tmux("kill-session", "-t", SESSION, check=False)
    shutil.rmtree(SCRATCH, ignore_errors=True)
    stored = read_store()
    os.makedirs(SCRATCH)
    settings = {
        "tui": "fullscreen",
        "model": a.model,
        "alwaysThinkingEnabled": False,
        "promptSuggestionEnabled": False,
        "spinnerTipsEnabled": False,
        "autoMemoryEnabled": False,
        "permissions": {
            "allow": [f"mcp__threads__{t}" for t in ("thread", "ask", "file", "settle")]
            + ["Bash(sleep:*)"]
        },
    }
    with open(os.path.join(SCRATCH, "settings.json"), "w") as f:
        json.dump(settings, f)
    # User settings are left out (--setting-sources project), so no installed plugin loads, the
    # installed threads included: only the folder given here.
    cmd = (
        f"claude --setting-sources project --settings {SCRATCH}/settings.json"
        f" --plugin-dir {plugin} --model {a.model} --debug-file {SCRATCH}/debug.log"
    )
    tmux("new-session", "-d", "-s", SESSION, "-x", "200", "-y", "50", "-c", SCRATCH, cmd)
    try:
        return run()
    finally:
        if not a.keep:
            cleanup(stored)


def run():
    has_prompt = lambda s: any(l.startswith("❯") for l in s.splitlines())
    s = wait_for(lambda s: "trust this folder" in s or has_prompt(s), "the first screen")
    if "trust this folder" in s:
        keys("Down")
        time.sleep(0.3)
        keys("Enter")
    wait_for(has_prompt, "the prompt")
    time.sleep(3)

    literal('Open a thread with id probe, title "Focus probe", summary "Testing focus". '
            "Reply with one short line tagged [[probe]].")
    time.sleep(0.5)
    keys("Enter")
    # The reply's tag line draws as a mark naming the thread: wait for that, since the band, which
    # names it too, can be turned off.
    wait_for(
        lambda s: ("● probe" in s or "▸ probe" in s) and "done" in s, "the probe thread"
    )

    literal("/threads probe")
    time.sleep(0.5)
    keys("Enter")
    wait_for(lambda s: "Message this thread…" in s, "the pane")

    # The pane takes the keyboard with its ring on nothing; Tab walks it until the field holds it.
    keys("C-x", "Tab")
    time.sleep(1)
    for tabs in range(1, 21):
        keys("Tab")
        time.sleep(0.7)
        if field(screen()) == "":
            print(f"the field took the keyboard after {tabs} Tab(s)")
            break
    else:
        sys.exit(f"the field never took the keyboard; last screen:\n{screen()}")

    literal(
        "Run Bash `sleep 6`. Then, one at a time, "
        + str(QUESTIONS)
        + " times for N = 1 to "
        + str(QUESTIONS)
        + ': call mcp__threads__ask with thread probe, question "Probe N?", options Yes and No; '
        "then run Bash `sleep 4`. Settle nothing. Then reply `done` tagged [[probe]]."
    )
    time.sleep(0.5)
    keys("Enter")
    # Sending remounts the field and files the message above it: the first place focus can slip.
    failures = []
    time.sleep(3)
    if field(screen()) != "":
        print("FAIL: the field lost the keyboard when the instruction was sent")
        failures.append(("send", 0, field(screen()), prompt(screen())))
    print("sent the instruction from the field; typing one letter a second")

    typed, during = "", 0
    for c in LETTERS:
        before = asked(screen())
        literal(c)
        typed += c
        time.sleep(1)
        s = screen()
        f, p, n = field(s), prompt(s), asked(s)
        during += n > 0
        ok = f == typed and p == ""
        print(f"{c} questions={n} field={f!r} prompt={p!r} {'ok' if ok else 'FAIL'}")
        if not ok:
            failures.append((c, n, f, p))
            with open(os.path.join(SCRATCH, f"fail-{len(typed):02}.txt"), "w") as out:
                out.write(s)
        if n >= QUESTIONS and before >= QUESTIONS and len(typed) >= 10:
            break

    final = screen()
    print(final)
    if failures:
        bad = sum(x[0] != "send" for x in failures)
        print(f"FAIL: {bad} of {len(typed)} checks after a letter found the letters elsewhere")
        return 1
    if asked(final) < 2 or during == 0:
        print(f"INCONCLUSIVE: only {asked(final)} questions arrived while typing")
        return 2
    print(f"PASS: all {len(typed)} letters reached the field while {asked(final)} questions "
          "were filed above it")
    for on, check in ((NOTES, notes), (LINKS, links), (SPLIT, split), (FAST, fast)):
        result = check() if on else 0
        if result != 0:
            return result
    return 0


def notes():
    """Keeps a note on the last card through its ✎ by mouse, picks an option, reopens the note, Enters
    it unchanged, and reopens it again: each reopening must show the note in the field. The engine
    keeps a field's text by key and empties it on Enter, so a field reopened under a used key opens
    empty, which the unit tests cannot see."""
    def step(what, ok):
        print(f"notes: {what} {'ok' if ok else 'FAIL'}")
        if not ok:
            print(screen())
        return ok

    def press_pen():
        ok = click_last(screen(), "✎")
        time.sleep(1.5)
        return ok

    for _ in range(len(LETTERS) + 5):
        keys("BSpace")
    time.sleep(1)
    good = step("✎ clicked", press_pen())
    good &= step("the field took the note's keyboard", field(screen()) == "")
    literal("hello")
    time.sleep(0.5)
    keys("Enter")
    time.sleep(1.5)
    good &= step("Enter kept the note", "Note: hello" in screen())
    good &= step("an option picked", click_last(screen(), "( ) Yes"))
    time.sleep(1.5)
    for n in (1, 2):
        press_pen()
        shown = field(screen())
        good &= step(f"reopening {n} shows the note (field={shown!r})", shown == "hello")
        keys("Enter")
        time.sleep(1.5)
        good &= step(f"Enter {n} unchanged kept it", "Note: hello" in screen())
    print(f"NOTES {'PASS' if good else 'FAIL'}")
    return 0 if good else 1


def dock_column(s):
    """The column of the docked pane's left edge: where most rows show their first │."""
    cols = [l.index("│") for l in s.splitlines() if "│" in l]
    return max(set(cols), key=cols.count) if cols else None


def transcript_at(s, text, after=None):
    """The 0-based row and column where the transcript, left of the docked pane, shows text: of the
    places it shows it, the one furthest left, on a row that shows `after` before it. The prompt's
    rows, which start with its mark, are left out."""
    found = []
    edge = dock_column(s)
    for r, line in enumerate(s.splitlines()):
        if line.startswith("❯"):
            continue
        line = line[:edge]
        start = 0
        if after is not None:
            if after not in line:
                continue
            start = line.index(after)
        if text in line[start:]:
            found.append((line.index(text, start), r))
    if not found:
        return None
    col, row = min(found)
    return row, col


def list_alone(s):
    """Whether the pane shows the list alone: its stats line, and no thread below it."""
    return "waiting on you ·" in s and "[[probe]] · open" not in s and divider_row(s) is None


def press_probe_row(s):
    """Clicks the probe thread's row in the pane's list, by its title; False when the list shows none.
    With the thread open below it, the press closes the thread."""
    col = dock_column(s) or 0
    rows = [(r, l.index("Focus probe", col)) for r, l in enumerate(s.splitlines())
            if "Focus probe" in l[col:]]
    if not rows:
        return False
    click(*rows[0])
    return True


def travel_at(s):
    """The 0-based row and column of the pane's Back, drawn `← →` with Forward beside it."""
    for r, line in enumerate(s.splitlines()):
        if "← →" in line:
            return r, line.index("← →")
    return None


def links():
    """Has Claude reply with the thread and a question named in its prose, then from the pane's list
    clicks each reference in the transcript: the thread's must open the thread, the question's its
    subthread. A reference drawn as anything but its own text (escapes showing) is not found."""
    def step(what, ok):
        print(f"links: {what} {'ok' if ok else 'FAIL'}")
        if not ok:
            print(screen())
        return ok

    def until(pred, timeout=20.0):
        end = time.time() + timeout
        while time.time() < end:
            if pred(screen()):
                return True
            time.sleep(0.5)
        return False

    # The field is the thread's, holding what the run typed: empty it and send the request from it.
    for _ in range(len(LETTERS) + 5):
        keys("BSpace")
    time.sleep(1)
    # Short enough that the prompt's row does not wrap, so only the reply's rows are searched.
    literal("Reply with one line, calling no tool: REFLINK see [[probe]] and q1 here.")
    time.sleep(0.5)
    keys("Enter")
    # The question may come back as q1 or [[q1]]: either is a reference.
    good = step("the reply names the thread and q1",
                until(lambda s: transcript_at(s, "[[probe]]", "REFLINK") is not None
                      and transcript_at(s, "q1", "REFLINK") is not None, 90))
    time.sleep(3)
    good &= step("the pane went to the list", press_probe_row(screen())
                 and until(list_alone))
    at = transcript_at(screen(), "[[probe]]", "REFLINK")
    good &= step("clicked [[probe]] in the reply", at is not None)
    if at is not None:
        click(at[0], at[1] + 2)
        good &= step("the pane opened the thread", until(lambda s: "[[probe]] · open" in s))
    good &= step("the pane went to the list again", press_probe_row(screen())
                 and until(list_alone))
    at = transcript_at(screen(), "q1", "REFLINK")
    good &= step("clicked q1 in the reply", at is not None)
    if at is not None:
        click(at[0], at[1])
        good &= step("the pane opened q1's subthread", until(lambda s: "q1 in [[probe]]" in s))
    # The pane went list, thread, list, subthread: Back twice reaches the thread, Forward the list.
    for move, shows, what in (("back", list_alone, "the list"),
                              ("back", lambda s: "[[probe]] · open" in s, "the thread"),
                              ("forward", list_alone, "the list")):
        at = travel_at(screen())
        good &= step(f"{move} pressed", at is not None)
        if at is not None:
            click(at[0], at[1] + (0 if move == "back" else 2))
            good &= step(f"{move} went to {what}", until(shows))
    print(f"LINKS {'PASS' if good else 'FAIL'}")
    return 0 if good else 1


DIVIDER = re.compile("══[^●]*●")


def divider_row(s):
    """The 0-based row of the divider between the list and the open thread, a double rule with the
    round auto-size button at its end; None when the pane is not split."""
    rows = [r for r, l in enumerate(s.splitlines()) if DIVIDER.search(l)]
    return rows[0] if rows else None


def split():
    """Opens the probe thread under the list if it is not, presses the divider's round button to size
    the list automatically, drags the divider up a row by mouse (SGR press, motion with the left
    button held, release), then presses the round button again: the divider must move up a row, then
    back down. The list holds main and probe, two rows, which is its automatic size."""
    def step(what, ok):
        print(f"split: {what} {'ok' if ok else 'FAIL'}")
        if not ok:
            print(screen())
        return ok

    def until(pred, timeout=10.0):
        end = time.time() + timeout
        while time.time() < end:
            if pred(screen()):
                return True
            time.sleep(0.3)
        return False

    s = screen()
    good = True
    if divider_row(s) is None:
        rows = [(r, l.index("Focus probe", dock_column(s) or 0))
                for r, l in enumerate(s.splitlines()) if "Focus probe" in l[dock_column(s) or 0:]]
        good &= step("the probe row found in the list", bool(rows))
        if rows:
            click(*rows[0])
    good &= step("the pane split under the list", until(lambda s: divider_row(s) is not None))
    r0 = divider_row(screen())
    if r0 is None:
        print("SPLIT FAIL")
        return 1

    def press_auto(at):
        # A click soon after the last one can be lost, as a double click's second: wait it out.
        time.sleep(1)
        line = screen().splitlines()[at]
        click(at, DIVIDER.search(line).end() - 1)

    # The list's rows are kept in the plugin's store from run to run: with a row of its two hidden,
    # the round button gives it its automatic size, both rows, first.
    if "above" in screen().splitlines()[r0]:
        press_auto(r0)
        good &= step("the round button sized the list to its rows",
                     until(lambda s: divider_row(s) == r0 + 1))
        r0 += 1
        time.sleep(1)
    col = (dock_column(screen()) or 0) + 8
    literal(f"\x1b[<0;{col + 1};{r0 + 1}M")
    time.sleep(0.3)
    literal(f"\x1b[<32;{col + 1};{r0}M")
    time.sleep(0.5)
    literal(f"\x1b[<0;{col + 1};{r0}m")
    good &= step(f"dragged up a row from row {r0}", until(lambda s: divider_row(s) == r0 - 1))
    press_auto(r0 - 1)
    good &= step("the round button moved it back down", until(lambda s: divider_row(s) == r0))
    print(f"SPLIT {'PASS' if good else 'FAIL'}")
    return 0 if good else 1


FAST_TEXT = "the quick brown fox jumps"


def fast():
    """Types into each empty field Tab reaches, one key per send-keys call and no delay between them,
    then sends as many backspaces, and checks the field ends on the text and then empty."""
    # Clear the field the run typed into first, so it counts as empty too.
    for _ in range(len(LETTERS) + 5):
        keys("BSpace")
    time.sleep(1)
    failures, checked = 0, 0
    for tab in range(40):
        if checked >= 3:
            break
        keys("Tab")
        time.sleep(0.7)
        s = screen()
        if field(s) != "":
            continue
        for c in FAST_TEXT:
            literal(c)
        time.sleep(1.5)
        typed = field(screen())
        for _ in FAST_TEXT:
            keys("BSpace")
        time.sleep(1.5)
        emptied = field(screen())
        # A text past twice the field's width must wrap, every key of it on screen: the engine cuts a
        # field inset too far with an ellipsis instead.
        long = " ".join([FAST_TEXT] * 8) + " END-OF-LONG"
        literal(long)
        time.sleep(1.5)
        shown = "END-OF-LONG" in screen()
        for _ in long:
            keys("BSpace")
        time.sleep(1.5)
        ok = typed == FAST_TEXT and emptied == "" and shown
        checked += 1
        failures += not ok
        print(f"fast field {checked} (Tab {tab + 1}): typed={typed!r} emptied={emptied!r} long={shown} "
              f"{'ok' if ok else 'FAIL'}")
    if checked == 0:
        print("FAST INCONCLUSIVE: Tab reached no empty field")
        return 2
    print(f"FAST {'FAIL' if failures else 'PASS'}: {checked - failures} of {checked} fields kept "
          "fast typing and fast backspaces")
    return 1 if failures else 0


def read_store():
    """The stores of threads plugins loaded from a folder, by name, as bytes."""
    try:
        names = [n for n in os.listdir(STORE) if n.startswith(STORE_PREFIX)]
    except FileNotFoundError:
        return {}
    stored = {}
    for name in names:
        with open(os.path.join(STORE, name), "rb") as f:
            stored[name] = f.read()
    return stored


def restore_store(stored):
    """Puts the stores back as read_store found them: the run's list size and the probe session's
    threads go, and a store the run made is removed."""
    for name in set(read_store()) - set(stored):
        os.remove(os.path.join(STORE, name))
    for name, data in stored.items():
        with open(os.path.join(STORE, name), "wb") as f:
            f.write(data)


def cleanup(stored):
    tmux("kill-server", check=False)
    shutil.rmtree(SCRATCH, ignore_errors=True)
    # The session's transcript folder, named after the scratch folder.
    shutil.rmtree(TRANSCRIPTS, ignore_errors=True)
    restore_store(stored)


if __name__ == "__main__":
    sys.exit(main())
