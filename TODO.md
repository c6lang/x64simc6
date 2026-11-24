# x64simc6 TODO（与实际实现同步更新）

> 详细方案见 [`docs/DESIGN.md`](docs/DESIGN.md)。本文件只记录**真正做过/正在做的事**：勾选项=已落地且可编译/可运行，未勾选项=尚未完成。阶段编号沿用设计文档。

## 阶段 1 —— 设计（已完成）

- [x] 写详细设计文档 `docs/DESIGN.md`
- [x] 写本 TODO 文档
- [x] 补充 wasm 真实网络 + 页面存储当文件系统的硬性需求（DESIGN.md §10.1）
- [x] 记录 c6 扩展在 wasm32 下的 ABI 限制与对策（DESIGN.md §13）
- [x] 设计评审后按需修订（实现中发现 interface/f-string 不可用，已写入偏差）

## 阶段 2 —— 工程骨架与工具链验证

- [x] 建立目录结构：`src/ tools/ web/ tests/ docs/ build/`
- [x] `tests/toolchain_probe.c6`：native 编译通过、wasm 编译通过、256 MiB 静态数组可用、导出函数签名验证
- [x] 确认 wasm32 下 64 位必须用 `unsigned long long`（`unsigned long` 是 32 位）
- [x] `tests/c6_features_probe.c6`：native 接口/方法/切片/foreach/元组/defer/err/catch/f-string 全通过
- [x] `tests/c6_features_wasm.c6`：wasm 下方法/切片/foreach/元组/defer 通过
- [x] `tests/if_probe.c6`：定位 wasm 接口转换崩溃的根因（LP64 胖指针 vs 32 位 helper）
- [x] `build.sh`（native / wasm / all / fw / test / clean）：native 与 wasm 产物均可构建
- [x] `tests/test_cpu.c6`：native 单元测试（复位、串口默认值、hostfs 往返、payload 停机），由 `./build.sh test` 编译运行

## 阶段 3 —— CPU / 内存核心（代码已落地，等待冒烟验证）

- [x] `src/c6sim.h`：类型、常量、CPUState/Machine/Operand 结构、跨模块声明（原计划的 `types.c6` 合并进这里）
- [x] `src/mem.c6`：128 MiB RAM、MMIO 分派、4 级分页（4K/2M/1G）、TLB、缺页异常
- [x] `src/cpu.c6`：前缀/REX/ModRM/SIB 译码、GPR/标志、ALU/移位/位操作/乘除、控制流、字符串指令、I/O、系统调用、MSR/CPUID、FPU/SSE 最小集、异常投递
- [x] `src/cpu.c6` 暴露 c6 方法 `c->step()` / `c->deliver()`，枚举命名空间用于异常号；取指元组在 wasm 下因后端解构偏移错误改为 packed `u64`（见 DESIGN.md §13）
- [x] native 全量链接通过：`c6c -I src src/mem.c6 ... src/main.c6 -o build/sim`
- [x] `tools/hello64.py` 生成 47 字节 64 位手汇编 payload；`./build/sim --payload build/hello64.bin` 输出 `C6SIM64 OK`，26 条指令后正常停机（退出码 0）
- [x] `tests/test_cpu.c6` 覆盖复位、RAM 清零、hostfs 往返与 payload 停机；ALU/ModRM/分页的更细粒度用例待补

## 阶段 4 —— 设备与 Linux 直接引导（代码已落地，等待真内核验证）

- [x] `src/dev.c6`：16550A、8259A、8254、CMOS、PCI 配置空间、LAPIC MMIO、debug exit 端口
- [x] `src/boot.c6`：C6FW 头解析、e820、boot_params、页表/GDT/IDT、长模式 CPU 初态
- [x] `src/machine.c6`：机器复位、方法 `m->run()`、指令/TSC 统计、中断节拍
- [x] `src/host.c6`：宿主无关诊断输出
- [x] `src/main.c6`：native CLI，使用 defer / errdefer / err / try / catch / f-string / 枚举命名空间
- [x] native 加载真实 bzImage+initrd 引导到串口日志——已输出 `Linux version 6.6.142-0-lts`、`BIOS-e820`、`earlycon: uart8250`、`RAMDISK`、`Zone ranges`、`mem_init`、`ftrace`、`printk: console [ttyS0] enabled`、`APIC disabled by BIOS`、`clocksource: refined-jiffies`
- [x] 指令级差分测试器 `tools/difftest`（本机 CPU vs 模拟器）：348 条基础指令 + 800 组随机序列，1160/1160 一致
- [x] 扩大范围随机差分测试 `tools/difftest/fuzz2.py`（全寄存器、SHLD/SHRD/IMUL/BT/rotate/SETcc/CMOV/XADD/BSWAP/ADC），并据其修正 SHLD/SHRD 零计数零扩展与 IMUL/SHLD 标志位
- [x] 补 sgdt/sidt（store_idt/load_idt）、clts/invd/wbinvd、invlpg 与 smsw/lmsw
- [x] wasm 运行库重建（`~/c6/scripts/build-wasm-runtime.sh`）：`./build.sh test` 全绿，`node tests/browser_e2e.js` 通过
- [x] 按差分测试修正乘除/移位/旋转/标志位/位操作/`mov sreg` 语义（见 DESIGN.md §13.16–13.18）
- [x] 按诊断补 Linux 启动期缺项：MOV CR ModRM 操作数顺序、MOV r/m,reg 方向、MOV imm64/imm32 符号扩展、长模式 near call 64 位、SIB 无基址、FS/GS 段前缀、ENDBR64、0F 18 NOP、全部 PT_LOAD 装载、内核高半区页表；仍需继续排查自旋

