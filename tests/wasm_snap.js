/* tests/wasm_snap.js —— 检查点快照对拍：一次跑完整个区间，直接给出第一个分叉点。
 *
 * 以前的二分法每一步都要重跑 native + wasm（各几分钟）。这里改成：
 *   native 一次 `--stopt=END --snap=START,STEP` —— 在循环里每到检查点就打一行
 *   `[SNAP] <insns> <rip> <flags> r0..r15`；
 *   wasm   一次分块 `sim_run(STEP)` —— 每块结束读同样的字段；
 * 两边按指令数配对比较，第一个不一致的检查点就是分叉区间（精度 = STEP）。
 *
 * 用法:
 *   node tests/wasm_snap.js [start] [step] [end]
 *   默认 150000000 1000000 200000000（即已知 MATCH 与已知 DIVERGE 之间）
 * 退出码: 0 = 全区间一致，1 = 找到分叉。
 */
const fs = require('fs');
const { execFileSync } = require('child_process');

const START = Number(process.argv[2] || 150000000);
const STEP = Number(process.argv[3] || 1000000);
const END = Number(process.argv[4] || 200000000);
const SIM = process.env.SIM || 'build/sim';
const FW = process.env.FW || 'build/firmware.bin';
const WASM = process.env.WASM || 'web/sim.wasm';

function nativeSnaps() {
  const args = ['--stopt=' + END, '--snap=' + START + ',' + STEP,
                '--cmdline=console=ttyS0,115200 loglevel=4 panic=-1 acpi=off pci=conf1', FW];
  let out = '';
  try {
    out = execFileSync(SIM, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
                                    timeout: 3600000, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    out = (e.stdout || '').toString();
  }
  const map = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^\[SNAP\] (\d+) ([0-9a-f]+) ([0-9a-f]+)((?: [0-9a-f]+){16})(?: clk=([0-9a-f]+) rsn=([0-9a-f]+) pit=([0-9a-f]+))?(?: pic=([0-9a-f]+))?$/);
    if (!m) continue;
    map.set(Number(m[1]), { rip: m[2], flags: m[3], regs: m[4].trim().split(' '), clk: m[5] || null, rsn: m[6] || null, pit: m[7] || null, pic: m[8] || null });
  }
  return map;
}

async function wasmSnaps() {
  const mod = await WebAssembly.compile(fs.readFileSync(WASM));
  const w = (await WebAssembly.instantiate(mod, {})).exports;
  const STAGE = 0x0d800000;
  const fw = new Uint8Array(fs.readFileSync(FW));
  new Uint8Array(w.memory.buffer).set(fw, STAGE);
  w.sim_set_cmdline('console=ttyS0,115200 loglevel=4 panic=-1 acpi=off pci=conf1');
  const rc = w.sim_init(STAGE, fw.length);
  if (rc !== 0) throw new Error('sim_init rc=' + rc);

  const map = new Map();
  const hex64 = v => BigInt.asUintN(64, v).toString(16);
  /* 必须精确停在每个检查点：sim_run 的 idle 路径一次加 0x2000，直接跑会冲过头。 */
  /* 检查点必须是 STEP 的整数倍（native 端的 --snap 也按这个条件打印），
   * 否则两边 key 集合不同，会被误报成「wasm 缺检查点」。 */
  const k0 = Math.ceil(START / STEP) * STEP;
  for (let k = k0; k <= END; k += STEP) {
    w.sim_set_stopt(BigInt(k));
    w.sim_run(k + STEP);  /* 从当前位置一直跑到 stopt=k；返回 0 只是停在那里 */
    if (Number(w.sim_insns()) !== k) { console.log('检查点', k, '未精确命中:', Number(w.sim_insns())); break; }
    const regs = [];
    for (let i = 0; i < 16; i++) regs.push(hex64(w.sim_cpu_reg(i)));
    map.set(k, { rip: hex64(w.sim_last_rip()), flags: hex64(w.sim_cpu_flags()), regs, clk: hex64(w.sim_clock_state()), rsn: hex64(w.sim_raise_state()), pit: hex64(w.sim_pit_phase()), pic: hex64(w.sim_pic_state()) });
  }
  return map;
}

(async () => {
  console.log(`扫描区间 ${START} .. ${END}，步长 ${STEP}`);
  const nat = nativeSnaps();
  console.log(`native 检查点 ${nat.size} 个`);
  const was = await wasmSnaps();
  console.log(`wasm   检查点 ${was.size} 个`);

  const keys = [...nat.keys()].sort((a, b) => a - b);
  let bad = null, ripSkew = null;
  const diffs = [];
  for (const k of keys) {
    const a = nat.get(k);
    const b = was.get(k);
    if (!b) { bad = { k, why: 'wasm 缺检查点' }; break; }
    /* RIP 单独看：native 在 instructions++ 之后、step() 之前快照，wasm 在 stopt
       处返回，两者可能差一条指令；寄存器/flags 相同就认为状态一致。 */
    if (a.rip !== b.rip && !ripSkew) ripSkew = { k, nat: a.rip, was: b.rip };
    if (a.rsn && b.rsn && a.rsn !== b.rsn) { bad = bad || { k, why: `rsn ${a.rsn} vs ${b.rsn}` }; diffs.push({ k, why: 'rsn' }); continue; }
    if (a.pit && b.pit && a.pit !== b.pit) { bad = bad || { k, why: `pit ${a.pit} vs ${b.pit}` }; diffs.push({ k, why: 'pit' }); continue; }
    if (a.clk && b.clk && a.clk !== b.clk) { bad = bad || { k, why: `clk ${a.clk} vs ${b.clk}` }; diffs.push({ k, why: 'clk' }); continue; }
    if (a.pic && b.pic && a.pic !== b.pic) { bad = { k, why: `pic ${a.pic} vs ${b.pic}` }; break; }
    if (a.flags !== b.flags) { bad = { k, why: `flags ${a.flags} vs ${b.flags}` }; break; }
    for (let i = 0; i < 16; i++) {
      if (a.regs[i] !== b.regs[i]) { bad = { k, why: `r${i} ${a.regs[i]} vs ${b.regs[i]}` }; break; }
    }
    if (bad) break;
  }

  if (!bad) {
    if (ripSkew) console.log('  首次 RIP 偏移（寄存器一致，视为对齐 artifact）: ' + ripSkew.k + ' native=' + ripSkew.nat + ' wasm=' + ripSkew.was);
    console.log('SNAP MATCH（' + keys.length + ' 个检查点寄存器全部一致）');
    process.exitCode = 0;
  } else {
    const a = nat.get(bad.k), b = was.get(bad.k);
    console.log(`SNAP DIVERGE at ${bad.k}: ${bad.why}`);
    if (a && b) {
      console.log('  native:', a.rip, a.flags, a.regs.join(' '));
      console.log('  wasm  :', b.rip, b.flags, b.regs.join(' '));
    }
    const prev = keys.filter(k => k < bad.k).pop();
    console.log('  上一个一致的检查点: ' + (prev === undefined ? '(无，说明 ' + START + ' 处就已不同)' : prev));
    process.exitCode = 1;
  }
})().catch(e => { console.log('failed:', e.message); process.exit(1); });