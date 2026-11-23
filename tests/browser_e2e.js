/* 用 headless Chromium + CDP 验证 web/app.js 的真实 fetch / Cache Storage / IndexedDB / wasm 桥。 */
const { spawn } = require('child_process');
const http = require('http');

const PORT = 8123;
const CDP_PORT = 9223;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
                       { cwd: 'web', stdio: 'ignore' });
  const chrome = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=build/chrome-e2e`, 'about:blank'
  ], { stdio: 'ignore' });
  let ws = null;
  try {
    let info = null;
    for (let i = 0; i < 60; i++) {
      try { info = await getJson(`http://127.0.0.1:${CDP_PORT}/json/version`); break; }
      catch (e) { await sleep(200); }
    }
    if (!info) throw new Error('Chromium 调试端口未就绪');
    let targets = await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
    let page = targets.find(t => t.type === 'page');
    if (!page) throw new Error('没有可调试的页面目标');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let seq = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    };
    const send = (method, params = {}) => new Promise(resolve => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result && r.result.exceptionDetails) {
        const d = r.result.exceptionDetails;
        throw new Error((d.exception && d.exception.description) || d.text || 'Uncaught');
      }
      return r.result && r.result.result && r.result.result.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
    for (let i = 0; i < 100; i++) {
      const ready = await evaluate(`document.readyState === 'complete' && !!document.getElementById('status')`);
      if (ready) break;
      await sleep(200);
    }
    let status = '';
    for (let i = 0; i < 100; i++) {
      status = await evaluate(`document.getElementById('status').textContent`) || '';
      if (status.includes('已就绪')) break;
      await sleep(200);
    }
    if (!status.includes('已就绪')) throw new Error('wasm/IndexedDB 初始化失败: ' + status);
    console.log('[browser] wasm + IndexedDB 初始化 OK:', status);

    const net = await evaluate(`fetch('sim.wasm').then(r => r.status)`);
    if (net !== 200) throw new Error('fetch 状态 ' + net);
    console.log('[browser] 真实 fetch OK: HTTP', net);

    const cache = await evaluate(`caches.open('c6sim-assets-v1').then(c => c.match('sim.wasm')).then(r => !!r)`);
    if (!cache) throw new Error('Cache Storage 未缓存 sim.wasm');
    console.log('[browser] Cache Storage OK');

    const idb = await evaluate(`new Promise((resolve, reject) => {
      const r = indexedDB.open('c6sim', 1);
      r.onsuccess = () => {
        const db = r.result;
        const tx = db.transaction('files', 'readwrite');
        tx.objectStore('files').put(new Uint8Array([101,50,101]), '__e2e__');
        tx.oncomplete = () => {
          const tx2 = db.transaction('files', 'readonly');
          const g = tx2.objectStore('files').get('__e2e__');
          g.onsuccess = () => resolve(Array.from(new Uint8Array(g.result)).join(','));
          g.onerror = () => reject(g.error);
        };
      };
      r.onerror = () => reject(r.error);
    })`);
    if (idb !== '101,50,101') throw new Error('IndexedDB 往返失败: ' + idb);
    console.log('[browser] IndexedDB 往返 OK');

    const put = await evaluate(`(() => {
      document.getElementById('filename').value = '__e2e_file__';
      document.getElementById('filedata').value = 'hello';
      document.getElementById('put').click();
      return document.getElementById('fileresult').textContent;
    })()`);
    await sleep(300);
    if (!(put || '').includes('已写入')) throw new Error('hostfs put UI 失败: ' + put);
    console.log('[browser] wasm hostfs put OK:', put);

    const get = await evaluate(`(() => { document.getElementById('get').click(); return document.getElementById('fileresult').textContent; })()`);
    if (!get.includes('hello')) throw new Error('hostfs get UI 失败: ' + get);
    console.log('[browser] wasm hostfs get OK:', get);
    console.log('browser_e2e: all checks passed');
  } finally {
    if (ws) ws.close();
    chrome.kill();
    server.kill();
  }
}

main().catch(e => { console.error('browser_e2e FAILED:', e.message); process.exit(1); });
