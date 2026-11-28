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
const { makeJitEnv } = require('./jit_hooks');

const N = Number(process.argv[2] || 1000000);
const QUIET = process.argv.includes('--quiet');
const SIM = process.env.SIM || 'build/sim';
const FW = process.env.FW || 'build/firmware.bin';

function nativeSnapshot() {
  let out = '';
  try {
    const args = ['--stopt=' + N, '--dumpregs'];
    if (process.env.REGION) args.push('--memhash=' + process.env.REGION);
    args.push('--cmdline=console=ttyS0,115200 loglevel=4 panic=-1 acpi=off pci=conf1', FW);
    out = execFileSync(SIM, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
                                   timeout: 600000 });
  } catch (e) {
    out = (e.stdout || '').toString();
  }
  const regs = new Array(16).fill(null);
  let rip = null, flags = null, insns = null, memregion = null; const memhash = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\[REG\] (\d+) ([0-9a-f]+)$/);
    if (m) { regs[Number(m[1])] = m[2]; continue; }
    const r = line.match(/^\[REG\] rip ([0-9a-f]+)$/);
    if (r) { rip = r[1]; continue; }
    const f = line.match(/^\[REG\] flags ([0-9a-f]+)$/);
    if (f) { flags = f[1]; continue; }
    const i = line.match(/^\[REG\] insns (\d+)$/);
    if (i) { insns = Number(i[1]); continue; }
    const h = line.match(/^\[MEMH\] (\d+) ([0-9a-f]+)$/);
    if (h) { memhash[Number(h[1])] = h[2]; }
    const mr = line.match(/^\[MEMR\] ([0-9a-f]+)$/);
    if (mr) { memregion = mr[1]; }
  }
  const bytes = {};
  if (process.env.BYTES) {
    for (const a of process.env.BYTES.split(',').map(Number)) bytes[a] = nat.regs ? null : null;
  }
  return { regs, rip, flags, insns, memhash, memregion, bytes };
}

