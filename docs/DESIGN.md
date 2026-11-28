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
| `defer` / `errdefer` | v1.0.2 前用于 native 固件加载（`defer fclose(f)` / `defer free(...)`）。**v1.1 起 `main.c6` 改为朴素写法**：`--emit-ctu` 不降级这些语法，为了同一个入口文件既能被 c6c 直接编、也能进宿主 cc 快速构建，错误路径改成显式 `fclose/free`（见 §84） |
| `int!error` + `err` + `try` / `catch` | 同上，v1.0.2 前 `main.c6` 用它做固件加载/boot 的错误链；v1.1 起改为返回 `int` + 打印原因。`machine_*` 接口本来就是返回 rc，`try/catch` 只影响 CLI 层 |
| `f"..."` | v1.0.2 前用于 `main.c6` 的错误信息；v1.1 起 CLI 用 `printf("... %s", ...)`。wasm 侧本来就不用 f-string（tcc-c6 后端不支持） |
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

44. **用 `--sys` 跟踪器定位到「没有 login 提示」的真因（本轮）**：给模拟器加
    `--sys` 后，每次 `syscall` 打一行 `[SYS] cr3/nr/a0..a3`（前 6000 条），
    并对 `write(2,…)`、`connect(…, AF_UNIX)` 额外打印内容。Alpine 固件跑到
    32 亿条指令后，日志里出现：
    ```
    [SYST] .can't open /dev/tty6: No such file or directory.
    [SYST] .can't open /dev/tty1: No such file or directory.
    ...
    [SYSC] /dev/log..
    ```
    ⇒ 系统**早已进到真实 root 并在跑 getty**，只是：
    1. `/dev` 不是 devtmpfs ⇒ `/dev/tty1..6`、`/dev/ttyS0` 都不存在；
    2. Alpine 的 `/etc/inittab` 里串口那行是**注释掉的**：
       `#ttyS0::respawn:/sbin/getty -L 115200 ttyS0 vt100`，
       而 `mkfw.py` 的注入脚本用 `grep -q ttyS0` 判断——命中注释就**从不追加**。
    修法：`/init` 补 `mount -t devtmpfs dev /dev`；inittab 先用 `sed` 取消注释，
    再按行首判据 `grep -q '^ttyS0::respawn'` 兜底追加。
    这条经验说明：**"系统看起来卡住" 常常只是最后一个用户态进程在报错循环**，
    一个 syscall 跟踪器比猜测内核栈快得多。

45. **改用 `/bin/login` 后系统在 init 阶段 halt（当前卡点）**：minirootfs 里既没有
    `/sbin/openrc` 也没有 `/sbin/getty`（`--sys` 跟踪里是
    `can't run '/sbin/openrc'`、`can't change directory to '/lib/modules'`），
    所以把 inittab 的串口行改成 `ttyS0::respawn:-/bin/login`，并清空 root 密码、
    给 `/init` 补 `mount -t devtmpfs`。重建固件后用 `tools/boot_login.py` 跑：
    ```
    [c6sim] halted, instructions=2261778433, exit=0
    ```
    模拟器在 2.26e9 条指令（约 7.5s 客户机时间）后停机 —— 说明新路径下有
    三重故障/`hlt` 且 IF=0 的情况。下一步：用 `--sys --sample` 复跑，看停机前
    最后几条 syscall 和 RIP；重点怀疑 `sed -i`（写临时文件+rename）、
    `mount -t devtmpfs`，以及 `/bin/login` 依赖的 tty ioctl 路径。

46. **`/bin/login` 已经在 ttyS0 上等输入（本轮里程碑）**：用 `--sys --sample` 复跑，
    最后 6 条 syscall 是
    ```
    [SYS] nr=5  (fstat)  a0=0
    [SYS] nr=16 (ioctl)  a0=0 a1=0x540b        ← tty 属性查询
    [SYS] nr=63 (uname)
    [SYS] nr=16 (ioctl)  a0=1 a1=0x5413        ← TIOCGWINSZ
    [SYS] nr=20 (writev) a0=1 a1=… a2=2        ← 写登录提示
    [SYS] nr=0  (read)   a0=0 a1=… a2=0x400    ← 阻塞等输入
    ```
    `[SMP]` 采样同时显示 `rip=irq_entries_start cpl=0`、`ue=1189` —— 系统在 idle
    等输入。也就是说 **initramfs → /sbin/init → inittab → /bin/login 全链路已经
    跑通，login 提示已经写进 ttyS0，进程正阻塞在 read(0)**。
    还剩一个**串口输出路径**问题：6s 之后内核 console 之外的输出（login 提示、
    openrc 报错等）没有出现在模拟器 stdout 上，说明 tty 驱动的**中断发送路径**
    （THRE 中断 → `serial8250_tx_chars`）没有被正确驱动。下一步：
    检查 8250 的 IIR/IER/THRE 与 IRQ4（PIC/IOAPIC）投递，或先用轮询模式
    （Console 走 `serial8250_console_write` 已能工作到 5.98s）验证。

47. **确定性停机点 + 串口输出缺口（本轮收尾状态）**：反复跑都在
    `instructions=2261778433` 精确停机（两次独立运行同一数字），说明是某个
    **确定性 bug**（大概率是 `hlt` 时 IF=0 或三重故障），而不是超时/竞态。
    同一次运行里 `[SYST] ttyS0::respawn:-/bin/login.` 能出现在串口输出里，
    说明 6s 前后的 console 输出通路是通的；但 `/bin/login` 通过
    `writev(1, …)` 发出的提示没有落到模拟器 stdout（`[SYS]` 只看到
    `ioctl(0,0x5402)`(TCSETS) 与 `read(0,…)`），又说明 **tty 驱动 → 16550 的
    中断发送路径**在用户态加入后有问题。
    下一步（按优先级）：
    1. 给 `machine_step_loop` 的停机分支加诊断（打印停机前的 RIP/IF/halted 来源），
       定位 2261778433 这条确定性停机；
    2. 检查 8250 的 TX 中断（IER bit1 / IIR=0x02 / THRE）与 IRQ4 的投递；
    3. 或用 `console=ttyS0` 下轮询模式验证串口输出是否恢复。

48. **确定性停机点的现场（本轮最后一条证据）**：加 halt 诊断后拿到
    ```
    [HALT] rip=ffffffff81c003f0 flags=46 cr3=3eea000 insns=2261778433
    [c6sim] halted, instructions=2261778433, exit=0
    ```
    - `rip=irq_entries_start+0x100`（中断入口桩），`cr3` 是某个用户进程的 mm；
    - `RFLAGS=0x46` 表示 **IF=0**（bit1 保留位 + PF + ZF）；
    - 指令数每次都是 2261778433，完全确定性。
    ⇒ CPU 在「中断入口桩 + 关中断」状态下执行了 `hlt`。正常内核不会这样做，
    最可能是某条指令把 RFLAGS 弄坏了（`popf`/`iretq`/`syscall` 的 SFMASK 路径、
    或 ALU 的 flags 计算），也可能是 `hlt` 的 IF 判断读错了位。
    下一步：在 `case 0xf4`（hlt）里打印 `rip/flags/CS`，并在 `iretq`/`popf` 后
    校验 IF 是否按预期恢复，用 `tests/test_cpu.c6` 补一条 `pushfq/popfq/hlt`
    的语义测试。

49. **Alpine 原生引导到登录 + root shell（里程碑达成）**：把 `boot_login.py` 的输入
    时机提前（在 login 就绪前就把 `root\n` 写进串口输入环）后，串口日志出现
    ```
    See <https://wiki.alpinelinux.org/>.
    You can setup the system with the command: setup-alpine
    login[443]: root login on 'ttyS0'
    (none):~#
    ```
    也就是 **Alpine 的 /sbin/init → inittab → /bin/login → root 登录 → shell**
    全链路在模拟器里真实跑通。之前"卡住/无输出"的两个真因都已修掉：
    §44 的 devtmpfs + inittab 注入、§45 的 /bin/getty→/bin/login 替换；
    而 §47/§48 记录的"确定性停机"其实是 **guest 主动关机**——
    `dev.c6` 把 I/O 端口 `0xf4` 当成 QEMU 关机端口，内核在 init 退出时会写它，
    所以登录超时后进程退出 → 内核关机 → 模拟器 halt。给 0xf4 加了
    `[OFF] port/val/rip/insns` 诊断确认了这一点。

50. **绕开 wasm 后端结构体成员偏移 bug：固件长度改用独立全局**：之前
    `sim_init()` 在 wasm 里总返回 -1/-4，实测是「结构体里紧跟在指针成员后的
    u32 成员」在不同 TU 读写偏移不一致（native 完全正常，见 §37）。
    把 `fw_kernel_len` / `fw_initrd_len` 的**权威值**挪到两个独立全局
    `g_fw_klen` / `g_fw_ilen`（boot.c6），`machine_load_firmware()`,
    `machine_boot_staged()`, `machine_boot()` 统一读写这两个全局。
    改完后 headless Chromium 里 `sim_init(固件 32.7 MiB)` **返回 0**，
    wasm 已经能装载并启动完整 Alpine 固件；但内核在 ~100 万条指令的早期就
    halt（另一个 wasm 侧问题），浏览器里跑到 login 仍未打通。

51. **阶段 5 达成证据（native Alpine → login → root shell）**：`build/alpine15.out`
    里的串口内容（无任何 patch 的 `build/sim30`、官方 Alpine 固件）：
    ```
    Welcome to Alpine!
    The Alpine Wiki contains a large amount of how-to guides ...
    login[445]: root login on 'ttyS0'
    (none):~#
    ```
    这是 `/sbin/init` → `/etc/inittab` → `ttyS0::respawn:-/bin/login` →
    root（空密码）→ `-sh` 的完整链路，运行在模拟器里。
    注意 `boot_login.py` 的自动验收还差一步：它按 “等 `login:` → 发 root →
    等 `# ` → 发 `uname -m`” 的顺序驱动，但本模拟器的串口输出在 idle 时
    偶发延迟，脚本容易错过提示符而超时；手工定时喂输入（先 root、隔几分钟
    再发命令）能稳定进 shell。下一步把 `boot_login.py` 改成“轮询发送 + 重试”，
    并把 `uname -m` 的 `x86_64` 输出作为最终判据。

52. **阶段 5 正式验收通过**：`tools/boot_login.py`（盲发输入版）输出
    ```
    [boot_login] shell prompt seen, sent 'uname -m'
    PASS: Alpine booted to login and ran 'uname -m' (log: build/login.log)
    ```
    串口日志结尾：
    ```
    (none):~# uname -m; echo MARK-OK
    x86_64
    MARK-OK
    (none):~#
    ```
    也就是说：官方 Alpine 固件在模拟器里完成 initramfs → `/sbin/init` →
    inittab → `/bin/login` → root 登录 → busybox shell，并且**真的执行了
    用户命令并返回 `x86_64`**。阶段 5 完成。
    剩下阶段 6 的「浏览器里跑同一固件到 login」：`sim_init` 已返回 0（§50），
    但 wasm 里内核在约 100 万条指令处就 halt，需要继续查（大概率是另一个
    wasm 后端代码生成问题，而不是逻辑问题）。

53. **wasm 里内核早期 halt 的现场（剩余唯一 TODO）**：加了 `sim_halt_info()`
    （1=machine halted，2=cpu halted，4=pending 异常，8=fault_abort）导出后，
    headless Chromium 里读到的状态是：
    ```
    halt info: {"hi":3,"rip":37378,"fl":70,"n":18590}
    rc=0（sim_init 成功装载 32.7 MiB 固件）
    ```
    - `hi=3` = `g_m.halted`(**hlt 时 IF=0** 这条分支) + `cpu.halted`；
    - `rip=0x9202`（内核早期低地址）、`flags=0x46`（**IF=0**）、
      只有 **18590** 条指令就停了，完全确定性。
    native 同一固件能跑到 login，所以这是 **c6 wasm 后端**在这条路径上的代码
    生成问题（同一份源码、同一份数据，只有 wasm 目标异常），不是模拟器逻辑
    问题。已做的缓解：wasm 侧忽略 0xf4/0xfe 关机端口（`#if !defined(C6_WASM)`）。
    下一步建议：把内核早期那 18.6k 条指令的 RIP 序列 dump 出来，与本机 native
    跑同一固件的前 18.6k 条 RIP 序列逐条比对，第一条不同的指令就是后端 bug
    的现场（可以用同一套 `rip_ring`，只是把记录条件换成“前 20000 条”）。

54. **wasm 首个分叉点定位到第 29 条指令（call/ret 路径）**：加了 `--riptrace`
    （native 写 /tmp/simwatch.bin，wasm 通过 `sim_rip_trace(i)` 读）后逐条比对：
    ```
      23..27  nat=010006a9..010006b2  wasm=同
      28      nat=01bcda30             wasm=01bcda30     ← 进入一个只有一条指令的被调函数
      29      nat=010000ba             wasm=00000000     ← 本机返回到 0x10000ba，wasm 返回到 0
      30..    nat=010000bc/010000c3..  wasm=00000002/00000004/...  ← 于是从 0 开始按 2 字节步进解码
    ```
    也就是 **`ret` 在 wasm 里弹出了 0**（本机正确弹出 0x10000ba），随后从地址 0
    开始执行垃圾指令。说明 wasm 侧的 **call/ret 与栈上返回地址**这一环有问题
    （或者 `call` 压入的值不对），而不是解码器本身。
    下一步：在 wasm 里把第 28 条前后的 RSP、以及 `[rsp]` 的内容导出
    （同样的方式：写进 `g_m.ram` 再读），确认是“压错”还是“弹错”。

55. **wasm 下 call/ret 返回地址为 0 —— 已修，内核推进 600 倍**：用 9 字节的最小
    payload（`call 0x10008; hlt; nop; nop; ret`）在 wasm 里跑，10 条指令就复现：
    ```
    step 0: rip=0x10008      call 正常
    step 1: rip=0x0          ret 弹出 0（本机是 0x10005）
    ```
    根因：c6 的 wasm 后端对「通过 `struct CPUState *` 访问结构体内的 u64 数组
    元素」会生成错误的地址计算（`c->r[4]` 读到的不是 RSP）。把 `push64()/pop64()`
    里的 RSP 读写改成经全局 `g_m.cpu.r[4]` 后，最小用例的 `ret` 正确回到
    0x10005，完整固件在 wasm 里从 **18,590 条指令**推进到 **11,465,697 条**
    （约 600 倍）。difftest 仍 1236/1236。
    仍会在 11.4M 处 halt（`hi=3`、`flags=0x46` 即 hlt+IF=0、RIP 是内核高地址），
    说明还有同类的 wasm 后端问题；下一步用同样的 RIP 逐条比对（把 trace 容量
    从 2 万提到能覆盖 1200 万，或改成只记录指定窗口）。

56. **RIP 逐条比对工具的现状（已撤回）**：为了定位 wasm 第二个分叉点，试过把
    前 N 条 / 环形 2 万条 RIP+RSP 写进 `g_m.ram` 再导出，并加 `--stopt=N` 让
    native 停在同一个指令数上对比。但加上环形写之后 `--riptrace` 路径本身
    会在启动十几秒内崩溃（默认路径不受影响，`build.sh test` 与 difftest 全绿），
    为避免把不稳定的调试代码留在树里，**已把循环内 trace 写入和 ring dump 删掉**；
    `g_m.stopt`（跑到指定指令数就停）保留，因为它只影响调试运行。
    结论：wasm 的第二处问题需要换一种更稳的定位方式（例如在 wasm 侧用
    `printf` 走串口输出把关键 RIP 打出来），而不是内存环形缓冲。

57. **秒级 native/wasm 对拍（本轮最有效的手段）**：不再跑几十分钟的浏览器引导，
    改成 `tests/wasm_cmp.js <指令数>`：
    - native：`--stopt=N --dumpregs` 打印 16 个 GPR/RIP/RFLAGS；
    - wasm：`sim_set_stopt(N)` 跑到同一指令数，再用 `sim_cpu_reg(i)` 读；
    - 对比同一指令数下的寄存器快照，几秒钟一次，二分找第一条分叉。
    据此连修两个 **c6 wasm 后端的代码生成 bug**（都是“通过指针访问结构体成员/
    数组”这一类）：
    1. `push64/pop64` 里的 `c->r[4]`：wasm 读到的不是 RSP，导致 `ret` 弹出 0
       （9 字节 payload 即可复现）；改成经全局 `g_m.cpu.r[4]` 后正常。
    2. `dev_tick()` 里的 `struct PicState *p = &m->pic; p->irr[...]` 写法：
       每 262144 条指令（正好是 `dev_tick` 的调用周期）就会把 RDX/clobber 成 0；
       改成直接用 `g_m.pic.` 后，262144 处对拍 MATCH。
    修完后 wasm 的确定性分叉点从 **18,590** 条推进到 **874,905** 条（约 47 倍）。
    最新分叉点（874,905→874,906）的指令是
    `mov ecx, [rip+0x314e47]`（读 0xffffffff82d6bcfc）——寄存器别的都对、只有
    RCX 本应是 0x3525e9 却读到 0，说明这是**内存状态**的差异（不是寄存器/解码），
    下一步给 `tests/wasm_cmp.js` 加内存哈希对比（例如 `sim_read_pa()` 读几个
    关键地址），继续二分。

58. **对拍加入内存哈希后：连最早 1000 条指令都不一致**：给 `tests/wasm_cmp.js`
    加了全 RAM（128 MiB）的 FNV 哈希（native 侧 `[REG] memhash`，wasm 侧
    `sim_mem_hash()`）之后，**1000 条指令时内存哈希就已经不同**，而寄存器一致。
    这说明前面的“寄存器一致”只覆盖了架构可见状态，内存里早就有差异（很可能是
    固件装载/早期页表写入路径上的另一个 wasm 后端问题）。
    下一步：把哈希改成**按区域**（先只哈希内核映像 0x01000000..0x03000000），
    并把 `sim_mem_hash(start,len)` 做成带参数版本，逐步缩小到具体页，
    再用 `sim_read_pa()` 做逐字节确认。
    当前状态：`build.sh test` 与 difftest 1236/1236 全绿；native 阶段 5 验收仍 PASS。

59. **内存差异定位到字节 0x7005（本轮结束点）**：用区域哈希二分（native `--memhash=S,L`
    vs wasm `sim_mem_hash_region(S,L)`，都不走指针），在 1000 条指令处逐步缩小：
    - `0..0x1000` MATCH；
    - `0..0x8000` DIFF ⇒ 二分到 `(28685, 28686]`，也就是 **字节 0x7005 是第一个
      不同的字节**（0x7000 起是我们 `GDT_PA` 的 GDT 页，0x7005 是第一个描述符的
      access byte）。
    也就是说 wasm 在启动后 1000 条指令内，就写坏/漏写了 GDT 里的一个字节。
    下一步：把 native 侧 `--dumpmem` 的打印修好（现在 dump 循环要求 len>=16 且
    判定用的 `dumpmem_len` 解析有坑），直接对比 0x7000 起 16 字节；再用
    `sim_ram_byte(pa)` 在 wasm 侧确认该字节的值。

60. **哈希反解出差异字节：0x7005 处 native=0x9b、wasm=0x00**：区域哈希是
    FNV-1a，单字节可穷举反解。知道 `H(0..28685)` 和 `H(0..28686)` 就能算出
    第 28685 字节：
    ```
    native byte@28685 = 0x9b    （代码段的 access byte）
    wasm   byte@28685 = 0x00
    ```
    也就是说 wasm 在启动后 1000 条指令内，把 GDT 页（0x7000 起）里本该是 0x9b
    的那个字节写成了 0（或根本没写）。这类“写 u8/写描述符”的差异正是前面
    一系列 wasm 后端 bug 的同类，下一步查这一笔写入是谁做的（大概率是内核
    早期 `lgdt` 前后的 GDT 描述符写入，或我们 `build_gdt_idt` 的等价路径）。
    工具已经齐了：`tests/wasm_cmp.js`（寄存器 + 区域哈希 + 单字节反解），
    每次验证都是秒级。

