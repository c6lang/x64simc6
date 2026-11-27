/* c6simc6 浏览器前端：真实 fetch + Cache Storage + IndexedDB 文件表/快照。
 * 与 wasm 之间只通过导出的 C 函数 + 共享线性内存通信，不依赖 wasm import。 */
const $ = (id) => document.getElementById(id);
const status = (s) => { $('status').textContent = s; };
const SCRATCH = 0x0f800000;   // 248 MiB：hostfs/串口的小缓冲（初始 256 MiB 内）
const FW_STAGE = 0x10000000;  // 256 MiB：大固件 staging；不够就先把内存扩到 512 MiB
const FW_MAX = 48 << 20;      // 与 src/wasm.c6 的 g_fw_stage 一致
const FS_CAP = 1 << 20;

let wasm = null;
let mem = null;
let db = null;
let running = false;
let raf = 0;
let totalInsns = 0;
let lastSync = 0;

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

/* ---------- 初始化 ---------- */
async function initWasm() {
  status('加载 wasm…');
  const bytesWasm = await fetchAsset('sim.wasm');
  const module = await WebAssembly.compile(bytesWasm);
  const inst = await WebAssembly.instantiate(module, {});
  wasm = inst.exports;
  mem = wasm.memory;
  db = await openDB();
  const files = await idbOp('files', 'readonly', s => s.getAll());
  const keys = await idbOp('files', 'readonly', s => s.getAllKeys());
  const pairs = keys.map((k, i) => [String(k), new Uint8Array(files[i])]);
  importFiles(pairs);
  const log = await idbOp('meta', 'readonly', s => s.get('console'));
  if (log) $('console').textContent = new TextDecoder().decode(log);
  status('wasm 已就绪，IndexedDB 文件已导入');
}

async function loadFirmware() {
  if (!wasm) { status('请先加载 wasm'); return; }
  const url = $('fwurl').value.trim();
  try {
    const fw = await fetchAsset(url);
    if (fw.length > FW_MAX) throw new Error(`固件超过 ${FW_MAX >> 20} MiB staging 上限`);
    const need = FW_STAGE + fw.length;
    if (need > wasm.memory.buffer.byteLength) {
      const pages = Math.ceil((need - wasm.memory.buffer.byteLength) / 65536);
      if (wasm.memory.grow(pages) < 0)
        throw new Error(`内存不足：固件需要 ${need} 字节线性内存`);
      mem = wasm.memory;
    }
    put(FW_STAGE, fw);
    const rc = wasm.sim_init(FW_STAGE, fw.length);
    if (rc !== 0) throw new Error(`sim_init 返回 ${rc}`);
    $('console').textContent = '';
    status(`固件已加载：${fw.length} 字节`);
  } catch (e) { status(`固件加载失败：${e.message}`); }
}

function pumpSerial() {
  const cap = 65536;
  const p = SCRATCH + 2 * FS_CAP;
  const n = wasm.sim_serial_out(p, cap);
  if (n > 0) {
    const el = $('console');
    el.textContent += new TextDecoder().decode(get(p, n));
    el.scrollTop = el.scrollHeight;
  }
}

function loop() {
  if (!running) return;
  const before = Number(wasm.sim_stat_insns());
  // 按时间预算跑：固定 20000 条/帧会把 wasm 限制在 ~1.2M 条/秒，
  // 白白浪费 clang -O2 的 15M 条/秒。每帧最多占 12ms，UI 仍可交互。
  const t0 = performance.now();
  do {
    wasm.sim_run(100000);
    if (wasm.sim_status() !== 0) break;
  } while (performance.now() - t0 < 12);
  totalInsns = Number(wasm.sim_stat_insns());
  pumpSerial();
  if (totalInsns - before === 0 || wasm.sim_status() !== 0) {
    running = false;
    status(`停机，共执行 ${totalInsns} 条指令`);
    exportFiles();
    return;
  }
  const now = Date.now();
  if (now - lastSync > 2000) {
    lastSync = now;
    exportFiles();
    idbOp('meta', 'readwrite', s => s.put(str2bytes($('console').textContent), 'console'));
    localStorage.setItem('c6sim.insns', String(totalInsns));
  }
  raf = requestAnimationFrame(loop);
}

/* ---------- UI ---------- */
$('load').onclick = loadFirmware;
$('start').onclick = () => {
  if (!wasm) { status('请先加载 wasm'); return; }
  if (!running) { running = true; status('运行中…'); loop(); }
};
$('pause').onclick = () => { running = false; cancelAnimationFrame(raf); status('已暂停'); exportFiles(); };
$('reset').onclick = () => { running = false; wasm.sim_reset(); $('console').textContent = ''; status('已复位'); };
$('send').onclick = () => {
  const data = str2bytes($('input').value + '\n');
  put(wasm.sim_host_bridge(), data);
  wasm.sim_host_event(3, data.length);
  $('input').value = '';
};
$('input').addEventListener('keydown', e => { if (e.key === 'Enter') $('send').click(); });
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
