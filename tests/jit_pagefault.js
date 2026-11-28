#!/usr/bin/env node
/* tests/jit_pagefault.js —— 链式块里的缺页投递（paging 合成测试）
 *
 * 4 级页表：VA 0x40000000 -> PA 0x2000（代码），VA 0x40001000 -> PA
 * 0x4000（栈），VA 0x40002000 不映射（guard）。代码：
 *   A: mov rsp,0x40002000; jmp B
 *   B: ret
 * A 是 2 条（jmp 结尾），JS 链到 B 的 ret；ret 从 guard 页读返回地址
 * 缺页。JIT 开（采样 + 链）与解释器各跑 3 条，比较寄存器/RIP/RFLAGS/
 * halted 和缺页投递后的状态。
 */
process.env.JIT_CHAIN_FALL = '0';
const fs = require('fs');
const path = require('path');
const { makeJitEnv } = require('./jit_hooks');

const ROOT = path.dirname(__dirname);
const WINDOW_LO = 0x40000000n;
const WINDOW_HI = 0x40001000n;

(async () => {
  const mod = new WebAssembly.Module(fs.readFileSync(path.join(ROOT, 'web', 'sim.wasm')));
  let inst = null;
  const jit = makeJitEnv(() => inst);
  inst = await WebAssembly.instantiate(mod, { env: jit.env });
  const w = inst.exports;
  if (w.sim_set_jit_min_n) w.sim_set_jit_min_n(1);   /* 单元测试的块很短 */
  if (w.sim_set_jit_no_mem) w.sim_set_jit_no_mem(0);

  function setup() {
    w.sim_reset();
    const base = Number(w.sim_ram_base());
    const dv = new DataView(w.memory.buffer);
    const q = (off, v) => dv.setBigUint64(base + off, BigInt(v), true);
    q(0x10000, 0x11003n);            /* PML4[0] -> PDPT */
    q(0x11008, 0x12003n);            /* PDPT[1] -> PD */
    q(0x12000, 0x13003n);            /* PD[0] -> PT */
    q(0x13000, 0x2003n);             /* PT[0] code 0x40000000 -> PA 0x2000 */
    q(0x13008, 0x4003n);             /* PT[1] stack 0x40001000 -> PA 0x4000 */
    q(0x13010, 0n);                  /* PT[2] guard 0x40002000 不存在 */

    const a = [0x48, 0xbc, 0x00, 0x20, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00,
               0xe9, 0xf1, 0x01, 0x00, 0x00];
    a.forEach((b, i) => dv.setUint8(base + 0x2000 + i, b));
    dv.setUint8(base + 0x2200, 0xc3);  /* B: ret */

    w.sim_set_cr(3, 0x10000n);
    w.sim_set_cr(0, 0x80000001n);      /* PG|PE */
    w.sim_set_cr(4, 0x20n);            /* PAE */
    w.sim_set_efer(0x900n);            /* LME|LMA */
    w.sim_set_sel(1, 0x10n);
    w.sim_set_sel(2, 0x18n);
    for (let i = 0; i < 16; i++) w.sim_set_reg(i, 0n);
    w.sim_set_flags(2n);
    w.sim_set_rip(WINDOW_LO);
  }
  function snap() {
    const r = [];
    for (let i = 0; i < 16; i++) r.push(w.sim_get_reg(i));
    return { r, f: w.sim_get_flags(), rip: BigInt.asUintN(64, w.sim_get_rip()),
             halted: w.sim_cpu_halted() };
  }

  /* JIT on：采样编译 A，链到预编译的 B；ret 缺页 */
  setup();
  w.sim_set_jit(1);
  w.sim_set_jit_window(WINDOW_LO, WINDOW_HI);
  const cB = w.sim_jit_compile_only(0x40000200n);
  w.sim_run(3);
  const j = snap();
  console.log(`compile B=${cB}`);

  /* 解释器 */
  setup();
  w.sim_set_jit(0);
  w.sim_run(3);
  const i = snap();

  let bad = 0;
  for (let k = 0; k < 16; k++) {
    if (j.r[k] !== i.r[k]) {
      console.error(`r${k} jit=${j.r[k]} interp=${i.r[k]}`);
      bad++;
    }
  }
  if (j.f !== i.f) { console.error(`flags ${j.f} != ${i.f}`); bad++; }
  if (j.rip !== i.rip) {
    console.error(`rip jit=0x${j.rip.toString(16)} interp=0x${i.rip.toString(16)}`);
    bad++;
  }
  if (j.halted !== i.halted) {
    console.error(`halted jit=${j.halted} interp=${i.halted}`);
    bad++;
  }
  console.log(`jit: rip=0x${j.rip.toString(16)} rsp=0x${j.r[4].toString(16)} halted=${j.halted}`);
  console.log(`int: rip=0x${i.rip.toString(16)} rsp=0x${i.r[4].toString(16)} halted=${i.halted}`);
  /* 缺页 load：mov rbx,[guard]；解释器会把 mem_r64 的返回（垃圾）写进 RBX，
   * JIT 当前在写目的寄存器前就中止 */
  function loadRun(useJit) {
    setup();
    const base = Number(w.sim_ram_base());
    const dv = new DataView(w.memory.buffer);
    const c = [0x48, 0xb8, 0x00, 0x20, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00,
               0x48, 0x8b, 0x18];
    c.forEach((b, i) => dv.setUint8(base + 0x2300 + i, b));
    /* 缺页后 mem_r64 会拿 pa=0 读 RAM[0..7]；写成非零以暴露
     * “解释器把垃圾写进目的寄存器、JIT 不写”的差异 */
    dv.setBigUint64(base + 0, 0xdeadbeefcafebaben, true);
    if (useJit) {
      w.sim_set_jit(1);
      w.sim_set_jit_window(WINDOW_LO, WINDOW_HI);
    } else {
      w.sim_set_jit(0);
    }
    w.sim_set_rip(0x40000300n);
    w.sim_set_reg(3, 0x123456789n);   /* 目的寄存器初值非零 */
    w.sim_run(2);
    return snap();
  }
  const lj = loadRun(true);
  const li = loadRun(false);
  console.log(`load fault: jit rbx=0x${lj.r[3].toString(16)} rip=0x${lj.rip.toString(16)} halted=${lj.halted}`);
  console.log(`load fault: int rbx=0x${li.r[3].toString(16)} rip=0x${li.rip.toString(16)} halted=${li.halted}`);
  if (lj.r[3] !== li.r[3]) {
    console.error(`load fault RBX jit=0x${lj.r[3].toString(16)} interp=0x${li.r[3].toString(16)}`);
    bad++;
  }
  if (lj.rip !== li.rip) { console.error('load fault RIP differs'); bad++; }
  if (lj.halted !== li.halted) { console.error('load fault halted differs'); bad++; }

  if (bad) { console.error(`[jit_pagefault] ${bad} mismatch(es)`); process.exit(1); }
  console.log('[jit_pagefault] PASS');
})();
