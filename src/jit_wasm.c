/* jit_wasm.c —— wasm 后端的 JIT 编码器（仅 wasm 目标编译）
 *
 * 为什么单独一个 C 文件：这里是「生成 wasm 字节码」的宿主侧胶水，不参与
 * 客户机语义，也不该出现在 C6_PURE 自举路径里。默认 wasm 构建不编译它；
 * JIT=1 时由 clang 编进 web/sim.wasm，并在链接时允许 js_jit_compile /
 * js_jit_run 两个 JS import。
 *
 * 生成的模块与主模块共享同一块线性内存：块函数签名固定为
 *   run(state_off, ram_off) -> i32
 * state_off 是 &g_m 在内存中的偏移，ram_off 是 g_m.ram 的偏移。CPU 状态
 * 的字段偏移在 C 侧用 offsetof 算出后直接烧进 wasm 常量——它和 C6 生成的
 * struct 布局来自同一份 c6sim.h，不会漂移。
 *
 * 翻译范围（直线块，1..16 条，遇分支结束）：
 *   - mov r32/r64, imm32/imm64（B8-BF、C7 /0）
 *   - mov r32/r64, r32/r64（89/8B）
 *   - add/sub/and/or/xor/cmp r32/r64, r32/r64 与 imm32/imm8（01/03/…、81/83）
 *   - test r32/r64, r32/r64（85）
 *   - inc/dec r32/r64（FF /0、/1）
 *   - nop、jmp rel8/rel32、jcc rel8/rel32（块的最后一条）
 * 所有操作数都是寄存器或立即数，生成代码不访问客户机内存；标志位不在
 * 生成代码里重算，而是 call 回主模块的 jit_flags_* / jit_cond 包装，保证
 * 与解释器逐位一致。
 *
 * 执行入口 jit_try(rip)：按 RIP 直接映射缓存；缓存项带代码物理页的
 * 「写代数」，客户机每次写内存时 mem.c6 递增对应页的代数，命中时比对，
 * 变了就重新翻译——这就是 SMC 失效。只对内核 text 窗口 + CPL0 启用。
 */
#include <stddef.h>
#include "c6sim.h"

#define JIT_MOD_MAX 8192
#define JIT_MAX_INS 16
#define JIT_CACHE 8192
#define JIT_MAX_COMPILES 8192
#define JIT_SEEN 8192
#define JIT_HOT 64

static u8 jit_mod[JIT_MOD_MAX];

/* 由 JS 提供（build.sh 的 JIT=1 链接加 --allow-undefined） */
extern int js_jit_compile(u32 ptr, u32 len, u32 rip_lo, u32 rip_hi,
                          u32 n, u32 pa_page, u32 gen, u32 branch);
extern int js_jit_run(int handle, u32 state_off, u32 ram_off,
                      u32 rip_off, u32 max_ins);

int g_jit_on = 1;
static u64 jit_lo = 0xffffffff80000000ull;
static u64 jit_hi = 0xffffffffc0000000ull;
static int jit_compiles = 0;
static u64 jit_n_compile = 0;
static u64 jit_n_hit = 0;
static u64 jit_n_insn = 0;
u64 g_jit_bad_boundary = 0;
u64 g_jit_flush_gen = 0;
u8 g_jit_bad[524288];
u8 g_jit_good[524288];   /* 64K 个 64-bit 位图：不可翻译的 RIP，C 侧快速跳过 */
int g_jit_trace = 0;
u32 g_jit_trace_n = 0;
u64 g_jit_bad_budget = 0;


u64 jit_stat(int i)
{
    if (i == 0) return jit_n_compile;
    if (i == 1) return jit_n_hit;
    if (i == 3) return (u64)jit_compiles;
    if (i == 6) return jit_n_insn;
    if (i == 7) return g_jit_bad_boundary;
    if (i == 8) return g_jit_bad_budget;
    return 0;
}

struct JitEnt {
    u64 rip;
    u32 n;
    u32 handle;
    u32 pa_page;
    u32 gen;
    u8 valid;
};

static struct JitEnt jit_cache[JIT_CACHE];

struct SeenEnt {
    u64 rip;
    u16 cnt;
    u8 valid;
};

static struct SeenEnt jit_seen[JIT_SEEN];

struct WBuf {
    u8 *p;
    u32 n;
    u32 cap;
};

static void wb_u8(struct WBuf *w, u8 v)
{
    if (w->n < w->cap) w->p[w->n++] = v;
}

static void wb_bytes(struct WBuf *w, const u8 *p, u32 n)
{
    u32 i = 0;
    for (i = 0; i < n; i++)
        wb_u8(w, p[i]);
}

static void wb_leb(struct WBuf *w, u64 v)
{
    do {
        u8 b = (u8)(v & 0x7full);
        v >>= 7;
        if (v != 0) b |= 0x80u;
        wb_u8(w, b);
    } while (v != 0);
}

static void wb_sleb(struct WBuf *w, i64 v)
{
    int more = 1;
    while (more) {
        u8 b = (u8)((u64)v & 0x7full);
        int sign = (b & 0x40u) != 0;
        v >>= 7;
        if ((v == 0 && !sign) || (v == -1 && sign))
            more = 0;
        else
            b |= 0x80u;
        wb_u8(w, b);
    }
}

static void wb_name(struct WBuf *w, const char *s)
{
    u32 n = 0;
    while (s[n] != 0) n++;
    wb_leb(w, n);
    while (*s != 0)
        wb_u8(w, (u8)*s++);
}

static void wb_section(struct WBuf *out, u8 id, struct WBuf *body)
{
    wb_u8(out, id);
    wb_leb(out, body->n);
    wb_bytes(out, body->p, body->n);
}

/* ---- 客户机指令解码 ---- */
enum {
    J_NOP = 1, J_MOVI, J_MOVMI, J_MOVRR, J_MOVRM, J_MOVMR,
    J_ADD, J_SUB, J_AND, J_OR, J_XOR, J_CMP, J_TEST,
    J_INC, J_DEC, J_LEA, J_MOVZX, J_MOVSX,
    J_PUSH, J_POP, J_CALL, J_RET, J_LEAVE,
    J_SHIFT, J_IMUL, J_MOVSXD, J_SEXT, J_SEXT_D, J_CMOV, J_PUSHF, J_POPF,
    J_JMP, J_JCC
};

struct JIns {
    u8 op;
    u8 dst;
    u8 src;
    u8 sz;       /* 4 或 8 */
    u8 is_imm;
    u8 branch;   /* 1 = 块的最后一条是 jmp/jcc */
    u8 callret;  /* 1 = call/ret，块结束并自己写 RIP */
    u8 cnt_cl;   /* 移位计数来自 CL */
    u8 cc;       /* jcc 条件码 */
    u8 base;     /* LEA: 0xff = 无 */
    u8 index;    /* LEA: 0xff = 无 */
    u8 scale;    /* LEA: 0..3 -> ×1/2/4/8 */
    u8 from;     /* MOVZX/MOVSX 源宽度：1/2 字节 */
    u8 src_hi;   /* 无 REX 的 8 位源是 AH/CH/DH/BH */
    u8 rip_rel;  /* LEA 的 RIP 相对 */
    u8 mem;      /* 有内存操作数 */
    u8 mem_dst;  /* 内存是目的（读改写/写） */
    u8 mem_src;  /* 内存是源（读） */
    u8 mem_sz;   /* 内存访问宽度 1/2/4/8 */
    int disp;    /* 位移（已符号扩展） */
    u64 imm;
    u64 rip;
    u64 target;
    u32 len;
};

static u64 jit_mr8(u64 a) { return mem_r8(a); }

static u32 jit_rd32(u64 a)
{
    u32 v = 0;
    u32 i = 0;
    for (i = 0; i < 4; i++)
        v |= (u32)jit_mr8(a + (u64)i) << (i * 8);
    return v;
}

static u64 jit_rd64(u64 a)
{
    u64 v = 0;
    u32 i = 0;
    for (i = 0; i < 8; i++)
        v |= (u64)jit_mr8(a + (u64)i) << (i * 8);
    return v;
}

/* 解析 ModRM 内存操作数（mod != 3）：base/index/scale/disp/rip_rel，
 * 并把 in->len 设到地址字节之后。成功返回 1；mod==3/非法返回 0。 */
