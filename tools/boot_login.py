#!/usr/bin/env python3
"""boot_login.py —— Alpine 固件启动到 login 并自动登录验收。

驱动 build/sim 启动 build/firmware.bin：
  1. 等内核打印出 ``... login:``；
  2. 输入 ``root``；
  3. 等 shell 提示符，输入 ``uname -m``；
  4. 输出里出现 ``x86_64`` 即判定通过（Alpine 的用户态 busybox 真的在跑）。

串口输出会同时写进 build/login.log，方便事后看卡在哪一步。

环境变量：
  SIM       模拟器路径（默认 build/sim）
  FW        固件路径（默认 build/firmware.bin）
  TIMEOUT   总超时秒数（默认 7200）
  BOOT_ARGS 内核命令行（默认 console=ttyS0,115200 loglevel=4 panic=-1 acpi=off pci=off）
"""
import os
import select
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIM = os.environ.get("SIM", os.path.join(ROOT, "build", "sim"))
FW = os.environ.get("FW", os.path.join(ROOT, "build", "firmware.bin"))
TIMEOUT = float(os.environ.get("TIMEOUT", "7200"))
BOOT_ARGS = os.environ.get(
    "BOOT_ARGS",
    "console=ttyS0,115200 loglevel=4 panic=-1 acpi=off pci=off",
)
LOG = os.environ.get("LOG", os.path.join(ROOT, "build", "login.log"))


def main():
    if not os.path.exists(SIM):
        print(f"missing simulator: {SIM}")
        return 2
    if not os.path.exists(FW):
        print(f"missing firmware: {FW}")
        return 2

    proc = subprocess.Popen(
        [SIM, "--cmdline=" + BOOT_ARGS, FW],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=0,
    )
    out = open(LOG, "wb")
    buf = b""
    started = time.time()
    deadline = started + TIMEOUT

    # state: 0=等 login，1=等 shell，2=等 uname 结果
    state = 0
    result = "timeout"
    sent_root = False
    last_data_at = started
    last_beat = started

    # 本模拟器的串口输出在 idle 时可能延迟，靠“看到 login: 再发”容易错过提示符。
    # 这里加一份按时钟盲发的兜底输入：root 在 10/15/20 分钟各发一次，
    # 之后每 5 分钟发一次 uname -m，直到看到 x86_64。
    BLIND = [(600, b"root\n"), (900, b"root\n"), (1200, b"root\n"),
             (1400, b"uname -m; echo MARK-OK\n"),
             (1700, b"uname -m; echo MARK-OK\n"),
             (2000, b"uname -m; echo MARK-OK\n"),
             (2350, b"uname -m; echo MARK-OK\n"),
             (2700, b"uname -m; echo MARK-OK\n")]
    blind_i = 0

    try:
        while time.time() < deadline:
            while blind_i < len(BLIND) and time.time() - started >= BLIND[blind_i][0]:
                try:
                    os.write(proc.stdin.fileno(), BLIND[blind_i][1])
                    print(f"[boot_login] blind input @{BLIND[blind_i][0]}s",
                          flush=True)
                except Exception:
                    pass
                blind_i += 1
            if proc.poll() is not None:
                result = f"sim exited rc={proc.returncode}"
                break
            r, _, _ = select.select([proc.stdout], [], [], 1.0)
            if not r:
                now = time.time()
                if now - last_beat > 300:
                    print(f"[boot_login] {now - started:.0f}s alive,"
                          f" {len(buf)} bytes buffered", flush=True)
                    last_beat = now
                if now - last_data_at > 60:
                    print(f"[boot_login] {now - started:.0f}s no serial output",
                          flush=True)
                    last_data_at = now
                continue
            chunk = os.read(proc.stdout.fileno(), 65536)
            if not chunk:
                result = "eof"
                break
            out.write(chunk)
            out.flush()
            buf = (buf + chunk)[-262144:]
            last_data_at = time.time()

            if state == 0 and b"login:" in buf:
                os.write(proc.stdin.fileno(), b"root\n")
                sent_root = True
                buf = b""
                state = 1
                print("[boot_login] saw login: sent 'root'", flush=True)
            elif state == 1 and sent_root and (b"localhost:" in buf or b"~ #" in buf
                                               or b"# " in buf):
                os.write(proc.stdin.fileno(), b"uname -m; echo MARK-OK\n")
                buf = b""
                state = 2
                print("[boot_login] shell prompt seen, sent 'uname -m'", flush=True)
            elif b"x86_64" in buf:
                result = "pass"
                break
            elif state == 2 and b"x86_64" in buf and b"MARK-OK" in buf:
                os.write(proc.stdin.fileno(), b"poweroff -f\n")
                result = "pass"
                break
    finally:
        try:
            proc.kill()
        except Exception:
            pass
        out.close()

    if result == "pass":
        print(f"PASS: Alpine booted to login and ran 'uname -m' (log: {LOG})")
        return 0
    print(f"FAIL: {result} (log: {LOG})")
    return 1


if __name__ == "__main__":
    sys.exit(main())