#!/usr/bin/env python3
"""difftest.py —— x86-64 指令级差分测试驱动。

同一段机器码分别交给本机 CPU（tools/difftest/native_run）和模拟器
（build/sim --blob）执行，比较 16 个通用寄存器、RFLAGS 和数据页哈希。
测试代码一律以 int3 结尾。
"""
import os
import random
import struct
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SIM = os.environ.get("SIM", os.path.join(ROOT, "build", "sim"))
NATIVE = os.path.join(ROOT, "build", "native_run")
TMP = "/tmp/dt_blob.bin"

REG_NAMES = ["rax", "rbx", "rcx", "rdx", "rsi", "rdi", "rbp", "rsp",
             "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"]

CF, PF, AF, ZF, SF, TF, IF, DF, OF = 1, 4, 0x10, 0x40, 0x80, 0x100, 0x200, 0x400, 0x800


def make_blob(regs, flags, code):
    hdr = struct.pack("<18Q", *regs, 0x100000, flags) + b"\0" * 16
    assert len(hdr) == 160
    return hdr + bytes(code)


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, timeout=5)
    out = p.stdout.decode("utf-8", "replace")
    for line in out.splitlines():
        if line.startswith("RES "):
            f = line.split()
            return [int(x, 16) for x in f[1:]]
    raise RuntimeError("no RES line: %r (stderr=%r)" % (out[-500:], p.stderr[-500:]))


def run_both(regs, flags, code):
    blob = make_blob(regs, flags, code)
    with open(TMP, "wb") as f:
        f.write(blob)
    emu = run([SIM, "--blob", TMP])
    nat = run([NATIVE, TMP])
    return emu, nat


def compare(name, regs, flags, code, fmask=0x8D5):
    emu, nat = run_both(regs, flags, code)
    bad = []
    for i in range(16):
        if emu[i] != nat[i]:
            bad.append("%s emu=%016x nat=%016x" % (REG_NAMES[i], emu[i], nat[i]))
    if (emu[17] & fmask) != (nat[17] & fmask):
        bad.append("flags emu=%016x nat=%016x" % (emu[17], nat[17]))
    if emu[18] != nat[18]:
        bad.append("mem emu=%016x nat=%016x" % (emu[18], nat[18]))
    if bad:
        print("FAIL %-40s %s" % (name, "; ".join(bad)))
        print("     code=%s" % bytes(code).hex())
        print("     regs=%s flags=%x" % (" ".join("%x" % r for r in regs), flags))
        return False
    return True


BASE = [0x1122334455667788, 0x8877665544332211, 3, 0xDEADBEEFCAFEBABE,
        0x0000000020000000, 0x0000000020000100, 0x000000002FF000,
        0x000000002FF800, 0x1111111111111111, 0x2222222222222222,
        0x3333333333333333, 0x4444444444444444, 0x5555555555555555,
        0x6666666666666666, 0x7777777777777777, 0x8888888888888888]


def modrm(mod, reg, rm):
    return (mod << 6) | ((reg & 7) << 3) | (rm & 7)


def rex(w, r, x, b):
    return 0x40 | (8 if w else 0) | ((r & 8) >> 1) | ((x & 8) >> 2) | ((b & 8) >> 3)