static int jit_parse_mem(u64 p, u32 mrm_pos, u8 rex, struct JIns *in)
{
    u8 m = (u8)jit_mr8(p + mrm_pos);
    u32 mod = (u32)(m >> 6);
    u32 rm = (u32)(m & 7);
    u32 dp = mrm_pos + 1;
    int disp = 0;
    u32 base = 0xff, index = 0xff;
    u8 scale = 0, rip_rel = 0;

    if (mod == 3)
        return 0;
    if (mod == 0 && rm == 5) {         /* RIP 相对 */
        disp = (int)jit_rd32(p + dp);
        dp += 4;
        rip_rel = 1;
    } else {
        if (rm == 4) {
            u8 sib = (u8)jit_mr8(p + dp);
            u32 rawidx = (u32)((sib >> 3) & 7);
            dp++;
            index = rawidx | ((rex & 2) ? 8 : 0);
            if (rawidx == 4 && !(rex & 2))
                index = 0xff;
            base = (u32)(sib & 7) | ((rex & 1) ? 8 : 0);
            scale = (u8)((sib >> 6) & 3);
            if ((sib & 7) == 5 && mod == 0) {
                base = 0xff;
                disp = (int)jit_rd32(p + dp);
                dp += 4;
            }
        } else {
            base = rm | ((rex & 1) ? 8 : 0);
        }
        if (mod == 1) {
            disp = (int)(i8)jit_mr8(p + dp);
            dp++;
        } else if (mod == 2) {
            disp = (int)jit_rd32(p + dp);
            dp += 4;
        }
    }
    in->base = (u8)base;
    in->index = (u8)index;
    in->scale = scale;
    in->disp = disp;
    in->rip_rel = rip_rel;
    in->len = dp;
    return 1;
}

/* 解码一条指令。调用方保证 p 所在页还剩 >= 16 字节。
 * 成功返回 1 并填 in->len/rip；不支持返回 0。 */
