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
- [x] native + Alpine 固件引导到 `login:` 并进入 root shell，`tools/boot_login.py` 验收 PASS（`uname -m` = `x86_64`），关键修复见 DESIGN §30–§52

## 阶段 6 —— wasm 与浏览器

- [x] `src/wasm.c6`：`sim_init / sim_load_payload / sim_reset / sim_run / sim_status / sim_serial_out / sim_serial_in / sim_set_cmdline / sim_stat_insns / sim_ram_base`
- [x] wasm-ld 参数：`--no-entry --export-all`，initial 256 MiB / max 512 MiB；`web/sim.wasm` 无 import
- [x] node 冒烟 `tests/wasm_smoke.js`：实例化 → 写 payload → 运行 → 读串口，输出 `C6SIM64 OK`，26 条指令后停机
- [x] `web/index.html` + `web/style.css` + `web/app.js`：固件/网络下载、Cache Storage 缓存、IndexedDB 文件表与串口快照持久化、bridge 事件注入；headless Chromium 端到端验证通过
- [x] 浏览器验证 Alpine 登录提示与 root 输入 —— headless Chromium + wasm：
      `用时 1064s，指令 888M，串口 713 字节`，自动喂 `root` 后拿到
      `x86_64` / `MARK-OK`（build/browser_alpine.log）

## 阶段 7：回归修复（发现的阻塞项）

- [x] **native 回归：`/init` 之后用户态写不到串口** —— 根因是 16550 THRE 是
      电平中断，驱动在 `start_tx` 里只使能 `UART_IER_THRI` 就返回，我们使能时
      没有再拉 IRQ4，导致首次 `write()` 永久阻塞。修复见 docs/DESIGN.md §77。
- [x] 修复后重跑 native 登录验收 —— `PASS: Alpine booted to login and ran uname -m`，
      `build/login.log` 里 `x86_64` / `MARK-OK`（docs/DESIGN.md §78）
- [x] wasm 侧（Node 驱动）登录并执行命令 —— `tests/wasm_login.js`，
      `x86_64` / `MARK-OK`，见 docs/DESIGN.md §79
- [x] 再用浏览器验证登录提示与 root 输入 —— `node tests/browser_alpine.js`
      PASS（同上，docs/DESIGN.md §80）（`tests/wasm_cmp.js` 秒级对拍已推进到 **150M 条指令 MATCH**；本轮又修掉两处 wasm 后端截断：GDT 描述符 u64 字面量、`boot params` 的 `m->fw_initrd_len`，见 DESIGN §58/§61。本轮再修 6 处 wasm 结构体读写问题（dev_init/dev_tick/pic/pit 直连全局、PIC 位图独立全局、RMW 拆分、状态访问器），PIC 状态已一致；关键根因已找到：`dev_tick()` 曾被 `#if !defined(C6_WASM)` 圈掉，wasm 里 PIT 从不触发；修正后 wasm 在 200M 处与 native RIP 完全一致、600M 处已开始 printk，见 DESIGN §65。wasm 现已跑内核到 5.9 秒并开始串口输出，但仍在 VFS 挂载处 panic；boot params/initrd 本体/PIC 时钟均已比对一致，SHRD/SHLD 的 wasm 分歧已修（局部 u64 跨语句低 32 位被清零，内联 reg_read 解决，见 DESIGN §69），229M–245M 快照已全部对齐；245M–500M 全部 MATCH，9 亿条处 wasm 与 native 输出逐字相同且 VFS panic 已消失；另修掉一处真 bug：hlt 后投递挂起中断未清 halted，导致整机在 2,261,778,433 条处假停机（DESIGN §71）；现在 native 已跑过 2.26B 到 3.5B 不停，wasm 已跑满 60 亿条仍无 login（guest 已进用户态、cr3 有 4 种值、user_entries=1324，瓶颈是吞吐 ~1.5% 实时，见 DESIGN §72）；idle 快进已改为跳到下一次 PIT 到期（同一指令数下 user_entries 仍为 1324，行为不变、墙钟 -12%，DESIGN §73）；采样显示 PIT 每 262144 条指令一次、比应有节拍快 3–9 倍，试过按真实 8254 时钟折算 tick，反而更慢（1452→1236 次系统调用），已回滚，见 DESIGN §74；下一步从解释器开销侧提速，再跑 login 与 browser 验证）

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

