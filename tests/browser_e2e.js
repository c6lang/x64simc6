/* 用 headless Chromium + CDP 验证 web/app.js 的真实 fetch / Cache Storage / IndexedDB / wasm 桥。 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const net = require('net');
const path = require('path');

let PORT = 0;
let CDP_PORT = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* 取一个空闲端口：固定端口会和上一次遗留的 Chromium/http.server 抢，
 * 拿到的可能是别的进程（旧 app.js），表现就是测试结果和源码不一致。 */
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
  PORT = await freePort();
  CDP_PORT = await freePort();
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
                       { cwd: 'web', stdio: 'ignore' });
  // 网络代理：页面「连接」按钮背后是 tools/ws_slip_proxy.js（每个连接起一个 --netshim）
  const proxyPort = await freePort();
  const proxy = spawn('node', ['tools/ws_slip_proxy.js', '--port', String(proxyPort)],
                      { stdio: ['ignore', 'ignore', 'pipe'] });
  // 每次用干净的 profile：否则会命中上一次的 HTTP 缓存（旧 app.js/sim.wasm）
  fs.rmSync('build/chrome-e2e', { recursive: true, force: true });
  fs.mkdirSync('build/chrome-e2e', { recursive: true });
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

    const cache = await evaluate(`caches.open('c6sim-assets-v1').then(c => c.keys()).then(ks => ks.some(k => k.url.indexOf('sim.wasm') >= 0))`);
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

    // 页面自身的「加载固件」路径：真实 Alpine 固件约 34 MiB，要能扩内存 staging
    const loaded = await evaluate(`(async () => {
      document.getElementById('fwurl').value = 'firmware.bin';
      document.getElementById('load').click();
      for (let i = 0; i < 300; i++) {
        const s = document.getElementById('status').textContent || '';
        if (s.includes('已加载') || s.includes('失败')) return s;
        await new Promise(r => setTimeout(r, 100));
      }
      return document.getElementById('status').textContent || '';
    })()`);
    if (!(loaded || '').includes('已加载')) throw new Error('页面加载 34 MiB 固件失败: ' + loaded);
    console.log('[browser] 页面加载 34 MiB 固件 OK:', loaded);

    // 页面「启动」后每帧要按时间预算跑（旧实现固定 20000 条/帧 → ~1.2M/s）
    const tput = await evaluate(`(async () => {
      const before = Number(wasm.sim_stat_insns());
      document.getElementById('start').click();
      await new Promise(r => setTimeout(r, 5000));
      document.getElementById('pause').click();
      return Number(wasm.sim_stat_insns()) - before;
    })()`);
    if (tput < 12000000) throw new Error('页面运行吞吐过低（5s 只跑了 ' + tput + ' 条）');
    console.log('[browser] 页面 5s 跑 ' + tput + ' 条指令 OK');

    // 本地 .bin 文件选择（页面新增的 #fwfile）：不走 fetch/Cache，直接读进
    // wasm staging。先用 Linux 固件验证 picker 本身，再（如果有）用 c6os
    // 固件验证 C6FW v2 分派与 Alpine 引导。
    await send('DOM.enable');
    const doc = await send('DOM.getDocument');
    const input = await send('DOM.querySelector',
                             { nodeId: doc.result.root.nodeId, selector: '#fwfile' });
    if (!input.result.nodeId) throw new Error('页面没有 #fwfile');
    await evaluate(`document.getElementById('status').textContent = '选择中…'`);
    await send('DOM.setFileInputFiles',
               { nodeId: input.result.nodeId, files: [path.resolve('web/firmware.bin')] });
    // CDP 放文件是异步落 DOM 的：等 files[0].name 真的换过来，再补 change
    for (let i = 0; i < 100; i++) {
      const n = await evaluate(`(document.getElementById('fwfile').files[0] || {}).name`);
      if (n === 'firmware.bin') break;
      await sleep(50);
    }
    await evaluate(`document.getElementById('fwfile').dispatchEvent(new Event('change'))`);
    let pick = '';
    for (let i = 0; i < 200; i++) {
      pick = await evaluate(`document.getElementById('status').textContent`) || '';
      if (pick.includes('已加载') || pick.includes('失败')) break;
      await sleep(100);
    }
    if (!pick.includes('已加载') || !pick.includes('firmware.bin'))
      throw new Error('本地 firmware.bin 选择失败: ' + pick);
    console.log('[browser] 本地 firmware.bin 选择 OK:', pick);

    // c6os/Alpine 固件（C6FW v2）：可选。build/c6os.bin 由 ./build.sh c6os
    // 打包（依赖 ~/rtos-c6 的内核与 Alpine rootfs），没有就跳过这一段。
    if (fs.existsSync('build/c6os.bin')) {
      await evaluate(`document.getElementById('status').textContent = '选择中…'`);
      // nodeId 在第一次 setFileInputFiles 后可能失效，重新查一次
      const doc2 = await send('DOM.getDocument');
      const input2 = await send('DOM.querySelector',
                                { nodeId: doc2.result.root.nodeId, selector: '#fwfile' });
      const setRc = await send('DOM.setFileInputFiles',
                               { nodeId: input2.result.nodeId,
                                 files: [path.resolve('build/c6os.bin')] });
      if (setRc.error) throw new Error('setFileInputFiles: ' + JSON.stringify(setRc.error));
      let gotName = '';
      for (let i = 0; i < 100; i++) {
        gotName = await evaluate(`(document.getElementById('fwfile').files[0] || {}).name`) || '';
        if (gotName === 'c6os.bin') break;
        await sleep(50);
      }
      if (gotName !== 'c6os.bin')
        throw new Error('文件输入没有换成 c6os.bin，实际=' + gotName);
      await evaluate(`document.getElementById('fwfile').dispatchEvent(new Event('change'))`);
      let c6 = '';
      for (let i = 0; i < 300; i++) {
        c6 = await evaluate(`document.getElementById('status').textContent`) || '';
        if (c6.includes('已加载') || c6.includes('失败')) break;
        await sleep(100);
      }
      if (!c6.includes('已加载') || !c6.includes('c6os.bin'))
        throw new Error('本地 c6os.bin 选择失败: ' + c6);
      const boot = await evaluate(`(async () => {
        document.getElementById('start').click();
        for (let i = 0; i < 300; i++) {
          if (serialLog.includes('c6os alpine M12')) return serialLog;
          await new Promise(r => setTimeout(r, 100));
        }
        return serialLog;
      })()`);
      await evaluate(`document.getElementById('pause').click()`);
      if (!boot.includes('c6os alpine M12'))
        throw new Error('c6os 固件没有引导到内核: ' + boot.slice(0, 300));
      console.log('[browser] 本地 c6os.bin 引导 OK（C6FW v2 → Alpine 内核）');
    } else {
      console.log('[browser] 跳过 c6os.bin（没有 build/c6os.bin）');
    }

    // xterm.js：终端要能渲染文本与 ANSI 颜色（引导前 200M 条还没有串口输出，
    // 所以这里直接往终端写一行带颜色的测试串，验证缓冲区/渲染路径）
    const screen = await evaluate(`(async () => {
      if (!document.querySelector('.xterm')) return { ok: false, why: '没有 .xterm' };
      term.write('xterm-ok\\r\\n');
      await new Promise(r => setTimeout(r, 300));
      const b = term.buffer.active;
      let s = '';
      for (let i = 0; i < b.length; i++) s += (b.getLine(i) && b.getLine(i).translateToString(true) || '');
      return { ok: true, text: s, cols: term.cols, rows: term.rows,
               w: document.querySelector('.xterm').clientWidth };
    })()`);
    if (!screen.ok || !screen.text.includes('xterm-ok')) throw new Error('xterm 终端没有渲染文本: ' + JSON.stringify(screen));
    console.log('[browser] xterm 终端 OK: 渲染 xterm-ok');

    // 页面「网络代理」UI：只验证 WebSocket 连接（真正上网由 wasm_net_proxy 测）
    const netOk = await evaluate(`(async () => {
      document.getElementById('proxyurl').value = 'ws://127.0.0.1:${proxyPort}';
      document.getElementById('netconnect').click();
      for (let i = 0; i < 100; i++) {
        const s = document.getElementById('netstatus').textContent || '';
        if (s.includes('已连接') || s.includes('失败')) return s;
        await new Promise(r => setTimeout(r, 100));
      }
      return document.getElementById('netstatus').textContent || '';
    })()`);
    if (!(netOk || '').includes('已连接')) throw new Error('页面连接代理失败: ' + netOk);
    console.log('[browser] 页面网络代理连接 OK:', netOk);
    await evaluate(`document.getElementById('netdisconnect').click()`);

    // build/sim --serve：页面、sim.wasm 和 WS 网关同源，不需要 Node 代理。
    // 导航到网关发的页面，detectGateway() 应把 WS 地址自动填成同源 /ws。
    const gwPort = await freePort();
    const gw = spawn('build/sim', ['--serve', '--port=' + gwPort, '--web=web'],
                     { stdio: ['ignore', 'ignore', 'pipe'] });
    let gwLog = '';
    gw.stderr.on('data', (d) => { gwLog += d.toString(); });
    try {
      for (let i = 0; i < 100; i++) {
        if (gwLog.includes('--serve:')) break;
        await sleep(50);
      }
      if (!gwLog.includes('--serve:')) throw new Error('build/sim --serve 没有起来');
      await send('Page.navigate', { url: `http://127.0.0.1:${gwPort}/index.html` });
      let gwStatus = '';
      for (let i = 0; i < 200; i++) {
        gwStatus = await evaluate(`document.getElementById('status') ? document.getElementById('status').textContent : ''`) || '';
        if (gwStatus.includes('已就绪') || gwStatus.includes('失败')) break;
        await sleep(100);
      }
      if (!gwStatus.includes('已就绪')) throw new Error('--serve 页面初始化失败: ' + gwStatus);
      const wantWs = `ws://127.0.0.1:${gwPort}/ws`;
      let wsUrl = '';
      for (let i = 0; i < 50; i++) {
        wsUrl = await evaluate(`document.getElementById('proxyurl').value`) || '';
        if (wsUrl === wantWs) break;
        await sleep(100);
      }
      if (wsUrl !== wantWs) throw new Error('detectGateway 没自动填 WS: ' + wsUrl);
      const gwNet = await evaluate(`(async () => {
        document.getElementById('netconnect').click();
        for (let i = 0; i < 100; i++) {
          const s = document.getElementById('netstatus').textContent || '';
          if (s.includes('已连接') || s.includes('失败')) return s;
          await new Promise(r => setTimeout(r, 100));
        }
        return document.getElementById('netstatus').textContent || '';
      })()`);
      if (!(gwNet || '').includes('已连接')) throw new Error('--serve 网关连接失败: ' + gwNet);
      console.log('[browser] build/sim --serve 自动填 WS 并连接 OK:', gwNet);
    } finally {
      gw.kill();
    }
    console.log('browser_e2e: all checks passed');
  } finally {
    if (ws) ws.close();
    chrome.kill();
    server.kill();
    proxy.kill();
  }
}

main().catch(e => { console.error('browser_e2e FAILED:', e.message); process.exit(1); });