static int jit_decode_one(u64 p, struct JIns *in)
{
    u32 pos = 0;
    u8 op = (u8)jit_mr8(p);
    u8 rex = 0;
    int p66 = 0;
    u8 mrm = 0;
    u8 sz = 4;

    for (u32 k = 0; k < (u32)sizeof(*in); k++) ((u8 *)in)[k] = 0;
    in->rip = p;

    if (op == 0x66) {
        p66 = 1;
        pos++;
        op = (u8)jit_mr8(p + pos);
    }
    if ((op & 0xf0) == 0x40) {
        rex = op;
        pos++;
        op = (u8)jit_mr8(p + pos);
    }
    sz = (rex & 8) ? 8 : (p66 ? 2 : 4);
    if (sz == 2)
        return 0;                     /* 16 位暂不支持 */
    in->sz = sz;

    if (op == 0x90) {
        if ((rex & 0x0f) != 0)
            return 0;                 /* 带 REX.B 的 90 是 xchg */
        in->op = J_NOP;
        in->len = pos + 1;
        return 1;
    }
    if (op == 0xf3) {                 /* F3 0F 1E FA：endbr64，当 NOP */
        u8 b1 = (u8)jit_mr8(p + 1);
        if (b1 == 0x0f && (u8)jit_mr8(p + 2) == 0x1e) {
            (void)jit_mr8(p + 3);
            in->op = J_NOP;
            in->len = 4;
            return 1;
        }
        return 0;
    }
    if (op == 0x98) {                 /* cbw/cwde/cdqe */
        in->op = J_SEXT;
        in->sz = (rex & 8) ? 8 : 4;
        in->len = pos + 1;
        return 1;
    }
    if (op == 0x99) {                 /* cwd/cdq/cqo */
        in->op = J_SEXT_D;
        in->sz = (rex & 8) ? 8 : 4;
        in->len = pos + 1;
        return 1;
    }
    if (op == 0x9c) {                 /* pushfq */
        in->op = J_PUSHF;
        in->sz = 8;
        in->len = pos + 1;
        return 1;
    }
    if (op == 0x9d) {                 /* popfq */
        in->op = J_POPF;
        in->sz = 8;
        in->len = pos + 1;
        return 1;
    }
    if (op == 0x63) {                 /* movsxd r64, r/m32 */
        mrm = (u8)jit_mr8(p + pos + 1);
        in->op = J_MOVSXD;
        in->dst = (u8)(((mrm >> 3) & 7) | ((rex & 4) ? 8 : 0));
        in->sz = 8;
        if ((mrm >> 6) == 3) {
            in->src = (u8)((mrm & 7) | ((rex & 1) ? 8 : 0));
            in->len = pos + 2;
            return 1;
        }
        if (!jit_parse_mem(p, pos + 1, rex, in))
            return 0;
        in->mem = 1;
        in->mem_src = 1;
        in->mem_sz = 4;
        return 1;
    }
    if (op == 0xc1 || op == 0xd1 || op == 0xd3) {   /* shl/shr/sar/rol/... */
        u32 fn = 0;
        mrm = (u8)jit_mr8(p + pos + 1);
        fn = (mrm >> 3) & 7;
        if (fn == 6) fn = 4;
        in->op = J_SHIFT;
        in->from = (u8)fn;
        in->sz = (rex & 8) ? 8 : 4;
        if ((mrm >> 6) == 3) {
            in->dst = (u8)((mrm & 7) | ((rex & 1) ? 8 : 0));
            in->len = pos + 2;
        } else {
            if (!jit_parse_mem(p, pos + 1, rex, in))
                return 0;
            in->mem = 1;
            in->mem_dst = 1;
            in->mem_sz = in->sz;
        }
        if (op == 0xc1) {
            in->imm = (u64)jit_mr8(p + in->len);
            in->len += 1;
        } else if (op == 0xd3) {
            in->cnt_cl = 1;
        } else {
            in->imm = 1;
        }
        return 1;
    }
    if (op == 0x69 || op == 0x6b) {   /* imul r, r/m, imm */
        mrm = (u8)jit_mr8(p + pos + 1);
        in->op = J_IMUL;
        in->dst = (u8)(((mrm >> 3) & 7) | ((rex & 4) ? 8 : 0));
        in->sz = sz;
        in->is_imm = 1;
        if ((mrm >> 6) == 3) {
            in->src = (u8)((mrm & 7) | ((rex & 1) ? 8 : 0));
            in->len = pos + 2;
        } else {
            if (!jit_parse_mem(p, pos + 1, rex, in))
                return 0;
            in->mem = 1;
            in->mem_src = 1;
            in->mem_sz = sz;
        }
        if (op == 0x6b) {
            u32 b2 = (u32)jit_mr8(p + in->len);
            if (b2 & 0x80u) b2 |= 0xffffff00u;
            in->imm = (u64)(i64)(i32)b2;
            in->len += 1;
        } else {
            in->imm = (u64)(i64)(i32)(u32)jit_rd32(p + in->len);
            in->len += 4;
        }
        return 1;
    }
    if (op >= 0xb8 && op <= 0xbf) {
        u32 r = (op & 7) | ((rex & 1) ? 8 : 0);
        in->op = J_MOVI;
        in->dst = (u8)r;
        in->is_imm = 1;
        if (sz == 8) {
            in->imm = jit_rd64(p + pos + 1);
            in->len = pos + 9;
        } else {
            in->imm = (u64)jit_rd32(p + pos + 1);
            in->len = pos + 5;
        }
        return 1;
    }
    if (op == 0xc7) {
        mrm = (u8)jit_mr8(p + pos + 1);
        if (((mrm >> 3) & 7) != 0)
            return 0;
        in->op = J_MOVMI;
        in->is_imm = 1;
        if ((mrm >> 6) == 3) {
            in->dst = (u8)((mrm & 7) | ((rex & 1) ? 8 : 0));
            in->imm = (u64)jit_rd32(p + pos + 2);
            if (sz == 8)
                in->imm = (u64)(i64)(i32)(u32)in->imm;
            in->len = pos + 6;
            return 1;
        }
        if (!jit_parse_mem(p, pos + 1, rex, in))
            return 0;
        in->mem = 1;
        in->mem_dst = 1;
        in->mem_sz = sz;
        in->imm = (u64)jit_rd32(p + in->len);
        if (sz == 8)
            in->imm = (u64)(i64)(i32)(u32)in->imm;
        in->len += 4;
        return 1;
    }
    if (op == 0x8d) {                 /* LEA reg, [base+index*scale+disp] */
        u8 m = (u8)jit_mr8(p + pos + 1);
        if (!jit_parse_mem(p, pos + 1, rex, in))
            return 0;
        in->op = J_LEA;
        in->dst = (u8)(((m >> 3) & 7) | ((rex & 4) ? 8 : 0));
        in->sz = (rex & 8) ? 8 : 4;
        return 1;
    }
    if (op == 0x89 || op == 0x8b) {
        u32 reg = 0, rm = 0;
        mrm = (u8)jit_mr8(p + pos + 1);
        reg = ((mrm >> 3) & 7) | ((rex & 4) ? 8 : 0);
        rm = (mrm & 7) | ((rex & 1) ? 8 : 0);
        if ((mrm >> 6) == 3) {
            in->op = J_MOVRR;
            in->dst = (u8)((op == 0x8b) ? reg : rm);
            in->src = (u8)((op == 0x8b) ? rm : reg);
            in->len = pos + 2;
            return 1;
        }
        if (!jit_parse_mem(p, pos + 1, rex, in))
            return 0;
        in->sz = sz;
        in->mem = 1;
        in->mem_sz = sz;
        if (op == 0x8b) {
            in->op = J_MOVRM;
            in->dst = (u8)reg;
            in->mem_src = 1;
        } else {
            in->op = J_MOVMR;
            in->src = (u8)reg;
            in->mem_dst = 1;
        }
        return 1;
    }
    if (op == 0x01 || op == 0x03 || op == 0x29 || op == 0x2b ||
        op == 0x21 || op == 0x23 || op == 0x09 || op == 0x0b ||
        op == 0x31 || op == 0x33 || op == 0x39 || op == 0x3b || op == 0x85) {
        u32 reg, rm;
        mrm = (u8)jit_mr8(p + pos + 1);
        reg = ((mrm >> 3) & 7) | ((rex & 4) ? 8 : 0);
        rm = (mrm & 7) | ((rex & 1) ? 8 : 0);
        if ((mrm >> 6) != 3) {
            if (!jit_parse_mem(p, pos + 1, rex, in))
                return 0;
            in->sz = sz;
            in->mem = 1;
            in->mem_sz = sz;
            if (op == 0x85) {
                in->op = J_TEST;
                in->src = (u8)reg;
                in->mem_src = 1;
            } else {
                u32 base = op & 0xfd;
                switch (base) {
                case 0x01: in->op = J_ADD; break;
                case 0x29: in->op = J_SUB; break;
                case 0x21: in->op = J_AND; break;
                case 0x09: in->op = J_OR; break;
                case 0x31: in->op = J_XOR; break;
                case 0x39: in->op = J_CMP; break;
                default: return 0;
                }
                if (((op >> 1) & 1) == 0) {   /* r/m 是目的：01/21/29/31/39 */
                    in->dst = 0xff;
                    in->src = (u8)reg;
                    in->mem_dst = 1;
                } else {                      /* reg 是目的：03/23/2b/33/3b */
                    in->dst = (u8)reg;
                    in->src = 0xff;
                    in->mem_src = 1;
                }
            }
            return 1;
        }
        if (op == 0x85) { in->op = J_TEST; in->dst = (u8)rm; in->src = (u8)reg; }
        else {
            u32 base = op & 0xfd;
            u32 dir = (op >> 1) & 1;
            switch (base) {
            case 0x01: in->op = J_ADD; break;
            case 0x29: in->op = J_SUB; break;
            case 0x21: in->op = J_AND; break;
            case 0x09: in->op = J_OR; break;
            case 0x31: in->op = J_XOR; break;
            case 0x39: in->op = J_CMP; break;
            default: return 0;
            }
            in->dst = (u8)(dir ? reg : rm);
            in->src = (u8)(dir ? rm : reg);
        }
        in->len = pos + 2;
        return 1;
    }
    if (op == 0xff) {
        u32 sub = 0;
        mrm = (u8)jit_mr8(p + pos + 1);
        sub = (mrm >> 3) & 7;
        if (sub == 6) {                   /* push r/m64 */
            if ((mrm & 0xc0) == 0xc0) {
                in->op = J_PUSH;
                in->dst = (u8)((mrm & 7) | ((rex & 1) ? 8 : 0));
                in->sz = 8;
                in->len = pos + 2;
                return 1;
            }
            if (!jit_parse_mem(p, pos + 1, rex, in))
                return 0;
            in->op = J_PUSH;
            in->mem = 1;
            in->mem_src = 1;
            in->mem_sz = 8;
            in->sz = 8;
            return 1;
        }
        if ((mrm & 0xc0) != 0xc0) {
            if (sub != 0 && sub != 1)
                return 0;
            if (!jit_parse_mem(p, pos + 1, rex, in))
                return 0;
            in->op = (sub == 0) ? J_INC : J_DEC;
            in->sz = sz;
            in->mem = 1;
            in->mem_dst = 1;
            in->mem_sz = sz;
            return 1;
        }
        if (sub == 0) in->op = J_INC;
        else if (sub == 1) in->op = J_DEC;
        else return 0;
        in->dst = (u8)((mrm & 7) | ((rex & 1) ? 8 : 0));
        in->len = pos + 2;
        return 1;
    }
    if (op == 0x81 || op == 0x83) {
        u32 sub = 0;
        mrm = (u8)jit_mr8(p + pos + 1);
        sub = (mrm >> 3) & 7;
        if (sub != 0 && sub != 5 && sub != 7)
            return 0;
        in->op = (sub == 0) ? J_ADD : (sub == 5) ? J_SUB : J_CMP;
        in->is_imm = 1;
        if ((mrm >> 6) == 3) {
            in->dst = (u8)((mrm & 7) | ((rex & 1) ? 8 : 0));
            if (op == 0x83) {
                u32 b = (u32)jit_mr8(p + pos + 2);
                if (b & 0x80u) b |= 0xffffff00u;
                in->imm = (u64)b;
                if (sz == 8) in->imm = (u64)(i64)(i32)b;
                in->len = pos + 3;
            } else {
                in->imm = (u64)jit_rd32(p + pos + 2);
                if (sz == 8) in->imm = (u64)(i64)(i32)(u32)in->imm;
                in->len = pos + 6;
            }
            return 1;
        }
        if (!jit_parse_mem(p, pos + 1, rex, in))
            return 0;
        in->sz = sz;
        in->mem = 1;
        in->mem_dst = 1;
        in->mem_sz = sz;
        if (op == 0x83) {
            u32 b = (u32)jit_mr8(p + in->len);
            if (b & 0x80u) b |= 0xffffff00u;
            in->imm = (u64)b;
            if (sz == 8) in->imm = (u64)(i64)(i32)b;
            in->len += 1;
        } else {
            in->imm = (u64)jit_rd32(p + in->len);
            if (sz == 8) in->imm = (u64)(i64)(i32)(u32)in->imm;
            in->len += 4;
        }
        return 1;
    }
    if (op >= 0x50 && op <= 0x57) {       /* push r64 */
        in->op = J_PUSH;
        in->dst = (u8)((op & 7) | ((rex & 1) ? 8 : 0));
        in->sz = 8;
        in->len = pos + 1;
        return 1;
    }
    if (op >= 0x58 && op <= 0x5f) {       /* pop r64 */
        in->op = J_POP;
        in->dst = (u8)((op & 7) | ((rex & 1) ? 8 : 0));
        in->sz = 8;
        in->len = pos + 1;
        return 1;
    }
    if (op == 0x6a || op == 0x68) {       /* push imm8/imm32 */
        in->op = J_PUSH;
        in->is_imm = 1;
        in->sz = 8;
        if (op == 0x6a) {
            in->imm = (u64)(i64)(i8)jit_mr8(p + pos + 1);
            in->len = pos + 2;
        } else {
            in->imm = (u64)(i64)(i32)jit_rd32(p + pos + 1);
            in->len = pos + 5;
        }
        return 1;
    }
    if (op == 0xe8) {                     /* call rel32 */
        i64 d = (i64)(i32)jit_rd32(p + pos + 1);
        in->op = J_CALL;
        in->callret = 1;
        in->len = pos + 5;
        in->target = (u64)((i64)p + (i64)in->len + d);
        return 1;
    }
    if (op == 0xc3) {                     /* ret */
        in->op = J_RET;
        in->callret = 1;
        in->len = pos + 1;
        return 1;
    }
    if (op == 0xc9) {                     /* leave */
        in->op = J_LEAVE;
        in->len = pos + 1;
        return 1;
    }
    if (op == 0xeb || op == 0xe9) {
        i64 d = 0;
        in->op = J_JMP;
        in->branch = 1;
        if (op == 0xeb) {
            d = (i64)(i8)jit_mr8(p + pos + 1);
            in->len = pos + 2;
        } else {
            d = (i64)(i32)jit_rd32(p + pos + 1);
            in->len = pos + 5;
        }
        in->target = (u64)((i64)p + (i64)in->len + d);
        return 1;
    }
    if (op >= 0x70 && op <= 0x7f) {
        i64 d = (i64)(i8)jit_mr8(p + pos + 1);
        in->op = J_JCC;
        in->branch = 1;
        in->cc = (u8)(op - 0x70);
        in->len = pos + 2;
        in->target = (u64)((i64)p + (i64)in->len + d);
        return 1;
    }
    if (op == 0x0f) {
        u8 op2 = (u8)jit_mr8(p + pos + 1);
        if (op2 >= 0x80 && op2 <= 0x8f) {
            i64 d = (i64)(i32)jit_rd32(p + pos + 2);
            in->op = J_JCC;
            in->branch = 1;
            in->cc = (u8)(op2 - 0x80);
            in->len = pos + 6;
            in->target = (u64)((i64)p + (i64)in->len + d);
            return 1;
        }
        if (op2 == 0xaf) {            /* imul r, r/m */
            u8 m = (u8)jit_mr8(p + pos + 2);
            in->op = J_IMUL;
            in->dst = (u8)(((m >> 3) & 7) | ((rex & 4) ? 8 : 0));
            in->sz = sz;
            if ((m >> 6) == 3) {
                in->src = (u8)((m & 7) | ((rex & 1) ? 8 : 0));
                in->len = pos + 3;
                return 1;
            }
            if (!jit_parse_mem(p, pos + 2, rex, in))
                return 0;
            in->mem = 1;
            in->mem_src = 1;
            in->mem_sz = sz;
            return 1;
        }
        if (op2 >= 0x40 && op2 <= 0x4f) {   /* cmovcc */
            u8 m = (u8)jit_mr8(p + pos + 2);
            in->op = J_CMOV;
            in->cc = (u8)(op2 - 0x40);
            in->dst = (u8)(((m >> 3) & 7) | ((rex & 4) ? 8 : 0));
            in->sz = sz;
            if ((m >> 6) == 3) {
                in->src = (u8)((m & 7) | ((rex & 1) ? 8 : 0));
                in->len = pos + 3;
                return 1;
            }
            if (!jit_parse_mem(p, pos + 2, rex, in))
                return 0;
            in->mem = 1;
            in->mem_src = 1;
            in->mem_sz = sz;
            return 1;
        }
        if (op2 == 0x1f || op2 == 0x1e) {   /* nop r/m / endbr */
            u8 m = (u8)jit_mr8(p + pos + 2);
            in->op = J_NOP;
            if ((m >> 6) == 3) {
                in->len = pos + 3;
                return 1;
            }
            if (!jit_parse_mem(p, pos + 2, rex, in))
                return 0;
            in->mem = 0;              /* 只吃地址字节，不访问 */
            return 1;
        }
        if (op2 == 0xb6 || op2 == 0xb7 || op2 == 0xbe || op2 == 0xbf) {
            u8 m = (u8)jit_mr8(p + pos + 2);
            in->op = (op2 == 0xb6 || op2 == 0xb7) ? J_MOVZX : J_MOVSX;
            in->from = (u8)((op2 == 0xb6 || op2 == 0xbe) ? 1 : 2);
            in->dst = (u8)(((m >> 3) & 7) | ((rex & 4) ? 8 : 0));
            in->sz = (rex & 8) ? 8 : 4;
            if ((m >> 6) != 3) {
                if (!jit_parse_mem(p, pos + 2, rex, in))
                    return 0;
                in->mem = 1;
                in->mem_src = 1;
                in->mem_sz = in->from;
                return 1;
            }
            if ((op2 == 0xb6 || op2 == 0xbe) && rex == 0 && (m & 7) >= 4) {
                in->src_hi = 1;
                in->src = (u8)((m & 7) - 4);
            } else {
                in->src = (u8)((m & 7) | ((rex & 1) ? 8 : 0));
            }
            in->sz = (rex & 8) ? 8 : 4;
            in->len = pos + 3;
            return 1;
        }
        return 0;
    }
    return 0;
}

