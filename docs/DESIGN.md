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
│   ├── mem.c6                 # 客户机物理内存、MMIO 分派、页表遍历
│   ├── cpu.c6                 # CPUState、取指/译码/执行、标志位、异常
│   ├── dev.c6                 # 16550A、8259A、8254、CMOS、PCI 配置空间、debug 端口
│   ├── boot.c6                # Linux boot protocol：boot_params、e820、页表、装入
│   ├── machine.c6             # Machine：组装 RAM/CPU/设备，run loop，统计
│   ├── host.c6                # 宿主抽象：控制台环形缓冲、固件内存视图
│   ├── main.c6                # native CLI
│   ├── wasm.c6                # wasm 导出入口（导出全部函数由 wasm-ld 完成）
│   └── hostfs.c6              # 页面存储支持：文件表 + 共享内存邮箱（wasm 侧）
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
4. **wasm 后端局部指针变量会踩相邻栈槽**：tcc-c6 wasm 后端把 `struct CPUState *c = &g_m.cpu;` 之类的局部指针以 8 字节写进只分配 4 字节的栈槽，覆盖相邻局部（例如循环计数器 `n`），表现为「循环只跑一次」「字段读到垃圾」「串口只输出第一个字符」。对策：核心热路径（`machine_step_loop`、`mem_translate`、`fetch8/fetch_opcode`、serial 读写）全部改用 `g_m.cpu` / `g_m.serial` 全局直接访问，不保留局部指针；`machine_reset()` 整块清零 `g_m` 以绕开大结构偏移计算问题。
5. **wasm 下 c6 元组解构偏移错误**：`(u8 op, u8 rex, u32 pre) = fetch_opcode(c)` 生成的代码把 `rex` 读成 `op` 前一个字节，`op` 读成 0，导致译码全错。对策：`fetch_opcode()` 返回手工打包的 `u64`（`op | rex<<8 | pre<<16`），调用方用移位解包；native 仍保留元组 probe 作为特性验证。
6. **wasm 下 `memset` 不可用**：freestanding 链接会导入未定义的 `memset`。对策：`machine_reset()` 用手写 `for` 循环清零；核心不引入 `<string.h>`。
7. **wasm 弱别名方法入口风险**：`run()` / `cpu_raise` 的 `@weak alias` 在 wasm 下签名/跳转不可靠。对策：统一用静态函数 `machine_step_loop()` / `raise_exception()`（全项目改名，避免与 CPUState 方法别名冲突），c6 方法仅保留 native 兼容入口。
8. **`diag_u64` 在 wasm 上的输出顺序不可靠**：连续调用时标签与数值会错位（console 缓冲写入偏移问题），曾据此误判出「不存在的异常」。对策：wasm 冒烟不再依赖诊断字符串，改用导出探针与串口输出判断；native 保留 f-string/err 诊断。
9. **`machine_init()` 会清零整个 `g_m`（含 128 MiB RAM）**：JS 直接把 payload/固件写进 `g_m.ram` 区域会被复位抹掉。对策：`sim_load_payload()` / `sim_init()` 先把数据复制到 `g_m` 之外的静态 staging buffer，再复位并加载。
10. **wasm 侧文件表接口改为显式名字长度**：`sim_hostfs_put(name, name_len, data, len)` / `sim_hostfs_get(name, name_len, dst, cap)`。原因：c6 wasm 后端在 `cstr_len()` 这类带指针参数的循环里会把局部指针以 8 字节写进 4 字节栈槽，踩掉相邻计数变量导致死循环；JS 侧本来就知道文件名长度，显式传入即可绕开。同样原因，`sim_host_event(1)` 只作为 NET_RESPONSE 通知，文件写入由 JS 直接调 `sim_hostfs_put("__net/last", ...)` 完成。
11. **新增全局数组会改变 `g_m` 的链接地址并可能触发 wasm 后端另一处偏移 bug**：调试期间仅增加一个 10 字节全局常量数组就使 payload 冒烟从 26 条指令退化为 32660 条。对策：核心保持当前全局布局稳定，不随意新增全局；网络文件名由 JS 传入。12. **真实 Linux 固件引导（进行中）**：`tools/mkfw.py` 从 Alpine CDN 取 `vmlinuz-lts` 与 minirootfs，解压 bzImage 并抽取 ELF 首个 `PT_LOAD`（物理地址 `0x01000000`）写入 C6FW；`KERNEL_PA` 随之改为 `0x01000000`，`INITRD_PA` 改为 `0x06000000` 避免重叠。补了 `bts`、far jmp、64 位立即数符号扩展与高半区页表映射。当前 native 固件引导在 `rip=0x1000079` 触发 #PF（`CR2=0x7fffffff`、`RSP=0x7ffffffb`），尚未到串口登录提示，浏览器端 Linux 验证同样待完成。
13. **真实内核解码修复（进行中）**：修复了 MOV CR/通用 MOV 的 ModRM 操作数顺序、64 位立即数（符号扩展与 imm64）、长模式 near call 的 64 位目标、SIB base=5/mod=0 无基址、FS/GS 段前缀、ENDBR64/0F18 NOP、far jmp、BTS、内核高半区映射，以及 `mkfw.py` 装载全部 PT_LOAD 段。native 侧现可解码执行 3674 条指令进入内核早期初始化，但停在 `0xffffffff81bcca7e` 的 ticket lock 自旋，串口尚无输出；浏览器端 Linux 验证仍未完成。wasm 运行时库缺失时用 `~/c6/scripts/build-wasm-runtime.sh wasm32-unknown-unknown` 重建。
14. **引导修复续（进行中）**：修正 Jcc/setcc 条件码映射（2..7 曾整体错位）、32 位寄存器写入零扩展到 64 位、补 `leave`、补 PVH `struct hvm_start_info`（magic `0x336ec578`、cmdline、e820 表，EBX 指向该结构）、修正 boot header magic `HdrS`、扩展高半区 PDPT 映射。native 内核现可跑数万条指令并进入 `xen_prepare_pvh` 的内存映射阶段；仍在等待完整引导到串口登录提示。浏览器端已通过 headless Chromium 验证真实 fetch / Cache Storage / IndexedDB / wasm hostfs 往返。
15. **SIB 地址译码修复续**：SIB 的 index 字段是寄存器号，必须用 `c->r[index] << scale` 参与有效地址；SIB base=5/mod=0 还需读取 disp32；补 `retfq`；高半区页表遍历失败时按 `-4GiB`/`-2GiB` 窗口直接回退物理地址。native 引导现已越过之前卡死的 `pvh_start_xen` 循环，进入 `__startup_64` 的页表建立阶段。
16. **页表 NX 位污染物理地址（关键修复）**：4 KiB PTE 的 bit 63 是 NX。`mem_translate()` 原来用 `pa = e & ~0xfff` 拼物理地址，NX=1 时 bit 63 被带进 PA，`phys_r8()` 判为越界返回 `0xff`，于是 vmemmap 里每个 `struct page` 都读成 `0xffffffffffffffff`，`page_to_nid()` 得到非法 nid，`page_zone()` 变 NULL，最终在 `__free_pages_core()` 写 `zone->managed_pages` 时 #PF（CR2≈0x2a8c）。修复：1 GiB/2 MiB/4 KiB 三级页表项统一用 52 位物理地址掩码（`0x000fffffc0000000` / `0x000fffffffe00000` / `0x000ffffffffff000`）提取 PA，下一级页表地址同样掩码。修复后内核越过 `memblock_free_all()`。
17. **`mov r/m, sreg` 的 32 位零扩展**：`8C /r` 原来沿用了上一个 case 的 `s`（=1），`mov eax, cs` 只写 AL，导致 `sync_core()` 里 `iret_to_self` 保存的 CS/SS 帧被 RAX 高位污染、`iretq` 后 CS 变成 `0x6610`，最终 idle 线程崩溃。修复：`8C` 自己按 `REX.W/66` 取操作数宽度（8/2/4），32 位写入零扩展到 64 位。
18. **指令级差分测试器（tools/difftest）**：`native_run.c` + `run_stub.S` 用 sigaltstack/ucontext 在本机 CPU 上执行同一段机器码并捕获 16 个 GPR、RFLAGS、数据页哈希；`build/sim --blob` 在裸长模式（恒等映射 2 MiB 页）下执行同一 blob；`difftest.py` 枚举 348 条基础指令（ALU/移位/旋转/乘除/位操作/cmov/setcc/内存寻址/shld-shrd）+ 800 组随机指令序列，共 1160 例全部一致。期间修正：div/idiv 的 RDX:RAX 128 位被除数与商溢出检查、mul/imul 各宽度的 EDX:EAX 结果与 CF/OF、AF 标志位、SBB 借位、shld/shrd、`0F BA` 组 bt/bts/btr/btc、`cbw/cwde/cwd`、`lea mod=3` #UD、xadd 写回顺序、`/6` 移位（AMD 真机别名 SHL）、ROL/RCL/RCR 旋转语义。
19. **wasm 工具链恢复**：`~/c6/tcc/libtcc1-wasm32.a` 曾缺失导致 wasm 目标无法链接，用 `~/c6/scripts/build-wasm-runtime.sh wasm32-unknown-unknown` 重建后 `./build.sh test` 全绿（native + 单元测试 + wasm 冒烟），`node tests/browser_e2e.js` 也重新通过（真实 fetch / Cache Storage / IndexedDB / hostfs）。
20. **扩大范围差分测试（tools/difftest/fuzz2.py）**：除原有 1160 例外，新增全寄存器随机指令序列测试（movzx/movsx、imul、bt 家族、shld/shrd、rol/ror/rcl/rcr、setcc/cmovcc、xadd、bswap、adc/sbb/neg/not）。据此修出两处真实语义差异：`SHLD/SHRD` 在计数掩码后为 0 时不写目标寄存器，导致 32 位操作没有零扩展高 32 位；`IMUL r,r/m` 与 `SHLD/SHRD` 的 SF/ZF/PF 未按结果设置（SDM 里属未定义，但硬件会设置）。
21. **系统指令补齐**：`0F 01 /0`（sgdt）与 `/1`（sidt）此前被当成 NOP，而内核 `store_idt()` 依赖 sidt 保存 IDT 描述符，保存下来的是栈上垃圾值，随后的 `load_idt()` 会把 IDTR 指向垃圾地址；已实现 sgdt/sidt（以及 clts/invd/wbinvd，避免落进 #UD）。诊断中还确认了 `text_poke_early` 走的 static-call 蹦床、`native_save_fl` 的 iret 技巧、`local_irq_restore` 尾部调用在模拟器里都是正确的。
22. **系统指令补齐（二）**：`0F 01 /7`（invlpg）此前是空操作——内核 `text_poke` 改完页表后靠它失效 TLB，缺失会让模拟器继续用旧翻译执行改过的内核代码；已实现 invlpg（整表刷新）与 `/4` smsw、`/6` lmsw。
23. **引导卡点（已修）：异步中断被当成同步故障**：设备定时器用 `raise_exception()` 登记 vec=0x30，而 `step()` 末尾的「故障回退 RIP」对所有 exc_pending 生效，于是 `call [rip+disp]`（paravirt 调用点 `0x81053bcf`）已经压好返回地址后，RIP 又被拨回指令开头，投递时栈帧变成「RIP=call、RSP 已减 8」的不一致状态；handler 返回后 RIP 指回 call，而栈已经少了一槽，函数尾声的 `pop` 链整体错位，`ret` 弹出补丁缓冲区指针 `0x82403d8a` → 跳到数据上执行。修法：CPUState 增加 `exc_async`，设备中断改走 `raise_irq()`（异步），`step()` 只在**同步故障**时回退 RIP；同步异常优先于挂起的异步中断。修完引导从 `0.036666s`（alternatives 崩）推进到 `3.75s`（约 66×），全程定时器中断正常投递/返回。
24. **CPUID 与 SSE 面收缩**：CPUID.01H:ECX 原先写 `0x200`（正是 SSSE3 位），内核因此选 `blake2s_compress_ssse3` 触发 #UD；改为 0，只保留 EDX 里的 SSE/SSE2。同时补 `66 0F 6E/7E`（MOVD/MOVQ）并让 xorps/pxor/por/pand 覆盖两个 64 位半区，`movd xmm15, ecx` 一类不再 #UD。
25. **RIP 回退的第二处（已修）**：两字节指令组（`0F xx`）执行完也有一段 `if (exc_pending) c->rip = start;`，同样没区分异步中断。于是 `movzx esi, byte [rsi+rax+0x11]` 执行完（RSI 已变成读出的 1）后 RIP 被拨回该指令，投递帧变成「RIP=movzx、RSI=已写回」，handler 的 `push rsi` 压入 1，`iretq` 返回后以 RSI=1 重算基址 → `[1+0x240+0x11]` = `0x252` → NULL 解引用。加上 `!exc_async` 后引导越过该项：772M 指令无 oops（此前 484M 必崩），串口因 `loglevel=3` 无输出。
26. **用户态基础（本轮）**：`syscall/sysret` 按 SDM 重写（RCX=RIP、R11=RFLAGS、CS/SS 取自 STAR，SYSRET 用 STAR[63:48]+16/+8 并回填 RFLAGS）；中断投递在 CPL!=0 时先从 GDT 的 TSS 描述符取基址、读 `RSP0` 换栈，再把被中断的 CS/SS（而不是门选择子）压进 5 槽帧，并把 SS 切到内核数据段。
27. **进展**：initramfs 解包已通过（`Trying to unpack rootfs image as initramfs...` 之后继续 initcall），900s 长跑推进到 `6.26s` 内核时间（`NET: Registered PF_INET6 protocol family`），距 `Run /init as init process` 只差最后几个 initcall。native 吞吐约 560k 指令/秒，内核每 1s 引导时间约需 140s 墙钟。

