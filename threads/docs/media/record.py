"""Records the threads README's GIF: python3 -I threads/docs/media/record.py

It runs Claude Code in kitty on a virtual X display (Xvfb), with only this threads plugin loaded
and only the settings in settings.json, in a copy of project/ under /tmp/threads-demo. It types the
user's request, then works the pane with the mouse: the pointer moves and clicks through XTest,
and ffmpeg records the display with the pointer drawn. The waits for the model are cut out.

Needs Xvfb, kitty, ffmpeg, the Adwaita cursor theme, and a logged-in Claude Code. It makes a few
model calls, and Claude's replies differ from run to run, so look at each frame before keeping a
take. Claude Code remembers that you trusted /tmp/threads-demo/project.

A plugin loaded from a folder keeps its own store, plugins/store/threads_inline-*.json under the
Claude Code config folder (CLAUDE_CONFIG_DIR, or ~/.claude). The run puts those files back as it
found them when it ends.

Writes demo.gif next to this file. --keep leaves the scratch folder
with the raw segments.
"""

import ctypes
import glob
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(os.path.dirname(HERE))
SCRATCH = "/tmp/threads-demo"
PROJECT = os.path.join(SCRATCH, "project")
SOCK = os.path.join(SCRATCH, "kitty.sock")
CONFIG = os.path.expanduser(os.environ.get("CLAUDE_CONFIG_DIR") or "~/.claude")
STORE = os.path.join(CONFIG, "plugins", "store")
WIDTH, HEIGHT = 1600, 1200
FPS = 20
MODEL = "opus"
REQUEST = (
    "Two things: the CSV export drops its last row, can you fix it? And the timestamp parsing "
    "in timestamps.py is fragile, so I'd like to switch to a date library. Give me the options "
    "to pick from."
)
DONE = re.compile(r"for \d+s · done")


def last_done(text):
    """The last note that a turn is done, such as "Brewed for 24s · done 3:02 PM"."""
    notes = re.findall(r"\S+ for \d+s · done \d+:\d+(?: [AP]M)?", text)
    return notes[-1] if notes else None


def running(text):
    """Whether a turn runs: the footer then offers "esc to interrupt"."""
    return "esc to interrupt" in text


def free_display():
    n = 70
    while os.path.exists(f"/tmp/.X11-unix/X{n}") or os.path.exists(f"/tmp/.X{n}-lock"):
        n += 1
    return f":{n}"