static int jit_decode_block(u64 rip, struct JIns *ins, u64 *end)
{
    u64 p = rip;
    int n = 0;
    while (n < JIT_MAX_INS) {
        struct JIns t;
        u32 len = 0;
        if ((p & 0xfffull) > 0xff0ull)
            break;                    /* 页尾留 16 字节余量 */
        if (!jit_decode_one(p, &t))
            break;
        len = t.len;
        if (len == 0 || ((p & 0xfffull) + (u64)len) > 0x1000ull)
            break;
        ins[n] = t;
        n++;
        p += (u64)len;
        if (t.branch || t.callret)
            break;
    }
    *end = p;
    return n;
}

/* ---- wasm 编码辅助 ---- */
static void e_i32_const(struct WBuf *b, u32 v) { wb_u8(b, 0x41); wb_sleb(b, (i64)v); }
static void e_i64_const(struct WBuf *b, u64 v) { wb_u8(b, 0x42); wb_sleb(b, (i64)v); }
static void e_get(struct WBuf *b, u32 i) { wb_u8(b, 0x20); wb_leb(b, i); }
static void e_set(struct WBuf *b, u32 i) { wb_u8(b, 0x21); wb_leb(b, i); }
static void e_call(struct WBuf *b, u32 i) { wb_u8(b, 0x10); wb_leb(b, i); }
static void e_wrap(struct WBuf *b) { wb_u8(b, 0xa7); }
static void e_ext_u(struct WBuf *b) { wb_u8(b, 0xad); }
static void e_addr(struct WBuf *b, u32 off)
{
    e_get(b, 0);
    e_i32_const(b, off);
    wb_u8(b, 0x6a);                   /* i32.add */
}
static void e_load64(struct WBuf *b, u32 off)
{
    e_addr(b, off);
    wb_u8(b, 0x29); wb_leb(b, 3); wb_leb(b, 0);
}
static void e_store64(struct WBuf *b)
{
    wb_u8(b, 0x37); wb_leb(b, 3); wb_leb(b, 0);
}
static void e_addr_val(struct WBuf *b, const struct JIns *x, u32 rax_off)
{
    if (x->rip_rel) {
        e_i64_const(b, x->rip + (u64)x->len);
    } else if (x->base != 0xff) {
        e_load64(b, rax_off + (u32)x->base * 8u);
    } else {
        e_i64_const(b, 0);
    }
    if (x->index != 0xff) {
        e_load64(b, rax_off + (u32)x->index * 8u);
        if (x->scale != 0) {
            e_i64_const(b, 1ull << x->scale);
            wb_u8(b, 0x7e);
        }
        wb_u8(b, 0x7c);
    }
    if (x->disp != 0) {
        e_i64_const(b, (u64)(i64)x->disp);
        wb_u8(b, 0x7c);
    }
}
/* if (jit_faulted()) { RIP = 该指令; return k+1; } */
static void e_fault_check(struct WBuf *b, u32 rip_off, u64 rip, int k)
{
    e_call(b, 8);
    wb_u8(b, 0x04); wb_u8(b, 0x40);
    e_addr(b, rip_off); e_i64_const(b, rip); e_store64(b);
    e_i32_const(b, (u32)(k + 1));
    wb_u8(b, 0x0f);
    wb_u8(b, 0x0b);
}
static void e_mem_load(struct WBuf *b, const struct JIns *x, int k, u32 rip_off)
{
    e_get(b, 5); e_i64_const(b, (u64)x->mem_sz); e_call(b, 6); e_set(b, 6);
    e_fault_check(b, rip_off, x->rip, k);
}
static void e_mem_store(struct WBuf *b, const struct JIns *x, int k, u32 rip_off)
{
    e_get(b, 5); e_get(b, 4); e_i64_const(b, (u64)x->mem_sz);
    e_i64_const(b, x->rip); e_call(b, 7);
    e_fault_check(b, rip_off, x->rip, k);
}
/* 把 local 2/3 按操作数宽度算成 64 位，结果放 local 4 */
static void e_alu_result(struct WBuf *b, u8 sz, u8 op32, u8 op64)
{
    if (sz == 8) {
        e_get(b, 2); e_get(b, 3); wb_u8(b, op64);
    } else {
        e_get(b, 2); e_wrap(b);
        e_get(b, 3); e_wrap(b);
        wb_u8(b, op32);
        e_ext_u(b);
    }
    e_set(b, 4);
}

