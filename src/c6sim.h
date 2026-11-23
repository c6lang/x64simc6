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
#define RF_CF   ((u64)1 << 0)
#define RF_PF   ((u64)1 << 2)
#define RF_AF   ((u64)1 << 4)
#define RF_ZF   ((u64)1 << 6)
#define RF_SF   ((u64)1 << 7)
#define RF_TF   ((u64)1 << 8)
#define RF_IF   ((u64)1 << 9)
#define RF_DF   ((u64)1 << 10)
#define RF_OF   ((u64)1 << 11)
#define RF_IOPL ((u64)3 << 12)
#define RF_NT   ((u64)1 << 14)
#define RF_RF   ((u64)1 << 16)
#define RF_VM   ((u64)1 << 17)
#define RF_AC   ((u64)1 << 18)
#define RF_ID   ((u64)1 << 21)

/* CR0 / CR4 / EFER */
#define CR0_PE ((u64)1 << 0)
#define CR0_MP ((u64)1 << 1)
#define CR0_EM ((u64)1 << 2)
#define CR0_TS ((u64)1 << 3)
#define CR0_WP ((u64)1 << 16)
#define CR0_PG ((u64)1 << 31)
#define CR4_PAE ((u64)1 << 5)
#define CR4_MCE ((u64)1 << 6)
#define CR4_PSE ((u64)1 << 4)
#define CR4_OSFXSR ((u64)1 << 9)
#define CR4_OSXSAVE ((u64)1 << 18)
#define EFER_SCE ((u64)1 << 0)
#define EFER_LME ((u64)1 << 8)
#define EFER_LMA ((u64)1 << 10)
#define EFER_NXE ((u64)1 << 11)

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
};

struct CPUState {
    u8 exc_pending;
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
    u64 seg_base[6];
    u64 xmm[16][2];
    u32 mxcsr;
    u8 fxdata[512];
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
    u8 icw1, icw2, icw3, icw4, init_state[2], cascade;
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
    u32 lapic_id, lapic_ldr, lapic_tpr, lapic_lvr, lapic_svr, lapic_icr, lapic_eoi;
    u8 cmdline[512];
    u32 cmdline_len;
    u8 *fw_kernel;
    u8 *fw_initrd;
    u32 fw_kernel_len, fw_initrd_len;
    u8 ram[RAM_SIZE];
};

extern struct Machine g_m;

/* machine.c6 */
void machine_init(void);
void machine_reset(void);
int machine_load_firmware(u8 *fw, u32 len);
int machine_boot(void);
int machine_boot_payload(u8 *code, u32 len, u64 addr);
int machine_run(u64 count);
void machine_set_cmdline(const char *s);

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

/* cpu.c6 */
int cpu_step(struct CPUState *c);
void raise_exception(struct CPUState *c, u32 vec, u8 has_ec, u64 ec);
void cpu_deliver(struct CPUState *c);
void cpu_init(struct CPUState *c);
/* c6 方法：c->step() / c->deliver()（run 用静态函数，避免 wasm 弱别名 ABI 问题） */
int step(struct CPUState *self);
void deliver(struct CPUState *self);

/* dev.c6 */
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
