#!/usr/bin/env node
/* tests/wasm_net_proxy.js —— wasm guest 通过 WebSocket SLIP 代理真上网。
 *
 * 链路：
 *   wasm guest 的 ttyS1(SLIP) <-> sim_net_rx/tx <-> WebSocket
 *     <-> tools/ws_slip_proxy.js <-> build/sim --netshim <-> 宿主 socket
 *
 * 验证登录后：
 *   ping -c1 10.0.2.2          （本地网关，走 COM2 + shim 回包）
 *   wget http://example.com/   （DNS + TCP + HTTP，真的出外网）
 *
 * HTTPS 也走同一条 TCP 中继，但 2026-11-27 实测 wasm guest 的 TLS
 * ClientHello 到达代理后，example.com 的 CDN 边缘会直接关闭连接
 * （native 的 HTTPS 正常）；这里不把 HTTPS 作为断言，见 DESIGN §98。
 *
 * 用法：node tests/wasm_net_proxy.js
 */
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');

const SCRATCH = 0x0f800000, CAP = 65536;
const NET_RX = SCRATCH + 4 * 0x100000, NET_TX = NET_RX + CAP;
const STAGE = 0x10000000;
const dec = new TextDecoder();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tick = () => new Promise(r => setImmediate(r));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

(async () => {
  const PORT = await freePort();
  const proxy = spawn('node', ['tools/ws_slip_proxy.js', '--port', String(PORT)],
                      { stdio: ['ignore', 'ignore', 'pipe'] });
  let proxyErr = '';
  proxy.stderr.on('data', d => { proxyErr += d.toString(); });
  for (let i = 0; i < 100 && !proxyErr.includes('listening'); i++) await sleep(100);
  if (!proxyErr.includes('listening')) throw new Error('代理没起来: ' + proxyErr);

  const w = (await WebAssembly.instantiate(
    await WebAssembly.compile(fs.readFileSync('web/sim.wasm')), {})).exports;
  if (w.__wasm_call_ctors) w.__wasm_call_ctors();
  if (w.sim_set_rtc) w.sim_set_rtc(Math.floor(Date.now() / 1000));
  const fw = fs.readFileSync('build/firmware.bin');
  const need = STAGE + fw.length;
  if (need > w.memory.buffer.byteLength)
    w.memory.grow(Math.ceil((need - w.memory.buffer.byteLength) / 65536));
  new Uint8Array(w.memory.buffer, STAGE, fw.length).set(fw);

  const ws = new WebSocket('ws://127.0.0.1:' + PORT);
  ws.binaryType = 'arraybuffer';
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WebSocket 连接失败')); });
  let rx = 0, tx = 0;
  ws.onmessage = (ev) => {
    const b = new Uint8Array(ev.data);
    new Uint8Array(w.memory.buffer, NET_RX, b.length).set(b);
    w.sim_net_rx(NET_RX, b.length);
    rx += b.length;
  };
  const pump = setInterval(() => {
    const n = w.sim_net_tx(NET_TX, CAP);
    if (n > 0 && ws.readyState === 1) {
      ws.send(new Uint8Array(w.memory.buffer, NET_TX, n).slice());
      tx += n;
    }
  }, 2);

  let text = '';
  function drain() {
    const n = w.sim_serial_out(SCRATCH, CAP);
    if (n > 0) text += dec.decode(new Uint8Array(w.memory.buffer, SCRATCH, n));
  }
  function feed(s) {
    const b = Buffer.from(s, 'utf8');
    new Uint8Array(w.memory.buffer, SCRATCH + CAP, b.length).set(b);
    w.sim_serial_in(SCRATCH + CAP, b.length);
  }
  async function runFor(ms, stop) {
    const t = Date.now();
    while (Date.now() - t < ms) {
      w.sim_run(200000);
      drain();
      if (stop && stop()) return true;
      await tick();
    }
    return stop ? stop() : false;
  }

  try {
    w.sim_set_cmdline('console=ttyS0,115200 loglevel=4 panic=-1 acpi=off pci=conf1');
    if (w.sim_init(STAGE, fw.length) !== 0) throw new Error('sim_init 失败');
    if (!await runFor(300000, () => text.includes('login:'))) throw new Error('没到 login:');
    console.log('[wasm-net] 进入 login（insns=%d，代理 rx/tx=%d/%d）',
                Number(w.sim_stat_insns()), rx, tx);

    feed('root\n');
    if (!await runFor(60000, () => /\n[^\n]*# /.test(text))) throw new Error('没进 shell');
    console.log('[wasm-net] 登录成功');

    feed('ping -c1 10.0.2.2\n');
    if (!await runFor(15000, () => text.includes('1 packets received')))
      throw new Error('ping 10.0.2.2 失败');
    console.log('[wasm-net] ping 10.0.2.2 OK');

    feed('wget -T20 -O /dev/null http://example.com/\n');
    if (!await runFor(40000, () => text.includes("'/dev/null' saved")))
      throw new Error('wget http://example.com/ 失败');
    console.log('[wasm-net] wget http://example.com/ OK（代理 rx/tx=%d/%d）', rx, tx);
    console.log('WASM NET PROXY OK');
  } finally {
    clearInterval(pump);
    try { ws.close(); } catch (e) {}
    proxy.kill();
  }
})().catch(e => { console.error('WASM NET PROXY FAILED:', e.message); process.exit(1); });