def gen_basic():
    tests = []
    alu = [0x01, 0x29, 0x21, 0x09, 0x31, 0x39, 0x85]
    for op in alu:
        for a, b in [(0, 1), (3, 5), (7, 2), (8, 9), (12, 14)]:
            tests.append(("alu64 %02x r%d,r%d" % (op, a, b),
                          [rex(1, b, 0, a), op, modrm(3, b, a)]))
            tests.append(("alu32 %02x r%d,r%d" % (op, a, b),
                          [rex(0, b, 0, a), op, modrm(3, b, a)]))
            tests.append(("alu16 %02x r%d,r%d" % (op, a, b),
                          [0x66, rex(0, b, 0, a), op, modrm(3, b, a)]))
            tests.append(("alu8 %02x r%d,r%d" % (op - 1, a, b),
                          [rex(0, b, 0, a), op - 1, modrm(3, b, a)]))
    # mov r/m,r 与 mov reg,r/m（0x88..0x8b）——musl 动态链接器里到处都是
    for op in (0x88, 0x89, 0x8a, 0x8b):
        w = 0 if op in (0x88, 0x8a) else 1
        for a, b in [(0, 0), (3, 5), (7, 2), (8, 9), (12, 14), (15, 1)]:
            tests.append(("mov %02x r%d,r%d" % (op, a, b),
                          [rex(w, b, 0, a), op, modrm(3, b, a)]))
    # movsxd r64,r/m32（0x63）
    for a in range(8):
        tests.append(("movsxd r%d,r%d" % (a, a),
                      [0x48, 0x63, modrm(3, a, a)]))
    tests.append(("movsxd rax,eax", [0x48, 0x63, 0xc0]))
    tests.append(("mov eax,r12d", [0x44, 0x89, 0xe0]))

    # 立即数形式 83 /0../7 与 81 /0../7
    for op in range(8):
        for imm in (1, 0x7f, 0x80, 0xff):
            tests.append(("grp1 83 /%d imm%02x" % (op, imm),
                          [0x48, 0x83, modrm(3, op, 0), imm]))
        tests.append(("grp1 81 /%d" % op, [0x48, 0x81, modrm(3, op, 1), 0x88, 0x77, 0x66, 0x55]))
    # inc/dec/neg/not
    for op in (0xfe, 0xff):
        for r in range(8):
            pre = [0x48] if op == 0xff else []
            tests.append(("grp45 %02x /%d r%d" % (op, r % 2, r), pre + [op, modrm(3, r % 2, r)]))
    for r in (0, 1, 2, 3, 6, 7):
        tests.append(("neg r%d" % r, [0x48, 0xf7, modrm(3, 3, r)]))
        tests.append(("not r%d" % r, [0x48, 0xf7, modrm(3, 2, r)]))
    # 移位/旋转
    for op, nm in [(4, "shl"), (5, "shr"), (7, "sar"), (0, "rol"), (1, "ror"), (2, "rcl"), (3, "rcr")]:
        rot = op <= 3
        for cnt in (0, 1, 7, 31, 63, 65):
            # 旋转只定义 CF；移位定义 CF/PF/ZF/SF（count==1 时还有 OF）
            mask = CF if rot else (CF | PF | ZF | SF | (OF if cnt == 1 else 0))
            tests.append(("%s imm %d" % (nm, cnt), [0x48, 0xc1, modrm(3, op, 2), cnt & 0xff], mask))
        mask = CF if rot else (CF | PF | ZF | SF)
        tests.append(("%s cl" % nm, [0x48, 0xd3, modrm(3, op, 3)], mask))
    # mul/imul/div/idiv
    for op, nm in [(4, "mul"), (5, "imul"), (6, "div"), (7, "idiv")]:
        for w, pre in [(0, []), (1, [0x48])]:
            for r in range(4):
                mask = 0 if op >= 6 else (CF | OF)
                tests.append(("%s%d r%d" % (nm, 64 if w else 32, r),
                              pre + [0xf7, modrm(3, op, r)], mask))
    # cdq/cqo/cbw/cwde/cdqe
    tests += [("cdq", [0x99]), ("cqo", [0x48, 0x99]), ("cwd", [0x66, 0x99]),
              ("cbw", [0x66, 0x98]), ("cwde", [0x98]), ("cdqe", [0x48, 0x98])]
    # movzx/movsx/movsxd
    for op in (0xb6, 0xb7, 0xbe, 0xbf):
        for a, b in [(0, 3), (5, 2), (9, 14)]:
            tests.append(("movx %02x" % op, [rex(1, a, 0, b), 0x0f, op, modrm(3, a, b)]))
    tests.append(("movsxd", [0x48, 0x63, modrm(3, 3, 1)]))
    # lea
    tests.append(("lea", [0x48, 0x8d, modrm(3, 3, 5)]))
    tests.append(("lea mem", [0x48, 0x8d, modrm(1, 3, 5), 0x20]))
    # cmovcc / setcc
    for cc in (0x4, 0x5, 0xc, 0xd, 0xe, 0xf):
        tests.append(("cmov %x" % cc, [0x48, 0x0f, 0x40 + cc, modrm(3, 2, 3)]))
        tests.append(("setcc %x" % cc, [0x0f, 0x90 + cc, modrm(3, 0, 2)]))
    # bt/bts/btr/btc
    for op in (0xa3, 0xab, 0xb3, 0xbb):
        tests.append(("bt %02x" % op, [0x48, 0x0f, op, modrm(3, 2, 1)], CF))
    for sub in (4, 5, 6, 7):
        tests.append(("bt imm %d" % sub, [0x48, 0x0f, 0xba, modrm(3, sub, 2), 0x25], CF))
    # bsf/bsr
    tests += [("bsf", [0x48, 0x0f, 0xbc, modrm(3, 2, 1)], ZF),
              ("bsr", [0x48, 0x0f, 0xbd, modrm(3, 2, 1)], ZF)]
    # xadd/cmpxchg
    tests += [("xadd", [0x48, 0x0f, 0xc1, modrm(3, 2, 1)]),
              ("cmpxchg", [0x48, 0x0f, 0xb1, modrm(3, 2, 1)])]
    # xchg / bswap
    tests += [("xchg", [0x48, 0x87, modrm(3, 2, 1)]),
              ("bswap", [0x48, 0x0f, 0xc8 + 2])]
    # push/pop
    tests += [("push r1", [0x51]), ("pop r2", [0x5a]),
              ("push imm8", [0x6a, 0x7f]), ("push imm32", [0x68, 0x88, 0x77, 0x66, 0x55])]
    # lahf/sahf
    tests += [("lahf", [0x9f]), ("sahf", [0x9e])]
    # 内存操作：绝对地址 0x200000
    for op in (0x01, 0x29, 0x31, 0x39):
        tests.append(("mem %02x" % op, [0x48, op, modrm(0, 2, 4), 0x25, 0x00, 0x00, 0x20, 0x00]))
    tests.append(("mov mem", [0x48, 0x89, modrm(0, 0, 4), 0x25, 0x00, 0x00, 0x20, 0x00]))
    tests.append(("mov load", [0x48, 0x8b, modrm(0, 0, 4), 0x25, 0x08, 0x00, 0x20, 0x00]))
    return tests


