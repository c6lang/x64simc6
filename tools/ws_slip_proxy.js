#!/usr/bin/env node
/* tools/ws_slip_proxy.js —— 给 wasm 版当“网线”：WebSocket <-> SLIP/NAT 代理。
 *
 * wasm 里没有宿主 socket，guest 通过第二串口 ttyS1 跑 SLIP；页面把 COM2 的
 * 字节流通过 WebSocket 发到这里。本脚本每个连接起一个
 *
 *     build/sim --netshim
 *
 * 子进程（复用 src/net.c6 里和 native 一样的用户态 NAT），把二进制帧
 * 原样双向搬运。所以浏览器里的 guest 能真的 DNS/TCP/HTTP/HTTPS/ICMP 上网，
 * 地址仍是 10.0.2.15 / 网关 10.0.2.2 / DNS 10.0.2.3。
 *
 * 用法：
 *   node tools/ws_slip_proxy.js [--host 127.0.0.1] [--port 8787] [--sim build/sim]
 *
 * 然后页面「网络代理」填 ws://127.0.0.1:8787 点连接，再点「启动」。
 * 注意：GitHub Pages 是 HTTPS，浏览器对 ws://127.0.0.1 的混合内容策略
 * 各版本不同；本地 http://localhost 页面最稳。
 */
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

function opt(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const HOST = opt('--host', '127.0.0.1');
const PORT = Number(opt('--port', '8787'));
const SIM = opt('--sim', 'build/sim');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/* ---------------- 最小 WebSocket 帧层 ---------------- */
class Ws {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.onmessage = null;
    this.onclose = null;
    this.closed = false;
    socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    socket.on('close', () => this.close());
    socket.on('error', () => this.close());
  }

  send(data) {
    if (this.closed || this.socket.destroyed) return;
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let head;
    if (b.length < 126) head = Buffer.from([0x82, b.length]);
    else if (b.length < 65536) {
      head = Buffer.alloc(4); head[0] = 0x82; head[1] = 126; head.writeUInt16BE(b.length, 2);
    } else {
      head = Buffer.alloc(10); head[0] = 0x82; head[1] = 127;
      head.writeUInt32BE(0, 2); head.writeUInt32BE(b.length, 6);
    }
    this.socket.write(Buffer.concat([head, b]));
  }

  pong(payload) {
    if (this.closed || this.socket.destroyed) return;
    const b = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    this.socket.write(Buffer.concat([Buffer.from([0x8a, b.length]), b]));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.destroy(); } catch (e) {}
    if (this.onclose) this.onclose();
  }

  parse() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2)); off = 10;
      }
      let mask = null;
      if (masked) {
        if (this.buf.length < off + 4) return;
        mask = this.buf.subarray(off, off + 4); off += 4;
      }
      if (this.buf.length < off + len) return;
      let payload = Buffer.from(this.buf.subarray(off, off + len));
      this.buf = this.buf.subarray(off + len);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

      if (op === 0x8) {                 // close
        this.close();
        return;
      } else if (op === 0x9) {          // ping
        this.pong(payload);
      } else if (op === 0xa) {          // pong
        // ignore
      } else if (op === 0x1 || op === 0x2) {
        if (fin) { if (this.onmessage) this.onmessage(payload); }
        else { this.frag = [payload]; }
      } else if (op === 0x0) {
        this.frag.push(payload);
        if (fin) {
          const all = Buffer.concat(this.frag);
          this.frag = [];
          if (this.onmessage) this.onmessage(all);
        }
      }
    }
  }
}

/* ---------------- HTTP -> WebSocket ---------------- */
/* 页面可以把上游代理/DNS 放在 WS URL 的 query 上，例如
 *   ws://127.0.0.1:8787/?proxy=http%3A%2F%2F127.0.0.1%3A2334&dns=127.0.0.1%3A6450
 * 这里只做最小字符校验：这个网关没有认证，不能把任意字符串拼进子进程参数。 */
function safeProxy(v) {
  return /^[A-Za-z0-9._~:@\[\]/%+-]+$/.test(v);
}
function safeDns(v) {
  return /^[0-9A-Za-z.:\[\]]+$/.test(v);
}

const server = http.createServer((req, res) => {
  res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('WebSocket only: 用 ws:// 连接（页面里的“网络代理”输入框）\n');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  let px = '', dn = '';
  try {
    const u = new URL(req.url, 'ws://localhost');
    px = (u.searchParams.get('proxy') || '').trim();
    dn = (u.searchParams.get('dns') || '').trim();
  } catch (e) { /* 保守起见按空处理 */ }
  if (px && !safeProxy(px)) {
    console.error('[ws_slip_proxy] 拒绝非法的 proxy 参数: ' + px);
    socket.destroy();
    return;
  }
  if (dn && !safeDns(dn)) {
    console.error('[ws_slip_proxy] 拒绝非法的 dns 参数: ' + dn);
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
               'Upgrade: websocket\r\n' +
               'Connection: Upgrade\r\n' +
               'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');

  const ws = new Ws(socket);
  // NETSHIM_ARGS 可给 --netshim 传调试参数（例如 --nettrace）
  const extra = (process.env.NETSHIM_ARGS || '').split(/\s+/).filter(Boolean);
  if (px) extra.push('--proxy=' + px);
  if (dn) extra.push('--dns=' + dn);
  const shim = spawn(SIM, ['--netshim'].concat(extra), { stdio: ['pipe', 'pipe', 'inherit'] });
  console.error('[ws_slip_proxy] 客户端接入，启动 ' + SIM + ' --netshim' +
                (px ? ' --proxy=' + px : '') + (dn ? ' --dns=' + dn : ''));

  ws.onmessage = (buf) => {
    if (!shim.stdin.destroyed) shim.stdin.write(buf);
  };
  ws.onclose = () => {
    console.error('[ws_slip_proxy] 客户端断开');
    try { shim.kill(); } catch (e) {}
  };
  shim.stdout.on('data', (b) => ws.send(b));
  shim.on('exit', (code) => {
    console.error('[ws_slip_proxy] netshim 退出 code=' + code);
    ws.close();
  });
  shim.stdin.on('error', () => {});
});

server.listen(PORT, HOST, () => {
  console.error('[ws_slip_proxy] listening on ws://' + HOST + ':' + PORT +
                '（每个连接一个 ' + SIM + ' --netshim）');
});
