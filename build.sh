#!/bin/sh
# x64simc6 构建入口：native / wasm / fw / test / clean
set -e
ROOT=$(cd "$(dirname "$0")" && pwd)
cd "$ROOT"
C6C=${C6C:-$HOME/c6/c6c/build/c6c}
TCC=${TCC:-$HOME/c6/tcc/c6}
TCCDIR=${TCCDIR:-$HOME/c6/tcc}
WASM_FLAGS=${WASM_FLAGS:-"-Wl,--initial-memory=268435456 -Wl,--max-memory=536870912"}
# wasm 默认走和 native 同一条思路：c6c --emit-ctu 出 C，再交给 clang -O2
# 编成 wasm32，最后 wasm-ld 链接 c6 的 wasm 运行时。实测比 tcc-c6 出码快 20 倍
# 以上（5M 条整机引导 6.55s → 0.29s）。没有 clang/wasm-ld 时自动退回 tcc-c6。
WASM_BACKEND=${WASM_BACKEND:-auto}   # auto | clang | tcc
WASM_CC=${WASM_CC:-clang}
WASM_LD=${WASM_LD:-wasm-ld}
WASM_OPT=${WASM_OPT:--O2}
WASM_CFLAGS=${WASM_CFLAGS:-"-fno-builtin"}
# native 默认走「c6c --emit-ctu 出 C → 系统 cc -O2」的快速构建：
# 同一份 C6 源码，宿主编译器有寄存器分配，整机引导比 c6c 直接出码快 30 倍以上。
# C6_PURE=1 强制回到 c6c 自举路径（不需要系统 cc）。
CC=${CC:-cc}
# 优化级别：-O2 是实测最优（-O3/-march=native/-flto/PGO 都更差或只差 3%，
# 见 DESIGN §84）。要试别的就 OPT="-O3" ./build.sh native。
OPT=${OPT:--O2}
C6_PURE=${C6_PURE:-0}

CORE="src/mem.c6 src/dev.c6 src/fpu.c6 src/cpu.c6 src/boot.c6 src/machine.c6 src/host.c6 src/net.c6"

usage() {
    cat <<'EOF'
用法: ./build.sh [native|wasm|all|fw|test|clean]
  native  生成 build/sim（native CLI，默认用系统 cc 编 --emit-ctu 产物）
  wasm    生成 web/sim.wasm（浏览器用）
  fw      调用 tools/mkfw.py 生成 firmware.bin
  test    跑 c6 test 块与 payload 冒烟
  clean   删除 build/ 与 web/sim.wasm
环境变量:
  C6_PURE=1  跳过快速路径，直接用 c6c 生成 build/sim（自举验证用）
  CC=...     快速路径使用的宿主编译器（默认 cc）
  OPT=...    快速路径的优化选项（默认 -O2）
  C6C=...    c6c 路径
  WASM_BACKEND=auto|clang|tcc  wasm 后端（默认 auto：有 clang+wasm-ld 就 -O2）
  WASM_CC=... / WASM_LD=...    clang / wasm-ld 路径（默认取 PATH）
  WASM_OPT=...                 wasm 优化级别（默认 -O2）
EOF
}

# --emit-ctu 产物是给宿主 cc 的「真 C」，但有两处 c6 运行时的约定要就地改掉：
#   1. c6c 的 <stdio.h> 把 stdin/stdout/stderr 定义成 (FILE *)0/1/2 的魔法指针，
#      c6c 自己的运行时认这三个值，glibc 的 fflush/fwrite 会直接段错误；
#   2. 同一个类型名（FILE）在两边一致，补三条 extern 声明即可让链接期落到 libc。
ctu_fixup() {
    python3 - "$1" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
s = re.sub(r'\(\s*\(\s*FILE\s*\*\s*\)\s*1\s*\)', 'stdout', s)
s = re.sub(r'\(\s*\(\s*FILE\s*\*\s*\)\s*2\s*\)', 'stderr', s)
s = re.sub(r'\(\s*\(\s*FILE\s*\*\s*\)\s*0\s*\)', 'stdin', s)
if 'extern FILE *stdout;' not in s:
    s = s.replace('typedef struct __c6c_FILE FILE;',
                  'typedef struct __c6c_FILE FILE;\n'
                  'extern FILE *stdout; extern FILE *stderr; extern FILE *stdin;', 1)
open(p, 'w').write(s)
PY
}

