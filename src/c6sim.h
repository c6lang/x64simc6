/* c6sim.h —— x64simc6 的公共声明（普通 C 语法，供 .c6 文件 include） */
#ifndef C6SIM_H
#define C6SIM_H

typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef unsigned long long u64;
typedef signed char i8;
typedef short i16;
typedef int i32;
typedef long long i64;

/* x87 寄存器用的实数类型。
 *   默认构建（c6c --emit-ctu → 宿主 cc）：long double 就是宿主的 80 位 x87，
 *   于是 fadd/fmul/fdiv/fsqrt 直接吃宿主的扩展精度，64 位尾数、80 位语义都对
 *   —— musl 的 strtod/printf 十进制转换依赖 64 位尾数，用 double 会算错末几位。
 *   c6c 自举路径和 tcc-c6 的 wasm 后端把 long double 当 double（实测 c6c 只
 *   生成 double 指令），那里退回 double。两条路径的差异只体现在 x87 的最后
 *   一两位有效数字上（见 DESIGN §89）。 */
#if defined(C6_PURE) || defined(C6_WASM)
typedef double fpu_real;
#else
typedef long double fpu_real;
#endif

/* wasm 走「c6c --emit-ctu → clang -O2」时，cpu/mem 里那几处 debug printf
 * 需要显式声明（native 路径有 <stdio.h>，tcc-c6 容忍隐式声明）。 */
#if defined(C6_WASM)
int printf(const char *fmt, ...);
#endif


/* 客户机物理内存布局 */
#define RAM_SIZE        0x08000000u   /* 128 MiB */
#define RAM_TOP         0x08000000u
#define BOOTPARAMS_PA   0x00009000u
#define CMDLINE_PA      0x00020000u
#define EARLY_STACK_PA  0x00030000u
#define KERNEL_PA       0x01000000u
#define INITRD_PA       0x06000000u
#define PDPT_PA         0x00004000u
#define PD_PA           0x00005000u
#define PML4_PA         0x00006000u
#define GDT_PA          0x00007000u
#define IDT_PA          0x00008000u
#define LAPIC_PA        0xfee00000u
#define VIRTIO_NET_PA  0xfeb00000u
#define C6BLK_PA       0xfeb01000u

/* RFLAGS */
#define RF_CF 0x1ull
#define RF_PF 0x4ull
#define RF_AF 0x10ull
#define RF_ZF 0x40ull
#define RF_SF 0x80ull
#define RF_TF 0x100ull
#define RF_IF 0x200ull
#define RF_DF 0x400ull
#define RF_OF 0x800ull
#define RF_IOPL ((u64)3 << 12)
#define RF_NT 0x4000ull
#define RF_RF 0x10000ull
#define RF_VM 0x20000ull
#define RF_AC 0x40000ull
#define RF_ID 0x200000ull

/* CR0 / CR4 / EFER */
#define CR0_PE 0x1ull
#define CR0_MP 0x2ull
#define CR0_EM 0x4ull
#define CR0_TS 0x8ull
#define CR0_WP 0x10000ull
#define CR0_PG 0x80000000ull
#define CR4_PAE 0x20ull
#define CR4_MCE 0x40ull
#define CR4_PSE 0x10ull
#define CR4_OSFXSR 0x200ull
#define CR4_OSXSAVE 0x40000ull
#define EFER_SCE 0x1ull
#define EFER_LME 0x100ull
#define EFER_LMA 0x400ull
#define EFER_NXE 0x800ull

/* 异常向量 */
#define EXC_DE 0
#define EXC_DB 1
#define EXC_NI 2
#define EXC_BP 3
#define EXC_OF 4
#define EXC_BR 5
#define EXC_UD 6
#define EXC_NM 7
#define EXC_DF 8
#define EXC_TS 10
#define EXC_GP 13
#define EXC_PF 14
#define EXC_MF 16
#define EXC_AC 17
#define EXC_MC 18
#define EXC_XM 19
#define EXC_VE 20

/* 固件头 */
#define FW_MAGIC0 'C'
#define FW_MAGIC1 '6'
#define FW_MAGIC2 'F'
#define FW_MAGIC3 'W'
#define FW_VERSION 1
#define FW_HDR_SIZE 64

struct Operand {
    u64 addr;
    u32 reg;
    u32 rm;
    u32 is_reg;
    u32 seg;
    u32 rip_rel;   /* RIP 相对寻址：地址还需加上尾部立即数字节数 */
};