def enc_reg(n):
    """x86 编码序寄存器号 -> 架构序下标"""
    return [0, 2, 3, 1, 7, 6, 4, 5][n]


def gen_mem():
    """内存操作数形式 + 多指令序列"""
    tests = []
    # [rsp+disp8]
    tests.append(("mem rsp+8", [0x48, 0x8b, 0x44, 0x24, 0x08]))
    tests.append(("mem rsp+8 store", [0x48, 0x89, 0x4c, 0x24, 0x10]))
    # [rbp+disp32]
    tests.append(("mem rbp+16", [0x48, 0x8b, 0x45, 0x10]))
    # SIB: [rax*4 + 0x200000]
    tests.append(("mem sib", [0x48, 0x8b, 0x04, 0x85, 0x00, 0x00, 0x20, 0x00], 0x8D5, {0: 0x100}))
    tests.append(("mem sib store", [0x48, 0x89, 0x14, 0x85, 0x00, 0x00, 0x20, 0x00], 0x8D5, {0: 0x100}))
    # RIP 相对
    tests.append(("mem riprel", [0x48, 0x8b, 0x05, 0x00, 0x00, 0x00, 0x00]))
    # 多指令序列
    tests.append(("seq1", [0x48, 0x01, 0xd8, 0x48, 0x29, 0xc8, 0x48, 0x31, 0xd2,
                           0x48, 0x83, 0xc0, 0x10, 0x48, 0x0f, 0xaf, 0xc3]))
    tests.append(("seq2", [0x48, 0xc1, 0xe0, 0x04, 0x48, 0x89, 0xc3, 0x48, 0x0f,
                           0xb6, 0xc8, 0x48, 0x85, 0xc9]))
    tests.append(("seq3", [0x48, 0x8d, 0x04, 0x25, 0x00, 0x00, 0x20, 0x00,
                           0x48, 0x8b, 0x18, 0x48, 0x03, 0x58, 0x08]))
    tests.append(("seq4", [0x48, 0x6b, 0xc3, 0x05, 0x48, 0x69, 0xc8, 0x10, 0x00,
                           0x00, 0x00, 0x48, 0x0f, 0xaf, 0xc1], CF | OF))
    # shld/shrd
    tests.append(("shld", [0x48, 0x0f, 0xa4, 0xd8, 0x04], CF))
    tests.append(("shrd", [0x48, 0x0f, 0xac, 0xd8, 0x04], CF))
    return tests