28. **LAPIC IPI 投递（本轮）**：`0x300`(ICR) 写入此前只存值不投递，内核 `NMI testsuite` 的 `local IPI` 自检会无限等待（引导偶发卡在 0.63s）。现在按投递模式(DM)/简写(SH)字段投递：DM=4 走 NMI(vec 2)，DM=0 且 SH!=0 或 ICR2 目的地等于本 CPU ID 时投递对应向量；新增 `lapic_icr2`。修复后 `remote IPI: ok / local IPI: ok` 都通过，900s 长跑由 0.63s 推进到 2.34s 内核时间。

29. **下一步**：长跑（≥30 min）等到 `/init` → busybox → getty → `login:`；若用户态首条路径出错，按 §26 的 CPL3/syscall/TSS 三条链路依次核对。
26. **引导卡点定位（中断返回栈错位，历史记录）**：用「RIP 环 + 栈写入环 + 函数入口环」三组探针把 alternatives 崩溃收敛到一条证据链——`text_poke_early` 的**正常**调用（入口 `0x81053ba0`，RSP=0x…d80，四次 push 到 0x…d60）完全平衡；崩溃那次则是从 `0xffffffff81c0198c`（IRQ 桩）"返回"到 `0x81053bcf` 时 RSP=0x…**d58**（本该是 0x…d60），也就是**中断返回把被打断上下文的 RSP 少还原了 8 字节**，导致随后 4 次 pop 从 d58 弹到 d78，ret 弹到的是被保存的 r13（0x82403d8a，补丁缓冲区指针）而不是返回地址。下一步：查 IRQ 入口/出口的 5 槽帧在哪种路径上少压/多弹一个 qword（重点：`irq_entries_start` 的向量 0x30 桩、`irq_return`、以及嵌套中断）。
24. **引导进度续（2026-06 更新，二）**：又修了一批导致内核早期失败的问题——`bt/bts/btr/btc` 内存操作数的位偏移必须参与有效地址计算（否则 `set_bit` 落错字，`system_vectors` 位图错位，IRQ 向量门缺失）；INT3/INT n/INTO/ICEBP 属于陷阱类异常，保存的 RIP 指向下一条指令（内核 `int3_selftest` 依赖这一点）；补 x87 状态管理指令（`fninit`/`fldcw`/`fnstcw`/`fnstsw`/`fwait`），否则 `fpu__init_system` 直接 #UD；8259A 每片独立保存 ICW2/ICW3/ICW4 并按初始化序列区分数据口语义；HLT 在 IF=1 时等待中断而不是停机；`rep` 字符串指令改为每条目一步，避免长拷贝期间无法投递中断。内核现在通过 `unwind_init`、`mem_init`、`sched_init`、`int3` 自检与 x87 初始化，进入 `arch_cpu_finalize_init` → `alternative_instructions`。当前卡点：alternatives 打补丁期间（`apply_paravirt` 调用 `insn_decode`/`insn_get_displacement` 返回时）栈帧错位，返回地址槽被帧指针值（`0xffffffff82403e08`）覆盖导致跳入栈区；RIP 环显示中断在 `insn_get_displacement` 尾声被投递后返回即错位。：native + Alpine 固件现已输出完整串口日志：`Linux version 6.6.142-0-lts`、`BIOS-e820`、`earlycon: uart8250`、`RAMDISK`、`Zone ranges`、`mem_init`、`ftrace`、`Console: colour dummy device`、`printk: console [ttyS0] enabled`、`APIC disabled by BIOS`、`clocksource: refined-jiffies`；随后进入 `unwind_init()` 的 ORC 自检（约 4×10^7 条指令，属正常一次性开销），仍在向用户态推进。

