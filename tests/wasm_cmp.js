/* tests/wasm_cmp.js —— 秒级 native/wasm 对拍。
 *
 * 用法: node tests/wasm_cmp.js <指令数> [--quiet]
 *   1) native:  ./build/simXX --stopt=N --dumpregs 固件  -> 解析 [REG] 行
 *   2) wasm:    sim_init(固件) + sim_set_stopt(N) + sim_run(...) -> 读 sim_cpu_reg
 *   3) 打印两边的 16 个通用寄存器 + RIP + RFLAGS，并给出 diff 位置
 *
 * 这是定位 wasm 后端代码生成问题最快的办法：不需要跑完整引导，几秒钟一条。
 */
const fs = require('fs');
const { execFileSync } = require('child_process');

const N = Number(process.argv[2] || 1000000);
const QUIET = process.argv.includes('--quiet');
const SIM = process.env.SIM || 'build/sim';
const FW = process.env.FW || 'build/firmware.bin';

function nativeSnapshot() {
  let out = '';
  try {
    out = execFileSync(SIM, ['--stopt=' + N, '--dumpregs',
                             '--cmdline=console=ttyS0,115200 loglevel=4 panic=-1 acpi=off pci=off',
                             FW], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
                                   timeout: 600000 });
  } catch (e) {
    out = (e.stdout || '').toString();
  }
  const regs = new Array(16).fill(null);
  let rip = null, flags = null, insns = null;
  for (const line of out.split('\n')) {
    const m = line.match(/^\[REG\] (\d+) ([0-9a-f]+)$/);
    if (m) { regs[Number(m[1])] = m[2]; continue; }
    const r = line.match(/^\[REG\] rip ([0-9a-f]+)$/);
    if (r) { rip = r[1]; continue; }
    const f = line.match(/^\[REG\] flags ([0-9a-f]+)$/);
    if (f) { flags = f[1]; continue; }
    const i = line.match(/^\[REG\] insns (\d+)$/);
    if (i) { insns = Number(i[1]); }
  }
  return { regs, rip, flags, insns };
}

async function wasmSnapshot() {
  const buf = fs.readFileSync('web/sim.wasm');
  const mod = await WebAssembly.compile(buf);
  const inst = await WebAssembly.instantiate(mod, {});
  const w = inst.exports;
  const STAGE = 0x0d800000;
  const fw = new Uint8Array(fs.readFileSync(FW));
  const mem = new Uint8Array(w.memory.buffer);
  if (STAGE + fw.length > mem.length) throw new Error('stage overflow');
  mem.set(fw, STAGE);
  w.sim_set_cmdline('console=ttyS0,115200 loglevel=4 panic=-1 acpi=off pci=off');
  const rc = w.sim_init(STAGE, fw.length);
  if (rc !== 0) throw new Error('sim_init rc=' + rc);
  w.sim_set_stopt(BigInt(N));
  // 一次跑够；里面会在 stopt 处自己停
  let guard = 0;
  while (Number(w.sim_insns()) < N && guard++ < 40) w.sim_run(2000000);
  const regs = [];
  for (let i = 0; i < 16; i++)
    regs.push(BigInt.asUintN(64, w.sim_cpu_reg(i)).toString(16));
  return { regs, rip: BigInt.asUintN(64, w.sim_last_rip()).toString(16),
           flags: BigInt.asUintN(64, w.sim_cpu_flags()).toString(16),
           insns: Number(w.sim_insns()) };
}

(async () => {
  const nat = nativeSnapshot();
  const was = await wasmSnapshot();
  let first = -1;
  for (let i = 0; i < 16; i++) {
    if ((nat.regs[i] || '') !== (was.regs[i] || '')) { first = i; break; }
  }
  const ripDiff = nat.rip !== was.rip;
  const flagsDiff = nat.flags !== was.flags;
  if (!QUIET) {
    console.log('N =', N, 'insns nat/wasm =', nat.insns, '/', was.insns);
    for (let i = 0; i < 16; i++) {
      const mark = (nat.regs[i] || '') !== (was.regs[i] || '') ? '   <-- DIFF' : '';
      console.log(`  r${i.toString().padStart(2)}  nat=${nat.regs[i] || '?'}  wasm=${was.regs[i]}${mark}`);
    }
    console.log(`  rip   nat=${nat.rip}  wasm=${was.rip}${ripDiff ? '   <-- DIFF' : ''}`);
    console.log(`  flags nat=${nat.flags}  wasm=${was.flags}${flagsDiff ? '   <-- DIFF' : ''}`);
  }
  const same = first < 0 && !ripDiff && !flagsDiff;
  console.log(same ? `MATCH at ${N}` : `DIVERGE at ${N} (first reg r${first})`);
  process.exitCode = same ? 0 : 1;
})().catch(e => { console.error('failed:', e.message); process.exit(1); });