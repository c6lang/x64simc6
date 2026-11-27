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

#define JIT_MOD_MAX 4096
#define JIT_MAX_INS 16
#define JIT_CACHE 2048
#define JIT_MAX_COMPILES 2048
#define JIT_SEEN 8192
#define JIT_HOT 64

static u8 jit_mod[JIT_MOD_MAX];

/* 由 JS 提供（build.sh 的 JIT=1 链接加 --allow-undefined） */
extern int js_jit_compile(u32 ptr, u32 len);
extern int js_jit_run(int handle, u32 state_off, u32 ram_off);

int g_jit_on = 1;
static u64 jit_lo = 0xffffffff80000000ull;
static u64 jit_hi = 0xffffffffc0000000ull;
static int jit_compiles = 0;
static u64 jit_n_compile = 0;
static u64 jit_n_hit = 0;


u64 jit_stat(int i)
{
    if (i == 0) return jit_n_compile;
    if (i == 1) return jit_n_hit;
    if (i == 3) return (u64)jit_compiles;
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
    J_NOP = 1, J_MOVI, J_MOVMI, J_MOVRR,
    J_ADD, J_SUB, J_AND, J_OR, J_XOR, J_CMP, J_TEST,
    J_INC, J_DEC,
    J_JMP, J_JCC
};