30. **CPL3 下模拟器“代访”的权限判定（本轮关键修复）**：`mem_translate()` 原先用 `sel[1] & 3` 推断访问是否属于用户态。这条推断只对**客户指令自己**的访存成立；而 CPL3 期间模拟器自身也要访存——读 IDT 门描述符、把 5 槽异常帧压到 TSS.RSP0 栈上、缺页诊断探针读内核栈——这些都是**内核特权**访问。用 `sel[1]&3` 推断后，这些代访遇到内核页（U/S=0）就会误抛 #PF：
   - `cpu_deliver()` 读门外加压帧全部失败，异常帧根本没写进内核栈；
   - 内核的 #PF 处理器永远进不去；
   - 用户态首指令（`_start` 的 `push rbp` 撞未映射栈页）之后就一直重试，表现为“停在 0x401030 且不再推进指令数”。
   
   修法：`struct Machine` 增加 `emu_sup`；`cpu_deliver()`、`pg_fault()` 的诊断块内置 1；`mem_translate()` 的 CPL 推断改为 `((sel[1]&3) != 0 && !emu_sup)`。测试/自检代码在 CPL3 状态下改内存时也要显式置 `emu_sup`。

31. **64 位中断门有效性判断**：原判据是 `(gate >> 48) == 0` 就 `halted=1`——`gate>>48` 是 **offset_mid**，于是 handler 地址 < 4 GiB（offset_mid 天然为 0）的门全部被判死（内核高地址 handler 侥幸不受影响）。改为检查 P 位（bit47）与 `type != 0`。

