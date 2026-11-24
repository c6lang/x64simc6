#!/bin/sh
# x64simc6 构建入口：native / wasm / fw / test / clean
set -e
ROOT=$(cd "$(dirname "$0")" && pwd)
cd "$ROOT"
C6C=${C6C:-$HOME/c6/c6c/build/c6c}
TCC=${TCC:-$HOME/c6/tcc/c6}
TCCDIR=${TCCDIR:-$HOME/c6/tcc}
WASM_FLAGS=${WASM_FLAGS:-"-Wl,--initial-memory=268435456 -Wl,--max-memory=536870912"}

CORE="src/mem.c6 src/dev.c6 src/cpu.c6 src/boot.c6 src/machine.c6 src/host.c6"

usage() {
    cat <<'EOF'
用法: ./build.sh [native|wasm|all|fw|test|clean]
  native  生成 build/sim（native CLI）
  wasm    生成 web/sim.wasm（浏览器用）
  fw      调用 tools/mkfw.py 生成 firmware.bin
  test    跑 c6 test 块与 payload 冒烟
  clean   删除 build/ 与 web/sim.wasm
EOF
}

native() {
    mkdir -p build
    "$C6C" -I src $CORE src/main.c6 -o build/sim
    echo "native: build/sim"
}

wasm() {
    mkdir -p build web
    TCC_CCFLAGS="$WASM_FLAGS" "$TCC" -B "$TCCDIR" -DC6_WASM=1 -I src --target=wasm32-unknown-unknown \
        -o web/sim.wasm $CORE src/hostfs.c6 src/wasm.c6
    echo "wasm: web/sim.wasm ($(wc -c < web/sim.wasm) bytes)"
}

fw() {
    python3 tools/mkfw.py "$@"
}

test_all() {
    native
    python3 tools/hello64.py build/hello64.bin
    ./build/sim --payload build/hello64.bin > build/payload.out
    grep -q 'C6SIM64 OK' build/payload.out
    echo "test: payload smoke OK"
    for t in tests/test_cpu.c6 tests/test_cpl3.c6; do
        if [ -f "$t" ]; then
            "$C6C" -I src $CORE src/hostfs.c6 "$t" -o "build/$(basename "$t" .c6)" >/dev/null
            "./build/$(basename "$t" .c6)"
        fi
    done
    wasm
    node tests/wasm_smoke.js web/sim.wasm build/hello64.bin
}

case ${1:-all} in
native) native ;;
wasm) wasm ;;
all) native; wasm ;;
fw) shift; fw "$@" ;;
test) test_all ;;
clean) rm -rf build web/sim.wasm; echo "cleaned" ;;
-h|--help|help) usage ;;
*) echo "unknown target: $1" >&2; usage; exit 2 ;;
esac