FUZZ_OPS = [
    lambda r: [rex(1, r[0], 0, r[1]), 0x01, modrm(3, r[0], r[1])],
    lambda r: [rex(1, r[0], 0, r[1]), 0x29, modrm(3, r[0], r[1])],
    lambda r: [rex(1, r[0], 0, r[1]), 0x21, modrm(3, r[0], r[1])],
    lambda r: [rex(1, r[0], 0, r[1]), 0x31, modrm(3, r[0], r[1])],
    lambda r: [rex(1, r[0], 0, r[1]), 0x39, modrm(3, r[0], r[1])],
    lambda r: [rex(1, 0, 0, r[0]), 0x83, modrm(3, r[1] & 7, r[0]), r[2] & 0xff],
    lambda r: [rex(1, 0, 0, r[0]), 0x81, modrm(3, r[1] & 7, r[0])] + list(struct.pack("<i", r[2] - (1 << 31))),
    lambda r: [rex(1, r[0], 0, r[1]), 0x0f, 0xaf, modrm(3, r[0], r[1])],
    lambda r: [rex(1, r[0], 0, r[1]), 0x0f, 0xb6, modrm(3, r[0], r[1])],
    lambda r: [rex(1, r[0], 0, r[1]), 0x0f, 0xbe, modrm(3, r[0], r[1])],
    lambda r: [rex(1, r[0], 0, r[1]), 0x0f, 0xb7, modrm(3, r[0], r[1])],
    lambda r: [rex(1, r[0], 0, r[1]), 0x0f, 0xc1, modrm(3, r[0], r[1])],
    lambda r: [rex(1, r[0], 0, r[1]), 0x0f, 0xb1, modrm(3, r[0], r[1])],
    lambda r: [rex(1, r[0], 0, r[1]), 0x87, modrm(3, r[0], r[1])],
    lambda r: [rex(1, 0, 0, r[0]), 0xc1, modrm(3, (r[1] & 7) % 8, r[0]), 1],
    lambda r: [rex(1, 0, 0, r[0]), 0xd3, modrm(3, (r[1] & 7) % 8, r[0])],
    lambda r: [rex(1, 0, 0, r[0]), 0xf7, modrm(3, 2 + (r[1] & 1), r[0])],
    lambda r: [rex(1, 0, 0, r[0]), 0x0f, 0xc8 + (r[0] & 7)],
    lambda r: [rex(1, 0, 0, r[0]), 0x8d, modrm(1, r[1] & 7, r[0]), 0x20],
    lambda r: [0x90],
    lambda r: [0x0f, 0x1f, modrm(3, 0, r[0])],
]


def gen_fuzz(seed=777, count=800):
    rng = random.Random(seed)
    tests = []
    for i in range(count):
        code = []
        n = rng.randrange(1, 6)
        for _ in range(n):
            f = rng.choice(FUZZ_OPS)
            regs = [rng.choice([0, 1, 2, 3, 6, 7]) for _ in range(3)]
            code += f(regs)
        tests.append(("fuzz%04d" % i, code, 0x01))
    return tests


