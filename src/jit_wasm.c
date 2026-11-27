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
 * 当前是「直线块」POC：一次翻译 1..16 条不含内存操作数/分支的指令，
 * 覆盖 mov/ALU/inc/dec/nop。标志位不自己算，而是 call 回主模块的
 * jit_flags_* 包装（CPU 里唯一的 flags_* 实现），保证与解释器逐位一致；
 * 这样编码器只负责寄存器数据通路，先验证「翻译 + 共享状态 + 回退」，
 * 后续再把 flags 内联、加分支/内存操作数和块缓存。
 */
#include <stddef.h>
#include "c6sim.h"

#define JIT_MOD_MAX 8192
#define JIT_MAX_INS 16

static u8 jit_mod[JIT_MOD_MAX];

/* 由 JS 提供（build.sh 的 JIT=1 链接加 --allow-undefined） */
extern int js_jit_compile(u32 ptr, u32 len);
extern int js_jit_run(int handle, u32 state_off, u32 ram_off);

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

/* 有符号 LEB128：i32.const / i64.const 的立即数 */
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

/* ---- 客户机指令解码（直线块，无分支/内存操作数） ---- */
enum {
    J_NOP = 1, J_MOVI, J_MOVRR,
    J_ADD, J_SUB, J_AND, J_OR, J_XOR, J_CMP,
    J_INC, J_DEC
};

struct JIns {
    u8 op;
    u8 dst;
    u8 src;
    u8 is_imm;   /* 1 = 第二操作数是 imm32/imm8（add/sub/cmp r32, imm） */
    u32 imm;
};

static u64 jit_rd32(u64 a)
{
    u64 v = 0;
    u32 i = 0;
    for (i = 0; i < 4; i++)
        v |= ((u64)mem_r8(a + (u64)i)) << (i * 8);
    return v;
}

/* 成功返回 1 并写 len；不支持返回 0。调用方保证 p 起始处页内 >= 6 字节。 */
static int jit_decode_one(u64 p, struct JIns *in, u32 *len)
{
    u8 op = mem_r8(p);
    u8 m = 0;
    u8 sub = 0;
    u32 i = 0;

    if (op == 0x90) {
        in->op = J_NOP;
        *len = 1;
        return 1;
    }
    if (op >= 0xb8 && op <= 0xbf) {
        in->op = J_MOVI;
        in->dst = (u8)(op & 7);
        in->imm = (u32)jit_rd32(p + 1);
        *len = 5;
        return 1;
    }
    if (op == 0x89 || op == 0x8b || op == 0x01 || op == 0x03 ||
        op == 0x29 || op == 0x2b || op == 0x21 || op == 0x23 ||
        op == 0x09 || op == 0x0b || op == 0x31 || op == 0x33 ||
        op == 0x39 || op == 0x3b) {
        m = mem_r8(p + 1);
        if ((m >> 6) != 3)
            return 0;
        if (op == 0x89) { in->op = J_MOVRR; in->dst = (u8)(m & 7); in->src = (u8)((m >> 3) & 7); }
        else if (op == 0x8b) { in->op = J_MOVRR; in->dst = (u8)((m >> 3) & 7); in->src = (u8)(m & 7); }
        else {
            u8 reg = (u8)((m >> 3) & 7);
            u8 rm = (u8)(m & 7);
            int rmr = (op & 1) != 0;   /* 01/29/21/09/31/39 是 r/m <- r */
            switch (op & 0xfd) {       /* 清掉方向位：01/03 同组，29/2b 同组… */
            case 0x01: in->op = J_ADD; break;
            case 0x29: in->op = J_SUB; break;
            case 0x21: in->op = J_AND; break;
            case 0x09: in->op = J_OR; break;
            case 0x31: in->op = J_XOR; break;
            case 0x39: in->op = J_CMP; break;
            default: return 0;
            }
            in->dst = rmr ? rm : reg;
            in->src = rmr ? reg : rm;
        }
        *len = 2;
        return 1;
    }
    if (op == 0xff) {
        m = mem_r8(p + 1);
        if ((m & 0xf8) == 0xc0) { in->op = J_INC; in->dst = (u8)(m & 7); *len = 2; return 1; }
        if ((m & 0xf8) == 0xc8) { in->op = J_DEC; in->dst = (u8)(m & 7); *len = 2; return 1; }
        return 0;
    }
    if (op == 0x83 || op == 0x81) {
        m = mem_r8(p + 1);
        if ((m >> 6) != 3)
            return 0;
        sub = (u8)((m >> 3) & 7);
        if (sub != 0 && sub != 5 && sub != 7)
            return 0;
        in->dst = (u8)(m & 7);
        if (op == 0x83) {
            u32 b = (u32)mem_r8(p + 2);
            if (b & 0x80u) b |= 0xffffff00u;   /* imm8 符号扩展 */
            in->imm = b;
            *len = 3;
        } else {
            in->imm = (u32)jit_rd32(p + 2);
            *len = 6;
        }
        in->op = (sub == 0) ? J_ADD : (sub == 5) ? J_SUB : J_CMP;
        in->is_imm = 1;
        return 1;
    }
    (void)i;
    return 0;
}

