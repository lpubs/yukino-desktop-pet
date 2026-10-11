# -*- coding: utf-8 -*-
"""重制前后对照：把桌面端实际会看到的那一帧摆出来比。

判据必须按**实际显示条件**算，否则会得出错误结论：
  桌宠中档缩放的显示高是 400 CSS px；在 2× HiDPI 屏上，这 400 CSS px
  落到 800 个**设备像素**上。所以：

    旧素材 560 高 -> 被浏览器放大 1.43 倍（插值，发糊）
    重制后 800 高 -> 1:1
    重制后 762/790 高 -> 放大 1.05 / 1.01 倍（几乎无损）

  "旧的 560 素材"现在可以**精确重建**：旧流水线就是 "原生抠图 -> LANCZOS 缩到 560"，
  而原生图留在 _review/native/ 里。重建结果与旧素材逐像素一致
  （981x1009 -> 高 560 得宽 544，正是旧 maid.png 的尺寸）。

用法：python tools/build_assets.py 之后运行本脚本
     python tools/review_upscale.py
"""
import os

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REVIEW = os.path.join(ROOT, "_review")
NATIVE = os.path.join(REVIEW, "native")
SPRITES = os.path.join(ROOT, "assets", "sprites")

DEVICE_H = 800          # 2× 屏 × 中档（400 CSS px）的设备像素高
HEAD_RATIO = 0.30       # 只看头部：糊不糊在脸上最明显
ZOOM = 1.5


def to_h(img, h):
    w, oh = img.size
    sc = h / oh
    return img.resize((max(1, round(w * sc)), h), Image.LANCZOS)


def head(img, target_h):
    r = to_h(img, target_h)
    return r.crop((0, 0, r.size[0], max(1, round(target_h * HEAD_RATIO))))


def grad(im):
    """对比度无关的锐度：梯度能量 / 亮度标准差。

    为什么必须归一化：直接用梯度能量会被**对比度**骗。实测冬装重制后
    梯度能量"下降 3%"，看起来像重制变差 —— 实际是色调统一把黑场从 6.2 抬到 11.8，
    整体对比度降了，于是梯度能量跟着降。这是测出来的假象，不是画质退化。
    除以标准差之后，这个数只反映"单位对比度里有多少高频细节"，
    也就是真正想测的锐度。
    """
    a = np.asarray(im.convert("L"), dtype=np.float32)
    g = np.sqrt((np.diff(a, axis=1) ** 2).mean() + (np.diff(a, axis=0) ** 2).mean())
    s = max(float(a.std()), 1e-3)
    return float(g / s)


def main():
    names = ["maid", "sailor", "coat", "winter"]
    old, new, pre = {}, {}, {}
    for n in names:
        nat = Image.open(os.path.join(NATIVE, n + ".png")).convert("RGBA")
        old[n] = to_h(nat, 560)                                   # 精确重建旧素材
        pre[n] = Image.open(os.path.join(REVIEW, "hires", n + ".png")).convert("RGBA")
        new[n] = Image.open(os.path.join(SPRITES, n + ".png")).convert("RGBA")

    print("已发布的素材尺寸")
    for n in names:
        print("  %-8s 旧 %dx%-4d -> 新 %dx%-4d   %6.1fKB" % (
            n, old[n].size[0], old[n].size[1], new[n].size[0], new[n].size[1],
            os.path.getsize(os.path.join(SPRITES, n + ".png")) / 1024))

    # 两件事分开测。它们的判据不同，混在一起就分不清是谁的功劳。
    #   分辨率：都在**统一色调之前**（旧 560 vs hires）—— 只差采样率
    #   色调  ：都在**同一分辨率**（hires vs 落地素材）—— 只差色阶
    print("\n① 分辨率增益（均在色调统一前；素材拉到 %d 高再测）" % DEVICE_H)
    print("  %-8s %10s %10s   %s" % ("素材", "旧 560", "用满源", "增益"))
    for n in names:
        g0, g1 = grad(head(old[n], DEVICE_H)), grad(head(pre[n], DEVICE_H))
        print("  %-8s %10.4f %10.4f   %+.0f%%" % (n, g0, g1, (g1 / g0 - 1) * 100))

    print("\n② 色调统一的影响（同分辨率；顺带看整体亮度中位数）")
    print("  %-8s %10s %10s   %8s" % ("素材", "统一前", "统一后", "p50"))
    for n in names:
        g0, g1 = grad(head(pre[n], DEVICE_H)), grad(head(new[n], DEVICE_H))
        s0 = np.percentile(np.asarray(pre[n].convert("L"))[np.asarray(pre[n])[:, :, 3] > 200], 50)
        s1 = np.percentile(np.asarray(new[n].convert("L"))[np.asarray(new[n])[:, :, 3] > 200], 50)
        print("  %-8s %10.4f %10.4f   %5.1f -> %.1f" % (n, g0, g1, s0, s1))

    # 对照图：每行一套，左旧右新
    pad, tile_h, label_w = 10, 400, 90
    sc0 = tile_h / old[names[0]].size[1]
    cw = max(round(max(old[n].size[0] * tile_h / old[n].size[1],
                       new[n].size[0] * tile_h / new[n].size[1])) for n in names) + 12
    W = label_w + (cw + pad) * 2 + pad
    H = pad + (tile_h + pad) * len(names)
    sheet = Image.new("RGB", (W, H), (236, 238, 242))
    for i, n in enumerate(names):
        y = pad + i * (tile_h + pad)
        for j, im in enumerate((old[n], new[n])):
            t = to_h(im, tile_h)
            chk = Image.new("RGB", (cw, tile_h), (255, 255, 255))
            px = chk.load()
            for yy in range(0, tile_h, 14):
                for xx in range(0, cw, 14):
                    if ((xx // 14) + (yy // 14)) % 2:
                        for y2 in range(yy, min(yy + 14, tile_h)):
                            for x2 in range(xx, min(xx + 14, cw)):
                                px[x2, y2] = (216, 219, 225)
            base = Image.new("RGBA", (cw, tile_h), (0, 0, 0, 0))
            base.alpha_composite(t, ((cw - t.size[0]) // 2, 0))
            chk.paste(base.convert("RGB"), (0, 0), base)
            sheet.paste(chk, (label_w + j * (cw + pad), y))
    out = os.path.join(REVIEW, "_对比_重制.png")
    sheet.save(out)
    print("\n对照图（左 = 旧 560，右 = 重制后）：", os.path.relpath(out, ROOT))


if __name__ == "__main__":
    main()
