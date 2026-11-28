#!/usr/bin/env python3
"""把 c6os（~/rtos-c6）的 x86-64 内核 + Alpine initramfs 打成 C6FW v2 固件。

C6FW v2 布局（和 v1 的 Linux 固件同一个 64 字节头，只换 version）：

    +0   'C6FW'
    +4   u32 version = 2
    +8   u32 hdr size = 64
    +12  u32 保留
    +16  u32 kernel_off   ┐ kernel  槽：链接在 0x11000 的平铺镜像
    +20  u32 kernel_len   ┘ （c6os 的 build/x86/iso/stage2.bin）
    +24  u32 rootfs_off   ┐ rootfs  槽：8 字节长度 + 512 填充 + newc cpio
    +28  u32 rootfs_len   ┘ （c6os 的 build/x86/alpine/full.cpio）
    +32  u32 data_off     ┐ data    槽：/data 的 8MiB FAT16 镜像
    +36  u32 data_len     ┘ （c6os 的 build/x86/alpine/data.img，ATA PIO 主盘）

v2 把 v1 的 cmdline 槽（+32/+36）借给了 /data 镜像；没有它 c6os 的
Alpine 例程会停在 "/data 挂载 rc=22"，所以默认带上。

x64simc6 在 native（--fw）和浏览器（sim_init）里都按 version 分派：v2 走
machine_boot_c6os()，把内核装到 0x11000、rootfs 装到 0x800000，并写好 c6os
要的 E820 表（0x5000）和引导信息块（0x7000）。

用法：
    python3 tools/mkc6os.py
    python3 tools/mkc6os.py --kernel .../stage2.bin --rootfs .../full.cpio -o build/c6os.bin
"""
import argparse
import os
import struct
import sys

MAGIC = b'C6FW'
VERSION = 2
HDR = 64
KERNEL_PA = 0x11000
KERNEL_MAX = 0xA0000 - KERNEL_PA      # 内核链接脚本的 VGA/BIOS 空洞上界
ROOTFS_PA = 0x800000
RAM_TOP = 0x08000000                  # 和 src/c6sim.h 的 RAM_SIZE 一致
ATA_DATA_SIZE = 8 << 20               # /data 的 ATA 主盘固定 8MiB


def main():
    home = os.path.expanduser('~')
    default_rtos = os.environ.get('RTOS_C6', os.path.join(home, 'rtos-c6'))
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--kernel', default=os.path.join(default_rtos, 'build/x86/iso/stage2.bin'),
                    help='c6os stage2.bin（默认 %(default)s）')
    ap.add_argument('--rootfs', default=os.path.join(default_rtos, 'build/x86/alpine/full.cpio'),
                    help='Alpine full.cpio（默认 %(default)s）')
    ap.add_argument('--data', default=os.path.join(default_rtos, 'build/x86/alpine/data.img'),
                    help='c6os 的 /data FAT16 镜像（默认 %(default)s）')
    ap.add_argument('--no-data', action='store_true',
                    help='不打包 /data 镜像（Alpine 例程会停在 /data 挂载失败）')
    ap.add_argument('-o', '--out', default='build/c6os.bin',
                    help='输出固件（默认 %(default)s）')
    args = ap.parse_args()

    if not os.path.exists(args.kernel):
        sys.exit(f'mkc6os: 找不到内核 {args.kernel}\n'
                 f'  先在 rtos-c6 里构建：make x86-alpine（或 check-linuxabi-all）')
    if not os.path.exists(args.rootfs):
        sys.exit(f'mkc6os: 找不到 rootfs {args.rootfs}\n'
                 f'  先在 rtos-c6 里构建：make x86-alpine')

    kernel = open(args.kernel, 'rb').read()
    rootfs = open(args.rootfs, 'rb').read()
    data = b''
    if not args.no_data:
        if not os.path.exists(args.data):
            sys.exit(f'mkc6os: 找不到 /data 镜像 {args.data}（或加 --no-data）')
        data = open(args.data, 'rb').read()
        if len(data) > ATA_DATA_SIZE:
            sys.exit(f'mkc6os: /data 镜像 {len(data)} 字节超过 8MiB')
        data = data.ljust(ATA_DATA_SIZE, b'\0')      # 主盘固定 8MiB
    if len(kernel) > KERNEL_MAX:
        sys.exit(f'mkc6os: 内核 {len(kernel)} 字节超过链接上界 {KERNEL_MAX}'
                 f'（c6os 内核必须整体落在 0x11000..0xA0000）')
    if len(rootfs) < 1024 or rootfs[512:518] != b'070701':
        sys.exit('mkc6os: rootfs 不是 c6os 的「8 字节长度 + 512 填充 + cpio」格式')
    plen = int.from_bytes(rootfs[:8], 'little')
    if plen != len(rootfs) - 512:
        sys.exit(f'mkc6os: rootfs 长度前缀 {plen} 与文件大小 {len(rootfs)} - 512 不符')

    ko = HDR
    io = ko + len(kernel)
    do = io + len(rootfs)
    hdr = bytearray(HDR)
    hdr[0:4] = MAGIC
    # 和 tools/mkfw.py 相同的字段顺序：version, hdr, 保留, ko, klen, io, ilen,
    # 然后是 v2 的 data_off/data_len（v1 的 cmdline 槽）
    struct.pack_into('<IIIIIIII', hdr, 4, VERSION, HDR, 0,
                     ko, len(kernel), io, len(rootfs), do)
    struct.pack_into('<I', hdr, 36, len(data))

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'wb') as f:
        f.write(hdr)
        f.write(kernel)
        f.write(rootfs)
        f.write(data)

    total = len(hdr) + len(kernel) + len(rootfs) + len(data)
    print(f'mkc6os: {args.out} = {total} 字节')
    print(f'  kernel: off={ko} len={len(kernel)} -> 0x{KERNEL_PA:05x}')
    print(f'  rootfs: off={io} len={len(rootfs)} -> 0x{ROOTFS_PA:06x}'
          f'（cpio {plen} 字节）')
    if data:
        print(f'  data:   off={do} len={len(data)} -> ATA 主盘（/data FAT16）')
    else:
        print('  data:   无（/data 不会挂载）')


if __name__ == '__main__':
    main()