## 性能优化（v1.0.2）

- [x] 指令频率剖析（临时构建，按 opcode 计数 2 亿条真实引导）
- [x] (c) 页表快通道 `pg_fast()`：与 `mem_translate()` 同序的逐行等价副本，
      不持任何翻译状态、失效只靠 `mem_tlb_flush()`（第一版独立页缓存语义不
      等价、整机 panic，已弃用，过程见 DESIGN §83）
- [x] (b) 按频率重排主 switch（55 块）与 0x0f 二级 switch（46 块），
      结构校验 143 个 case 块内容与重排前完全相同
- [x] (a) 热指令快通道（nop / MOV r,r / Jcc rel8 / JMP rel8,rel32），
      所有出口统一走 `fast_done()` 复刻故障回滚
- [x] 调试期开关 `--nofast / --nofetch / --nodata / --cachecheck`（保留）
- [x] 新增 `tests/test_pcache.c6`：页缓存语义（缺页不污染、失效即生效、
      R/W/NX/US 四条权限、跨页 4/8 字节、缓存开/关随机对拍 4000 次）
- [x] difftest 1236/1236、build.sh test 六项
- [x] 验收点抬到 **9 亿条整机引导**：(a)(c) 全开与全关输出逐字节一致
      （309 字节串口、irq4=181、无 panic）
- [x] native 登录验收 `PASS: Alpine booted to login and ran 'uname -m'`
- [x] wasm 登录验收 `WASM LOGIN OK (MARK-OK)`（1194M 条 / 1056s / 713B）
- [x] 浏览器验收 `MARK-OK`（1062s / 874M 条 / 658B 串口）
- [x] 文档 §82 更正 + 新增 §83（两条「快路径必须与慢路径等价」的坑）
- [x] 发布 v1.0.2（tag v1.0.2 + src/dist/firmware 三件产物 + SHA256SUMS，源码包独立构建 `./build.sh test` 六项全过）

## 性能优化（v1.1）

- [x] 剖析结论：v1.0.2 之后瓶颈在 c6c 代码生成（不做内联/寄存器分配，
      每指令几千条宿主指令），算法层已无大项
- [x] native 默认构建改走 `c6c --emit-ctu` + 系统 `cc -O2`（`build.sh`
      的 `native_fast()`；`C6_PURE=1` 保留 c6c 自举）
- [x] `ctu_fixup()`：修 `(FILE *)0/1/2` 魔法指针、`<poll.h>`/`struct
      timespec` 冲突；wasm 侧 `<stdio.h>` 一律 `#if !defined(C6_WASM)`
- [x] `machine_reset()` 首次调用跳过 128MiB 清零（后续 reboot 4 字节块清）
- [x] 固件加载改 4 字节块直接拷进 `g_m.ram`（原逐字节 `mem_w8`）
- [x] `mem_fetch8/mem_r*/mem_w*` 的 `pg_check → pg_fast → phys_*` 展开成
      `TR_PA` + `RAM_R*` / `RAM_W*` 宏（与 `mem_translate()` 同序）
- [x] `PREFIX_TAB` / `PARITY_TAB` / `SZ_MASK_TAB` / `SIGN_BIT_TAB` 查表，
      常量宏字面量化（含「1/2/4 以外返回全 1/bit63」的旧语义坑）
- [x] `main.c6` 去掉 defer/errdefer/try/catch/f-string（可 `-c` / 可 `--emit-ctu`）
- [x] 取指窗口实验（每指令一次翻译 + 16 字节缓冲）：jmp 循环 60.7G → 88.0G，
      未采用，结论记入 DESIGN §84
- [x] difftest 1236/1236（自举 + 默认两种构建）
- [x] `./build.sh test` 全过（payload / 单元 / CPL3 / pcache / wasm 冒烟）
- [x] 900M 引导：两种构建 `ser_out=309 irq4=181` 且逐字节一致
- [x] `tools/boot_login.py`：默认构建 PASS（约 56s 到 900M）、自举构建 PASS
- [x] 交互终端：native 在 tty 上切 raw（手写 termios，避开 `--emit-ctu`
      的头冲突），Ctrl-C 送 guest、Ctrl-] 退出，过滤 ash 的 `ESC[..R` 应答
- [x] `build.sh` 加 `OPT` 旋钮（默认 `-O2`；-O3/-flto/-march=native/PGO
      实测都不如 -O2，见 DESIGN §85）
