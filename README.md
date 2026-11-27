# x64simc6 v1.2

用 C6 语言实现的 x86-64 模拟器，可在 native 与浏览器 wasm 两种形态运行；浏览器端通过真实 `fetch()` + Cache Storage + IndexedDB 提供网络与“页面存储当文件系统”。

**当前状态（v1.2）**：原生 Alpine Linux 固件在 native、wasm（Node 驱动）和
headless Chromium 三条路径上都已引导到 `(none) login:`，自动输入 `root` 后
执行 `uname -m` 得到 `x86_64`；native 版还能通过 COM2 上的 **SLIP + 用户态
NAT** 真正访问外网（DNS / TCP / HTTP / HTTPS / ICMP，见下文「外网访问」）。
发布说明见 [`docs/RELEASE.md`](docs/RELEASE.md)。

## 快速开始

```sh
./build.sh all        # native build/sim + web/sim.wasm
./build.sh test       # native payload、单元测试、wasm payload 冒烟
./tests/smoke.sh      # 上面的全部检查 + headless Chromium 端到端
```

native 默认走快速构建：`c6c --emit-ctu` 把每个 TU 降成 C，再交给系统
`cc -O2` 编（宿主 cc 有寄存器分配，整机引导到 `login:` 从 20 分钟降到 1 分钟）。
没有系统 cc 时自动退回 c6c 自举；也可以用 `C6_PURE=1 ./build.sh native`
强制自举路径。详细差异见 `docs/DESIGN.md` §84。

运行手汇编 payload：

```sh
./build/sim --payload build/hello64.bin
```

浏览器端（必须 HTTP 服务，不能 `file://`）：

```sh
cd web && python3 -m http.server 8000
# 打开 http://localhost:8000/
```

构建 Alpine 固件（需要联网；Alpine 3.20 CDN）：

```sh
./build.sh fw --kernel build/alpine/boot/vmlinuz-lts \
  --initrd build/alpine/minirootfs.tar.gz --out build/firmware.bin
./build/sim build/firmware.bin
```

在真实终端里跑时模拟器会把终端切到 raw：输入不会显示两遍，`Ctrl-C` 原样
送给 guest，**`Ctrl-]` 退出**。约 1 分钟出现 `(none) login:`，输入 `root`
回车进 shell；`/root` 是空的（`ls` 自然没有输出），可以试 `ls /`、
`cat /etc/os-release`、`uname -a`、`df -h`、`top -b -n1`（v1.1 补上了 SSE 浮点，
x87 FPU 也整套实现了：`awk 'BEGIN{print 22/7, sqrt(2)}'`、`printf "%.17g"`
这类十进制转换与真机逐位一致，`top` 的 `Load average` 等 `%f` 输出正常）。
交互下 `top`（不带 `-n`）会自动刷新，`q` 退出；提示符和长命令行的
行编辑都正常（模拟器自己模拟了一个最小终端，代真实终端回答 ash 的
`ESC[6n` 光标查询，见 `docs/DESIGN.md` §91）。
遇到不认识的指令可以用 `--udtrace` 打印 RIP 和指令字节。

## 外网访问（SLIP + 用户态 NAT）

native 版可以让 guest 真正上外网：模拟器在 **COM2（0x2f8 / IRQ3，/dev/ttyS1）**
上再挂一个 16550A，guest 用内核自带的 `slip` 模块 + `slattach` 跑 SLIP
（RFC 1055），宿主侧 `src/net.c6` 实现一个最小用户态 NAT。**不需要 tap、
不需要 root、不依赖 libslirp。**

地址约定与 QEMU user networking 一致（方便记）：

| | 地址 |
| --- | --- |
| guest | `10.0.2.15` |
| 网关 / peer | `10.0.2.2`（本地回 ping） |
| DNS | `10.0.2.3`（宿主 `/etc/resolv.conf` 的第一个服务器，兜底 1.1.1.1） |

构建带网络的固件（需要 linux-lts 的模块树，默认在 `build/alpine/lib`，
也可以 `--modules` 指到 `lib` / `lib/modules` / `lib/modules/<kver>`）：

