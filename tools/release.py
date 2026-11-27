#!/usr/bin/env python3
"""release.py —— 一键发布：从提交文本生成发布说明 + 打包三件产物 + 校验和。

在仓库根目录运行：

    python3 tools/release.py --tag v1.2
    python3 tools/release.py --tag v1.2 --notes-only     # 只生成 RELEASE_NOTES.md
    python3 tools/release.py --tag v1.2 --no-test --with-firmware no

产物在 build/release/<tag>/：

    RELEASE_NOTES.md            自动生成（GitHub Release 正文）
    x64simc6-<ver>-src.tar.gz   git archive 源码
    x64simc6-<ver>-dist.tar.gz  sim + sim.wasm + web/ + README/RELEASE
    x64simc6-<ver>-firmware.tar.gz  firmware.bin（有 build/alpine 时才打）
    SHA256SUMS                  上面三件的校验和
    RELEASE.md                  docs/RELEASE.md 副本

发布说明 = docs/RELEASE.md 里对应小节（人写）+ <上一个 tag>..<tag> 的提交
（按 Conventional Commits 的 feat/fix/perf/docs/... 分组）。
"""
import argparse
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CMD_GROUP = [
    ("feat", "新功能"),
    ("fix", "修复"),
    ("perf", "性能"),
    ("refactor", "重构"),
    ("docs", "文档"),
    ("test", "测试"),
    ("build", "构建"),
    ("ci", "CI"),
    ("chore", "杂项"),
    ("other", "其他"),
]
CC_RE = re.compile(r"^([A-Za-z]+)(\([^)]*\))?!?:\s*(.+)$")
DEFAULT_CMDLINE = "console=ttyS0,115200 loglevel=4 panic=-1 acpi=off pci=conf1"


def die(msg):
    print("release: " + msg, file=sys.stderr)
    sys.exit(1)


def log(msg):
    print("release: " + msg, flush=True)


def run(cmd, **kw):
    capture = kw.pop("capture", False)
    show = kw.pop("show", True)
    if show:
        log("$ " + " ".join(str(c) for c in cmd))
    return subprocess.run(
        [str(c) for c in cmd],
        cwd=str(ROOT),
        check=kw.pop("check", True),
        text=True,
        capture_output=capture,
        **kw,
    )


def git(*args, capture=True, check=False):
    return subprocess.run(
        ["git", *args], cwd=str(ROOT), text=True,
        capture_output=capture, check=check,
    )


def resolve_tag(arg):
    if arg:
        return arg
    r = git("describe", "--tags", "--exact-match")
    if r.returncode != 0:
        die("当前 HEAD 不在 tag 上；显式传 --tag vX.Y")
    return r.stdout.strip()


def tag_exists(tag):
    return git("rev-parse", "-q", "--verify", "refs/tags/" + tag).returncode == 0


def previous_tag(tag):
    r = git("describe", "--tags", "--abbrev=0", tag + "^")
    return r.stdout.strip() if r.returncode == 0 else None


def tag_date(tag):
    r = git("log", "-1", "--format=%cd", "--date=short", tag)
    return r.stdout.strip() if r.returncode == 0 else ""


def parse_commits(rng):
    """git log -> [(hash, subject)]，去掉 merge。"""
    sep = "\x1e"
    r = git("log", "--no-merges", "--format=%H%x1f%s" + sep, rng)
    out = []
    for rec in r.stdout.split(sep):
        rec = rec.strip("\n")
        if not rec:
            continue
        parts = rec.split("\x1f", 1)
        if len(parts) == 2:
            out.append((parts[0], parts[1]))
    return out


def extract_release_section(tag):
    """从 docs/RELEASE.md 里取 `## <tag> ...` 或 `## v<ver> ...` 小节正文。"""
    p = ROOT / "docs" / "RELEASE.md"
    if not p.exists():
        return ""
    ver = tag[1:] if tag.startswith("v") else tag
    names = {"## " + tag, "## v" + ver, "## " + ver}
    lines = p.read_text(encoding="utf-8").splitlines()
    start = None
    for i, ln in enumerate(lines):
        if ln.startswith("## ") and any(ln.startswith(n) for n in names):
            start = i + 1
            break
    if start is None:
        return ""
    body = []
    for ln in lines[start:]:
        if ln.startswith("## ") or ln.startswith("# "):
            break
        body.append(ln)
    return "\n".join(body).strip()


def build_notes(tag, repo):
    prev = previous_tag(tag)
    rng = "%s..%s" % (prev, tag) if prev else tag
    commits = parse_commits(rng)
    groups = {k: [] for k, _ in CMD_GROUP}
    for h, subj in commits:
        m = CC_RE.match(subj)
        if m:
            kind = m.group(1).lower()
            scope = (m.group(2) or "")[1:-1]
            rest = m.group(3)
        else:
            kind, scope, rest = "other", "", subj
        if kind not in groups:
            kind = "other"
        title = ("[" + scope + "] " + rest) if scope else rest
        groups[kind].append("- %s（`%s`）" % (title, h[:7]))

    out = []
    title = "## %s（%s）" % (tag, tag_date(tag) or "未注明日期")
    out.append(title)
    if prev:
        out.append("")
        out.append("相对 `%s` 共 %d 个提交。" % (prev, len(commits)))

    hand = extract_release_section(tag)
    if hand:
        out.append("")
        out.append("### 发布说明（docs/RELEASE.md）")
        out.append("")
        out.append(hand)

    out.append("")
    out.append("### 提交变更（自动生成）")
    any_group = False
    for kind, label in CMD_GROUP:
        items = groups.get(kind) or []
        if not items:
            continue
        any_group = True
        out.append("")
        out.append("#### " + label)
        out.extend(items)
    if not any_group:
        out.append("")
        out.append("- （没有提交）")

    if repo and prev:
        out.append("")
        out.append("**完整变更**：%s/compare/%s...%s" % (repo.rstrip("/"), prev, tag))
    return "\n".join(out).rstrip() + "\n"


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def make_tar_gz(out_path, base_dir, arcname):
    with tarfile.open(out_path, "w:gz") as tf:
        tf.add(str(base_dir), arcname=arcname)