- [x] 文档：README 性能表、DESIGN §84/§85/§86、RELEASE v1.1
- [x] 补 SSE 浮点指令：`comisd/cvttsd2si/cvtsi2sd/subsd/mulsd/addsd/divsd/`
      `sqrt`、`cvtss2sd/cvtsd2ss/cvtps2pd/cvtpd2ps`（借宿主的 `double`/`float`，
      不写软浮点，DESIGN §87）；顺手修 `movsd/movss` 多写 8 字节的内存踩踏（§88）
- [x] `--udtrace` 调试开关：打印未实现编码的 RIP/opcode/指令字节
- [x] Alpine 里 `top -b -n1` 正常输出（`Load average` 等 `%f` 与真机一致）
- [x] 整套 x87 FPU（`src/fpu.c6`）：8 层栈、`m32/m64/m80/m16/m32int/m64int`
      存取、四则、比较、`fsqrt/frndint/fscale/fprem/fxtract`、常量、超越函数、
      控制/状态字；`fpu_real` 默认取宿主 `long double`（真 80 位、64 位尾数），
      自举/wasm 回退 `double`（DESIGN §89）
- [x] `fistp/frndint` 按 `cw` 的 RC 位舍入（修 `awk 'BEGIN{print 22/7}'`
      段错误：RC=3 截断被当成就近偶数，残差滚大 → 死循环写爆栈）
- [x] guest 十进制与真机逐位一致：`0.1`、`0.1+0.2`、`22/7`、`sqrt(2)`、
      `printf "%.17g"`；`awk 'BEGIN{print 22/7, sqrt(2), 1/3}'` →
      `3.14286 1.41421 0.333333`

- [x] 修 8259 指定 EOI：只清本片 `v & 7` 的 ISR 位（原来无脑清最低位置位，
      `EOI(4)` 会清掉 IRQ0 的服务位 → IRQ4 永留 ISR → 控制台写永久阻塞、
      交互 `top` 只画一帧，DESIGN §91）
- [x] 串口 RX/THRE 改成电平中断（`dev_tick()` 按硬件语义重拉 IRR）；
      900M 引导 `irq4` 181 → 约 4.2k，`ser_out=309` 与墙钟不变
- [x] `main.c6` 做最小终端：跟踪 guest 光标位置、主动应答 ash 的 `ESC[6n`，
      修登录后提示符/输入"往后追加"（宿主终端的应答仍过滤）

- [x] 修交互登录 `login:` 反复输出：TSC 按 17 条指令加 1 + 交互模式空闲
      按墙钟节流（DESIGN §92）；busybox login 的 60 秒 SIGALRM 不再三四秒
      就到，逐字符输入回显正常、回车直接进 shell

## 阶段 9 —— 未结问题

- [x] 补齐其余 SSE 浮点：`min/max`、`cmp*` 八种谓词、`shufps/shufpd`、
      `unpckl/h`、`movmskps/pd`、打包 `cvtdq2ps/cvtps2dq/cvttps2dq`、
      `rcp/rsqrt`（DESIGN §90）；与本机 CPU 对拍 1553 条逐位相同
      （`rcpps/rsqrtps` 故意给精确值，与硬件的 12 位近似不同但不超 SDM 误差界）
- [ ] wasm 代理下的 HTTPS：guest 的 ClientHello 已到代理、直接重放能拿到
      完整 ServerHello，但 example.com 的 CDN 边缘 ~2.4s 后直接关闭连接
      （native HTTPS 正常）；待查（DESIGN §101）。测试暂只断言 HTTP/ICMP
- [ ] 引导期偶发的「跳进 0x48/0x4a/0x4d 填充页」`#UD`（`--udtrace` 可见，
      进程被 SIGILL 但整机继续跑；引导、登录、`top` 都不受影响）。下一步用
      `--udtrace` + `dmesg` 的 `traps:` 行定位是哪条跳转把 RIP 带进数据页。

## 阶段 10 —— 外网访问（SLIP + 用户态 NAT）

- [x] `src/dev.c6`：第二个 16550A（COM2 `0x2f8..0x2ff`、IRQ3、128 KiB RX
      环），RX/THRE 电平中断 + `thre_pending`（写 THR 置位、读 IIR 清除），
      `dev_tick()` 每轮重拉 IRQ3（DESIGN §93）