61. **`tests/wasm_boot_smoke.js`：秒级判断 wasm 串口通道通不通**：浏览器跑 1742M 条
    指令、串口 0 字节。为了不用几十分钟的完整引导排查，新增这个冒烟脚本：
    装载固件 → 分块 `sim_run` → 每块 `sim_serial_out(SCRATCH, 64K)` 取字节，
    默认跑 8M 条指令（几秒钟），看到 `Linux version` / `Run /init` 即 PASS。
    实测（8M 条指令）：`serial=0B halt_info=0`，而**同一指令数下 native 也没有
    任何串口输出**（`--stopt=8000000` 只打印 halt 行）——说明 8M 太早，
    内核还没开始 printk，脚本阈值需要抬高才有意义。
    结合 `tests/wasm_cmp.js` 的二分结果（**150M 条指令 MATCH、200M 条指令
    DIVERGE**，且这只是寄存器+内存的状态对比），可以解释浏览器里「跑了很多、
    串口全空」：wasm 在 1.5 亿～2 亿条之间失步，而内核第一次 printk 在那之后，
    所以永远看不到输出。下一步就在 150M→200M 之间二分（这区间每步 wasm 约
    2～3 分钟），拿到分叉指令后按同样的方式修。

62. **检查点快照对拍（`tests/wasm_snap.js`）——一次跑完整个区间**：逐点二分每一步
    都要重跑 native + wasm（各几分钟），太慢。改成：
    - native：`--stopt=END --snap=START,STEP`，在 `machine_step_loop` 里每到检查点
      打印一行 `[SNAP] <insns> <rip> <flags> r0..r15`；
    - wasm：循环 `sim_set_stopt(k)` + `sim_run(k+STEP)`，每次都**精确停在**第 k 条，
      再读 `sim_cpu_reg(i)` / `sim_last_rip()` / `sim_cpu_flags()`；
    - 两边按指令数配对比较，第一个不一致的检查点即分叉区间（精度 = STEP）。
    调试过程中踩到的三个坑（都已修）：
    1. `sim_run(STEP)` 会因 idle 路径一次 `instructions += 0x2000` 冲过头，
       必须用 `sim_set_stopt(k)` 精确停点；
    2. `sim_run` 的返回值 0 表示「停在 stopt」，不是停机，不能当 halt 处理；
    3. **快照时机差一条指令**：native 原来在 `step()` 之前打快照（`instructions++
       之后、执行之前`），wasm 是执行完 N 条之后读，两者差一条指令，于是每个
       检查点都出现 1～4 字节的 RIP 差和“看起来像寄存器分叉”的假象。把 native
       的快照移到 `cpu_step()` + `cpu_deliver()` 之后，1500000..1500100 的
       101 个检查点全部 MATCH。

63. **本轮修掉的 6 个 wasm 后端问题（都属同一类：结构体内数组/成员的读写）**：
    1. `dev_tick()` 的 `struct Machine *m = &g_m; m->...` → 改用 `g_m.`；
    2. `dev_init()` 里 `struct Machine *m` + `struct SerialState *s = &m->serial`
       → 全部改直连（否则 wasm 里 PIC/串口初始化整个写偏，`imr` 一直是 0）；
    3. `pic_read/pic_write/pit_read/pit_write` 的 `struct PicState *p = &g_m.pic`
       形式的 `p->x[i]`（含动态下标）→ 全部改 `g_m.pic.`/`g_m.pit.`（本轮对
       dev.c6 做了函数作用域内的机械替换，共 77 处）；
    4. PIC 的 `irr/isr/imr` 三组**结构体内数组**整体挪成独立全局
       `g_pic_irr/g_pic_isr/g_pic_imr`（平坦地址读写），ISR 位置丢失的问题消失；
    5. `dev_tick`/`pic_raise` 里的 `|=`、`&=` 复合赋值一律拆成「读 → 改 → 写」；
    6. `cpu_if_enabled()` / `cpu_exc_pending()` / `pic_state_pack()` 三个访问器
       放进**拥有该状态的 TU**（cpu.c6 / dev.c6），跨 TU 只传值不传结构体指针。
    另外把 native 的 `[SNAP]` 挪到 `cpu_step()+cpu_deliver()` 之后（之前快照比
    wasm 早一条指令，导致大量假分叉）。

64. **当前 wasm 与 native 的对齐状态**：检查点快照对拍（`tests/wasm_snap.js`）
    - `150000000` 处 MATCH；
    - `154000000` 处 DIVERGE，首个差异是 **r0(RAX)**：native `fffea072` vs
      wasm `fffea070`（差 2 = 一条指令），PIC 状态已经一致；
    - 粗扫（步长 50M）显示 150M MATCH、200M 起 DIVERGE（flags 0x202 vs 0x246）。
    所以下一个待定位窗口是 **153M～154M**，下一步用步长 100k/1k 收缩即可
    （`node tests/wasm_snap.js 153000000 100000 154000000`）。
    另外：native 到 1 亿 5 千万条指令都还没有任何串口输出，内核第一次 printk
    在这之后，所以 `tests/wasm_boot_smoke.js` 的默认 8M 阈值太早，需按
    实际首次 printk 的位置调整（或直接跑 6 亿条对比）。

65. **本轮的关键根因：`dev_tick()` 被 `#if !defined(C6_WASM)` 圈掉了**。
    上面第 63 条为了补一个缺失的 `#endif`，把 `#endif` 写在了
    `if (g_m.halted) break;` 和 `if ((g_m.instructions & 0x3ffffu) == 0) dev_tick();`
    **之后**，于是这两句只存在于 native 构建里 —— wasm 的 PIT 从来不走、定时器
    中断从来不发。症状：wasm 一路跑（浏览器里到 1742M 条）却永远没有串口输出，
    而且所有寄存器/内存都对得上（因为 guest 只是拿不到中断）。
    发现方式：给 `pic_raise` 和 `dev_tick` 加独立全局计数器（`g_raise_cnt`、
    `g_tick_cnt`），打包进快照一起比对 —— native 是 585/585，wasm 是 **0/0**，
    一眼看出「根本没调用」。把 `#endif` 移回快照块之后（halted 判断和 dev_tick
    都在通用代码里），wasm 立刻开始正常工作：
    - 200M 条指令处 RIP 与 native 完全相同（`ffffffff81bb3ab5`）；
    - 600M 条指令处串口开始有输出：
      `[    0.693333] PCI: Fatal: No config space access function found`（66 字节）。
    这也说明前面为了定位而做的那些 wasm 结构体修复（§63）本身是对的，但
    真正让 wasm 停摆的是这一个预处理块的范围错误。

66. **wasm 已能跑内核到 5.9 秒，但还没走完 initramfs**。修掉 §65 之后：
    - 200M 条指令：RIP 与 native 完全相同（`ffffffff81bb3ab5`）；
    - 600M 条指令：串口 66 字节（只有 `PCI: Fatal: No config space access
      function found`）；
    - 900M 条指令：串口 924 字节，最后是
      `[5.903082] Warning: unable to open an initial console.` /
      `Failed to create /dev/root: -2` /
      `Kernel panic - not syncing: VFS: Unable to mount root fs`。
    已经排除的因素：
    - boot params 页（0x9000 起 256 字节）在 1000 条指令处 **完全一致**；
    - initrd 本体（0x06000000 起 3483113 字节）哈希一致（`760ac20854cfe6e4`）；
    - PIC/时钟状态一致。
    所以差异出现在 **200M～600M 之间**（native 在 560M 之前就已经打印了 5.7～5.9 秒
    的那些行，wasm 到 600M 还只有 66 字节 ⇒ 分叉早于 600M）。下一步：
    `node tests/wasm_snap.js 200000000 50000000 600000000`（约 15～20 分钟）
    定位到 50M 窗口后继续用 1M/10k/1 收缩；这已经是最后一段。

67. **钉到单条指令：第 229,031,550 条处 RDX 丢 bit 33，代码是 `shrd rdx,rdi,0x20`**。
    逐步收缩过程（都用 `tests/wasm_snap.js`，一次扫描一份 native 输出）：
    - 229M..230M 步长 1万 → 229,040,000 处 r0（RAX）native `ffffffff821bfa19` vs 0；
    - 229.030M..229.040M 步长 100 → 229,031,600 处 flags `246` vs `202`；
    - 229,031,500..229,031,600 步长 1 → **229,031,550**，RDX `21cf479ac` vs `1cf479ac`。
    该处反汇编（0xffffffff813f850a）：
    ```
    shrd rdx, rdi, 0x20    ; 双精度右移 32 位
    cmp  BYTE PTR [rbx], 0x2e
    ```
    `shrd` 的实现在 cpu.c6 的 `case 0xa4/0xa5/0xac/0xad`：
    `a = ((a >> cnt) | (b << (w - cnt))) & sz_mask(s);` —— 当 `cnt == 32`、`w == 64`
    时依赖 `b << 32`，而 wasm 里出现的症状正是「高 32 位里的一位丢失」。
    下一步（很短）：在快照里再加一个 `cur_rip`（当前执行的指令地址，native 用
    `g_m.cur_rip`），就能把「快照是执行前还是执行后」彻底对齐；然后给
    `shrd/shrd 32 位计数` 写一个几秒钟的 payload 单测（在 wasm 里 movabs 两个
    操作数 + shrd + hlt，读 RDX 对比），确认后端在 `b << (w - cnt)` 这种
    「变量位移」上的行为，再决定是改实现（例如 cnt==32 时走专门分支）还是
    绕开后端。

68. **`tests/wasm_shrd.js`：秒级复现 SHRD/SHLD 的 wasm 分歧**。
    用户要求「wasm 慢，TDD，用最快的方式验证修改」，所以把 §67 的分歧做成了
    秒级 wasm 单测（`node tests/wasm_shrd.js`，3 个用例，各 4~5 条指令）：
    ```
    FAIL shrd rdx,rdi,32: got=0x0              expect=0x000b3ca800000000
    FAIL shrd rdx,rdi,1 : got=0x1              expect=0x8000000000000001
    FAIL shld rdx,rdi,32: got=0x1f479acffffc900 expect=0x1cf479ac000b3ca8
    ```
    已排除的因素（都是秒级验证）：
    - `movabs rdi, imm64` 正常（读回 `0xffffc900000b3ca8`）；
    - 模拟器自己的 `shl rax,cl` 正常（63 → `0x8000000000000000`，32 → `0x100000000`）；
    - 把 `sreg` 从原始 modrm 字节算、把 `op_read` 提前到 `reg_read` 之前、
      把位移拆成独立语句、把 `w = (u64)s * 8` 改成逐档显式赋值 —— 都没修好。
    由此可以断定：分歧出在 **`b << (w - cnt)` / `b >> (w - cnt)` 这一半**
    （`a >> cnt` / `a << cnt` 是对的），即 wasm 后端对「移位计数来自另一个
    运算结果」的 64 位左/右移处理错误。下一步可以：
    - 用 `tests/wasm_shrd.js` 做二分（每次改完 10 秒出结果）；
    - 试把 `b << n` 换成 `b * (1ull << n)`（乘法一般不走移位路径），
      或对 `cnt == 32` 用两个 32 位字重新拼装；
    - 也可以让 SHRD/SHLD 走「结果由两次 32 位操作拼」的实现，完全避开变量移位。
    注意：`./build.sh test` 和 difftest 1236/1236 都是绿的 —— native 一直正确，
    只有 wasm 构建受影响，所以这条不会影响阶段 5 的验收。

69. **SHRD/SHLD 的 wasm 分歧根因（已修）：局部 u64 跨语句后低 32 位被清零**。
    用 §68 的秒级单测 + 新加的 `tests/wasm_payload_cmp.js`（同一段 payload 分别
    在 native 和 wasm 跑 N 条，比对 16 个寄存器/RIP/flags），做了系统探针
    （`/tmp/sh_*.bin`：shrd/shld 各取 cnt=0/1/31/32/33/63）：
    ```
    shrd c=32  native=0xddeeff0011223344  wasm=0x11223344          # b<<32 丢失
    shld c=63  native=0x4cd55de66ef77f80  wasm=0x4cd55de600000000  # b>>1 低 32 位丢失
    ```
    由反推可知 handler 里拿到的 `b` 是 `0x99aabbcc00000000` 而不是
    `0x99aabbccddeeff00` —— **低 32 位被清零**。进一步用临时导出
    `sim_dbg_shl/shr/bitshl/bitshr/loopshl` 验证：wasm 的移位原语本身完全正确
    （0..63 全部正确，只有 UB 的 64 位计数按 x86 掩码），所以问题不在移位，
    而在「`b = reg_read(...)` 存进局部 u64，之后跨语句使用」这个模式。
    修复：把 `reg_read(c, sreg, s)` **内联进 hi 半部分的表达式**，不再让源寄存器
    值跨语句存活。修完 13 个 shrd/shld 用例（`tests/wasm_shrd.js`）全过，
    快照扫描 229M–245M 的 17 个检查点全部 MATCH（修之前 229,031,550 处 RDX
    丢 bit 33）。
    这是 §10/§63 那类「c6 wasm 后端在跨语句存活和结构体指针上有问题」的又一例，
    规律补充为：**从函数调用拿到的 u64 不许存进局部变量后跨语句使用，要么当场
    用完，要么内联重调**。新增的 `tests/wasm_payload_cmp.js` 让这类问题可以在
    几秒内复现和验证。

70. **SHRD 修好后 wasm 与 native 一路同步到 9 亿条，VFS panic 消失**。
    - 快照扫描 245M–500M（26 个检查点，步长 10M）**全部 MATCH**；
    - `MAX_INSNS=900000000 node tests/wasm_boot_smoke.js`：
      ```
      insns=904917123 serial=133B
      [    0.696666] PCI: Fatal: No config space access function found
      [    5.979744] Problem loading in-kernel X.509 certificate (-129)
      ```
      与 native 在 900M 条处的输出**逐字相同**（连时间戳都一样），
      之前的 `VFS: Unable to mount root fs` panic 不再出现。
    另外修了 `tests/wasm_snap.js` 的一个工具 bug：检查点必须是步长的整数倍
    （native 的 `--snap` 按这个条件打印），起始点不是倍数时两边 key 集合不同，
    会误报「wasm 缺检查点」。现在自动对齐到 `ceil(START/STEP)*STEP`。
    剩下的事就是把 wasm 跑完剩下的约 20 亿条指令（到 userspace 的 `Run /init`
    和登录提示）；native 全程约 2100–2500 秒，wasm 同量级。

71. **卡了整轮的真凶：`hlt` 之后投递挂起中断没清 `halted`**。
    加 halt 诊断（最近 16 条 guest RIP 的环形缓冲）后，一次 native 长跑就看清了：
    ```
    [HALT] rip=ffffffff81c003f0 flags=46 cr3=3eea000 insns=2261778433 rsp=... exc=0 vec=48
    [RING] ... ffffffff81bb9ff4 ffffffff81bb9ffd ffffffff81bb9ffe
    ```
    对应的代码是内核 idle 的经典两指令：
    ```
    ffffffff81bb9ffd: fb    sti
    ffffffff81bb9ffe: f4    hlt
    ```
    而 `rip=ffffffff81c003f0` 正是 x86_64 Linux 的 IRQ0 入口桩
    （`endbr64; push 0x30; jmp common_interrupt`，`0x30 = IRQ0_VECTOR`），
    `flags=0x46` 说明 IF 已被中断投递清掉。还原出来的顺序是：
    1. `sti` 把 IF 置 1；`hlt` 让 `cpu_step` 置 `cpu.halted = 1`；
    2. 机器循环紧接着 `if (exc_pending) cpu_deliver()` 投递了这个挂起中断，
       中断帧压好、`rip` 指向 IRQ0 入口桩、IF 清 0；
    3. 但 **`halted` 没清**，下一轮循环看到「halted 且 IF=0」，按「永久停机」处理
       —— 于是整机停在 2,261,778,433 条指令处（这正好是旧日志 alpine12/13 里
       停住的同一个指令数）。
    修复只要一行：投递挂起中断时把 `g_m.cpu.halted = 0`（CPU 被中断唤醒了）。
    修完 native 一路跑过 2.26B 到 3.5B 不再停（输出仍是内核早期那两行，说明
    还在 boot/init 阶段）。

72. **wasm 跑满 60 亿条仍无 login，但 guest 确实进过用户态**。
    - 后台长跑（`/tmp/wasm_long.js`，每 100M 一条进度）：6,002,696,121 条指令、
      串口仍是 133B（内核早期那两行），没有 halt；
    - native `--sample --stopt=3000000000` 的 149 个采样点：全部 `cpl=0`，
      但 `cr3` 出现 4 个不同的值（0x3eea000 / 0x2434000 / 0x41c4000 / 0x4706000），
      `user_entries` 从 0 涨到 1324 —— 说明 **进程在跑、也确实 iret 回过 CPL3**，
      只是没走到打印 login 的那一刻；
    - 76/149 个采样点落在 IRQ0 入口桩 `ffffffff81c003f0` 上，这不是卡死，而是
      采样点位于「idle 快进后刚被定时器唤醒」的第一条指令，属于采样偏差。
    结论：模拟器与 guest 都没停，瓶颈是**吞吐**——约 150M 条 guest 指令才对应
    1 秒 guest 时间，而模拟器只有 0.85~2.6M 条/秒，于是 guest 时间只以实时的
    ~1% 前进。下一步方向（按收益排序）：
    1. 让 idle 快进直接跳到「下一次 PIT 到期」，而不是每次固定 0x2000
       （现在一次 idle 只推进 8.2µs guest 时间，且每次都要跑 dev_tick）；
    2. 把 `dev_tick` 的调用从「每 0x40000 条指令」改成「按 PIT 到期时间」；
    3. 评估给 wasm 侧也做同样的时间跳进（guest 时间推进对两边必须一致，
       否则快照对拍会分叉）。
    另外把 `[RING]` 的每指令两次写改成只在 `--sample` 时记录。

73. **idle 快进改为「跳到下一次 PIT 到期」，行为不变、墙钟快 12%**。
    原来 idle 分支每次固定 `tsc += 0x2000`（guest 时间只推进 8.2µs），现在
    读 `pit.count[0]` 一次跳到下一次到期，等于把「原本 32 次 idle 迭代」合成
    一次。验证行为没变的方式：同一份 guest 在 30 亿条处的 `user_entries`
    完全是 **1324**（改动前 sim80 与改动后 sim82 一致），快照 150M–155M 也
    全部 MATCH；墙钟从 ~1900s 降到 ~1673s。
    同时还查到 PIT 的节拍：`sim_pit_phase()` 显示 tick 约每 262144 条指令一次
    （mode 3、reload 周期 2^18），而 guest 每秒约 227M 条指令 ⇒ 相当于每秒
    866 次 tick；内核如果按 HZ=100/250 走，定时器中断比应有频率快 3–9 倍，
    这也解释了采样点里 51% 落在 IRQ0 入口桩、以及引导推进慢。
    下一步（下一轮）：把 PIT 的 tick 周期按「每条指令 = 1ns」折算到真实节拍
    （或反过来把 tsc 的推进速率按 HZ 校准），再跑 login；同时用
    `user_entries`/`cr3` 采样确认时间校准后 guest 是否真的继续推进。

