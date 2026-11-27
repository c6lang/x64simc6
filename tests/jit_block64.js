#!/usr/bin/env node
/* tests/jit_block64.js —— 64 位 ALU 与 jcc 直线块的逐位对拍
 *
 * 覆盖 REX.W 的 mov imm64 / mov r,r / add/sub/xor/test/cmp / add imm8 /
 * inc/dec，以及 jcc rel8 的 taken / not-taken 两条路径。
 *
 * 运行：JIT=1 ./build.sh wasm && node tests/jit_block64.js
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
        console.error("[jit_block64] compile failed:", e && e.message);
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
    console.error("[jit_block64] sim_reset failed");
    process.exit(1);
  }

  const P = 0x2000;
  const ram = w.sim_ram_base();
  const mem = new Uint8Array(w.memory.buffer);

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

  let bad = 0;
  function run_case(name, code, n) {
    code.forEach((b, i) => (mem[ram + P + i] = b));

    reset(P);
    const jn = w.sim_jit_block(BigInt(P));
    const j = snap();

    reset(P);
    w.sim_run(n);
    const i = snap();

    if (jn !== n) {
      console.error(`[jit_block64] ${name}: block length ${jn} != ${n}`);
      bad++;
    }
    for (let k = 0; k < 16; k++) {
      if (j.r[k] !== i.r[k]) {
        console.error(
          `[jit_block64] ${name}: r${k} jit=0x${j.r[k].toString(16)} ` +
          `interp=0x${i.r[k].toString(16)}`
        );
        bad++;
      }
    }
    if (j.f !== i.f) {
      console.error(
        `[jit_block64] ${name}: flags jit=0x${j.f.toString(16)} ` +
        `interp=0x${i.f.toString(16)}`
      );
      bad++;
    }
    if (j.rip !== i.rip) {
      console.error(
        `[jit_block64] ${name}: rip jit=0x${j.rip.toString(16)} ` +
        `interp=0x${i.rip.toString(16)}`
      );
      bad++;
    }
    console.log(
      `${bad === 0 ? "PASS" : "FAIL"} ${name} n=${jn} ` +
      `rax=0x${j.r[0].toString(16)} rcx=0x${j.r[1].toString(16)} ` +
      `flags=0x${j.f.toString(16)} rip=0x${j.rip.toString(16)}`
    );
  }

  /* 64 位 ALU：12 条，无分支 */
  run_case("alu64", [
    0x48, 0xb8, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11,
    0x48, 0xb9, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
    0x48, 0x01, 0xc8,
    0x48, 0x29, 0xc8,
    0x48, 0x31, 0xc9,
    0x48, 0x83, 0xc0, 0x05,
    0x48, 0xff, 0xc0,
    0x48, 0xff, 0xc9,
    0x48, 0x85, 0xc0,
    0x48, 0x39, 0xc8,
    0x48, 0x83, 0xf8, 0x05,
    0x90,
  ], 12);

  /* jcc taken：mov/cmp/je，块长 3；目标落在 mov eax,3 */
  run_case("jcc_taken", [
    0xb8, 0x01, 0x00, 0x00, 0x00,
    0x83, 0xf8, 0x01,
    0x74, 0x05,
    0xb8, 0x02, 0x00, 0x00, 0x00,
    0xb8, 0x03, 0x00, 0x00, 0x00,
    0x90,
  ], 3);

  /* jcc not-taken：cmp eax,2 -> ZF=0，RIP 落到 mov eax,2 */
  run_case("jcc_not_taken", [
    0xb8, 0x01, 0x00, 0x00, 0x00,
    0x83, 0xf8, 0x02,
    0x74, 0x05,
    0xb8, 0x02, 0x00, 0x00, 0x00,
    0xb8, 0x03, 0x00, 0x00, 0x00,
    0x90,
  ], 3);

  if (bad !== 0) {
    console.error(`[jit_block64] ${bad} mismatch(es)`);
    process.exit(1);
  }
  console.log("[jit_block64] PASS");
}

main().catch((e) => {
  console.error("[jit_block64] error:", e);
  process.exit(1);
});