- [x] `src/net.c6`：用户态 NAT —— SLIP 解/封帧（RFC 1055）、IPv4 校验和与
      1480 分片、TCP 非阻塞中继（16 条，SYN-ACK + 写缓存 + `SO_ERROR`）、
      UDP 逐流转发（16 条，DNS 改写回 `10.0.2.3`）、ICMP echo（本地
      `10.0.2.2/3` + 宿主 ping socket，8 条）、`/etc/resolv.conf` 读 DNS、
      `net_tick()` 1 ms 墙钟节流（DESIGN §93）
- [x] `tools/mkfw.py`：`--modules` 注入 `slip.ko`/`slhc.ko` 并给 `/init`
      追加 `insmod`/`slattach`/`ifconfig sl0`/默认路由/`resolv.conf`；
      `build.sh fw` 在模块树存在时自动带上（DESIGN §93）
- [x] `src/c6sim.h` / `src/machine.c6` / `src/main.c6`：`serial2_*` /
      `net_*` 声明、`dev_init()`/`dev_tick()` 接线、`--nettrace` 调试开关
- [x] 修 `bswap` 漏 REX.B（`41 0f cc` 被当 `bswap %esp`，`ifconfig`
      一进 `fib_table_insert` 就把 RSP 打飞 → 整机 #PF 死循环）；difftest
      补 `bswap r8d..r15d/r8..r15` 16 条，全线 1252/1252（DESIGN §94）
- [x] 修 HLT 空闲快进「先跳时间、后投设备中断」：改成先 `dev_tick()`，
      有挂起中断就不推进时间，快进上限 0x40000；`ping` RTT 5869ms → 3.3ms，
      DNS 不再超时（DESIGN §95）
- [x] 修 TCP 方向：guest 包 `src`=guest、`dst`=远端，
      `conn_open/conn_find` 统一成 `(dst,dport,src,sport)`，否则 SYN-ACK
      IP 头和端口全反、guest 无限重传 SYN（DESIGN §93）
- [x] 端到端验证：`ifconfig sl0` = 10.0.2.15 P-t-P 10.0.2.2 UP；
      `ping -c1 10.0.2.2` / `ping -c1 10.0.2.3` 0% loss；`wget
      http://example.com/` 成功（DNS + TCP + HTTP）
- [x] 修 difftest 本机端 `native_run.c` 在 glibc 2.34+ 的
      `SIGSTKSZ` 非常量编译失败（固定 64 KiB 备用栈）
- [x] 文档：README「外网访问」、DESIGN §93–§95、本段 TODO、RELEASE
- [x] CMOS RTC（`0x70/0x71`，mc146818）：用宿主 UTC 时间现算年月日时分秒
      （BCD/24h、状态 A 无 UIP、状态 D 置 VRT、`0x32` 世纪），修 guest 时钟
      停在 1999-11-30 导致 `wget https://…` 证书校验失败（DESIGN §96）
- [x] HTTPS 验证：guest `date -u` 与宿主一致，`wget https://qq.com/` 证书
      校验通过（132 KiB）；HTTP/DNS/ping 同时正常
- [x] 发布 v1.2（tag v1.2 + src/dist/firmware 三件产物 + SHA256SUMS，
      产物在 `build/release/v1.2/`；源码包解压后独立 `./build.sh test` 全过）
- [ ] 后续（未做）：IPv6、DHCP、TCP 窗口缩放/拥塞控制（现在固定窗口，
      MSS 1460）、UDP 的严格无状态 NAT（现在是逐流表）；wasm 路径没有
      真实 socket，浏览器端仍走 `hostfs`/fetch 桥，不做 SLIP

## 阶段 11 —— 发布自动化

- [x] `tools/release.py`：从 `<上一个 tag>..<tag>` 的提交生成 `RELEASE_NOTES.md`
      （Conventional Commits 分组 + `docs/RELEASE.md` 概述），打包
      src/dist/firmware 三件产物、`SHA256SUMS`、`RELEASE.md` 副本
- [x] `tools/fetch_alpine.py`：钉 Alpine 3.20 的 linux-lts apk 与 minirootfs，
      解出 `build/alpine/{boot,lib,minirootfs.tar.gz}`，供 CI/新机器用
- [x] `.github/workflows/release.yml`：tag 推送或手动 dispatch，自托管 runner
      上跑发布脚本、上传 Actions 产物并创建 GitHub Release
