# x64simc6 —— 用 c6 写的 x86-64 全系统模拟器（wasm / 浏览器 / Alpine）

> 版本：v0.1（详细设计，先于实现）
> 工作区：`/media/winger/_dde_data/c6wk/x64simc6`
> 语言：c6（`.c6`，编译器 `~/c6/c6c/build/c6c`；wasm 路径用 `~/c6/tcc/c6 --target=wasm32-unknown-unknown`）

---

## 1. 目标与非目标

### 1.1 目标

1. 用 c6 语言（带其扩展：切片、defer/errdefer、错误返回、结构体方法、枚举命名空间、test 块等）从零实现一个 **x86-64 全系统模拟器**。
2. 同一个核心源码能编成：
   - 本地可执行程序（Linux 宿主，用于调试和跑回归）；
   - WebAssembly 模块（`wasm32`），在浏览器里跑。
3. 以 **Alpine Linux 镜像作为"固件"**：把 Alpine 的 vmlinuz + initramfs（或 minirootfs 打成的 cpio.gz）打包成一个固件 blob，模拟器按 Linux x86-64 启动协议直接加载内核与 initrd，串口输出接到浏览器终端，键盘输入送回模拟器，最终进入 Alpine 的 shell。
4. 提供一个可复现的构建/测试流程：一条命令出 native 模拟器，一条命令出 wasm + web 页面，一条命令做固件打包。

### 1.2 非目标（v1 明确不做）

- 完整 BIOS / UEFI / SeaBIOS / GRUB；采用 Linux **直接启动协议**（direct kernel boot）。
- SMP（v1 单核）、VGA/framebuffer、图形终端（v1 只有 16550 串口）。
- VirtIO / virtio-blk / 网卡：initramfs 自带完整根文件系统，不需要块设备和网络。
- 二进制翻译（DBT/JIT）；v1 是解释器。性能不足时把 "热点 opcode 分派" 留在架构里，后续再换 DBT。
- 完整 x86 兼容性（实模式保护模式全套、16 位任务、x87、AVX、SMM）。
- 精确周期级时序；用 "每条指令递增虚拟 TSC / PIT 计数" 的近似模型。

---

## 2. 总体架构

```
                      ┌──────────────────────────────────────────────┐
  Alpine ISO/rootfs   │  tools/mkfw.py                               │
  (vmlinuz+initramfs) │  → firmware.bin (C6FW 头 + kernel + initrd)  │
                      └───────────────┬──────────────────────────────┘
                                      │ 文件 / fetch()
┌───────────────────┐                 ▼
│  浏览器 web/       │   ┌──────────────────────────────────────────┐
│  index.html       │   │  c6 模拟器核心（共享源码 src/*.c6）       │
│  app.js 终端 UI   │◄──►│  machine / cpu / mem / dev / boot        │
│  sim.wasm         │   │  ┌─────────── wasm 边界 ──────────────┐  │
└───────────────────┘   │  │ sim_init / sim_run / sim_serial_*   │  │
                        │  └─────────────────────────────────────┘  │
                        └───────────────┬──────────────────────────┘
                                        │ 同一份 src/*.c6
                                        ▼
                              ┌──────────────────────────────┐
                              │  native main.c6（CLI）       │
                              │  ./build/sim firmware.bin    │
                              └──────────────────────────────┘
```

核心原则：**宿主无关**。模拟器核心不调用 libc 的文件/终端 API；native 侧由 `main.c6` 负责读文件并把字节交给核心，wasm 侧由 JS 负责 fetch 并写进 wasm 线性内存。所有宿主交互收敛到 `src/host.c6` 的一组弱符号/函数指针，避免 wasm 链接期出现未定义符号。

---

## 3. 源码布局

