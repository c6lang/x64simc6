# x64simc6 v1.0.1 发布说明

发布日期：2026-11-26（v1.0.1，同日补丁版）
许可：随仓库（无额外限制）
代码量：`src/*.c6` 约 4600 行（C6 语言），另有 web 前端与 20+ 个测试/工具脚本

## v1.0.1 变更（相对 v1.0.0）

- **修 TLB 命中率为 0**：4 KiB 页填充把 `TV_X`（可执行）写死，而取指命中判断
  要求 `!TV_X`，两边相反 → 每次取指都走四级页表（`hits=0 / walks=20,000,002`）。
  统一语义后 `hits=20,000,001 / walks=1`，payload 实测快 2.1–3.4 倍：
  `jmp 34.7s→10.3s`、`nop 28.5s→8.7s`、`add/cmp/jne 31.1s→14.8s`（每 1000 万条）。
- **顺带修 U/S 语义**：大页/4 KiB 页填充不再无条件置 `TV_U`，内核页不会在
  CPL3 下靠 TLB 命中绕过 U/S 检查。
- 验收与 v1.0.0 相同（difftest 1236/1236、build.sh test 五项、native/wasm 登录），
  整机引导时间基本不变：内核代码走高半区 direct-map，本就不查 TLB。

## 一句话

用 C6 语言写的 x86-64 模拟器，同一份源码编译成 native 与 wasm 两种形态，
把真实的 Alpine Linux（`vmlinuz-lts` + minirootfs）从加电引导到
`(none) login:`，自动输入 `root` 后能执行命令；浏览器里通过 wasm + 真实
`fetch()` / Cache Storage / IndexedDB 提供网络与“页面存储当文件系统”。

## 主要特性

- **x86-64 解释器**：长模式（含分页、CPL3、系统调用）、8259A PIC、8254 PIT、
  16550 UART、最小 xAPIC、virtio-net / c6blk MMIO 桩、GDT/IDT/TSS、异常与
  中断投递、字符串指令、x87 状态指令、`rep` 分步执行等。
- **一份源码两种形态**：`./build.sh native` 出 `build/sim`，`./build.sh wasm`
  出 `web/sim.wasm`；wasm 侧无 import，靠导出函数 + 共享线性内存接 JS。
- **浏览器桥**：`fetch()` 真实网络、Cache Storage 缓存、IndexedDB 当文件系统，
  页面输入框把键盘输入喂给 guest 串口。
- **可观测性**：`--sys` 系统调用轨迹、`--sample` RIP 采样环、`--snap` 检查点
  快照、`--dumpregs`、串口 THR/IRQ4 计数等，用于 native/wasm 逐检查点对拍。
- **测试**：1236 条指令级差分用例 + 单元测试 + CPL3 往返 + wasm 单指令对拍 +
  浏览器端到端。

## 验收证据（本版本实测）

| 验收项 | 命令 | 结果 |
| --- | --- | --- |
| 构建自检 | `./build.sh test` | payload smoke OK / 单元测试全过 / CPL3 round-trip 全过 / C6SIM64 OK / wasm payload smoke OK |
| 指令级差分 | `SIM=build/sim python3 tools/difftest/difftest.py` | **1236/1236 passed** |
| native 登录 | `SIM=build/sim TIMEOUT=4200 python3 tools/boot_login.py` | `PASS: Alpine booted to login and ran 'uname -m'`，日志里 `x86_64` / `MARK-OK` |
| wasm 登录 | `node tests/wasm_login.js` | `WASM LOGIN OK (MARK-OK)`；7.99 亿条看到 login，11.9 亿条拿到 `x86_64` |
| 浏览器登录 | `node tests/browser_alpine.js` | v1.0.0 上 `MARK-OK`（1064s / 8.88 亿条）；v1.0.1 重新跑过 |
| 浏览器桥 | `node tests/browser_e2e.js` | fetch 200 / Cache Storage OK / IndexedDB 往返 OK / hostfs put+get OK |
| 快照对拍 | `env SIM=build/sim node tests/wasm_snap.js 500000000 50000000 800000000` | `SNAP MATCH（6 个检查点寄存器全部一致）` |

浏览器侧串口尾部（`build/browser_alpine.log`）：

```
login[444]: root login on 'ttyS0'
(none):~# uname -m; echo MARK-OK
x86_64
MARK-OK
```

## 本版本修掉的关键问题

1. **16550 THRE 是电平中断**：Linux `serial8250_start_tx()` 只把 `UART_IER_THRI`
   置上就返回，真正的字节搬运在 THRE 中断里做；模型原先只在写 THR 时拉 IRQ4，
   导致用户态第一次 `write()` 永久阻塞、`/init` 卡死、串口再也出不了字节。
   现在写 IER 时按 THRI/RX 电平重新拉 IRQ4（`docs/DESIGN.md` §77）。
