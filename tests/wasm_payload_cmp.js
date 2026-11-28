// payload 级差分：同一段机器码，native 与 wasm 各跑 N 条指令，比对 16 个寄存器、
// RIP、flags。秒级完成（payload 只有几条指令）。
// 用法: node tests/wasm_payload_cmp.js <payload.bin> [N] [--quiet]
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const payload = process.argv[2] || path.join(path.dirname(__dirname), 'build', 'hello64.bin');
const N = parseInt(process.argv[3] || '8', 10);
const quiet = process.argv.includes('--quiet');
const SIM = process.env.SIM || 'build/sim';
const WASM = process.env.WASM || 'web/sim.wasm';

function nativeRun() {
  const out = execFileSync(SIM, ['--payload', `--stopt=${N}`, '--dumpregs', payload],
                           { encoding: 'utf8' });
  const regs = new Array(16).fill(null);
  let rip = null, flags = null;
  for (const line of out.split('\n')) {
    let m = /^\[REG\] (\d+) ([0-9a-f]+)/.exec(line);
    if (m) { regs[+m[1]] = BigInt('0x' + m[2]); continue; }
    m = /^\[REG\] rip ([0-9a-f]+)/.exec(line);
    if (m) { rip = BigInt('0x' + m[1]); continue; }
    m = /^\[REG\] flags ([0-9a-f]+)/.exec(line);
    if (m) flags = BigInt('0x' + m[1]);
  }
  return { regs, rip, flags };
}

(async () => {
  const code = fs.readFileSync(payload);
  const nat = nativeRun();
  const mod = await WebAssembly.compile(fs.readFileSync(WASM));
  const w = (await WebAssembly.instantiate(mod, {})).exports;
  const STAGE = 0x0d800000;
  new Uint8Array(w.memory.buffer).set(code, STAGE);
  w.sim_load_payload(STAGE, code.length);
  for (let i = 0; i < N; i++) { if (w.sim_run(1) === 0) break; }
  const wa = {
    regs: Array.from({ length: 16 }, (_, i) => BigInt.asUintN(64, w.sim_cpu_reg(i))),
    rip: BigInt.asUintN(64, w.sim_last_rip()),
    flags: BigInt(w.sim_cpu_flags()),
  };
  let bad = 0;
  for (let i = 0; i < 16; i++) {
    if (nat.regs[i] !== wa.regs[i]) {
      bad++;
      console.log(`DIFF r${i}: native=0x${nat.regs[i].toString(16)} wasm=0x${wa.regs[i].toString(16)}`);
    }
  }
  if (nat.rip !== wa.rip) { bad++; console.log(`DIFF rip: native=0x${nat.rip.toString(16)} wasm=0x${wa.rip.toString(16)}`); }
  if (nat.flags !== wa.flags) { bad++; console.log(`DIFF flags: native=0x${nat.flags.toString(16)} wasm=0x${wa.flags.toString(16)}`); }
  if (!quiet || bad) console.log(bad ? `${payload}: ${bad} 处不一致` : `${payload}: MATCH (${N} 条指令)`);
  process.exit(bad ? 1 : 0);
})();