74. **PIT 节拍实验：按真实 8254 时钟折算反而更慢，已撤回**。
    `sim_pit_phase()` 量到 tick 实际是「每 262144 条指令一次」（被 dev_tick 的
    调用周期量化），如果按「1 条指令 = 1 ns、8254 输入 1.193182 MHz
    ⇒ 1 PIT 时钟 ≈ 838 ns」折算，100Hz 应该约 1000 万条指令一次，现在的
    节拍快 ~38 倍。于是试了一版 `sub = delta / 838`（idle 跳进同步改成
    `count * 838`），结果同样跑 15 亿条：
    - 折算前：1452 次系统调用（nr 分布：close 139、ioctl 113、mmap 100、
      connect 80、socket 61 …）→ guest 已经在 userspace 跑 init 脚本；
    - 折算后：1236 次系统调用，反而更慢。
    说明 guest 的推进主要吃「tick 数」（超时/调度都按 jiffies），把 tick 拉慢
    等于把引导拉长。已完整回滚（`git status` 只剩未跟踪的 `build`）。
    结论：**不要再动 tick 频率**，提速要看别处（例如减少每条指令的解释开销、
    或对 wasm 侧做同样的时间跳进）。§73 的 idle 跳进保留。

75. **用户态 tty 写不到串口：先加计数器定位**。
    15 亿条处的 syscall 尾迹已经很像 getty/login：
    ```
    nr=59 execve … nr=158 arch_prctl … nr=16 ioctl(0, TCGETS/TCSETS/TCFLSH/TCSETSW)
    nr=20 writev(1, buf, 2)   nr=0 read(0, buf, 0x400)   ← 阻塞等输入
    ```
    但串口只出到 133B（内核早期那两行），而且 1.5B→1.6B 之间**没有任何新
    syscall**，说明进程卡在读 stdin。为了判断「用户态写 tty 到底有没有到达
    UART」，在 dev.c6 加了两个全局计数器（`g_ser_out_bytes`、`g_irq4_raises`），
    并在 native 的收尾行打印：
    `[c6sim] halted, instructions=… ser_out=… irq4=…`
    另外确认了固件本身没问题：`/tmp/fw_raw.bin` 和新打的 `build/firmware.bin`
    都带 `ttyS0::respawn:-/bin/login` 注入（mkfw.py 的 make_initrd 会改写
    inittab），initrd 是合法 cpio.gz。

76. **回归：`/init` 之后用户态写不到串口（15–22 亿条区间）**。
    证据链（native `--stopt=1.6e9/2.2e9`）：
    * `ser_out=133, irq4=0`：开机后**只有内核 printk** 的 133 字节进过 UART，
      用户态一个字节都没进，串口中断一次都没发。
    * 早前 `--sys` 尾迹：`execve(sh) → ioctl(0,TCGETS/TCSETS) → writev(1,2) →
      read(0,0x400)`，且 1.5B→1.6B **无新 syscall**：进程卡在 read，说明
      writev 已经返回（syscall 序列继续了），只是那 2 字节没到 UART。
    * `loglevel=7` 到 6.29s：`Run /init as init process` ✓、`serial8250: ttyS0
      at I/O 0x3f8 (irq = 4) is a 8250` ✓（ttyS0 驱动注册成功）。
    * 自造 `/init` 变体（raw-initrd 打包）：
      - 首句 `exec >/dev/ttyS0` → PID1 退出 → `Kernel panic: Attempted to
        kill init!`（说明脚本确实在跑，且 `/dev/ttyS0` 那时还不存在）；
      - 首句改成 `echo INIT-START > /dev/console`（内核会给 rootfs 建
        /dev/console 5:1）→ 22 亿条内**标记一个都没出现**，也无 panic。
    对照 `build/login.log`（11-25 09:55 的旧构建，同一固件）：
    ```
    [ 5.979744] X.509 ...
    can't run '/sbin/openrc' ×3
    (none) login: root
    ```
    可见旧构建里 `/init` 的 mount + inittab 改写 + `exec /sbin/init` 全都正常。
    **结论：这是 11-25 之后模拟器的回归**，最可疑的是中断/HLT/idle 那批改动
    （`c4e956c` hlt 投递清 halted、`1b0e6e0` idle 跳 PIT、`8290901` dev 重构），
    而不是固件或内核。
    下一步定位手段（按代价排序）：
    a. 给 `--sys` 加**返回值**打印，看 `mount`/`write` 是否返回、返回什么；
    b. 统计 8250 **所有寄存器**的读写次数（尤其 THR 之外的 `start_tx` 触发点）；
    c. 用 git 历史重建旧构建做二分（每次约 25 分钟）。

77. **根因与修复：16550 的 THRE 是电平中断，写 IER 时必须重新拉 IRQ4**。
    上一节的回归其实是**一直存在的建模缺陷**（11 个历史构建逐个并行验证，
    含 login.log 时代的 `e2e2065`，全都失败，所以不是近期改动引入的）：
    * 计数器证据（22 亿条）：`wr[1]=19`（IER 写了 19 次）、`ier=7`（RX+THRE+
      line-status 全开）、`wr[0]=135`（THR 只在开机阶段写过），但 `irq4=0`。
    * Linux 的 `serial8250_start_tx()` **只负责把 `UART_IER_THRI` 置上就返回**，
      真正的字节搬运在 THRE 中断处理函数里做；8250 的 THRE/RX 都是**电平**
      语义，使能后就该立刻再断言一次中断。
    * 我们的模型只在「写 THR」时 `pic_raise(4)`，于是驱动使能 THRI 后再也
      等不到中断 → 用户态第一次 `write()` 永久阻塞 → `/init` 卡死。
    修复（`src/dev.c6` 的 `serial_write`，case 1）：
    ```c
    case 1:
        g_m.serial.ier = v;
        if ((v & 2) && (g_m.serial.lsr & 0x20)) pic_raise(&g_m, 4);   /* THRE */
        if ((v & 1) && (g_m.serial.in_head != g_m.serial.in_tail)) pic_raise(&g_m, 4); /* RX */
        break;
    ```
    `serial_feed()` 里本来就会在 `ier & 1` 时拉 IRQ4，保持一致。
    验证：标记 `/init`（`echo INIT-START > /dev/console` 打头）在 17 亿条内
    依次打出 `INIT-START` / `M-PROC` / `M-DEV`，`ser_out=322 irq4=194`；
    标准固件 26 亿条时串口上出现 **`(none) login: `**（重复是因为没喂输入，
    login 读到 EOF 就退出被 respawn，属正常）。
    回归验证：`./build.sh test` 五项全过、`difftest 1236/1236`。

78. **修复后 native 登录验收重新 PASS（当前构建）**。
    `SIM=build/sim TIMEOUT=4200 python3 tools/boot_login.py` →
    ```
    [boot_login] saw login: sent 'root'
    [boot_login] shell prompt seen, sent 'uname -m'
    PASS: Alpine booted to login and ran 'uname -m'
    ```
    `build/login.log` 里对应：
    ```
    (none) login: root
    Welcome to Alpine!
    login[444]: root login on 'ttyS0'
    (none):~# uname -m; echo MARK-OK
    x86_64
    MARK-OK
    ```
    同时 `./build.sh test` 五项全过、`difftest 1236/1236`。

79. **wasm 侧跑到登录并执行命令（Node 驱动）**。
    新增 `tests/wasm_login.js`（与浏览器同一套 wasm 导出，不依赖浏览器）：
    分块 `sim_run()`、抽串口、看到 `login:` 就 `sim_serial_in('root\n')`、
    看到 shell 提示符再发 `uname -m; echo MARK-OK`。
    ```
    [wasm_login] 926s insns=799091640 看到 login: → 发送 root
    [wasm_login] insns=1193991187 text=713B loops=444 用时=1068s
    WASM LOGIN OK (MARK-OK)
    ```
    串口尾部：
    ```
    login[444]: root login on 'ttyS0'
    (none):~# uname -m; echo MARK-OK
    x86_64
    MARK-OK
    ```
    顺带修了 `tests/wasm_boot_smoke.js` 的误判：`sim_run()` 返回 0 只代表
    「这一块没跑满 count」（idle/hlt 快进、异常投递都会这样），不能当永久
    停机；只有 `sim_halt_info() != 0` 才是真停机。

80. **浏览器（headless Chromium + wasm）登录并执行命令 —— PASS**。
    `MAX_SECONDS=9000 CHUNK=2000000 node tests/browser_alpine.js`：
    ```
    [alpine] 看到 login: → 发送 root
    [alpine] 看到 shell 提示符 → 发送 uname -m
    [alpine] 用时 1064s，指令 888M，串口 713 字节
    [alpine] 登录并执行命令成功: MARK-OK
    [alpine] wasm 跑 Linux/Alpine 通过
    ```
    `build/browser_alpine.log` 尾部：
    ```
    login[444]: root login on 'ttyS0'
    (none):~# uname -m; echo MARK-OK
    x86_64
    MARK-OK
    ```
    排查过程中修掉的两个**测试脚本** bug（都不是模拟器问题）：
    1. `sim_serial_out(ptr, cap)` 的第一个参数是 wasm 线性内存里的地址，
       脚本却把 JS 的 `Uint8Array` 传了进去 → 被强转成 0，把 wasm 自己的
       全局数据写坏（现象：页面里 guest 跑到一半停滞、串口全是 `\0`、
       `text` 长度在涨但内容不可读）。改为 `sim_serial_out(0x0f800000, 64K)`
       并用 `new Uint8Array(w.memory.buffer, 0x0f800000, n)` 读。
    2. `sim_run()` 返回 0 只代表「这一块没跑满 count」，不能当永久停机；
       只有 `sim_halt_info() != 0` 才是真停机。

81. **TLB 命中率为 0 —— 每条指令都在走四级页表（性能根因之二）**。
    现象：`--payload` 的 tight loop 只有 0.32M 条/秒（`add rax,1; cmp; jne`
    10M 条 31 秒）。加计数器后一目了然：
    ```
    [TLB] hits=0 walks=20000002 mt=20006761
    ```
    **每次 mem_translate 都 miss**。两个错误叠加：
    1. 4 KiB 页填充时写死 `flags = TV_P | TV_U | TV_X` —— 等于把所有页
       都标成「可执行」也就罢了，而命中判断当时写的是
       `(user != 2 || !(flags & TV_X))`，取指要求 **没有** TV_X，正好相反；
       于是取指永远不命中（数据访问因为不看 TV_X 反而能命中）。
    2. 1 GiB / 2 MiB 大页填充把 `TV_U` 也写死，导致内核页在 CPL3 下可以
       靠 TLB 命中华丽地绕过 U/S 检查（正确性隐患）。
    统一语义后（`TV_X` = 可执行，`TV_U` = 用户可访问，都按 PTE 位来）：
    ```
    [TLB] hits=20000001 walks=1
    ```
    同一段 payload 的前后对比（10M 条）：
    | payload | 修复前 | 修复后 | 提升 |
    | --- | --- | --- | --- |
    | `jmp $` | 34.7s | 10.3s | 3.4× |
    | `nop; jmp` | 28.5s | 8.7s | 3.3× |
    | `add/cmp/jne` | 31.1s | 14.8s | 2.1× |
    整机引导到 `login:` 的墙钟几乎没变（native ~900s、wasm ~1105s）：内核
    代码/数据都在高半区，`mem_translate` 走的是 direct-map 快捷返回，本来就
    不查 TLB；真正受益的是**低地址的用户态代码**（init 脚本、payload、差分
    测试），`difftest 1236/1236` 与 `build.sh test` 五项全过，native/wasm
    登录验收也重新 PASS。
    INVLPG 目前是「整 TLB 刷新」（保守但正确），CR3/LMSW 写入同样刷新，
    所以打开真实 TLB 缓存不会踩到陈旧映射。

82. **解释器提速三件套（a/b/c）**。v1.0.1 修完 TLB 之后，native 每指令仍需
    ~1.3µs。先用**指令频率剖析**（临时构建，在 `step()` 里按 opcode 计数、
    跑 2 亿条真实引导）拿到真实分布：
    ```
    89 mov 11.6%  90 nop 4.0%   31 xor 11.8%  8d lea 3.0%  c1 shift 7.1%
    01 add  8.9%  8b mov 6.6%   e9 jmp 2.6%   83 group1 3.6%  c3 ret 2.1%
    70..7f jcc 7.0%  e8 call 2.3%  63 movsxd 2.4%  0f 1e endbr64 2.1%
    ```
    于是按「先量再改」落了三类改动，每类都单独用 `difftest 1236` 兜底：

    **(c) 页表快通道**。`mem_translate` 的固定开销摊在每条指令上（取指至少
    一次、数据操作若干次），外面还套着 `mem_fetch8/mem_r*/mem_w* → phys_r*`
    两层调用。最终实现是 `pg_fast()`：**逐行复刻** `mem_translate()` 的前半段，
    顺序完全一致（未开分页 → direct map → 高半区 → TLB 命中），不命中返回
    `PG_FAST_MISS` 让调用方原样落回慢路径。**不额外持有任何翻译状态**，失效
    仍然只由 `mem_tlb_flush()`（INVLPG / 写 CR3 / LMSW / 复位）负责。
    这里一开始写的是「独立页缓存」（1 项取指 + 8 项直接映射数据），实测快
    24%，但语义上无法保证与慢路径一致，整机引导在 init 起来后必崩；教训见
    §83。当前形态没有这份风险，代价是只省下 6%（引导 60M：85.6s → 80.2s）。

    **(b) 分派分派链重排**。`c6c` 把 `switch` 编成按**源码顺序**的比较链（实测把
    `case 0xeb` 从第 235 个位置挪到最前面，`jmp $` 循环 5M 条从 5.59s 降到
    4.16s，证明比较链就是成本）。于是按剖析频率把主 switch 的 55 个 case 块
    重排（`0x89/0x8b`、`0x90-0x97`、`0x8d`、`0xc0-0xd3`、`0x70-0x7f`、`0xe9`、
    `0xc2/0xc3`、`0x63`、`0xe8` 依次提前），`0x0f` 二级 switch 同样重排
    （`0x1e` endbr64、`0xb6/0xb7` movzx、`0x84/0x85` jcc rel32 提前）。
    每块都是完整的 `case ...: break;` 单元，整块搬移，语义不变。

    **(a) 热指令快通道**。在 `step()` 取完 opcode 之后、进主分派之前，先处理
    「高频且不会缺页」的几种形态：`nop`、`MOV r,r`（mod=3）、`Jcc rel8`、
    `JMP rel8/rel32`。命中直接返回，省掉 ALU 判别和一整条比较链；不命中则
    原样落回主路径。刻意**不**把 push/pop/call/ret 放进快通道——它们会写栈、
    可能缺页，需要保留故障回退语义。快通道的**每一个出口都必须走
    `fast_done(c, start)`**（复刻 `step()` 尾部的故障回滚），否则跨界取指
    缺页时 RIP 会停在半路，内核重试到错地址（§83）。

    最终实测（5M 条 tight loop / 6000 万条真实引导，空载机器上各测两轮取低值）：

    | 负载 | v1.0.1 | v1.0.2 | 提升 |
    | --- | --- | --- | --- |
    | `jmp $` | 6.19s | 4.60s | **1.34×** |
    | `nop;...;jmp` | 4.43s | 3.74s | **1.18×** |
    | `add/cmp/jne` | 10.03s | 8.85s | **1.13×** |
    | 引导 60M 条 | 87.3s | 80.5s | **1.08×** |

    独立页缓存的版本曾经测到 1.76× / 1.44× / 1.26× / 1.31×，但语义上与慢路径
    不等价（§83），已弃用；现在这份是「牺牲加速换确定性」后的数字。

    另外两个小坑：
    - 一开始把热通道写成「先判 op==0x89/0x8b 再 peek modrm」，整机引导反而慢
      3.5%（每个 mov 都多一次取指，而引导里 mov 多是内存形态、命中不了快通道）,
      最后靠 A/B 实测收窄到四种形态才转正。
    - 给页缓存写静态初始值会让 **c6/tcc 的 wasm 链接器**把后面 128 MiB 的
      客户机 RAM 一起铺进数据段：`sim.wasm` 从 1.1 MiB 涨到 **135 MiB**。这条
      经验对现在这份（无静态缓存）不适用，但换成任何「静态 + 初始值」的加速
      结构时要先看 wasm 体积。

83. **性能改动踩的两个「语义等价」坑（v1.0.2）**。三件套里 (b) 是把 case 块
    整块搬移（结构校验：143 个 case 块的标签组与内容与重排前逐一相同，纯排列），
    (a)(c) 改了执行路径，各踩了一个坑，共同点都是**快路径与慢路径给出了不同
    结论**：

    **(1) 页缓存要么不持状态，要么必须与慢路径严格同序。** 第一版用独立页
    缓存（1 项取指 + 8 项数据直接映射），接连两个后果：
    - 缺页时 `mem_translate` 返回 0，缓存却把「翻译失败」登记成「物理页 0 +
      全权限」，之后该 vpn 既不缺页、又读写错页 → 整机引导直接 kernel panic
      （`note: init[1] exited with irqs disabled` / `Fixing recursive fault`）。
      修法：填表先判 `fault_abort`，且只给「TLB 里拿得到权限」或「未开分页 /
      direct map / 高半区」三种已知来源登记。
    - 改成内联后把 TLB 判断放在了 direct map / 高半区三条快捷路径**之前**，
      于是同一地址「快路径走 TLB、慢路径走快捷路径」；direct map 上只要存在
      陈旧 TLB 项（旧 vpn 的项），两者就给出不同物理页。症状是 CPL3 取指
      `va=0` 命中缓存、而慢路径本该缺页 → init 收到 SIGSEGV → `Attempted to
      kill init! exitcode=0x0000000b`，且 oops 里 `ip == fault address`（说明
      是跳到了野地址）。用 `--cachecheck`（每次快路径命中都与慢路径对拍）
      一条就抓到现场：`[CC] CPL3 hit but slow path faults: va=0 wr=0`。
    最终形态 `pg_fast()`：不改任何状态、四条判据与 `mem_translate` 同序，
    不命中返回 `PG_FAST_MISS` 交回慢路径；`--cachecheck` 跑完 9 亿条整机引导
    无一处分歧。代价是加速从 24% 回落到 6%。

    **(2) 热指令快通道不能绕过 `step()` 尾部的故障回滚。** 快通道命中后
    `return 0` 提前返回，跳过了尾部
    `if (c->exc_pending && !trap_exc && !c->exc_async) { c->rip = start; ... }`。
    只要指令的 modrm / 立即数跨页落在未映射页上（页尾的那条指令），RIP 就会
    停在半路，内核修好页表后重试到错误地址 → init 跳到野地址 → kernel panic。
    修法：所有出口统一走 `fast_done(c, start)`；快通道不碰 RSP/RSI/RDI/RCX，
    所以只回滚 RIP 就够。

    **排查方法（后面复用）**：
    - 运行时开关 `--nofast / --nofetch / --nodata`，先用耗时差确认开关真的
      生效（实测 +0.7% / +32% / +23% / 全关 +54%）；
    - 验收点用 **9 亿条整机引导**，不要用 6000 万条：60M 只走到 guest 0.69s，
      三件套的分歧要到 init 起来（约 8 亿条、guest 6.2s）才暴露；
    - 用四象限（(a) 开/关 × (c) 开/关）把责任落到具体一件，再用
      `--cachecheck` 抓第一处现场；对拍比逐条断点快两个数量级。