def gen_sse():
    """SSE2 子集：传送/逻辑/比较/交织/移位/加减。结果写回数据页，用内存哈希比对。"""
    tests = []
    A = 0x200000                       # 数据页基址（本机与模拟器都映射，哈希覆盖）

    def ld(x, disp):                   # movdqu xmm[x], [rax+disp]
        return [0xf3, rex(0, x, 0, 0), 0x0f, 0x6f, modrm(1, x, 0), disp & 0xff]
    def st(x, disp):                   # movdqu [rax+disp], xmm[x]
        return [0xf3, rex(0, x, 0, 0), 0x0f, 0x7f, modrm(1, x, 0), disp & 0xff]
    def rr(prefix, op, d, s):          # 两操作数：<prefix> 0f <op> /r（寄存器形式）
        code = list(prefix)
        code += [rex(0, d, 0, s), 0x0f, op, modrm(3, d, s)]
        return code

    def seq(name, body, x=0, y=1, extra=None):
        code = [0x48, 0xb8] + list((A + 0x00).to_bytes(8, "little"))   # mov rax, A
        code += ld(x, 0x00) + ld(y, 0x10)
        code += body
        code += st(x, 0x20)
        over = {0: A}
        if extra:
            over.update(extra)
        tests.append((name, code, 0x8D5, over))

    def ldq(x, disp):                  # movq xmm[x], [rax+disp]（f3 0f 7e）
        return [0xf3, rex(0, x, 0, 0), 0x0f, 0x7e, modrm(1, x, 0), disp & 0xff]
    def stq(x, disp):                  # movq [rax+disp], xmm[x]（66 0f d6）
        return [0x66, rex(0, x, 0, 0), 0x0f, 0xd6, modrm(1, x, 0), disp & 0xff]
    def ldd(x, disp):                  # movd xmm[x], [rax+disp]（0f 6e）
        return [0x66, rex(0, x, 0, 0), 0x0f, 0x6e, modrm(1, x, 0), disp & 0xff]
    def std_(x, disp):                 # movd [rax+disp], xmm[x]（66 0f 7e）
        return [0x66, rex(0, x, 0, 0), 0x0f, 0x7e, modrm(1, x, 0), disp & 0xff]
    # musl 里高频：movq/movd 的内存形式（注意 0f d6 是 store、f3 0f 7e 是 load）
    seq("sse movq ld+st", ldq(2, 0x00) + stq(2, 0x30))
    seq("sse movd ld+st", ldd(3, 0x08) + std_(3, 0x38))
    seq("sse movq st of x", stq(0, 0x28))
    seq("sse movd st of x", std_(0, 0x2c))

    seq("sse pxor", rr([0x66], 0xef, 0, 1))
    seq("sse pand", rr([0x66], 0xdb, 0, 1))
    seq("sse por", rr([0x66], 0xeb, 0, 1))
    seq("sse andps", rr([], 0x54, 0, 1))
    seq("sse andnps", rr([], 0x55, 0, 1))
    seq("sse orps", rr([], 0x56, 0, 1))
    seq("sse xorps", rr([], 0x57, 0, 1))
    seq("sse pcmpeqb", rr([0x66], 0x74, 0, 1))
    seq("sse pcmpeqw", rr([0x66], 0x75, 0, 1))
    seq("sse pcmpeqd", rr([0x66], 0x76, 0, 1))
    seq("sse paddb", rr([0x66], 0xfc, 0, 1))
    seq("sse paddw", rr([0x66], 0xfd, 0, 1))
    seq("sse paddd", rr([0x66], 0xfe, 0, 1))
    seq("sse paddq", rr([0x66], 0xd4, 0, 1))
    seq("sse psubb", rr([0x66], 0xf8, 0, 1))
    seq("sse psubw", rr([0x66], 0xf9, 0, 1))
    seq("sse psubd", rr([0x66], 0xfa, 0, 1))
    seq("sse psubq", rr([0x66], 0xfb, 0, 1))
    seq("sse punpcklbw", rr([0x66], 0x60, 0, 1))
    seq("sse punpcklwd", rr([0x66], 0x61, 0, 1))
    seq("sse punpckldq", rr([0x66], 0x62, 0, 1))
    seq("sse punpcklqdq", rr([0x66], 0x6c, 0, 1))
    seq("sse punpckhbw", rr([0x66], 0x68, 0, 1))
    seq("sse punpckhwd", rr([0x66], 0x69, 0, 1))
    seq("sse punpckhdq", rr([0x66], 0x6a, 0, 1))
    seq("sse psrlw imm", [0x66, rex(0, 0, 0, 0), 0x0f, 0x71, modrm(3, 2, 0), 3])
    seq("sse psraw imm", [0x66, 0x0f, 0x71, modrm(3, 4, 0), 3])
    seq("sse psllw imm", [0x66, 0x0f, 0x71, modrm(3, 6, 0), 3])
    seq("sse psrld imm", [0x66, 0x0f, 0x72, modrm(3, 2, 0), 3])
    seq("sse psrad imm", [0x66, 0x0f, 0x72, modrm(3, 4, 0), 3])
    seq("sse pslld imm", [0x66, 0x0f, 0x72, modrm(3, 6, 0), 3])
    seq("sse psrlq imm", [0x66, 0x0f, 0x73, modrm(3, 2, 0), 3])
    seq("sse psllq imm", [0x66, 0x0f, 0x73, modrm(3, 6, 0), 3])
    seq("sse pshufd", [0x66, 0x0f, 0x70, modrm(3, 0, 1), 0x1b])
    seq("sse pshuflw", [0xf2, 0x0f, 0x70, modrm(3, 0, 1), 0x1b])
    seq("sse pshufhw", [0xf3, 0x0f, 0x70, modrm(3, 0, 1), 0x1b])
    tests.append(("sse pmovmskb",
                  [0x48, 0xb8] + list((A + 0x00).to_bytes(8, "little")) +
                  ld(0, 0) + [0x66, 0x0f, 0xd7, modrm(3, 1, 0)],
                  0x8D5, {0: A}))
    tests.append(("sse movq gpr",
                  [0x48, 0xb8] + list((A + 0x00).to_bytes(8, "little")) +
                  [0x66, 0x48, 0x0f, 0x6e, modrm(3, 0, 3)] +
                  [0x66, 0x48, 0x0f, 0x7e, modrm(3, 2, 0)],
                  0x8D5, {0: A, 3: 0x0123456789abcdef}))
    return tests