32. **故障指令的寄存器回滚**：SDM 规定触发故障的指令不得留下任何架构副作用。`step()` 原来只把 RIP 退回指令开头；`push`（RSP 已减 8）、串操作（RSI/RDI/RCX 已推进）在 `pg_fault` 之后会带着半截副作用重试。现在同步故障回退时同时恢复 `RSP/RSI/RDI/RCX` 到指令执行前的值（内存写入不改值，天然幂等）。

33. **定位手段**：`--sample` 每 2000 万条指令打一行 `[SMP] n/rip/cpl/cr3/user_entries`；`g_m.watch_fd`（native 打开 `/tmp/simwatch.bin`）每 4096 条指令写 24 字节 `{cur_rip, instructions, 0}`、`mem_translate` 每 16384 次写 24 字节 `{mt_calls, va, cur_rip}`。用「指令数停涨但翻译数继续涨」这一对观测量即可把问题收敛到“异常投递路径”，再配合 §30 的权限分析定位。

34. **CPL3 换栈失效的真凶：64 位 TSS 描述符基址解析（本轮关键修复）**：`cpu_deliver()` 在 CPL3 时按 `tr_sel` 找到 GDT 里的 TSS 描述符并取 `RSP0`，但基址拼接写成了
    `tb = ((d0>>16)&0xffffff) | ((d1&0xffff)<<24) | ((d1>>32)<<32)`。
    64 位描述符的基址分布是：`base[23:0] = d0[39:16]`、**`base[31:24] = d0[63:56]`**、`base[63:32] = d1[31:0]`。第二项把 `d1` 的低 16 位当成了 `base[39:32]`，既丢掉 `base[31:24]`，又在基址高 32 位非零时整体错位。
    内核的 per-CPU TSS 基址在 `0xffff8880_07xxxxxx` 一带，错位后 `mem_r64(tb+4)` 读不到 `sp0`（得到 0）， `cpu_deliver()` 只好退化成 `rsp0 = old_rsp`——把 5 槽异常帧压回**用户栈**。而用户栈页正是刚触发缺页的那一页，于是：缺页 → 投递压帧又缺页 → `error_entry`（0xffffffff81c01340）再缺页，`[SMP]` 采样永远停在该地址（60M 条指令没有位移）。
    修正后单测把 TSS 基址取成 `0x07000000`（`base[31:24] != 0`）以覆盖这条解析。

