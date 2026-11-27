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

SLIP_MODULES = [
    'kernel/drivers/net/slip/slhc.ko.gz',
    'kernel/drivers/net/slip/slip.ko.gz',
]


def find_modules_tree(path):
    """--modules 可以指向 .../lib、.../lib/modules 或 .../lib/modules/<kver>。

    返回 (模块根目录, 内核版本)，例如 (.. /lib/modules/6.6.142-0-lts,
    '6.6.142-0-lts')；找不到返回 (None, None)。
    """
    for base, dirs, files in os.walk(path):
        if os.path.basename(base) == 'kernel':
            kver = os.path.basename(os.path.dirname(base))
            if os.path.isdir(os.path.join(base, 'drivers')):
                return os.path.dirname(base), kver
        if base.count(os.sep) - path.count(os.sep) > 4:
            dirs[:] = []
    return None, None


def install_slip_modules(root, modules_dir):
    """把 slip.ko / slhc.ko 解压后放进 initramfs 的 /lib/modules/<kver>。"""
    modbase, kver = find_modules_tree(modules_dir)
    if modbase is None:
        raise SystemExit('mkfw: --modules 下没找到 <kver>/kernel/…')
    got = []
    for rel in SLIP_MODULES:
        src = os.path.join(modbase, rel)
        if not os.path.exists(src):
            continue
        dst = os.path.join(root, 'lib', 'modules', kver, rel)
        if dst.endswith('.gz'):
            dst = dst[:-3]
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if src.endswith('.gz'):
            with gzip.open(src, 'rb') as fi, open(dst, 'wb') as fo:
                shutil.copyfileobj(fi, fo)
        else:
            shutil.copyfile(src, dst)
        got.append(os.path.basename(dst))
    if 'slip.ko' not in got:
        raise SystemExit('mkfw: --modules 里缺少 slip.ko')
    return kver


def make_initrd(tar_path, modules_dir=None):
    root = tempfile.mkdtemp(prefix='c6sim-initrd-')
    with tarfile.open(tar_path, 'r:gz') as t:
        t.extractall(root, filter=lambda ti, path: ti)
    kver = install_slip_modules(root, modules_dir) if modules_dir else None
    # 串口登录：busybox inittab 默认只有 tty1，补一行 ttyS0
    init_file = os.path.join(root, 'init')
    with open(init_file, 'w') as f:
        f.write('#!/bin/sh\n')
        f.write('mount -t proc none /proc 2>/dev/null\n')
        f.write('mount -t sysfs none /sys 2>/dev/null\n')
        # /dev 必须是 devtmpfs，否则 getty/login 打不开 /dev/ttyS0
        f.write('mkdir -p /dev\n')
        f.write('mount -t devtmpfs dev /dev 2>/dev/null\n')
        if kver:
            # 用户态外网：第二串口 ttyS1 跑 SLIP，模拟器侧是用户态 NAT。
            # 地址沿用 QEMU user networking：guest 10.0.2.15 / peer 10.0.2.2 /
            # DNS 10.0.2.3；不依赖 tap、不需要 root。
            f.write('K=/lib/modules/%s\n' % kver)
            f.write('insmod "$K/kernel/drivers/net/slip/slhc.ko" 2>/dev/null\n')
            f.write('insmod "$K/kernel/drivers/net/slip/slip.ko" 2>/dev/null\n')
            f.write('if [ -c /dev/ttyS1 ] && [ -x /sbin/slattach ]; then\n')
            f.write('  slattach -p slip -s 115200 /dev/ttyS1 2>/dev/null &\n')
            f.write('  i=0\n')
            f.write('  while [ $i -lt 50 ] && [ ! -e /sys/class/net/sl0 ]; do\n')
            f.write('    sleep 0.1; i=$((i+1))\n')
            f.write('  done\n')
            f.write('  ifconfig sl0 10.0.2.15 pointopoint 10.0.2.2 mtu 1500 up 2>/dev/null\n')
            f.write('  route add default gw 10.0.2.2 2>/dev/null\n')
            f.write('  echo "nameserver 10.0.2.3" > /etc/resolv.conf\n')
            f.write('fi\n')
        # minirootfs 里没有 /sbin/getty、也没有 /sbin/openrc，只有 /bin/login；
        # 而且 Alpine 的 inittab 里 ttyS0 那行默认是注释的。这里直接改写成 login。
        f.write('L=\'ttyS0::respawn:-/bin/login\'\n')
        f.write('if [ -r /etc/inittab ]; then\n')
        f.write('  sed -i \'/ttyS0::respawn/d\' /etc/inittab\n')
        f.write('  echo "$L" >> /etc/inittab\n')
        f.write('else\n')
        f.write('  echo "$L" > /etc/inittab\n')
        f.write('fi\n')
        # root 无密码，方便自动登录验收
        f.write('sed -i \'s/^root:[^:]*:/root::/\' /etc/passwd 2>/dev/null\n')
        f.write('sed -i \'s/^root:[^:]*:/root::/\' /etc/shadow 2>/dev/null\n')
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
    ap.add_argument('--raw-initrd', action='store_true',
                    help='initrd 已经是 cpio.gz，原样打包（不再注入 /init）')
    ap.add_argument('--modules',
                    help='内核模块树（build/alpine/lib 或 lib/modules/<kver>），'
                         '注入 slip/slhc 并自动配置外网')
    ap.add_argument('--cmdline', default='console=ttyS0,115200 earlyprintk=ttyS0,115200 panic=-1')
    ap.add_argument('--out', default='build/firmware.bin')
    a = ap.parse_args()
    kernel, kpaddr = extract_vmlinux(a.kernel)
    if kpaddr != 0x01000000:
        print('mkfw: warning: kernel load paddr=0x%x (expected 0x01000000)' % kpaddr, file=sys.stderr)
    if not a.initrd:
        initrd = b''
    elif a.raw_initrd:
        initrd = open(a.initrd, 'rb').read()
    else:
        if a.modules:
            print('mkfw: 注入 SLIP 模块：%s' % a.modules)
        else:
            print('mkfw: 未指定 --modules，guest 将没有外网（只有串口 shell）',
                  file=sys.stderr)
        initrd = make_initrd(a.initrd, a.modules)
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