## 阶段 5 —— Alpine 固件

- [x] `tools/mkfw.py`：C6FW 头 + bzImage gzip/xz 解压 + ELF PT_LOAD 抽取 + 内核/命令行/initrd 打包
- [x] 从 Alpine 3.20 CDN 下载 `linux-lts-6.6.142-r0.apk`（含 `vmlinuz-lts`）与 `alpine-minirootfs-3.20.3-x86_64.tar.gz`
- [x] minirootfs → cpio.gz，注入 `/init` 与 `ttyS0` 的 getty；固件 `build/firmware.bin` 已生成（kernel 19.8 MiB + initrd 3.3 MiB）
- [ ] native + Alpine 固件引导到 `localhost login:` 并进入 shell——现已通过 `unwind_init` ORC 自检、`mem_init`、`sched_init`、`int3` 自检、x87 初始化，进入 `arch_cpu_finalize_init` 的 alternatives 补丁阶段；在 `apply_paravirt`/`insn_decode` 返回时出现栈损坏（返回地址槽被帧指针值覆盖），未到登录提示；已修「异步中断当同步故障」的 RIP 回退 bug（引导推进到 3.75s，约 66×）；当前卡在 genl_op_from_small 的 RSI 被中断路径改写

## 阶段 6 —— wasm 与浏览器

- [x] `src/wasm.c6`：`sim_init / sim_load_payload / sim_reset / sim_run / sim_status / sim_serial_out / sim_serial_in / sim_set_cmdline / sim_stat_insns / sim_ram_base`
- [x] wasm-ld 参数：`--no-entry --export-all`，initial 256 MiB / max 512 MiB；`web/sim.wasm` 无 import
- [x] node 冒烟 `tests/wasm_smoke.js`：实例化 → 写 payload → 运行 → 读串口，输出 `C6SIM64 OK`，26 条指令后停机
- [x] `web/index.html` + `web/style.css` + `web/app.js`：固件/网络下载、Cache Storage 缓存、IndexedDB 文件表与串口快照持久化、bridge 事件注入；headless Chromium 端到端验证通过
- [ ] 浏览器验证 Alpine 登录提示与 root 输入

## 阶段 7 —— wasm 网络与页面存储（用户新增硬性需求，DESIGN.md §10.1）

- [x] `src/wasm.c6` 侧 `sim_host_bridge()` / `sim_host_event()` 64 KiB 共享邮箱 + 事件分派（1=NET_RESPONSE, 2=STORAGE_LOADED, 3=USER_INPUT）
- [x] `fetch()` 拉固件（URL 输入、进度、3 次重试）+ Cache Storage 缓存 + IndexedDB 文件持久化
- [x] `src/hostfs.c6` 文件表（32 槽 × 256 KiB = 8 MiB，dirty 标记）+ `sim_hostfs_import/export/put/get`；JS 启动时导入 IndexedDB、运行期导出回写，端到端验证通过
- [x] 串口日志写入 IndexedDB `meta`，刷新页面后恢复；指令计数存 localStorage
- [x] 预留 virtio-net / c6blk 设备接口：MMIO 寄存器桩（0xfeb00000 / 0xfeb01000）

## 阶段 8 —— 收尾

- [x] `tests/smoke.sh` 一条命令跑 native + wasm 冒烟 + headless Chromium 端到端，已全绿
- [x] `./build.sh test` 全绿：native payload、native 单元测试、wasm payload 冒烟均通过
- [x] `README.md`：快速开始、已知限制、性能说明
- [x] Git 提交：每完成一个任务即提交（docs、probes、指令差分测试器与语义修复、页表 NX 修复等）
