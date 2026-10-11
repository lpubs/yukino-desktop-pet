# -*- coding: utf-8 -*-
"""扫描"素材高该定多少"：把每个候选目标都还原成桌面端实际看到的那一帧再比。

判据只有一条，而且必须按**实际显示条件**算：
  桌宠在中档缩放下显示高 400 CSS px，2× HiDPI 屏上 = 800 设备像素。
  所以任意候选高 H 的素材，最终都会被拉到 800 再显示：
    H < 800 -> 浏览器插值放大（糊）
    H = 800 -> 1:1
    H > 800 -> 浏览器降采样（清晰度到顶，只是白占体积）
  于是"哪个 H 最好"= 在 H ≤ 源可用高 的前提下，谁的显示锐度最高。

本脚本对每套装备遍历候选高，报告显示锐度与文件体积，供定档。
不写 assets/，纯测量。

用法：python tools/scan_target.py
"""
import os
import struct

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
NATIVE = os.path.join(ROOT, "_review", "native")

DEVICE_H = 800
CANDIDATES = [560, 700, 760, 790, 800, 900, 1000]


def grad(im):
    a = np.asarray(im.convert("L"), dtype=np.float32)
    gx = np.diff(a, axis=1)
    gy = np.diff(a, axis=0)
    return float(np.sqrt((gx ** 2).mean() + (gy ** 2).mean()))


def to_h(img, h):
    w, oh = img.size
    sc = h / oh
    return img.resize((max(1, round(w * sc)), h), Image.LANCZOS)


def main():
    print("显示锐度（头部区域梯度能量）。每行的素材都会被拉到 %d 高再测 —— 与实际显示一致。" % DEVICE_H)
    print("  %-8s %s" % ("素材", "  ".join("%6d" % c for c in CANDIDATES)))
    avail = {}
    for n in ["maid", "sailor", "coat", "winter"]:
        nat = Image.open(os.path.join(NATIVE, n + ".png")).convert("RGBA")
        avail[n] = nat.size[1]
        row = []
        for c in CANDIDATES:
            shown = to_h(to_h(nat, c), DEVICE_H)
            row.append(grad(shown))
        print("  %-8s %s" % (n, "  ".join("%6.1f" % v for v in row)))

    print("\n  %-8s %s" % ("源可用高", "  ".join("%6d" % avail[n] for n in ["maid", "sailor", "coat", "winter"])))

    print("\n文件体积（KB，PNG）。左半是全部装备之和，右边看单套。")
    print("  %6s %10s   %s" % ("目标高", "四套合计", "  ".join("%7s" % n for n in ["maid", "sailor", "coat", "winter"])))
    for c in CANDIDATES:
        tot = 0
        cells = []
        for n in ["maid", "sailor", "coat", "winter"]:
            nat = Image.open(os.path.join(NATIVE, n + ".png")).convert("RGBA")
            h = min(c, avail[n])
            up = to_h(nat, h)
            p = os.path.join(ROOT, "_review", "_scan_%s_%d.png" % (n, h))
            up.save(p)
            kb = os.path.getsize(p) / 1024
            os.remove(p)
            tot += kb
            cells.append("%7.0f" % kb)
        print("  %6d %10.0f   %s" % (c, tot, "  ".join(cells)))

    print("\n注：'目标高' 超过某套的源可用高时，那一套实际按源可用高输出（min），不会插值放大。")


if __name__ == "__main__":
    main()