84. **v1.1 性能：把每指令开销压下去，再让宿主 cc 接管代码生成**。
    v1.0.2 之后瓶颈已经不在算法而在 **c6c 的代码生成**：它不做内联、不做寄存器
    分配，`step()` 的每个局部变量/临时量都落在栈槽里，一条 guest 指令要几千条
    宿主指令。实测（`taskset` 固定核 + `perf stat -e instructions:u`）：
    20M guest 指令整机引导 **121.9G** 条宿主指令 / 27.4s，其中 6.4G 是
    `machine_reset()` 逐字节清 128MiB RAM、5.5G 是 `machine_boot()` 用
    `mem_w8()` 一个字节一个字节搬 34MiB 固件 —— 这两笔是**每次启动都付**的。

    1. **启动路径**（对短负载收益最大）
       - `g_m` 在 BSS 里本来就是 0：`machine_reset()` 首次调用直接跳过整块清零，
         后续（reboot）才按 4 字节块清；4 字节而非 8 字节是照顾 wasm32 指针。
       - 固件加载不再走 `mem_w8`：内核/initrd 落在 0..128MiB 恒等映射区，
         直接按 4 字节块拷进 `g_m.ram`。语义不变（同一物理地址、同一字节序）。
       - 结果：进程启动从 **6.4G 条宿主指令降到 390 万**；20M 引导总指令数
         因此直接少掉约 12G。
    2. **解释器热路径**（对长负载有效）
       - `mem_fetch8/mem_r*/mem_w*` 里 `pg_check -> pg_fast -> phys_*` 四层真实
         函数调用展开成宏 `TR_PA` + `RAM_R8/R16/R32/R64` + `RAM_W16/32/64`。
         `TR_PA` 与 `mem_translate()` **同序**：未开分页 → direct map →
         `0xffffffff80000000`/`0xffffffff00000000` 两窗口 → TLB → 慢路径；
         三个窗口按实测命中率排序。`--cachecheck` 仍然逐次对拍。
       - `PREFIX_TAB[256]` 取代 10 条比较的前缀循环；`PARITY_TAB[256]` 取代
         8 次移位循环；`SZ_MASK_TAB`/`SIGN_BIT_TAB` 取代比较链
         （**注意**：旧实现对 1/2/4 以外的宽度一律返回全 1 / bit63，表里照抄，
         否则 SSE 路径用 `s==0` 调 `sz_mask()` 会被清零 —— 这个坑在 difftest
         的 `sse movq/pshuflw/pshufhw` 三条上现形）。
       - `PRE_*`/`RF_*`/`CR0_*`/`TV_*`/`TLB_SIZE` 等常量宏全部改成字面量：
         `(u64)1 << n` 在 c6c 里会生成 movabs+shl 序列。
       - 取指窗口/每指令 16 字节缓冲**试过但没用**（89.1G vs 87.4G，且依赖
         `memcpy` 的字节循环实现），最终没有保留。
       - `main.c6` 改成不用 `defer/errdefer/try/catch/f-string` 的朴素写法，
         单 TU 可以 `-c` 编译，也能被 `--emit-ctu` 吃下。
    3. **构建路径**：`./build.sh native` 默认走
       `c6c --emit-ctu`（每个 TU 出一个 C）→ 系统 `cc -O2` → 链接。
       同一份 C6 源码，宿主 cc 有寄存器分配，20M 引导 **6.41G 条 / 0.95s**
       （自举路径同负载 72.4G / 16.7s；wasm 走 tcc-c6，同负载 46.1s → 28.2s）。
       稳态（100M 条引导）的宿主指令数：121.9G/20M 那种启动摊薄消失后，
       v1.0.2 **640.9G**、自举 **444.8G**（1.44×）、默认 **36.6G**（17.5×）。
       到 login 的 900M 条墙钟（同机顺序实测）：v1.0.2 1203s、自举 998s、
       默认 **56s**；三种构建串口输出逐字节一致。
       三处必要的就地修正（都在 `build.sh` 的 `ctu_fixup()` 里，有注释）：
       - c6c 的 `<stdio.h>` 把 `stdin/stdout/stderr` 定义成 `(FILE *)0/1/2`
         魔法指针（c6c 运行时认这三个值，glibc 的 `fflush` 会段错误）→
         在 emit 出来的 C 里换成真正的 `stdout/stderr/stdin` 并补 extern；
       - `main.c6` 不用 `<poll.h>`（c6c 没有这个头，会落到系统 glibc 头，
         `struct timespec` 和 c6c 自带 `<sys/stat.h>` 重定义），自己声明
         `struct pollfd` + `poll()`；
       - wasm 构建必须继续走 tcc-c6：`cpu/dev/boot/machine` 的 `<stdio.h>`
         用 `#if !defined(C6_WASM)` 包起来（tcc-c6 的 wasm 后端遇到这个头会
         生成非法 wasm），并且 `fetch8()` 里**不能**用 `c->rip`，必须
         `g_m.cpu.rip`（§10 的指针参数偏移 bug）。
       自举路径保留为 `C6_PURE=1 ./build.sh native`，用于验证「C6 源码本身」
       的正确性与可移植性。
85. **编译器选项：-O2 是实测最优，-O3 反而更慢**。同一份 `--emit-ctu` 产物上
    逐个试过（100M 条整机引导，`perf stat -e instructions:u` + 墙钟 best-of-3）：

    | 选项 | 宿主指令 | 墙钟 |
    | --- | --- | --- |
    | `-O2`（采用） | 36.57G | 5.10s |
    | `-O3` | 37.23G（+1.8%） | 5.17s |
    | `-O2 -march=native` | 6.42G@20M（比 -O2 的 6.41G 略差） | 0.838s@20M |
    | `-O2 -flto` | 36.11G（−1.3%） | 5.31s |
    | `-O2` + PGO（200M 采样） | 35.41G（−3.2%） | 5.18s |
    | `-O2 -fno-stack-protector` | 与 -O2 相同 | — |

    `--emit-ctu` 出来的 `step()` 是一个巨大的 switch + goto 热循环：
    -O3 多做的循环展开/矢量化把热循环撑大，I-cache 和分支预测都变差，
    20M 处指令数 +2.4%、100M 处 +1.8%；`-march=native` 不改变代码结构，
    没有收益。LTO 能跨 TU 内联一点（指令数 −1.3%），但代码布局变差、墙钟更慢。
    PGO 只有 ~3% 收益，却需要「拿 34MB 固件跑一遍采样」并维护随源码变化的
    profile 数据，不划算。结论：默认 `-O2`，需要时用 `OPT="-O3" ./build.sh
    native` 覆盖。

86. **交互串口终端**：native CLI 在 stdin 是 tty 时把宿主终端切到 raw。
    `struct termios` 和 `tcgetattr/tcsetattr` 是手写声明（glibc x86-64 布局，
    实测 `sizeof` 60），因为 `#include <termios.h>` 会让系统头和 c6c 的
    `<sys/stat.h>` 抢 `struct timespec`，`--emit-ctu` 路径编不过 —— 和
    `<poll.h>` 是同一个坑（§84）。不开 raw 时两个问题在真终端上都能复现
    （用 `script -qec` 分配 pty 验证过）：
    - 宿主终端的行规程回显 + guest 的串口回显 → 每条命令显示两遍；
    - busybox ash 每个提示符发 `ESC[6n` 问光标位置，真实终端的应答
      `ESC[24;11R` 被行规程回显到屏幕上，还会插进正在编辑的命令行
      （`(none):~# ^[[24;11Rls ...`，这条命令就废了）。
    现在关掉 `ISIG`（Ctrl-C 原样进 guest），退出用 `Ctrl-]`（0x1d，只在
    raw 模式下生效）；输入路径上再过滤 `ESC[数字;数字R` 这条应答（方向键等
    其它 ESC 序列原样转给 guest）；正常退出（Ctrl-] 或机器 halt）时
    `tcsetattr` 恢复原设置。

87. **SSE 浮点：借宿主浮点，不自己写软浮点**。`top` 一跑就 `Illegal
    instruction`，`--udtrace` 追下去是 musl/busybox 在算 `%f`：先是
    `comisd`（`66 0f 2f`），补完又依次缺 `cvttsd2si`（`f2 0f 2c`）、
    `cvtsi2sd`（`f2 0f 2a`）、`subsd/mulsd`（`f2 0f 5c/59`）……本质是这台
    机器**一条浮点指令都没实现**。
    关键发现是 c6 语言本身支持 `double`/`float`（`c6c` 自举路径也能跑对
    `1.0/3.0`），所以不需要在整数上造软浮点：xmm 的位型用 union 转成宿主
    `double`/`float` 算完再转回来，NaN、±0、次正规数、就近偶数舍入全部由
    x86-64 的 SSE2 指令保证，和真机一致。实现落在 `cpu.c6` 的
    `fp_d_get/fp_d_put/fp_f_get/fp_f_put`、`fp_d_bin/fp_f_bin`（+ - * / 和
    sqrt，sqrt 用牛顿迭代到 1ulp，不链 libm）以及 `sse_fp_cmp/i2f/f2i/bin/cvt`
    五个指令体，覆盖 `ucomiss/ucomisd`、`cvtsi2sd/cvtsi2ss`、
    `cvttsd2si/cvtsd2si`、`add/sub/mul/div/sqrt`（ss/sd/ps/pd 四种宽度）、
    `cvtss2sd/cvtsd2ss/cvtps2pd/cvtpd2ps`。`0x2d`（按 MXCSR 舍入）与
    `sqrt` 的末位、MXCSR/FXSAVE 仍不建模，够 printf/top 用。
    这些指令体都抽成独立函数，**不能**内联进 `step()`：tcc-c6 的 wasm 后端
    对单函数 local 数有上限，早先直接写进 case 里会让 `web/sim.wasm` 过不了
    `WebAssembly.validate`（`local count too large`）。

88. **`movsd/movss` 的窄宽度**（顺手修掉的内存踩踏）：`f2/f3 0f 10/11` 是
    `movsd/movss`，只动低 64/32 位，载入时高位清零；旧代码把它们和
    `movaps/movups` 一样当 16 字节搬，**存储时会多写 8 字节**，直接踩坏
    guest 内存。浮点代码一多（musl 的 `printf` 到处 `movsd`）这个 bug 就会
    放大，所以和 §87 一起修。

89. **x87 FPU：整套协处理器 + 80 位精度的取法**。SSE 补完 `top` 能跑之后，
    浮点还剩“真·x87”这一半：musl 的 `strtod`（十进制解析）和 `printf` 的
    数字生成走的是 `long double` + x87 指令（`fld/fstp tbyte`、`fild/fistp`、
    `faddp/fmulp/fsubp/fdivp`、`fucomi`、`fldcw`…），一条不认就 `#UD`，认错
    一个就是错数。实现落在新增的 `src/fpu.c6`（约 1100 行），`cpu.c6` 的
    `D8..DF` 逃逸码只负责取 `modrm` 再转给 `fpu_op()`：

    - **栈**：`st[8]` + `ftop`，`fpu_idx(i)=（ftop+i)&7`；`push` 把 `ftop`
      减一、`pop` 加一，`fxch/ffree/fdecstp/fincstp` 按 SDM 语义。
    - **存取**：`m32fp/m64fp/m80fp/m16int/m32int/m64int` 六种宽度全支持，
      `fld tbyte/fstp tbyte` 直接对 80 位位型做拼接（§精度取法见下）。
    - **四则/比较**：`fadd/fsub/fsubr/fmul/fdiv/fdivr` 的 ST(i) 与内存两种
      形式、带 `p` 的弹栈形式；`fcom/fcomp/fcompp/fucom/…/fcomi/fcomip/
      fucomi/fucomip/ftst` 把结果同时写 `fpsw` 的 C0/C2/C3 和 RFLAGS 的
      CF/PF/ZF。
    - **一元/常量/超越**：`fld1/fldz/fldpi/fldl2t/fldl2e/fldlg2/fldln2`、
      `fabs/fchs/fsqrt/frndint/fscale/fprem/fxtract`、`f2xm1/fyl2x/fyl2xp1/
      fpatan/fsin/fcos/fsincos/fptan`（超越函数用自写级数，不链 libm）。
    - **控制/状态字**：`fldcw/fnstcw/fnstsw/fninit`，`fpsw` 的 top 字段跟着
      `ftop` 走。

    **精度取法（关键决策）**：c6c 自举路径把 `long double` 当 `double`
    （实测 `1.0L/3.0L` 出来就是 53 位尾数的位型），但 `c6c --emit-ctu` 生成的
    是**真正的 C**，`long double` 交给宿主 `cc` 就是 x86 的 80 位扩展精度。
    所以 `c6sim.h` 里给出
    `fpu_real = long double`（默认）/`double`（`C6_PURE` 与 `C6_WASM`），
    `st[8]` 用 `fpu_real`：默认构建下 `fadd/fmul/fdiv/fsqrt` 直接**吃宿主的
    x87 扩展精度**，64 位尾数、就近偶数、80 位 m80 布局全部和真机一致；
    `fld tbyte/fstp tbyte` 在默认路径就是按位搬（`union { u64 w[2]; fpu_real v; }`），
    自举/wasm 路径才回退到手工 double ↔ 80 位换算。这一步是必须的：
    musl 的十进制转换按 64 位尾数写，53 位尾数会让 `0.1` 解析成
    `0.099999999999994315`、`%.6g` 把 `22/7` 印成 `3.14285`。

    **舍入模式**：`fistp/fist/frndint` 必须按 `cw` 的 RC 位走。musl 的数字
    生成会 `fldcw` 临时切到 RC=3（向零）再 `fistp` 取整数位；只做就近偶数
    会让残差符号翻转，循环里的值越滚越大，最后 `fistp` 撞出整数不定值、
    `-inf`、死循环写爆栈 —— 这就是 `awk 'BEGIN{print 22/7}'` 段错误的根因。

    **fsqrt**：80 位精度用 `fpu_real` 牛顿迭代（种子取宿主 `sqrtsd`），
    SSE 的 `sqrtsd` 仍用 double 版，并按“精确中点比较”（64×64→128 整数乘法）
    修正到正确舍入，difftest 的 `fsqrt` 用例比的是内存哈希，差一个 ulp 就挂。

    **验证**：`tools/difftest` 那套 blob 直接和本机 CPU 对拍 x87（同一段
    机器码分别跑模拟器和真机、比寄存器和数据页哈希）——`faddp/fmulp/fdivr/
    fsubr/fild/fistp/fcomip/fnstsw/m80 往返/fsqrt` 全过，且把 musl 那个
    “每轮乘 1e9 取 9 位数字”的循环原样搬过来跑 39 轮，命中值与真机逐位相同。
    guest 里 `awk` 的 `0.1`、`0.1+0.2`、`22/7`、`sqrt(2)`、`printf "%.17g"`
    均与真机一致，`top -b -n1` 正常。

90. **其余 SSE 浮点：min/max、比较谓词、shuffle/unpack、movmsk、rcp/rsqrt、
    打包转换**。补 `top` 那条链之后剩下的 SSE1/SSE2 浮点面，全部按 SDM 的
    边角语义实现：
    - `minss/minsd/minps/minpd`（`5d`）与 max（`5f`）：**两边都是 NaN、或
      两个都是零（含 `+0/-0` 混搭）时返回第二操作数**；这是 SSE 与 C 的
      `fmin/fmax` 的区别，写成 `a < b ? a : b` 会把 `-0/+0` 取反。
    - `cmpss/cmpsd/cmpps/cmppd`（`c2` + imm8）：谓词 0..7，反身谓词
      （`NLT/NLE/NEQ`）对 NaN 返回真，`ORD` 对 NaN 返回假；每通道生成
      全 1/全 0 掩码。
    - `shufps/shufpd`（`c6`）、`unpcklps/unpckhps/unpcklpd/unpckhpd`
      （`14/15`）：立即数选通道、按 32/64 位通道交错。
    - `movmskps/movmskpd`（`50`）：符号位压进 GPR 低位（32 位写，高位清零）。
    - `cvtdq2ps`/`cvtps2dq`/`cvttps2dq`（`5b`）：`cvtps2dq` 的“就近偶数”
      复用 x87 的 `fpu_rnd_dir(v,0)`（导出成 `x64_rnd_ne`），越界/NaN 写
      `0x80000000`；`cvttps2dq` 用截断。
    - `rsqrtps/rsqrtss/rcpps/rcpss`（`52/53`）：**算精确值**（1/x、
      1/sqrt(x)）而不是硬件的 12 位近似。SDM 只要求相对误差 ≤ 1.5·2⁻¹²，
      精确值满足这条，程序也不能依赖某个具体近似值；代价是 difftest 里这
      四条与真机逐位不同（其余新指令 1553/1553 逐位相同）。
    **注意**：这些函数都单独成函数、不内联进 `step()`，理由同 §87
    （tcc-c6 的 wasm 后端有单函数 local 上限）。

91. **交互终端的两个"卡死/错位"：8259 指定 EOI 与 ash 的光标查询**。
    v1.1 收尾时 guest 里出现两个怪现象：控制台输出写一会儿就停在一行中间
    （`top` 只画一帧、不再刷新），以及登录后提示符/输入老是"往后追加"。

    **（a）控制台写永久阻塞**。用 `--sys` 看 guest 的最后一次系统调用是
    `writev(1, ...)`（musl 的 stdio flush），之后没有任何系统调用；再用
    RIP 环 + `System.map` 符号化，停机时 CPU 在 idle 里，说明有任务卡在
    内核态的写里。最后用 EOI 直方图定位：guest 的 8259 驱动**只发指定
    EOI**（`OCW2 = 0x60|irq`，实测 14580 次全是这种，非指定 0 次），而
    `pic_write()` 以前不看低 3 位，一律"清最低的置位位"。定时器（IRQ0）
    和串口（IRQ4）同时在服务时，`EOI(4)` 清掉的是 IRQ0 的服务位，IRQ4
    永远留在 ISR 里；投递条件 `irr & ~isr & ~imr` 之后恒为 0 —— **IRQ4
    再也不投递**。串口驱动的 tty 写就永远等不到"发送完成"的唤醒。
    修法：指定 EOI 只清本片 `v & 7` 那一位（从片写 0xA0 就清从片），
    非指定 EOI 才清最高优先级的在服务位。

    同时把串口的 RX/THRE 改成**电平**语义（`dev_tick()` 里每次设备轮询
    把电平重新拉进 IRR）。只补边沿还会丢另一种中断：驱动一批
    `tx_loadsz` 写完之后 THRI 仍然开着，tty 层再排数据进来只调
    `start_tx`，而 `start_tx` 看到 THRI 已置位就不再写 IER —— 边沿没了。
    代价是 900M 引导的 `irq4` 从 181 变成约 4.2k（每 0x40000 条指令最多
    一次），实测墙钟仍在 47~53s，`ser_out=309` 不变。

    **（b）提示符"往后追加"**。busybox ash 每个提示符都会发 `ESC[6n`
    （`FEATURE_EDITING_ASK_TERMINAL`，二进制里能看到
    `\x1b[999;999H\x1b[6n` / `\x1b[%hu;%huR`），然后在 raw 模式下
    `read()` 等终端的 `ESC[行;列R`。以前我们只做了一半：把宿主终端的
    应答在输入侧过滤掉（不然会作为垃圾塞进命令行），但 guest 永远等不到
    应答，光标位置算错、用户敲的字符还可能被当成应答吃掉 —— 表现就是
    提示符/输入一直往右追加。
    修法：在 `main.c6` 里做一个最小终端——用 guest 的输出字节流跟踪光标
    （`\r`/`\n`/`\b`/可见字符累计列、`ESC[H`/`ESC[A-D`/`ESC7`/`ESC8`/
    `ESC[s`/`ESC[u` 都认，屏幕尺寸取宿主终端的 `TIOCGWINSZ`，拿不到就
    24×80），看到 `ESC[6n` 就立刻用当前 (行,列) 回一条 `ESC[行;列R`。
    宿主终端自己的应答仍然过滤，避免重复。这样 `ESC[999;999H` 那种
    "把光标开到右下角量尺寸"的老技巧也自动算对（我们按屏幕尺寸截断）。

    **验证**：交互 `top` 30 秒 13 帧并可用 `q` 退出；连续 12 次 500 字节
    写全部完成；`top -n 2` 两帧后回到 shell；pty 里模拟真终端应答时
    100 字符长命令行的回显完整、提示符不再追加。

