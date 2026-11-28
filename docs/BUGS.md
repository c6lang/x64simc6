# Bug 清单与验收矩阵

每条：现象 → 最小复现 → 根因 → 固定验收命令。根因细节见 DESIGN §104（本轮）
与 §90–§103（JIT/启动）。验收命令都在仓库根目录跑。

## A. 对拍 / 一致性

| # | Bug | 最小复现（修复前） | 根因 | 固定验收 |
|---|-----|--------------------|------|----------|
| A1 | wasm_cmp 整机低 1MB 不同、1M 起 r1 分叉（JIT=0 也复现） | `node tests/wasm_cmp.js 1000000` → `mem DIFF@0` | 测试把 JS 字符串传给 `sim_set_cmdline`（wasm 要线性内存偏移），wasm 一直用固件内建 cmdline，native 用 `--cmdline`，boot_params/cmdline 在低 1MB 就不同 | `node tests/wasm_cmp.js 50000000` → `MATCH at 50000000` |
| A2 | native `--memhash=0x1000,0x1000` 不输出 `[MEMR]`；wasm `sim_mem_hash_region` 不同区间同哈希 | `./build/sim --stopt=1 --memhash=0x1000,0x1000 build/firmware.bin \| grep MEMR`（空） | `parse_memrange` 只认十进制（0x1000→0）；wasm 导出用 u64 参数，c6 wasm 后端第 8 参/64 位传参丢失 | `REGION=0,0x100000 node tests/wasm_cmp.js 20000000` → `REGION MATCH` |
| A3 | wasm_snap 在 152M 检查点后寄存器分叉 | `node tests/wasm_snap.js` → native/wasm 行不同 | native 用宿主 RTC、wasm 用固定 epoch，开机路径读 RTC | `node tests/wasm_snap.js` → `SNAP MATCH（51 个检查点）` |
| A4 | 900M 条到不了 login（native/wasm 都卡在 1s 后） | `./build/sim --stopt=900000000 build/firmware.bin` → 停在 `No current clocksource` | CPUID 0x16 报 2400MHz 与快进 TSC(~1.19MHz) 不符 → watchdog 判 unstable；`noapic nolapic` 下内核走 8259/PIT 卡死 | `node tests/wasm_login.js` → `WASM LOGIN OK (MARK-OK)`；`tools/boot_login.py` PASS |

## B. wasm / 测试工具

| # | Bug | 最小复现（修复前） | 根因 | 固定验收 |
|---|-----|--------------------|------|----------|
| B1 | `sim_set_cmdline` 在 wasm 下不保存；`machine_boot_staged` 用固件内建覆盖调用者 cmdline | wasm 侧 cmdline 永远等于固件值 | 只调了 `machine_set_cmdline`，没拷贝到 `g_sim_cmdline`；boot_staged 无条件覆盖 | A1 的验收 + `node tests/wasm_fixed.js 20000000` |
| B2 | 测试写死 staging 地址 `0x0d800000`，静态布局一变就覆盖 `g_m` | 改大 `g_m` 后测试崩溃/串口乱码 | 常量过时 | 测试改用 `sim_fw_stage_ptr()`：`node tests/wasm_boot_smoke.js` |
| B3 | `node tests/wasm_login.js` / `wasm_fixed.js` → `ReferenceError: w is not defined` | 直接跑即崩 | `const STAGE = w...` 写在 `const w = instance.exports` 之前 | `node tests/wasm_login.js`、`node tests/wasm_fixed.js 20000000` |
| B4 | `node tests/wasm_payload_cmp.js` → `fs.openSync(undefined)` / `[REG]` 解析为 null | 直接跑即崩 | 无默认 payload；payload 串口 "C6S" 无结尾换行，`[REG]` 被前缀吞掉（测试用 `^\[REG\]`） | `node tests/wasm_payload_cmp.js` → `MATCH (8 条指令)` |
| B5 | `node tests/wasm_boot_smoke.js` → `BOOT SMOKE FAIL`（8M 条串口 0B） | 直接跑即失败 | 测试传 loglevel=4 安静 cmdline（串口直到 login~830M 才有字节），且默认 8M 太早 | `node tests/wasm_boot_smoke.js` → `BOOT SMOKE OK`（走固件默认 cmdline） |

## C. CLI / 构建 / 默认值

| # | Bug | 最小复现（修复前） | 根因 | 固定验收 |
|---|-----|--------------------|------|----------|
| C1 | `parse_u64`/`parse_memrange` 不支持 `0x`，且 `parse_u64` 有悬空 `{ }` | `--stopt=0x1000` 被当 0 | 字符串解析不完整 | `./build/sim --stopt=0x1000 --dumpregs build/firmware.bin \| grep insns` |
| C2 | 无法固定 RTC，对拍随机分叉 | A3 | 无接口 | `./build/sim --rtc=1795000000 --stopt=1 build/firmware.bin` |
| C3 | 默认 cmdline 带 `noapic nolapic`，默认固件也到不了 login | `./build/sim --stopt=1500000000 build/firmware.bin` 卡住 | A4 第二半 | `./build/sim --stopt=1500000000 build/firmware.bin \| tail -c 20` 含 `login:` |
| C4 | `tools/mkfw.py`/`src/machine.c6`/`tools/boot_login.py` 默认 cmdline 与修复不一致 | 重新生成固件又带 noapic | 默认值没同步 | `grep -R noapic tools/mkfw.py src/machine.c6 tools/boot_login.py` 无输出 |

## D. JIT（前几轮已修，回归保证）

链式分叉/缺 `cpu_deliver`/mem 块进 batch/`jit_flush` 代际/`jit_shift(int fn)`/
第 8 参丢失等：`JIT=1 ./build.sh wasm && ./build.sh jit` → 42 项 PASS；
`JIT=0` 默认产物仍零 import（`133427` 字节）。

## 固定回归矩阵（每次改动跑一遍）

```
./build.sh test
python3 tools/difftest/difftest.py          # 1252/1252
node tests/wasm_cmp.js 50000000             # MATCH
REGION=0,0x100000 node tests/wasm_cmp.js 20000000
node tests/wasm_login.js                    # WASM LOGIN OK (MARK-OK)
node tests/wasm_boot_smoke.js               # BOOT SMOKE OK
node tests/wasm_payload_cmp.js              # MATCH
node tests/wasm_fixed.js 20000000
node tests/wasm_shrd.js                     # 13 cases OK
node tests/wasm_snap.js                     # SNAP MATCH
JIT=1 ./build.sh wasm && ./build.sh jit     # 42 PASS；之后 JIT=0 还原
node tests/browser_e2e.js                   # all checks passed
node tests/browser_alpine.js                # MARK-OK
node tests/browser_tty_login.js             # BROWSER TTY OK
node tests/wasm_net_proxy.js                # WASM NET PROXY OK（需外网）
```