35. **CPL3 首次进入就 segfault 的两个真凶（本轮，单测复现）**：内核日志是
    `init[1]: segfault at 0 ip 0000000000401032 ... error 4` + `Code: Unable to access opcode bytes at 0x401008`，
    而 `/init` 的入口 `0x401030` 是 `55 48 89 e5 ...`（`push rbp; mov rbp,rsp`）。
    `--ppt` 打出前四条缺页，直接暴露了问题：
    ```
    [PPT] va=401030 wr=0 us=1 rip=401030     ← 取指缺页（正常：代码页首次访问）
    [PPT] va=401031 wr=0 us=1 rip=401031     ← RIP 没有回退，前进了 1 字节
    [PPT] va=0      wr=0 us=1 rip=401032     ← 又前进 1 字节，解码出 add [rax],al
    [PPT] va=0      wr=1 us=1 rip=401032
    ```
    1. **ALU 家族缺页不回退 RIP**：`step()` 里 `op <= 0x3d` 的分支（`add/or/adc/sbb/and/sub/xor/cmp` 及其 `r/m` 形式）
       用**裸 `return 0;`** 提前返回，绕过了函数末尾统一的「同步故障回退 RIP + 回滚 RSP/RSI/RDI/RCX」。
       取指缺页时 `fetch8` 已经把 RIP 推进，返回值又被当成操作码继续解码，于是 RIP 一条一条往上漂，
       内核按错误的 RIP 重试，最终在 `add [rax],al`（RAX=0）上真正触碰地址 0。
       `0F` 两字节分支也有同样的提前返回，一并补上回滚。
    2. **`pg_fault()` 覆盖首条异常的 CR2**：同一条指令后续的连带访存（如上例的第二条 `wr=1 va=0`）
       仍会执行 `g_m.cpu.cr[2] = va` 并重设错误码，虽然 `raise_exception()` 因已挂起而忽略，
       但 CR2 已经被改成 0。内核 `do_user_addr_fault` 于是拿着 CR2=0 判定「不在任何 VMA」→ SIGSEGV。
       修复：`exc_pending` 已置位时直接返回，保留第一条异常的 CR2/ec。
    这两个 bug 都在 `tests/test_cpl3.c6` 里以秒级单测复现/守护：
    - 用户 `push rbp` 打未映射栈页 → 投递到 `TSS.sp0` → 内核建页表 → `iretq` 回 CPL3 → 重试 `push` 成功；
    - 取指缺页必须回退 RIP，CR2 必须是取指地址（不能被后续连带访存覆盖）。
    经验：**凡是在 `step()` 中间 `return` 的路径，都必须自己做完故障回退**；更好的做法是不要在中间 return。