92. **`login:` 反复输出：guest 时钟比墙钟快 15 倍**。交互登录时提示符会
    每隔 4～6 秒重新打印一次，输入的用户名还可能被吞掉。查下来既不是
    getty 也不是串口的问题，而是**时间模型**：空闲快进（HLT 分支）一次
    推进一个 PIT 周期（4ms guest 时间），但墙钟只花几百微秒，于是 guest
    钟比真实时间快十几倍（实测 15 秒墙钟 = 234～269 秒 guest 时间）。
    busybox login 用 `setitimer(ITIMER_REAL, 60s)` + SIGALRM 做登录超时
    （`--sys` 里能看到 `rt_sigaction(SIGALRM)` → `setitimer` → `read` →
    立刻 `exit_group(0)`），60 guest 秒 ≈ 4 秒墙钟，于是 login 刚打印完
    提示符就被超时踢掉，init 不停 respawn getty —— 用户看到的就是
    "login:" 反复输出；敲字快还能赶上，慢慢打就必然被踢。
    修法两条：
    - **TSC 按 17 条指令加 1**（`g_tsc_acc` 分频）。内核用 PIT 标定出的
      TSC 频率约 1.19MHz，而模拟器一秒跑两千万条指令；1:1 推进时 guest
      眼里的时间就是墙钟的 15 倍。分频后忙时 guest 时间和墙钟基本一致。
    - **交互模式下空闲快进按墙钟节流**（`pace_ahead()`）：guest 钟比墙钟
      超前 20ms 以上时这一跳就不推进时间（但**仍然调用 `dev_tick()`**，
      否则挂起的串口中断投递不出去、敲键没反应——这是第一版踩的坑）。
      stdin 不是 tty（批处理 / difftest / `--stopt` 基准）时完全关掉，
      吞吐和结果都不受影响。
    修复后交互登录：逐字符输入回显即时、回车后直接进 shell，提示符不再
    重复；批处理跑 900M 引导仍是 46 秒、`ser_out=309`（`irq4` 317）。

93. **外网访问：COM2 上的 SLIP + 用户态 NAT**。目标：guest 里的 `ping` /
    `wget` 能真正走宿主网络，不要求 root/tap，也不引入 libslirp 依赖。
    选型过程与结论：

    - **为什么不是 virtio-net**：guest 内核是 Alpine 的
      `6.6.142-0-lts`，`CONFIG_VIRTIO_MMIO=m` 而
      `# CONFIG_VIRTIO_MMIO_CMDLINE_DEVICES is not set`，模块又没有
      `depmod` 索引，`virtio_mmio.device=` 内核参数无解；`-netdev user`
      / tap 需要宿主特权。**稳健的公共交集是串口**：内核有
      `CONFIG_SLIP=m`、`CONFIG_SLIP_COMPRESSED=y`、`CONFIG_SLIP_MODE_SLIP6=y`，
      minirootfs 里也有 `/sbin/slattach`。
    - **硬件**：在 `dev.c6` 里加第二个 16550A：端口 `0x2f8..0x2ff`（COM2，
      `/dev/ttyS1`）、IRQ3、128 KiB RX 环。`serial2_read/write` 覆盖
      RBR/THR、IER、IIR、LCR/DLAB、MCR、LSR、SCR；`dev_tick()` 每轮把
      RX 和 THRE 的**电平**重新拉进 PIC（和 §91 的 COM1 同一套语义），
      否则驱动使能 IER 后不会再收到第一次中断。
    - **THRE 不能只做电平**：16550 的 THRE 挂起态由「写 THR」置位、
      「读 IIR」清除（RX 优先）；只按电平重拉会变成永不停的中断风暴，
      guest 卡在 IRQ3 处理里、sl0 的 TX queue 20 秒超时。`Serial2State`
      里加 `thre_pending`，`serial2_read(2)` 读到 THRE 时清它，
      `serial2_write(0)` 重新置位——这样「驱动一批写完 → 清 THRI」能停，
      而「tty 层后来再排数据 → start_tx 只写 IER」也能被 `ier & 2`
      重新拉起（顺序与真 16550 一致）。
    - **软件**：`src/net.c6`（`C6_WASM` 下整体为空）。地址 `10.0.2.15`
      / peer `10.0.2.2` / DNS `10.0.2.3`（QEMU user 的约定）。
      `slip_rx_byte()` 按 RFC 1055 解帧（`0xC0` 定界，`0xDB 0xDC/0xDD`
      转义），`slip_tx()` 反向转义后 `serial2_feed()` 进 COM2 环；
      IP 层自己算校验和、按 1480 分片；TCP 每条连接一个**非阻塞**宿主
      socket（`connect` 后发本地 SYN-ACK，guest 的数据先缓存在
      `wbuf`，`poll(SO_ERROR)` 成功后再 forward，最大 16 条）；UDP 逐流
      转发（16 条），`10.0.2.3:53` 自动改写成宿主 DNS 并把回包源改回
      `10.0.2.3`；ICMP echo 对 `10.0.2.2/10.0.2.3/10.0.2.15` 本地回，
      其余用宿主 **ping socket**（`SOCK_DGRAM, IPPROTO_ICMP`，本机
      `ping_group_range = 0 2147483647`，非 root 可用）。宿主 DNS 取
      `/etc/resolv.conf` 第一个 `nameserver`，取不到用 `1.1.1.1`。
      `net_tick()` 由 `dev_tick()` 调用，按墙钟 1ms 节流；`net_reset()`
      在 `dev_init()` 里复位。**`10.0.2.2` 在宿主侧映射到 `127.0.0.1`**
      （QEMU user net 的约定，`n_host_ip()`）：guest 可以直接访问宿主上的
      服务；例如宿主跑一个 HTTP 代理 3128，guest 里
      `export http_proxy=http://10.0.2.2:3128` 后 `wget http://…` 就走代理
      （实测通过）。busybox wget 对 https 会向代理发 `GET https://…` 而不是
      `CONNECT`，需要代理支持 TLS 终结；UDP/ICMP 不走 HTTP 代理。
    - **固件**：`tools/mkfw.py` 新增 `--modules`（也接受
      `lib/modules/<kver>`），把 `slip.ko`/`slhc.ko` 解压进
      `/lib/modules/<kver>/kernel/drivers/net/slip/`，并给 `/init` 追加
      `insmod slhc`、`insmod slip`、`slattach -p slip -s 115200
      /dev/ttyS1 &`、等待 `/sys/class/net/sl0`（最多 5 秒）、
      `ifconfig sl0 10.0.2.15 pointopoint 10.0.2.2 mtu 1500 up`、
      `route add default gw 10.0.2.2`、`nameserver 10.0.2.3`。
      `build.sh fw` 在 `build/alpine/lib/modules` 存在时自动带上模块树。
    - **验证**（native，默认构建）：guest 里 `ifconfig sl0` 显示
      `10.0.2.15 P-t-P 10.0.2.2 UP`；`ping -c1 10.0.2.2` 和
      `ping -c1 10.0.2.3` 都是 0% loss、RTT ~3.3ms；
      `wget http://example.com/` 走完 DNS + TCP + HTTP 并成功退出。
    - **踩过的坑**：`tcp_input` 里 guest 包的 `src` 是 guest、`dst` 是远端，
      最初把两者当成「远端/guest」传给 `conn_open`，SYN-ACK 的 IP 头和
      端口方向全反，guest 只看到「自己发给自己」的包并无限重传 SYN；
      统一成 `conn_open(dst, dport, src, sport)` 后修复。THRE 语义和
      §95 的空闲快进两个坑分别见上面和下一节。UDP 侧没有这个问题，
      因为 `udp_input` 一开始就是按 `gip=src, rip=dst` 写的，DNS 一直能通。

94. **`ifconfig` 触发内核 oops：BSWAP 漏了 REX.B**。现象：guest 里一执行
    `ifconfig`（甚至只是 `ifconfig -a`）就
    `BUG: unable to handle page fault for address: ffffffff88000000`，
    `RSP = CR2`，随后整机卡在页错误处理里空转；`uname -m` 等命令本身正常。
    这个 bug **与联网无关**：不带 `slip` 模块的固件同样复现，是模拟器
    已有缺陷。

    定位靠新加的 `--rspcheck`：每条指令前记录 `(rip,rsp)` 到 64 项环，
    发现 `rsp` 落在模块区（`0xffffffffc0000000` 以上）就打印环和 TSS
    并停机。第一次停机点在 `bffffff8`，把范围放宽后看到 8 字节一步的
    「栈一直往下走」——是 `#PF` 的入口反复入栈，而 `rsp` 本来是
    `0xffffc90000197830`，某条指令之后突然变成 `0x30781900`。
    **`0x30781900` 正好是 `0x00197830` 的字节序反转**：`RSP` 低 32 位被
    `bswap` 了。对应的指令是 `41 0f cc`（`bswap %r12d`，在内核
    `fib_table_insert` 里），而 `cpu.c6` 的 `bswap` 实现是
    `i = op2 - 0xc8` —— **忘了加 REX.B**，于是 `41 0f cc` 被当成
    `bswap %esp`，把 RSP 的低 32 位反转后零扩展成 `0x30781900`。
    `ifconfig` 一做路由表查找就踩中这条指令，`call` 一压栈就
    `#PF`，异常入口再用坏 RSP 压栈，形成死循环。

    修法：`u32 i = (op2 - 0xc8) + ((rex & 1) ? 8 : 0);`。
    `tools/difftest/difftest.py` 补了 `41 0f c8..cf` 和 `49 0f c8..cf`
    （`bswap r8d..r15d` / `r8..r15`）共 16 条用例。修复后
    `ifconfig -a`、`ifconfig lo up`、`uname -m` 全部正常，`--rspcheck`
    不再触发；`slattach`/`sl0` 的回归也才有意义（此前 `/init` 里的
    `ifconfig sl0` 同样会把整机带进 oops）。

95. **空闲快进越过设备中断：ping RTT 2 秒、DNS 超时**。SLIP 刚通时
    guest 里 `ping 10.0.2.2` 能收到回包，但 RTT 显示 **5869ms**，DNS
    查询必然 `bad address`。`--nettrace` 加墙钟后看到：`udp send` →
    `udp recv` 只有 **14ms**，`serial2_feed` 也是立即的；问题在 guest
    收到包之后 1～2 秒才处理。根因在 HLT 空闲分支：
    ```c
    step = pit.count[0];        /* tickless idle 下可能是 2 秒 */
    g_m.tsc += step; g_m.instructions += step;
    dev_tick();                 /* 这时才把 IRQ3 投递给 CPU */
    ```
    设备中断在**时间已经跳完**之后才投递：回包确实进了 RX 环、IRQ3
    也确实拉起来了，但 guest 的 TSC/jiffies 已经被推后 2 秒，于是
    `ping` 的 RTT 是 2 秒、DNS 解析器的 1 秒超时提前到期、UDP 回包到达
    时 socket 已经关闭（guest 反而回了一个 ICMP port unreachable）。
    修法三步：**先 `dev_tick()` 再快进**；`dev_tick()` 之后如果
    `exc_pending` 就清 `halted`、投递、**不推进时间**；快进上限
    `0x40000` 条指令，保证设备事件最多晚 0x40000 条被发现。修复后
    `ping 10.0.2.2` RTT **3.3ms**，DNS、`wget http://example.com/`
    一次通过。注意 §92 的交互模式 `pace_ahead()` 不受影响：它本来就把
    step 置 0，只是现在「先轮询、再决定是否快进」的顺序对批处理模式
    同样正确。

96. **guest 时钟停在 1999：CMOS RTC 是桩，HTTPS 证书校验失败**。
    guest 里 `wget https://qq.com/` 报
    `tls_post_process_server_certificate:certificate verify failed`
    然后 `ssl_client: SSL_connect` / `error getting response: Connection
    reset by peer`。TCP/TLS 本身是通的（443 连上了、服务器证书收到了），
    问题在**时间**：`date -u` 显示 **Tue Nov 30 00:00:07 UTC 1999**，
    X.509 的 notBefore/notAfter 全部落在窗口外。根因是 `dev.c6` 的
    CMOS 一直是空实现：`io_w8(0x70)` 丢掉索引、`io_r8(0x71)` 恒返回 0，
    内核 `mach_get_cmos_time()` 读到全 0 的秒/分/时/日/月/年，落到
    mc146818 的默认时间 1999-11-30 00:00:00。

    修法：实现只读的 mc146818 RTC。`0x70` 写存索引（低 7 位），
    `0x71` 用宿主 `CLOCK_REALTIME` **现算** UTC 年月日时分秒
    （Howard Hinnant 的 `civil_from_days`，不依赖 libc 的 `gmtime`
    结构体布局），按 BCD、24 小时制返回；状态寄存器 `0x0A = 0x26`
    （UIP=0）、`0x0B = 0x02`（BCD+24h、不使能中断）、`0x0C = 0`、
    `0x0D = 0x80`（VRT），`0x32` 给世纪。`acpi=off` 时内核不读世纪，
    年份 26 走 `year < 70 → +2000` 得到 2026。RTC 只读：guest 的
    `date -s`/`hwclock -w` 只改内核时钟，不回写 CMOS；wasm 侧没有
    `CLOCK_REALTIME`，给 2026 年的常量（浏览器里证书不会"未生效"）。

    验证：guest `date -u` = 宿主时间（2026-11-27 11:45 UTC），
    `wget -O /dev/null https://qq.com/` 证书校验通过并下载 132k，
    `http://example.com/` 同时正常。这个 bug 与联网无关（任何 HTTPS
    都会踩），但只有 guest 真能上网才会暴露。

97. **wasm 也用 -O2：ctu + clang + wasm-ld**。native 早就走
    「`c6c --emit-ctu` → 宿主 `cc -O2`」，wasm 却一直用 tcc-c6 直接出码。
    tcc 是单遍编译器、基本不做优化，整机只有 **0.76M guest 指令/秒**，
    浏览器里登录 Alpine 要 **18 分钟**，演示价值大打折扣。

    其实 c6c 的 `--emit-ctu` 正是为交叉编译准备的（帮助里写着「per-TU C：
    真 C ABI、不要 main、不带运行时」），那就把它接到 clang：

    - `c6c --emit-ctu -D C6_WASM=1 -I src <tu>.c6 -o <tu>.c`：c6c 的预处理器
      按 `-D` 展开，所以产物是 wasm 变体；头文件被内联进 C（带 `# line` 标记），
      不依赖宿主/目标机的系统头。
    - `clang --target=wasm32-unknown-unknown -O2 -fno-builtin -c`。
    - `wasm-ld --no-entry --export-all --initial-memory=268435456
      --max-memory=536870912` 链接 tcc-c6 留下的 wasm 运行时
      `libtcc1-wasm32.a`（提供 printf/memcpy/memset/malloc/free）。

    **ABI 能对上的原因**：wasm32 的 C ABI 两边一致（int 32、long long 64、
    指针 32），结构布局由同一份 emitted C 决定；wasm 没有 80 位浮点，两边
    `long double` 都是 f64（`c6sim.h` 里 `C6_WASM` 已经选了 `double`）；
    wasm 的 varargs 是"参数区指针"约定，tcc 运行时的 `printf` 正好是
    `(i32 fmt, i32 args)`，clang 生成的调用形式相同。唯一要补的是声明：
    `src/cpu.c6` 的 `[UD]` 与 `src/mem.c6` 的 `[CC]` 两处 debug printf 在
    `C6_WASM` 下没有 `<stdio.h>`，clang 会报 implicit declaration；在
    `c6sim.h` 里给 `#if defined(C6_WASM)` 补一条
    `int printf(const char *fmt, ...);` 即可。`-fno-builtin` 用来防止 clang
    把 `printf("...\n")` 换成 `puts` 之类的库函数替换（运行时没有对应实现）。

    **验证与数字**（同一台机器）：

    | 指标 | tcc-c6 | ctu + clang -O2 |
    | --- | --- | --- |
    | 5M 条整机引导 | 6.55s / 0.76M 条每秒 | **0.29s / 17M 条每秒（22.6×）** |
    | 20M 条整机引导 | 15.85s | **1.04s（15.2×）** |
    | wasm_login（Node） | 1056s / 1194M 条 | **59s / 882M 条** |
    | browser_alpine（Chromium） | 1062s | **62s** |
    | `web/sim.wasm` 大小 | 1.6 MiB | **116 KiB** |
    | 构建时间（9 个 TU） | — | **2.2s** |

    正确性：`tests/wasm_cmp.js 50000000` 与 native **MATCH**（16 个 GPR、
    RIP、RFLAGS、128MiB RAM 的 FNV 哈希全部一致）；`wasm_smoke.js`、
    `browser_e2e.js`、`wasm_login.js`、`browser_alpine.js` 全过，
    `./build.sh test` 全绿。

    **回落与开关**：`WASM_BACKEND=auto|clang|tcc`。auto 会检查 clang 的
    `--print-targets` 里有 wasm32、`wasm-ld` 在 PATH、以及
    `$TCCDIR/libtcc1-wasm32.a` 存在；任一不满足就退回原来的 tcc-c6 路径
    （产物照旧可用，只是慢）。`WASM_CC/WASM_LD/WASM_OPT/WASM_CFLAGS` 可覆盖。
    链接产物仍是 export-all 的 wasm，浏览器 API 一个没变；clang 默认会用到
    bulk-memory 等较新的 wasm 特性，需要近几年的浏览器。

