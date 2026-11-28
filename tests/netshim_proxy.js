#!/usr/bin/env node
/* tests/netshim_proxy.js —— 合成 SLIP guest 验证 NAT 的上游代理（--proxy / --dns）。
 *
 *  本脚本(合成 guest) <-> build/sim --netshim --proxy=... <-> tools/test_proxy.js
 *                                                        <-> 本地 echo 服务
 *
 * 覆盖：
 *   direct（无代理，回归）、http、socks5、socks4、
 *   不带 scheme 的自动识别（→ socks5 / → http）、
 *   HTTP Basic 认证、SOCKS5 用户名密码认证、认证失败（应发 RST、不过数据）、
 *   --dns=ip:port 覆盖（不被 resolv.conf 的 53 端口绑住）。
 *
 * 不上 Linux、不联网，几秒跑完。用法：node tests/netshim_proxy.js
 */
const net = require('net');
const { spawn } = require('child_process');

const GUEST_IP = '10.0.2.15';
const PEER_IP = '10.0.2.2';   /* NAT 映射到宿主 127.0.0.1 */
const DNS_IP = '10.0.2.3';
const PAYLOAD = 'GET / HTTP/1.0\r\nHost: test\r\n\r\n';
const HELLO = 'HELLO-NAT-PROXY\n';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(20);
  }
  return false;
}

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

/* ---------------- 合成 IP / TCP / UDP / SLIP ---------------- */

function ip4(s) {
  return Buffer.from(s.split('.').map(Number));
}

function ck16(b) {
  let s = 0;
  for (let i = 0; i + 1 < b.length; i += 2) s += b.readUInt16BE(i);
  if (b.length & 1) s += b[b.length - 1] << 8;
  while (s >> 16) s = (s & 0xffff) + (s >> 16);
  return (~s) & 0xffff;
}

function pseudo(src, dst, proto, len) {
  const p = Buffer.alloc(12);
  ip4(src).copy(p, 0);
  ip4(dst).copy(p, 4);
  p[9] = proto;
  p.writeUInt16BE(len, 10);
  return p;
}

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

function tcpPacket(src, dst, o) {
  const seg = Buffer.alloc(20);
  seg.writeUInt16BE(o.sport, 0);
  seg.writeUInt16BE(o.dport, 2);
  seg.writeUInt32BE(o.seq, 4);
  seg.writeUInt32BE(o.ack || 0, 8);
  seg[12] = 0x50;
  seg[13] = o.flags;
  seg.writeUInt16BE(0xffff, 14);
  const body = Buffer.concat([seg, o.payload || Buffer.alloc(0)]);
  body.writeUInt16BE(ck16(Buffer.concat([pseudo(src, dst, 6, body.length), body])), 16);
  return ipPacket(6, src, dst, body);
}

