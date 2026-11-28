#!/usr/bin/env node
/* tests/wasm_fixed.js —— 固定 stopt 的 wasm 串口/状态对比（无交互输入）
 *
 *   node tests/wasm_fixed.js 20000000
 *   JIT_OFF=1 node tests/wasm_fixed.js 20000000
 *
 * 输出串口字节到 SERIAL_OUT（默认 /tmp/wasm_fixed_serial.bin），并打印
 * instructions / 字节数 / SHA256。JIT 开/关跑同一个 N，串口应逐字节相同。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { makeJitEnv } = require('./jit_hooks');

const ROOT = path.dirname(__dirname);
const N = Number(process.argv[2] || 20000000);
const STAGE = w.sim_fw_stage_ptr ? Number(w.sim_fw_stage_ptr()) : 0x0d800000;
const SCRATCH = 0x0f800000;
const CAP = 1 << 16;

(async () => {
  const fw = fs.readFileSync(path.join(ROOT, 'build', 'firmware.bin'));
  const mod = new WebAssembly.Module(fs.readFileSync(path.join(ROOT, 'web', 'sim.wasm')));
  const hasJit = WebAssembly.Module.imports(mod).some(
    (i) => i.module === 'env' && i.name === 'js_jit_compile');
  let inst = null;
  const jit = makeJitEnv(() => inst);
  inst = await WebAssembly.instantiate(mod, hasJit ? { env: jit.env } : {});
  const w = inst.exports;
  if (hasJit && process.env.JIT_OFF === '1' && w.sim_set_jit) w.sim_set_jit(0);

  const mem = new Uint8Array(w.memory.buffer);
  mem.set(fw, STAGE);
  w.sim_set_cmdline('console=ttyS0,115200 loglevel=4 panic=-1 acpi=off pci=conf1');
  const rc = w.sim_init(STAGE, fw.length);
  if (rc !== 0) throw new Error('sim_init rc=' + rc);
  if (w.sim_set_paced) w.sim_set_paced(0);   /* 对拍/序列：固定 1/17，不按墙钟校准 */
  w.sim_set_stopt(BigInt(N));

  const chunks = [];
  while (Number(w.sim_insns()) < N) {
    w.sim_run(1000000);
    const n = w.sim_serial_out(SCRATCH, CAP);
    if (n > 0) chunks.push(Buffer.from(new Uint8Array(w.memory.buffer, SCRATCH, n)));
  }
  const n = w.sim_serial_out(SCRATCH, CAP);
  if (n > 0) chunks.push(Buffer.from(new Uint8Array(w.memory.buffer, SCRATCH, n)));
  const out = Buffer.concat(chunks);
  const dst = process.env.SERIAL_OUT || '/tmp/wasm_fixed_serial.bin';
  fs.writeFileSync(dst, out);
  console.log(JSON.stringify({
    insns: Number(w.sim_insns()),
    bytes: out.length,
    sha: crypto.createHash('sha256').update(out).digest('hex'),
    jit: hasJit,
    tsc: w.sim_tsc ? Number(w.sim_tsc()) : -1,
    pit: w.sim_pit_count ? Number(w.sim_pit_count()) : -1,
    lastPit: w.sim_last_pit_tsc ? Number(w.sim_last_pit_tsc()) : -1,
    jitRuns: hasJit && w.sim_jit_stat ? Number(w.sim_jit_stat(0)) : 0,
    jitInsns: hasJit && w.sim_jit_stat ? Number(w.sim_jit_stat(6)) : 0,
    badBoundary: hasJit && w.sim_jit_stat ? Number(w.sim_jit_stat(7)) : 0,
    badBudget: hasJit && w.sim_jit_stat ? Number(w.sim_jit_stat(8)) : 0,
    ram: (() => {
      const base = Number(w.sim_ram_base());
      const view = new Uint8Array(w.memory.buffer, base, 128 * 1024 * 1024);
      let h = 2166136261 >>> 0;
      for (let i = 0; i < view.length; i++) {
        h ^= view[i];
        h = Math.imul(h, 16777619) >>> 0;
      }
      return h.toString(16);
    })(),
  }));
})();
