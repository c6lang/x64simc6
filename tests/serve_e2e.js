#!/usr/bin/env node
/* tests/serve_e2e.js —— build/sim --serve：单进程 HTTP + WebSocket + SLIP/NAT。
 *
 * 验证不依赖 Node 代理、也不依赖浏览器：
 *   1) HTTP 静态站：/__c6sim、/index.html、/sim.wasm、404
 *   2) WebSocket 握手（Node 的全局 WebSocket，客户端自动带 mask）
 *   3) 把合成的 SLIP ICMP echo 发给网关，收回 10.0.2.2 的 echo reply；
 *      顺便把一帧拆成两条 WS 消息发，验证跨消息的 SLIP 拼帧
 *
 * 用法：node tests/serve_e2e.js（先 ./build.sh native）
 */
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

function httpGet(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode,
                                    headers: res.headers,
                                    body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

/* ---- 合成 IP/ICMP/SLIP ---- */
function ck16(b) {
  let s = 0;
  for (let i = 0; i + 1 < b.length; i += 2) s += b.readUInt16BE(i);
  if (b.length & 1) s += b[b.length - 1] << 8;
  while (s >> 16) s = (s & 0xffff) + (s >> 16);
  return (~s) & 0xffff;
}
function ip4(s) { return Buffer.from(s.split('.').map(Number)); }
function ipPacket(proto, src, dst, payload) {
  const h = Buffer.alloc(20);
  h[0] = 0x45;
  h.writeUInt16BE(20 + payload.length, 2);
  h.writeUInt16BE(0x1234, 4);
  h.writeUInt16BE(0x4000, 6);
  h[8] = 64;
  h[9] = proto;
  ip4(src).copy(h, 12);
  ip4(dst).copy(h, 16);
  h.writeUInt16BE(ck16(h), 10);
  return Buffer.concat([h, payload]);
}
function icmpEcho() {
  const b = Buffer.alloc(24);
  b[0] = 8;                       /* echo request */
  b[1] = 0;
  b.writeUInt16BE(0x1234, 4);     /* id */
  b.writeUInt16BE(1, 6);          /* seq */
  for (let i = 8; i < 24; i++) b[i] = i;
  b.writeUInt16BE(ck16(b), 2);
  return b;
}
function slip(pkt) {
  const out = [0xc0];
  for (const b of pkt) {
    if (b === 0xc0) out.push(0xdb, 0xdc);
    else if (b === 0xdb) out.push(0xdb, 0xdd);
    else out.push(b);
  }
  out.push(0xc0);
  return Buffer.from(out);
}
function unslip(raw) {
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 0xdb && i + 1 < raw.length) {
      i++;
      out.push(raw[i] === 0xdc ? 0xc0 : raw[i] === 0xdd ? 0xdb : raw[i]);
    } else {
      out.push(raw[i]);
    }
  }
  return Buffer.from(out);
}

/* 把任意切分的 WS 消息流攒回 SLIP 帧 */
class Feed {
  constructor() { this.buf = Buffer.alloc(0); this.pkts = []; }
  push(b) {
    this.buf = Buffer.concat([this.buf, b]);
    for (;;) {
      const a = this.buf.indexOf(0xc0);
      if (a < 0) break;
      const c = this.buf.indexOf(0xc0, a + 1);
      if (c < 0) break;
      this.pkts.push(unslip(this.buf.subarray(a + 1, c)));
      this.buf = this.buf.subarray(c);
    }
  }
  find(fn) { return this.pkts.find(fn); }
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? '  [' + detail + ']' : '')); }
}

(async () => {
  const port = await freePort();
  const sim = spawn('build/sim', ['--serve', '--port=' + port, '--web=web'],
                    { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  sim.stderr.on('data', (d) => { log += d.toString(); });
  let ws = null;
  try {
    for (let i = 0; i < 100; i++) {
      if (log.includes('--serve:')) break;
      await sleep(50);
    }
    if (!log.includes('--serve:')) throw new Error('网关没有起来: ' + log);

    const gate = await httpGet(port, '/__c6sim');
    let cfg = null;
    try { cfg = JSON.parse(gate.body.toString()); } catch (e) {}
    check('/__c6sim 返回 gateway:1', gate.status === 200 && cfg && cfg.gateway === 1,
          'status=' + gate.status + ' body=' + gate.body.toString().slice(0, 80));

    const idx = await httpGet(port, '/index.html');
    check('/index.html 是页面', idx.status === 200 && idx.body.includes('fwfile'),
          'status=' + idx.status + ' len=' + idx.body.length);

    const wasm = await httpGet(port, '/sim.wasm');
    const wasmSize = fs.statSync(path.join('web', 'sim.wasm')).size;
    check('/sim.wasm 完整', wasm.status === 200 && wasm.body.length === wasmSize,
          'status=' + wasm.status + ' len=' + wasm.body.length + '/' + wasmSize);

    const missing = await httpGet(port, '/no-such-file');
    check('404 正常', missing.status === 404, 'status=' + missing.status);

    /* WS：合成 SLIP ping */
    ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    ws.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WS 握手超时')), 5000);
      ws.onopen = () => { clearTimeout(t); resolve(); };
      ws.onerror = () => { clearTimeout(t); reject(new Error('WS 握手失败')); };
    });
    check('WebSocket 101 握手', true);

    const feed = new Feed();
    ws.onmessage = (ev) => feed.push(Buffer.from(ev.data));

    const frame = slip(ipPacket(1, '10.0.2.15', '10.0.2.2', icmpEcho()));
    /* 拆成两条 WS 消息，验证 SLIP 拼帧（真实页面也会按 4ms 分片发） */
    ws.send(new Uint8Array(frame.subarray(0, 7)));
    await sleep(30);
    ws.send(new Uint8Array(frame.subarray(7)));

    let reply = null;
    for (let i = 0; i < 100; i++) {
      reply = feed.find((p) => p.length > 20 && p[9] === 1 && p[20] === 0);
      if (reply) break;
      await sleep(50);
    }
    check('WS → SLIP → NAT 收到 ICMP echo reply', !!reply);
    if (reply) {
      check('reply 源地址 10.0.2.2', [...reply.subarray(12, 16)].join('.') === '10.0.2.2',
            [...reply.subarray(12, 16)].join('.'));
      check('reply 目的地址 10.0.2.15', [...reply.subarray(16, 20)].join('.') === '10.0.2.15',
            [...reply.subarray(16, 20)].join('.'));
      check('reply id/seq 与请求一致', reply[24] === 0x12 && reply[25] === 0x34);
    }

    /* 整帧一次发，确认不是只在拆包时能工作 */
    const before = feed.pkts.length;
    ws.send(new Uint8Array(slip(ipPacket(1, '10.0.2.15', '10.0.2.2', icmpEcho()))));
    let reply2 = null;
    for (let i = 0; i < 100; i++) {
      reply2 = feed.pkts.slice(before).find((p) => p.length > 20 && p[9] === 1 && p[20] === 0);
      if (reply2) break;
      await sleep(50);
    }
    check('整帧重发也收到 reply', !!reply2);

    console.log(`serve_e2e: ${pass} passed, ${fail} failed`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error('serve_e2e FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    if (ws) { try { ws.close(); } catch (e) {} }
    sim.kill();
  }
})();
