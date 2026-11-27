/* tests/browser_tty_login.js —— 走浏览器页面自身的 xterm.js 终端登录。
 *
 * 和 browser_alpine.js 的区别：那个测试直接调 wasm 的 sim_run/sim_serial_out；
 * 这个测试点页面的「加载固件」「启动」，从 xterm 缓冲区里找 login:，用
 * term.paste() 输入 root / uname -m，验证「页面 UI + xterm + 键盘输入 +
 * 串口输出」整条链路。
 *
 * 用法：node tests/browser_tty_login.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const net = require('net');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, r => {
    let b = '';
    r.on('data', c => b += c);
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

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
  const CDP = await freePort();
  const profile = 'build/chrome-tty-' + process.pid;
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });

  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
                       { cwd: 'web', stdio: 'ignore' });
  const chrome = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, 'about:blank'
  ], { stdio: 'ignore' });

  let ws = null;
  try {
    let info = null;
    for (let i = 0; i < 100; i++) {
      try { info = await getJson(`http://127.0.0.1:${CDP}/json/version`); break; }
      catch (e) { await sleep(200); }
    }
    if (!info) throw new Error('Chromium 调试端口未就绪');
    const targets = await getJson(`http://127.0.0.1:${CDP}/json/list`);
    const page = targets.find(t => t.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let seq = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params = {}) => new Promise(resolve => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text || 'eval error');
      return r.result && r.result.result && r.result.result.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
    let status = '';
    for (let i = 0; i < 300; i++) {
      status = await evaluate(`document.getElementById('status') ? document.getElementById('status').textContent : ''`) || '';
      if (status.includes('已就绪')) break;
      await sleep(200);
    }
    if (!status.includes('已就绪')) throw new Error('页面未就绪: ' + status);

    const loaded = await evaluate(`(async () => {
      document.getElementById('load').click();
      for (let i = 0; i < 600; i++) {
        const s = document.getElementById('status').textContent || '';
        if (s.includes('已加载') || s.includes('失败')) return s;
        await new Promise(r => setTimeout(r, 250));
      }
      return document.getElementById('status').textContent || '';
    })()`);
    if (!loaded.includes('已加载')) throw new Error('固件加载失败: ' + loaded);
    await evaluate(`document.getElementById('start').click()`);

    const termText = () => evaluate(`(() => {
      const b = term.buffer.active;
      let s = '';
      for (let i = 0; i < b.length; i++) s += (b.getLine(i) && b.getLine(i).translateToString(true) || '') + '\\n';
      return s;
    })()`);

    let text = '';
    for (let i = 0; i < 900; i++) {          // 最多 180s 到 login
      text = await termText();
      if (text.includes('login:')) break;
      await sleep(200);
    }
    if (!text.includes('login:')) throw new Error('xterm 里没等到 login:');
    console.log('[tty] xterm 看到 login:');

    await evaluate(`term.paste('root\\r')`);
    for (let i = 0; i < 300; i++) {
      text = await termText();
      if (text.includes('# ')) break;
      await sleep(200);
    }
    if (!text.includes('# ')) throw new Error('没有等到 shell 提示符');
    console.log('[tty] 登录成功，看到 shell 提示符');

    await evaluate(`term.paste('uname -m\\r')`);
    for (let i = 0; i < 100; i++) {
      text = await termText();
      if (text.includes('x86_64')) break;
      await sleep(200);
    }
    if (!text.includes('x86_64')) throw new Error('xterm 里没有 x86_64');
    console.log('[tty] xterm 里执行 uname -m = x86_64');
    console.log('BROWSER TTY OK');
  } finally {
    try { ws && ws.close(); } catch (e) {}
    chrome.kill();
    server.kill();
    await sleep(500);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
})().catch(e => { console.error('BROWSER TTY FAILED:', e.message); process.exit(1); });