def build_src(tag, out, ver):
    path = out / ("x64simc6-%s-src.tar.gz" % ver)
    run(["git", "archive", "--format=tar.gz",
         "--prefix=x64simc6-%s/" % ver, "-o", path, tag])
    return path


def build_dist(out, ver):
    stage = Path(tempfile.mkdtemp(prefix="rel-dist-"))
    try:
        sim = ROOT / "build" / "sim"
        if not sim.exists():
            die("build/sim 不存在，先跑 ./build.sh all")
        shutil.copy2(sim, stage / "sim")
        wasm = ROOT / "web" / "sim.wasm"
        if not wasm.exists():
            die("web/sim.wasm 不存在，先跑 ./build.sh all")
        shutil.copy2(wasm, stage / "sim.wasm")
        shutil.copy2(ROOT / "README.md", stage / "README.md")
        shutil.copy2(ROOT / "docs" / "RELEASE.md", stage / "RELEASE.md")
        (stage / "web").mkdir()
        # 只带 web 静态资源；web/firmware.bin 是指向 build/ 的符号链接
        # （CI/本地测试用），不能跟着拷进 dist。
        for name in ("app.js", "style.css", "index.html"):
            src = ROOT / "web" / name
            if src.exists():
                shutil.copy2(src, stage / "web" / name)
        path = out / ("x64simc6-%s-dist.tar.gz" % ver)
        make_tar_gz(path, stage, ".")
        return path
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def build_firmware(tag, out, ver, mode):
    kernel = ROOT / "build" / "alpine" / "boot" / "vmlinuz-lts"
    initrd = ROOT / "build" / "alpine" / "minirootfs.tar.gz"
    have = kernel.exists() and initrd.exists()
    if mode == "no":
        log("跳过固件（--with-firmware no）")
        return None
    if not have:
        if mode == "yes":
            die("缺少 %s 或 %s；先跑 tools/fetch_alpine.py" % (kernel, initrd))
        log("跳过固件（缺 build/alpine；需要时先跑 tools/fetch_alpine.py）")
        return None
    fw = ROOT / "build" / "firmware.bin"
    run(["./build.sh", "fw", "--kernel", kernel, "--initrd", initrd,
         "--cmdline", DEFAULT_CMDLINE, "--out", fw])
    stage = Path(tempfile.mkdtemp(prefix="rel-fw-"))
    try:
        shutil.copy2(fw, stage / "firmware.bin")
        path = out / ("x64simc6-%s-firmware.tar.gz" % ver)
        with tarfile.open(path, "w:gz") as tf:
            tf.add(str(stage / "firmware.bin"), arcname="firmware.bin")
        return path
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--tag", help="要发布的 tag（默认取 HEAD 上的 tag）")
    ap.add_argument("--out", help="产物目录（默认 build/release/<tag>）")
    ap.add_argument("--notes-only", action="store_true", help="只生成 RELEASE_NOTES.md")
    ap.add_argument("--no-test", action="store_true", help="跳过 ./build.sh test")
    ap.add_argument("--with-firmware", choices=["auto", "yes", "no"], default="auto",
                    help="是否打固件（默认 auto：有 build/alpine 才打）")
    ap.add_argument("--repo", default=os.environ.get("RELEASE_REPO_URL", ""),
                    help="仓库 URL，用于生成 compare 链接（默认读 $RELEASE_REPO_URL）")
    ap.add_argument("--allow-dirty", action="store_true", help="允许有未提交改动")
    a = ap.parse_args()

    tag = resolve_tag(a.tag)
    if not tag_exists(tag):
        die("tag %s 不存在" % tag)
    ver = tag[1:] if tag.startswith("v") else tag
    out = Path(a.out) if a.out else ROOT / "build" / "release" / tag
    out.mkdir(parents=True, exist_ok=True)

    notes = build_notes(tag, a.repo)
    (out / "RELEASE_NOTES.md").write_text(notes, encoding="utf-8")
    log("发布说明 -> %s" % (out / "RELEASE_NOTES.md"))
    if a.notes_only:
        print(notes)
        return

    if not a.allow_dirty:
        dirty = git("status", "--porcelain").stdout.strip()
        if dirty:
            die("工作区有未提交改动（加 --allow-dirty 可跳过）：\n" + dirty)

    if not a.no_test:
        run(["./build.sh", "test"])
    else:
        log("跳过 ./build.sh test（--no-test）")

    for f in out.glob("*.tar.gz"):
        f.unlink()

    paths = []
    paths.append(build_src(tag, out, ver))
    paths.append(build_dist(out, ver))
    fw = build_firmware(tag, out, ver, a.with_firmware)
    if fw:
        paths.append(fw)

    sums = []
    for p in paths:
        sums.append("%s  %s" % (sha256(p), p.name))
    (out / "SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="utf-8")
    shutil.copy2(ROOT / "docs" / "RELEASE.md", out / "RELEASE.md")

    log("产物目录：%s" % out)
    for line in sums:
        print("  " + line)
    print("  " + "-" * 40)
    print("  RELEASE_NOTES.md / RELEASE.md / SHA256SUMS")


if __name__ == "__main__":
    main()