36. **mini init 全链路验证通过（本轮里程碑）**：修完 §34/§35 后，用 mini initramfs
    （942 字节 cpio.gz，内含静态 `_start`：`write(1, "MINIT-OK", 9); exit(0)`）引导
    Alpine `vmlinuz-lts`：
    - 修复前：`init[1]: segfault at 0 ip 0000000000401032`，随后
      `Attempted to kill init! exitcode=0x0000000b`（SIGSEGV）；
    - 修复后：**没有 segfault**，内核直接报
      `Kernel panic - not syncing: Attempted to kill init! exitcode=0x00000000`
      —— `exitcode=0` 说明 `/init` 完整执行到 `exit(0)`（init 退出触发 panic 属正常）。
    这验证了 CPL3 进入、用户栈缺页处理、`syscall`、`exit` 全链路。下一步用真正的
    Alpine initramfs 跑到 `login:`。

37. **wasm 侧装载完整固件的现状（限制）**：`tests/browser_alpine.js` 已验证 wasm 能装载
    `web/sim.wasm`、把 32.7 MiB 的 `build/firmware.bin` 写进线性内存、`sim_set_cmdline`
    与 `sim_init` 都被正确调用（C6FW 头 magic/version/kernel_len 在 JS 侧与 wasm 侧都对得上），
    但 `sim_init` 仍返回 -1：**同一个 `struct Machine` 成员在 wasm 不同 TU 里偏移不一致**
    （`wasm.c6` 写 `g_m.fw_kernel_len = 30814208`，`boot.c6` 里 `boot_probe()` 读出来是 0，
    而同结构里的指针成员 `fw_kernel` 读出来正常）。这是 c6 wasm 后端已知的一类代码生成问题
    （见第 10 条），不是逻辑错误。
    为此把固件字段的写入与 `machine_boot()` 收进同一个 TU（新增 `machine_boot_staged()`），
    结构上更稳妥；但在后端修好前，**浏览器里跑完整 Alpine 仍不可用**。
    浏览器侧已通过的是：wasm 实例化 + 真实 fetch + Cache Storage + IndexedDB 文件表 +
    hostfs 往返 + payload 运行（`node tests/browser_e2e.js`，见阶段 6）。