struct CPUState {
    u8 exc_pending;
    u8 exc_async;
    u8 fault_abort;  /* 1=本指令因缺页中止：后续写入必须全部丢弃（SDM 零副作用） */   /* 1=外部中断（异步），0=指令产生的异常（故障） */
    u32 exc_vec;
    u64 exc_ec;
    u8 exc_has_ec;
    u8 halted;
    u8 rex_present;
    u32 halt_code;
    u64 r[16];
    u64 rip;
    u64 flags;
    u64 cr[16];
    u64 efer;
    u64 msr_star, msr_lstar, msr_cstar, msr_sfmask;
    u64 msr_fs_base, msr_gs_base, msr_kgs_base;
    u64 msr_pat, msr_mtrr_def, msr_apicbase;
    u64 gdtr_base, idtr_base;
    u16 gdtr_limit, idtr_limit;
    u16 sel[6];
    u16 tr_sel;
    u16 ldtr_sel;
    u64 seg_base[6];
    u64 xmm[16][2];
    u32 mxcsr;
    u8 fxdata[512];
    /* x87：ST(0..7) 用 fpu_real（默认路径是宿主 long double = 真 80 位，
     * 自举/wasm 路径回退 double），见 DESIGN §89 */
    fpu_real st[8];
    u16 fpcw;
    u16 fpsw;
    u8 ftop;
};

struct SerialState {
    u64 out_head, out_tail;
    u8 out[65536];
    u64 in_head, in_tail;
    u8 in[4096];
    u8 rbr, ier, iir, lcr, mcr, lsr, msr, dll, dlm, fcr;
};

struct PicState {
    u8 imr[2];
    u8 isr[2];
    u8 irr[2];
    u8 icw1, icw2[2], icw3[2], icw4[2], init_state[2], cascade;
    u8 read_isr;
};

struct PitState {
    u32 reload[3];
    u32 count[3];
    u8 access[3];
    u8 mode[3];
    u8 rw_phase[3];
    u64 last_tsc;
};

struct PciState {
    u32 addr;
    u8 config[256];
};

struct Machine {
    struct CPUState cpu;
    u64 instructions;
    u64 tsc;
    u64 pit_ticks;
    u64 last_pit_tsc;
    u8 halted;
    u32 exit_code;
    struct SerialState serial;
    struct PicState pic;
    struct PitState pit;
    struct PciState pci;
    u32 lapic_id, lapic_ldr, lapic_tpr, lapic_lvr, lapic_svr, lapic_icr, lapic_icr2, lapic_eoi;
    u8 cmdline[512];
    u32 cmdline_len;
    u8 *fw_kernel;
    u8 *fw_initrd;
    u32 fw_kernel_len, fw_initrd_len;
    /* 调试用：最近 64 条指令的 RIP 环形缓冲，在异常/坏指针时打印 */
    u64 rip_ring[4096];
    u32 rip_ring_i;
    u64 user_entries;
    u64 sample_marks;
    u64 cur_rip;
    int watch_fd;
    u32 emu_sup;
    u32 trace_win;
    u32 sys_trace;               /* 1 = 记录每次 syscall 到 watch_fd */
    u64 sysrec[8];
    u64 sys_count;
    u64 stopt;                   /* >0: 跑到这么多条指令就停（调试） */
    u64 snap_start;              /* 检查点快照：从第几条开始 */
    u64 snap_step;               /* 检查点快照：间隔（0 = 关闭） */
    u32 rip_trace_on;            /* 1 = 记录前 RIP_TRACE_N 条 RIP */
    u32 rip_trace_n;
    u32 rip_trace[20000];               /* syscall 记录缓冲：cr3,nr,rdi,rsi,rdx,r10,r8,r9 */               /* CPL3 首次进入后的逐步记录窗口 */                 /* 1 = 模拟器自身代访（分页遍历/门读取/压帧），按内核权限 */
    u64 mt_calls;
    u64 sample_on;
    u32 ppt_dumps;
    u8 rip_dump_en;
    u32 ppt_count;
    u8 ram[RAM_SIZE];
};

extern struct Machine g_m;
extern int g_no_fast;
extern int g_no_fetch;
extern int g_no_data;
extern int g_cc;
extern int g_ud_trace;
extern int g_rsp_check;
extern int g_ntrace;
u64 boot_probe(void);
int machine_boot_staged(u8 *base, u32 koff, u32 klen,
                        u32 ioff, u32 ilen, u32 coff, u32 clen);

/* machine.c6 */
void machine_init(void);
void machine_reset(void);
void machine_reset_noram(void);
int machine_load_firmware(u8 *fw, u32 len);
int machine_boot(void);
int machine_boot_payload(u8 *code, u32 len, u64 addr);
int machine_run(u64 count);
void machine_set_cmdline(const char *s);