98. **启动加速实测与 wasm JIT 第一版**。

    **(a) 宿主内联（已落地）**。c6c 不做内联，`step()` 经宿主 `cc -O2`
    编译后约 26 KiB，GCC 不会把 `reg_read/reg_write/cond/flags_add/
    flags_sub/flags_logic/shift_op/op_read/op_write` 这些 static 小函数
    内联进巨型 switch；200M 条整机引导里它们约占 12% 的周期。`build.sh`
    在 c6c 产物上补 `static inline __attribute__((always_inline))`
    （native 与 wasm 的 ctu 路径都做，`INLINE_HOT=0` 可关闭做对照；
    C6_PURE 自举路径不经过这里）。

    200M 条 guest、`--stopt=200000000`、固定核：

    | 版本 | 宿主 instructions:u | best-of-3 墙钟 |
    | --- | --- | --- |
    | P0 基线 | 74,644,973,526 | 10.8s |
    | +always_inline | **70,710,388,920（-5.3%）** | **9.6–9.7s（约 -10%）** |

    串口输出 SHA256 完全一致（`2c1da2ba…`）。分项实测：只内联
    reg_read/reg_write/cond 约 -3%；再加 flags_* 约 -3.3%；把 shift_op 和
    op_read/op_write 也带上才到 -5.3%。sz_mask/sx/parity/sign_bit 已经被
    cc 内联，再加反而略慢，所以不在列表里。

    **(b) 两个反例（已回退，记录避免重走）**。

    - 计数摊销：把 `g_m.instructions`/`g_tsc_acc` 放寄存器、循环末尾再写回，
      宿主指令 70.7G → 68.5G（-3.1%），但墙钟 9.68s → 10.06s（+4%）。
      原因是 `cpu_step` 调用前后的寄存器压力和栈槽：少掉的两条内存 RMW
      抵不过多出来的 spill/reload。保留逐条 RMW。
    - 惰性取指翻译窗口：缓存「下一条顺序取指 VA→PA」并在同页写入时失效。
      宿主指令 70.7G → 73.1G（+3.3%），墙钟持平；profile 里 `mem_fetch8`
      仍是 17.90%（窗口前 16.28%）。内核 text 本来就命中
      `0xffffffff80000000` 的 direct-map 窗口（两次减法+比较），每字节再加
      「比较/自增/页尾判断」比省下来的还多。只有走 TLB 的取指才可能受益，
      占比不够。已回退。

    **(c) 客户机侧命令行（未改默认）**。到 login 的整机墙钟（`--stopt=
    1500000000`，均 51–52s）：基线 51.72s、`lpj=1000` 51.30s、
    `nokaslr` 51.90s，差异都在噪声内。`Calibrating delay loop` 本身只占
    一个 jiffy，560–780M 处的 `delay_loop` 是设备轮询等待而不是
    `__const_udelay` 的 lpj 循环，所以预设 lpj 省不掉；KASLR 也不是大头。
    没有把这些参数写进默认 `BOOT_ARGS`。

    **(d) wasm JIT 第一版（实验构建，默认关闭）**。

    目标是在浏览器/Node 的 wasm 构建里把热客户机直线块编译成**动态 wasm
    模块**，native 继续用解释器——只做一个后端，不写第二套 x86-64 宿主 JIT。

    链路：

    - `JIT=1 ./build.sh wasm` 额外编译 `src/jit_wasm.c`，链接时加
      `--allow-undefined`；生成模块只 import `js_jit_compile/js_jit_run`
      两个 JS 钩子。
    - C6 侧 `sim_jit_block(rip)`（`src/wasm.c6`）调 C 编码器。编码器从
      `g_m.ram` 逐字节解码 1–16 条客户机指令，在静态 `jit_mod[]` 里拼出
      wasm 二进制：type/import/function/export/code 五段，导出
      `run(state_off, ram_off) -> i32`。
    - JS 钩子用 `new WebAssembly.Module(bytes)` + `new Instance(..., {env:
      {memory: 主模块 memory, jit_flags_*}})` 实例化；生成模块与主模块
      **共享同一块线性内存**。CPU 字段偏移用 `offsetof` 在 C 侧算好、
      烧成 wasm 常量，和 c6sim.h 的布局同源。
    - `js_jit_run` 调 `run()`；块尾把 RIP 写回 `state + offsetof(cpu.rip)`。
    - 标志位不自算：生成代码 `call` 主模块导出的
      `jit_flags_add/sub/logic/inc/dec` 包装，复用 `cpu.c6` 里唯一一份
      `flags_*` 语义（inc/dec 会恢复 CF）。这样编码器只负责寄存器数据通路。

    当前指令子集：`mov r32,imm32`、`mov r32,r32`、`add/sub/and/or/xor/cmp
    r32,r32`、`81/83` 的 add/sub/cmp r32,imm、`inc/dec r32`、`nop`；遇到
    内存操作数、分支、前缀、未支持 opcode 或页边界就收块。每次调用现场
    编译（POC，还没有块缓存）。

    验收：`./build.sh jit`（自动 `JIT=1` 构建 + 两个 Node 测试）。
    `tests/jit_poc.js` 覆盖 6 个 imm 的 mov（含 0xdeadbeef/0xffffffff）；
    `tests/jit_block.js` 用 12 条指令跑完整块，16 个 GPR、RFLAGS、RIP
    与解释器 `sim_run(12)` 逐位一致（PASS，rax=6、rcx=0xffffffff、
    flags=0x96、rip=0x101e）。默认 `JIT=0` 的 `web/sim.wasm` 仍是零 import；
    `wasm_cmp 50M` MATCH、`./build.sh test`、`boot_login.py` 全过。

    **还没做**（下一步）：第一版只做到这里。块缓存、machine_run 接入、
    SMC、64 位与分支翻译已经在 §100 补上；只编译长块后性能已略快。

    **(e) 复现命令**：

    ```sh
    ./build.sh native
    perf stat -e instructions:u,cycles:u -o /tmp/p.txt \
      taskset -c 20 build/sim --stopt=200000000 \
      --cmdline="console=ttyS0,115200 loglevel=4 panic=-1 acpi=off pci=off" \
      build/firmware.bin > /tmp/serial.bin
    JIT=1 ./build.sh wasm && node tests/jit_poc.js && node tests/jit_block.js
    ./build.sh test && node tests/wasm_cmp.js 50000000
    SIM=build/sim TIMEOUT=1200 python3 tools/boot_login.py
    ```

99. **P1 热指令快通道扩展（已落地）**。

    `step()` 顶部原有 nop / MOV r,r / Jcc rel8 / JMP rel8|rel32 快通道。
    这次补了内核里最常见的四类，全部只在「不碰内存、不会缺页」的编码上：

    - `MOV r32/r64, imm32/imm64`（B8-BF，含 REX.B/W）
    - 32/64 位 ALU reg,reg：add/or/and/sub/xor/cmp（排除 adc/sbb 与字节形式）
    - `TEST r32/r64, r32/r64`（85，mod=3）
    - `Jcc rel32`（0F 80-8F）

    ALU 快通道复用主路径的 `flags_add/flags_sub/flags_logic/reg_read/
    reg_write`，没有第二套标志位公式。命中时只多一次 modrm 比较。

    200M 条整机引导（固定核，`--stopt=200000000`）：

    | 版本 | instructions:u | cycles:u（无争用配对） | best-of-3 墙钟 |
    | --- | --- | --- | --- |
    | 只有 §98a 内联 | 70,710,397,444 | 约 26.6G | 9.60s |
    | + 快通道扩展 | **66,397,426,607（-6.10%）** | 约 25.4G | **9.33s（-2.9%）** |

    墙钟受共享机器负载影响很大（同一配对里见过 9.3–28.9s），所以主指标
    用 instructions:u；-6.1% 在三轮里稳定到 0.001% 以内。配对最好的三次：
    base 9.602/9.750/9.774s，fast 9.328/9.527/9.633s。

    正确性：串口输出 SHA256 与内联版一致（`2c1da2ba…`）；
    `tools/difftest` **1252/1252**；`wasm_cmp 50M` MATCH；
    `./build.sh test`、`boot_login.py` PASS。

    顺带确认了一个**改动前就有**的现象：native 跑到 1B 条时，同一个二进制
    两次运行的串口首行时间戳（`[0.686666]` vs `[0.683333]`）和 halt 行的
    irq4 计数会差一点，其余字节完全相同。这是设备/宿主时序的既有抖动，
    不是快通道引入的（同一二进制复跑即可复现）。所以全量引导的逐字节对比
    取 200M 确定性窗口 + wasm_cmp；JIT 验收走 wasm 路径（无宿主
    net_tick/节流），不把 native 的墙钟序当确定性基准。

100. **wasm JIT 接入 machine_run（MVP）**。

    §98d 的块编码器现在接进了运行循环；编译目标只有 wasm，native 不受影响。

    - **触发与预算**：`machine_run` 每轮在解释指令前调
      `jit_try2(rip, max_ins)`。只在 `g_jit_on`、无调试、无 pending 异常/
      HLT、RIP 落在内核 text 窗口 `[0xffffffff80000000,
      0xffffffffc0000000)`、且不跨 `(instructions & 0x3ffff)==0` 的
      dev_tick 边界时尝试。`max_ins = min(循环剩余, stopt 剩余, 到边界距离)`；
      块比预算长就不跑。成功后按 jn 一次补 `g_m.instructions` 和
      `g_tsc_acc/g_m.tsc`（整除/取模，和逐条累加结果完全一致），跳过本轮
      解释器；中断/异常仍只在边界交给解释器。
    - **缓存**：2048 项直接映射，键 RIP。8192 项 seen 表做热块阈值：同一个
      块先让解释器跑 64 次才编译，编译上限 2048。900M 引导实际只编译 291
      个块，避免了把冷块全编一遍（无阈值时 50M 就编满 16384 个，反而 +3%）。
    - **SMC**：`mem_w8/16/32/64` 每次写 RAM 把 `jit_page_gen[pa>>12]++`；
      缓存项存代码物理页和写代数，命中时比对，变了就重翻译。INVLPG 不刷
      整个 JIT 缓存（内核 text 是全局映射，用户页 INVLPG 很频繁；刷了会让
      50M 之后 0 命中），只有 CR0/CR4 改分页模式才整体失效并重置编译预算。
    - **指令子集**：在 §98d 的 32 位基础上加了 REX.W（mov imm64/C7、ALU、
      inc/dec、test）、jmp/jcc rel8/rel32（块尾用 `select` 选 target/next）。
      标志位/条件仍 call 回主模块的 `jit_flags_*`/`jit_cond`（signature 加
      操作数宽度），没有第二份语义。
    - 顺带修了 wasm `sim_init` 没把 `g_m.watch_fd` 置 -1 的问题：BSS 默认 0
      会让 `dbg_any` 恒真，JIT/快通道永远不触发。

    **正确性**（同一份 JIT=1 wasm，开/关对比）：

    - `wasm_cmp 50M`：寄存器/RIP/RFLAGS/RAM 与 native **MATCH**。
    - `tests/jit_poc.js`、`tests/jit_block.js`、`tests/jit_block64.js` 全
      PASS（含 64 位 ALU、jcc taken/not-taken）。
    - 900M 引导（`tests/wasm_login.js`，实际 876,201,405 条到 shell）：
      JIT 开/关的指令数完全一样，串口 646 字节 SHA256 都是
      `c67ca2a0…`，两次都 `WASM LOGIN OK`。

    **性能与链式实验**（Node，同机）：

    | 负载 | JIT 关 | JIT 开（默认单块直跑） |
    | --- | --- | --- |
    | 900M 引导 | 56.6s | 66.8s（+18%） |
    | 50M 引导 | 15.9s | 16.4–16.9s（+3–6%） |
    | 210M 固定 stopt | RAM `dedbf9f2` | RAM `dedbf9f2`（一致） |

    为了摊薄 wasm↔JS 切换，在 JS 侧按 RIP 连跑多个块（`JIT_CHAIN_FALL=0`
    打开）。最初 205M–210M 的固定 stopt 对比发现 JIT 开/关的 RAM 分叉
    （串口首行时间戳差 10ms、login PID 502/503；tsc/PIT 计数一致，
    badBoundary/badBudget=0）。根因是 CR0/CR4 变更时 `jit_flush` 只清了
    C 侧缓存，JS 的 `byRip` 映射仍指向 flush 前的 handle，分支链会执行到
    这些旧块；把 flush 代数传进 JS（变化时清空 `byRip`）后，210M 的 RAM
    恢复一致，900M 全链式也做到 876,201,405 条、串口 SHA256
    `c67ca2a0…` 一致。全链式仍比单块直跑慢（900M 71.3s vs 66.8s），所以
    默认仍是单块直跑，链式作为诊断/后续优化开关。

    - 期间修了一个 simple 路径不检查 `max_ins` 的 bug：块长于预算时会
      在 `machine_run` 里让 n 下溢，整机跑飞（实测 13.7B 条）。
    - 新增 LEA（SIB/RIP 相对/32 位）与 movzx/movsx（含无 REX 的
      AH/CH/DH/BH）、64 位/分支的块测试，以及 `jit_chain.js`、
      `wasm_fixed.js`（固定 stopt 对比串口/RAM/tsc/PIT）。

    内存操作数（本轮补上）：支持 base+index*scale+disp 与 RIP 相对地址，
    覆盖 `mov r,[m]` / `[m],r` / `[m],imm32`、ALU/cmp/test 两个方向、
    `inc/dec [m]`、`movzx/movsx [m]`。生成代码通过 `jit_ld`/`jit_st`
    访问（和解释器同一套 mem_r/mem_w），每次访问后查 `jit_faulted`：
    缺页时写回该指令 RIP 并 `return k+1`（把这次尝试计入指令数），
    `machine_run` 下一次看到 exc_pending 就回退解释器重试；加载在写
    寄存器前检查，存储在算完标志后检查，和解释器的故障回滚顺序一致。

    调试内存时抓到一个方向 bug：ALU 内存形式用了 `op & 1` 判断
    mem_dst/mem_src（0x01 和 0x03 都是奇数），导致 `and rdi,[rip+…]`
    （0x23）被翻成对内存的存储，35M 处把内核页表的一个 PTE 改成
    0x8000000000000063。用 `JIT_TRACE=1` 的 `[JST]` 存储日志
    （rip=ffffffff810a0c06、va=ffffffff825de110）加反汇编
    （指令实际是 `and rdi,[rip+0x153d503]`）定位；改成
    `(op>>1)&1` 后 50M MATCH、900M 串口一致。

    栈操作与调用（本轮补上）：push r64/imm8/imm32/r/m64、pop r64、
    call rel32、ret、leave。栈访问走 `jit_ld`/`jit_st`；RSP 只在存储/
    加载成功后更新，缺页时保持原值，和解释器的同步故障回滚一致；
    call/ret 作为块结束并自己写 RIP。

    指令集再扩（本轮）：C1/D1/D3 移位（复用 shift_op，含 CL 计数）、
    0F AF/69/6B imul（69/6B 按解释器不更新标志）、0x63 movsxd、
    98/99 cdqe/cqo、0F 40-4F cmovcc（修了 select 参数顺序）、9C/9D
    pushfq/popfq、F3 0F 1E FA endbr64、0F 1F nop r/m。

    只扩指令集时：900M 里 JIT 执行 31.1M 条（3.5%）、654 次编译、
    19.2M 次块执行；JIT 开 69.1s vs 关 55.6s（+24%）。扩指令集本身
    提升有限：热块平均只有约 1.6 条指令（解码很快碰到未覆盖指令）。

    采样编译（本轮）：之前 `machine_run` 每条指令都调 `jit_try2`
    （876M 次），绝大多数 RIP 不可翻译/未编译。改成三层过滤：

    - good 位图（已编译块的 RIP）：直接跑；
    - 每 64 条指令在当前 RIP 采样一次，采样路径跳过 64 次热块阈值；
    - bad 位图：解码失败的 RIP 永久跳过。

    同时去掉 CR0/CR4 变更时的整体 flush（生成代码不依赖 CR0/CR4；
    内存访问走 helper；代码页变化由 SMC 写代数兜底），缓存不再被频繁
    清空。900M：JIT 执行 107.5M 条（12.3%）、8192 次编译、20.1M 次
    块执行；墙钟 63.4s vs 关 55.6s（+14%，从 +24% 降下来），串口和
    指令数仍一致。链式路径（`JIT_CHAIN_FALL=0`）在 20M 与 native 分叉；
    `JIT_BATCH_ONE=1`（只跑批内第一块）MATCH，说明 bug 在“链到下一块”
    的 JS 分发；继续二分到 18M MATCH、19M DIFF，call/ret 的合成链测试
    能过，怀疑与链中的缺页/采样块有关。默认仍是单块直跑（SIMPLE），
    链式保留诊断。下一步：补内存/缺页链测试定位、SSE/rep string ops。
    默认发布构建仍是 JIT=0。

    性能拐点（MIN_N，本轮）：每块 wasm↔JS 切换约 0.3µs，而块内省下的
    解释器 dispatch 约每指令 20–40ns；平均 5.4 条的块大多净亏，这就是
    +14% 的主因。只编译 >=9 条指令的长块（`g_jit_min_n=9`，短块标 bad
    交给解释器；`JIT_MIN_N=` 可覆盖）后：900M 里 JIT 执行 199.0M 条
    （25.3%）、14.8M 次块执行、6219 次编译；best-of-3 墙钟关
    49.31–50.24s（中位 49.85s）、开 49.12–49.47s（中位 49.45s），约
    0.5–1% 净赢；指令数/串口 SHA256 完全一致。50M wasm_cmp MATCH
    （JIT 覆盖 20.9M/50M=42%）。JIT 从「慢 14%」变成「略快」，默认
    JIT=1 构建采用 MIN_N=9；单元测试的短块用 `sim_set_jit_min_n(1)`。
    下一步的大头仍是批量/wasm 内 dispatch（消除每块 JS 切换）和
    SSE/rep string ops。

    链式根因（已修）：`JIT_CHAIN_FALL=0` 在 900M 上串口/指令数与单块
    路径不同（a9bd52…/944,863,568 vs f9aaea…/945,486,073）。用
    `JIT_MASK=128` 禁用显式内存操作数块后链式完全一致（945,486,073
    条、f9aaea…，55.4s），说明分叉来自「内存操作数块在 JS 批里连续
    执行」。修法：JS 批只链**非内存块**，内存块作为批的第一块由 C
    单块调用（e.mem/nx.mem 断开）；并补 `jit_pending()`，批内一旦有
    pending 异常就交回 C 投递。修后 900M 链式与单块/解释器逐字节一致
    （63.0s，仍比单块 56.9s 慢，链式保留诊断）。`g_jit_no_mem=1` 的
    无内存链式在 harness 里 55.4s，但生产 glue 没有链式，默认仍是
    单块（MIN_N=9）。

    固定 1/17 对拍模式（`sim_set_paced(0)`；浏览器/交互仍按墙钟校准）下
    再测 900M：JIT 开 54.0s vs 关 55.5s（约 -2.7%），指令数 928,669,926、
    串口 96018440… 开/关一致。`sim_set_cmdline` 在 `sim_init` 前设置时
    会被 `machine_init` 的默认值覆盖，现在存一份并在 boot 前重新套用。
    已知：`tests/wasm_cmp` 的整机 128 分块哈希在新固件/boot 下 chunk 0
    仍有差异（100K 处 CPU 状态一致，1M 起 r1 分叉），属 boot 参数/低内存
    的并发 boot 改动，待 boot 侧对齐。

    链式二分：用 `JIT_MASK` 按指令组禁用后，mask 64（push/pop/call/ret/
    leave）使 19M 恢复 MATCH，问题就在这一组。期间修了 `pop %rsp` 的
    顺序（目的写入必须在 RSP+=8 之后，否则 pop %rsp 的最终 RSP 会错），
    并补了 leave/push [mem] 的单块测试；合成 call/ret 链（无缺页）通过，
    所以更像是栈/调用链里的缺页路径，下一步用 paging 故障链或 19M 的
    RIP/块 trace 定位。把 mask 再拆细到单个形式：mask 64（只 push
    reg）、8192（只 call）、262144（只 ret）各自都能让 19M 恢复 MATCH；
    关 pop/push imm/push [mem]/leave 都不行。19M 的 RAM 差异集中在内核
    text 的补丁字节（ftrace/static call 一类），看起来是不同路径走到了
    不同补丁阶段，而不是单个错误存储。更像是 push reg + call/ret 出现
    在链里改变了后续路径/覆盖，下一步用 19M 的 RIP/块 trace 对齐。

    又修了一个缺失的投递：JIT 块的最后一条缺页时，machine_run 过去会
    `continue`，把异常留到下一轮再重试一条指令；现在块结束后若
    exc_pending 就立刻 `cpu_deliver`，和解释器循环尾一致。
    `tests/jit_pagefault.js`（4 级页表 + guard 栈 + call/ret 链）PASS：
    JIT 开/关都停在 RIP=ret、RSP=guard、halted=1。

    复现：

    ```sh
    ./build.sh jit                 # JIT=1 + 三个块测试
    JIT=1 ./build.sh wasm
    JIT_STATS=1 node tests/wasm_cmp.js 50000000
    node tests/wasm_login.js                  # JIT 开（默认单块直跑）
    JIT_OFF=1 node tests/wasm_login.js        # JIT 关
    JIT_CHAIN_FALL=0 node tests/wasm_login.js # 链式诊断（分支链有已知差异）
    node tests/wasm_fixed.js 210000000        # 固定 stopt 对比
    ```