# 快速路径：每个 TU 各自 --emit-ctu → 宿主 cc -O2 → 一次性链接
native_fast() {
    mkdir -p build/ctu
    for f in $CORE src/main.c6; do
        n=$(basename "$f" .c6)
        "$C6C" --emit-ctu -I src "$f" -o "build/ctu/$n.c"
        ctu_fixup "build/ctu/$n.c"
        "$CC" $OPT -w -c -I src "build/ctu/$n.c" -o "build/ctu/$n.o"
    done
    "$CC" $OPT -o build/sim build/ctu/*.o -lm
    echo "native: build/sim (cc $OPT via --emit-ctu)"
}

native_pure() {
    "$C6C" -DC6_PURE=1 -I src $CORE src/main.c6 -o build/sim
    echo "native: build/sim (c6c 自举)"
}

native() {
    mkdir -p build
    if [ "$C6_PURE" = "1" ] || ! command -v "$CC" >/dev/null 2>&1; then
        native_pure
        return
    fi
    # 探一下 c6c 是否支持 --emit-ctu；不支持就退回自举路径
    if "$C6C" --emit-ctu -I src src/mem.c6 -o build/.ctu_probe.c >/dev/null 2>&1; then
        native_fast
    else
        native_pure
    fi
}

wasm() {
    mkdir -p build web
    WANT_CLANG=0
    if [ "$WASM_BACKEND" != "tcc" ] &&
       command -v "$WASM_CC" >/dev/null 2>&1 &&
       "$WASM_CC" --print-targets 2>/dev/null | grep -q wasm32 &&
       command -v "$WASM_LD" >/dev/null 2>&1 &&
       [ -f "$TCCDIR/libtcc1-wasm32.a" ]; then
        WANT_CLANG=1
    fi
    if [ "$WASM_BACKEND" = "clang" ] && [ "$WANT_CLANG" = "0" ]; then
        echo "wasm: WASM_BACKEND=clang 但缺少 $WASM_CC / $WASM_LD / $TCCDIR/libtcc1-wasm32.a" >&2
        exit 1
    fi
    if [ "$WANT_CLANG" = "1" ]; then
        rm -rf build/ctu-wasm
        mkdir -p build/ctu-wasm
        for f in $CORE src/hostfs.c6 src/wasm.c6; do
            b=$(basename "$f" .c6)
            "$C6C" --emit-ctu -D C6_WASM=1 -I src "$f" -o "build/ctu-wasm/$b.c"
            "$WASM_CC" --target=wasm32-unknown-unknown $WASM_CFLAGS "$WASM_OPT" \
                -c "build/ctu-wasm/$b.c" -o "build/ctu-wasm/$b.o"
        done
        "$WASM_LD" --no-entry --export-all \
            --initial-memory=268435456 --max-memory=536870912 \
            -o web/sim.wasm build/ctu-wasm/*.o "$TCCDIR/libtcc1-wasm32.a"
        echo "wasm: web/sim.wasm ($(wc -c < web/sim.wasm) bytes, $WASM_CC $WASM_OPT)"
    else
        TCC_CCFLAGS="$WASM_FLAGS" "$TCC" -B "$TCCDIR" -DC6_WASM=1 -I src --target=wasm32-unknown-unknown \
            -o web/sim.wasm $CORE src/hostfs.c6 src/wasm.c6
        echo "wasm: web/sim.wasm ($(wc -c < web/sim.wasm) bytes, tcc-c6)"
    fi
}

fw() {
    # build/alpine 里有从 Alpine apk 解出来的内核模块树时，默认注入 slip/slhc，
    # 让 firmware.bin 一启动就带用户态外网；用户显式给了 --modules 就不干预。
    MODARG=""
    if [ -d build/alpine/lib/modules ]; then
        case " $* " in
        *" --modules "*) ;;
        *) MODARG="--modules build/alpine/lib" ;;
        esac
    fi
    python3 tools/mkfw.py "$@" $MODARG
}

test_all() {
    native
    python3 tools/hello64.py build/hello64.bin
    ./build/sim --payload build/hello64.bin > build/payload.out
    grep -q 'C6SIM64 OK' build/payload.out
    echo "test: payload smoke OK"
    for t in tests/test_cpu.c6 tests/test_cpl3.c6 tests/test_pcache.c6; do
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