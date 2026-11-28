#!/usr/bin/env node
/* tools/test_proxy.js —— 测试用的最小上游代理（HTTP CONNECT / SOCKS5 / SOCKS4）。
 *
 * 只给 tests/netshim_proxy.js 用：握手成功后把目标地址打到 stdout，然后在
 * 客户端和目标之间双向搬运字节。不做认证白名单、限流、超时管理，别当生产
 * 代理用。
 *
 * 用法：
 *   node tools/test_proxy.js --http 18080 --socks 18081 --socks4 18082 \
 *        [--http-auth user:pass] [--socks-auth user:pass]
 * 只监听 127.0.0.1；不传的协议就不启动。
 * stdout 每行一个事件：`HTTP host:port [auth]`、`SOCKS5 host:port [auth]`、
 * `SOCKS4 host:port`、以及握手失败时的 `HTTP-AUTH-FAIL` / `SOCKS5-AUTH-FAIL`。
 */
const net = require('net');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

function log(kind, target, extra) {
  process.stdout.write(kind + ' ' + target + (extra ? ' ' + extra : '') + '\n');
}

/* 握手完成后把客户端和上游接起来；leftover 是握手时同包多读到的字节。 */
function relay(client, target, leftover) {
  const queued = [];
  if (leftover && leftover.length) queued.push(leftover);
  const queue = (d) => queued.push(d);
  client.on('data', queue);
  const up = net.connect({ host: target.host, port: target.port });
  up.on('connect', () => {
    client.removeListener('data', queue);
    for (const q of queued) if (q && q.length) up.write(q);
    queued.length = 0;
    client.pipe(up);
    up.pipe(client);
  });
  up.on('error', () => { try { client.destroy(); } catch (e) {} });
  client.on('error', () => { try { up.destroy(); } catch (e) {} });
}

function splitHostPort(s) {
  const i = s.lastIndexOf(':');
  if (i <= 0) return null;
  return { host: s.slice(0, i), port: Number(s.slice(i + 1)) };
}