/* 解码直线块，返回指令数（0 = 第一条就不支持），end 指向块尾 RIP */
static int jit_decode_block(u64 rip, struct JIns *ins, u64 *end)
{
    u64 p = rip;
    int n = 0;
    while (n < JIT_MAX_INS) {
        struct JIns t;
        u32 len = 0;
        /* 页尾不足 6 字节就收块：避免解码时读到下一页触发缺页 */
        if ((p & 0xfffull) > 0xffaull)
            break;
        for (u32 k = 0; k < (u32)sizeof(t); k++) ((u8 *)&t)[k] = 0;
        if (!jit_decode_one(p, &t, &len))
            break;
        if (((p & 0xfffull) + (u64)len) > 0x1000ull)
            break;
        ins[n] = t;
        n++;
        p += (u64)len;
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
static void e_wrap(struct WBuf *b) { wb_u8(b, 0xa7); }        /* i32.wrap_i64 */
static void e_ext_u(struct WBuf *b) { wb_u8(b, 0xad); }       /* i64.extend_i32_u */
static void e_addr(struct WBuf *b, u32 state_off)
{
    e_get(b, 0);
    e_i32_const(b, state_off);
    wb_u8(b, 0x6a);                                           /* i32.add */
}
static void e_load64(struct WBuf *b, u32 off)
{
    e_addr(b, off);
    wb_u8(b, 0x29); wb_leb(b, 3); wb_leb(b, 0);               /* i64.load align=8 */
}
static void e_store64(struct WBuf *b)
{
    wb_u8(b, 0x37); wb_leb(b, 3); wb_leb(b, 0);               /* i64.store align=8 */
}

/* 生成一个 (i32,i32)->i32 的模块，导出 run()：
 *   run(state, ram) 执行整块指令，写回 RIP，返回 0。
 * 导入：memory + 5 个 jit_flags_* 帮助函数（主模块导出）。 */
static u32 jit_build_module(const struct JIns *ins, int n, u64 end_rip)
{
    u8 t1[256], t2[512], t3[64], t4[64], t5[2048];
    u32 rax_off = (u32)offsetof(struct Machine, cpu.r[0]);
    u32 rip_off = (u32)offsetof(struct Machine, cpu.rip);
    struct WBuf out = { jit_mod, 0, JIT_MOD_MAX };
    struct WBuf b;
    int k = 0;

    wb_u8(&out, 0x00); wb_u8(&out, 0x61); wb_u8(&out, 0x73); wb_u8(&out, 0x6d);
    wb_u8(&out, 0x01); wb_u8(&out, 0x00); wb_u8(&out, 0x00); wb_u8(&out, 0x00);

    /* type: 0=(i32,i32)->i32, 1=(i64,i64,i64)->(), 2=(i64)->(), 3=(i64,i64)->() */
    b.p = t1; b.n = 0; b.cap = sizeof(t1);
    wb_u8(&b, 0x04);
    wb_u8(&b, 0x60); wb_u8(&b, 0x02); wb_u8(&b, 0x7f); wb_u8(&b, 0x7f);
    wb_u8(&b, 0x01); wb_u8(&b, 0x7f);
    wb_u8(&b, 0x60); wb_u8(&b, 0x03); wb_u8(&b, 0x7e); wb_u8(&b, 0x7e); wb_u8(&b, 0x7e); wb_u8(&b, 0x00);
    wb_u8(&b, 0x60); wb_u8(&b, 0x01); wb_u8(&b, 0x7e); wb_u8(&b, 0x00);
    wb_u8(&b, 0x60); wb_u8(&b, 0x02); wb_u8(&b, 0x7e); wb_u8(&b, 0x7e); wb_u8(&b, 0x00);
    wb_section(&out, 0x01, &b);

    /* import: memory + flags helpers。函数索引 0..4 即导入顺序。 */
    b.p = t2; b.n = 0; b.cap = sizeof(t2);
    wb_u8(&b, 0x06);
    wb_name(&b, "env"); wb_name(&b, "memory");
    wb_u8(&b, 0x02); wb_u8(&b, 0x01); wb_leb(&b, 0); wb_leb(&b, 65536);
    wb_name(&b, "env"); wb_name(&b, "jit_flags_add");   wb_u8(&b, 0x00); wb_leb(&b, 1);
    wb_name(&b, "env"); wb_name(&b, "jit_flags_sub");   wb_u8(&b, 0x00); wb_leb(&b, 1);
    wb_name(&b, "env"); wb_name(&b, "jit_flags_logic"); wb_u8(&b, 0x00); wb_leb(&b, 2);
    wb_name(&b, "env"); wb_name(&b, "jit_flags_inc");   wb_u8(&b, 0x00); wb_leb(&b, 3);
    wb_name(&b, "env"); wb_name(&b, "jit_flags_dec");   wb_u8(&b, 0x00); wb_leb(&b, 3);
    wb_section(&out, 0x02, &b);

    /* function: 一个函数，类型 0（索引 5） */
    b.p = t3; b.n = 0; b.cap = sizeof(t3);
    wb_u8(&b, 0x01); wb_leb(&b, 0);
    wb_section(&out, 0x03, &b);

    /* export: "run" -> func 5 */
    b.p = t4; b.n = 0; b.cap = sizeof(t4);
    wb_u8(&b, 0x01); wb_name(&b, "run");
    wb_u8(&b, 0x00); wb_leb(&b, 5);
    wb_section(&out, 0x07, &b);

    /* code */
    b.p = t5; b.n = 0; b.cap = sizeof(t5);
    /* locals: 2=i64(a), 3=i64(b), 4=i32(res) */
    wb_u8(&b, 0x02); wb_u8(&b, 0x02); wb_u8(&b, 0x7e); wb_u8(&b, 0x01); wb_u8(&b, 0x7f);

    for (k = 0; k < n; k++) {
        const struct JIns *x = &ins[k];
        u32 d = rax_off + (u32)x->dst * 8u;
        u32 s = rax_off + (u32)x->src * 8u;
        u32 w = 0x6a;
        u32 fl = 0;

        switch (x->op) {
        case J_NOP:
            break;
        case J_MOVI:
            e_addr(&b, d); e_i64_const(&b, (u64)x->imm); e_store64(&b);
            break;
        case J_MOVRR:
            e_addr(&b, d); e_load64(&b, s);
            e_wrap(&b); e_ext_u(&b);   /* 32 位写零扩展 */
            e_store64(&b);
            break;
        case J_INC:
            e_load64(&b, d); e_set(&b, 2);
            e_get(&b, 2); e_wrap(&b); e_i32_const(&b, 1); wb_u8(&b, 0x6a); e_set(&b, 4);
            e_addr(&b, d); e_get(&b, 4); e_ext_u(&b); e_store64(&b);
            e_get(&b, 2); e_get(&b, 4); e_ext_u(&b); e_call(&b, 3);
            break;
        case J_DEC:
            e_load64(&b, d); e_set(&b, 2);
            e_get(&b, 2); e_wrap(&b); e_i32_const(&b, 1); wb_u8(&b, 0x6b); e_set(&b, 4);
            e_addr(&b, d); e_get(&b, 4); e_ext_u(&b); e_store64(&b);
            e_get(&b, 2); e_get(&b, 4); e_ext_u(&b); e_call(&b, 4);
            break;
        default:
            /* 二操作数 ALU：a=local2, b=local3, res=local4 */
            if (x->op == J_ADD) { w = 0x6a; fl = 0; }
            else if (x->op == J_SUB || x->op == J_CMP) { w = 0x6b; fl = 1; }
            else if (x->op == J_AND) { w = 0x71; fl = 2; }
            else if (x->op == J_OR) { w = 0x72; fl = 2; }
            else if (x->op == J_XOR) { w = 0x73; fl = 2; }
            e_load64(&b, d); e_set(&b, 2);
            if (x->is_imm) {
                e_i64_const(&b, (u64)x->imm);
                e_set(&b, 3);
            } else {
                e_load64(&b, s);
                e_set(&b, 3);
            }
            e_get(&b, 2); e_wrap(&b);
            e_get(&b, 3); e_wrap(&b);
            wb_u8(&b, (u8)w);
            e_set(&b, 4);
            if (x->op != J_CMP) {
                e_addr(&b, d); e_get(&b, 4); e_ext_u(&b); e_store64(&b);
            }
            if (fl == 2) {
                e_get(&b, 4); e_ext_u(&b); e_call(&b, 2);
            } else if (fl == 1) {
                e_get(&b, 2); e_get(&b, 3); e_get(&b, 4); e_ext_u(&b); e_call(&b, 1);
            } else {
                e_get(&b, 2); e_get(&b, 3); e_get(&b, 4); e_ext_u(&b); e_call(&b, 0);
            }
            break;
        }
    }

    /* RIP = end_rip */
    e_addr(&b, rip_off); e_i64_const(&b, end_rip); e_store64(&b);
    e_i32_const(&b, 0);
    wb_u8(&b, 0x0b);

    {
        struct WBuf c = { t5, 0, sizeof(t5) };
        /* 把函数体挪到临时段：b 与 c 共用 t5，先复制 */
        u8 body[2048];
        u32 i = 0;
        for (i = 0; i < b.n && i < sizeof(body); i++) body[i] = b.p[i];
        wb_u8(&c, 0x01); wb_leb(&c, b.n); wb_bytes(&c, body, b.n);
        wb_section(&out, 0x0a, &c);
    }
    return out.n;
}

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
