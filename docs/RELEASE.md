# x64simc6 v1.1 发布说明

发布日期：2026-11-27

## v1.1 变更（相对 v1.0.2）

性能版本：**默认构建的整机引导快 28.8×，c6c 自举构建快 1.64×**，指令语义
不变（difftest 1236/1236，900M 引导串口输出逐字节一致）。

### 1. 构建：native 默认走 `c6c --emit-ctu` + 系统 cc

v1.0.2 的剖析结论是：瓶颈已经不在算法，而在 **c6c 的代码生成** —— 它不做
内联、不做寄存器分配，`step()` 的每个局部变量/临时量都落栈槽，一条 guest
指令要几千条宿主指令。v1.1 让 c6c 只做前端：

```sh
c6c --emit-ctu -I src src/<tu>.c6 -o build/ctu/<tu>.c
cc -O2 -c build/ctu/<tu>.c -o build/ctu/<tu>.o
cc -O2 -o build/sim build/ctu/*.o
```

同一份 C6 源码，20M 条整机引导 **121.9G → 6.41G** 条宿主指令，墙钟
**27.4s → 0.95s**；到 `login:`（约 9 亿条）从 20.1 分钟降到 **约 1 分钟**。
`--emit-ctu` 产物有三处 c6 运行时约定需要就地修正（`build.sh` 的
`ctu_fixup()`，逐条带注释）：

- `stdin/stdout/stderr` 在 c6c 的 `<stdio.h>` 里是 `(FILE *)0/1/2` 魔法指针
  （c6c 运行时认这三个值，glibc 的 `fflush` 会直接段错误）→ 在 emit 出来的
  C 里换成真正的 `stdout/stderr/stdin` 并补 extern 声明；
- `main.c6` 不再用 `<poll.h>`：c6c 没有该头，会落到系统 glibc 头并把
  `struct timespec` 带进来，和 c6c 自带 `<sys/stat.h>` 重定义。自己声明
  `struct pollfd` + `poll()` 即可；
- wasm 构建继续走 tcc-c6，`<stdio.h>` 用 `#if !defined(C6_WASM)` 包起来
  （tcc-c6 的 wasm 后端遇到这个头会生成非法 wasm）。

没有系统 cc 时自动退回 c6c 自举；`C6_PURE=1 ./build.sh native` 可强制自举。

### 2. 源码级优化（两条构建路径都受益）

- **启动路径**：`machine_reset()` 首次调用直接跳过 128MiB 清零（BSS 本来
  全 0），后续 reboot 才按 4 字节块清；固件加载不再逐字节 `mem_w8`，内核/
  initrd 在 0..128MiB 恒等映射区里按 4 字节块直接拷进 `g_m.ram`。
  进程启动从 **6.4G 条宿主指令降到 390 万条**。
- **翻译快路径**：`mem_fetch8/mem_r*/mem_w*` 里原来的
  `pg_check → pg_fast → phys_*` 四层真实调用展开成宏 `TR_PA`（与
  `mem_translate()` 同序：未开分页 → direct map → 两个高半区窗口 → TLB →
  慢路径；三个窗口按命中率排序），RAM 访问直接下标 `g_m.ram[]`。
  `--cachecheck` 照旧每次快路径命中与慢路径对拍。
- **查表**：`PREFIX_TAB[256]`（前缀循环）、`PARITY_TAB[256]`（8 次移位循环）、
  `SZ_MASK_TAB`/`SIGN_BIT_TAB`（比较链，注意要照抄「1/2/4 以外返回全 1 /
  bit63」的旧行为，否则 SSE 的 `s==0` 调用会被清零）；`PRE_*`/`RF_*`/
  `CR0_*`/`TF_*`/`TV_*`/`TLB_SIZE` 等常量宏全部改字面量（c6c 对
  `(u64)1 << n` 会生成 movabs+shl）。
- **`main.c6`** 去掉 `defer/errdefer/try/catch/f-string`：单个 TU 可以
  `-c` 编译，也能被 `--emit-ctu` 吃下。
- **交互终端**：native 在 tty 上把终端切 raw（输入不再显示两遍），
  `Ctrl-C` 送给 guest、`Ctrl-]` 退出；并过滤 ash 光标查询的应答
  （`ESC[..R`），命令行不会再被 `^[[24;11R` 这类垃圾污染。
