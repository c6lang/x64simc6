/* c6simc6 浏览器前端：真实 fetch + Cache Storage + IndexedDB 文件表/快照。
 * 与 wasm 之间只通过导出的 C 函数 + 共享线性内存通信，不依赖 wasm import。 */
const $ = (id) => document.getElementById(id);
const status = (s) => { $('status').textContent = s; };
const netstatus = (s) => { $('netstatus').textContent = s; };
const SCRATCH = 0x0f800000;   // 248 MiB：hostfs/串口的小缓冲（初始 256 MiB 内）
const FW_STAGE = 0x10000000;  // 256 MiB：大固件 staging；不够就先把内存扩到 512 MiB
const FW_MAX = 48 << 20;      // 与 src/wasm.c6 的 g_fw_stage 一致
const NET_RX = SCRATCH + 4 * 0x100000;   // 252 MiB：代理 -> wasm 的收包缓冲
const NET_TX = NET_RX + 65536;            // 252 MiB + 64 KiB：wasm -> 代理
const FS_CAP = 1 << 20;
const WASM_VER = '2.2';   // 换 wasm 时同步 bump：Cache Storage 按 URL 缓存
const FW_VER = '3';       // 换内置固件（firmware.bin/c6os.bin）时 bump

let wasm = null;
let mem = null;
let term = null;
let serialLog = '';
let db = null;
let running = false;
let fwLoaded = false;      /* sim_init 成功过才允许「启动」 */
let raf = 0;
let totalInsns = 0;
let lastSync = 0;
let lastStatus = 0;
let sawSerial = false;
let fwSeq = 0;   // 固件加载序号：后一次选择作废前一次（异步读文件/下载会乱序）
let netws = null;
let netTimer = 0;
let netRx = 0, netTx = 0, netStatusAt = 0;

function bytes() { return new Uint8Array(wasm.memory.buffer); }
function str2bytes(s) { return new TextEncoder().encode(s); }
function put(ptr, data) { bytes().set(data, ptr); }
function get(ptr, len) { return bytes().slice(ptr, ptr + len); }

/* ---------- IndexedDB ---------- */
function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('c6sim', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('files');
      r.result.createObjectStore('meta');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function idbOp(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ---------- 固件下载：Cache Storage + 重试 + 进度 ---------- */
async function fetchAsset(url, retries = 3) {
  const cache = await caches.open('c6sim-assets-v1');
  const cached = await cache.match(url);
  if (cached) return new Uint8Array(await cached.arrayBuffer());
  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      status(`下载 ${url}（第 ${attempt + 1} 次）`);
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const total = Number(resp.headers.get('content-length') || 0);
      const reader = resp.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (total) status(`下载 ${url}：${received}/${total} 字节`);
      }
      const out = new Uint8Array(received);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      await cache.put(url, new Response(out));
      return out;
    } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 300 * (attempt + 1))); }
  }
  throw lastErr;
}

/* ---------- wasm 侧文件表同步 ---------- */
function importFiles(files) {
  const chunks = [];
  let off = 8;
  for (const [name, data] of files) {
    const nb = str2bytes(name);
    const h = new Uint8Array(8);
    new DataView(h.buffer).setUint16(0, nb.length, true);
    new DataView(h.buffer).setUint32(4, data.length, true);
    chunks.push(h, nb, data);
    off += 8 + nb.length + data.length;
  }
  chunks.unshift(new Uint8Array(8));
  const buf = new Uint8Array(off);
  let p = 0;
  for (const c of chunks) { buf.set(c, p); p += c.length; }
  put(SCRATCH, buf);
  const n = wasm.sim_hostfs_import(SCRATCH, buf.length);
  wasm.sim_host_event(2, 0);
  return n;
}
function exportFiles() {
  const n = wasm.sim_hostfs_export(SCRATCH + FS_CAP, FS_CAP);
  if (n <= 0) return;
  const view = new DataView(wasm.memory.buffer, SCRATCH + FS_CAP, n);
  let off = 0, count = 0;
  while (off + 8 <= n) {
    const nl = view.getUint16(off, true);
    const dl = view.getUint32(off + 4, true);
    off += 8;
    if (!nl) break;
    const name = new TextDecoder().decode(get(SCRATCH + FS_CAP + off, nl));
    off += nl;
    const data = get(SCRATCH + FS_CAP + off, dl);
    off += dl;
    idbOp('files', 'readwrite', s => s.put(data, name));
    count++;
  }
  if (count) status(`页面存储同步：${count} 个文件已写回 IndexedDB`);
}