```
x64simc6/
├── docs/
│   ├── DESIGN.md              # 本文
│   └── ALPINE.md              # 固件制作细节（实现后补）
├── src/
│   ├── c6sim.h                # 公共类型、常量、extern 声明（.h 用普通 C 语法）
│   ├── types.c6               # 固定宽度类型、位操作、日志宏
│   ├── mem.c6                 # 客户机物理内存、MMIO 分派、页表遍历
│   ├── cpu.c6                 # CPUState、取指/译码/执行、标志位、异常
│   ├── dev.c6                 # 16550A、8259A、8254、CMOS、PCI 配置空间、debug 端口
│   ├── boot.c6                # Linux boot protocol：boot_params、e820、页表、装入
│   ├── machine.c6             # Machine：组装 RAM/CPU/设备，run loop，统计
│   ├── host.c6                # 宿主抽象：控制台环形缓冲、固件内存视图
│   ├── main.c6                # native CLI
│   └── wasm.c6                # wasm 导出入口（导出全部函数由 wasm-ld 完成）
├── tools/
│   ├── mkfw.py                # 从 Alpine ISO / minirootfs 生成 firmware.bin
│   └── hello64.py             # 生成手汇编的 64 位测试 payload（无内核冒烟）
├── web/
│   ├── index.html, app.js, style.css
│   └── sim.wasm               # 构建产物
├── tests/
│   ├── test_cpu.c6            # c6 test 块：ALU/译码/分页
│   └── smoke.sh               # native + node wasm 冒烟
├── build.sh                   # 构建入口（native / wasm / clean / test）
├── TODO.md
└── README.md
```

---

## 4. 固件格式（C6FW）

固件是一个扁平二进制，头部小端：

| 偏移 | 类型 | 字段 | 含义 |
|---:|---|---|---|
| 0 | u8[4] | magic | `"C6FW"` |
| 4 | u32 | version | 1 |
| 8 | u32 | hdr_size | 头部总字节数（64） |
| 12 | u32 | flags | bit0: initrd 是 gzip |
| 16 | u32 | kernel_off | bzImage 起点 |
| 20 | u32 | kernel_len | bzImage 长度 |
| 24 | u32 | initrd_off | initrd（cpio.gz）起点 |
| 28 | u32 | initrd_len | 长度 |
| 32 | u32 | cmdline_off | 内核命令行起点 |
| 36 | u32 | cmdline_len | 长度（不含 NUL） |
| 40..63 | u8[24] | reserved | 0 |

`tools/mkfw.py` 从以下来源生成：

1. **Alpine ISO**（`alpine-standard-*.iso`）：用 `7z x -so` 取 ISO 内 `boot/vmlinuz-lts`、`boot/initramfs-lts`（或 `initramfs-vanilla`）；
2. **Alpine minirootfs tarball**：下载 `alpine-minirootfs-<ver>-x86_64.tar.gz`，写一个 `/init`（挂载 proc/sys/dev、设 ttyS0 控制台、exec /bin/sh），用 cpio 打成 newc 格式再 gzip；
3. 命令行默认：`console=ttyS0,115200 earlycon=uart8250,io,0x3f8,115200 panic=-1 reboot=k acpi=off noapic nolapic pci=off`

> "Alpine 镜像当固件" 的含义即：浏览器加载的 `firmware.bin` 里带着 Alpine 的 kernel + rootfs；模拟器把它当作要引导的 firmware payload 直接装入内存执行。

---

## 5. 客户机内存布局

常量集中在 `c6sim.h`：

```
0x00000000 - 0x0009fbff  常规 RAM（640KiB）
0x0009fc00 - 0x0009ffff  EBDA（保留）
0x000a0000 - 0x000fffff  VGA/BIOS 区（MMIO 保留，不装真实 BIOS）
0x00001000 - 0x00001fff  IDT（早期，Linux 会覆盖）
0x00002000 - 0x00008fff  GDT / 页表 / 临时栈
0x00009000 - 0x00009fff  boot_params（含 setup_header）
0x00020000 - 0x00020fff  内核命令行
0x00030000 - 0x0003ffff  早期栈
0x00100000 - ...         bzImage 解包后的内核（1MiB）
0x02000000 - ...         initrd（32MiB）
0x08000000               RAM 顶端（128MiB，可配置）
0xfee00000               LAPIC MMIO（4KiB）
0xfec00000               IOAPIC MMIO（占位/简化）
0x000cfc00...            PCI 配置空间通过 I/O 端口 0xcf8/0xcfc 访问
```