2. **wasm 后端的几类代码生成坑**：结构体指针/结构体内数组读写、函数返回的
   u64 存入局部后跨语句使用会丢高/低 32 位、`#if` 范围写错把通用代码圈成
   native-only（后者曾让 wasm 的 PIT 完全不触发）。
3. **HLT 唤醒后没清 `halted`**：投递挂起中断后必须清 halted，否则整机在
   22.6 亿条处假停机（§71）。
4. **测试脚本两处误用**：`sim_serial_out()` 首参是 wasm 线性内存地址而非 JS
   数组；`sim_run()==0` 不等于停机（要看 `sim_halt_info()`）。

## 构建与运行

```sh
./build.sh all          # native: build/sim；wasm: web/sim.wasm
./build.sh test         # 5 项自检
./build/fw.sh           # 或按下面命令打包 Alpine 固件
./build/sim --cmdline="console=ttyS0,115200 loglevel=4 panic=-1 acpi=off pci=off" build/firmware.bin
```

打包 Alpine 固件（需要联网取 Alpine 3.20 CDN 的 `vmlinuz-lts` 与 minirootfs）：

```sh
python3 tools/mkfw.py --kernel build/alpine/boot/vmlinuz-lts \
  --initrd build/alpine/minirootfs.tar.gz \
  --cmdline="console=ttyS0,115200 loglevel=4 panic=-1 acpi=off pci=off" \
  --out build/firmware.bin
```

浏览器：

```sh
cd web && python3 -m http.server 8000     # 打开 http://localhost:8000/
```

`tools/mkfw.py` 会往 initrd 里注入一个 `/init`：挂 proc/sysfs/devtmpfs、把
`ttyS0::respawn:-/bin/login` 写进 `/etc/inittab`（Alpine 默认那行是注释掉的）、
把 root 改成无密码，然后 `exec /sbin/init`。

## 产物

- `build/sim`：native 解释器（ELF x86-64，约 258 MiB —— c6c 把 `g_m` 的
  128 MiB guest RAM 等静态区直接铺进了文件，压缩后只有 ~1.1 MiB）
- `web/sim.wasm`：wasm 模块（无 import，导出 `sim_*` 接口）
- `web/index.html` + `web/app.js`：浏览器界面（串口、网络、文件系统、性能面板）
- `docs/DESIGN.md`：80 节详细设计与逐问题排查记录
- `docs/RELEASE.md`：本发布说明

## 已知限制

- 引导慢：到 `login:` 需要 9 亿～12 亿条 guest 指令（native ~25 分钟、
  wasm/浏览器 ~17–18 分钟）；解释器吞吐 native 约 1.0–1.5M 条/秒、
  wasm 约 0.85–1.1M 条/秒。
- native 可执行文件约 258 MiB（大块零填充，gzip 后 ~1.1 MiB）；分发请用
  `x64simc6-1.0.0-dist.tar.gz`。
- 未实现：SMP（单核）、真实 virtio 队列（网络/块设备仍是 MMIO 桩，实际
  网络与存储走浏览器 hostfs 桥）、ACPI 表、VGA 文本控制台（getty 只保证
  在 ttyS0 上）。
- wasm 后端限制见 `docs/DESIGN.md` §13：不支持 `interface` / `err` /
  f-string / 自定义 import，64 位一律用 `unsigned long long`。

## 发布产物（`build/release/v1.0.0/`）

| 文件 | 内容 |
| --- | --- |
| `x64simc6-1.0.0-src.tar.gz` | `git archive` 出的完整源码（src/web/tests/tools/docs），已验证可独立构建并通过自检 |
| `x64simc6-1.0.0-dist.tar.gz` | 可直接运行：`sim` + `sim.wasm` + `web/` 静态文件 + README/RELEASE |
| `x64simc6-1.0.0-firmware.tar.gz` | Alpine 引导固件 `firmware.bin`（33 MiB，压后 14 MiB）——放到 `web/` 同级即可直接在浏览器里跑 |
| `SHA256SUMS` | 上面三个包的校验和 |
| `RELEASE.md` | 本文件副本 |

## 仓库

- 分支：`master`（本版本合并后快进）
- 标签：`v1.0.0`
- 每个任务一次提交，提交信息带 `fix(...)` / `test(...)` / `docs(...)` 前缀；
  `TODO.md` 全部条目标记完成，`docs/DESIGN.md` 逐条记录踩过的坑与证据。