#if defined(C6_JIT)
/* jit_wasm.c：wasm 后端 JIT 编码器（默认构建不链接，JIT=1 时启用） */
int jit_poc(u64 rip);
int jit_block(u64 rip);
int jit_try(u64 rip);
int jit_try2(u64 rip, u32 max_ins);
void jit_flush(void);
void jit_set_on(int v);
void jit_set_window(u64 lo, u64 hi);
extern int g_jit_on;

/* mem.c6：按物理页的写代数，JIT 用它做 SMC 失效 */
extern u32 jit_page_gen[32768];

/* cpu.c6：给 wasm JIT 生成代码复用的标志位/条件实现 */
void jit_flags_add(u64 a, u64 b, u64 res, int s);
void jit_flags_sub(u64 a, u64 b, u64 res, int s);
void jit_flags_logic(u64 r, int s);
void jit_flags_inc(u64 a, u64 res, int s);
void jit_flags_dec(u64 a, u64 res, int s);
int jit_cond(u64 flags, u64 cc);
u64 jit_stat(int i);
#endif

/* mem.c6 */
u8 mem_fetch8(u64 a);
u8 mem_r8(u64 a);
u16 mem_r16(u64 a);
u32 mem_r32(u64 a);
u64 mem_r64(u64 a);
void mem_w8(u64 a, u8 v);
void mem_w16(u64 a, u16 v);
void mem_w32(u64 a, u32 v);
void mem_w64(u64 a, u64 v);
void mem_copy_from(u64 dst, const u8 *src, u64 n);
u64 mem_translate(u64 va, u32 write, u32 user, u32 *pf_ec);
void mem_tlb_flush(void);

/* fpu.c6：位型 ↔ 宿主浮点、sqrt（cpu.c6 的 SSE 与 x87 共用） */
double x64_bits_to_d(u64 a);
u64 x64_d_to_bits(double x);
float x64_bits_to_f(u32 a);
u32 x64_f_to_bits(float x);
double x64_sqrt_d(double x);
double x64_rnd_ne(double v);
void fpu_op(struct CPUState *c, u8 esc, u8 modrm, struct Operand *o);
void raise_irq(struct CPUState *c, u32 vec);

/* cpu.c6 */
int cpu_step(struct CPUState *c);
int cpu_if_enabled(void);
int cpu_exc_pending(void);
u64 pic_state_pack(void);
u64 clock_state_pack(void);
u64 raise_state_pack(void);
u64 pit_phase_pack(void);
void raise_exception(struct CPUState *c, u32 vec, u8 has_ec, u64 ec);
extern u64 g_rip_ring[256];
extern u32 g_rip_i;
void cpu_deliver(struct CPUState *c);
void cpu_init(struct CPUState *c);
/* c6 方法：c->step() / c->deliver()（run 用静态函数，避免 wasm 弱别名 ABI 问题） */
int step(struct CPUState *self);
void deliver(struct CPUState *self);

/* dev.c6 */
extern u64 g_ser_out_bytes;
extern u64 g_irq4_raises;
extern u32 g_ser_rd[8];
extern u32 g_ser_wr[8];
extern u32 g_ser_last_ier;
extern u32 g_ser_last_mcr;
extern u32 g_ser_last_lsr;
u8 io_r8(u32 port);
u16 io_r16(u32 port);
u32 io_r32(u32 port);
void io_w8(u32 port, u8 v);
void io_w16(u32 port, u16 v);
void io_w32(u32 port, u32 v);
u64 mmio_r(u64 addr, u32 size);
void mmio_w(u64 addr, u32 size, u64 val);
void dev_init(void);
void dev_tick(void);
void pic_raise(struct Machine *m, u8 irq);

/* dev.c6：第二串口 COM2（0x2f8/IRQ3）用来跑 SLIP，native 才有 */
#if !defined(C6_WASM)
int serial2_space(void);
int serial2_feed(const u8 *buf, u32 n);
#endif

/* net.c6：用户态 SLIP 网关（native） */
#if !defined(C6_WASM)
void net_reset(void);
void net_tick(void);
void net_input_ip(const u8 *pkt, u32 len);
void slip_rx_byte(u32 v);
#endif

/* host.c6 / wasm.c6 */
int serial_take_output(u8 *dst, int cap);
void serial_feed(const u8 *src, int len);
void host_diag(const char *msg);
void diag_u64(const char *tag, u64 value);

/* wasm 宿主桥：共享内存邮箱 + IndexedDB 文件表 */
u8 *sim_host_bridge(void);
int sim_host_event(u32 code, u32 len);
int sim_hostfs_import(u8 *buf, u32 len);
int sim_hostfs_export(u8 *buf, u32 cap);
int sim_hostfs_put(u8 *name, u32 name_len, u8 *data, u32 len);
int sim_hostfs_get(u8 *name, u32 name_len, u8 *dst, u32 cap);

#endif
