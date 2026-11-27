#!/usr/bin/env python3
"""make_demo_gif.py —— 录一段 Alpine 登录后跑网络的终端 GIF。

流程：pty 里启动 build/sim build/firmware.bin，等 `login:` 出现（不录引导），
自动输入 root，再逐字敲命令并录制屏幕，最后存成 GIF：

    python3 tools/make_demo_gif.py \
        --sim build/sim --fw build/firmware.bin \
        --out docs/img/net-demo.gif

默认命令：ifconfig sl0 / ping qq.com / wget https://qq.com/。
需要 Pillow 和 DejaVuSansMono 字体；GIF 是 100x30 字符、约 15 秒。
"""
import argparse
import codecs
import fcntl
import os
import pty
import select
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# 16 色 ANSI（深色背景）
PALETTE = [
    "#1b1f27", "#e06c75", "#98c379", "#e5c07b",
    "#61afef", "#c678dd", "#56b6c2", "#dcdfe4",
    "#5c6370", "#ff7b86", "#b5e890", "#ffd68a",
    "#7cc5ff", "#e29bff", "#7ee7f0", "#ffffff",
]
DEFAULT_FG = "#d6deeb"
DEFAULT_BG = "#14161a"


class Term:
    """够用的 VT100 子集：光标、换行滚动、CSI H/A-D/J/K/L/M、SGR 颜色。"""

    def __init__(self, cols, rows):
        self.cols, self.rows = cols, rows
        self.grid = [[(" ", 7, None) for _ in range(cols)] for _ in range(rows)]
        self.r = self.c = 0
        self.fg, self.bg, self.bold = 7, None, False
        self.saved = (0, 0)
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.state = "normal"
        self.csi = ""

    def feed(self, data):
        for ch in self.decoder.decode(data):
            self._char(ch)

    def _char(self, ch):
        if self.state == "osc":
            if ch == "\x07":
                self.state = "normal"
            elif ch == "\x1b":
                self.state = "esc"
            return
        if self.state == "esc":
            if ch == "[":
                self.state, self.csi = "csi", ""
            elif ch == "]":
                self.state = "osc"
            elif ch == "7":
                self.saved = (self.r, self.c); self.state = "normal"
            elif ch == "8":
                self.r, self.c = self.saved; self.state = "normal"
            elif ch in "()#":
                self.state = "skip1"
            else:
                self.state = "normal"
            return
        if self.state == "skip1":
            self.state = "normal"
            return
        if self.state == "csi":
            if "\x40" <= ch <= "\x7e":
                self.state = "normal"
                self._csi(ch, self.csi)
            else:
                self.csi += ch
            return
        if ch == "\x1b":
            self.state = "esc"
            return
        if ch == "\r":
            self.c = 0
        elif ch == "\n":
            self._lf()
        elif ch == "\b":
            if self.c > 0:
                self.c -= 1
        elif ch == "\t":
            self.c = min(self.cols - 1, (self.c // 8 + 1) * 8)
        elif ch >= " ":
            if self.c >= self.cols:
                self.c = 0
                self._lf()
            self.grid[self.r][self.c] = (ch, self.fg, self.bg)
            self.c += 1

    def _lf(self):
        if self.r == self.rows - 1:
            self.grid.pop(0)
            self.grid.append([(" ", 7, None) for _ in range(self.cols)])
        else:
            self.r += 1

    def _csi(self, final, params):
        args = [int(x) if x else 0 for x in params.lstrip("?").split(";")] if params else []

        def a(i, d=1):
            return args[i] if i < len(args) and args[i] != 0 else d

        if final in "Hf":
            self.r = min(self.rows - 1, max(0, a(0, 1) - 1))
            self.c = min(self.cols - 1, max(0, a(1, 1) - 1))
        elif final == "A":
            self.r = max(0, self.r - a(0))
        elif final == "B":
            self.r = min(self.rows - 1, self.r + a(0))
        elif final == "C":
            self.c = min(self.cols - 1, self.c + a(0))
        elif final == "D":
            self.c = max(0, self.c - a(0))
        elif final == "E":
            self.r = min(self.rows - 1, self.r + a(0)); self.c = 0
        elif final == "F":
            self.r = max(0, self.r - a(0)); self.c = 0
        elif final == "G":
            self.c = min(self.cols - 1, max(0, a(0, 1) - 1))
        elif final == "d":
            self.r = min(self.rows - 1, max(0, a(0, 1) - 1))
        elif final == "J":
            mode = args[0] if args else 0
            if mode in (2, 3):
                self.grid = [[(" ", 7, None) for _ in range(self.cols)]
                             for _ in range(self.rows)]
            elif mode == 0:
                for cc in range(self.c, self.cols):
                    self.grid[self.r][cc] = (" ", 7, None)
                for rr in range(self.r + 1, self.rows):
                    self.grid[rr] = [(" ", 7, None) for _ in range(self.cols)]
            elif mode == 1:
                for cc in range(0, self.c + 1):
                    self.grid[self.r][cc] = (" ", 7, None)
                for rr in range(0, self.r):
                    self.grid[rr] = [(" ", 7, None) for _ in range(self.cols)]
        elif final == "K":
            mode = args[0] if args else 0
            if mode == 0:
                for cc in range(self.c, self.cols):
                    self.grid[self.r][cc] = (" ", 7, None)
            elif mode == 1:
                for cc in range(0, self.c + 1):
                    self.grid[self.r][cc] = (" ", 7, None)
            else:
                self.grid[self.r] = [(" ", 7, None) for _ in range(self.cols)]
        elif final == "L":
            for _ in range(a(0)):
                self.grid.insert(self.r, [(" ", 7, None) for _ in range(self.cols)])
                self.grid.pop()
        elif final == "M":
            for _ in range(a(0)):
                self.grid.pop(self.r)
                self.grid.append([(" ", 7, None) for _ in range(self.cols)])
        elif final == "m":
            self._sgr(args)
        # 其它（含 ESC[6n）忽略：不回应答，避免把 R 序列写进 guest 键盘

    def _sgr(self, args):
        if not args:
            args = [0]
        i = 0
        while i < len(args):
            v = args[i]
            if v == 0:
                self.fg, self.bg, self.bold = 7, None, False
            elif v == 1:
                self.bold = True
            elif v == 22:
                self.bold = False
            elif 30 <= v <= 37:
                self.fg = v - 30
            elif v == 39:
                self.fg = 7
            elif 40 <= v <= 47:
                self.bg = v - 40
            elif v == 49:
                self.bg = None
            elif 90 <= v <= 97:
                self.fg = v - 90 + 8
            elif 100 <= v <= 107:
                self.bg = v - 100 + 8
            elif v in (38, 48) and i + 2 < len(args) and args[i + 1] == 5:
                if v == 38:
                    self.fg = args[i + 2] % 16
                else:
                    self.bg = args[i + 2] % 16
                i += 2
            i += 1

    def text(self):
        return "\n".join("".join(c[0] for c in row).rstrip() for row in self.grid)

    def at_prompt(self):
        return self.text().rstrip().endswith("#")


class Renderer:
    def __init__(self, cols, rows, font_path, font_size):
        self.cols, self.rows = cols, rows
        self.font = ImageFont.truetype(font_path, font_size)
        bold_path = font_path.replace(".ttf", "-Bold.ttf")
        self.bold = ImageFont.truetype(bold_path, font_size) if Path(bold_path).exists() else self.font
        bbox = self.font.getbbox("M")
        self.cw = max(6, bbox[2])
        asc, desc = self.font.getmetrics()
        self.ch = asc + desc + 2
        self.pad = 14
        self.w = self.pad * 2 + self.cw * cols
        self.h = self.pad * 2 + self.ch * rows

    def frame(self, term, cursor=True):
        im = Image.new("RGB", (self.w, self.h), DEFAULT_BG)
        d = ImageDraw.Draw(im)
        for rr in range(self.rows):
            y = self.pad + rr * self.ch
            for cc in range(self.cols):
                ch, fg, bg = term.grid[rr][cc]
                x = self.pad + cc * self.cw
                if bg is not None and bg != 7:
                    d.rectangle([x, y, x + self.cw - 1, y + self.ch - 1], fill=PALETTE[bg])
                if ch != " ":
                    d.text((x, y), ch, font=self.bold if term.bold else self.font,
                           fill=PALETTE[fg] if fg < 16 else DEFAULT_FG)
        if cursor:
            x = self.pad + term.c * self.cw
            y = self.pad + term.r * self.ch
            d.rectangle([x, y, x + self.cw - 2, y + self.ch - 3], outline="#6b7a90")
        return im


def set_winsize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--sim", default="build/sim")
    ap.add_argument("--fw", default="build/firmware.bin")
    ap.add_argument("--out", default="docs/img/net-demo.gif")
    ap.add_argument("--cols", type=int, default=92)
    ap.add_argument("--rows", type=int, default=26)
    ap.add_argument("--text-log", help="把每条命令后的屏幕文本写到这个文件（调试用）")
    ap.add_argument("--pty", action="store_true",
                    help="用 pty（交互模式）录；默认用管道（和验收脚本一致）")
    ap.add_argument("--font", default="/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf")
    ap.add_argument("--font-size", type=int, default=15)
    ap.add_argument("--boot-timeout", type=float, default=600)
    ap.add_argument("--cmdline",
                    default="console=ttyS0,115200 loglevel=4 panic=-1 acpi=off pci=off")
    a = ap.parse_args()

    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    cols, rows = a.cols, a.rows
    env = dict(os.environ, TERM="xterm-256color")
    if a.pty:
        master, slave = pty.openpty()
        set_winsize(slave, cols, rows)
        p = subprocess.Popen([a.sim, "--cmdline=" + a.cmdline, a.fw],
                             stdin=slave, stdout=slave, stderr=slave,
                             env=env, preexec_fn=os.setsid)
        os.close(slave)
        rfd = wfd = master
    else:
        # 管道模式：stdin/stdout 都不是 tty，和 tools/boot_login.py 等验收
        # 脚本完全一致；guest 的控制台仍是 80x24，交互行编辑由 guest 自己做。
        p = subprocess.Popen([a.sim, "--cmdline=" + a.cmdline, a.fw],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, env=env, bufsize=0)
        rfd = p.stdout.fileno()
        wfd = p.stdin.fileno()

    term = Term(cols, rows)
    renderer = Renderer(cols, rows, a.font, a.font_size)
    frames, times = [], []
    last_text = [None]
    capture = [False]   # 引导阶段不录，清屏后从干净的 shell 开始

    def snap(force=False):
        if not capture[0]:
            return
        t = term.text()
        if not force and t == last_text[0]:
            return
        last_text[0] = t
        frames.append(renderer.frame(term))
        times.append(time.time())

    def drain():
        r, _, _ = select.select([rfd], [], [], 0)
        if not r:
            return
        try:
            data = os.read(rfd, 65536)
        except OSError:
            return
        if data:
            term.feed(data)
            snap()

    def pump(stop_fn, timeout, min_after=0.0):
        end = time.time() + timeout
        start = time.time()
        while time.time() < end:
            r, _, _ = select.select([rfd], [], [], 0.05)
            if r:
                try:
                    data = os.read(rfd, 65536)
                except OSError:
                    return
                if not data:
                    return
                term.feed(data)
                snap()
            if stop_fn and stop_fn() and time.time() - start >= min_after:
                return

    def type_text(s, delay):
        for ch in s:
            os.write(wfd, ch.encode())
            time.sleep(delay)
            drain()

    checkpoints = []

    def record(cmd, expect, delay):
        type_text(cmd, delay)
        type_text("\n", 0)
        time.sleep(0.25)
        pump(term.at_prompt, 30, min_after=1.2)
        if expect not in term.text():
            # 偶尔 ash 的 ESC[6n 应答会和回车抢输入，回车被吃掉；补一个
            print("[demo] %s：补一个回车" % cmd, file=sys.stderr, flush=True)
            type_text("\n", 0)
            time.sleep(0.3)
            pump(term.at_prompt, 15, min_after=1.2)
        ok = expect in term.text()
        checkpoints.append((cmd, ok, term.text()))
        print("[demo] %-38s %s" % (cmd, "OK" if ok else "未见到 %r" % expect),
              file=sys.stderr, flush=True)
        time.sleep(0.5)
        snap(force=True)

    try:
        # 1) 引导到 login:（不录）
        pump(lambda: "login:" in term.text(), a.boot_timeout)
        if "login:" not in term.text():
            print("make_demo_gif: 没等到 login:", file=sys.stderr)
            return 1
        time.sleep(0.4)

        # 2) 登录 + 清屏（去掉内核引导日志），从干净的 shell 开始录
        type_text("root\n", 0.06)
        pump(term.at_prompt, 60, min_after=0.5)
        time.sleep(0.3)
        type_text("clear\n", 0.02)
        pump(term.at_prompt, 5, min_after=0.3)
        time.sleep(0.4)
        capture[0] = True
        snap(force=True)          # 第一帧：干净的命令行

        # 3) 逐条命令：ifconfig / ping qq.com / wget https
        record("ifconfig sl0", "inet addr", 0.03)
        record("ping -c3 qq.com", "packets received", 0.03)
        record("wget -O /dev/null https://qq.com/", "saved", 0.03)
        time.sleep(1.5)
        snap(force=True)
        checkpoints.append(("", True, term.text()))
    finally:
        try:
            p.terminate()
            p.wait(timeout=3)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass
        for fd in {rfd, wfd}:
            try:
                os.close(fd)
            except OSError:
                pass

    if a.text_log:
        Path(a.text_log).write_text(
            "\n\n".join("### %s (%s)\n%s" % (c or "final",
                                             "OK" if ok else "MISSING", t)
                        for c, ok, t in checkpoints),
            encoding="utf-8")

    if len(frames) < 3:
        print("make_demo_gif: 没录到画面", file=sys.stderr)
        return 1

    # 按真实时间算每帧停留，限幅后存 GIF
    durs = []
    for i in range(len(frames) - 1):
        d = int((times[i + 1] - times[i]) * 1000)
        durs.append(min(1200, max(80, d)))
    durs.append(1500)
    if len(frames) > 900:
        step = len(frames) // 900 + 1
        frames = frames[::step]
        durs = durs[::step]
    frames = [im.convert("RGB").quantize(colors=64) for im in frames]
    frames[0].save(str(out), save_all=True, append_images=frames[1:],
                   duration=durs, loop=0, optimize=True, disposal=2)
    print("make_demo_gif: %s（%d 帧，约 %.1f 秒，%.2f MiB）" %
          (out, len(frames), sum(durs) / 1000.0,
           out.stat().st_size / (1 << 20)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
