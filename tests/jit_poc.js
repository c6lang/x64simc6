#!/usr/bin/env node
/* tests/jit_poc.js —— wasm JIT POC 对拍
 *
 * 验证链路：C6 导出 sim_jit_poc -> C 编码器生成 wasm 模块字节
 *           -> JS new WebAssembly.Module/Instance（import 主模块 memory）
 *           -> 执行 mov eax,imm32 -> 与解释器 sim_run(1) 的 RAX/RIP 对拍。
 *
 * 运行：JIT=1 ./build.sh wasm && node tests/jit_poc.js
 */
const fs = require("fs");
const path = require("path");
const { makeJitEnv } = require("./jit_hooks");

const ROOT = path.dirname(__dirname);
const WASM = path.join(ROOT, "web", "sim.wasm");

async function main() {
  const bytes = fs.readFileSync(WASM);
  const mod = new WebAssembly.Module(bytes);

  let inst = null;
  const jit = makeJitEnv(() => inst);
  inst = await WebAssembly.instantiate(mod, { env: jit.env });
  const w = inst.exports;

  const rc = w.sim_reset();
  if (rc !== 0) {
    console.error("[jit_poc] sim_reset rc=", rc);
    process.exit(1);
  }

  const P = 0x1000;
  const ram = w.sim_ram_base();
  const mem = new Uint8Array(w.memory.buffer);
  if (!Number.isInteger(ram) || ram <= 0) {
    console.error("[jit_poc] bad sim_ram_base:", ram);
    process.exit(1);
  }

  const cases = [0, 1, 0x12345678, 0x7fffffff, 0xdeadbeef, 0xffffffff];
  let bad = 0;

  for (const imm of cases) {
    mem[ram + P] = 0xb8;
    mem[ram + P + 1] = imm & 0xff;
    mem[ram + P + 2] = (imm >>> 8) & 0xff;
    mem[ram + P + 3] = (imm >>> 16) & 0xff;
    mem[ram + P + 4] = (imm >>> 24) & 0xff;

    // JIT 路径
    w.sim_set_reg(0, 0n);
    w.sim_set_rip(BigInt(P));
    const jrc = w.sim_jit_poc(BigInt(P));
    const jrax = w.sim_get_reg(0);
    const jrip = w.sim_get_rip();

    // 解释器路径（同样的起始状态）
    w.sim_set_reg(0, 0n);
    w.sim_set_rip(BigInt(P));
    w.sim_run(1);
    const iraax = w.sim_get_reg(0);
    const irip = w.sim_get_rip();

    const want = BigInt(imm >>> 0);
    const wantRip = BigInt(P + 5);
    const ok =
      jrc === 0 && jrax === want && jrip === wantRip &&
      iraax === want && irip === wantRip;
    if (!ok) bad++;
    console.log(
      `${ok ? "PASS" : "FAIL"} imm=0x${(imm >>> 0).toString(16).padStart(8, "0")} ` +
      `jit(rc=${jrc} rax=0x${jrax.toString(16)} rip=0x${jrip.toString(16)}) ` +
      `interp(rax=0x${iraax.toString(16)} rip=0x${irip.toString(16)})`
    );
  }

  if (bad !== 0) {
    console.error(`[jit_poc] ${bad} case(s) failed`);
    process.exit(1);
  }
  console.log("[jit_poc] PASS");
}

main().catch((e) => {
  console.error("[jit_poc] error:", e);
  process.exit(1);
});