```sh
./build.sh fw --kernel build/alpine/boot/vmlinuz-lts \
  --initrd build/alpine/minirootfs.tar.gz \
  --cmdline "console=ttyS0,115200 loglevel=4 panic=-1 acpi=off pci=off" \
  --out build/firmware.bin
# 没有模块树时自动退回“无网络”固件；等价的显式写法：
python3 tools/mkfw.py --modules build/alpine/lib ...
```

（`--cmdline` 用和验收一致的 `acpi=off pci=off`；不带它时 mkfw 用
`earlyprintk=...` 的默认命令行，也能启动，但没在这台模拟器上完整验收过。）

mkfw 会把 `slip.ko` / `slhc.ko` 解压进 initrd，并在 `/init` 里自动执行：
`insmod` 两个模块 → `slattach -p slip -s 115200 /dev/ttyS1` →
`ifconfig sl0 10.0.2.15 pointopoint 10.0.2.2 mtu 1500 up` → 默认路由 →
`nameserver 10.0.2.3`。所以引导到 login 时 `sl0` 已经可用，guest 里直接：

```sh
ifconfig sl0
ping -c1 10.0.2.2          # 本地网关，3ms 左右
ping -c1 10.0.2.3          # DNS，本地回
wget -O /dev/null http://example.com/   # DNS + TCP/HTTP 真外网
wget -O /dev/null https://example.com/  # HTTPS：证书校验依赖 RTC 对时
```

如果 `ifconfig sl0` 报 `Device not found`，说明**固件没带 SLIP 模块**，
不是启动参数的问题。在 guest 里依次确认：

```sh
cat /init                                   # 应该有 insmod/slattach/ifconfig sl0 段
ls /lib/modules/$(uname -r)/kernel/drivers/net/slip/   # slip.ko slhc.ko
ls -l /dev/ttyS1                            # COM2 设备节点
dmesg | grep -iE 'slip|slhc'                # insmod 失败会打印 invalid module format
```

最常见的原因是固件是用旧命令（没有 `--modules`/`build/alpine/lib`）打的：
`mkfw` 会打印「未指定 --modules，guest 将没有外网」。重新按上面命令生成
`build/firmware.bin` 即可（成功时会打印「注入 SLIP 模块：build/alpine/lib」）。
浏览器/wasm 版没有真实 socket，永远没有 `sl0`。

guest 的时钟由模拟的 CMOS RTC（0x70/0x71，mc146818 布局）从宿主 UTC 时间
初始化，所以 `date -u` 与宿主一致、HTTPS 证书校验能过（DESIGN §96）；guest
里 `date -s` 只改内核时钟，不会回写 RTC。

宿主侧的行为：IP 层自己封/解（含校验和、>1480 的分片），TCP 每条连接用一个
非阻塞宿主 socket 中继（最大 16 条），UDP 逐流转发（16 条，DNS 自动改写目标到
宿主 DNS 并把回包源地址改回 10.0.2.3），ICMP echo 走宿主 **ping socket**
（`SOCK_DGRAM/IPPROTO_ICMP`，`ping_group_range` 允许非 root 时可用）。TCP/UDP/
ICMP 的缓冲都在 `net_tick()` 里推进，`dev_tick()` 负责把 COM2 的 RX/THRE 电平
中断投给 PIC。实现细节和踩过的坑见 `docs/DESIGN.md` §93–§95。

限制：只支持 IPv4（SLIP 上没配 IPv6），没有 DHCP（地址是 initrd 里写死的），
不做 TCP 窗口缩放/拥塞控制（窗口固定、MSS 1460），UDP 是逐流的、不是严格
无状态 NAT；宿主必须能访问 DNS 返回的地址（例如某些环境给 example.com 解析到
不可达的内网段时，guest 里也会连不上）。

调试：`--nettrace` 打印前 800 条 SLIP/IP/TCP/UDP/ICMP 收发摘要（不改变行为）；
`--rspcheck` 在 RSP 掉进模块区/非法栈时打印最近 64 条 RIP/RSP 并停机，
`--udtrace` 打印未实现指令。三个开关都只在显式打开时才工作。

## 验证