e820 表按上述布局生成：RAM、保留区、RAM（1MiB 起）、initrd 保留区。内核/initrd 占用的区域标为 E820_RESERVED，避免 kernel 把自己覆盖掉。

---

## 6. CPU 模型

### 6.1 状态

`CPUState` 包含：

- GPR：16 个 `uint64_t`（RAX..R15），RIP，RFLAGS（位级结构 + 整数字）；
- 段：`CS/DS/ES/FS/GS/SS` 的 selector + 缓存的 base/limit/access（v1 只需 base=0、长模式忽略 limit）；
- 控制寄存器：CR0（PE/PG）、CR2（缺页地址）、CR3（PML4 物理地址）、CR4（PAE/OSFXSR）、EFER（LME/LMA/SCE）；
- 系统表：GDTR/IDTR（base+limit）、TR/LDTR 缓存；
- FPU/SSE：v1 只保留 XMM0..15 的 128 位存储 + MXCSR，FXSAVE/FXRSTOR 做原样存取；
- APIC base MSR、TSC、MSR 小表（EFER/STAR/LSTAR/CSTAR/PAT/MTRR/TSC）；
- 显卡不需要；`halted`、`pending_irq`、`exception` 状态。

### 6.2 指令执行

统一流水线：

```
fetch_byte() → 解析 prefix（REX / 66 / 67 / F2 / F3 / LOCK / 段覆盖）
             → 解析 opcode（支持 0F、0F38 两字节）
             → ModRM/SIB/disp/immediate 解码
             → 分派到 opcode handler
             → 写回寄存器/内存，更新 RFLAGS
```

设计要点：

- **固定在wasmland/native 都安全的整数语义**：所有 64/32/16/8 位运算用 `uint64_t/uint32_t/uint16_t/uint8_t` 显式完成，不依赖宿主 `long` 宽度（c6 IR 是 LP64，wasm32 需要适配）。
- `RFLAGS` 用位宏：`CF=1, PF=4, AF=16, ZF=64, SF=128, TF=256, IF=512, DF=1024, OF=2048`；`pushf/popf/iret` 按 32 位 EFLAGS 语义处理（保留位 1 恒置）。
- **ModRM/SIB** 支持 64 位寻址（含 REX.B/REX.X、RIP 相对、`[disp32]` 绝对）、32 位寻址（含 SIB）、16 位寻址（ boot 早期可能用到）。
- **opcode 分组**（按 Linux 启动期实际需要逐步补齐）：

  | 组 | 指令 |
  |---|---|
  | 数据传送 | `mov`(89/8b/88/8a/c6/c7/a0..a3), `lea`(8d), `movzx/movsx`(0fb6..0fbf), `xchg`(86/87/90+n), `push/pop`(50..5f,ff/6,8f), `pusha/popa`, `pushf/popf`, `setcc`(0f90..0f9f), `cmovcc`(0f40..0f4f) |
  | 算术 | `add/adc/sub/sbb/cmp/test`(00..3d,84/85), `inc/dec`(fe/ff), `neg/not`(f6/f7), `mul/div/imul/idiv`(f6/f7,6b/69), `xadd`, `cmpxchg`(0fb0/0fb1) |
  | 逻辑/移位 | `and/or/xor`(20..3d), `shl/shr/sar/rol/ror/rcl/rcr`(c0/c1,d0..d3), `shld/shrd`(0fac/0fad), `bt/bts/btr/btc`(0fa3/ab/b3/bb), `bsf/bsr`(0fbc/0fbd), `bswap`(0fc8..0fcf) |
  | 控制流 | `jmp`(eb/e9/ff/ea), `jcc`(70..7f,0f80..0f8f), `loop/loope/loopne`(e0..e2), `call`(e8/ff/9a), `ret/retf/iret`(c2/c3/cb/ca/cf), `jecrz`(e3) |
  | 字符串 | `movs/lods/stos/scas/cmps`(a4..a7,aa..af) + `rep/repne` |
  | 系统 | `cpuid`(0fa2), `rdtsc`(0f31), `rdmsr/wrmsr`(0f32/0f30), `rdpmc`, `lgdt/lidt/lgdt/sgdt/sidt`(0f01), `lmsw/smsw`(0f01/0f20-30), `mov cr/dr`(0f20..0f24), `invlpg`(0f01/7), `swapgs`(0f01/f8), `syscall`(0f05), `sysret`(0f07), `hlt`(f4), `ud2`(0f0b), `pause`(f3 90), `clflush/wbinvd`, `xgetbv`(0f01,d0) |
  | FPU/SSE | `fxsave/fxrstor`(0fae/0,0fae/1), `xsave/xrstor`(0fae/4,5，简化), `movaps/movups/movdqa/movq/movd/movss/movsd` 常用 SSE 传送、`pxor/xorps/por/pand`, `ldmxcsr/stmxcsr` |
  | I/O | `in/out`(e4/e5/e6/e7/ec/ed/ee/ef,6d/6e/6f) |

  未知 opcode 处理：打印 RIP + opcode（前 16 字节）并注入 #UD；#UD 无处理时 triple fault → 模拟器停机并输出诊断。诊断信息包含第一个未实现指令，方便按需补 opcode。