class Screen:
    """The kitty window: its text, and a pointer and keyboard driven through XTest and kitty."""

    def __init__(self, display, env):
        self.display, self.env = display, env
        self.x11 = ctypes.CDLL("libX11.so.6")
        self.xtst = ctypes.CDLL("libXtst.so.6")
        self.x11.XOpenDisplay.restype = ctypes.c_void_p
        self.dpy = ctypes.c_void_p(self.x11.XOpenDisplay(display.encode()))
        self.pos = (WIDTH * 3 // 4, HEIGHT // 3)
        self._move(*self.pos)

    def kitty(self, *args):
        return subprocess.run(["kitty", "@", "--to", f"unix:{SOCK}", *args],
                              capture_output=True, text=True, env=self.env, check=True).stdout

    def lines(self):
        return self.kitty("get-text", "--extent", "screen").split("\n")

    def text(self):
        return "\n".join(self.lines())

    def cell(self):
        w = json.loads(self.kitty("ls"))[0]["tabs"][0]["windows"][0]
        return WIDTH // w["columns"], HEIGHT // w["lines"]

    def wait(self, test, what, timeout=300):
        end = time.time() + timeout
        while time.time() < end:
            s = self.text()
            if "Do you want to proceed?" in s:
                raise SystemExit(f"A permission prompt appeared while waiting for {what}:\n{s}")
            if test(s):
                return s
            time.sleep(0.5)
        raise SystemExit(f"Timed out waiting for {what}. The screen:\n{s}")

    def find(self, pattern, right_of=0, quiet=False):
        """The pixel centre of the first match of pattern at or right of column right_of."""
        cw, ch = self.cell()
        for row, line in enumerate(self.lines()):
            for m in re.finditer(pattern, line):
                if m.start() >= right_of:
                    col = (m.start() + m.end()) / 2
                    return int(col * cw), int((row + 0.5) * ch)
        if quiet:
            raise LookupError(pattern)
        raise SystemExit(f"Not on screen: {pattern}\n{self.text()}")

    def divider(self):
        """The column of the pane's left border, the one most rows draw │ in."""
        counts = {}
        for line in self.lines():
            for i, c in enumerate(line):
                if c == "│":
                    counts[i] = counts.get(i, 0) + 1
        return max(counts, key=counts.get) if counts else 0

    def list_ids(self):
        """The thread ids in the pane's list, from its header row down to its rule."""
        pane, ids, inside = self.divider(), [], False
        for line in self.lines():
            part = line[pane + 1:]
            if inside and "═" in part:
                break
            if inside:
                ids += [t for t in part.split()[:4] if re.fullmatch(r"[a-z0-9][a-z0-9-]+", t)][:1]
            inside = inside or (" id " in part and "title" in part)
        return ids

    def _move(self, x, y):
        self.xtst.XTestFakeMotionEvent(self.dpy, -1, int(x), int(y), 0)
        self.x11.XFlush(self.dpy)

    def glide(self, x, y, seconds=0.7):
        x0, y0 = self.pos
        steps = int(seconds * 60)
        for i in range(1, steps + 1):
            t = i / steps
            e = t * t * (3 - 2 * t)
            self._move(x0 + (x - x0) * e, y0 + (y - y0) * e)
            time.sleep(seconds / steps)
        self.pos = (x, y)

    def click(self, x, y):
        self.glide(x, y)
        time.sleep(0.25)
        self.xtst.XTestFakeButtonEvent(self.dpy, 1, 1, 0)
        self.x11.XFlush(self.dpy)
        time.sleep(0.08)
        self.xtst.XTestFakeButtonEvent(self.dpy, 1, 0, 0)
        self.x11.XFlush(self.dpy)

    def wheel(self, up, notches=1):
        button = 4 if up else 5
        for _ in range(notches):
            self.xtst.XTestFakeButtonEvent(self.dpy, button, 1, 0)
            self.xtst.XTestFakeButtonEvent(self.dpy, button, 0, 0)
            self.x11.XFlush(self.dpy)
            time.sleep(0.12)

    def scroll_to(self, pattern, right_of, up):
        """Scrolls the pane under the pointer until pattern shows right of column right_of."""
        for _ in range(60):
            try:
                return self.find(pattern, right_of, quiet=True)
            except LookupError:
                self.wheel(up)
        raise SystemExit(f"Scrolled without finding: {pattern}\n{self.text()}")

    def type(self, text, delay=0.015):
        for c in text:
            self.kitty("send-text", "--", c)
            time.sleep(delay)

    def key(self, seq):
        self.kitty("send-text", "--", seq)


class Recorder:
    """Records the display in segments, so that the waits between them are cut out."""

    def __init__(self, display, env):
        self.display, self.env, self.segments, self.proc = display, env, [], None

    def start(self):
        path = os.path.join(SCRATCH, f"seg{len(self.segments)}.mkv")
        self.segments.append(path)
        self.proc = subprocess.Popen(
            ["ffmpeg", "-v", "error", "-y", "-f", "x11grab", "-draw_mouse", "1", "-framerate",
             str(FPS), "-video_size", f"{WIDTH}x{HEIGHT}", "-i", self.display, "-c:v", "libx264",
             "-crf", "0", "-preset", "ultrafast", path],
            stdin=subprocess.PIPE, env=self.env)
        time.sleep(0.5)

    def stop(self):
        self.proc.communicate(b"q")
        self.proc = None

    def gif(self, name):
        listing = os.path.join(SCRATCH, "segments.txt")
        with open(listing, "w") as f:
            f.writelines(f"file '{p}'\n" for p in self.segments)
        joined = os.path.join(SCRATCH, "joined.mkv")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i",
                        listing, "-c", "copy", joined], check=True)
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", joined, "-vf",
             "fps=10,scale=1200:-1:flags=lanczos,split[a][b];"
             "[a]palettegen=max_colors=64:stats_mode=diff[p];"
             "[b][p]paletteuse=dither=none:diff_mode=rectangle",
             os.path.join(HERE, name)],
            check=True)


def read_store():
    return {p: open(p, "rb").read() for p in glob.glob(os.path.join(STORE, "threads_inline-*.json"))}


def restore_store(saved):
    for p in glob.glob(os.path.join(STORE, "threads_inline-*.json")):
        if p not in saved:
            os.remove(p)
    for p, data in saved.items():
        with open(p, "wb") as f:
            f.write(data)


def setup_project():
    shutil.rmtree(SCRATCH, ignore_errors=True)
    shutil.copytree(os.path.join(HERE, "project"), PROJECT)
    shutil.copy(os.path.join(HERE, "settings.json"), SCRATCH)
    git = ["git", "-C", PROJECT]
    subprocess.run([*git, "init", "-q"], check=True)
    subprocess.run([*git, "add", "-A"], check=True)
    subprocess.run([*git, "-c", "user.name=demo", "-c", "user.email=demo@example.com",
                    "commit", "-qm", "Start"], check=True)