function udpPacket(src, dst, sport, dport, payload) {
  const u = Buffer.alloc(8);
  u.writeUInt16BE(sport, 0);
  u.writeUInt16BE(dport, 2);
  u.writeUInt16BE(8 + payload.length, 4);
  const body = Buffer.concat([u, payload]);
  body.writeUInt16BE(ck16(Buffer.concat([pseudo(src, dst, 17, body.length), body])), 6);
  return ipPacket(17, src, dst, body);
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

function parseIp(pkt) {
  if (pkt.length < 20) return null;
  const ihl = (pkt[0] & 0x0f) * 4;
  if (ihl < 20 || pkt.length < ihl) return null;
  const total = pkt.readUInt16BE(2);
  const end = Math.min(total, pkt.length);
  return {
    proto: pkt[9],
    src: Array.from(pkt.subarray(12, 16)).join('.'),
    dst: Array.from(pkt.subarray(16, 20)).join('.'),
    body: pkt.subarray(ihl, end),
  };
}

/* ---------------- shim 进程 + 帧解析 ---------------- */

function startShim(extra) {
  const sim = spawn('build/sim', ['--netshim'].concat(extra), {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const st = { sim, stderr: '', pkt: [], segs: [], udp: [], out: Buffer.alloc(0) };
  sim.stdout.on('data', (d) => {
    st.out = Buffer.concat([st.out, d]);
    for (;;) {
      const a = st.out.indexOf(0xc0);
      if (a < 0) {
        st.out = Buffer.alloc(0);
        return;
      }
      const b = st.out.indexOf(0xc0, a + 1);
      if (b < 0) {
        st.out = st.out.subarray(a);
        return;
      }
      st.pkt.push(unslip(st.out.subarray(a + 1, b)));
      st.out = st.out.subarray(b);
    }
  });
  sim.stderr.on('data', (d) => {
    st.stderr += d.toString();
  });
  sim.on('error', () => {});
  st.parsed = () => {
    for (const pkt of st.pkt) {
      const p = parseIp(pkt);
      if (!p) continue;
      if (p.proto === 6) {
        const b = p.body;
        if (b.length < 20) continue;
        const off = (b[12] >> 4) * 4;
        if (off < 20 || off > b.length) continue;
        st.segs.push({
          src: p.src,
          dst: p.dst,
          sport: b.readUInt16BE(0),
          dport: b.readUInt16BE(2),
          seq: b.readUInt32BE(4),
          ack: b.readUInt32BE(8),
          flags: b[13],
          payload: b.subarray(off),
        });
      } else if (p.proto === 17) {
        const b = p.body;
        if (b.length < 8) continue;
        st.udp.push({
          src: p.src,
          dst: p.dst,
          sport: b.readUInt16BE(0),
          dport: b.readUInt16BE(2),
          payload: b.subarray(8),
        });
      }
    }
    st.pkt.length = 0;
  };
  return st;
}

function tcpText(st) {
  st.parsed();
  return Buffer.concat(st.segs.map((s) => s.payload)).toString('latin1');
}

function rstSeen(st) {
  st.parsed();
  return st.segs.some((s) => (s.flags & 0x04) !== 0);
}

/* ---------------- 测试进程 ---------------- */

let fails = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log('PASS ' + name);
  } else {
    fails++;
    console.log('FAIL ' + name + (detail ? '  [' + detail + ']' : ''));
  }
}

async function startTestProxy(args) {
  const p = spawn('node', ['tools/test_proxy.js'].concat(args), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.logs = [];
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) p.logs.push(line);
    }
  });
  p.stderr.on('data', () => {});
  const up = await waitFor(() => p.logs.includes('READY'), 5000);
  if (!up) throw new Error('test_proxy 没起来');
  return p;
}