101. **wasm 真上网：`--netshim` + WebSocket SLIP 代理**。背景：wasm 里没有
    宿主 socket，native 那套 SLIP + 用户态 NAT（`src/net.c6`）又依赖模拟器的
    PIC/串口状态，不能原样搬进浏览器。做法是把 NAT 留在 native，wasm 只负责
    “串口字节 ↔ JS”，中间用 WebSocket 代理把两边接起来：

    ```
    wasm guest ttyS1(SLIP) <-> sim_net_rx/tx <-> WebSocket
      <-> tools/ws_slip_proxy.js <-> build/sim --netshim <-> 宿主 socket
    ```

    **（a）wasm 第二串口**。`dev.c6` 的 COM2 去掉 `C6_WASM` 限制；RX/TX 两个
    128 KiB 环从结构体里挪到全局数组（wasm 后端对“结构体内的数组下标”读写
    有坑，和 §13 的 PIC 位图同类）；新增 guest→JS 的 TX 环：THR 写入在 native
    下仍走 `slip_rx_byte()`，wasm 下改成进 TX 环；`dev_tick()` 的 COM2
    RX/THRE 电平重拉对 wasm 也打开。导出
    `sim_net_rx(src,len)`（→ `serial2_feed`）和 `sim_net_tx(dst,cap)`
    （→ `serial2_out_take`）。guest 的 `/init` 看到 `/dev/ttyS1` 就会
    `slattach` + `ifconfig sl0`，和 native 完全相同。

    **（b）`--netshim`**：`main.c6` 加一个无固件模式。`g_net_shim=1` 后
    `serial2_feed()` 把整帧 SLIP 直接 `fwrite(stdout)`（日志走 stderr，
    stdout 只放二进制）；主循环 `poll(stdin, 1ms)` 读到的每个字节喂给
    `slip_rx_byte()`，再调 `net_tick()` 推进宿主 socket。等于把 native 的
    用户态 NAT（DNS 改写、TCP 中继、UDP、ICMP ping socket）单独跑成一个
    网关进程，一行 NAT 逻辑都没有重写。

    **（c）WebSocket 代理**：`tools/ws_slip_proxy.js` 是一个零依赖的最小
    WebSocket 服务器（握手、掩码帧、ping/pong、分片），每个连接 `spawn`
    一个 `build/sim --netshim`，二进制消息 ↔ 子进程 stdin/stdout 原样搬运。
    WS 二进制消息就是任意切分的 SLIP 字节流（RFC 1055：`0xC0` 定界、
    `0xDB` 转义），所以代理本身不理解 IP。

    **（d）页面**：「网络代理」输入框填 `ws://127.0.0.1:8787`，点连接后
    `onmessage` 把字节写到线性内存 252 MiB 处再调 `sim_net_rx()`；
    4 ms 定时器调 `sim_net_tx()` 把 guest 的字节 `send()` 回去；状态行显示
    ↑↓ 字节数。地址仍是 guest `10.0.2.15` / 网关 `10.0.2.2` / DNS
    `10.0.2.3`，guest 里的 ping/wget 和 native 完全一样。

    **为什么这么绕**：NAT 复用同一份 `src/net.c6`，行为与 native 一致；
    wasm 仍不需要任何 import（保持 `--no-entry --export-all` 的链接方式）；
    每个浏览器连接一个 shim 进程，多标签页/多用户天然隔离。

    **实测**（2026-11-27）：wasm guest 带 COM2 启动到 `login:` 约 **778M 条
    指令 / 52s**；`ifconfig sl0` = `10.0.2.15 P-t-P 10.0.2.2`；
    `ping -c1 10.0.2.2` 0% loss；`wget http://example.com/` 打印
    `'/dev/null' saved`（DNS + TCP + HTTP 真出外网，代理 rx/tx 约
    1.4KB/480B）。`tests/wasm_net_proxy.js` 一条命令覆盖这条链路；
    `browser_e2e` 覆盖页面「连接」按钮到 WS 代理。

    **代理模式的一个细节**：shim 不在 SYN 时立刻连宿主，而是等 guest 的
    第一个数据段再 `connect()`。guest 的 TLS/CRNG 首次可能要几十秒才发出
    ClientHello，先连会被服务器的握手超时踢掉；HTTP/HTTPS 都是客户端先
    说话，这个延迟没有副作用（native 仍是立即连）。

    **已知问题**：**HTTPS 在 wasm 代理下还不稳定**。同一条 TCP 中继在
    native guest 里 HTTPS 正常（§96），wasm guest 的 TLS ClientHello 也确实
    到了代理（抓包 + 直接重放能拿到完整 ServerHello/Certificate），但
    example.com 的 CDN 边缘在收到后约 2.4s 直接关闭连接、不回任何数据；
    怀疑和 CDN 对该 ClientHello/连接时序的策略有关，待查。测试只把
    HTTP/ICMP 作为断言，HTTPS 留作后续。

    **限制与安全**：`--netshim` 等于把宿主的网络能力开放给 guest，默认只绑
    `127.0.0.1`，不要暴露到公网（没有认证/白名单）；HTTPS 页面连
    `ws://127.0.0.1` 受浏览器混合内容策略影响（各版本不同），本地
    `http://localhost` 最稳；每个连接一个 shim 进程，没有 IPv6；ICMP 依赖
    Linux 的非 root ping socket，其它宿主需要相应能力。Pages 的 `sim.wasm`
    取自 release 资产，要等带 `sim_net_rx/tx` 的 release（v1.4+）才能在
    线上站点用代理。

102. **wasm 空闲快进也要按墙钟节流：ping 卡顿、DNS 提前超时**。浏览器的
     wasm 页面里 `ping bing.com` 报 `bad address`，而 `ping 10.0.2.2` 的
     RTT 显示 2.8s、回复一团一团地出来。根因是**空闲快进只节流了 native
     交互模式**：`pace_ahead()` / `g_pace_idle` 整段都在
     `#if !defined(C6_WASM)` 里，wasm 的 HLT 快进每次都把 `g_m.tsc` 推进
     0x2000~0x40000 条指令，guest 钟在等待网络时比墙钟跑得快得多——
     musl 解析器的 5s 超时提前到、busybox ping 的 1s 间隔被压缩、RTT 被
     撑大，表现就是「坏地址」和一阵一阵的回复。

     修法：wasm 也走同一套 `pace_ahead()`。`pace_wall_ns()` 在 wasm 下读
     `g_host_ms`（页面/Node 前端每帧调
     `sim_set_host_ms(Date.now() & 0xffffffff)`），`g_pace_idle` 在 wasm
     下恒为 1；空闲快进前若 guest 钟比墙钟超前 20ms，这一步就不推进时间
     （仍然 `dev_tick()` 收设备事件）。前端不提供宿主时间（`g_host_ms=0`）
     时 `pace_wall_ns()` 返回 0，自动退化为原来的行为。

     验证：`node tests/wasm_net_proxy.js`（每轮都设宿主毫秒）里
     `ping 10.0.2.2` 的 RTT 3.3~23ms、`ping bing.com` 106ms 且 DNS 正常；
     浏览器 e2e/页面登录不受影响。改动：`src/machine.c6`、`src/wasm.c6`、
     `web/app.js`、`tools/wasm_tty.js`。

     **补充：top 看起来“不刷新”**。固定 1/17 是按 ~20M 条/秒调的；
     pty/终端模拟实测只有 ~10M 条/秒，guest 钟只有墙钟的一半，busybox
     top 默认 5s 的刷新间隔被拉成 ~8s。修法：交互/wasm 模式下
     `pace_calibrate()` 用前 150ms 实测指令速率，把 `g_tsc_div` 校准成
     `rate/1.19M`（限 4~64）；空闲快进在 paced 模式下也按
     `step/g_tsc_div` 推进 TSC（原来 1:1）。批处理/对拍
     （`g_pace_idle=0`）保持 1/17 + 1:1 快进，吞吐和结果不变。
     验证：默认 `top` 25s 5 帧（5s 间隔），`top -d 1` 12s 10 帧。

103. **启动日志清零：PCI 配置空间读回与 inittab 的 openrc 三连**。标准固件的
     串口日志一直是下面 4 行（后面才是 `login:`），看起来像启动失败：

     ```
     [    0.696666] PCI: Fatal: No config space access function found
     can't run '/sbin/openrc': No such file or directory
     can't run '/sbin/openrc': No such file or directory
     can't run '/sbin/openrc': No such file or directory
     ```

     **（a）PCI：配置地址口 0xcf8 不可读 ⇒ 内核放弃整条枚举**。
     `src/dev.c6` 的配置空间原来只实现了「`0xcfc` 起 1 字节读」，
     `0xcf8..0xcfb`（配置地址寄存器）读出去全是 `0xff`。Linux x86 的
     `pci_check_type1()` 是这样探测 type-1 机制的：

     ```
     outb(0x01, 0xCFB);                  /* 先动一下地址高位 */
     tmp = inl(0xCF8);
     outl(0x80000000, 0xCF8);
     if (inl(0xCF8) == 0x80000000 &&     /* ← 这里读回 0xffffffff，探测失败 */
         pci_conf1_read(0,0,0,0,2,&tmp) == PCIBIOS_SUCCESSFUL)
             works = 1;
     ```

     读回比对失败 → `pci_arch_init()` 打印 `PCI: Fatal: ...` 并让
     `raw_pci_ops` 保持空，后面所有 PCI 访问都没有实现（loglevel=7 时还能
     看到 `PCI: System does not support PCI`）。

     修法：
     - `0xcf8..0xcfb` 按字节通道读回 `g_m.pci.addr`（写侧同样按字节通道，
       原来 outb 到这四个字节任意一个都覆盖低字节）；
     - `0xcfc..0xcff` 按字节通道读写 `config[]`——`inb/inw/inl` 都是
       `io_r8` 拼出来的，所以 `pci_conf1_read` 的 1/2/4 字节访问一起修好；
     - BAR/ROM（`0x10..0x30`）本机一个都没实现：忽略写、读回 0。否则内核
       探测 BAR 大小时写 `0xffffffff`，会在假设备上读回 4GiB 资源
       （loglevel=7 曾出现 `pci 0000:00:00.0: ROM [mem 0x0-0x7ff pref]`）；
     - 头布局按 PCI 规范摆正：vendor `8086` / device `1237`（i440FX 主机桥）/
       base class `0x06`（即 `0x060000`）/ header type 0 / status 不带
       capability 链（0x10 位会让内核去 0x34 找 capability 指针）。

     **（b）`pci=off` 与「想枚举 PCI」互斥**。设备模型修好之后仍然会打印
     那行 Fatal：`pci=off` 把 `pci_probe` 清成 0，`pci_direct_probe()` 直接
     返回 0，`pci_arch_init()` 只能报「没有访问函数」。所以默认 cmdline
     统一从 `pci=off` 换成 `pci=conf1`（显式 type-1，跳过 BIOS/MMCONFIG
     探测）：`tools/boot_login.py`、`tools/release.py`、
     `tools/make_demo_gif.py`、`tools/wasm_tty.js`、`tests/*.js`、README
     的固件示例、`src/machine.c6` 的 `default_cmdline`，共 18 处。

     **（c）openrc：minirootfs 里没有这个程序**。Alpine 自带的
     `/etc/inittab` 有三行 `::sysinit:/sbin/openrc sysinit`、
     `::sysinit:/sbin/openrc boot`、`::wait:/sbin/openrc default`，busybox
     init 逐条 fork/exec，全失败就打印三次 `can't run '/sbin/openrc'`。
     `tools/mkfw.py` 生成 `/init` 本来就会改 inittab 注入
     `ttyS0::respawn:-/bin/login`，现在先 `sed -i -e '/sbin\/openrc/d'` 把
     三行（含 `::shutdown:` 那行）删掉再注入。

     **验证**（默认 cmdline 是 `earlycon=... loglevel=7 ... pci=conf1`）：
     - 默认固件跑到 1.5B 条（`--stopt=1500000000`）：串口 15425 字节，
       `PCI: Using configuration type 1 for base access` 和
       `pci 0000:00:00.0: [8086:1237] type 00 class 0x060000` 都在，
       `PCI: Fatal` / `openrc` 各 **0 行**，最后是 `(none) login:`；
     - 更早的安静配置（loglevel=4）同样跑到 1.5B：串口**只有 56 字节**
       （`(none) login: ` ×4，批处理下 stdin EOF 被 respawn），同样 0 报错——
       说明那两类输出不是被 `loglevel` 压掉的，是真没了；
     - `tools/boot_login.py` PASS（880 字节 LOG，earlycon 起就有输出，
       `uname -m` = `x86_64`）；`tests/wasm_login.js`（wasm 侧仍是
       loglevel=4 的 cmdline）`WASM LOGIN OK`，49s / 792M 条 / 418 字节；
     - `./build.sh test` 全过、`tools/difftest` **1252/1252**。

     **顺带记录**：`pci=conf1` 让内核真的枚举到 8086:1237 之后，
     `pci 0000:00:00.0: Limiting direct PCI/PCI transfers` 是 i440FX 的
     正常 quirk 输出（KERN_INFO，loglevel=4 看不到），不是错误。

103. **TSC 2.4GHz：`/proc/cpuinfo` 的 CPU MHz、BogoMIPS 和 watchdog**。
     guest 里原来有 `tsc: Fast TSC calibration failed` / `Unable to
     calibrate against PIT` / `No reference (HPET/PMTIMER) available` ——
     模拟器没实现 PIT 通道 2、HPET 和 ACPI PM timer，TSC 校不准，
     `cpu_khz = 0`，`/proc/cpuinfo` 的 cpu MHz 显示 0.000，clocksource
     回落到 refined-jiffies；BogoMIPS 77.8 是解释器真实的 delay-loop 速度。

     只把 CPUID 0x16 报成 2400MHz 不行：内核会相信 TSC 就是 2.4GHz（实际
     只有 ~1.19MHz），`delay_tsc`/`udelay` 慢约 2000 倍，引导期 NMI 自检
     卡 26 秒（`BUG: soft lockup`），clocksource watchdog 报 -505ms skew。

     最终实现（`machine.c6`/`dev.c6`/`cpu.c6`）：
     - TSC 真跑 2.4GHz：每条指令加 `g_tsc_mul`；native 用 clock_gettime、
       wasm 用 `sim_set_host_ms()`，每 150ms 按实测指令速率重算 mul，
       让 guest 的 TSC 时间≈墙钟。对拍/批处理（native 非 tty、wasm
       `sim_set_paced(0)`）不校准，固定 `g_tsc_mul = 160`，native/wasm
       逐字节一致；只有交互/浏览器才按墙钟校准。
     - PIT 仍是独立的 1.193182MHz：`dev_tick` 里按
       `delta_tsc * 1193182 / 2400000000` 换算成 PIT 时钟；mode 2/3 周期、
       mode 0 one-shot 都要投 IRQ0（TSC clocksource/NO_HZ 会用 one-shot）。
     - `dev_tick` 从「每 0x40000 条指令」改成「每 ~1ms TSC」触发，否则
       HZ=300/PIT 周期下会丢 tick，NO_HZ 的 sleep 被拉长甚至卡住。
     - CPUID 0x16 报 base/max/bus = 2400/2400/100MHz，基本叶子上限 0x16。
     - cmdline 加 `tsc=unstable`：内核不去跑 tsc-early 的 watchdog（否则
       tsc-early 与 refined-jiffies 的 101ms epoch 差会把它标 unstable），
       但 TSC 频率是真的，`delay_tsc`/`udelay` 仍正确，BogoMIPS 按 2.4GHz
       算成 4801；时间走 refined-jiffies/PIT，引导 46s、top/ping 正常。

     验证：`/proc/cpuinfo` 2400.000、BogoMIPS 4801、无 watchdog/soft
     lockup、`date`/`sleep` 准确、`top -d 1` 12s 9 帧；`build.sh test`、
     `boot_login`、`wasm_net_proxy`、`browser_e2e` 全过。

104. **启动回归修复（本轮）**：`2ad2583`（CPUID 0x16）之后 900M 条到不了
     login，并且 wasm/native 对拍在低 1MB 出现分叉。根因有四层：
     - **cmdline 传参**：`sim_set_cmdline` 收的是 wasm 线性内存偏移，测试却
       直接传 JS 字符串（=垃圾指针），于是 wasm 一直用固件内建 cmdline，
       native 用 `--cmdline`，boot_params/cmdline 在低 1MB 就不同 → chunk 0
       差异、1M 起 r1 分叉。修：`sim_set_cmdline` 真正拷贝到 `g_sim_cmdline`
       并置 `g_sim_cmdline_set`；`machine_boot_staged` 只在调用者没给 cmdline
       时才用固件内建（`g_boot_user_cmdline_set`）；测试统一把串写进
       `sim_fw_stage_ptr()+fw.length` 再传偏移（不再写死 0x0d800000）。
     - **RTC**：native 用宿主时间、wasm 用固定 epoch，开机路径读 RTC → 随机
       分叉。新增 native `--rtc=SECS`；wasm_cmp/fixed/snap 两侧都固定
       `1795000000`。
     - **clocksource**：CPUID 0x16 报 2400MHz（现在 TSC 也真跑 2.4GHz，
       见 §103），但 `tsc-early` 和 refined-jiffies 有 ~101ms epoch 差，
       watchdog 会把它标 unstable → `No current clocksource`，内核时间基
       停摆；并且 `noapic nolapic` 下内核走 8259/PIT，SMP 初始化后卡死。
       修：`machine_boot` 统一从 guest cmdline 里剥掉 `noapic/nolapic`，
       并在用户没写时追加 `tsc=unstable`（时钟源走 refined-jiffies/PIT，
       `delay_tsc`/`udelay` 仍按真实 2.4GHz TSC 算）。实测 native/wasm
       都在 830M 条前到 `(none) login:`；wasm_login `MARK-OK`
       （829,716,603 条 / 52s），JIT 开/关串口 SHA 完全相同。
     - **工具/测试**：`parse_num` 支持 `0x`（`--memhash/--snap/--stopt`）；
       `sim_mem_hash_region(u32,u32)` 修 wasm 传参（原 u64 全区间同哈希）；
       `--dumpregs` 先补换行（payload 串口无结尾换行时 `[REG]` 被前缀吞）；
       wasm_login/fixed 的 `w` 未定义、boot_smoke 的安静 cmdline、snap 的
       RTC、payload_cmp 的默认 payload 等测试 bug 全修。
     **验收**：`./build.sh test`、difftest **1252/1252**、wasm_cmp 50M
     MATCH（JIT 0/1）、wasm_login MARK-OK（串口 SHA 一致）、`./build.sh jit`、
     boot_smoke/payload_cmp/fixed/snap/shrd/smoke 全过。PIT ch2 校准可后续
     补，但有了 §103 的 TSC 2.4GHz 已不阻塞 CPU MHz/BogoMIPS。