### 6.3 分页

- 支持 4 级分页（PML4→PDPT→PD→PT），4KiB 和 2MiB 页，1GiB 页可选；
- 检查 P 位、RW、US、NX（EFER.NXE）、PS、地址对齐；
- 缺页：写 CR2，向 IDT 投递向量 14（带错误码），由 guest IDT 处理；
- 不实现 PCID/INVPCID/PKS；TLB 可省略（每次翻译走页表，慢但简单、正确）。

### 6.4 中断/异常投递

`raise_exception(vec, has_ec, ec)`：读 guest IDT 描述符（64 位 interrupt/trap gate），从 IDT 取目标 CS/RIP，向 guest 栈压 `SS, RSP, RFLAGS, CS, RIP[, error_code]`，清 TF/IF（interrupt gate），更新 RIP。不可恢复（如 IDT 未初始化）时停机并打印诊断。
中断注入（PIC/PIT/串口）复用同一路径，向量由 8259A 提供。

---

## 7. 设备模型（MMIO / I/O 端口）

所有设备访问走统一入口 `io_read8/16/32(port)` 与 `io_write8/16/32(port, val)`，MMIO 走 `mmio_read/write(addr, size)`；MMIO 区域注册在 `Machine.mmio[]`（少量固定槽位，线性扫描，v1 够用）。

| 设备 | 端口/地址 | 作用 |
|---|---|---|
| 16550A COM1 | 0x3f8..0x3ff | 串口：THR/RBR、IER、IIR、LCR(8N1/DLAB)、MCR、LSR(THRE|DR)、MSR、DLL/DLM；输出写环形缓冲供宿主读取，输入从宿主环形缓冲取并置 DR + IRQ4 |
| 8259A PIC | 0x20/0x21, 0xa0/0xa1 | ICW1..4、OCW1(IMR)、OCW2(EOI)；IRR/ISR/优先级；级联 IRQ2 |
| 8254 PIT | 0x40..0x43 | channel0 模式3，计数频率 1193182Hz；每次 `sim_run(n)` 按指令数推进，溢出时置 IRQ0 |
| CMOS/RTC | 0x70/0x71 | 返回固定日期时间；内核读 `/proc`、随机种子时用 |
| PCI 配置 | 0xcf8/0xcfc | conf1 机制：只有 host bridge（vendor 0x8086, dev 0x1237, class 0x0600）；其余设备返回 0xffffffff |
| LAPIC | 0xfee00000 | 最小 xAPIC：ID、版本、TPR、EOI、LVR、SVR、ICR；`nolapic` 下不参与，但读不崩 |
| debug 端口 | 0xf4 / 0xfe | 写 0xf4 以 AL 为退出码停机（类似 QEMU isa-debug-exit）；方便测试 payload |

