#!/usr/bin/env python3
"""fetch_alpine.py —— 下载 Alpine 3.20 内核/模块/initrd 到 build/alpine。

给 CI 和全新机器用。产物布局正好是 tools/mkfw.py 需要的：

    build/alpine/boot/vmlinuz-lts
    build/alpine/lib/modules/<kver>/kernel/drivers/net/slip/*.ko
    build/alpine/minirootfs.tar.gz

用法：

    python3 tools/fetch_alpine.py                       # 下到 build/alpine
    python3 tools/fetch_alpine.py --dest /tmp/alpine
    python3 tools/fetch_alpine.py --apk-file build/alpine/linux-lts.apk \\
        --initrd-file build/alpine/minirootfs.tar.gz      # 离线复用已有文件

版本是钉死的（linux-lts-6.6.142-r0 / alpine-minirootfs-3.20.3），
换版本时改下面的 URL 常量或传 --apk-url/--initrd-url。
"""
import argparse
import os
import shutil
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

ALPINE_VER = "v3.20"
APK_URL = ("https://dl-cdn.alpinelinux.org/alpine/%s/main/x86_64/"
           "linux-lts-6.6.142-r0.apk" % ALPINE_VER)
INITRD_URL = ("https://dl-cdn.alpinelinux.org/alpine/%s/releases/x86_64/"
              "alpine-minirootfs-3.20.3-x86_64.tar.gz" % ALPINE_VER)

# apk 里只需要内核和模块树；.PKGINFO/.SIGN 之类不要
WANT_PREFIXES = ("boot/vmlinuz-lts", "lib/modules/")


def log(msg):
    print("fetch-alpine: " + msg, flush=True)


def download(url, dst):
    log("下载 %s" % url)
    req = urllib.request.Request(url, headers={"User-Agent": "x64simc6-fetch/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r, open(dst, "wb") as f:
        total = 0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            total += len(chunk)
            if total % (16 << 20) < (1 << 20):
                print("  %.1f MiB" % (total / (1 << 20)), flush=True)
    log("下载完成 %.1f MiB -> %s" % (total / (1 << 20), dst))


def safe_members(tf):
    picked = []
    for m in tf.getmembers():
        name = m.name.lstrip("./")
        if not name:
            continue
        if ".." in name.split("/"):
            continue
        if any(name == p or name.startswith(p) for p in WANT_PREFIXES):
            picked.append(m)
    return picked


def extract_apk(apk, dest):
    log("解包 %s" % apk)
    with tarfile.open(apk, "r:*") as tf:
        members = safe_members(tf)
        if not any(m.name.endswith("vmlinuz-lts") for m in members):
            raise SystemExit("fetch-alpine: apk 里没有 boot/vmlinuz-lts")
        try:
            tf.extractall(path=str(dest), members=members, filter="data")
        except TypeError:   # Python < 3.12 没有 filter 参数
            tf.extractall(path=str(dest), members=members)
    kver = ""
    moddir = dest / "lib" / "modules"
    if moddir.is_dir():
        subs = [p.name for p in moddir.iterdir() if p.is_dir()]
        kver = subs[0] if subs else ""
    if not kver:
        raise SystemExit("fetch-alpine: apk 里没有 lib/modules")
    slip = dest / "lib" / "modules" / kver / "kernel" / "drivers" / "net" / "slip"
    log("内核版本 %s，SLIP 模块：%s" % (
        kver, ", ".join(sorted(p.name for p in slip.glob("*.ko*"))) or "无"))


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dest", default="build/alpine", help="输出目录（默认 build/alpine）")
    ap.add_argument("--apk-url", default=APK_URL)
    ap.add_argument("--initrd-url", default=INITRD_URL)
    ap.add_argument("--apk-file", help="用本地 apk，不下载")
    ap.add_argument("--initrd-file", help="用本地 minirootfs tar.gz，不下载")
    ap.add_argument("--force", action="store_true", help="已有文件也重新下载/解包")
    a = ap.parse_args()

    dest = Path(a.dest)
    dest.mkdir(parents=True, exist_ok=True)

    kernel = dest / "boot" / "vmlinuz-lts"
    if kernel.exists() and not a.force:
        log("%s 已存在，跳过（--force 可重下）" % kernel)
    else:
        apk = dest / "linux-lts.apk"
        if a.apk_file:
            apk = Path(a.apk_file)
        elif not apk.exists() or a.force:
            download(a.apk_url, apk)
        extract_apk(apk, dest)

    initrd = dest / "minirootfs.tar.gz"
    if initrd.exists() and not a.force:
        log("%s 已存在，跳过（--force 可重下）" % initrd)
    elif a.initrd_file:
        shutil.copy2(a.initrd_file, initrd)
        log("复制 %s -> %s" % (a.initrd_file, initrd))
    else:
        tmp = Path(tempfile.mkstemp(prefix="minirootfs-", suffix=".tar.gz")[1])
        try:
            download(a.initrd_url, tmp)
            shutil.move(str(tmp), str(initrd))
        finally:
            if tmp.exists():
                tmp.unlink()

    log("完成：")
    for p in (dest / "boot" / "vmlinuz-lts", dest / "minirootfs.tar.gz",
              dest / "lib" / "modules"):
        print("  %s" % p)


if __name__ == "__main__":
    main()
