#!/usr/bin/env python3
"""把 bzImage + Alpine minirootfs 打成 C6FW 固件。"""
import argparse, gzip, lzma, os, shutil, struct, subprocess, sys, tarfile, tempfile, zlib

MAGIC = b'C6FW'
VERSION = 1
HDR = 64

def extract_vmlinux(bz):
    data = open(bz, 'rb').read()
    # 常见 bzImage 负载：gzip / xz / zstd(lzma 不认 zstd，此处只处理前两者)
    for magic, dec in ((b'\xfd7zXZ\x00', lambda d: lzma.decompress(d)),
                       (b'\x1f\x8b\x08', lambda d: zlib.decompressobj(31).decompress(d))):
        start = 0
        while True:
            i = data.find(magic, start)
            if i < 0:
                break
            try:
                out = dec(data[i:])
                if out[:4] == b'\x7fELF':
                    phoff = int.from_bytes(out[32:40], 'little')
                    phentsize = int.from_bytes(out[54:56], 'little')
                    phnum = int.from_bytes(out[56:58], 'little')
                    segs = []
                    for n in range(phnum):
                        ph = out[phoff + n * phentsize: phoff + (n + 1) * phentsize]
                        if len(ph) < 56 or int.from_bytes(ph[:4], 'little') != 1:
                            continue
                        off = int.from_bytes(ph[8:16], 'little')
                        paddr = int.from_bytes(ph[24:32], 'little')
                        filesz = int.from_bytes(ph[32:40], 'little')
                        segs.append((paddr, filesz, off))
                    if not segs:
                        break
                    base = min(p for p, _, _ in segs)
                    size = max(p + n for p, n, _ in segs) - base
                    img = bytearray(size)
                    for paddr, filesz, off in segs:
                        img[paddr - base:paddr - base + filesz] = out[off:off + filesz]
                    return (bytes(img), base)
                elif len(out) > 0x100000:
                    return (out, 0x100000)
            except Exception:
                pass
            start = i + 1
    raise SystemExit('mkfw: cannot extract vmlinux payload')

def make_initrd(tar_path):
    root = tempfile.mkdtemp(prefix='c6sim-initrd-')
    with tarfile.open(tar_path, 'r:gz') as t:
        t.extractall(root, filter=lambda ti, path: ti)
    # 串口登录：busybox inittab 默认只有 tty1，补一行 ttyS0
    init_file = os.path.join(root, 'init')
    with open(init_file, 'w') as f:
        f.write('#!/bin/sh\n')
        f.write('mount -t proc none /proc 2>/dev/null\n')
        f.write('mount -t sysfs none /sys 2>/dev/null\n')
        f.write('[ -r /etc/inittab ] || printf \'ttyS0::respawn:/sbin/getty -L 115200 ttyS0 vt100\' >> /etc/inittab\n')
        f.write('grep -q ttyS0 /etc/inittab || echo \'ttyS0::respawn:/sbin/getty -L 115200 ttyS0 vt100\' >> /etc/inittab\n')
        f.write('exec /sbin/init\n')
    os.chmod(init_file, 0o755)
    out = root + '.cpio.gz'
    with open(out, 'wb') as f:
        p = subprocess.run(['sh', '-c', 'find . -print0 | cpio --null -o -H newc --quiet'],
                           cwd=root, stdout=subprocess.PIPE, check=True)
        f.write(gzip.compress(p.stdout, mtime=0))
    shutil.rmtree(root)
    return open(out, 'rb').read()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--kernel', required=True, help='bzImage (vmlinuz)')
    ap.add_argument('--initrd', help='Alpine minirootfs tar.gz')
    ap.add_argument('--cmdline', default='console=ttyS0,115200 earlyprintk=ttyS0,115200 panic=-1')
    ap.add_argument('--out', default='build/firmware.bin')
    a = ap.parse_args()
    kernel, kpaddr = extract_vmlinux(a.kernel)
    if kpaddr != 0x01000000:
        print('mkfw: warning: kernel load paddr=0x%x (expected 0x01000000)' % kpaddr, file=sys.stderr)
    initrd = make_initrd(a.initrd) if a.initrd else b''
    cmd = a.cmdline.encode()
    off = HDR
    blobs = []
    def put(b):
        nonlocal off
        o = off
        blobs.append(b)
        off += len(b)
        return o
    ko, io, co = put(kernel), put(initrd), put(cmd)
    hdr = bytearray(HDR)
    hdr[0:4] = MAGIC
    struct.pack_into('<IIIIIIII', hdr, 4, VERSION, HDR, 0, ko, len(kernel), io, len(initrd), co)
    struct.pack_into('<I', hdr, 36, len(cmd))
    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
    with open(a.out, 'wb') as f:
        f.write(hdr)
        for b in blobs:
            f.write(b)
    print('mkfw: %s kernel=%d initrd=%d cmdline=%s' % (a.out, len(kernel), len(initrd), a.cmdline))

if __name__ == '__main__':
    main()