38. **Alpine 真实 initramfs 进展：进到 musl 动态链接器（当前卡点）**：用官方
    `build/firmware.bin`（内核 30 MiB + Alpine minirootfs initrd 3.4 MiB）跑到
    `Run /init as init process` 之后，用户态真正跑起来了：
    ```
    [    5.959745] Problem loading in-kernel X.509 certificate (-129)
    [    6.243060] init[1]: segfault at 7fe31d7f9d88 ip 00007fe2391dc7cf sp 00007fffe06936d0
                  error 4 in ld-musl-x86_64.so.1[7fe23918d000+54000]
    Code: ... 48 8d 3d bc 95 03 00 44 89 e0 <48 63 04 87> 48 01 f8 ff e0 ...
    ```
    `<48 63 04 87>` 就是 `movslq (%rdi,%rax,4),%rax`（musl 的跳转表分派），
    而 CR2 精确等于 `RDI + 4*RAX`（RDI=0x7fe239215d88、RAX=0x39179000）。
    也就是说前一条 `mov eax,r12d`（`44 89 e0`）没有把 RAX 变成 R12 里的小索引
    （内核 dump 里 R12=7），RAX 还留着上一个系统调用返回值。
    已把 `mov r/m,r`（0x88..0x8b）与 `movsxd`（0x63）的寄存器形式补进差分测试
    （原来 alu 列表里没有 0x89/0x8b，是覆盖盲区），1232/1232 全过——说明这两条
    指令本身实现是对的，问题更可能在这些指令**之前**的状态（例如某条指令的
    32 位写没有零扩展、或 syscall 返回值路径）。
    下一步：用 `--trace_win`（CPL3 首次进入后的 600 步全量 RIP 环）抓 musl
    加载器出错前的指令序列，定位是哪条把 RAX 留大的。

39. **Alpine initramfs 已跑起多个用户进程（本轮新证据）**：用 `--ppt` 跑完整固件，
    `[PPT]` 记录显示 initramfs 的 `/init` 脚本 fork 出了**多个进程**（每次 ASLR 基址
    不同：0x7f20…、0x7fd4…、0x7fa9…），每个都跑到 musl 动态链接器里，说明
    用户态、fork/exec、文件系统这些链路都基本可用。最终崩在同一个地方：
    ```
    [PPT] va=7fe239215da4 wr=0 us=1 rip=7fe2391dc7d3   ← musl 跳转表 movslq 的读
    [PPT] va=7fe31d7f9d88 wr=0 us=1 rip=7fe2391dc7d3   ← 同一 RIP 再次执行，RAX 变成上次读出的值
    [PPT] va=80009a070    wr=0 us=0 rip=80009a070       ← 处理器跳到 0x80009a070（CPL0 取指）
    ```
    第二条的地址精确等于 `RDI + 4*RAX`（RAX=0x39179000），也就是同一条 `movslq`
    **在同一次重试路径上被执行了第二次**，而此时 RAX 已经是第一次读出来的值。
    推测根因：`op_read` 在缺页时返回 0 并且**不阻止后续的写入/重试语义**，
    配合 `step()` 的 RIP 回退，容易出现「缺页指令留下部分副作用」；另外
    最后那条 `rip=va=0x80009a070` 属于内核态跳到野地址，说明故障处理路径上
    内核栈里的某个返回地址被写坏了。
    下一步（留给下一轮）：给 `step()` 加一个「本指令已因缺页中止」的硬标记
    （`c->fault_abort`），让 `op_read`/`op_write`/`push`/串操作在置位后全部变成
    空操作，保证缺页指令零副作用；再用同样的 `--ppt` 复验 musl 分派是否还崩。

