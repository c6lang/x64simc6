/* tests/browser_alpine.js —— 用 headless Chromium + wasm 跑完整 Alpine 固件。
 *
 * 目的：验证「浏览器里 wasm 真的能跑 Linux/Alpine」，而不只是跑 hello64 payload。
 * 做法：同源 HTTP 提供 web/sim.wasm 与 build/firmware.bin（约 34 MiB），
 *       在页面里 instantiate wasm，把固件写进线性内存，调用 sim_init()，
 *       然后分块 sim_run() 并抽取串口输出，直到看到 "Run /init as init process"。
 *
 * 环境变量：
 *   BOOT_TARGET  期望出现的关键字（默认 "Run /init as init process"）
 *   MAX_SECONDS  整体超时（默认 3600）
 *   CHUNK        每次 evaluate 跑的指令数（默认 2000000）
 */
const { spawn } = require('child_process');
const http = require('http');

const PORT = 8132;
const CDP_PORT = 9233;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TARGET = process.env.BOOT_TARGET || 'Run /init as init process';
const MAX_SECONDS = Number(process.env.MAX_SECONDS || 3600);
const CHUNK = Number(process.env.CHUNK || 2000000);

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
                       { stdio: 'ignore' });
  const chrome = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=build/chrome-alpine', 'about:blank'
  ], { stdio: 'ignore' });
  let ws = null;
  try {
    let info = null;
    for (let i = 0; i < 80; i++) {
      try { info = await getJson(`http://127.0.0.1:${CDP_PORT}/json/version`); break; }
      catch (e) { await sleep(200); }
    }
    if (!info) throw new Error('Chromium 调试端口未就绪');
    const targets = await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const page = targets.find(t => t.type === 'page');
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
      const r = await send('Runtime.evaluate',
                           { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result && r.result.exceptionDetails) {
        const d = r.result.exceptionDetails;
        throw new Error((d.exception && d.exception.description) || d.text || 'Uncaught');
      }
      return r.result && r.result.result && r.result.result.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/web/index.html` });
    await sleep(1500);

    // 1) 装载 wasm + 固件并 sim_init()
    const initInfo = await evaluate(`(async () => {
      const FW = '/build/firmware.bin';
      const STAGE = 0x0d800000;               /* 216 MiB：在 guest RAM 与 wasm 栈之上 */
      const resp = await fetch(FW);
      if (!resp.ok) throw new Error('firmware fetch ' + resp.status);
      const fw = new Uint8Array(await resp.arrayBuffer());
      const mod = await WebAssembly.compileStreaming(fetch('/web/sim.wasm'));
      const inst = await WebAssembly.instantiate(mod, {});
      const w = inst.exports;
      const mem = new Uint8Array(w.memory.buffer);
      if (STAGE + fw.length > mem.length) throw new Error('stage overflow ' + mem.length);
      mem.set(fw, STAGE);
      w.sim_set_cmdline('console=ttyS0,115200 loglevel=4 panic=-1 acpi=off pci=off');
      const rc = w.sim_init(STAGE, fw.length);
      w.sim_riptrace_start();
      window.__w = w;
      window.__out = new Uint8Array(65536);
      window.__text = '';
      window.__drain = () => {
        const n = w.sim_serial_out(window.__out, window.__out.length);
        if (n > 0) window.__text += new TextDecoder().decode(window.__out.subarray(0, n));
        return n;
      };
      window.__step = (n) => { const r = w.sim_run(n); window.__drain(); return r; };
      window.__riptrace = () => {
        const n = w.sim_rip_trace_n();
        const a = new Array(n);
        for (let i = 0; i < n; i++) a[i] = Number(w.sim_rip_trace(i));
        return a;
      };
      window.__info = () => ({ hi: Number(w.sim_halt_info()),
                               rip: Number(w.sim_last_rip()),
                               fl: Number(w.sim_cpu_flags()),
                               n: Number(w.sim_insns()) });
      return { rc, fwlen: fw.length, memlen: mem.length, stage: STAGE };
    })()`);
    console.log('[alpine] wasm 装载完成:',
                `rc=${initInfo.rc} fw=${(initInfo.fwlen / 1048576).toFixed(1)}MiB`,
                `mem=${(initInfo.memlen / 1048576).toFixed(0)}MiB`);

    // 2) 分块推进
    const t0 = Date.now();
    let lastBeat = 0;
    let hit = false;
    let insns = 0;
    while ((Date.now() - t0) / 1000 < MAX_SECONDS) {
      const r = await evaluate(`(() => { const ret = window.__step(${CHUNK}); return { ret, len: window.__text.length }; })()`);
      insns += CHUNK;
      const secs = (Date.now() - t0) / 1000;
      if (secs - lastBeat > 30) {
        lastBeat = secs;
        const tail = await evaluate(`window.__text.slice(-240)`);
        const rate = insns / secs / 1e6;
        console.log(`[alpine] ${secs.toFixed(0)}s insns=${(insns / 1e6).toFixed(0)}M ` +
                    `(${rate.toFixed(2)}M/s) text=${r.len}B`);
        if (tail && tail.trim()) console.log('   …' + tail.replace(/\s+/g, ' ').slice(-160));
      }
      if (r.ret === 0 || insns >= 3000000) {
        const tr = await evaluate(`window.__riptrace()`);
        if (tr && tr.length) {
          require('fs').writeFileSync('build/wasm_rip.json', JSON.stringify(tr));
          console.log(`[alpine] RIP trace ${tr.length} 条 -> build/wasm_rip.json`);
        }
      }
      if (r.ret === 0) {
        const info = await evaluate(`window.__info()`);
        console.log('[alpine] halt info:', JSON.stringify(info));
      }
      const has = await evaluate(`window.__text.includes(${JSON.stringify(TARGET)})`);
      if (has) { hit = true; break; }
      if (r.ret === 0) break;                  /* 模拟器停机 */
    }

    const text = await evaluate(`window.__text`);
    const secs = (Date.now() - t0) / 1000;
    const fwlog = require('fs');
    fwlog.mkdirSync('build', { recursive: true });
    fwlog.writeFileSync('build/browser_alpine.log', text);
    console.log(`[alpine] 用时 ${secs.toFixed(0)}s，指令 ${(insns / 1e6).toFixed(0)}M，串口 ${text.length} 字节`);
    console.log(hit ? `[alpine] 命中目标: ${TARGET}` : `[alpine] 未命中目标: ${TARGET}`);
    if (!hit) {
      console.log('[alpine] 串口尾部: ' + text.slice(-400).replace(/\s+/g, ' '));
      process.exitCode = 1;
      return;
    }
    console.log('[alpine] wasm 跑 Linux/Alpine 通过');
  } finally {
    try { if (ws) ws.close(); } catch (e) {}
    chrome.kill('SIGKILL');
    server.kill('SIGKILL');
  }
}

main().catch(e => { console.error('[alpine] failed:', e.message); process.exit(1); });