static u32 jit_build_module(const struct JIns *ins, int n, u64 end_rip)
{
    u8 t1[256], t2[512], t3[64], t4[64], t5[8192];
    u32 rax_off = (u32)offsetof(struct Machine, cpu.r[0]);
    u32 rip_off = (u32)offsetof(struct Machine, cpu.rip);
    u32 fl_off = (u32)offsetof(struct Machine, cpu.flags);
    u32 rsp_off = rax_off + 4u * 8u;
    u32 rbp_off = rax_off + 5u * 8u;
    struct WBuf out = { jit_mod, 0, JIT_MOD_MAX };
    struct WBuf b;
    int k = 0;
    int has_branch = 0;
    int has_term = 0;

    wb_u8(&out, 0x00); wb_u8(&out, 0x61); wb_u8(&out, 0x73); wb_u8(&out, 0x6d);
    wb_u8(&out, 0x01); wb_u8(&out, 0x00); wb_u8(&out, 0x00); wb_u8(&out, 0x00);

    /* type: 0=(i32,i32)->i32; 1=(i64,i64,i64,i32)->(); 2=(i64,i32)->();
     *       3=(i64,i64,i32)->(); 4=(i64,i64)->i32;
     *       5=(i64,i64)->i64 (jit_ld); 6=(i64,i64,i64)->() (jit_st);
     *       7=()->i32 (jit_faulted) */
    b.p = t1; b.n = 0; b.cap = sizeof(t1);
    wb_u8(&b, 0x0a);
    wb_u8(&b, 0x60); wb_u8(&b, 0x02); wb_u8(&b, 0x7f); wb_u8(&b, 0x7f);
    wb_u8(&b, 0x01); wb_u8(&b, 0x7f);
    wb_u8(&b, 0x60); wb_u8(&b, 0x04); wb_u8(&b, 0x7e); wb_u8(&b, 0x7e);
    wb_u8(&b, 0x7e); wb_u8(&b, 0x7f); wb_u8(&b, 0x00);
    wb_u8(&b, 0x60); wb_u8(&b, 0x02); wb_u8(&b, 0x7e); wb_u8(&b, 0x7f); wb_u8(&b, 0x00);
    wb_u8(&b, 0x60); wb_u8(&b, 0x03); wb_u8(&b, 0x7e); wb_u8(&b, 0x7e);
    wb_u8(&b, 0x7f); wb_u8(&b, 0x00);
    wb_u8(&b, 0x60); wb_u8(&b, 0x02); wb_u8(&b, 0x7e); wb_u8(&b, 0x7e);
    wb_u8(&b, 0x01); wb_u8(&b, 0x7f);
    wb_u8(&b, 0x60); wb_u8(&b, 0x02); wb_u8(&b, 0x7e); wb_u8(&b, 0x7e);
    wb_u8(&b, 0x01); wb_u8(&b, 0x7e);
    wb_u8(&b, 0x60); wb_u8(&b, 0x04); wb_u8(&b, 0x7e); wb_u8(&b, 0x7e);
    wb_u8(&b, 0x7e); wb_u8(&b, 0x7e); wb_u8(&b, 0x00);
    wb_u8(&b, 0x60); wb_u8(&b, 0x00); wb_u8(&b, 0x01); wb_u8(&b, 0x7f);
    wb_u8(&b, 0x60); wb_u8(&b, 0x04); wb_u8(&b, 0x7f); wb_u8(&b, 0x7e);
    wb_u8(&b, 0x7e); wb_u8(&b, 0x7f); wb_u8(&b, 0x01); wb_u8(&b, 0x7e);
    wb_u8(&b, 0x60); wb_u8(&b, 0x03); wb_u8(&b, 0x7e); wb_u8(&b, 0x7e);
    wb_u8(&b, 0x7f); wb_u8(&b, 0x01); wb_u8(&b, 0x7e);
    wb_section(&out, 0x01, &b);

    /* import: memory + flags/cond/ld/st/faulted。
     * 函数索引：add=0, sub=1, logic=2, inc=3, dec=4, cond=5,
     *           ld=6, st=7, faulted=8。 */
    b.p = t2; b.n = 0; b.cap = sizeof(t2);
    wb_u8(&b, 0x0c);
    wb_name(&b, "env"); wb_name(&b, "memory");
    wb_u8(&b, 0x02); wb_u8(&b, 0x01); wb_leb(&b, 0); wb_leb(&b, 65536);
    wb_name(&b, "env"); wb_name(&b, "jit_flags_add");   wb_u8(&b, 0x00); wb_leb(&b, 1);
    wb_name(&b, "env"); wb_name(&b, "jit_flags_sub");   wb_u8(&b, 0x00); wb_leb(&b, 1);
    wb_name(&b, "env"); wb_name(&b, "jit_flags_logic"); wb_u8(&b, 0x00); wb_leb(&b, 2);
    wb_name(&b, "env"); wb_name(&b, "jit_flags_inc");   wb_u8(&b, 0x00); wb_leb(&b, 3);
    wb_name(&b, "env"); wb_name(&b, "jit_flags_dec");   wb_u8(&b, 0x00); wb_leb(&b, 3);
    wb_name(&b, "env"); wb_name(&b, "jit_cond");        wb_u8(&b, 0x00); wb_leb(&b, 4);
    wb_name(&b, "env"); wb_name(&b, "jit_ld");          wb_u8(&b, 0x00); wb_leb(&b, 5);
    wb_name(&b, "env"); wb_name(&b, "jit_st");          wb_u8(&b, 0x00); wb_leb(&b, 6);
    wb_name(&b, "env"); wb_name(&b, "jit_faulted");     wb_u8(&b, 0x00); wb_leb(&b, 7);
    wb_name(&b, "env"); wb_name(&b, "jit_shift");       wb_u8(&b, 0x00); wb_leb(&b, 8);
    wb_name(&b, "env"); wb_name(&b, "jit_imul");        wb_u8(&b, 0x00); wb_leb(&b, 9);
    wb_section(&out, 0x02, &b);

    /* function: 一个函数，类型 0（索引 11） */
    b.p = t3; b.n = 0; b.cap = sizeof(t3);
    wb_u8(&b, 0x01); wb_leb(&b, 0);
    wb_section(&out, 0x03, &b);

    /* export: "run" -> func 11 */
    b.p = t4; b.n = 0; b.cap = sizeof(t4);
    wb_u8(&b, 0x01); wb_name(&b, "run");
    wb_u8(&b, 0x00); wb_leb(&b, 11);
    wb_section(&out, 0x07, &b);

    /* code：local 2/3/4=a/b/res，5=地址，6=内存读出值（均 i64） */
    b.p = t5; b.n = 0; b.cap = sizeof(t5);
    wb_u8(&b, 0x01); wb_u8(&b, 0x05); wb_u8(&b, 0x7e);

    for (k = 0; k < n; k++) {
        const struct JIns *x = &ins[k];
        u32 d = rax_off + (u32)x->dst * 8u;
        u32 s = rax_off + (u32)x->src * 8u;
        int logic = 0;

        if (x->branch) {
            has_branch = 1;
            continue;                 /* 分支单独处理 */
        }
        if (x->mem) {
            e_addr_val(&b, x, rax_off);
            e_set(&b, 5);
            if (!(x->op == J_MOVMR || (x->op == J_MOVMI && x->mem_dst)))
                e_mem_load(&b, x, k, rip_off);
        }
        switch (x->op) {
        case J_NOP:
            break;
        case J_MOVI:
            e_addr(&b, d); e_i64_const(&b, x->imm); e_store64(&b);
            break;
        case J_MOVMI:
            if (x->mem) {
                e_i64_const(&b, x->imm); e_set(&b, 4);
                e_mem_store(&b, x, k, rip_off);
            } else {
                e_addr(&b, d); e_i64_const(&b, x->imm); e_store64(&b);
            }
            break;
        case J_MOVRM:
            e_addr(&b, d); e_get(&b, 6); e_store64(&b);
            break;
        case J_MOVMR:
            e_load64(&b, s); e_set(&b, 4);
            e_mem_store(&b, x, k, rip_off);
            break;
        case J_MOVRR:
            e_addr(&b, d);
            e_load64(&b, s);
            if (x->sz == 4) { e_wrap(&b); e_ext_u(&b); }
            e_store64(&b);
            break;
        case J_INC:
        case J_DEC:
            if (x->mem) { e_get(&b, 6); e_set(&b, 2); }
            else { e_load64(&b, d); e_set(&b, 2); }
            if (x->sz == 8) {
                e_get(&b, 2);
                e_i64_const(&b, 1);
                wb_u8(&b, x->op == J_INC ? 0x7c : 0x7d);
            } else {
                e_get(&b, 2); e_wrap(&b);
                e_i32_const(&b, 1);
                wb_u8(&b, x->op == J_INC ? 0x6a : 0x6b);
                e_ext_u(&b);
            }
            e_set(&b, 4);
            if (x->mem) e_mem_store(&b, x, k, rip_off);
            else { e_addr(&b, d); e_get(&b, 4); e_store64(&b); }
            e_get(&b, 2); e_get(&b, 4); e_i32_const(&b, x->sz);
            e_call(&b, x->op == J_INC ? 3 : 4);
            break;
        case J_LEA:
            if (x->rip_rel) {
                e_i64_const(&b, x->rip + (u64)x->len);
            } else if (x->base != 0xff) {
                e_load64(&b, rax_off + (u32)x->base * 8u);
            } else {
                e_i64_const(&b, 0);
            }
            if (x->index != 0xff) {
                e_load64(&b, rax_off + (u32)x->index * 8u);
                if (x->scale != 0) {
                    e_i64_const(&b, 1ull << x->scale);
                    wb_u8(&b, 0x7e);          /* i64.mul */
                }
                wb_u8(&b, 0x7c);              /* i64.add */
            }
            if (x->disp != 0) {
                e_i64_const(&b, (u64)(i64)x->disp);
                wb_u8(&b, 0x7c);
            }
            e_set(&b, 2);
            e_addr(&b, d);
            e_get(&b, 2);
            if (x->sz == 4) { e_wrap(&b); e_ext_u(&b); }
            e_store64(&b);
            break;
        case J_MOVZX:
        case J_MOVSX:
            if (x->mem) {
                e_get(&b, 6);
            } else {
                e_load64(&b, s);
                if (x->src_hi) {
                    e_i64_const(&b, 8);
                    wb_u8(&b, 0x88);      /* i64.shr_u：取 AH/CH/DH/BH */
                }
            }
            e_wrap(&b);
            if (x->from == 1) {
                if (x->op == J_MOVZX) { e_i32_const(&b, 0xff); wb_u8(&b, 0x71); }
                else wb_u8(&b, 0xc0);     /* i32.extend8_s */
            } else {
                if (x->op == J_MOVZX) { e_i32_const(&b, 0xffff); wb_u8(&b, 0x71); }
                else wb_u8(&b, 0xc1);     /* i32.extend16_s */
            }
            if (x->op == J_MOVSX && x->sz == 8)
                wb_u8(&b, 0xac);          /* i64.extend_i32_s */
            else
                e_ext_u(&b);
            e_set(&b, 2);
            e_addr(&b, d);
            e_get(&b, 2);
            e_store64(&b);
            break;
        case J_TEST:
            if (x->mem) { e_get(&b, 6); e_set(&b, 2); }
            else { e_load64(&b, d); e_set(&b, 2); }
            e_load64(&b, s); e_set(&b, 3);
            if (x->sz == 8) {
                e_get(&b, 2); e_get(&b, 3); wb_u8(&b, 0x83);   /* and */
            } else {
                e_get(&b, 2); e_wrap(&b);
                e_get(&b, 3); e_wrap(&b);
                wb_u8(&b, 0x71); e_ext_u(&b);
            }
            e_set(&b, 4);
            e_get(&b, 4); e_i32_const(&b, x->sz); e_call(&b, 2);
            break;
        case J_PUSH:
            if (x->mem) { e_get(&b, 6); e_set(&b, 4); }
            else if (x->is_imm) { e_i64_const(&b, x->imm); e_set(&b, 4); }
            else { e_load64(&b, d); e_set(&b, 4); }
            e_load64(&b, rsp_off); e_i64_const(&b, 8); wb_u8(&b, 0x7d); e_set(&b, 5);
            e_get(&b, 5); e_get(&b, 4); e_i64_const(&b, 8); e_i64_const(&b, x->rip);
            e_call(&b, 7);
            e_fault_check(&b, rip_off, x->rip, k);
            e_addr(&b, rsp_off); e_get(&b, 5); e_store64(&b);
            break;
        case J_POP:
            e_load64(&b, rsp_off); e_set(&b, 5);
            e_get(&b, 5); e_i64_const(&b, 8); e_call(&b, 6); e_set(&b, 6);
            e_fault_check(&b, rip_off, x->rip, k);
            e_addr(&b, d); e_get(&b, 6); e_store64(&b);
            e_addr(&b, rsp_off); e_get(&b, 5); e_i64_const(&b, 8);
            wb_u8(&b, 0x7c); e_store64(&b);
            break;
        case J_CALL:
            has_term = 1;
            e_i64_const(&b, x->rip + (u64)x->len); e_set(&b, 4);
            e_load64(&b, rsp_off); e_i64_const(&b, 8); wb_u8(&b, 0x7d); e_set(&b, 5);
            e_get(&b, 5); e_get(&b, 4); e_i64_const(&b, 8); e_i64_const(&b, x->rip);
            e_call(&b, 7);
            e_fault_check(&b, rip_off, x->rip, k);
            e_addr(&b, rsp_off); e_get(&b, 5); e_store64(&b);
            e_addr(&b, rip_off); e_i64_const(&b, x->target); e_store64(&b);
            break;
        case J_RET:
            has_term = 1;
            e_load64(&b, rsp_off); e_set(&b, 5);
            e_get(&b, 5); e_i64_const(&b, 8); e_call(&b, 6); e_set(&b, 6);
            e_fault_check(&b, rip_off, x->rip, k);
            e_addr(&b, rip_off); e_get(&b, 6); e_store64(&b);
            e_addr(&b, rsp_off); e_get(&b, 5); e_i64_const(&b, 8);
            wb_u8(&b, 0x7c); e_store64(&b);
            break;
        case J_LEAVE:
            e_load64(&b, rbp_off); e_set(&b, 5);
            e_get(&b, 5); e_i64_const(&b, 8); e_call(&b, 6); e_set(&b, 6);
            e_fault_check(&b, rip_off, x->rip, k);
            e_addr(&b, rbp_off); e_get(&b, 6); e_store64(&b);
            e_addr(&b, rsp_off); e_get(&b, 5); e_i64_const(&b, 8);
            wb_u8(&b, 0x7c); e_store64(&b);
            break;
        case J_SHIFT:
            if (x->mem) { e_get(&b, 6); e_set(&b, 2); }
            else { e_load64(&b, d); e_set(&b, 2); }
            e_i32_const(&b, (u32)x->from);
            e_get(&b, 2);
            if (x->cnt_cl) e_load64(&b, rax_off + 8u);
            else e_i64_const(&b, x->imm);
            e_i32_const(&b, x->sz);
            e_call(&b, 9);
            e_set(&b, 4);
            if (x->mem) e_mem_store(&b, x, k, rip_off);
            else { e_addr(&b, d); e_get(&b, 4); e_store64(&b); }
            break;
        case J_IMUL:
            if (x->is_imm) {
                if (x->mem) { e_get(&b, 6); e_set(&b, 2); }
                else { e_load64(&b, s); e_set(&b, 2); }
                e_i64_const(&b, x->imm); e_set(&b, 3);
                if (x->sz == 8) {
                    e_get(&b, 2); e_get(&b, 3); wb_u8(&b, 0x7e);
                } else {
                    e_get(&b, 2); e_wrap(&b);
                    e_get(&b, 3); e_wrap(&b);
                    wb_u8(&b, 0x6c); e_ext_u(&b);
                }
                e_set(&b, 4);
            } else {
                e_load64(&b, d); e_set(&b, 2);
                if (x->mem) { e_get(&b, 6); e_set(&b, 3); }
                else { e_load64(&b, s); e_set(&b, 3); }
                e_get(&b, 2); e_get(&b, 3); e_i32_const(&b, x->sz);
                e_call(&b, 10);
                e_set(&b, 4);
            }
            e_addr(&b, d); e_get(&b, 4); e_store64(&b);
            break;
        case J_MOVSXD:
            if (x->mem) e_get(&b, 6);
            else e_load64(&b, s);
            e_wrap(&b);
            wb_u8(&b, 0xac);
            e_set(&b, 4);
            e_addr(&b, d); e_get(&b, 4); e_store64(&b);
            break;
        case J_SEXT:
            e_load64(&b, rax_off); e_wrap(&b);
            if (x->sz == 8) wb_u8(&b, 0xac);
            else { wb_u8(&b, 0xc1); e_ext_u(&b); }
            e_set(&b, 4);
            e_addr(&b, rax_off); e_get(&b, 4); e_store64(&b);
            break;
        case J_SEXT_D:
            if (x->sz == 8) {
                e_load64(&b, rax_off); e_i64_const(&b, 63); wb_u8(&b, 0x87);
            } else {
                e_load64(&b, rax_off); e_wrap(&b); e_i32_const(&b, 31);
                wb_u8(&b, 0x75); e_ext_u(&b);
            }
            e_set(&b, 4);
            e_addr(&b, rax_off + 16u); e_get(&b, 4); e_store64(&b);
            break;
        case J_CMOV:
            if (x->mem) { e_get(&b, 6); e_set(&b, 3); }
            else { e_load64(&b, s); e_set(&b, 3); }
            e_load64(&b, d); e_set(&b, 2);
            if (x->sz == 4) {
                e_get(&b, 2); e_wrap(&b); e_ext_u(&b); e_set(&b, 2);
                e_get(&b, 3); e_wrap(&b); e_ext_u(&b); e_set(&b, 3);
            }
            e_get(&b, 3); e_get(&b, 2);   /* select: cond 真取 src */
            e_load64(&b, fl_off); e_i64_const(&b, (u64)x->cc);
            e_call(&b, 5);
            wb_u8(&b, 0x1b);
            e_set(&b, 4);
            e_addr(&b, d); e_get(&b, 4); e_store64(&b);
            break;
        case J_PUSHF:
            e_load64(&b, fl_off); e_set(&b, 4);
            e_load64(&b, rsp_off); e_i64_const(&b, 8); wb_u8(&b, 0x7d); e_set(&b, 5);
            e_get(&b, 5); e_get(&b, 4); e_i64_const(&b, 8); e_i64_const(&b, x->rip);
            e_call(&b, 7);
            e_fault_check(&b, rip_off, x->rip, k);
            e_addr(&b, rsp_off); e_get(&b, 5); e_store64(&b);
            break;
        case J_POPF:
            e_load64(&b, rsp_off); e_set(&b, 5);
            e_get(&b, 5); e_i64_const(&b, 8); e_call(&b, 6); e_set(&b, 6);
            e_fault_check(&b, rip_off, x->rip, k);
            e_get(&b, 6); e_i64_const(&b, 2); wb_u8(&b, 0x84);
            e_set(&b, 4);
            e_addr(&b, fl_off); e_get(&b, 4); e_store64(&b);
            e_addr(&b, rsp_off); e_get(&b, 5); e_i64_const(&b, 8);
            wb_u8(&b, 0x7c); e_store64(&b);
            break;
        default:
            /* 二操作数 ALU */
            if (x->mem_dst) { e_get(&b, 6); e_set(&b, 2); }
            else { e_load64(&b, d); e_set(&b, 2); }
            if (x->mem_src) {
                e_get(&b, 6); e_set(&b, 3);
            } else if (x->is_imm) {
                e_i64_const(&b, x->imm); e_set(&b, 3);
            } else {
                e_load64(&b, s); e_set(&b, 3);
            }
            if (x->op == J_ADD) {
                e_alu_result(&b, x->sz, 0x6a, 0x7c);
            } else if (x->op == J_SUB || x->op == J_CMP) {
                e_alu_result(&b, x->sz, 0x6b, 0x7d);
            } else if (x->op == J_AND) {
                e_alu_result(&b, x->sz, 0x71, 0x83); logic = 1;
            } else if (x->op == J_OR) {
                e_alu_result(&b, x->sz, 0x72, 0x84); logic = 1;
            } else {   /* J_XOR */
                e_alu_result(&b, x->sz, 0x73, 0x85); logic = 1;
            }
            if (x->op != J_CMP) {
                if (x->mem_dst) e_mem_store(&b, x, k, rip_off);
                else { e_addr(&b, d); e_get(&b, 4); e_store64(&b); }
            }
            if (logic) {
                e_get(&b, 4); e_i32_const(&b, x->sz); e_call(&b, 2);
            } else if (x->op == J_ADD) {
                e_get(&b, 2); e_get(&b, 3); e_get(&b, 4);
                e_i32_const(&b, x->sz); e_call(&b, 0);
            } else {
                e_get(&b, 2); e_get(&b, 3); e_get(&b, 4);
                e_i32_const(&b, x->sz); e_call(&b, 1);
            }
            break;
        }
    }

    if (has_branch) {
        const struct JIns *x = &ins[n - 1];
        if (x->op == J_JMP) {
            e_addr(&b, rip_off); e_i64_const(&b, x->target); e_store64(&b);
        } else {
            /* addr, target, next, cond -> select -> store */
            e_addr(&b, rip_off);
            e_i64_const(&b, x->target);
            e_i64_const(&b, x->rip + (u64)x->len);
            e_load64(&b, fl_off);
            e_i64_const(&b, (u64)x->cc);
            e_call(&b, 5);            /* jit_cond(flags, cc) -> i32 */
            wb_u8(&b, 0x1b);          /* select */
            e_store64(&b);
        }
    } else if (!has_term) {
        e_addr(&b, rip_off); e_i64_const(&b, end_rip); e_store64(&b);
    }
    e_i32_const(&b, 0);
    wb_u8(&b, 0x0b);

    {
        struct WBuf c = { t5, 0, sizeof(t5) };
        u8 body[8192];
        u32 i = 0;
        for (i = 0; i < b.n && i < sizeof(body); i++) body[i] = b.p[i];
        wb_u8(&c, 0x01); wb_leb(&c, b.n); wb_bytes(&c, body, b.n);
        wb_section(&out, 0x0a, &c);
    }
    return out.n;
}