async function wasmSnapshot() {
  const buf = fs.readFileSync('web/sim.wasm');
  const mod = await WebAssembly.compile(buf);
  const imports = WebAssembly.Module.imports(mod);
  const hasJit = imports.some((i) => i.module === 'env' && i.name === 'js_jit_compile');
  let inst = null;
  const jit = makeJitEnv(() => inst);
  inst = await WebAssembly.instantiate(mod, hasJit ? { env: jit.env } : {});
  const w = inst.exports;
  if (hasJit && process.env.JIT_OFF === '1' && w.sim_set_jit) w.sim_set_jit(0);
  const STAGE = w.sim_fw_stage_ptr ? Number(w.sim_fw_stage_ptr()) : 0x0d800000;
  const fw = new Uint8Array(fs.readFileSync(FW));
  const mem = new Uint8Array(w.memory.buffer);
  if (STAGE + fw.length > mem.length) throw new Error('stage overflow');
  mem.set(fw, STAGE);
  w.sim_set_cmdline('console=ttyS0,115200 loglevel=4 panic=-1 acpi=off pci=conf1');
  const rc = w.sim_init(STAGE, fw.length);
  if (rc !== 0) throw new Error('sim_init rc=' + rc);
  if (w.sim_set_paced) w.sim_set_paced(0);   /* 对拍/序列：固定 1/17，不按墙钟校准 */
  w.sim_set_stopt(BigInt(N));
  if (hasJit && process.env.JIT_MIN_N && w.sim_set_jit_min_n) w.sim_set_jit_min_n(Number(process.env.JIT_MIN_N));
  if (hasJit && process.env.JIT_TRACE === '1' && w.sim_set_jit_trace) w.sim_set_jit_trace(1);
  if (hasJit && process.env.JIT_MASK && w.sim_set_jit_mask) w.sim_set_jit_mask(Number(process.env.JIT_MASK));
  // 一次跑够；里面会在 stopt 处自己停
  let guard = 0;
  while (Number(w.sim_insns()) < N && guard++ < 2000) w.sim_run(2000000);
  const ramBase = Number(w.sim_ram_base());
  let ramView = new Uint8Array(w.memory.buffer, ramBase, 128 * 1024 * 1024);
  const memhash = [];
  for (let c = 0; c < 128; c++) {
    let h = 0xcbf29ce484222325n;
    const base = c * 0x100000;
    for (let i = 0; i < 0x100000; i++) {
      h = ((h ^ BigInt(ramView[base + i])) * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    memhash.push(h.toString(16));
  }
  ramView = new Uint8Array(w.memory.buffer, ramBase, 128 * 1024 * 1024);
  if (process.env.DUMPMEM) {
    const [ds, dl] = process.env.DUMPMEM.split(',').map(Number);
    let outN = '';
    for (let o = 0; o + 16 <= dl; o += 16) {
      let line = (ds + o).toString(16) + ' ';
      for (let j = 0; j < 16; j++)
        line += ramView[ds + o + j].toString(16).padStart(2, '0');
      outN += line + '\n';
    }
    fs.writeFileSync(process.env.DUMP_OUT || '/tmp/wasm_mem.txt', outN);
    console.log('wasm mem dump ->', process.env.DUMP_OUT || '/tmp/wasm_mem.txt');
  }
  if (process.env.JIT_TRACE === '1' && w.__c6_wasm_con_ptr) {
    const cp = Number(w.__c6_wasm_con_ptr());
    const cl = Number(w.__c6_wasm_con_len());
    if (cp && cl) {
      console.error('[trace]\n' +
        new TextDecoder().decode(new Uint8Array(w.memory.buffer, cp, cl)));
    }
  }
  const regs = [];
  for (let i = 0; i < 16; i++)
    regs.push(BigInt.asUintN(64, w.sim_cpu_reg(i)).toString(16));
  if (hasJit && process.env.JIT_STATS === '1') {
    console.error(
      `[jit] runs=${w.sim_jit_stat(0)} hits=${w.sim_jit_stat(1)} ` +
      `compiles=${w.sim_jit_stat(3)} insns=${w.sim_jit_stat(6)}`
    );
  }
  return { regs, rip: BigInt.asUintN(64, w.sim_last_rip()).toString(16),
           flags: BigInt.asUintN(64, w.sim_cpu_flags()).toString(16),
           insns: Number(w.sim_insns()),
           memhash,
           memregion: (() => {
             if (!process.env.REGION) return null;
             const [rs, rl] = process.env.REGION.split(',').map(Number);
             return BigInt.asUintN(64, w.sim_mem_hash_region(BigInt(rs), BigInt(rl))).toString(16);
           })() };
}

(async () => {
  const nat = nativeSnapshot();
  const was = await wasmSnapshot();
  let first = -1;
  for (let i = 0; i < 16; i++) {
    if ((nat.regs[i] || '') !== (was.regs[i] || '')) { first = i; break; }
  }
  const ripDiff = nat.rip !== was.rip;
  let regionDiff = false;
  if (process.env.REGION) regionDiff = nat.memregion !== was.memregion;
  let memDiff = false;
  let memFirst = -1;
  for (let c = 0; c < 128; c++) {
    if (nat.memhash[c] !== was.memhash[c]) { memDiff = true; if (memFirst < 0) memFirst = c; }
  }
  const flagsDiff = nat.flags !== was.flags;
  if (!QUIET) {
    console.log('N =', N, 'insns nat/wasm =', nat.insns, '/', was.insns);
    for (let i = 0; i < 16; i++) {
      const mark = (nat.regs[i] || '') !== (was.regs[i] || '') ? '   <-- DIFF' : '';
      console.log(`  r${i.toString().padStart(2)}  nat=${nat.regs[i] || '?'}  wasm=${was.regs[i]}${mark}`);
    }
    console.log(`  rip   nat=${nat.rip}  wasm=${was.rip}${ripDiff ? '   <-- DIFF' : ''}`);
    console.log(`  flags nat=${nat.flags}  wasm=${was.flags}${flagsDiff ? '   <-- DIFF' : ''}`);
    if (process.env.REGION)
      console.log(`  region nat=${nat.memregion} wasm=${was.memregion}${regionDiff ? '   <-- DIFF' : ''}`);
    if (process.env.BYTES) {
      const addrs = process.env.BYTES.split(',').map(Number);
      const nb = addrs.map(a => nat.bytes[a]).join(' ');
      const wb = addrs.map(a => was.bytes[a]).join(' ');
      console.log(`  bytes  0x${'?'} nat=[${nb}] wasm=[${wb}]`);
    }
    console.log(`  mem   ${memDiff ? 'DIFF first chunk ' + memFirst + ' (0x' + (memFirst*0x100000).toString(16) + ')'
                                              : 'MATCH'} `);
  }
  // 指定 REGION 时只看该区域（整机 128 分块哈希在调试期噪声太大）
  const same = process.env.REGION
    ? (first < 0 && !ripDiff && !flagsDiff && !regionDiff)
    : (first < 0 && !ripDiff && !flagsDiff && !memDiff);
  console.log(same ? `MATCH at ${N}` : `DIVERGE at ${N} (first reg r${first})`);
  process.exitCode = same ? 0 : 1;
})().catch(e => { console.error('failed:', e.message); process.exit(1); });