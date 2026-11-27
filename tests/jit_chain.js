#!/usr/bin/env node
/* tests/jit_chain.js —— 块链式执行的合成测试
 *
 * 两个块放在相距 0x100 的地址（避开直接映射缓存/seen 表的同槽冲突）。
 * 先分别热到编译阈值，再重置状态从第一块跑；JS 侧应把第二块接上。
 * 与解释器 sim_run(nA+nB) 比较全部寄存器/RFLAGS/RIP。
 */
process.env.JIT_CHAIN_FALL = '0';   // 这个测试专门验证分支链
const fs = require('fs');
const path = require('path');
const { makeJitEnv } = require('./jit_hooks');

const ROOT = path.dirname(__dirname);
const WASM = path.join(ROOT, 'web', 'sim.wasm');
const P = 0x3000;

(async () => {
  const mod = new WebAssembly.Module(fs.readFileSync(WASM));
  let inst = null;
  const jit = makeJitEnv(() => inst);
  inst = await WebAssembly.instantiate(mod, { env: jit.env });
  const w = inst.exports;
  if (w.sim_reset() !== 0) throw new Error('reset');

  const ram = w.sim_ram_base();
  const mem = new Uint8Array(w.memory.buffer);
  w.sim_set_jit(1);
  w.sim_set_jit_window(BigInt(P), BigInt(P + 0x1000));

  function reset(rip) {
    for (let i = 0; i < 16; i++) w.sim_set_reg(i, 0n);
    w.sim_set_flags(2n);
    w.sim_set_rip(BigInt(rip));
  }
  function snap() {
    const r = [];
    for (let i = 0; i < 16; i++) r.push(w.sim_get_reg(i));
    return { r, f: w.sim_get_flags(), rip: w.sim_get_rip() };
  }
  function put(code, off) {
    code.forEach((b, i) => (mem[ram + off + i] = b));
  }
  function cmp(name, a, b) {
    let bad = 0;
    for (let i = 0; i < 16; i++) {
      if (a.r[i] !== b.r[i]) {
        console.error(`${name}: r${i} ${a.r[i]} != ${b.r[i]}`);
        bad++;
      }
    }
    if (a.f !== b.f) { console.error(`${name}: flags ${a.f} != ${b.f}`); bad++; }
    if (a.rip !== b.rip) { console.error(`${name}: rip ${a.rip} != ${b.rip}`); bad++; }
    console.log(`${bad ? 'FAIL' : 'PASS'} ${name} rax=${a.r[0]} rip=0x${a.rip.toString(16)}`);
    return bad;
  }
  /* 热块阈值 64：重复调用直到编译/执行 */
  function warm(rip) {
    let r = 0;
    for (let k = 0; k < 96; k++) {
      reset(rip);
      r = w.sim_jit_try(BigInt(rip));
      if (r > 0) break;
    }
    return r;
  }

  let bad = 0;

  /* 1) jmp 链：A 跳到 P+0x100 的 B */
  put([0xb8, 0x05, 0x00, 0x00, 0x00, 0xe9, 0xf6, 0x00, 0x00, 0x00], P);
  put([0x83, 0xc0, 0x03, 0x90], P + 0x100);
  const b1 = warm(P + 0x100);
  const a1 = warm(P);
  reset(P);
  const r1 = w.sim_jit_try(BigInt(P));
  const cs1 = snap();
  reset(P);
  w.sim_run(4);
  const is1 = snap();
  console.log(`jmp: B=${b1} A=${a1} chain=${r1}`);
  if (r1 !== 4) { console.error('FAIL jmp chain length'); bad++; }
  bad += cmp('jmp_chain', cs1, is1);

  /* 2) je 链：A 条件跳到 P2+0x200 的 B（换一个 A 地址，避开旧缓存） */
  const P2 = P + 0x400;
  put([0xb8, 0x01, 0x00, 0x00, 0x00,
       0x83, 0xf8, 0x01,
       0x0f, 0x84, 0xf2, 0x01, 0x00, 0x00], P2);
  put([0x83, 0xc0, 0x02, 0x90], P2 + 0x200);
  const b2 = warm(P2 + 0x200);
  const a2 = warm(P2);
  reset(P2);
  const r2 = w.sim_jit_try(BigInt(P2));
  const cs2 = snap();
  reset(P2);
  w.sim_run(5);
  const is2 = snap();
  console.log(`je: B=${b2} A=${a2} chain=${r2}`);
  if (r2 !== 5) { console.error('FAIL je chain length'); bad++; }
  bad += cmp('je_chain', cs2, is2);

  /* 3) A: mov/cmp/jmp B；B 是 je：跨块标志位 + 分支作为被链块 */
  const P4 = P + 0x800;
  put([0xb8, 0x01, 0x00, 0x00, 0x00,
       0x83, 0xf8, 0x01,
       0xe9, 0xf3, 0x00, 0x00, 0x00], P4);
  put([0x0f, 0x84, 0xfa, 0x00, 0x00, 0x00], P4 + 0x100);
  const b5 = warm(P4 + 0x100);
  const a5 = warm(P4);
  reset(P4);
  const r5 = w.sim_jit_try(BigInt(P4));
  const cs5 = snap();
  reset(P4);
  w.sim_run(4);
  const is5 = snap();
  console.log(`branch-as-chain taken: B=${b5} A=${a5} chain=${r5}`);
  if (r5 !== 4) { console.error('FAIL branch-chain length'); bad++; }
  bad += cmp('branch_chain_taken', cs5, is5);

  /* 4) 预算：A 长 3，B 长 1 */
  reset(P4);
  const q2 = w.sim_jit_try2(BigInt(P4), 2);
  const q2s = snap();
  reset(P4);
  const q3 = w.sim_jit_try2(BigInt(P4), 3);
  const q3s = snap();
  reset(P4);
  const q4 = w.sim_jit_try2(BigInt(P4), 4);
  const q4s = snap();
  reset(P4);
  w.sim_run(4);
  const qis = snap();
  console.log(`budget: 2->${q2} 3->${q3} 4->${q4}`);
  if (q2 !== 0 || q3 !== 3 || q4 !== 4) { console.error('FAIL chain budget'); bad++; }
  bad += cmp('budget_chain', q4s, qis);

  /* 5) 循环链：dec ecx; jnz -4，按预算跑多圈 */
  const P5 = P + 0xc00;
  put([0xff, 0xc9, 0x75, 0xfc], P5);
  let warmLoop = 0;
  for (let k = 0; k < 96; k++) {
    reset(P5);
    w.sim_set_reg(1, 5n);
    warmLoop = w.sim_jit_try2(BigInt(P5), 2);
    if (warmLoop > 0) break;
  }
  reset(P5);
  w.sim_set_reg(1, 5n);
  const r6 = w.sim_jit_try2(BigInt(P5), 10);
  const cs6 = snap();
  reset(P5);
  w.sim_set_reg(1, 5n);
  w.sim_run(10);
  const is6 = snap();
  console.log(`loop budget10: warm=${warmLoop} chain=${r6}`);
  if (r6 !== 10) { console.error('FAIL loop10 length'); bad++; }
  bad += cmp('loop10', cs6, is6);

  reset(P5);
  w.sim_set_reg(1, 5n);
  const r7 = w.sim_jit_try2(BigInt(P5), 9);
  const cs7 = snap();
  reset(P5);
  w.sim_set_reg(1, 5n);
  w.sim_run(8);
  const is7 = snap();
  console.log(`loop budget9: chain=${r7}`);
  if (r7 !== 8) { console.error('FAIL loop9 length'); bad++; }
  bad += cmp('loop9', cs7, is7);

  if (bad) { console.error(`[jit_chain] ${bad} mismatch(es)`); process.exit(1); }
  console.log('[jit_chain] PASS');
})();
