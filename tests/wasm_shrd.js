// SHRD/SHLD 在 wasm 里的快速单测（秒级）。
// 用法：node tests/wasm_shrd.js
// 覆盖 64 位、计数 32（boot 里 229031550 处那条）和计数 1。
const fs = require('fs');
const wasmPath = process.env.WASM || 'web/sim.wasm';
const STAGE = 0x0d800000;
const cases = [
  { name: 'shrd rdx,rdi,32', code: [0x48,0xba,0xac,0x79,0xf4,0x01,0,0,0,0,
                                    0x48,0xbf,0xa8,0x3c,0x0b,0,0,0xc9,0xff,0xff,
                                    0x48,0x0f,0xac,0xfa,0x20, 0xf4],
    expect: 0x000b3ca800000000n },
  { name: 'shrd rdx,rdi,1',  code: [0x48,0xc7,0xc2,0x02,0,0,0,
                                    0x48,0xc7,0xc7,0x01,0,0,0,
                                    0x48,0x0f,0xac,0xfa,0x01, 0xf4],
    expect: 0x8000000000000001n },
  { name: 'shld rdx,rdi,32', code: [0x48,0xba,0xac,0x79,0xf4,0x01,0,0,0,0,
                                    0x48,0xbf,0xa8,0x3c,0x0b,0,0,0xc9,0xff,0xff,
                                    0x48,0x0f,0xa4,0xfa,0x20, 0xf4],
    expect: 0x1cf479ac000b3ca8n },
];
(async () => {
  const mod = await WebAssembly.compile(fs.readFileSync(wasmPath));
  const w = (await WebAssembly.instantiate(mod, {})).exports;
  let bad = 0;
  for (const c of cases) {
    new Uint8Array(w.memory.buffer).set(Uint8Array.from(c.code), STAGE);
    w.sim_load_payload(STAGE, c.code.length);
    for (let i = 0; i < 5; i++) { if (w.sim_run(1) === 0) break; }
    const got = BigInt.asUintN(64, w.sim_cpu_reg(2));
    const ok = got === BigInt.asUintN(64, c.expect);
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name}: got=0x${got.toString(16)} expect=0x${BigInt.asUintN(64, c.expect).toString(16)}`);
  }
  console.log(bad ? `${bad} case(s) FAILED` : 'wasm shrd/shld OK');
  process.exit(bad ? 1 : 0);
})();
