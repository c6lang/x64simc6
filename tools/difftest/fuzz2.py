#!/usr/bin/env python3
"""扩大范围的随机指令差分测试（正确 REX/ModRM 编码）。

覆盖 movzx/movsx、imul、bt 家族、shld/shrd、rol/ror/rcl/rcr、setcc/cmovcc、
xadd、bswap、adc/sbb/neg/not/mul/imul、test/mov 等。只使用除 rsp/rbp 外的
寄存器，都是寄存器形式，不会碰栈。
"""
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from difftest import compare, BASE, CF, PF, AF, ZF, SF, OF  # noqa: E402

REGS = [0, 1, 2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]


def rex(w, r, b):
    v = 0x40
    if w:
        v |= 8
    if r >= 8:
        v |= 4
    if b >= 8:
        v |= 1
    return v


def modrm(reg, rm):
    return 0xC0 | ((reg & 7) << 3) | (rm & 7)


def rr(prefix, w, dst, src):
    """返回 (rex_prefix, modrm)，dst 作 rm、src 作 reg。"""
    out = []
    if w or dst >= 8 or src >= 8:
        out.append(rex(w, src, dst))
    out += prefix
    return out


def rand_ins(rng):
    d = rng.choice(REGS)
    s = rng.choice(REGS)
    w = rng.randrange(2)
    kind = rng.randrange(13)
    if kind == 0:      # movzx/movsx r, r8/r16
        op = rng.choice([0xB6, 0xB7, 0xBE, 0xBF])
        return rr([], w, d, s) + [0x0F, op, modrm(s, d)]
    if kind == 1:      # imul r, r/m
        return rr([], w, d, s) + [0x0F, 0xAF, modrm(s, d)]
    if kind == 2:      # bt/bts/btr/btc r, r
        op = rng.choice([0xA3, 0xAB, 0xB3, 0xBB])
        return rr([], w, d, s) + [0x0F, op, modrm(s, d)]
    if kind == 3:      # bt/bts/btr/btc r, imm8
        sub = rng.choice([4, 5, 6, 7])
        imm = rng.randrange(0, 200)
        return rr([], w, d, 0) + [0x0F, 0xBA, modrm(sub, d), imm]
    if kind == 4:      # shld/shrd r, r, imm8
        op = rng.choice([0xA4, 0xAC])
        return rr([], w, d, s) + [0x0F, op, modrm(s, d), rng.randrange(0, 70)]
    if kind == 5:      # rol/ror/rcl/rcr/shl/shr/sar r, cl
        sub = rng.randrange(8)
        return rr([], w, d, 0) + [0xD3, modrm(sub, d)]
    if kind == 6:      # setcc r8
        cc = rng.randrange(16)
        return rr([], 0, d, 0) + [0x0F, 0x90 + cc, modrm(0, d)]
    if kind == 7:      # cmovcc r, r
        cc = rng.randrange(16)
        return rr([], w, d, s) + [0x0F, 0x40 + cc, modrm(s, d)]
    if kind == 8:      # xadd r, r
        return rr([], w, d, s) + [0x0F, 0xC1, modrm(s, d)]
    if kind == 9:      # bswap r
        return rr([], w, d, 0) + [0x0F, 0xC8 + (d & 7)]
    if kind == 10:     # adc/sbb/and/or/xor/sub/add/cmp r, r
        op = rng.choice([0x11, 0x19, 0x21, 0x09, 0x31, 0x29, 0x01, 0x39])
        return rr([], w, d, s) + [op, modrm(s, d)]
    if kind == 11:     # neg/not/mul/imul r
        sub = rng.choice([2, 3, 4, 5])
        return rr([], w, d, 0) + [0xF7, modrm(sub, d)]
    return rr([], w, d, s) + [0x89, modrm(s, d)]     # mov r/m, r


def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 4000
    seed = int(sys.argv[2]) if len(sys.argv) > 2 else 20240601
    rng = random.Random(seed)
    fails = 0
    for i in range(count):
        code = []
        for _ in range(rng.randrange(1, 6)):
            code += rand_ins(rng)
        regs = list(BASE)
        for k in range(16):
            if k in (6, 7):          # BASE: 6=rbp, 7=rsp
                continue
            regs[k] = rng.getrandbits(64)
        regs[1] = rng.randrange(0, 70)      # rcx：移位计数
        flags = 2 | rng.choice([0, CF, PF, AF, ZF, SF, OF, CF | ZF, SF | OF,
                                AF | CF, CF | OF | ZF])
        try:
            ok = compare("f2_%05d" % i, regs, flags, code + [0xCC], 0x8D5)
        except Exception as e:
            print("ERROR f2_%05d %s code=%s" % (i, e, bytes(code).hex()))
            ok = False
        if not ok:
            fails += 1
    print("%d/%d passed" % (count - fails, count))
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main())