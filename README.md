# x64simc6 v1.0.1

用 C6 语言实现的 x86-64 模拟器，可在 native 与浏览器 wasm 两种形态运行；浏览器端通过真实 `fetch()` + Cache Storage + IndexedDB 提供网络与“页面存储当文件系统”。

**当前状态（v1.0.0）**：原生 Alpine Linux 固件在 native、wasm（Node 驱动）和
headless Chromium 三条路径上都已引导到 `(none) login:`，自动输入 `root` 后
执行 `uname -m` 得到 `x86_64`。发布说明见 [`docs/RELEASE.md`](docs/RELEASE.md)。

## 快速开始

```sh
./build.sh all        # native build/sim + web/sim.wasm
./build.sh test       # native payload、单元测试、wasm payload 冒烟
./tests/smoke.sh      # 上面的全部检查 + headless Chromium 端到端
```

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

## 验证

```sh
./build.sh test                                   # 5 项：payload/单元/CPL3/C6SIM64/wasm 冒烟
SIM=build/sim python3 tools/difftest/difftest.py  # 1236 条指令级差分用例
node tests/browser_e2e.js                         # fetch/Cache Storage/IndexedDB/hostfs
node tests/browser_alpine.js                      # 浏览器里跑到 login 并自动登录
node tests/wasm_login.js                          # wasm 里跑到 login 并自动登录
```

## 已知限制

- 引导速度慢：到 `login:` 约需 9 亿～12 亿条 guest 指令（native 约 25 分钟、
  wasm 约 17 分钟、headless Chromium 约 18 分钟）。
- wasm 路径禁用 `interface` / `err` / `f-string` 与自定义 import；64 位一律用
  `unsigned long long`（详见 `docs/DESIGN.md` §13）。
- 浏览器 virtio-net / c6blk 是 MMIO 寄存器桩；真正的网络与文件系统走
  `hostfs` 桥（`fetch()` / Cache Storage / IndexedDB），已由 `browser_e2e` 验证。

## 性能

native 解释器：tight loop 0.7–1.2M 条/秒，整机引导平均约 0.9M 条/秒
（到 `login:` 约 15 分钟）；wasm 约 0.8–1.1M 条/秒（到 `login:` 约 18 分钟）。
每 1000 万条的实测：`jmp 10.3s`、`nop 8.7s`、`add/cmp/jne 14.8s`
（v1.0.1 修 TLB 后比 v1.0.0 快 2.1–3.4 倍）。