- 试过但**没有采用**：每条指令开头填一次的 16 字节取指窗口。c6c 下
  小函数调用 + 逐字节拷贝比「再翻译一次」还贵，`jmp $` 20M 条从 60.7G
  **劣化到 88.0G**。

### 实测（`taskset` 固定核、`perf stat -e instructions:u`）

宿主指令数（与机器负载无关）：

| 负载 | v1.0.2 (c6c) | v1.1 自举 (c6c) | v1.1 默认 (cc -O2) |
| --- | --- | --- | --- |
| 20M 条整机引导（含启动） | 121.9G | 72.4G（1.68×） | 6.41G（19.0×） |
| 100M 条整机引导（稳态） | 640.9G | 444.8G（1.44×） | 36.6G（17.5×） |
| `jmp $` 紧循环 20M 条 | 77.9G | 60.7G（1.15×） | 5.00G（15.6×） |

到 `login:` 的墙钟（900M 条 guest 指令，同一台机器顺序实测；多人共享
这台机器，多次实测的波动范围如下）：

| 构建 | 墙钟 | 相对 v1.0.2 |
| --- | --- | --- |
| v1.0.2 (c6c) | 1203 秒（20.1 分钟） | 1× |
| v1.1 自举 (c6c) | 998 秒（16.6 分钟） | 1.21× |
| v1.1 默认 (cc -O2) | **46–68 秒**（中位约 57 秒） | **18–26×** |

20M 行的自举比例高于 100M 稳态，是因为 v1.1 去掉了每次启动固定的
「清 128MiB RAM + 逐字节搬 34MiB 固件」（约 12G 条宿主指令）。
900M 条引导的串口输出三种构建逐字节一致（`ser_out=309 irq4=181`；
默认构建 900M 条为 300.8G 宿主指令）。

wasm 仍走 tcc-c6，纯源码级优化：20M 条引导 46.1s → 28.2s（1.63×）。

### 3. 补上 SSE 浮点指令（`top` 不再 `Illegal instruction`）

v1.1 之前模拟器**一条浮点指令都没实现**：Alpine 里一跑 `top` 就 `Illegal instruction`。
用新增的 `--udtrace` 逐条追，缺的是 musl/busybox 算 `%f` 用的那一串：

| 缺的编码 | 指令 | 用途 |
| --- | --- | --- |
| `66 0f 2f` | `comisd` | 浮点比较 |
| `f2 0f 2c` | `cvttsd2si` | double → 整数 |
| `f2 0f 2a` | `cvtsi2sd` | 整数 → double |
| `f2 0f 5c/59/58/5e` | `subsd/mulsd/addsd/divsd` | 四则 |
| `f2/f3 0f 5a` | `cvtsd2ss/cvtss2sd` | 精度转换 |

实现方式是不写软浮点：**c6 语言自带 `double`/`float`**（自举路径也能正确算
`1.0/3.0`），把 xmm 的位型用 union 转成宿主浮点算完再转回来，NaN、±0、
次正规数、就近偶数舍入都由宿主的 SSE2 指令保证（`docs/DESIGN.md` §87）。
顺带修了 `f2/f3 0f 10/11`（`movsd/movss`）被当成 16 字节搬的 bug——旧代码
存储时会多写 8 字节，直接踩坏 guest 内存（§88）。

现在 Alpine 里 `top`、`free`、`top -b -n1` 都能正常输出，
`Load average:` 这类 `%f` 格式化结果与真机一致：

```
(none):~# top -b -n1
Mem: 25176K used, 69768K free, 7860K shrd, 0K buff, 7860K cached
CPU:   0% usr   9% sys   0% nic  90% idle   0% io   0% irq   0% sirq
Load average: 1.12 1.23 0.52 1/57 445
  PID  PPID USER     STAT   VSZ %VSZ CPU %CPU COMMAND
  445   444 root     R     1624   2%   0   9% top -b -n1
```

新增调试开关 `--udtrace`：遇到未实现的编码时打印 RIP、opcode 和 8 字节
指令，配合 `objdump -d` 能在几分钟内定位下一条要补的指令。

### 4. 整套 x87 FPU（`awk` 的十进制结果与真机一致）

SSE 只覆盖了 musl 的 `printf` 一小半：十进制**解析**（`strtod`）和 `%g` 的
数字生成走的是 `long double` + x87。新增 `src/fpu.c6` 把协处理器补齐：
8 层栈、六种宽度存取、四则、比较、`fsqrt/frndint/fscale/fprem/fxtract`、
常量、超越函数、控制/状态字（`D8..DF` 全部逃逸码）。