/* ---------- 终端（xterm.js） ----------
 * 浏览器里直接给一个真终端：ANSI 颜色、光标、滚动历史、选择复制都由
 * xterm.js 处理；键盘输入原样送 guest（Ctrl-C 就是 0x03），
 * ash 的 ESC[6n 也由 xterm 自动应答。 */
function initTerm() {
  term = new Terminal({
    cols: 80, rows: 24, scrollback: 5000, cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 13,
    theme: {
      background: '#0a0e13', foreground: '#d6e0ea', cursor: '#7fd1c1',
      selectionBackground: '#2a6f68',
    },
  });
  term.open($('term'));
  $('term').addEventListener('mousedown', () => term.focus());
  term.onData((data) => {
    if (!running) {
      status('先点「加载固件」和「启动」，终端才会连到 guest');
      return;
    }
    const b = str2bytes(data);
    put(wasm.sim_host_bridge(), b);
    wasm.sim_host_event(3, b.length);
  });
  term.focus();
}

/* ---------- 初始化 ---------- */
async function initWasm() {
  if (location.protocol === 'file:') {
    status('请用 HTTP 服务打开（cd web && python3 -m http.server 8000），不能用 file://');
    return;
  }
  status('加载 wasm…');
  const bytesWasm = await fetchAsset('sim.wasm?v=' + WASM_VER);
  const module = await WebAssembly.compile(bytesWasm);
  const inst = await WebAssembly.instantiate(module, {});
  wasm = inst.exports;
  mem = wasm.memory;
  if (typeof wasm.sim_set_rtc === 'function')
    wasm.sim_set_rtc(Math.floor(Date.now() / 1000));
  initTerm();
  db = await openDB();
  const files = await idbOp('files', 'readonly', s => s.getAll());
  const keys = await idbOp('files', 'readonly', s => s.getAllKeys());
  const pairs = keys.map((k, i) => [String(k), new Uint8Array(files[i])]);
  importFiles(pairs);
  const log = await idbOp('meta', 'readonly', s => s.get('console'));
  if (log) {
    serialLog = new TextDecoder().decode(log);
    term.write('\r\n\x1b[90m── 上次会话的串口记录（机器已复位，' +
               '点「加载固件」「启动」重新开始）──\x1b[0m\r\n');
    term.write(serialLog);
  }
  status(log ? '已恢复上次日志（机器未运行）；请点「加载固件」「启动」'
             : 'wasm 已就绪，IndexedDB 文件已导入');
  detectGateway();
}

/* 页面由 build/sim --serve 提供时，/__c6sim 会回 {"gateway":1}：WS 网关
 * 和页面同源，直接把地址填好。普通静态服务器（python http.server、
 * GitHub Pages）没有这个端点，保持原来的手填方式。 */
async function detectGateway() {
  try {
    const r = await fetch('__c6sim', { cache: 'no-store' });
    if (!r.ok) return;
    const cfg = await r.json();
    if (!cfg || !cfg.gateway) return;
    const ws = (location.protocol === 'https:' ? 'wss://' : 'ws://') +
               location.host + (cfg.ws || '/ws');
    if ($('proxyurl')) $('proxyurl').value = ws;
    if ($('netstatus'))
      netstatus('本页由 build/sim --serve 提供：网关 ' + ws + '，点「连接」后 guest 可上网');
  } catch (e) { /* 没有网关端点：保持手填 */ }
}