static void jit_mark_bad(u64 rip)
{
    u32 jb = (u32)((rip >> 3) & 0x3fffffull);
    g_jit_bad[jb >> 3] |= (u8)(1u << (jb & 7));
}

static void jit_mark_good(u64 rip)
{
    u32 jb = (u32)((rip >> 3) & 0x3fffffull);
    g_jit_good[jb >> 3] |= (u8)(1u << (jb & 7));
}

/* 编译并实例化一个新块；成功返回句柄，失败返回 -1。 */
static int jit_compile(u64 rip, u32 *n_out, u32 *pa_page, u32 *gen)
{
    struct JIns ins[JIT_MAX_INS];
    u64 end = 0;
    int n = 0;
    u32 len = 0;
    int h = 0;
    u64 pa = 0;

    if (jit_compiles >= JIT_MAX_COMPILES)
        return -2;                    /* 预算满：不标 bad（flush 后可再编） */
    n = jit_decode_block(rip, ins, &end);
    if (n <= 0)
        return -1;                    /* 真的译不了：标 bad */
    if (g_m.cpu.exc_pending)
        return -2;                    /* 取指缺页：交给解释器 */
    pa = mem_translate(rip, 0, 0, 0);
    if (pa >= (u64)RAM_SIZE)
        return -2;                    /* 只缓存 RAM 里的代码 */
    len = jit_build_module(ins, n, end);
    if (len == 0)
        return -1;
    h = js_jit_compile((u32)(unsigned long)jit_mod, len,
                       (u32)rip, (u32)(rip >> 32), (u32)n,
                       *pa_page, *gen, (u32)(ins[n - 1].branch || ins[n - 1].callret));
    if (h < 0)
        return -2;
    jit_compiles++;
    jit_mark_good(rip);
    *n_out = (u32)n;
    *pa_page = (u32)(pa >> 12);
    *gen = jit_page_gen[(u32)(pa >> 12)];
    return h;
}