**时序近似**：`Machine.virtual_tsc` 每执行一条指令 +1（或 + 常量），PIT 按 TSC 差值产生 IRQ；不做真实时间对齐，浏览器里一帧跑固定条数指令。

---

## 8. Linux 直接引导流程

`boot_linux()`：

1. 校验固件 C6FW 头；把 bzImage 解包后的 kernel 放到 1MiB（`kernel_off` 指向的是已经解包的 raw 内核镜像；若指向 bzImage，则按 setup_header 里的 `setup_sects` 跳过 setup 段把 payload 直接搬到 1MiB）；
2. initrd 搬到 0x02000000；
3. cmdline 搬到 0x00020000，NUL 结尾；
4. 填 `boot_params`：清零 4096 字节，拷贝 `setup_header`（从 bzImage 偏移 0x1f1，长度 0x7f），设置
   - `type_of_loader = 0xff`（unknown bootloader），
   - `loadflags |= 0x01 (LOADED_HIGH) | 0x80 (CAN_USE_HEAP)`，`heap_end_ptr = 0xdf00`，
   - `cmdline_ptr = 0x00020000`，
   - `initrd_addr = 0x02000000`，`initrd_size = initrd_len`，
   - `e820_entries` + 至少 4 项 e820（常规 RAM / 保留 / 扩展 RAM / initrd 保留）；
5. 建页表：PML4[0] → PDPT；PDPT[0..63] → PD；PD 用 2MiB 大页覆盖 0..128MiB（P|RW|US|PS）；
6. 初始化 CPU：EFLAGS=0x00000002，CR0=PE|PG（进长模式后），CR4=PAE|OSFXSR，EFER=LME|LMA，
   GDT 三项（null / 64-bit code / 64-bit data），IDT 256 项指向早期默认 handler（或全 0，Linux 会重装），
   RSI=boot_params 地址 0x9000，RIP=0x100000，RBP=0，其他 GPR=0；
7. 进入 run loop；串口收到 Alpine 输出即证明引导成功。

**为什么这样能跑**：x86-64 Linux 的 `startup_64` 只依赖 (a) 长模式已开启、(b) 1MiB 处的内核、(c) RSI 指向 boot_params、(d) 身份映射页表；它随后会重建自己的 GDT/IDT/页表，因此早期表只需够它跑到那一步。

---

## 9. c6 语言特性的具体落点（要求：充分使用，不是只换后缀）

核心必须在 **c6c（native）与 tcc-c6（wasm32）两条路径都能编译**，因此选用双方都支持的扩展子集。已用探针验证：`interface`/方法/切片/`foreach`/元组/`defer`/`err` + `catch`/`f"..."` 在两条路径都可用（注意 wasm32 下 `unsigned long` 是 32 位，64 位必须写 `unsigned long long`）。

