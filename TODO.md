# x64simc6 TODO（按阶段推进，完成一项勾一项）

> 详细方案见 [`docs/DESIGN.md`](docs/DESIGN.md)。原则：先让最小 payload 跑起来，再上真 Linux，最后上 web。

## 阶段 1 —— 设计（已完成）

- [x] 写详细设计文档 `docs/DESIGN.md`
- [x] 写本 TODO 文档
- [ ] 设计评审后按需修订（若实现中发现偏差，更新 DESIGN.md 的"实现偏差"小节）

## 阶段 2 —— 工程骨架与工具链验证

- [ ] 建立目录结构：`src/ tools/ web/ tests/ docs/ build/`
- [ ] `build.sh` 支持 `native` / `wasm` / `fw` / `test` / `clean`
- [ ] c6c 编译最小 `.c6` 程序为 native 可执行文件并跑通
- [ ] tcc-c6 `--target=wasm32-unknown-unknown` 编译同一份源码为 `.wasm`，node 里实例化并调用导出函数
- [ ] 验证 128MiB 静态数组在 wasm 中可分配（初始内存 256MiB）
- [ ] 验证导出函数签名用 `uint64_t` 参数/返回值在 wasm32 下的 ABI（避免 `long`）
- [ ] `tests/test_cpu.c6`：`test "..."` 块的最小运行（c6c -test）

## 阶段 3 —— CPU 核心

- [ ] `src/types.c6`：类型、位宏、日志、 guest 内存读写辅助
- [ ] `src/mem.c6`：RAM 数组、物理读写、MMIO 分派表、页表遍历（4KiB/2MiB）
- [ ] `src/cpu.c6`：CPUState 结构、RFLAGS、寄存器访问
- [ ] 取指/前缀/REX/ModRM/SIB/立即数解码
- [ ] 数据传送组：mov / lea / movzx / movsx / push / pop / xchg / setcc / cmovcc
- [ ] 算术逻辑组：add/adc/sub/sbb/cmp/test/and/or/xor/inc/dec/neg/not/mul/div/imul/idiv
- [ ] 移位/位操作组：shl/shr/sar/rol/ror/bt/bts/btr/bsf/bsr/bswap/shld/shrd
- [ ] 控制流组：jmp/jcc/call/ret/loop/iret/int
- [ ] 字符串组：movs/stos/lods/scas/cmps + rep/repne
- [ ] 系统组：cpuid / rdtsc / rdmsr / wrmsr / mov cr,dr / lgdt/lidt / swapgs / syscall / hlt / ud2 / pause / invlpg / xgetbv
- [ ] FPU/SSE 最小组：fxsave/fxrstor / movaps/movups/movq/pxor/xorps / ldmxcsr/stmxcsr
- [ ] I/O 组：in / out（8/16/32 位，含字符串形式）
- [ ] 异常投递：#GP/#UD/#PF/#DF，IDT gate 读取、栈帧压入、错误码
- [ ] 未知 opcode 诊断：打印 RIP/字节并停机，不静默继续

## 阶段 4 —— 设备与 Linux 直接引导

- [ ] `src/dev.c6`：16550A 串口（THR/RBR/IER/IIR/LCR/LSR/MSR/DLL/DLM，环形缓冲，IRQ4）
- [ ] `src/dev.c6`：8259A PIC（ICW/OCW/EOI，IRR/ISR）
- [ ] `src/dev.c6`：8254 PIT（channel0 mode3，按指令数推进，IRQ0）
- [ ] `src/dev.c6`：CMOS/RTC、PCI 配置空间（仅 host bridge）、LAPIC 最小 MMIO、debug exit 端口
- [ ] `src/boot.c6`：C6FW 头校验与装入
- [ ] `src/boot.c6`：bzImage setup_header 校验、内核搬到 1MiB、initrd 搬到 32MiB、cmdline 搬到 0x20000
- [ ] `src/boot.c6`：boot_params + e820 表填充
- [ ] `src/boot.c6`：长模式页表（PML4/PDPT/PD，2MiB 大页，覆盖 128MiB）
- [ ] `src/boot.c6`：CPU 初态与 GDT/IDT 初始化，RIP=1MiB、RSI=boot_params
- [ ] `src/machine.c6`：Machine 组装、run loop、指令/周期统计、halt 处理

## 阶段 5 —— 测试 payload 与真内核

- [ ] `tools/hello64.py`：生成手汇编 64 位 payload（写串口字符串 + out 0xf4 退出）
- [ ] native 跑 payload，串口得到 `C6SIM64 OK`，退出码正确
- [ ] 获取一个真实 x86-64 bzImage（Alpine ISO 的 vmlinuz 或自行编译的小内核）
- [ ] native 直接引导真内核 + 极简 initramfs，串口出现 Linux 启动日志
- [ ] 逐步补 Linux 启动期缺的 opcode / MSR / 设备（按诊断迭代）

## 阶段 6 —— Alpine 固件

- [ ] `tools/mkfw.py`：C6FW 头写入/校验
- [ ] 支持从 Alpine ISO 用 `7z` 提取 `vmlinuz-lts` + `initramfs-lts`
- [ ] 支持从 Alpine minirootfs tarball 生成 cpio.gz（含自定义 /init：挂载 proc/sys/dev，启动 ttyS0 上的 sh）
- [ ] 产物 `firmware.bin` 可被 native 模拟器直接加载
- [ ] native + Alpine 固件引导到 `localhost login:`，输入 `root` 能进入 shell
- [ ] `docs/ALPINE.md` 记录固件来源、版本与重建命令

## 阶段 7 —— wasm 与浏览器

- [ ] `src/wasm.c6`：`sim_init / sim_reset / sim_run / sim_status / sim_serial_out / sim_serial_in / sim_stat_insns / sim_ram_base`
- [ ] wasm-ld 参数：`--no-entry --export-all`，initial 256MiB / max 512MiB
- [ ] node 冒烟：实例化 → 写固件 → 调 `sim_run` 若干次 → 读串口输出
- [ ] `web/index.html` + `web/style.css`：终端样式、状态栏、按钮
- [ ] `web/app.js`：fetch 固件、驱动 sim、串口终端、键盘输入、暂停/继续/重启、MIPS 显示
- [ ] 浏览器手工验证：能看到 Alpine 登录提示并输入 root
- [ ] 可选：终端渲染改用 xterm.js（若需要 ANSI 转义支持）

## 阶段 8 —— 收尾

- [ ] `tests/smoke.sh`：native payload + wasm node 冒烟一条命令跑完
- [ ] `./build.sh test` 全绿
- [ ] `README.md`：快速开始、目录说明、已知限制、性能说明
- [ ] DESIGN.md 补"实现偏差"小节（记录与设计的不同及原因）
- [ ] 用 worktree finish 提交/合并（若当前目录不是 git 仓库则跳过）
