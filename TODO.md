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
- [ ] native 加载真实 bzImage+initrd 引导到串口日志——尚未验证
- [ ] 按诊断补 Linux 启动期缺的 opcode / MSR / 设备——尚未开始

## 阶段 5 —— Alpine 固件

- [ ] `tools/mkfw.py`：C6FW 头 + bzImage 解压为 raw vmlinux + initrd 打包
- [ ] 支持从 Alpine ISO 提取 `vmlinuz-lts` + `initramfs-lts`
- [ ] 支持从 minirootfs 生成 cpio.gz（自定义 /init）
- [ ] native + Alpine 固件引导到 `localhost login:` 并进入 shell

## 阶段 6 —— wasm 与浏览器

- [x] `src/wasm.c6`：`sim_init / sim_load_payload / sim_reset / sim_run / sim_status / sim_serial_out / sim_serial_in / sim_set_cmdline / sim_stat_insns / sim_ram_base`
- [x] wasm-ld 参数：`--no-entry --export-all`，initial 256 MiB / max 512 MiB；`web/sim.wasm` 无 import
- [x] node 冒烟 `tests/wasm_smoke.js`：实例化 → 写 payload → 运行 → 读串口，输出 `C6SIM64 OK`，26 条指令后停机
- [x] `web/index.html` + `web/style.css` + `web/app.js`：固件/网络下载、Cache Storage 缓存、IndexedDB 文件表与串口快照持久化、bridge 事件注入；[ ] 浏览器端到端验证待做
- [ ] 浏览器验证 Alpine 登录提示与 root 输入

## 阶段 7 —— wasm 网络与页面存储（用户新增硬性需求，DESIGN.md §10.1）

- [x] `src/wasm.c6` 侧 `sim_host_bridge()` / `sim_host_event()` 64 KiB 共享邮箱 + 事件分派（1=NET_RESPONSE, 2=STORAGE_LOADED, 3=USER_INPUT）
- [x] `fetch()` 拉固件（URL 输入、进度、3 次重试）+ Cache Storage 缓存 + IndexedDB 文件持久化
- [x] `src/hostfs.c6` 文件表（32 槽 × 256 KiB = 8 MiB，dirty 标记）+ `sim_hostfs_import/export/put/get`；[ ] JS/IndexedDB 双向同步尚未实现
- [x] 串口日志写入 IndexedDB `meta`，刷新页面后恢复；指令计数存 localStorage
- [ ] 预留 virtio-net / c6blk 设备接口（v2，不阻塞 v1）

## 阶段 8 —— 收尾

- [ ] `tests/smoke.sh` 一条命令跑 native + wasm 冒烟（当前由 `./build.sh test` 覆盖）
- [x] `./build.sh test` 全绿：native payload、native 单元测试、wasm payload 冒烟均通过
- [ ] `README.md`：快速开始、已知限制、性能说明
- [ ] Git 提交：每完成一个任务即提交（已执行：docs ×2、probes ×1）
