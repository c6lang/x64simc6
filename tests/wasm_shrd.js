// SHRD/SHLD 在 wasm 里的快速单测（秒级）。
// 用法：node tests/wasm_shrd.js
// 覆盖 64 位、计数 0/1/31/32/33/63，包含 boot 里第 229031550 条那条
// 0xffffffff813f850a: shrd rdx,rdi,0x20 的形状。
const fs = require('fs');
const wasmPath = process.env.WASM || 'web/sim.wasm';
const STAGE = 0x0d800000;
const U = (v) => BigInt.asUintN(64, v);

function movabs(reg, imm) {
  const out = [0x48, 0xb8 + reg];
  let v = U(imm);
  for (let i = 0; i < 8; i++) { out.push(Number(v & 0xffn)); v >>= 8n; }
  return out;
}

const A = 0x1122334455667788n, B = 0x99aabbccddeeff00n;
const cases = [];
for (const cnt of [0n, 1n, 31n, 32n, 33n, 63n]) {
  cases.push({
    name: `shrd rdx,rdi,${cnt}`,
    code: [...movabs(2, A), ...movabs(7, B), 0x48, 0x0f, 0xac, 0xfa, Number(cnt), 0xf4],
    expect: cnt === 0n ? U(A) : U((A >> cnt) | (B << (64n - cnt))),
  });
  cases.push({
    name: `shld rdx,rdi,${cnt}`,
    code: [...movabs(2, A), ...movabs(7, B), 0x48, 0x0f, 0xa4, 0xfa, Number(cnt), 0xf4],
    expect: cnt === 0n ? U(A) : U((A << cnt) | (B >> (64n - cnt))),
  });
}
// boot 里真实出现的那条
cases.push({
  name: 'shrd rdx,rdi,32 (kernel 0xffffffff813f850a)',
  code: [...movabs(2, 0x1cf479acn), ...movabs(7, 0xffffc900000b3ca8n), 0x48, 0x0f, 0xac, 0xfa, 0x20, 0xf4],
  expect: U((0x1cf479acn >> 32n) | (0xffffc900000b3ca8n << 32n)),
});

(async () => {
  const mod = await WebAssembly.compile(fs.readFileSync(wasmPath));
  const w = (await WebAssembly.instantiate(mod, {})).exports;
  let bad = 0;
  for (const c of cases) {
    new Uint8Array(w.memory.buffer).set(Uint8Array.from(c.code), STAGE);
    w.sim_load_payload(STAGE, c.code.length);
    for (let i = 0; i < 5; i++) { if (w.sim_run(1) === 0) break; }
    const got = U(w.sim_cpu_reg(2));
    const ok = got === c.expect;
    if (!ok) bad++;
    if (!ok) console.log(`FAIL ${c.name}: got=0x${got.toString(16)} expect=0x${c.expect.toString(16)}`);
  }
  console.log(bad ? `${bad}/${cases.length} FAILED` : `wasm shrd/shld OK (${cases.length} cases)`);
  process.exit(bad ? 1 : 0);
})();