/* 执行一个块，返回执行的客户机指令数；0 = 未处理，由解释器接手。
 * max_ins 用于 machine_run 的 stopt / 循环配额：块比它长就不跑。 */
int jit_try_common(u64 rip, u32 max_ins, int sample)
{
    u32 rip_off = (u32)offsetof(struct Machine, cpu.rip);
    u32 slot = 0;
    struct JitEnt *e = 0;
    u32 n = 0;
    u32 pa_page = 0;
    u32 gen = 0;
    int h = 0;

    if (!g_jit_on)
        return 0;
    if (rip < jit_lo || rip >= jit_hi)
        return 0;
    if (jit_compiles >= JIT_MAX_COMPILES) {
        if (sample) {
            jit_mark_bad(rip);
            return 0;
        }
    }
    slot = (u32)((rip >> 4) & (u64)(JIT_CACHE - 1));
    e = &jit_cache[slot];
    if (e->valid && e->rip == rip) {
        if (e->gen != jit_page_gen[e->pa_page])
            e->valid = 0;             /* SMC：页被写过，重翻译 */
        else {
            int rc = 0;
            if (e->n > max_ins)
                return 0;
            rc = js_jit_run((int)e->handle, (u32)(unsigned long)&g_m,
                            (u32)(unsigned long)g_m.ram, rip_off, max_ins);
            if (rc < 0) {
                e->valid = 0;
                return 0;
            }
            if (rc > 0) {
                jit_n_hit++;
                jit_n_insn += (u32)rc;
            }
            return rc;
        }
    }
    if (!sample) {
        u32 ss = (u32)((rip >> 4) & (u64)(JIT_SEEN - 1));
        struct SeenEnt *se = &jit_seen[ss];
        if (!se->valid || se->rip != rip) {
            se->rip = rip;
            se->cnt = 0;
            se->valid = 1;
        }
        if (se->cnt < JIT_HOT) {
            se->cnt++;
            return 0;                 /* 先让解释器跑几次，热了再编译 */
        }
    }
    h = jit_compile(rip, &n, &pa_page, &gen);
    if (h < 0) {
        if (h == -1)
            jit_mark_bad(rip);
        return 0;
    }
    e->rip = rip;
    e->n = n;
    e->handle = (u32)h;
    e->pa_page = pa_page;
    e->gen = gen;
    e->valid = 1;
    if (n > max_ins)
        return 0;                     /* 已缓存，等下一次预算够再跑 */
    {
        int rc = js_jit_run(h, (u32)(unsigned long)&g_m,
                            (u32)(unsigned long)g_m.ram, rip_off, max_ins);
        if (rc < 0) {
            e->valid = 0;
            return 0;
        }
        if (rc > 0) {
            jit_n_compile++;
            jit_n_insn += (u32)rc;
        }
        return rc;
    }
}