- [x] `.claude/skills/release/SKILL.md`：仓库内发布 skill（步骤/参数/验收闸门/回滚）
- [x] `tools/make_demo_gif.py` + `docs/img/net-demo.gif`：登录后
      ifconfig/ping/wget 的演示 GIF（README 已嵌入）
- [x] wasm 后端换成 `c6c --emit-ctu -D C6_WASM=1` + `clang -O2` + `wasm-ld`：
      整机 20M 条 15.85s → 1.04s（15.2×），浏览器登录 Alpine 1062s → 62s，
      产物 1.6 MiB → 116 KiB；50M 条与 native MATCH，无 clang 时回退 tcc-c6
      （DESIGN §97）
- [x] wasm 空闲快进按墙钟节流：`sim_set_host_ms` + `pace_ahead` 对 wasm
      生效，修 `ping bing.com` 的 `bad address`、ping 回复一阵一阵（DESIGN §102）
- [x] 交互/wasm 按实测指令速率校准 TSC 分频（`pace_calibrate`），guest
      时间≈墙钟；修 `top` 刷新间隔被拉长（默认 5s 间隔、`-d 1` 约 1s，DESIGN §102）
- [x] `10.0.2.2` 映射到宿主 `127.0.0.1`：guest 可访问宿主上的 HTTP 代理
      （`export http_proxy=http://10.0.2.2:3128`，`wget http://…` 实测通过；
      HTTPS 需代理支持 busybox 的 `GET https://…` 形式）
- [x] 发布 v1.3（tag v1.3 + src/dist/firmware + `RELEASE_NOTES.md`，产物在
      `build/release/v1.3/`，GitHub Release）
- [x] `tools/wasm_tty.js`：wasm 版真终端前端（raw、Ctrl-C 送 guest、Ctrl-]
      退出、自动应答/过滤 `ESC[6n`），已在 pty 里验证登录 + `uname -m`
- [x] `.github/workflows/pages.yml` + 仓库 Pages 设置：从 release 资产组装
      `web/` 站点（<https://c6lang.github.io/x64simc6/> 已部署）
- [x] 浏览器串口换 xterm.js：光标/ANSI 颜色/5000 行滚动历史/选择复制，
      键盘直通 guest、Ctrl-C 原样送；`tests/browser_tty_login.js` 走页面
      UI 登录并执行 `uname -m` 通过（约 70s）
- [x] wasm 真上网：`--netshim`（native SLIP↔NAT 网关，复用 `src/net.c6`）+
      wasm COM2/`sim_net_rx/tx` + `tools/ws_slip_proxy.js` + 页面「网络代理」；
      `tests/wasm_net_proxy.js` 里 guest 登录 + `ping 10.0.2.2` +
      `wget http://example.com/` 全过（DESIGN §101）
- [ ] CI 首次在真实 GitHub runner 上跑通（需要 remote + 带 c6c/tcc-c6 的自托管
      runner；`runs-on` / `C6C` / `TCC` 已参数化）

## 阶段 12 —— 启动加速与 wasm JIT（2026-11）

- [x] 宿主内联：`build.sh` 在 ctu 产物上给 `reg_read/reg_write/cond/flags_*/
      shift_op/op_read/op_write` 补 `always_inline`；200M 条整机引导
      74.6G → 70.7G 宿主指令（-5.3%），墙钟约 -10%，串口输出一致
      （DESIGN §98a）
- [x] 反例：计数摊销（宿主 -3.1% 但墙钟 +4%）、惰性取指窗口（宿主 +3.3%、
      墙钟持平、`mem_fetch8` 仍 17.9%）均已回退；guest cmdline 的
      `lpj=1000`/`nokaslr` 在噪声内，不改默认（§98b/c）
- [x] wasm JIT POC：C 编码器生成 wasm 模块、JS 钩子共享线性内存、
      `mov r32,imm32` 与解释器对拍（`tests/jit_poc.js`）
- [x] wasm JIT 直线块：mov/ALU/inc/dec/nop + `jit_flags_*` 复用，
      12 条指令的 16 GPR/RFLAGS/RIP 全部对拍（`tests/jit_block.js`，
      `./build.sh jit`）
- [x] JIT 接入 `machine_run`：RIP 直接映射缓存 + 热块阈值、dev_tick/
      指令计数/TSC 边界、未覆盖指令回退、SMC 页写代数、64 位与
      jcc/jmp；900M 引导 JIT 开/关的指令数与串口逐字节一致
      （876,201,405 条，`c67ca2a0…`，DESIGN §100）
