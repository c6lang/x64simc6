/* tests/wasm_boot_smoke.js —— 秒级检查「wasm 里的固件引导是否产出串口输出」。
 *
 * 为什么需要它：浏览器里完整跑了 1742M 条指令、寄存器对拍到 1.5 亿条都一致，
 * 但串口一直是 0 字节。这个脚本只跑几百万条指令（几秒钟），直接回答
 * 「wasm 的串口输出通道到底通不通」，避免再用几十分钟的完整引导去排查。
 *
 * 用法:
 *   node tests/wasm_boot_smoke.js            # 默认最多 8M 条指令
 *   MAX_INSNS=20000000 node tests/wasm_boot_smoke.js
 *
 * 退出码: 0 = 有串口输出（看到 Linux 版本行或任意字节），1 = 没有任何输出。
 */
const fs = require('fs');

const FW = process.env.FW || 'build/firmware.bin';
const WASM = process.env.WASM || 'web/sim.wasm';
const MAX = Number(process.env.MAX_INSNS || 8000000);
const CHUNK = 2000000;
const STAGE = 0x0d800000;   /* 固件暂存区 */
const SCRATCH = 0x0f800000; /* 串口取字节的暂存区（都在线性内存内） */
const CAP = 1 << 16;

(async () => {
  const mod = await WebAssembly.compile(fs.readFileSync(WASM));
  const w = (await WebAssembly.instantiate(mod, {})).exports;
  const mem = new Uint8Array(w.memory.buffer);
  const fw = new Uint8Array(fs.readFileSync(FW));
  if (STAGE + fw.length > mem.length) throw new Error('stage 越界');
  mem.set(fw, STAGE);

  w.sim_set_cmdline('console=ttyS0,115200 loglevel=4 panic=-1 acpi=off pci=off');
  const rc = w.sim_init(STAGE, fw.length);
  if (rc !== 0) { console.log('sim_init 失败 rc =', rc); process.exit(1); }

  const dec = new TextDecoder();
  let text = '';
  let bytes = 0;
  while (Number(w.sim_insns()) < MAX) {
    const alive = w.sim_run(CHUNK);
    const n = w.sim_serial_out(SCRATCH, CAP);
    if (n > 0) {
      bytes += n;
      text += dec.decode(new Uint8Array(w.memory.buffer, SCRATCH, n));
    }
    if (text.indexOf('Linux version') >= 0 || text.indexOf('Run /init') >= 0) break;
    if (alive === 0) break;
  }

  const insns = Number(w.sim_insns());
  const hi = Number(w.sim_halt_info());
  console.log(`insns=${insns} serial=${bytes}B halt_info=${hi} last_rip=0x${Number(w.sim_last_rip()).toString(16)}`);
  if (bytes > 0) {
    console.log('串口片段:', JSON.stringify(text.slice(0, 300)));
  } else {
    console.log('串口为空（wasm 的串口输出通道没有产出任何字节）');
  }
  const ok = bytes > 0 && (text.indexOf('Linux version') >= 0 || text.indexOf('Run /init') >= 0);
  console.log(ok ? 'BOOT SMOKE OK' : (bytes > 0 ? 'BOOT SMOKE PARTIAL（有串口字节但没看到内核版本行）' : 'BOOT SMOKE FAIL'));
  process.exit(ok || bytes > 0 ? 0 : 1);
})().catch(e => { console.log('failed:', e.message); process.exit(1); });