40. **缺页指令零副作用（`fault_abort`，本轮实现）**：SDM 要求触发故障的指令完全
    没有架构副作用。之前只有「RIP 回退 + RSP/RSI/RDI/RCX 回滚」，但像
    `movsxd rax, [mem]` 这种指令，`op_read` 在缺页时返回 0，后面 `reg_write(RAX, 0)`
    照样把目标寄存器写脏——Alpine musl 跳转表分派正是这样把 RAX 污染成
    上一次读出的 32 位偏移（§39）。
    实现：`CPUState` 增加 `fault_abort`。`pg_fault()` 置 1；`mem_w8/16/32/64`、
    `reg_write()`、`push64()` 见到置位直接丢弃；`step()` 开头清 0；
    `cpu_deliver()` 入口清 0（投递本身要正常压帧）。这样故障指令的一切写入
    都被丢弃，配合已有的 RIP/寄存器回退，做到「零副作用 + 可重试」。
    回归测试：`tests/test_cpl3.c6` 场景 8 —— 用户态 `movsxd rax,[rdi+rax*4]`
    打未映射页，要求 RAX 保持 3、CR2=rdi+12、RIP 回退。

41. **`fault_abort` 之后的 Alpine 状态：不再崩，但系统停在 idle**：完整固件复跑
    45 分钟（`loglevel=4`）没有再出现 segfault/panic，`--sample` 采样显示
    ```
    [SMP] n=1540100150 rip=ffffffff81c003f0 cpl=0 cr3=2434000 ue=541
    ```
    - `rip=ffffffff81c003f0` = `irq_entries_start + 0x100`，采样里 25/40 次都命中这里，
      另有 `arch_cpu_idle_exit + 4` —— 说明 CPU **大部分时间在中断入口和 idle 循环**；
    - `ue=541` 且 15 亿条指令里只进过 541 次用户态 —— 用户进程几乎没在跑；
    - `cr3=0x2434000` 是 initramfs 阶段 PID 1 的 mm。
    结论：**系统没崩，但所有任务都在等事件**（idle），initramfs 的某个环节卡住了。
    下一步用 `loglevel=7` 抓内核消息，看 `/init` 脚本停在 mount/mdev/modprobe 哪一步。

42. **`f3 0f 7e`（MOVQ xmm, m64）方向搞反（本轮差分测试抓到）**：`0x7e` 的处理器
    对所有前缀一视同仁地当成 `MOVD/MOVQ r/m, xmm`（**写**）：
    ```
    case 0x7e: op_write(c, &rm, (rex&8)?8:4, c->xmm[x][0]);
    ```
    但 SDM 里 `f3 0f 7e /r` 是 `MOVQ xmm, xmm/m64`（**读**），只有 `66 0f 7e /r`
    才是写。musl 的动态链接器里两种形式都出现，把它当成写就会**直接踩坏内存**
    （往代码/常量区写 xmm 的低 64 位），Alpine 的 `grep` 就是因此报
    `segfault at ... error 6`（写、用户、页不存在）。
    修法：`0x7e` 里判 `pre & PRE_REP`（F3），是则改成读（`xmm[x][0] = mem_r64` /
    xmm→xmm 复制，高半区清零）。
    差分测试补了 4 条内存形式用例（`f3 0f 7e` 读、`66 0f d6` 写、`0f 6e`/`66 0f 7e`
    的 movd 读写），1236/1236 全过。
    教训：**SSE 指令的方向/宽度由前缀决定**（66/F2/F3 各不同），写处理器时必须
    先看前缀再决定读写方向；差分测试要覆盖内存形式，只测寄存器形式会漏。

43. **Alpine 现在稳定停在 initramfs 的 idle（本轮结论 + 下一步）**：修完 §40/§42 后，
    完整固件跑到 32.8 亿条指令仍然**没有 panic/segfault**，但采样恒定在
    ```
    [SMP] n=3280366589 rip=ffffffff81c003f0 cpl=0 cr3=2434000 ue=535
    ```
    `cr3=0x2434000` 还是 initramfs 阶段 PID 1 的 mm，说明**没到 `switch_root`**；
    `ue` 只有 535 且 CPU 在 `irq_entries_start`/`arch_cpu_idle_exit` 之间打转，
    即所有任务都在等事件（idle）。`loglevel=7` 的长跑显示 6.24s 时 `grep` 因
    `f3 0f 7e` 方向 bug 踩坏内存而崩（§42 已修），64s 时 `crng init done`，之后静默。
    下一步：加一个**系统调用跟踪器**（PID 1 的前 N 个 syscall 号 + 参数 + 返回值），
    直接看 `/init` 卡在哪个 syscall（很可能是 mount/mdev/wait4/vfork 之一），
    比继续猜快得多。