function startEcho() {
  return new Promise((resolve) => {
    const srv = net.createServer((c) => {
      c.on('error', () => {});
      c.end(HELLO);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

const GSEQ = 0x10000100;

/* 一次完整的 guest 会话：SYN → 数据（触发拨号/握手）→ 等回包 */
async function session(extra, sport, dport, opts) {
  const o = opts || {};
  const st = startShim(extra);
  const send = (pkt) => st.sim.stdin.write(slip(pkt));
  try {
    send(tcpPacket(GUEST_IP, PEER_IP, { sport, dport, seq: GSEQ, flags: 0x02 }));
    await sleep(40);
    send(tcpPacket(GUEST_IP, PEER_IP, {
      sport,
      dport,
      seq: GSEQ + 1,
      ack: 0,
      flags: 0x18,
      payload: Buffer.from(PAYLOAD),
    }));
    const ok = await waitFor(() => tcpText(st).includes(HELLO), o.timeout || 5000);
    return { st, ok, text: tcpText(st) };
  } finally {
    st.sim.kill();
  }
}

(async () => {
  const echo = await startEcho();
  const P = {
    http: await freePort(),
    socks: await freePort(),
    socks4: await freePort(),
    httpAuth: await freePort(),
    socksAuth: await freePort(),
  };
  const plain = await startTestProxy([
    '--http', String(P.http),
    '--socks', String(P.socks),
    '--socks4', String(P.socks4),
  ]);
  const auth = await startTestProxy([
    '--http', String(P.httpAuth), '--http-auth', 'user:pass',
    '--socks', String(P.socksAuth), '--socks-auth', 'user:pass',
  ]);
  const target = '127.0.0.1:' + echo.port;
  let sport = 40000;
  const logs = (p) => p.logs.join('\n');

  try {
    /* 0. 无代理：回归原来的直连中继 */
    {
      const r = await session([], sport++, echo.port);
      check('direct 中继', r.ok, 'payload=' + JSON.stringify(r.text));
    }
    /* 1. http */
    {
      const r = await session(['--proxy=http://127.0.0.1:' + P.http], sport++, echo.port);
      check('http 代理转发', r.ok, 'payload=' + JSON.stringify(r.text));
      check('http 代理收到 CONNECT ' + target, logs(plain).includes('HTTP ' + target));
    }
    /* 2. socks5 */
    {
      const r = await session(['--proxy=socks5://127.0.0.1:' + P.socks], sport++, echo.port);
      check('socks5 代理转发', r.ok);
      check('socks5 代理收到 CONNECT ' + target, logs(plain).includes('SOCKS5 ' + target));
    }
    /* 3. socks4 */
    {
      const r = await session(['--proxy=socks4://127.0.0.1:' + P.socks4], sport++, echo.port);
      check('socks4 代理转发', r.ok);
      check('socks4 代理收到 CONNECT ' + target, logs(plain).includes('SOCKS4 ' + target));
    }
    /* 4. 不带 scheme 的自动识别 */
    {
      const r = await session(['--proxy=127.0.0.1:' + P.socks], sport++, echo.port);
      check('auto → socks5 转发', r.ok);
      check('auto 识别成 socks5', r.st.stderr.includes('自动识别：socks5'),
            r.st.stderr.split('\n').filter((l) => l.includes('识别')).join(' / '));
    }
    {
      const r = await session(['--proxy=127.0.0.1:' + P.http], sport++, echo.port);
      check('auto → http 转发', r.ok);
      check('auto 识别成 http', r.st.stderr.includes('自动识别：http'));
    }
    /* 5. 认证 */
    {
      const r = await session(
        ['--proxy=http://user:pass@127.0.0.1:' + P.httpAuth], sport++, echo.port);
      check('http Basic 认证转发', r.ok);
      check('http 认证被代理接受', logs(auth).includes('HTTP ' + target + ' auth'));
    }
    {
      const r = await session(
        ['--proxy=socks5://user:pass@127.0.0.1:' + P.socksAuth], sport++, echo.port);
      check('socks5 用户密码认证转发', r.ok);
      check('socks5 认证被代理接受', logs(auth).includes('SOCKS5 ' + target + ' auth'));
    }
    /* 6. 认证失败：不应有数据，guest 应收到 RST */
    {
      const r = await session(
        ['--proxy=http://user:bad@127.0.0.1:' + P.httpAuth], sport++, echo.port);
      check('错误密码不过数据', !r.ok);
      check('错误密码时 guest 收到 RST', rstSeen(r.st));
      check('代理记录了认证失败', logs(auth).includes('HTTP-AUTH-FAIL'));
    }
    /* 7. --dns=ip:port 覆盖（不碰 /etc/resolv.conf 的 53） */
    {
      const got = [];
      const dnsSrv = net.createServer();  /* 占位，避免端口被抢 */
      await new Promise((res) => dnsSrv.close(res));
      const dport = await freePort();
      const dns = require('dgram').createSocket('udp4');
      await new Promise((res) => dns.bind(dport, '127.0.0.1', res));
      dns.on('message', (msg, rinfo) => {
        got.push(msg);
        /* 原样回一份带 A 记录的应答 */
        const q = Buffer.from(msg);
        q[2] = 0x81;
        q[3] = 0x80;
        q.writeUInt16BE(1, 6);
        const ans = Buffer.from([0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01,
                                 0x00, 0x00, 0x00, 0x3c, 0x00, 0x04,
                                 0x01, 0x02, 0x03, 0x04]);
        dns.send(Buffer.concat([q, ans]), rinfo.port, rinfo.address);
      });
      const st = startShim(['--dns=127.0.0.1:' + dport]);
      const query = Buffer.from([
        0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0,
        0x03, 0x77, 0x77, 0x77, 0x07, 0x65, 0x78, 0x61, 0x6d, 0x70,
        0x6c, 0x65, 0x03, 0x63, 0x6f, 0x6d, 0x00, 0x00, 0x01, 0x00, 0x01,
      ]);
      st.sim.stdin.write(slip(udpPacket(GUEST_IP, DNS_IP, 5555, 53, query)));
      const ok = await waitFor(() => {
        st.parsed();
        return st.udp.some((u) => u.payload.includes(Buffer.from([1, 2, 3, 4])));
      }, 4000);
      check('--dns 覆盖把查询送到指定端口', got.length > 0, 'queries=' + got.length);
      check('--dns 覆盖的应答回到 guest 的 10.0.2.3:53', ok);
      st.sim.kill();
      dns.close();
    }
  } finally {
    plain.kill();
    auth.kill();
    echo.srv.close();
  }

  console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试异常: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