| c6 特性 | 在本项目中的落点 |
|---|---|
| `interface` + 结构体方法 | `interface BusDevice { int read(u64 addr, u32 size); void write(...); }`；串口/PIC/PIT/PCI/LAPIC 各自作为实现者放进 `BusDevice[:]` 数组，`foreach` 遍历分派 MMIO/I/O；`CPU.step()`、`Machine.run()`、`Serial.put()` 等也写成方法 |
| `T[:]` 切片 + `foreach` | 固件字节视图 `u8[:]`、串口环形缓冲视图、e820 表项数组、设备数组、指令字节切片，全部用切片和 `foreach (…)` 遍历；切片下标自带边界检查 |
| 元组 `(T1,T2)` | `mmu.translate()` 返回 `(u64 pa, u32 fault)`；`decode_modrm()` 返回 `(int disp, int regs)`；`(pa, ec) = ...` 解构赋值；页表项解析也用元组 |
| `defer` / `errdefer` | native 固件加载：`FILE *f = fopen(...)` 后立刻 `defer fclose(f)`；分配临时缓冲后 `defer free(...)`；`errdefer` 回滚部分装入的机器状态 |
| `int!error` + `err` + `try` / `catch` | `Firmware.load()`、`Machine.boot()` 等返回 `int!error`；头校验失败 `return err(E_BAD_MAGIC, f"bad magic ...")`；上层用 `try`/`catch e { host_diag(e.msg); }` |
| `f"..."` | 所有诊断信息：`host_diag(f"UD at rip={rip;016x} op={op;02x}")`——零分配，wasm 控制台缓冲也能用 |
| `test "..." { }` | `tests/test_cpu.c6` 中测 ALU 标志、ModRM 解码、分页/权限、e820、固件头解析；`build.sh test` 用 `c6c -test` 跑 |
| 枚举命名空间 `E.FIELD` | 错误码、异常号、设备状态用 `enum Err { Err.BAD_MAGIC = 1, ... }`，避免裸名冲突 |
| tag 类型名、结构体方法、切片作为结构体成员 | `Machine` 内 `u8[:]` 视图成员，方法调用统一 `m.run()` 风格 |
| `module` / `import` | 在确认 wasm 路径可用后，把工具模块（如 `x64/fw.c6`）做成 `module x64.fw`，由 `main.c6` `import x64.fw`；其余核心先用头文件共享声明 |
| `@T` / `new` / `defer drop` | native 侧的固件对象用 `@Firmware` 托管引用（无环），演示 GC 与 `defer drop` 的清理 |
| 泛型 `Vect@T`、闭包、`spawn`/`co` | 不作为 v1 关键路径；若 wasm 探针通过，再用于固件字节向量或设备迭代器 |

- `.c6` 文件里所有变量定义带初始化器（`static` 除外）；64 位一律用 `unsigned long long`（wasm32 下 `unsigned long` 只有 32 位）。
- **内核页表/硬件结构必须用显式字节偏移读写**，不能把宿主结构体指针当 guest 地址（wasm32 与客户机 LP64 不一致）。
- 所有全局状态聚合到 `Machine`/`CPUState`，避免隐式全局和 TLS；诊断统一走 `host_diag()`。
- 若某个 c6 扩展在 wasm 探针里不可用，退化为普通 C 写法并在本文"实现偏差"中记录原因。

---

## 10. wasm 边界与浏览器交互

wasm-ld 参数（由 `tcc/c6 --target=...` 使用，可通过 `TCC_CCFLAGS` 追加）：

```
--no-entry --export-all -nostdlib
-Wl,--initial-memory=268435456 -Wl,--max-memory=536870912
```

导出 API（C 签名，wasm 名字同名）：

```c
int   sim_init(uint8_t *fw, int len);      /* fw 指向 wasm 线性内存里的固件，解析并装入 */
int   sim_reset(void);                    /* 重置机器 */
int   sim_run(int instructions);          /* 执行 N 条指令；返回实际执行数或 <0 表示停机 */
int   sim_status(void);                   /* 0 运行 / 1 停机 / 2 需要输入 */
int   sim_serial_out(uint8_t *dst, int cap);  /* 取出串口输出字节，返回实际长度 */
int   sim_serial_in(uint8_t *src, int len);   /* 把键盘字节放进输入环形缓冲 */
void  sim_cmdline(const char *s);         /* 覆盖默认 cmdline（可选） */
uint64_t sim_stat_insns(void);            /* 统计 */
uint8_t *sim_ram_base(void);              /* 调试用：RAM 基址 */
```

JS 侧（`web/app.js`）：

