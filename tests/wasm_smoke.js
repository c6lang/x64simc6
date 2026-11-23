// wasm 冒烟：把 payload 写进线性内存，驱动模拟器并读回串口输出
const fs = require('fs');
const path = require('path');

const wasmPath = process.argv[2] || 'web/sim.wasm';
const payloadPath = process.argv[3] || 'build/hello64.bin';

(async () => {
    const buf = fs.readFileSync(wasmPath);
    if (!WebAssembly.validate(buf)) throw new Error('wasm 校验失败');
    const inst = new WebAssembly.Instance(new WebAssembly.Module(buf), {});
    const ex = inst.exports;
    if (ex.__wasm_call_ctors) ex.__wasm_call_ctors();

    const payload = fs.readFileSync(payloadPath);
    const CODE = 0x08000000;
    const OUT = 0x08010000;
    const mem = new Uint8Array(ex.memory.buffer);
    mem.set(payload, CODE);

    const rc = ex.sim_load_payload(CODE, payload.length);
    if (rc !== 0) throw new Error('sim_load_payload failed: ' + rc);

    for (let i = 0; i < 100; i++) {
        if (ex.sim_status()) break;
        ex.sim_run(1000);
    }
    const n = ex.sim_serial_out(OUT, 8192);
    const text = new TextDecoder().decode(new Uint8Array(ex.memory.buffer, OUT, n));
    process.stdout.write(text);
    console.log('\n[wasm] instructions=' + Number(ex.sim_stat_insns()));
    if (ex.__c6_wasm_con_ptr && ex.__c6_wasm_con_len) {
        const p = Number(ex.__c6_wasm_con_ptr());
        const n2 = Number(ex.__c6_wasm_con_len());
        console.log('[wasm console] ' +
            new TextDecoder().decode(new Uint8Array(ex.memory.buffer, p, n2)));
    }
    if (!text.includes('C6SIM64 OK')) {
        console.error('[wasm] payload smoke FAILED');
        process.exit(1);
    }
    console.log('[wasm] payload smoke OK');
})().catch(e => { console.error(e); process.exit(1); });