/* URL 与本地文件共用：把固件放进 FW_STAGE，再交给 sim_init。
 * Linux 固件（C6FW v1）和 c6os/Alpine 固件（C6FW v2）都走这里，
 * 由 wasm 侧按头里的 version 分派。 */
async function bootFirmware(fw, label, seq) {
  if (!wasm) throw new Error('请先加载 wasm');
  if (seq !== undefined && seq !== fwSeq) return;   // 已被后一次选择取代
  if (fw.length > FW_MAX) throw new Error(`固件超过 ${FW_MAX >> 20} MiB staging 上限`);
  const need = FW_STAGE + fw.length;
  if (need > wasm.memory.buffer.byteLength) {
    const pages = Math.ceil((need - wasm.memory.buffer.byteLength) / 65536);
    if (wasm.memory.grow(pages) < 0)
      throw new Error(`内存不足：固件需要 ${need} 字节线性内存`);
    mem = wasm.memory;
  }
  if (seq !== undefined && seq !== fwSeq) return;
  put(FW_STAGE, fw);
  const rc = wasm.sim_init(FW_STAGE, fw.length);
  if (rc !== 0) throw new Error(`sim_init 返回 ${rc}（不是可引导的固件？）`);
  fwLoaded = true;
  term.reset();
  serialLog = '';
  sawSerial = false;
  term.focus();
  status(`固件已加载：${label}（${(fw.length / 1048576).toFixed(1)} MiB），点「启动」`);
}

async function loadFirmware() {
  if (!wasm) { status('请先加载 wasm'); return; }
  const raw = $('fwurl').value.trim();
  /* 内置固件也按 URL 进 Cache Storage；加 ?v= 让重编过的 c6os.bin 不被旧缓存
   * 顶掉（否则页面上永远是上一次的内核）。 */
  const url = raw.indexOf('?') < 0 ? raw + '?v=' + FW_VER : raw;
  const seq = ++fwSeq;
  try {
    const fw = await fetchAsset(url);
    if (seq !== fwSeq) return;
    await bootFirmware(fw, raw, seq);
  } catch (e) { if (seq === fwSeq) status(`固件加载失败：${e.message}`); }
}

/* 本机 .bin：FileReader 不进缓存，也不上传，直接读进 wasm 线性内存。
 * 页面重新加载后要重新选（文件句柄不能持久化）。 */
async function loadFirmwareFile() {
  if (!wasm) { status('请先加载 wasm'); return; }
  const f = $('fwfile').files && $('fwfile').files[0];
  if (!f) return;
  const seq = ++fwSeq;
  status(`正在读取 ${f.name}…`);
  try {
    const fw = new Uint8Array(await f.arrayBuffer());
    if (seq !== fwSeq) return;
    await bootFirmware(fw, f.name, seq);
  } catch (e) { if (seq === fwSeq) status(`固件加载失败：${e.message}`); }
}

function pumpSerial() {
  const cap = 65536;
  const p = SCRATCH + 2 * FS_CAP;
  const n = wasm.sim_serial_out(p, cap);
  if (n > 0) {
    sawSerial = true;
    const bytes = get(p, n);
    term.write(bytes);
    serialLog += new TextDecoder().decode(bytes);
    if (serialLog.length > 600000) serialLog = serialLog.slice(-400000);
  }
}