- [x] JIT 批量链式执行（JS 按 RIP 连跑）：flush 代数清 `byRip` 后，
      210M/900M 与解释器一致；但全链式 900M 71.3s vs 单块直跑 66.8s，
      默认仍单块直跑，`JIT_CHAIN_FALL=0` 保留为诊断开关
- [x] JIT 内存操作数与缺页回退：mov/ALU 两方向/cmp/test/inc/movzx/
      movsx 的 [mem] 形式，base/index*scale+disp/RIP 相对；50M MATCH、
      900M 串口与指令数一致（commit 6eca7cd）
- [x] JIT 栈操作与调用：push/pop/call/ret/leave（含故障回滚）；
      900M JIT 执行 29.9M 条（3.4%），开/关串口一致
- [x] JIT 子集：shift/imul/movsxd/98-99/cmovcc/pushfq-popfq/endbr64
      （块测试全过；900M 开/关串口一致）
- [ ] JIT 子集再扩：setcc/xchg/cmpxchg/bswap、常用 SSE、rep movs/stos
- [x] JIT 采样编译 + good/bad RIP 位图、去 CR0/CR4 flush：900M 覆盖
      107.5M 条（12.3%），墙钟 +24% → +14%，串口/指令数一致
- [x] JIT 链式分叉已修：mask 128（显式内存块）下链式与单块一致，
      定位到内存块在 JS 批内连续执行；JS 批只链非内存块、内存块由 C
      单块调用，并补 jit_pending() 交回 C 投递；900M 链式
      945,486,073 条/串口 f9aaea… 与单块逐字节一致（63.0s，仍慢于
      单块，仅诊断用）
- [x] JIT 只编译长块（MIN_N=9）：900M 覆盖 199M（25.3%），
      固定 1/17 对拍模式约 1–3% 快于解释器（54.0s vs 55.5s），
      指令数/串口一致；50M wasm_cmp 受新固件 boot 影响待对齐
- [ ] JIT 批量/wasm 内 dispatch，消除每块 wasm↔JS 切换
- [ ] JIT 生成代码内联 flags/条件，去掉每个 ALU 的 import 调用

## 阶段 13 —— 启动日志清理（2026-11）

- [x] `src/dev.c6` PCI 配置空间：`0xcf8..0xcfb` 读回地址寄存器、
      `0xcfc..0xcff` 按字节通道读写 `config[]`（1/2/4 字节访问都对）、
      BAR/ROM（`0x10..0x30`）忽略写并按真硬件读回 0；头布局改成 i440FX
      主机桥 8086:1237 / class 0x060000 / header type 0 / 无 capability 链
      （DESIGN §103a）
- [x] 默认 cmdline 的 `pci=off` 全部换成 `pci=conf1`：`tools/boot_login.py`、
      `tools/release.py`、`tools/make_demo_gif.py`、`tools/wasm_tty.js`、
      `tests/*.js`、README 示例、`src/machine.c6` 的 `default_cmdline`
      （`pci=off` 会把 `pci_probe` 清 0，内核必然打印 PCI Fatal，§103b）
- [x] `tools/mkfw.py` 生成 `/init` 时先
      `sed -i -e '/sbin\/openrc/d'` 删掉 inittab 里的 openrc 三连，再注入
      `ttyS0::respawn:-/bin/login`（minirootfs 没有 openrc，§103c）
- [x] 验证：默认 cmdline（earlycon + loglevel=7 + pci=conf1）跑到 1.5B 条，
      串口 15425 字节、`PCI: Fatal` / `openrc` 各 0 行，`PCI: Using
      configuration type 1 for base access` 和 `[8086:1237] type 00 class
      0x060000` 都在；loglevel=4 安静配置 56 字节同样无报错；
      `boot_login.py` PASS（880B LOG）；`wasm_login.js` OK（49s/418B）；
      `./build.sh test` 全过；difftest 1252/1252
- [x] 文档：DESIGN §103、README 启动说明
- [ ] 模拟 PIT ch2 + HPET/ACPI PM timer，让内核校准 TSC（不再依赖启动时
      注入 `tsc=unstable`），同时保住 CPUID 0x16 的 2400MHz（DESIGN §104）