两个关键点：

1. **精度**：c6c 自举路径的 `long double` 其实只是 `double`，但
   `c6c --emit-ctu` 生成的是真 C，交给宿主 `cc` 就是 80 位扩展精度。于是
   `fpu_real` 在默认构建取 `long double`（64 位尾数、m80 按位搬），
   `C6_PURE`/wasm 回退 `double`。用 `double` 存 x87 时，`0.1` 会被解析成
   `0.099999999999994315`、`awk 'BEGIN{print 22/7}'` 印成 `3.14285`。
2. **舍入模式**：`fistp`/`frndint` 必须按 `cw` 的 RC 位走。musl 会临时
   `fldcw` 到向零截断再 `fistp` 取数字；只做就近偶数会让残差符号翻转，
   循环里的值越滚越大，最终 `fistp` 撞出不定值、`-inf`、死循环写爆栈 ——
   这正是 `awk 'BEGIN{print 22/7}'` 段错误的根因。

现在 guest 里：

```
(none):~# awk "BEGIN{printf "%.17g %.17g\n", 0.1, 0.1+0.2}"
0.10000000000000001 0.30000000000000004
(none):~# awk "BEGIN{print 22/7, sqrt(2), 1/3}"
3.14286 1.41421 0.333333
(none):~# awk "BEGIN{printf "%.12f\n", sqrt(2)}"
1.414213562373
```

与真机逐位一致。x87 的验证方式是把同一段机器码分别喂给模拟器和本机 CPU
（`tools/difftest` 的 blob 机制）比寄存器/数据页哈希：四则、`fild/fistp`、
`fcomip/fnstsw`、m80 往返、`fsqrt`，以及 musl 那个“每轮乘 1e9 取 9 位数字”
的循环（39 轮逐位相同）。

### 4.1 其余 SSE 浮点（min/max、cmp、shuffle、打包转换）

补完 `min/max`、`cmpss/sd/ps/pd`（8 种谓词）、`shufps/shufpd`、
`unpckl/h`、`movmskps/pd`、`cvtdq2ps/cvtps2dq/cvttps2dq`、`rcp/rsqrt`。
边角语义按 SDM：min/max 遇 NaN 或两个零返回第二操作数（与 C 的
`fmin/fmax` 不同）；反身比较谓词对 NaN 返回真。`rcpps/rsqrtps` 返回精确的
1/x、1/√x，而硬件给的是 12 位近似（SDM 只要求相对误差 ≤ 1.5·2⁻¹²，精确值
满足），所以这四条与真机逐位不同，其余新指令用 blob 和本机 CPU 对拍
1553 条全部逐位相同。

### 5. 修交互终端：`top` 自动刷新、提示符不再"往后追加"

v1.1 收尾时 guest 里有两个只有交互操作才暴露的问题：`top` 画完一帧就
不再刷新（控制台输出卡在一行中间），以及登录后提示符/输入一直往右追加。
两个都定位到了具体模型错误：

1. **8259 指定 EOI 被当成非指定处理**。Linux 的 8259 驱动只发指定 EOI
   （`OCW2=0x60|irq`），旧代码不看低 3 位、一律清"最低的置位位"；定时器
   和串口同时在服务时 `EOI(4)` 清掉的是 IRQ0 的服务位，IRQ4 永远留在
   ISR 里，之后 IRQ4 一律不再投递 —— 串口驱动的 tty 写就永远等不到唤醒。
   同时把串口 RX/THRE 改成电平语义（原来只补边沿，`start_tx` 看到 THRI
   已置位就不再写 IER，边沿丢失同样会卡死）。
2. **ash 的 `ESC[6n` 光标查询没有应答**。busybox ash 每个提示符都会问
   光标位置，以前只把宿主终端的应答过滤掉，guest 永远等不到答案；
   现在 `main.c6` 里做一个小终端，跟踪光标位置并主动应答（宿主终端的
   应答仍然过滤）。

修复后：交互 `top` 30 秒 13 帧、`q` 正常退出；`top -n 2` 两帧后回到
shell；连续 12×500 字节输出全部送达；100 字符长命令行回显完整。
900M 引导仍是 `ser_out=309`（`irq4` 因电平语义从 181 变成约 4.2k，
每 0x40000 条指令最多一次，墙钟仍 47~53 秒）。