function loop() {
  if (!running) return;
  const before = Number(wasm.sim_stat_insns());
  // 按时间预算跑：固定 20000 条/帧会把 wasm 限制在 ~1.2M 条/秒，
  // 白白浪费 clang -O2 的 15M 条/秒。每帧最多占 12ms，UI 仍可交互。
  if (typeof wasm.sim_set_host_ms === 'function')
    wasm.sim_set_host_ms(Date.now() >>> 0);
  const t0 = performance.now();
  do {
    wasm.sim_run(100000);
    // 注意：不要用 sim_status() 判断“停机”——Linux 在 idle/等回车时就是
    // HLT（cpu.halted=1），那是正常运行状态；只有指令数不再前进才真停了。
  } while (performance.now() - t0 < 12);
  totalInsns = Number(wasm.sim_stat_insns());
  pumpSerial();
  if (totalInsns - before === 0) {
    running = false;
    status(`停机，共执行 ${totalInsns} 条指令`);
    exportFiles();
    return;
  }
  const now = Date.now();
  if (now - lastStatus > 500) {
    lastStatus = now;
    const n = (totalInsns / 1e6).toFixed(0);
    status(sawSerial ? `运行中… ${n}M 条指令`
                     : `运行中… ${n}M 条指令（内核解压中，第一条串口日志还没出来）`);
  }
  if (now - lastSync > 2000) {
    lastSync = now;
    exportFiles();
    idbOp('meta', 'readwrite', s => s.put(str2bytes(serialLog), 'console'));
    localStorage.setItem('c6sim.insns', String(totalInsns));
  }
  raf = requestAnimationFrame(loop);
}

/* ---------- wasm 网络代理（WebSocket <-> COM2 SLIP） ---------- */
function ensureNetBuf() {
  const need = NET_TX + 65536;
  if (need > wasm.memory.buffer.byteLength) {
    const pages = Math.ceil((need - wasm.memory.buffer.byteLength) / 65536);
    if (wasm.memory.grow(pages) < 0) return false;
  }
  return true;
}

function pumpNet() {
  if (!wasm || !netws || netws.readyState !== 1) return;
  const n = wasm.sim_net_tx(NET_TX, 65536);
  if (n > 0) {
    netws.send(new Uint8Array(wasm.memory.buffer, NET_TX, n).slice());
    netTx += n;
  }
  const now = Date.now();
  if (now - netStatusAt > 300) {
    netStatusAt = now;
    netstatus('已连接 ' + $('proxyurl').value.trim() + ' ↑' + netTx + ' ↓' + netRx + ' B');
  }
}

function disconnectProxy() {
  if (netTimer) { clearInterval(netTimer); netTimer = 0; }
  if (netws) {
    const w = netws;
    netws = null;
    try { w.close(); } catch (e) {}
  }
  netstatus('未连接（可选：只有 guest 要上外网才需要；本机先跑 node tools/ws_slip_proxy.js）');
}

function connectProxy() {
  if (!wasm) { netstatus('请先加载 wasm'); return; }
  if (typeof wasm.sim_net_rx !== 'function') {
    netstatus('这个 sim.wasm 不支持网络代理（需要本仓库重新构建的 wasm）');
    return;
  }
  if (netws) return;
  const url = $('proxyurl').value.trim();
  if (!url) { netstatus('请输入代理地址'); return; }
  if (!ensureNetBuf()) { netstatus('线性内存不足'); return; }
  /* 上游代理/DNS 通过 WS URL 的 query 传给 tools/ws_slip_proxy.js，
   * 再由它拼到 build/sim --netshim 的参数里（NAT 侧拨号 + 解析）。 */
  const upproxy = $('upproxy') ? $('upproxy').value.trim() : '';
  const updns = $('updns') ? $('updns').value.trim() : '';
  const qs = new URLSearchParams();
  if (upproxy) qs.set('proxy', upproxy);
  if (updns) qs.set('dns', updns);
  const target = qs.toString()
    ? url + (url.indexOf('?') >= 0 ? '&' : '?') + qs.toString()
    : url;
  try {
    const w = new WebSocket(target);
    w.binaryType = 'arraybuffer';
    netws = w;
    w.onopen = () => {
      netRx = netTx = 0;
      netstatus('已连接 ' + url + (upproxy ? '（上游 ' + upproxy + '）' : ''));
      netTimer = setInterval(pumpNet, 4);
    };
    w.onmessage = (ev) => {
      if (!wasm || netws !== w) return;
      const b = new Uint8Array(ev.data);
      if (b.length > 65536) return;
      put(NET_RX, b);
      wasm.sim_net_rx(NET_RX, b.length);
      netRx += b.length;
    };
    w.onerror = () => netstatus('连接失败：' + url);
    w.onclose = () => {
      if (netws === w) netws = null;
      if (netTimer) { clearInterval(netTimer); netTimer = 0; }
      netstatus('已断开 ' + url);
    };
  } catch (e) { netstatus('连接失败：' + e.message); }
}

