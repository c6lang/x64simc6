#!/usr/bin/env node
/* tools/wasm_tty.js —— 在真实终端（tty）里跑 wasm 版模拟器。
 *
 * 用法：
 *   node tools/wasm_tty.js [--wasm web/sim.wasm] [--fw build/firmware.bin]
 *                          [--cmdline "console=ttyS0,..."]
 *
 * 行为对齐 native 的 build/sim：
 *   - stdin 切 raw，Ctrl-C 原样送 guest，Ctrl-] 退出；
 *   - 跟踪 guest 输出的光标位置，遇到 ash 的 ESC[6n 自动回 ESC[行;列R
 *     （否则登录后提示符/长命令行会乱）；
 *   - 后台按 12ms 时间预算跑 sim_run，串口输出直接写 stdout。
 *
 * 固件先写进 wasm 线性内存的高地址（256 MiB），不够就把内存扩到 512 MiB；
 * wasm 的 staging 上限是 48 MiB（src/wasm.c6 的 g_fw_stage）。
 */
const fs = require('fs');

function opt(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const WASM = opt('--wasm', 'web/sim.wasm');
const FW = opt('--fw', 'build/firmware.bin');
const CMDLINE = opt('--cmdline',
  'console=ttyS0,115200 loglevel=4 panic=-1 acpi=off pci=off');
const STAGE = 0x10000000;     // 256 MiB：固件 staging
const SCRATCH = 0x0f800000;   // 248 MiB：串口输出/输入的小缓冲
const CAP = 65536;
const FW_MAX = 48 << 20;

(async () => {
  const wasmBuf = fs.readFileSync(WASM);
  const inst = await WebAssembly.instantiate(
    await WebAssembly.compile(wasmBuf), {});
  const w = inst.exports;
  if (w.__wasm_call_ctors) w.__wasm_call_ctors();
  if (w.sim_set_rtc) w.sim_set_rtc(Math.floor(Date.now() / 1000));

  const fw = fs.readFileSync(FW);
  if (fw.length > FW_MAX) throw new Error(`固件超过 ${FW_MAX >> 20} MiB staging 上限`);
  const need = STAGE + fw.length;
  if (need > w.memory.buffer.byteLength) {
    const pages = Math.ceil((need - w.memory.buffer.byteLength) / 65536);
    if (w.memory.grow(pages) < 0) throw new Error(`内存不足：需要 ${need} 字节`);
  }
  new Uint8Array(w.memory.buffer, STAGE, fw.length).set(fw);
  w.sim_set_cmdline(CMDLINE);
  const rc = w.sim_init(STAGE, fw.length);
  if (rc !== 0) throw new Error('sim_init rc=' + rc);

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  /* ---------------- 最小终端：跟踪光标 + 回答 ESC[6n ---------------- */
  let row = 1, col = 1, st = 0, cur = 0, params = [];
  const inputBuf = Buffer.alloc(4096);

  function send(bytes) {
    const n = Math.min(bytes.length, inputBuf.length);
    inputBuf.set(bytes.subarray(0, n));
    new Uint8Array(w.memory.buffer, SCRATCH, n).set(inputBuf.subarray(0, n));
    w.sim_serial_in(SCRATCH, n);
  }

  function feedOut(bytes) {
    for (const b of bytes) {
      if (st === 0) {
        if (b === 0x1b) { st = 1; continue; }
        if (b === 0x0a) { row = Math.min(rows, row + 1); continue; }
        if (b === 0x0d) { col = 1; continue; }
        if (b === 0x08) { if (col > 1) col--; continue; }
        if (b < 0x20 || b === 0x7f) continue;
        col++;
        if (col > cols) { col = 1; row = Math.min(rows, row + 1); }
        continue;
      }
      if (st === 1) {
        st = 0;
        if (b === 0x5b) { st = 2; params = []; cur = 0; }
        continue;
      }
      if (b >= 0x30 && b <= 0x39) { cur = cur * 10 + (b - 0x30); continue; }
      if (b === 0x3b) { params.push(cur); cur = 0; continue; }
      if (b >= 0x40 && b <= 0x7e) {
        const a = params.length ? params[0] : 0;
        const d = params.length > 1 ? params[1] : 0;
        st = 0;
        if (b === 0x48 || b === 0x66) { row = a || 1; col = d || 1; }
        else if (b === 0x41) row = Math.max(1, row - (a || 1));
        else if (b === 0x42) row = Math.min(rows, row + (a || 1));
        else if (b === 0x43) col = Math.min(cols, col + (a || 1));
        else if (b === 0x44) col = Math.max(1, col - (a || 1));
        else if (b === 0x6e && a === 6) send(Buffer.from(`\x1b[${row};${col}R`));
        continue;
      }
      st = 0;
    }
  }

  function drain() {
    const n = w.sim_serial_out(SCRATCH + CAP, CAP);
    if (n <= 0) return;
    const out = Buffer.from(new Uint8Array(w.memory.buffer, SCRATCH + CAP, n));
    // 先应答 ESC[6n，再显示给用户：否则用户看到提示符就敲字时，
    // ash 还卡在等光标应答，命令行会被当成应答吃掉（和 native 一样的顺序）。
    feedOut(out);
    process.stdout.write(out);
  }

  /* ---------------- 主循环 ---------------- */
  let quit = false;
  let raw = false;

  function finish(code) {
    if (quit) return;
    quit = true;
    try { if (raw) process.stdin.setRawMode(false); } catch (e) {}
    process.stdin.pause();
    process.stdout.write('\n');
    setTimeout(() => process.exit(code || 0), 30);
  }

  /* 输入侧过滤：丢掉宿主终端对 ESC[6n 的应答（ESC [ digits ; digits R），
   * 否则它会作为用户输入塞进 guest（和 native main.c6 的 cpr_byte 一致）。 */
  let cpr = [];
  function cprByte(b) {
    if (cpr.length === 0) {
      if (b === 0x1b) { cpr.push(b); return true; }
      return false;
    }
    if (cpr.length === 1) {
      if (b === 0x5b) { cpr.push(b); return true; }
      send(Buffer.from(cpr)); cpr = [];
      return false;
    }
    if ((b >= 0x30 && b <= 0x39) || b === 0x3b) { cpr.push(b); return true; }
    if (b === 0x52) { cpr = []; return true; }   // 完整应答：整条丢掉
    send(Buffer.from(cpr)); cpr = [];
    return false;
  }

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    raw = true;
  }
  process.stdin.resume();
  process.stdin.on('data', (d) => {
    const out = [];
    for (const b of d) {
      if (b === 0x1d) {   // Ctrl-]
        finish(0);
        return;
      }
      if (!cprByte(b)) out.push(b);
    }
    if (out.length) send(Buffer.from(out));
  });
  process.on('SIGINT', () => { /* Ctrl-C 以 0x03 送 guest，不退出 */ });

  function tick() {
    if (quit) return;
    if (w.sim_set_host_ms) w.sim_set_host_ms(Date.now() >>> 0);
    const t0 = Date.now();
    do {
      w.sim_run(200000);
      if (w.sim_status() !== 0) break;
    } while (Date.now() - t0 < 12);
    drain();
    if (w.sim_status() !== 0) { drain(); finish(0); return; }
    setTimeout(tick, 0);
  }
  tick();
})().catch((e) => {
  console.error('wasm_tty: ' + e.message);
  process.exit(1);
});