struct JIns {
    u8 op;
    u8 dst;
    u8 src;
    u8 sz;       /* 4 或 8 */
    u8 is_imm;
    u8 branch;   /* 1 = 块的最后一条是分支 */
    u8 cc;       /* jcc 条件码 */
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
        if ((mrm & 0xc0) != 0xc0 || ((mrm >> 3) & 7) != 0)
            return 0;
        in->op = J_MOVMI;
        in->dst = (u8)((mrm & 7) | ((rex & 1) ? 8 : 0));
        in->is_imm = 1;
        in->imm = (u64)jit_rd32(p + pos + 2);
        if (sz == 8)
            in->imm = (u64)(i64)(i32)(u32)in->imm;   /* imm32 符号扩展 */
        in->len = pos + 6;
        return 1;
    }
    if (op == 0x89 || op == 0x8b || op == 0x01 || op == 0x03 ||
        op == 0x29 || op == 0x2b || op == 0x21 || op == 0x23 ||
        op == 0x09 || op == 0x0b || op == 0x31 || op == 0x33 ||
        op == 0x39 || op == 0x3b || op == 0x85) {
        u32 reg, rm;
        mrm = (u8)jit_mr8(p + pos + 1);
        if ((mrm >> 6) != 3)
            return 0;
        reg = ((mrm >> 3) & 7) | ((rex & 4) ? 8 : 0);
        rm = (mrm & 7) | ((rex & 1) ? 8 : 0);
        if (op == 0x89) { in->op = J_MOVRR; in->dst = (u8)rm; in->src = (u8)reg; }
        else if (op == 0x8b) { in->op = J_MOVRR; in->dst = (u8)reg; in->src = (u8)rm; }
        else if (op == 0x85) { in->op = J_TEST; in->dst = (u8)rm; in->src = (u8)reg; }
        else {
            u32 base = op & 0xfd;     /* 清方向位 */
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
        mrm = (u8)jit_mr8(p + pos + 1);
        if ((mrm & 0xc0) != 0xc0)
            return 0;
        if (((mrm >> 3) & 7) == 0) in->op = J_INC;
        else if (((mrm >> 3) & 7) == 1) in->op = J_DEC;
        else return 0;
        in->dst = (u8)((mrm & 7) | ((rex & 1) ? 8 : 0));
        in->len = pos + 2;
        return 1;
    }
    if (op == 0x81 || op == 0x83) {
        u32 sub = 0;
        mrm = (u8)jit_mr8(p + pos + 1);
        if ((mrm >> 6) != 3)
            return 0;
        sub = (mrm >> 3) & 7;
        if (sub != 0 && sub != 5 && sub != 7)
            return 0;
        in->op = (sub == 0) ? J_ADD : (sub == 5) ? J_SUB : J_CMP;
        in->dst = (u8)((mrm & 7) | ((rex & 1) ? 8 : 0));
        in->is_imm = 1;
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
        if (t.branch)
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
    u8 t1[256], t2[512], t3[64], t4[64], t5[4096];
    u32 rax_off = (u32)offsetof(struct Machine, cpu.r[0]);
    u32 rip_off = (u32)offsetof(struct Machine, cpu.rip);
    u32 fl_off = (u32)offsetof(struct Machine, cpu.flags);
    struct WBuf out = { jit_mod, 0, JIT_MOD_MAX };
    struct WBuf b;
    int k = 0;
    int has_branch = 0;

    wb_u8(&out, 0x00); wb_u8(&out, 0x61); wb_u8(&out, 0x73); wb_u8(&out, 0x6d);
    wb_u8(&out, 0x01); wb_u8(&out, 0x00); wb_u8(&out, 0x00); wb_u8(&out, 0x00);

    /* type: 0=(i32,i32)->i32; 1=(i64,i64,i64,i32)->(); 2=(i64,i32)->();
     *       3=(i64,i64,i32)->(); 4=(i64,i64)->i32 */
    b.p = t1; b.n = 0; b.cap = sizeof(t1);
    wb_u8(&b, 0x05);
    wb_u8(&b, 0x60); wb_u8(&b, 0x02); wb_u8(&b, 0x7f); wb_u8(&b, 0x7f);
    wb_u8(&b, 0x01); wb_u8(&b, 0x7f);
    wb_u8(&b, 0x60); wb_u8(&b, 0x04); wb_u8(&b, 0x7e); wb_u8(&b, 0x7e);
    wb_u8(&b, 0x7e); wb_u8(&b, 0x7f); wb_u8(&b, 0x00);
    wb_u8(&b, 0x60); wb_u8(&b, 0x02); wb_u8(&b, 0x7e); wb_u8(&b, 0x7f); wb_u8(&b, 0x00);
    wb_u8(&b, 0x60); wb_u8(&b, 0x03); wb_u8(&b, 0x7e); wb_u8(&b, 0x7e);
    wb_u8(&b, 0x7f); wb_u8(&b, 0x00);
    wb_u8(&b, 0x60); wb_u8(&b, 0x02); wb_u8(&b, 0x7e); wb_u8(&b, 0x7e);
    wb_u8(&b, 0x01); wb_u8(&b, 0x7f);
    wb_section(&out, 0x01, &b);

    /* import: memory + 6 个 flags/cond 帮助函数。
     * 函数索引：add=0, sub=1, logic=2, inc=3, dec=4, cond=5。 */
    b.p = t2; b.n = 0; b.cap = sizeof(t2);
    wb_u8(&b, 0x07);
    wb_name(&b, "env"); wb_name(&b, "memory");
    wb_u8(&b, 0x02); wb_u8(&b, 0x01); wb_leb(&b, 0); wb_leb(&b, 65536);
    wb_name(&b, "env"); wb_name(&b, "jit_flags_add");   wb_u8(&b, 0x00); wb_leb(&b, 1);
    wb_name(&b, "env"); wb_name(&b, "jit_flags_sub");   wb_u8(&b, 0x00); wb_leb(&b, 1);
    wb_name(&b, "env"); wb_name(&b, "jit_flags_logic"); wb_u8(&b, 0x00); wb_leb(&b, 2);
    wb_name(&b, "env"); wb_name(&b, "jit_flags_inc");   wb_u8(&b, 0x00); wb_leb(&b, 3);
    wb_name(&b, "env"); wb_name(&b, "jit_flags_dec");   wb_u8(&b, 0x00); wb_leb(&b, 3);
    wb_name(&b, "env"); wb_name(&b, "jit_cond");        wb_u8(&b, 0x00); wb_leb(&b, 4);
    wb_section(&out, 0x02, &b);

    /* function: 一个函数，类型 0（索引 6） */
    b.p = t3; b.n = 0; b.cap = sizeof(t3);
    wb_u8(&b, 0x01); wb_leb(&b, 0);
    wb_section(&out, 0x03, &b);

    /* export: "run" -> func 6 */
    b.p = t4; b.n = 0; b.cap = sizeof(t4);
    wb_u8(&b, 0x01); wb_name(&b, "run");
    wb_u8(&b, 0x00); wb_leb(&b, 6);
    wb_section(&out, 0x07, &b);

    /* code：local 2/3/4 = i64（a、b、res） */
    b.p = t5; b.n = 0; b.cap = sizeof(t5);
    wb_u8(&b, 0x01); wb_u8(&b, 0x03); wb_u8(&b, 0x7e);

    for (k = 0; k < n; k++) {
        const struct JIns *x = &ins[k];
        u32 d = rax_off + (u32)x->dst * 8u;
        u32 s = rax_off + (u32)x->src * 8u;
        int logic = 0;

        if (x->branch) {
            has_branch = 1;
            continue;                 /* 分支单独处理 */
        }
        switch (x->op) {
        case J_NOP:
            break;
        case J_MOVI:
        case J_MOVMI:
            e_addr(&b, d); e_i64_const(&b, x->imm); e_store64(&b);
            break;
        case J_MOVRR:
            e_addr(&b, d);
            e_load64(&b, s);
            if (x->sz == 4) { e_wrap(&b); e_ext_u(&b); }
            e_store64(&b);
            break;
        case J_INC:
        case J_DEC:
            e_load64(&b, d); e_set(&b, 2);
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
            e_addr(&b, d); e_get(&b, 4); e_store64(&b);
            e_get(&b, 2); e_get(&b, 4); e_i32_const(&b, x->sz);
            e_call(&b, x->op == J_INC ? 3 : 4);
            break;
        case J_TEST:
            e_load64(&b, d); e_set(&b, 2);
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
        default:
            /* 二操作数 ALU */
            e_load64(&b, d); e_set(&b, 2);
            if (x->is_imm) {
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
                e_addr(&b, d); e_get(&b, 4); e_store64(&b);
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
    } else {
        e_addr(&b, rip_off); e_i64_const(&b, end_rip); e_store64(&b);
    }
    e_i32_const(&b, 0);
    wb_u8(&b, 0x0b);

    {
        struct WBuf c = { t5, 0, sizeof(t5) };
        u8 body[4096];
        u32 i = 0;
        for (i = 0; i < b.n && i < sizeof(body); i++) body[i] = b.p[i];
        wb_u8(&c, 0x01); wb_leb(&c, b.n); wb_bytes(&c, body, b.n);
        wb_section(&out, 0x0a, &c);
    }
    return out.n;
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
        return -1;
    n = jit_decode_block(rip, ins, &end);
    if (n <= 0)
        return -1;
    if (g_m.cpu.exc_pending)
        return -1;                    /* 取指缺页：交给解释器 */
    pa = mem_translate(rip, 0, 0, 0);
    if (pa >= (u64)RAM_SIZE)
        return -1;                    /* 只缓存 RAM 里的代码 */
    len = jit_build_module(ins, n, end);
    if (len == 0)
        return -1;
    h = js_jit_compile((u32)(unsigned long)jit_mod, len);
    if (h < 0)
        return -1;
    jit_compiles++;
    *n_out = (u32)n;
    *pa_page = (u32)(pa >> 12);
    *gen = jit_page_gen[(u32)(pa >> 12)];
    return h;
}

/* 执行一个块，返回执行的客户机指令数；0 = 未处理，由解释器接手。
 * max_ins 用于 machine_run 的 stopt / 循环配额：块比它长就不跑。 */
int jit_try2(u64 rip, u32 max_ins)
{
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
    slot = (u32)((rip >> 4) & (u64)(JIT_CACHE - 1));
    e = &jit_cache[slot];
    if (e->valid && e->rip == rip) {
        if (e->gen != jit_page_gen[e->pa_page])
            e->valid = 0;             /* SMC：页被写过，重翻译 */
        else {
            if (e->n > max_ins)
                return 0;
            if (js_jit_run((int)e->handle, (u32)(unsigned long)&g_m,
                           (u32)(unsigned long)g_m.ram) != 0) {
                e->valid = 0;
                return 0;
            }
            jit_n_hit++;
            return (int)e->n;
        }
    }
    {
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
    if (h < 0)
        return 0;
    e->rip = rip;
    e->n = n;
    e->handle = (u32)h;
    e->pa_page = pa_page;
    e->gen = gen;
    e->valid = 1;
    if (n > max_ins)
        return 0;                     /* 已缓存，等下一次预算够再跑 */
    if (js_jit_run(h, (u32)(unsigned long)&g_m,
                   (u32)(unsigned long)g_m.ram) != 0) {
        e->valid = 0;
        return 0;
    }
    jit_n_compile++;
    return (int)n;
}

int jit_try(u64 rip)
{
    return jit_try2(rip, 0xffffffffu);
}

void jit_flush(void)
{
    u32 i = 0;
    for (i = 0; i < JIT_CACHE; i++)
        jit_cache[i].valid = 0;
    jit_compiles = 0;      /* 失效后允许重新编译热块 */
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
    int n = 0;
    u32 len = 0;
    int h = 0;

    n = jit_decode_block(rip, ins, &end);
    if (n <= 0)
        return -2;
    len = jit_build_module(ins, n, end);
    if (len == 0)
        return -3;
    h = js_jit_compile((u32)(unsigned long)jit_mod, len);
    if (h < 0)
        return -4;
    if (js_jit_run(h, (u32)(unsigned long)&g_m,
                   (u32)(unsigned long)g_m.ram) != 0)
        return -5;
    return n;
}

int jit_poc(u64 rip)
{
    int n = jit_block(rip);
    return n > 0 ? 0 : n;
}