/* ---------------- HTTP CONNECT ---------------- */
function startHttp(port, auth) {
  const want = auth ? 'Basic ' + Buffer.from(auth).toString('base64') : null;
  const srv = net.createServer((c) => {
    let buf = Buffer.alloc(0);
    const ondata = (d) => {
      buf = Buffer.concat([buf, d]);
      /* 协议探测（--proxy 不带 scheme 时）会先发 SOCKS5 问候；真实 HTTP
       * 代理遇到这种二进制垃圾会立刻回 400，这里也照做，好让自动识别
       * 走「首字节 'H' → http」这条路径。 */
      if (buf.length >= 1 && buf[0] !== 0x43 /* 'C' */) {
        log('HTTP-BADREQ', String(buf.length));
        c.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) {
        if (buf.length > 8192) c.destroy();
        return;
      }
      c.removeListener('data', ondata);
      const head = buf.subarray(0, i).toString('latin1');
      const rest = buf.subarray(i + 4);
      const m = /^CONNECT\s+(\S+)\s+HTTP\/1\.[01]\s*$/im.exec(head);
      if (!m) {
        c.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      const hp = splitHostPort(m[1]);
      if (!hp || !hp.port) {
        c.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      if (want) {
        const h = mHdr(head, 'proxy-authorization');
        if (h !== want) {
          log('HTTP-AUTH-FAIL', hp.host + ':' + hp.port);
          c.end('HTTP/1.1 407 Proxy Authentication Required\r\n' +
                'Proxy-Authenticate: Basic realm="test"\r\n' +
                'Content-Length: 0\r\n\r\n');
          return;
        }
      }
      log('HTTP', hp.host + ':' + hp.port, want ? 'auth' : '');
      c.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      relay(c, hp, rest);
    };
    c.on('data', ondata);
    c.on('error', () => {});
  });
  srv.listen(port, '127.0.0.1');
}

function mHdr(head, name) {
  const lines = head.split('\r\n');
  for (let i = 1; i < lines.length; i++) {
    const k = lines[i].indexOf(':');
    if (k <= 0) continue;
    if (lines[i].slice(0, k).trim().toLowerCase() === name)
      return lines[i].slice(k + 1).trim();
  }
  return null;
}

/* ---------------- SOCKS5 ---------------- */
function startSocks5(port, auth) {
  const user = auth ? auth.split(':')[0] : null;
  const pass = auth ? auth.slice(user.length + 1) : null;
  const srv = net.createServer((c) => {
    let buf = Buffer.alloc(0);
    let step = 'greet';
    const ondata = (d) => { buf = Buffer.concat([buf, d]); pump(); };
    const take = (n) => { const b = buf.subarray(0, n); buf = buf.subarray(n); return b; };
    const pump = () => {
      for (;;) {
        if (step === 'greet') {
          if (buf.length < 2) return;
          if (buf[0] !== 0x05) { c.destroy(); return; }
          const nm = buf[1];
          if (buf.length < 2 + nm) return;
          const methods = take(2 + nm).subarray(2);
          if (user !== null) {
            if (!methods.includes(0x02)) { c.end(Buffer.from([0x05, 0xff])); return; }
            c.write(Buffer.from([0x05, 0x02]));
            step = 'auth';
          } else {
            if (!methods.includes(0x00)) { c.end(Buffer.from([0x05, 0xff])); return; }
            c.write(Buffer.from([0x05, 0x00]));
            step = 'req';
          }
          continue;
        }
        if (step === 'auth') {
          if (buf.length < 2) return;
          const ul = buf[1];
          if (buf.length < 2 + ul + 1) return;
          const pl = buf[2 + ul];
          if (buf.length < 2 + ul + 1 + pl) return;
          const u = take(2 + ul).subarray(2).toString('latin1');
          const p = take(1 + pl).subarray(1).toString('latin1');
          if (u !== user || p !== pass) {
            log('SOCKS5-AUTH-FAIL', u);
            c.end(Buffer.from([0x01, 0x01]));
            return;
          }
          c.write(Buffer.from([0x01, 0x00]));
          step = 'req';
          continue;
        }
        if (step === 'req') {
          if (buf.length < 5) return;
          if (buf[0] !== 0x05 || buf[1] !== 0x01) { c.destroy(); return; }
          const atyp = buf[3];
          let host = null;
          let need = 0;
          if (atyp === 0x01) {
            need = 4 + 4 + 2;
            if (buf.length < need) return;
            host = buf.subarray(4, 8).join('.');
          } else if (atyp === 0x03) {
            const n = buf[4];
            need = 5 + n + 2;
            if (buf.length < need) return;
            host = buf.subarray(5, 5 + n).toString('latin1');
          } else {
            c.destroy();
            return;
          }
          const p = buf.readUInt16BE(need - 2);
          take(need);
          c.removeListener('data', ondata);
          step = 'done';
          log('SOCKS5', host + ':' + p, user !== null ? 'auth' : '');
          const rest = buf;
          buf = Buffer.alloc(0);
          c.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          relay(c, { host, port: p }, rest);
          return;
        }
        return;
      }
    };
    c.on('data', ondata);
    c.on('error', () => {});
  });
  srv.listen(port, '127.0.0.1');
}

/* ---------------- SOCKS4 ---------------- */
function startSocks4(port) {
  const srv = net.createServer((c) => {
    let buf = Buffer.alloc(0);
    const ondata = (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 8) return;
      if (buf[0] !== 0x04) { c.destroy(); return; }
      if (buf[1] !== 0x01) {
        c.end(Buffer.from([0x00, 0x5b, 0, 0, 0, 0, 0, 0]));
        return;
      }
      const p = buf.readUInt16BE(2);
      const ip = buf.subarray(4, 8).join('.');
      let i = 8;
      while (i < buf.length && buf[i] !== 0) i++;
      if (i >= buf.length) return;
      const rest = buf.subarray(i + 1);
      c.removeListener('data', ondata);
      log('SOCKS4', ip + ':' + p);
      c.write(Buffer.from([0x00, 0x5a, 0, 0, 0, 0, 0, 0]));
      relay(c, { host: ip, port: p }, rest);
    };
    c.on('data', ondata);
    c.on('error', () => {});
  });
  srv.listen(port, '127.0.0.1');
}

const httpPort = Number(arg('--http', '0'));
const socksPort = Number(arg('--socks', '0'));
const socks4Port = Number(arg('--socks4', '0'));
if (!httpPort && !socksPort && !socks4Port) {
  console.error('用法: node tools/test_proxy.js --http 18080 --socks 18081 [--socks4 18082]');
  process.exit(2);
}
if (httpPort) startHttp(httpPort, arg('--http-auth', null));
if (socksPort) startSocks5(socksPort, arg('--socks-auth', null));
if (socks4Port) startSocks4(socks4Port);
console.log('READY');
