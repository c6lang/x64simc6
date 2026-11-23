#!/usr/bin/env python3
"""生成 64 位手汇编 payload：往 16550 串口打印字符串，再写 debug 端口退出。

用法：python3 tools/hello64.py build/hello64.bin ["文本"]
"""
import sys


def mov_edx_imm32(port: int) -> bytes:
    return b"\xba" + port.to_bytes(4, "little")       # mov edx, imm32


def mov_al_imm8(value: int) -> bytes:
    return b"\xb0" + bytes([value])                   # mov al, imm8


def out_al_dx() -> bytes:
    return b"\xee"                                    # out dx, al


def build(text: bytes) -> bytes:
    code = bytearray()
    code += mov_edx_imm32(0x3F8)
    for ch in text:
        code += mov_al_imm8(ch)
        code += out_al_dx()
    code += mov_edx_imm32(0xF4)
    code += mov_al_imm8(0)
    code += out_al_dx()
    code += b"\xf4"                                   # hlt
    return bytes(code)


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "build/hello64.bin"
    msg = sys.argv[2].encode() if len(sys.argv) > 2 else b"C6SIM64 OK\n"
    data = build(msg)
    with open(out, "wb") as f:
        f.write(data)
    print(f"wrote {out}: {len(data)} bytes")
