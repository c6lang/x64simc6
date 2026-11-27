'use strict';
/* tests/jit_hooks.js —— JIT=1 wasm 的共享 JS import 钩子
 *
 * 主模块（JIT=1）只 import 两个钩子：
 *   js_jit_compile(ptr, len, rip_lo, rip_hi, n, pa_page, gen) -> handle
 *   js_jit_run(handle, state, ram, rip_off, max_ins) -> 执行的指令数
 *
 * js_jit_run 在 JS 侧按 RIP 连续跑一串已缓存的块，每块先比对
 * jit_page_gen[pa_page]（SMC 写代数），再调该块 wasm 实例的 run；遇到
 * 未编译的下一个 RIP、写代数变化或预算用尽就返回。这样一次 wasm→JS
 * 调用可以摊薄多个基本块，减少 wasm↔JS 切换。
 */
function makeJitEnv(getInst) {
  const NOCHAIN = process.env.JIT_NOCHAIN === '1';
  const PAGE_ONLY = process.env.JIT_CHAIN_PAGE === '1';
  const FALL_ONLY = process.env.JIT_CHAIN_FALL !== '0';
  const SIMPLE = NOCHAIN || FALL_ONLY;   /* 默认不做分支链，直接走单块快路径 */
  const handles = [];
  const byRip = new Map();
  let genView = null;

  const env = {
    js_jit_compile(ptr, len, ripLo, ripHi, n, pa, gen, branch) {
      const inst = getInst();
      if (!inst || handles.length >= 32768) return -1;
      try {
        const bytes = new Uint8Array(inst.exports.memory.buffer, ptr >>> 0, len >>> 0).slice();
        const m = new WebAssembly.Module(bytes);
        const i = new WebAssembly.Instance(m, {
          env: {
            memory: inst.exports.memory,
            jit_flags_add: inst.exports.jit_flags_add,
            jit_flags_sub: inst.exports.jit_flags_sub,
            jit_flags_logic: inst.exports.jit_flags_logic,
            jit_flags_inc: inst.exports.jit_flags_inc,
            jit_flags_dec: inst.exports.jit_flags_dec,
            jit_cond: inst.exports.jit_cond,
          },
        });
        const h = handles.length;
        handles.push({ inst: i, n: n >>> 0, pa: pa >>> 0, gen: gen >>> 0, rip: ripLo >>> 0, branch: branch >>> 0 });
        byRip.set(ripLo >>> 0, { h, hi: ripHi >>> 0, rip: ripLo >>> 0 });
        return h;
      } catch (e) {
        return -1;
      }
    },

    js_jit_run(h, state, ram, ripOff, maxIns) {
      const inst = getInst();
      if (!inst || h < 0 || h >= handles.length) return -2;
      if (SIMPLE) {
        const e = handles[h];
        if (e.n > (maxIns >>> 0)) return 0;   /* 预算不够：回退解释器 */
        const rc = e.inst.exports.run(state, ram);
        return rc === 0 ? e.n : -2;
      }
      const buf = inst.exports.memory.buffer;
      if (!genView || genView.buffer !== buf) {
        genView = new Uint32Array(buf, inst.exports.jit_gen_base(), 32768);
      }
      const dv = new DataView(buf);
      const lim = maxIns >>> 0;
      let total = 0;
      let cur = h;
      while (cur >= 0) {
        const e = handles[cur];
        if (!e || total + e.n > lim) break;
        if (genView[e.pa] !== e.gen) break;
        if (e.inst.exports.run(state, ram) !== 0) break;
        total += e.n;
        if (NOCHAIN) break;
        if (FALL_ONLY && e.branch) break;
        const lo = dv.getUint32((state >>> 0) + (ripOff >>> 0), true);
        const hi = dv.getUint32((state >>> 0) + (ripOff >>> 0) + 4, true);
        const nx = byRip.get(lo);
        if (!nx || nx.hi !== hi) break;
        if (PAGE_ONLY && (nx.rip >>> 12) !== (e.rip >>> 12)) break;
        cur = nx.h;
      }
      return total | 0;
    },
  };

  return { env, handles, byRip };
}

module.exports = { makeJitEnv };