def main():
    if not os.path.exists(SIM) or not os.path.exists(NATIVE):
        print("build/sim 或 build/native_run 不存在")
        return 2
    tests = gen_basic() + gen_mem() + gen_sse() + gen_fuzz()
    rng = random.Random(12345)
    fails = 0
    total = 0
    for t in tests:
        name, code = t[0], t[1]
        fmask = t[2] if len(t) > 2 else 0x8D5
        over = t[3] if len(t) > 3 else {}
        regs = list(BASE)
        # 随机化一些输入寄存器，但保持 rsp/rbp 指向栈
        for i in range(16):
            if i in (7, 6):
                continue
            regs[i] = rng.getrandbits(64)
        regs[2] = rng.randrange(0, 64)          # rcx：移位计数
        regs[0] = rng.getrandbits(32)           # rax
        regs[3] = rng.getrandbits(16)           # rdx
        for k, v in over.items():
            regs[k] = v
        if name.startswith("fuzz"):
            regs[2] = 1
        flags = 2 | rng.choice([0, CF, PF, AF, ZF, SF, OF, CF | ZF, SF | OF, AF | CF])
        if name.startswith(("div", "idiv")):
            regs[3] = 0
            regs[0] = rng.randrange(1, 1 << 30)
            dr = int(name[-1])
            enc2arch = [0, 2, 3, 1, 7, 6, 4, 5]
            if dr != 0:
                regs[enc2arch[dr]] = rng.randrange(1, 1 << 16)
        total += 1
        try:
            ok = compare(name, regs, flags, code + [0xCC], fmask)
        except Exception as e:
            print("ERROR %-40s %s code=%s" % (name, e, bytes(code).hex()))
            ok = False
        if not ok:
            fails += 1
    print("%d/%d passed" % (total - fails, total))
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
