# x64simc6 v1.3

用 C6 语言实现的 x86-64 模拟器，可在 native 与浏览器 wasm 两种形态运行；浏览器端通过真实 `fetch()` + Cache Storage + IndexedDB 提供网络与“页面存储当文件系统”。

**当前状态（v1.3）**：原生 Alpine Linux 固件在 native、wasm（Node 驱动）和
headless Chromium 三条路径上都已引导到 `(none) login:`，自动输入 `root` 后
执行 `uname -m` 得到 `x86_64`；native 版还能通过 COM2 上的 **SLIP + 用户态
NAT** 真正访问外网（DNS / TCP / HTTP / HTTPS / ICMP，见下文「外网访问」）；
wasm 后端改用 `clang -O2` 后，浏览器里登录 Alpine 也从 18 分钟降到 **约 1
分钟**。发布说明见 [`docs/RELEASE.md`](docs/RELEASE.md)。

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

wasm 也走同一条思路：`c6c --emit-ctu -D C6_WASM=1` 出 C，`clang -O2` 编成
wasm32，`wasm-ld` 链上 c6 的 wasm 运行时（`libtcc1-wasm32.a`）。整机引导比
原来的 tcc-c6 出码快 15～22 倍，浏览器里登录 Alpine 从 18 分钟降到约 1 分钟。
没有 clang/wasm-ld 时自动退回 tcc-c6，也可以 `WASM_BACKEND=tcc ./build.sh wasm`
强制。见 `docs/DESIGN.md` §97。

运行手汇编 payload：

```sh
./build/sim --payload build/hello64.bin
```

浏览器端（必须 HTTP 服务，不能 `file://`）：

```sh
cd web && python3 -m http.server 8000
# 打开 http://localhost:8000/
```

页面里的串口是一个**真终端**（xterm.js）：光标闪烁、ANSI 颜色、5000 行
滚动历史、选择复制都和终端一致；点一下终端后键盘直接输入，Ctrl-C 原样送
guest。`tests/browser_tty_login.js` 会从页面点「加载固件」「启动」，在 xterm
里等到 `login:`、输入 `root` 和 `uname -m`，验证整条 UI + 键盘 + 串口链路。

要注意的两点（也是“点了没反应”的常见原因）：

- **先点一下终端再打字**（终端里出现光标），键盘才会进 guest；页面启动后
  会自动聚焦，但点过按钮/别处后焦点会丢。
- 点「启动」后，内核解压阶段大约 **20 秒没有串口输出**（第一条日志大约在
  3 亿条指令之后），状态栏会显示已执行的指令数，属正常现象。
- 必须用 HTTP 服务打开，`file://` 下 wasm/firmware 拉不下来（状态栏会提示）。

也可以托管到 GitHub Pages（`sim.wasm` / `firmware.bin` 是构建产物，不在 git
里，所以 Pages workflow 直接从 release 资产取）：仓库 Settings → Pages →
Source 选「GitHub Actions」，手动跑一次 `pages` workflow（之后每次 release
也会自动触发）。它会把**该 release 的** `sim.wasm`、`firmware.bin` 与
`web/` 组装成站点，打开 <https://c6lang.github.io/x64simc6/> 即可。固件
34 MB，首次加载后会存进 Cache Storage。

想在**终端**里跑 wasm 版（而不是浏览器）：`node tools/wasm_tty.js`（默认
`--wasm web/sim.wasm --fw build/firmware.bin`）。它和 native 一样切 raw、
Ctrl-C 送 guest、Ctrl-] 退出，并自己应答 ash 的 `ESC[6n` 光标查询。

### 浏览器里真上网（WebSocket SLIP 代理）

wasm 里没有宿主 socket；guest 的上网走“第二串口 + WebSocket 代理”：

```sh
./build.sh native                    # 需要 build/sim（--netshim 模式）
node tools/ws_slip_proxy.js          # 默认 ws://127.0.0.1:8787
```