def demo_env(display):
    # Run from inside a Claude Code session, the demo would inherit that session's markers (and,
    # with them, no transcript saving). Keep only the config folders.
    keep = {"CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"}
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE") or k in keep}
    env.update(DISPLAY=display, XCURSOR_THEME="Adwaita", XCURSOR_SIZE="32")
    return env


def scene(screen, rec):
    has_prompt = lambda s: "accept edits on" in s
    s = screen.wait(lambda s: "trust this folder" in s or has_prompt(s), "the first screen")
    if "trust this folder" in s:
        screen.key("\x1b[B")
        time.sleep(0.3)
        screen.key("\r")
    screen.wait(has_prompt, "the prompt")
    time.sleep(2)
    screen.type("/threads", 0)
    screen.key("\r")
    screen.wait(lambda s: "waiting on you" in s, "the pane")
    time.sleep(1)

    # The request, typed.
    rec.start()
    time.sleep(1)
    screen.type(REQUEST)
    time.sleep(0.8)
    screen.key("\r")
    time.sleep(2.5)
    rec.stop()
    screen.wait(lambda s: DONE.search(s) and "date-library" in s, "the reply", 400)
    time.sleep(2)

    # The reply split into threads. The band's row for the question opens its thread at the card.
    rec.start()
    time.sleep(2.5)
    try:
        row = screen.find(r"\?\d+\W+[a-z0-9-]+ .*librar", quiet=True)
    except LookupError:
        row = screen.find(r"\?\d+\W+[a-z0-9-]+ ")
    screen.click(*row)
    screen.wait(lambda s: "Message this thread" in s, "the thread view", 15)
    time.sleep(2)
    pane = screen.divider()

    # Scroll up to the recommended option, pick it, scroll down to Send, and send.
    screen.glide(*screen.find(r"Message this thread", pane))
    screen.glide(screen.pos[0], screen.pos[1] - 200, 0.4)
    # The thread opens at its first unread entry; the card is further down.
    screen.scroll_to(r"Pick one", pane, up=False)
    screen.wheel(up=False, notches=3)
    try:
        option = screen.find(r"\( \) [^│]*\(recommended\)", pane, quiet=True)
    except LookupError:
        option = screen.find(r"\( \) ", pane)
    screen.click(*option)
    time.sleep(1)
    screen.click(*screen.scroll_to(r"Send 1 answer", pane, up=False))
    time.sleep(2.5)
    rec.stop()
    # The answer's turn has ended once its spinner, seen running, is gone and a done note shows.
    screen.wait(running, "the answer's turn to start", 60)
    screen.wait(lambda s: not running(s) and last_done(s), "the answer's turn", 400)
    time.sleep(2)

    # The question settled; then look at the other thread.
    rec.start()
    time.sleep(3)
    pane = screen.divider()
    other = next(i for i in screen.list_ids() if i != "main" and "librar" not in i and "date" not in i)
    screen.click(*screen.find(re.escape(other), pane))
    time.sleep(3)
    rec.stop()


def main():
    keep = "--keep" in sys.argv
    # A stop by signal still restores the store and stops the display.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(1))
    saved = read_store()
    setup_project()
    display = free_display()
    env = demo_env(display)
    xvfb = subprocess.Popen(["Xvfb", display, "-screen", "0", f"{WIDTH}x{HEIGHT}x24",
                             "-nolisten", "tcp"], stderr=subprocess.DEVNULL)
    kitty = None
    try:
        time.sleep(1)
        claude = (f"claude --setting-sources project"
                  f" --settings {SCRATCH}/settings.json"
                  f" --plugin-dir {PLUGIN} --model {MODEL}")
        kitty = subprocess.Popen(
            ["kitty", "--config", "NONE", "-o", "font_size=13", "-o", "window_padding_width=0",
             "-o", "mouse_hide_wait=0", "-o", "default_pointer_shape=arrow",
             "-o", "pointer_shape_when_grabbed=arrow", "-o", "allow_remote_control=yes",
             "-o", f"initial_window_width={WIDTH}", "-o", f"initial_window_height={HEIGHT}",
             "-o", "remember_window_size=no", "-o", "linux_display_server=x11",
             "--listen-on", f"unix:{SOCK}", "--directory", PROJECT, "sh", "-c", claude],
            env=env, stderr=subprocess.DEVNULL)
        time.sleep(3)
        screen = Screen(display, env)
        rec = Recorder(display, env)
        scene(screen, rec)
        rec.gif("demo.gif")
    finally:
        if kitty:
            kitty.terminate()
            kitty.wait(10)
            # Claude Code saves the session as it exits, after its terminal closes.
            time.sleep(5)
        xvfb.terminate()
        restore_store(saved)
        if not keep:
            shutil.rmtree(SCRATCH, ignore_errors=True)


if __name__ == "__main__":
    main()
