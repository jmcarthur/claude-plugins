"""Takes the rootcause README's screenshot: python3 -I rootcause/docs/media/screenshot.py

It records a made-up analysis with this plugin's rootcause command in a scratch ROOTCAUSE_DIR
under /tmp, serves the web UI from there on a spare port, and has headless Chrome take a picture
of the analysis's page. Your own analyses and server are not touched.

Needs python3 and Google Chrome or Chromium. Writes analysis.png next to this file. --keep leaves
the scratch folder.
"""

import datetime
import glob
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
COMMAND = os.path.join(HERE, "..", "..", "bin", "rootcause")
# The window in CSS pixels; the picture is twice as large, so it stays sharp when scaled down.
WIDTH, HEIGHT, SCALE = 1400, 980, 2

# The analysis, one rootcause call per item: (subcommand, input).
STEPS = [
    ("start", """\
symptom: The daily orders CSV is missing the last order of each day
"""),
    ("answer", """\
combine: any
evidence E1: export() over a list of three orders writes a header and two rows
evidence E2: The orders query returns every order of the day, the last included
cause: export() loops over rows[:-1], so it never writes the last row
cites: E1
status: checked
effects: The refunds export calls export() too, and also loses its last row
reach: fix
fix: removes
change: Loop over rows
proportion: A one-word change that restores every caller's last row
cause: The orders query's LIMIT cuts off the last order
cites: E2
status: refuted
"""),
    ("answer", """\
step: 1
evidence E3: The change that added the slice is named "Skip the reader's blank trailing row"
evidence E4: The reader's tests show it no longer returns a blank trailing row
cause: The slice was written to skip a blank row that the reader once added at the end
cites: E3, E4
status: checked
effects: none
reach: changeable
"""),
    ("answer", """\
step: 1.1
combine: all
cause: The reader stopped adding the blank row, and nothing searched for code that skipped it
cites: E4
status: checked
effects: none
reach: stop
cause: No test checks that export() writes every row it is given
evidence: The export tests only check the header
status: checked
effects: The refunds export has no such test either
reach: fix
fix: removes
change: Add a test that export() writes every row
proportion: One short test guards both exports
"""),
    ("answer", """\
step: 1.1.2
cause: The tests were written from the header's bug report, and no one widened them
evidence: The test file's only change is the one that fixed the header
status: checked
effects: none
reach: stop
"""),
    ("conclude", """\
leftAlone: 1.1.1
reason: The reader's change is long past; the test at 1.1.2 catches the next slip of its kind
leftAlone: 1.1.2.1
reason: No deeper cause is worth naming: the tests matched the bug they were written for
avoidable: A change to the reader's output went in without a search for the code that relied on it
avoid: List the reader's callers in its docstring, so a change to its output names what to check
worth: yes
why: A few lines of docstring against a silent data loss in every export
"""),
]


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def chrome():
    for name in ("google-chrome-stable", "google-chrome", "chromium", "chromium-browser"):
        path = shutil.which(name)
        if path:
            return path
    sys.exit("Needs Google Chrome or Chromium.")


def run(env, sub, text, *args):
    p = subprocess.run([sys.executable, "-I", COMMAND, sub, *args], input=text, env=env,
                       cwd=env["HOME"], capture_output=True, text=True)
    if p.returncode:
        sys.exit(f"rootcause {sub} refused:\n{p.stderr}")
    return p.stdout


def retime(folder):
    """Spreads the record's times, all made within a second, over half an hour from 14:00 UTC.

    The page colours each step by the order its cause was added, and shows the first and last
    times, so a few minutes between answers reads as an agent at work."""
    (path,) = glob.glob(os.path.join(folder, "*.json"))
    with open(path) as f:
        text = f.read()
    stamps = sorted(set(re.findall(r'"(\d{4}-\d\d-\d\dT[^"]+)"', text)))
    first = datetime.datetime.fromisoformat(stamps[0])
    base = first.replace(hour=14, minute=0, second=0, microsecond=0)
    for i, stamp in enumerate(stamps):
        new = base + datetime.timedelta(minutes=6 * i, seconds=37 * i)
        text = text.replace(f'"{stamp}"', f'"{new.isoformat()}"')
    json.loads(text)
    with open(path, "w") as f:
        f.write(text)


def main():
    keep = "--keep" in sys.argv[1:]
    scratch = tempfile.mkdtemp(prefix="rootcause-shot-")
    port = free_port()
    # Only what the command needs: no session id, so the analysis belongs to no session.
    # HOME is the scratch folder too, so the record's working directory names nothing of yours.
    env = {"PATH": os.environ["PATH"], "HOME": scratch, "TZ": "UTC",
           "ROOTCAUSE_DIR": os.path.join(scratch, "rootcause"), "ROOTCAUSE_PORT": str(port)}
    server = None
    try:
        out = run(env, *STEPS[0])
        ident = out.split()[1].rstrip(".")
        for sub, text in STEPS[1:]:
            run(env, sub, text, ident)
        retime(os.path.join(scratch, "rootcause", "analyses"))
        server = subprocess.Popen([sys.executable, "-I", COMMAND, "serve"], env=env,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        url = f"http://127.0.0.1:{port}/a/{ident}"
        for _ in range(50):
            try:
                urllib.request.urlopen(url, timeout=1).close()
                break
            except OSError:
                time.sleep(0.1)
        out_png = os.path.join(HERE, "analysis.png")
        subprocess.run(
            [chrome(), "--headless=new", "--disable-gpu", "--hide-scrollbars",
             f"--user-data-dir={os.path.join(scratch, 'chrome')}",
             f"--window-size={WIDTH},{HEIGHT}", f"--force-device-scale-factor={SCALE}",
             # The page keeps an event stream open, so a virtual time budget never runs out.
             "--timeout=4000",
             f"--screenshot={out_png}", url],
            env={**os.environ, "TZ": "UTC"}, check=True, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, timeout=60)
        print(f"Wrote {out_png}")
    finally:
        if server:
            server.terminate()
            server.wait()
        if keep:
            print(f"Kept {scratch}")
        else:
            shutil.rmtree(scratch)


if __name__ == "__main__":
    main()