### 验收

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 单元/冒烟 | `./build.sh test` | 全过（payload / 单元 / CPL3 / pcache / wasm 冒烟） |
| 指令差分 | `tools/difftest/difftest.py` | 1236/1236，自举与默认两种构建各跑一遍 |
| 900M 引导 | `build/sim firmware.bin --stopt=900000000` | `ser_out=309 irq4=181`，逐字节一致 |
| 浮点/`top` | 登录后 `top -b -n1` | 正常输出（含 `Load average` 浮点格式化） |
| x87/十进制 | `awk 'BEGIN{printf "%.17g", 0.1+0.2}'` | `0.30000000000000004`，与真机一致 |
| 登录验收 | `tools/boot_login.py` | 两种构建都 PASS（`uname -m` → `x86_64`） |

---

# x64simc6 v1.0.2 发布说明（历史）

发布日期：2026-11-27

## v1.0.2 变更（相对 v1.0.1）

解释器提速三件套（不改变指令语义，用 9 亿条整机引导逐一验证）：

- **(b) 分派链重排**：`c6c` 把 `switch` 编成按源码顺序的比较链，于是按实测
  指令频率重排主 switch 的 55 个 case 块与 `0x0f` 二级 switch 的 46 个块
  （结构校验：143 个块内容与重排前逐一相同）。
- **(a) 热指令快通道**：`nop` / `MOV r,r` / `Jcc rel8` / `JMP rel8,rel32`
  在进主分派前直接处理。**所有出口统一走 `fast_done()`**，复刻 `step()` 尾部
  的故障回滚（漏掉它会让页尾跨界取指的缺页指令把 RIP 停在半路）。
- **(c) 页表快通道 `pg_fast()`**：与 `mem_translate()` **同序**的逐行等价副本
  （未开分页 → direct map → 高半区 → TLB 命中），不持有任何翻译状态。
  第一版用「独立页缓存」（快 24%）语义上不等价，整机引导会在 init 起来后
  kernel panic，已弃用；经过见 `docs/DESIGN.md` §83。

调试设施（保留在 CLI 里）：`--nofast`、`--nofetch`、`--nodata`（A/B 开关，
实测耗时差 +0.7% / +32% / +23%），`--cachecheck`（每次快路径命中与慢路径对拍），
`--udtrace`（遇到未实现编码时打印 RIP/opcode/指令字节，补指令时用）。

新增单元测试 `tests/test_pcache.c6`：缺页不污染缓存、失效立即生效、
R/W/NX/U-S 四条权限、跨页 4/8 字节访问、开/关缓存随机对拍 4000 次。

### 实测（空载机器，各测两轮取低值）

| 负载 | v1.0.1 | v1.0.2 | 提升 |
| --- | --- | --- | --- |
| `jmp $` 5M 条 | 6.19s | 4.60s | 1.34× |
| `nop;...;jmp` 5M 条 | 4.43s | 3.74s | 1.18× |
| `add/cmp/jne` 5M 条 | 10.03s | 8.85s | 1.13× |
| 引导 60M 条 | 87.3s | 80.5s | 1.08× |

### 验收

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 单元/冒烟 | `./build.sh test` | 六项全过 |
| 指令差分 | `tools/difftest/difftest.py` | 1236/1236 |
| 语义对齐 | 9 亿条整机引导，三件套全开 vs 全关 | 串口 309 字节、`irq4=181`、无 panic，逐字节一致 |
| native 登录 | `tools/boot_login.py` | `PASS: Alpine booted to login and ran 'uname -m'` |
| wasm 登录 | `node tests/wasm_login.js` | `WASM LOGIN OK (MARK-OK)`（1194M 条 / 1056s / 713B） |
| 浏览器登录 | `node tests/browser_alpine.js` | `MARK-OK`（1062s / 874M 条 / 658B） |
| 源码包独立构建 | 解压 `-src.tar.gz` 后 `./build.sh test` | 六项全过 |

### 产物

| 文件 | 内容 |
| --- | --- |
| `x64simc6-1.0.2-src.tar.gz` | 源码（git archive，不含 build/） |
| `x64simc6-1.0.2-dist.tar.gz` | `sim`（native）+ `sim.wasm` + `web/` + 文档 |
| `x64simc6-1.0.2-firmware.tar.gz` | `build/firmware.bin`（kernel+initrd 打包，34 MB） |
| `SHA256SUMS` | 上面三件的校验和 |

---

# x64simc6 v1.0.1 发布说明（历史）

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