/* ---------- UI ---------- */
$('netconnect').onclick = connectProxy;
$('netdisconnect').onclick = disconnectProxy;
$('clearcache').onclick = async () => {
  if (!confirm('清空缓存的 wasm/固件（页面存储的文件不会删除）并重新加载？')) return;
  try {
    const names = await caches.keys();
    for (const n of names) if (n.indexOf('c6sim') === 0) await caches.delete(n);
    localStorage.removeItem('c6sim.insns');
    status('缓存已清空，正在重新加载…');
    setTimeout(() => location.reload(), 300);
  } catch (e) { status('清空缓存失败：' + e.message); }
};
window.addEventListener('beforeunload', disconnectProxy);
$('load').onclick = loadFirmware;
$('fwfile').onchange = loadFirmwareFile;
$('start').onclick = () => {
  if (!wasm) { status('请先加载 wasm'); return; }
  if (!fwLoaded) {
    status('请先「加载固件」：下拉选内置固件，或选本地 .bin');
    return;
  }
  if (!running) { running = true; setTimeout(() => term.focus(), 0); status('运行中…'); loop(); }
};
$('pause').onclick = () => { running = false; cancelAnimationFrame(raf); status('已暂停'); exportFiles(); };
$('reset').onclick = () => { running = false; cancelAnimationFrame(raf); wasm.sim_reset(); term.reset(); serialLog = ''; sawSerial = false; term.focus(); status('已复位'); };
$('netfetch').onclick = async () => {
  const url = $('neturl').value.trim();
  if (!url) { status('请输入 URL'); return; }
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = new Uint8Array(await resp.arrayBuffer());
    if (data.length > 65536) throw new Error('响应超过 64 KiB 邮箱');
    put(wasm.sim_host_bridge(), data);
    put(SCRATCH + 3 * FS_CAP, str2bytes('__net/last'));
    wasm.sim_hostfs_put(SCRATCH + 3 * FS_CAP, 10, wasm.sim_host_bridge(), data.length);
    wasm.sim_host_event(1, data.length);
    status(`网络响应 ${data.length} 字节已写入 __net/last`);
    exportFiles();
  } catch (e) { status(`fetch 失败：${e.message}`); }
};
$('put').onclick = async () => {
  const name = $('filename').value.trim();
  const data = str2bytes($('filedata').value);
  const p = SCRATCH + 3 * FS_CAP;
  put(p, data);
  const rc = wasm.sim_hostfs_put(p, str2bytes(name).length, p, data.length);
  if (rc !== 0) { $('fileresult').textContent = `put 失败：${rc}`; return; }
  exportFiles();
  $('fileresult').textContent = `已写入 ${name}（${data.length} 字节）`;
};
$('get').onclick = () => {
  const name = $('filename').value.trim();
  const p = SCRATCH + 3 * FS_CAP;
  const n = wasm.sim_hostfs_get(p, str2bytes(name).length, p, FS_CAP);
  $('fileresult').textContent = n < 0 ? `读取失败：${n}` : new TextDecoder().decode(get(p, n));
};

initWasm().catch(e => { status(`初始化失败：${e.message}`); console.error(e); });
