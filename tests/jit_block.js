#!/usr/bin/env node
/* tests/jit_block.js —— wasm 直线块 JIT 与解释器逐寄存器/标志位对拍
 *
 * 覆盖：mov imm32 / mov r32,r32 / add/sub/and/or/xor/cmp / add imm8 /
 *       inc/dec / nop。JIT 一次调用执行整块；随后用 sim_run(N) 让解释器
 *       执行同样 N 条，比较 16 个通用寄存器、RFLAGS 和 RIP。
 *
 * 运行：JIT=1 ./build.sh wasm && node tests/jit_block.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.dirname(__dirname);
const WASM = path.join(ROOT, "web", "sim.wasm");

async function main() {
  const bytes = fs.readFileSync(WASM);
  const mod = new WebAssembly.Module(bytes);

  const handles = [];
  let inst = null;
  const env = {
    js_jit_compile(ptr, len) {
      try {
        const mem = new Uint8Array(inst.exports.memory.buffer, ptr, len).slice();
        const m = new WebAssembly.Module(mem);
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
        handles.push(i);
        return handles.length - 1;
      } catch (e) {
        console.error("[jit_block] compile failed:", e && e.message);
        return -1;
      }
    },
    js_jit_run(h, state, ram) {
      if (h < 0 || h >= handles.length) return -2;
      return handles[h].exports.run(state, ram) | 0;
    },
  };

  inst = await WebAssembly.instantiate(mod, { env });
  const w = inst.exports;

  if (w.sim_reset() !== 0) {
    console.error("[jit_block] sim_reset failed");
    process.exit(1);
  }

  const P = 0x1000;
  const ram = w.sim_ram_base();
  const mem = new Uint8Array(w.memory.buffer);
  if (!Number.isInteger(ram) || ram <= 0) {
    console.error("[jit_block] bad sim_ram_base:", ram);
    process.exit(1);
  }

  /* mov eax,0x12345678
   * mov ecx,0xdeadbeef
   * add eax,ecx ; sub eax,ecx ; xor ecx,ecx ; or eax,ecx
   * and eax,edx ; cmp eax,edx
   * add eax,5   ; inc eax ; dec ecx ; nop */
  const code = [
    0xb8, 0x78, 0x56, 0x34, 0x12,
    0xb9, 0xef, 0xbe, 0xad, 0xde,
    0x01, 0xc8,
    0x29, 0xc8,
    0x31, 0xc9,
    0x09, 0xc8,
    0x21, 0xd0,
    0x39, 0xd0,
    0x83, 0xc0, 0x05,
    0xff, 0xc0,
    0xff, 0xc9,
    0x90,
  ];
  const N = 12;
  code.forEach((b, i) => (mem[ram + P + i] = b));

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

  reset(P);
  const n = w.sim_jit_block(BigInt(P));
  const j = snap();

  reset(P);
  w.sim_run(N);
  const i = snap();

  let bad = 0;
  if (n !== N) {
    console.error(`[jit_block] block length ${n} != ${N}`);
    bad++;
  }
  for (let k = 0; k < 16; k++) {
    if (j.r[k] !== i.r[k]) {
      console.error(
        `[jit_block] r${k} jit=0x${j.r[k].toString(16)} interp=0x${i.r[k].toString(16)}`
      );
      bad++;
    }
  }
  if (j.f !== i.f) {
    console.error(`[jit_block] flags jit=0x${j.f.toString(16)} interp=0x${i.f.toString(16)}`);
    bad++;
  }
  if (j.rip !== i.rip) {
    console.error(`[jit_block] rip jit=0x${j.rip.toString(16)} interp=0x${i.rip.toString(16)}`);
    bad++;
  }

  if (bad !== 0) {
    console.error(`[jit_block] ${bad} mismatch(es)`);
    process.exit(1);
  }
  console.log(
    `[jit_block] PASS n=${n} rax=0x${j.r[0].toString(16)} rcx=0x${j.r[1].toString(16)} ` +
    `flags=0x${j.f.toString(16)} rip=0x${j.rip.toString(16)}`
  );
}

main().catch((e) => {
  console.error("[jit_block] error:", e);
  process.exit(1);
});