页面「网络代理」填 `ws://127.0.0.1:8787`，点「连接」，再「加载固件」「启动」。
guest 里照常 `ping 10.0.2.2`、`wget http://example.com/`，地址仍是
10.0.2.15 / 10.0.2.2 / 10.0.2.3。链路是：

```
wasm guest ttyS1(SLIP) <-> sim_net_rx/tx <-> WebSocket
  <-> tools/ws_slip_proxy.js <-> build/sim --netshim <-> 宿主 socket
```

`--netshim` 不跑 guest，只把 stdin/stdout 上的 SLIP 帧接到 `src/net.c6` 里
**和 native 完全相同的用户态 NAT**（DNS/TCP/UDP/ICMP），所以 wasm 和 native
的上网行为一致。`node tests/wasm_net_proxy.js` 会把这条链路完整跑一遍
（登录 + ping + wget http）。HTTPS 走同一条 TCP 中继，但 wasm guest 目前
实测会被 CDN 边缘关闭连接（native 的 HTTPS 正常），见 DESIGN §98 的已知问题。

注意：`--netshim` 把宿主的网络能力开放给 guest（默认只绑 127.0.0.1，
不要暴露到公网）；GitHub Pages 是 HTTPS，浏览器对 `ws://127.0.0.1` 的
混合内容策略各版本不同，本地 `http://localhost` 页面最稳。Pages 上的
`sim.wasm` 来自 release 资产，需要 v1.4+ 的构建才带 `sim_net_rx/tx`。

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

![登录后用 ping 和 wget 访问外网](docs/img/net-demo.gif)

*登录后依次执行 `ifconfig sl0`、`ping -c3 qq.com`、`wget -O /dev/null
https://qq.com/`（HTTPS 证书校验通过）；GIF 由 `tools/make_demo_gif.py` 录制。*

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

## 发布

发布说明从提交文本自动生成，产物由同一套脚本打包（本地和 CI 共用）：

```sh
git tag -a vX.Y -m "vX.Y: …"
python3 tools/release.py --tag vX.Y                 # 先跑 ./build.sh test，再出三件产物
python3 tools/release.py --tag vX.Y --notes-only    # 只预览自动生成的说明
```

产物在 `build/release/vX.Y/`：`RELEASE_NOTES.md`（Release 正文：`docs/RELEASE.md`
的概述 + `<上一个 tag>..<tag>` 的提交按 feat/fix/perf/docs/... 分组）、
`x64simc6-X.Y-{src,dist,firmware}.tar.gz`、`SHA256SUMS`。固件需要 `build/alpine`，
新机器先跑 `python3 tools/fetch_alpine.py`。

推 tag 后 `.github/workflows/release.yml` 在带 C6 工具链的自托管 runner 上跑同一
脚本并创建 GitHub Release；仓库内 skill `.claude/skills/release/SKILL.md` 记录了
完整发版流程、验收闸门和回滚办法。演示 GIF 可重新录制：

```sh
python3 tools/make_demo_gif.py --out docs/img/net-demo.gif
```

## 已知限制

- 到 `login:` 约需 9 亿～12 亿条 guest 指令：native（`cc -O2`）约 1 分钟，
  `C6_PURE=1` 自举约 17 分钟；wasm（`clang -O2`）约 1 分钟，tcc-c6 回退约
  18 分钟。
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

wasm 也从 tcc-c6 换成了同一套「ctu + `clang -O2` + `wasm-ld`」：20M 条整机引导
**15.85s → 1.04s（15.2×）**，5M 条 6.55s → 0.29s（22.6×），产物 1.6 MiB →
116 KiB；headless Chromium 里登录 Alpine 并执行 `uname -m` 从 **1062s 降到
62s**（Node 里 59s），寄存器/RAM 在 50M 条处与 native MATCH。
细节见 `docs/DESIGN.md` §97。
