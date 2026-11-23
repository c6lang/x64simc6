# x64simc6

用 C6 语言实现的 x86-64 模拟器，可在 native 与浏览器 wasm 两种形态运行；浏览器端通过真实 `fetch()` + Cache Storage + IndexedDB 提供网络与“页面存储当文件系统”。

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

## 已知限制

- 真实 Alpine Linux 直接引导仍在调试中：已能解码执行数万条内核指令并提供 PVH start info，但尚未到达 `localhost login:`。
- wasm 路径禁用 `interface` / `err` / `f-string` 与自定义 import；64 位一律用 `unsigned long long`（详见 `docs/DESIGN.md` §13）。
- 浏览器 virtio-net / c6blk 目前是 MMIO 寄存器桩，v2 再接真实后端。

## 性能

native 解释器约 20k–200k 指令/秒（取决于是否触发 MMIO/分页）；浏览器 wasm 端每帧 20k 条指令，避免阻塞 UI。