int jit_try2(u64 rip, u32 max_ins)
{
    return jit_try_common(rip, max_ins, 0);
}

int jit_try_sample(u64 rip, u32 max_ins)
{
    return jit_try_common(rip, max_ins, 1);
}

int jit_try(u64 rip)
{
    return jit_try_common(rip, 0xffffffffu, 0);
}

void jit_flush(void)
{
    u32 i = 0;
    for (i = 0; i < JIT_CACHE; i++)
        jit_cache[i].valid = 0;
    for (i = 0; i < (u32)sizeof(g_jit_good); i++)
        g_jit_good[i] = 0;
    jit_compiles = 0;      /* 失效后允许重新编译热块 */
    g_jit_flush_gen++;
}

void jit_set_trace(int v)
{
    g_jit_trace = v ? 1 : 0;
    g_jit_trace_n = 0;
}

void jit_set_on(int v)
{
    g_jit_on = v ? 1 : 0;
    if (!g_jit_on)
        jit_flush();
}

void jit_set_window(u64 lo, u64 hi)
{
    jit_lo = lo;
    jit_hi = hi;
    jit_flush();
}

/* 旧的块级测试入口：强制 CR0=0，直接在低地址上跑一个块。 */
int jit_block(u64 rip)
{
    struct JIns ins[JIT_MAX_INS];
    u64 end = 0;
    u64 pa = 0;
    int n = 0;
    u32 len = 0;
    u32 pg = 0;
    u32 gen = 0;
    u32 rip_off = (u32)offsetof(struct Machine, cpu.rip);
    int h = 0;

    n = jit_decode_block(rip, ins, &end);
    if (n <= 0)
        return -2;
    len = jit_build_module(ins, n, end);
    if (len == 0)
        return -3;
    pa = mem_translate(rip, 0, 0, 0);
    if (pa < (u64)RAM_SIZE) {
        pg = (u32)(pa >> 12);
        gen = jit_page_gen[pg];
    }
    h = js_jit_compile((u32)(unsigned long)jit_mod, len,
                       (u32)rip, (u32)(rip >> 32), (u32)n, pg, gen,
                       (u32)(ins[n - 1].branch || ins[n - 1].callret));
    if (h < 0)
        return -4;
    if (js_jit_run(h, (u32)(unsigned long)&g_m,
                   (u32)(unsigned long)g_m.ram, rip_off, 0xffffffffu) < 0)
        return -5;
    return n;
}

/* 合成块：不取指、不执行客户机代码，只生成 mov eax,imm 或 jmp end，
 * 用来单独测试 JS 侧对高地址 RIP 的链式分发。 */
static int jit_synth_one(u64 rip, u64 end, u32 imm, u32 is_jmp)
{
    struct JIns ins[1];
    u32 len = 0;
    u32 k = 0;
    for (k = 0; k < (u32)sizeof(ins); k++) ((u8 *)ins)[k] = 0;
    if (is_jmp) {
        ins[0].op = J_JMP;
        ins[0].branch = 1;
        ins[0].target = end;
    } else {
        ins[0].op = J_MOVI;
        ins[0].dst = 0;
        ins[0].sz = 4;
        ins[0].is_imm = 1;
        ins[0].imm = (u64)imm;
    }
    len = jit_build_module(ins, 1, end);
    if (len == 0)
        return -1;
    return js_jit_compile((u32)(unsigned long)jit_mod, len,
                          (u32)rip, (u32)(rip >> 32), 1, 0, 0, is_jmp);
}

int jit_synth_chain(u64 a, u64 b, u32 ia, u32 ib, u32 mode)
{
    u32 rip_off = (u32)offsetof(struct Machine, cpu.rip);
    int hb = jit_synth_one(b, b + 0x10, ib, 0);
    int ha = 0;
    if (hb < 0)
        return -2;
    ha = jit_synth_one(a, b, ia, mode ? 1 : 0);
    if (ha < 0)
        return -3;
    return js_jit_run(ha, (u32)(unsigned long)&g_m,
                      (u32)(unsigned long)g_m.ram, rip_off, 0xffffffffu);
}

u64 jit_flush_count(void)
{
    return g_jit_flush_gen;
}

u32 jit_gen_base(void)
{
    return (u32)(unsigned long)jit_page_gen;
}

int jit_poc(u64 rip)
{
    int n = jit_block(rip);
    return n > 0 ? 0 : n;
}