1. `fetch('firmware.bin')` → `ArrayBuffer` → `new Uint8Array(sim.memory.buffer, ptr, len)` 拷贝；
2. `sim_init(ptr, len)`；
3. `requestAnimationFrame` 循环：每帧 `sim_run(200000)`（可按性能调节），读 `sim_serial_out` 追加到终端；
4. 键盘事件 → `sim_serial_in`；退格/回车按 16550 语义发送 `0x7f`/`0x0d`；
5. 展示指令数 / MIPS / 运行状态；提供暂停、继续、重启按钮。

wasm 侧没有真正的文件和 stdout：`printf` 走 c6 运行库的 64KiB 控制台缓冲（见 llvm-backend.md），调试时由 JS 读出；正式串口输出走上面的环形缓冲，不受影响。

**内存预算**：v1 客户机 RAM 128MiB（静态 `uint8_t g_ram[128<<20]`），加上模拟器状态，wasm 初始内存 256MiB、上限 512MiB。若浏览器分配失败，降级到 64MiB RAM 并在固件生成时同步调整 initrd 位置。

---

## 10.1 wasm 的真实网络与页面存储（新增硬性需求）

浏览器里的 wasm 模块**不能**直接用 POSIX socket/open，因此需要在宿主（JS）与模拟器核心之间搭一座桥。目标是两条能力都"真实可用"，不是 mock：

### 网络

1. **固件/文件下载**：`web/app.js` 用 `fetch()` 从任意 URL 拉取 `firmware.bin`、内核、initrd，支持进度条、断点续传（`Range`）和失败重试；
2. **持久化缓存**：下载结果写进 Cache Storage / IndexedDB，离线时可重用；界面提供"重新下载/清除缓存"；
3. **共享内存邮箱**：wasm 导出 `u8 *sim_host_bridge(void)` 指向 64 KiB 共享区，JS 把网络响应写进共享区并调用 `sim_host_event(code, len)` 通知核心；核心侧用 `u8[:]` 切片解析响应。这样**不需要 wasm import**，与 `--no-entry --export-all` 的 c6 wasm 链接方式完全兼容；
4. **访客网络（v2）**：在上述桥上实现一个简化的 virtio-net 设备，JS 侧把以太网帧通过 WebSocket 代理到本地 TCP/UDP 栈；受浏览器 CORS/WebSocket 约束，v1 先不做，但设备接口在设计上预留。

### 页面存储当作文件系统

1. **持久化层**：浏览器 IndexedDB（大容量、事务）作为后端，localStorage 只存小配置；
2. **wasm 侧文件系统**：核心里实现一张固定大小的文件表（`sim_hostfs_*` 导出），每个条目 `{name[40], offset, len, dirty}`，数据区放在线性内存的一段静态数组里（v1 为 8 MiB，可配置）；
3. **同步协议**：启动时 JS 从 IndexedDB 读出所有文件，通过 `sim_hostfs_import(ptr, len)` 灌入 wasm；运行中核心写文件时置 `dirty` 位，JS 在每帧末尾调用 `sim_hostfs_export(ptr, cap)` 取回变化并写回 IndexedDB。全程同步、无重入；
4. **访客可见性（v1）**：initramfs 自带根文件系统，页面存储用于固件、串口日志、快照、用户上传的文件——即"模拟器的文件系统"由页面存储承担；
5. **访客可见的持久盘（v2）**：把 wasm 侧文件表的一个文件暴露成简单块设备（I/O 端口 0x500 的 c6blk 协议），Linux 侧配一个小驱动或 initramfs 脚本访问；列为后续里程碑，不阻塞 v1 的"能跑 Alpine"。

### 导出 API 增补

```c
u8   *sim_host_bridge(void);            /* 64 KiB 共享内存邮箱 */
int   sim_host_event(u32 code, u32 len);/* JS → wasm 事件通知 */
int   sim_hostfs_import(u8 *buf, u32 len); /* IndexedDB → wasm */
int   sim_hostfs_export(u8 *buf, u32 cap); /* wasm → IndexedDB，返回序列化长度 */
int   sim_hostfs_put(const char *name, u8 *data, u32 len);
int   sim_hostfs_get(const char *name, u8 *dst, u32 cap);
```