105. **`find /` 卡死 / 内核栈跑到用户栈（诊断中）**：guest 连续做大量
   `/proc`/`/sys` 访问（`find / > /dev/null`）时偶发整机自陷。`--rspcheck`
   （`bad_stack_ptr` 命中即停）抓到：
   - 停机点：`asm_exc_page_fault+0x0`，RSP=`0x7ffe...`（**用户栈**），
     但 CS 的 CPL=0；前 8 条 RIP 是 `common_interrupt+0x27..0x6b`，即外部
     中断在 **CPL=0 且 RSP 仍在用户栈**时投递，随后压栈/取页触发 #PF；
     递归 `get_stack_info_noinstr`（`ffffffff81bb728c`）在
     `ffffc90000003ff8`（vmap 栈底）反复缺页 → 死循环。
   - 已排除：`pcpu_hot.top_of_stack`（`gs+0x2e818`，CONFIG_CALL_DEPTH_TRACKING
     下偏移 0x18）正确指向任务内核栈顶（`ffffc900001e0000`）；TSS.sp0 正确
     （CEA 入口栈 `fffffe0000003000`）；SYSCALL 的 FMASK=`0x257fd5` 含 IF
     （0x200），入口前几条指令 IF=0；PIC 投递检查 IF；用户态异常经 TSS/CEA
     栈再 `sync_regs` 到任务栈，均正常。
   - 仍疑：某条入口/返回路径让内核在用户 RSP 上继续执行（疑似
     `entry_SYSCALL_64` 的 `mov %gs:top,%rsp` 或 `error_entry` 的栈切换
     在竞态下未生效），尚未定位到指令级。
   - 缓解：init 关 `debug/exception-trace` 与 `print-fatal-signals`——
     否则内核为用户的致命信号展开 vmap 栈底时再次缺页，整机必陷。
     关闭后**批处理** `find / > /tmp/find.out` 可跑完（22498 项）；
     交互/pty 下仍偶发（与用户栈边界有关）。
   - 探针（`C6_WASM` 外）：`--rspcheck`/`[RSPFIRST]`/`[RING64]`、`[PFT]`
     （同一内核地址反复缺页打 RIP/CR3）、`--no-pace`（关墙钟校准与 idle
     快进，便于逐条复现）。
   - **后续（§106）**：根因是中断投递晚了一条指令——`exc_pending` 的
     投递原本在 `cpu_step()` 之后，dev_tick 用 IF=1 抬起的定时器中断
     会先让 `syscall` 执行完（ring0 + 用户 RSP + IF=0），再把硬件帧压到
     用户栈上，栈指针在页边界时 #PF 递归自陷。已修复，并去掉 init 里
     关致命信号回显的临时措施。

106. **`find /` 卡死根因：中断投递晚了一条指令（本轮修复）**
   - 现象：guest 里 `find / > /dev/null` 偶发整机卡死；开机也偶发
     `login:` 前 `BUG: unable to handle page fault`。
   - 探针：`--rspcheck` 新增 `[DELBAD]`（内核态却用用户地址栈投递）、
     `[RSPSC]`（ring0+用户 RSP 出现在 syscall 入口/返回窗口之外）和
     `[RSPFIRST]` 的 CR2；命中即停机并打印 64 条 (RIP,RSP) 环。
   - 实测一次命中（约 13.7 亿条处）：
     `[DELBAD] vec=30 async=1 next_rip=ffffffff81c00080 rsp=7ffe... flags=46 if=0`
     —— 向量 0x30 是内核的 IRQ0_VECTOR（PIT），`next_rip` 正是
     `entry_SYSCALL_64`。
   - 机理：`machine_step_loop` 里 `if (exc_pending) cpu_deliver()` 原来在
     `cpu_step()` **之后**。`dev_tick()` 在循环尾用 IF=1 抬起定时器中断，
     下一轮却先执行了一条指令：若它是 `syscall`，CPU 已切到 ring0、
     RIP=LSTAR、RSP 仍是用户栈、IF 被 FMASK 清零；随后投递时 CPU 认为
     没有权限级变化，直接把 5 槽硬件帧压到用户栈上。用户栈指针正好
     落在页边界（栈底 guard page）时，`push` 触发 #PF；#PF 的投递同样
     在用户栈上压帧 → 页错误处理自陷。内核给用户致命信号展开 vmap
     栈底（`ffffc90000003ff8`）时也是同一条路走到死循环。
   - 修复：把挂起异常/中断的投递移到 `cpu_step()` **之前**——有 pending
     就只投递、本轮不再执行指令。同步异常顺延到下一轮顶部投递，与
     原来"指令执行后立刻投递"等价；HLT 唤醒路径不变（仍在 `dev_tick()`
     之后立刻投递）。
   - 连带清理：`tools/mkfw.py` 里"关 `debug/exception-trace` 和
     `print-fatal-signals`"的临时措施不再需要，已去掉，内核恢复默认的
     oops/致命信号栈回显。
   - 验证：native `find / > /dev/null` 连跑 15 次全完成（修复前 1~2 次
     内必卡，`[PFT]` 在 vmap 栈底打转）；`--rspcheck` 下 12 次无
     `[DELBAD]/[RSPSC]/[RSPFIRST]`；`./build.sh test` 全过、
     `boot_login.py` PASS、difftest 1252/1252、`wasm_cmp 50000000`
     MATCH、`wasm_login` MARK-OK。

107. **NAT 侧上游代理：`--proxy` / `--dns`（自动识别协议）**。背景：guest
     出网原来是直连宿主 socket。需要固定出口（或被墙）时，用户手里通常只有
     一个 HTTP/SOCKS 混合端口（hiddify 的 2334 之类），希望在 NAT 这一层就
     用上，而不是在 guest 里设 `http_proxy`（busybox wget 的 https 走的是
     `GET https://…` 而不是 CONNECT，代理不一定支持）。做法是把代理做成
     NAT 的拨号目标，全部在 `src/net.c6` 里完成：

     - **URL 语法**：`[scheme://][user[:pass]@]host[:port]`。scheme 支持
       `http`/`https`（都发 `CONNECT`）、`socks5`/`socks5h`/`socks`、
       `socks4`/`socks4a`；空串 / `none` / `direct` 关闭代理。只支持 IPv4
       与 `localhost`（NAT 没有 getaddrinfo）。省略端口按协议默认：http
       8080、https 443、socks 1080。
     - **自动识别**：不带 scheme 的 `host:port` 是 `PX_AUTO`——首次拨号前
       用一个临时连接发 SOCKS5 问候 `05 01 00`，看首个回包字节：`0x05` →
       socks5、`0x04` → socks4、`'H'`（HTTP 代理对二进制垃圾回 400）→
       http、读超时兜底 http。识别结果写回 `g_px.type`，只探测一次。
     - **握手状态机**（`conn_hs_*`，全非阻塞）：`hs_state` 1=连代理中、
       2=握手中、3=就绪；`hs_stage` 10=等 HTTP 响应头、20/21/22=SOCKS5 的
       方法选择/用户名密码/`CONNECT` 应答、30=SOCKS4 应答。`host_ok` 只在
       握手成功后置位，所以 guest 数据继续攒在原来的 `wbuf` 里，
       `conn_flush_wbuf` 一行没改；握手超时 12s（`hs_deadline`），失败直接
       RST 给 guest。shim 模式原有的「guest 第一个数据段才拨号」保留，
       只是拨号目标从远端换成了代理。
     - **认证**：HTTP Basic（`Proxy-Authorization`，自己实现 base64）、
       SOCKS5 用户名密码（RFC 1929）、SOCKS4 userid。
     - **一个容易丢字节的细节**：握手读到的多余字节属于隧道数据（SOCKS5
       应答和服务器首段数据粘在同一个 TCP 包里很常见），成功后按
       `hs_used` 把剩余部分搬回 `sbuf` 再交给 guest；否则首段数据被吞。
     - **DNS**：`--dns=ip[:port]` 覆盖 `/etc/resolv.conf` 和原来写死的 53
       端口（新增 `NetState.dns_port`）。现场例子：LAN 解析器
       `192.168.68.1` 把 `www.google.com` 答成 `69.171.235.22`（Facebook
       的 IP，污染），而 hiddify 的本地 DNS `127.0.0.1:6450` 给出真的
       `142.251.x`；`resolv.conf` 写不出端口，所以必须由 NAT 支持非 53。
     - **页面 / 网关**：页面新增「上游代理」「DNS」两栏，点连接时拼成
       `ws://…:8787/?proxy=…&dns=…`；`tools/ws_slip_proxy.js` 做字符集校验
       （这个网关没有认证，不能把任意字符串拼进子进程参数）后追加到
       `build/sim --netshim` 的参数里。native 直接跑同理：
       `build/sim --proxy=… --dns=… build/firmware.bin`。
     - **测试**：`tools/test_proxy.js` 是测试用的 HTTP CONNECT / SOCKS5 /
       SOCKS4 三合一代理（可开 Basic 与用户名密码认证，并模仿真实 HTTP
       代理对二进制垃圾回 400 以便测自动识别）；`tests/netshim_proxy.js`
       不跑 Linux，用合成 SLIP 包驱动 `build/sim --netshim`，几秒内覆盖
       20 项：无代理回归、http/socks5/socks4、自动识别两条路径、两种认证、
       错误密码（guest 收到 RST 且不过数据）、`--dns` 覆盖。
     - **实测**：`node tests/netshim_proxy.js` → 20/20 PASS；
       `C6_TEST_PROXY=http://127.0.0.1:18999 C6_TEST_DNS=127.0.0.1:6450
       node tests/wasm_net_proxy.js`（真实 wasm guest，上游是本仓库的
       测试代理）→ 登录 + ping 10.0.2.2 + `wget http://example.com/` 全过，
       代理侧日志 `HTTP 104.20.23.154:80`（example.com 的解析结果），
       说明 guest 的 TCP 确实从代理走的；`wasm_net_proxy.js` 新增
       `C6_TEST_PROXY`/`C6_TEST_DNS` 两个环境变量就是给这种跑法用的。
     - **限制**：只代理 TCP；UDP/ICMP 仍直连（DNS 靠 `--dns` 指到干净解析器
       解决，还没有 DNS-over-proxy / SOCKS5 UDP ASSOCIATE）；不支持 IPv6 和
       域名形式的代理主机；`--netshim` 本来就把宿主网络给了 guest，WS 网关
       也没有认证，仍然只能绑 127.0.0.1 或可信网段。

108. **C6FW v2：在模拟器里引导 c6os + Alpine（本轮新增）**
   - 目标：`~/rtos-c6` 的 x86-64 内核（c6os）已经能在 QEMU 里把 Alpine
     的 musl rootfs 跑到 shell；同一份内核 + initramfs 也要能在 native 和
     浏览器里起来，页面还可以直接选本机 `.bin`。
   - **固件格式 v2**：还是 64 字节头、`'C6FW'` 魔数，只把 `version` 从 1
     改成 2；字段与 v1 同序，v1 的 cmdline 槽（`+32/+36`）借给 `/data`
     的 FAT 镜像：

     | 偏移 | 字段 | v2 含义 |
     | --- | --- | --- |
     | +0 | `'C6FW'` | 魔数 |
     | +4 | u32 version | 2 = c6os/Alpine |
     | +8 | u32 hdr | 64 |
     | +16/+20 | kernel_off/len | c6os 平铺内核（`stage2.bin`）|
     | +24/+28 | rootfs_off/len | Alpine initramfs（`u64 长度 + 512 填充 + newc cpio`）|
     | +32/+36 | data_off/len | `/data` 的 8MiB FAT16 镜像（`data.img`）|

     `tools/mkc6os.py` 默认从 `~/rtos-c6/build/x86/iso/stage2.bin`、
     `~/rtos-c6/build/x86/alpine/full.cpio`、`…/data.img` 取材
     （`--no-data` 可以不带盘），`./build.sh c6os` 是它的入口。
   - **内存布局**：不能复用 Linux 引导那套低地址（PD `0x5000`、GDT
     `0x7000`、IDT `0x8000` 会压在 c6os 的 E820 表和引导块上），
     `machine_boot_c6os` 重新排：

     | 物理地址 | 用途 |
     | --- | --- |
     | `0x1000` | IDT（256 × 16B）|
     | `0x2000/0x3000/0x4000` | PML4 / PDPT / PD（恒等映射 0..128MiB，2MiB 大页）|
     | `0x5000` | E820：count @0x5000，条目 24B/条 @0x5010 |
     | `0x5400` | GDT（CS=0x08、DS/ES/SS=0x10）|
     | `0x7000` | 引导信息块：magic `'C6IS'`、version=1、flags=1、kernel/rootfs pa+len、data_lba |
     | `0x11000..0xA0000` | c6os 内核（`stage2.ld` 断言 `__bss_end <= 0xA0000`）|
     | `0x800000` | Alpine initramfs（13.1MB）|
     | `0x07800000..0x08000000` | `/data` 的 FAT16 盘镜像 |

     E820 的 usable 项上界停在 `ATA_DATA_PA`，否则 c6os 的页分配器会把
     顶部 8MiB 当空闲页框踩掉盘上的数据。CPU 状态按 c6os 的契约设：
     `rip=0x11000`、`cr3=0x2000`、`cr4=PAE|PSE|OSFXSR|OSXMMEXCPT`、
     `efer=SCE|LME|LMA|NXE`、`lstar=0xffffffffffff0000`，与 Linux 引导的
     `0x10/0x18` 选择子不同。
   - **ATA PIO 主盘**：`src/dev.c6` 补了 `0x1F0..0x1F7` + `0x3F6` 的最小
     PIO：LBA28、READ(0x20)/WRITE(0x30)/FLUSH(0xE7)、每交付 512 字节按
     多扇区计数清/拉 DRQ、`inw 0x1F0` 走 16 位数据口（不能拆成
     `io_r8(0x1F0)+io_r8(0x1F1)`，后者是 error 寄存器）。盘内容就是
     `ATA_DATA_PA` 起的 8MiB；c6os 的 `port/x86_64/ata.c` 只用 PIO，正好
     对得上，`LOS_FsMount(..., "fatfs")` 能挂上 `/data`。写落在客户机
     RAM 里，刷新页面即丢，宿主磁盘不受影响。
   - **native/wasm 入口**：`machine_boot_c6os_fw` 与 `wasm.c6` 的
     `sim_init` 都先认 `version==2` 再回落 v1；v2 分支校验 kernel/rootfs/
     data 槽不越界后直接 `machine_boot_c6os`，不再走 Linux 的
     `machine_load_firmware`。页面「固件与网络」新增「本地固件」文件选择
     （`#fwfile`），`FileReader` 读进 `FW_STAGE` 后 `sim_init`；URL 与
     本地文件共用 `bootFirmware()`，`WASM_VER` 升到 2.2。
   - **实测**：native `timeout 90 ./build/sim --no-pace build/c6os.bin` →
     E820 4 项、`cr3=00409000`、rootfs 667 节点、`/data = FAT16 数据盘`，
     约 7700 万条到 Alpine 用户态，busybox sweep 打出
     `OK|echo / OK|printf / OK|cat / …`（90s 只看得到前半段）；
     wasm（node，clang -O2）同样 7700 万条、5.7 秒出现
     `bx-sweep-alive`；`node tests/browser_e2e.js` 用 `#fwfile` 选
     `build/c6os.bin` 后能读到 `c6os alpine M12` 串口日志。
   - **限制**：内核必须整体落在 `0x11000..0xA0000`（c6os 的链接断言），
     超过会返回 -2；sweep 有 300 多个 applet，全量跑完要几分钟（不是卡死）；
     c6os 目前没有 e1000 驱动（`net: 没有 e1000`），网络相关 applet 会失败；
     `/data` 不持久化。

109. **#PF 错误码漏了 P 位：COW 写被当成缺页（本轮修复）**
   - 现象：c6os 的 Alpine 在 native/wasm 里一进 `/bin/sh` 就 SIGSEGV：
     `exc vec=14 err=6 cr2=0x7fffffffd538 rip=0x7f000004397b`，RIP 在 musl
     ld.so 的 `call` 上（`push` 返回地址），进程随即被杀；同一个 ISO 在
     QEMU 里能跑完 busybox sweep，所以是模拟器语义差异，不是 guest 的 bug。
   - 根因：`src/mem.c6` 的 `pg_fault()` 只拼了 `(wr?2:0)|(us?4:0)`，
     **bit0（P）永远是 0**。`fork` 之后父子进程的栈页是「存在 + 只读」
     （COW），父进程 `call` 压栈写该页时硬件应报 `P=1,W=1,U=1`（err=7），
     模拟器却报 6。c6os 的 `x86_exc_dump` 按 bit0 分流：P=0 走
     `lx_vma_fault` 的按需补页，`port_as_map_zero` 看到 PTE 已存在返回失败，
     于是把信号投成 SIGSEGV；QEMU 报 P=1，走 `port_pf_resolve` 的 COW
     路径复制一页就好了。
   - 修复：`pg_fault` 增加 `present` 参数并置 bit0；四个调用点里
     「层级不存在」传 0，「U/S 违规、只读页写、NX 取指」传 1。
     这同时让 Linux 的 COW 缺页错误码与真机一致（以前 Linux 也是靠
     `handle_pte_fault` 自己再看 PTE 才没出事）。
   - 验证：修复后 c6os 在 native/wasm 都能跑 Alpine 用户态（见 §108 的
     `OK|…` 日志）；`./build.sh test` 全过，回归见提交说明。

110. **`build/sim --serve`：把 WS/HTTP 网关并进模拟器（去掉 Node）**
   - 背景：浏览器页面只有 fetch 和 WebSocket 两种字节通道，拿不到裸
     `socket()`；hiddify 的 mixed 端口是 SOCKS5/HTTP CONNECT 隧道协议，
     WS 的 `Upgrade` 握手它不认。所以「SLIP ↔ 宿主 socket」的转接必须
     有一个宿主进程，页面直连代理做不到。原来的宿主进程是
     `tools/ws_slip_proxy.js`（每个 WS 连接再 spawn 一个
     `build/sim --netshim`）；本轮把这一层直接并进 `build/sim`。
   - 用法：`./build/sim --serve [--port=8787] [--web=web]`，一个 native
     进程同时是静态站 + WS 网关 + NAT。`--serve` 只绑 127.0.0.1，不要
     暴露到公网。
   - `src/wsgate.c6`（native-only，`#if !defined(C6_WASM)`）：
     - **HTTP**：读 `GET` 请求头，`web/` 下按路径发文件（`/` →
       `index.html`、MIME 按扩展名、`Content-Length`、`Cache-Control:
       no-store`）；`/__c6sim` 回 `{"gateway":1,"ws":"/ws"}` 给页面探测；
       `..` 路径直接 403，未知路径 404，非 GET 405。
     - **WebSocket**：标准 101 握手（`SHA-1(key+GUID)` → base64，自己写
       了 SHA-1/base64，不依赖 string.h）；客户端帧按 mask 解出
       payload，支持多 WS 消息拼一个 SLIP 帧（页面每 4ms 发一片）、
       ping→pong、close；NAT 的回包用 0x82 二进制帧发回。
     - **NAT 接线**：`g_net_shim=1; net_reset();`；WS payload 逐字节喂
       `slip_rx_byte()`，`net_tick()` 在主循环里跑；`dev.c6` 的
       `serial2_feed()` 在 `g_wsgate_on` 时改走 `wsgate_out()`，不再写
       stdout。主循环 `poll()` 同时看 listen fd 和唯一的 WS fd。
     - 限制：一次一个 WS 客户端（第二个连接会顶掉第一个）；HTTP 连接
       顺序处理；没有 TLS（GitHub Pages 那种 HTTPS 场景仍需外部网关）。
   - **页面探测**：`app.js` 的 `detectGateway()` 在 wasm 初始化后
     `fetch('__c6sim')`，有 gateway 就把「网络代理」地址自动填成同源
     `ws://<host>/ws`，并提示点「连接」；普通静态服务器没有这个端点，
     保持手填。
   - **不引导 guest**：`--serve` 只跑网关，guest 仍是页面里的 wasm；宿主
     终端只有网关事件（WS 连接/断开），native 启动日志用
     `./build/sim build/c6os.bin`。带固件参数时会给一行忽略提示。
   - **实测**：`tests/serve_e2e.js` 10/10——`/__c6sim`、`/index.html`、
     `/sim.wasm` 长度、404、WS 101 握手、把一帧 SLIP 拆成两条 WS 消息
     后仍能收到 `10.0.2.2` 的 ICMP echo reply（源/目的/ID 都对）、整帧
     重发也通；`browser_e2e` 里导航到 `--serve` 发的页面，确认
     `proxyurl` 被自动填成 `ws://127.0.0.1:<port>/ws` 且能连上。
   - `tools/ws_slip_proxy.js` 保留：页面部署在 GitHub Pages、或想用
     `python3 -m http.server` 发页面时仍走它；`--netshim` 模式也保留，
     两者共用 `src/net.c6` 的同一套 NAT。
