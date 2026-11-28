/* tests/wasm_login.js —— wasm 里把 Alpine 跑到 login 并自动登录。
 *
 * 与 tests/browser_alpine.js 同一套 wasm 导出，但不依赖浏览器，用于快速
 * 验证「wasm 侧真的能登进 guest 执行命令」。
 *
 *   MAX_INSNS=3000000000 SERIAL_OUT=/tmp/wasm_login.txt node tests/wasm_login.js
 *
 * 判定：串口里出现 MARK-OK（root 登录 + uname -m 的输出）。
 */
const fs = require('fs');
const path = require('path');
const { makeJitEnv } = require('./jit_hooks');
const ROOT = path.dirname(__dirname);
const MAX = Number(process.env.MAX_INSNS || 3000000000);
const CHUNK = Number(process.env.CHUNK || 2000000);
const SCRATCH = 0x0f800000;
const STAGE = 0x0d800000;
const INBUF = 0x0f900000;
const CAP = 1 << 16;

(async () => {
  const fw = fs.readFileSync(path.join(ROOT, 'build', 'firmware.bin'));
  const mod = new WebAssembly.Module(fs.readFileSync(path.join(ROOT, 'web', 'sim.wasm')));
  const hasJit = WebAssembly.Module.imports(mod).some(
    (i) => i.module === 'env' && i.name === 'js_jit_compile');
  let instance = null;
  const jit = makeJitEnv(() => instance);
  instance = await WebAssembly.instantiate(mod, hasJit ? { env: jit.env } : {});
  const w = instance.exports;
  if (hasJit && process.env.JIT_OFF === '1' && w.sim_set_jit) w.sim_set_jit(0);
  if (hasJit && process.env.JIT_MIN_N && w.sim_set_jit_min_n) w.sim_set_jit_min_n(Number(process.env.JIT_MIN_N));
  const mem = new Uint8Array(w.memory.buffer);
  if (STAGE + fw.length > mem.length) throw new Error('stage overflow');
  mem.set(fw, STAGE);
  const rc = w.sim_init(STAGE, fw.length);
  if (rc !== 0) throw new Error('sim_init rc=' + rc);
  if (w.sim_set_paced) w.sim_set_paced(0);   /* 对拍/序列：固定 1/17，不按墙钟校准 */

  const dec = new TextDecoder();
  const send = (s) => {
    const b = Buffer.from(s, 'utf8');
    mem.set(b, INBUF);
    w.sim_serial_in(INBUF, b.length);
  };
  let text = '';
  let sentRoot = false;
  let sentCmd = false;
  const t0 = Date.now();
  let lastBeat = t0;
  let loops = 0;
  while (Number(w.sim_insns()) < MAX) {
    const ret = w.sim_run(CHUNK);
    loops++;
    const n = w.sim_serial_out(SCRATCH, CAP);
    if (n > 0) text += dec.decode(new Uint8Array(w.memory.buffer, SCRATCH, n));
    if (!sentRoot && text.indexOf('login:') >= 0) {
      sentRoot = true;
      send('root\n');
      console.log(`[wasm_login] ${((Date.now() - t0) / 1000).toFixed(0)}s ` +
                  `insns=${Number(w.sim_insns())} 看到 login: → 发送 root`);
    }
    if (!sentCmd && (text.indexOf(':~#') >= 0 || text.indexOf('Welcome to Alpine') >= 0)) {
      sentCmd = true;
      send('uname -m; echo MARK-OK\n');
      console.log(`[wasm_login] ${((Date.now() - t0) / 1000).toFixed(0)}s 看到 shell → 发送 uname`);
    }
    if (text.indexOf('MARK-OK') >= 0) break;
    if (Number(w.sim_halt_info()) !== 0) break;
    const now = Date.now();
    if (now - lastBeat > 60000) {
      lastBeat = now;
      console.log(`[wasm_login] ${((now - t0) / 1000).toFixed(0)}s ` +
                  `insns=${(Number(w.sim_insns()) / 1e6).toFixed(0)}M ` +
                  `text=${text.length}B rate=${(Number(w.sim_insns()) / ((now - t0) / 1000) / 1e6).toFixed(2)}M/s`);
    }
    if (ret === 0 && n === 0 && Number(w.sim_insns()) === 0) break;
  }
  const insns = Number(w.sim_insns());
  const ok = text.indexOf('MARK-OK') >= 0;
  if (process.env.SERIAL_OUT) fs.writeFileSync(process.env.SERIAL_OUT, text);
  if (hasJit) {
    console.log(`[wasm_login] jit runs=${w.sim_jit_stat(0)} hits=${w.sim_jit_stat(1)} ` +
                `compiles=${w.sim_jit_stat(3)} insns=${w.sim_jit_stat(6)}`);
  }
  console.log(`[wasm_login] insns=${insns} text=${text.length}B ` +
              `loops=${loops} 用时=${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log(ok ? 'WASM LOGIN OK (MARK-OK)' : 'WASM LOGIN 未达成');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.log('failed:', e.message); process.exit(1); });