```sh
./build.sh test                                   # 5 项：payload/单元/CPL3/C6SIM64/wasm 冒烟
SIM=build/sim python3 tools/difftest/difftest.py  # 1236 条指令级差分用例
node tests/browser_e2e.js                         # fetch/Cache Storage/IndexedDB/hostfs
node tests/browser_alpine.js                      # 浏览器里跑到 login 并自动登录
node tests/wasm_login.js                          # wasm 里跑到 login 并自动登录
```

## 已知限制

- 到 `login:` 约需 9 亿～12 亿条 guest 指令：v1.1 默认构建 native 约 1 分钟，
  `C6_PURE=1` 自举构建约 17 分钟；wasm（tcc-c6 出码）约 11 分钟。
- wasm 路径禁用 `interface` / `err` / `f-string` 与自定义 import；64 位一律用
  `unsigned long long`（详见 `docs/DESIGN.md` §13）。
- SSE 浮点覆盖 `add/sub/mul/div/sqrt`、`min/max`、`cmp*`、shuffle/unpack、
  `movmsk`、整/浮转换（含打包 `cvtdq2ps/cvtps2dq/cvttps2dq`）、`cvtss2sd`
  一族与 `rcp/rsqrt`：MXCSR、FXSAVE、`sqrt` 的末位和 `0x2d` 的舍入模式不
  建模，够 `printf`/`top` 用。`rcpps/rsqrtps` 给精确值，不是硬件的 12 位近似
  （SDM 只要求误差 ≤ 1.5·2⁻¹²，精确值满足）。
- x87 的精度取决于构建路径：默认构建（`--emit-ctu` + 宿主 `cc`）的
  `fpu_real` 是宿主的 `long double`（真 80 位、64 位尾数），`C6_PURE=1`
  自举和 wasm 路径的 `long double` 只是 `double`，x87 最后 1～2 位有效数字
  可能与真机不同（十进制解析/格式化的末位会差；`docs/DESIGN.md` §89）。
- 浏览器 virtio-net / c6blk 是 MMIO 寄存器桩；真正的网络与文件系统走
  `hostfs` 桥（`fetch()` / Cache Storage / IndexedDB），已由 `browser_e2e` 验证。

## 性能

native 有两条构建路径，源码完全相同：

- **默认快速路径**（`./build.sh native`）：c6c 只做前端（`--emit-ctu`），
  代码生成交给系统 `cc -O2`。c6c 不做内联、不做寄存器分配，每个局部变量都落
  栈槽；宿主 cc 接手后解释器主循环的指令数降一个数量级。
- **自举路径**（`C6_PURE=1 ./build.sh native`）：c6c 直接出码，用来验证
  C6 源码本身的可移植性与正确性。

宿主指令数（`taskset` 固定核 + `perf stat -e instructions:u`，与负载无关）：

| 负载 | v1.0.2（c6c） | v1.1 自举（c6c） | v1.1 默认（cc -O2） |
| --- | --- | --- | --- |
| 20M 条整机引导（含启动） | 121.9G | 72.4G（1.68×） | 6.41G（19.0×） |
| 100M 条整机引导（稳态） | 640.9G | 444.8G（1.44×） | 36.6G（17.5×） |

20M 那行的自举比例比稳态高，是因为 v1.1 把每次启动都要付的
「逐字节清 128MiB RAM + 逐字节搬 34MiB 固件」（约 12G 条宿主指令）去掉了；
进程启动从 6.4G 条降到 390 万条。

到 `login:`（900M 条 guest 指令，串口 309 字节、irq4=181）的墙钟，
同一台机器上顺序实测：

| v1.0.2 | v1.1 自举 | v1.1 默认 |
| --- | --- | --- |
| 20.1 分钟 | 16.6 分钟 | **46–68 秒**（中位约 57 秒） |

（这台机器多人共享，墙钟随负载波动；指令数和串口输出不受影响。
三种构建的 900M 串口输出逐字节一致，默认构建 300.8G 条宿主指令。）

wasm 仍由 tcc-c6 出码，同一套源码级优化同样受益：20M 条引导 46.1s → 28.2s
（1.63×），启动阶段少的 19 秒来自不再逐字节清 128MiB RAM。
具体改了什么、哪些试过但没用，见 `docs/DESIGN.md` §84。