邮箱 code：`1=NET_RESPONSE`、`2=STORAGE_LOADED`、`3=USER_INPUT`。所有跨边界数据都按显式小端字节序读写，避免 LP64/wasm32 布局差异。

---

## 11. 分阶段实施与验收

见 `TODO.md`。总体顺序：

1. 工具链与骨架 → 2. CPU 译码/执行 + 手汇编 payload → 3. 设备 + Linux 直接引导 → 4. Alpine 固件工具 → 5. wasm/web → 6. 端到端回归与文档。

每阶段的"完成"定义：

- 阶段 2：native 运行 `tests/hello64.bin`（手汇编），串口打印 `C6SIM64 OK`，退出码 0；
- 阶段 3：native 加载真实 bzImage+initrd，串口出现 Alpine 启动日志和 `localhost login:`；
- 阶段 4：`tools/mkfw.py` 一键产出 `firmware.bin`，native 直接加载它达到阶段 3 的效果；
- 阶段 5：`web/` 在浏览器里出现同样的登录提示符，能输入 `root` 回车看到 Alpine shell 提示符；
- 阶段 6：`./build.sh test` 全绿，`README.md` 记录已知限制。

---

## 12. 主要风险与对策

| 风险 | 对策 |
|---|---|
| Linux 启动期用到未实现的 opcode | 诊断打印首个未知指令 → 小步快跑补 opcode；先用一个极简 initramfs 缩短启动路径 |
| 解释器在 wasm 里太慢（启动要几分钟） | 批量执行、热路径专用化；v1 接受慢启动，UI 显示进度；未来换 DBT |
| wasm32 的 LP64 ABI 坑 | 核心只用固定宽度整数；固件/页表按显式字节偏移读写；用官方 wasm-smoke 做基线 |
| Alpine initramfs 的 init 依赖块设备/网络 | 用 minirootfs 自建 cpio.gz + 自定义 /init，根在 initramfs 内，不挂载外部设备 |
| PCI/APIC 复杂导致内核卡死 | 内核命令行加 `acpi=off noapic nolapic pci=off`，把复杂设备从启动关键路径上摘掉 |
| 4MiB malloc 静态池限制（c6 wasm 运行库） | 大内存用静态数组，不走 malloc；只在 native 侧用 FILE*/malloc |

---

## 13. 实现偏差（随实现更新）

1. **c6 `interface` 在 wasm32 路径不可用**：tcc-c6 为 wasm32 生成的接口胖指针是 LP64 布局（两个 8 字节字段），但 `libtcc1-wasm32.a` 里的 `__tcc_iface_init_lp64` 按 32 位指针写 4 字节偏移，导致 vtable 指针错位、调用即 `memory access out of bounds`（已用最小用例复现）。对策：MMIO 设备接口在 native 侧用 c6 `interface` + 方法实现，wasm 侧编译同一份逻辑时退化为显式分派（宏切换）；核心其余 c6 特性（方法、切片、foreach、元组、枚举命名空间）两条路径均可用。
2. **c6 `f"..."` 与 `err`/`catch` 在 wasm32 路径触发 ABI 警告**：`__c6_fmt_l` / `__tcc_err_set_copy` 的签名在 wasm32 目标下 mismatch。对策：把 `err`/`errdefer`/`f-string` 用在只编 native 的 `main.c6`（固件加载的错误处理与诊断），核心诊断用手工十六进制格式化的 `diagnostics` 输出。
3. **固件内核形态**：直接引导要求 1MiB 处是**未压缩**的内核镜像，`tools/mkfw.py` 在打包时先把 Alpine 的 bzImage 解压成 raw vmlinux（或用 Alpine 包里的 vmlinux），再写入 C6FW。
