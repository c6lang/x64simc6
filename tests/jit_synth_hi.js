#!/usr/bin/env node
/* tests/jit_synth_hi.js —— 高地址 RIP 的 JS 链式分发（不取指/不执行客户机代码）
 *
 * 合成两个块：A 在 0xffffffff81000000 写 EAX 或 jmp，B 在 +0x10 写 EAX。
 * A 的结束 RIP 指向 B；JS 钩子应读到 64 位高地址并接上 B。
 */
process.env.JIT_CHAIN_FALL = '0';   // 启用链式（默认单块直跑）
const fs = require('fs');
const path = require('path');
const { makeJitEnv } = require('./jit_hooks');

const ROOT = path.dirname(__dirname);

(async () => {
  const mod = new WebAssembly.Module(fs.readFileSync(path.join(ROOT, 'web', 'sim.wasm')));
  let inst = null;
  const jit = makeJitEnv(() => inst);
  inst = await WebAssembly.instantiate(mod, { env: jit.env });
  const w = inst.exports;
  if (w.sim_reset() !== 0) throw new Error('reset');

  let bad = 0;
  function check(name, a, b, ia, ib, mode) {
    const A = BigInt(a), B = BigInt(b);
    w.sim_set_reg(0, 0n);
    const rc = w.sim_jit_synth(A, B, ia, ib, mode);
    const rax = w.sim_get_reg(0);
    const rip = BigInt.asUintN(64, w.sim_get_rip());
    const ok = rc === 2 && rax === BigInt(ib) && rip === B + 16n;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} rc=${rc} rax=${rax} rip=0x${rip.toString(16)}`);
    if (!ok) bad++;
  }

  /* mov eax,ia -> chain -> mov eax,ib */
  check('hi_mov_chain', 0xffffffff81000000n, 0xffffffff81000010n, 1, 2, 0);
  /* jmp B -> chain -> mov eax,ib */
  check('hi_jmp_chain', 0xffffffff81000100n, 0xffffffff81000110n, 0, 3, 1);

  if (bad) { console.error(`[jit_synth_hi] ${bad} mismatch(es)`); process.exit(1); }
  console.log('[jit_synth_hi] PASS');
})();
