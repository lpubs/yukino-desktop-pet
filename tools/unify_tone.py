# -*- coding: utf-8 -*-
"""色调统一：把四套素材的**色阶**对齐，不动色相与饱和。

## 统一什么、不统一什么（这是这个脚本最重要的一段）

四套素材来自三次不同的生成 + 一张低清截图，天生不像一套。但差异分两类，
必须分开对待：

  · **是内容，不能动**：水手服和冬装本来就是深藏青，饱和度天然高于
    女仆装的白围裙；色温也一样（藏青 = R−B 为负）。实测饱和度 8.5 vs 27.0、
    色温 −0.2 vs −15.9 —— 这些数是"衣服的颜色"，把它们对齐等于把衣服洗白。
  · **是批次差异，必须动**：色阶。实测暗部 p2 在 1.2 ~ 20.3 之间（线稿黑度
    差了十几倍），中位亮度在 69 ~ 152 之间（整体明暗差 2.2 倍）。
    这两个数不是任何一件衣服的属性，纯粹来自生成批次 / 截图条件。

所以做法是：估计每套的 p2 / p50 / p98，向四套的公共目标拉。

## 为什么这样拉不会改色相

对每个像素求亮度 L，先算仿射映射 L' = L·gain + lift（对齐 p2 与 p98），
再按 **比例** 缩放 RGB：RGB' = RGB · (L'/L)。
比例缩放把 R:G:B 的比值原样保留，所以色相和相对饱和度都不变，
只有明暗对比被拉齐。再对整体亮度（p50）做**半强度**匹配 ——
全量会把水手服的明亮感一并抹掉，那是内容。

## 与"重制分辨率"的分工

本脚本只管**颜色**，不管尺寸；尺寸由 build_assets.py 按"用满源、不放大"决定。
两件事分开做，是因为它们的判据完全不同：尺寸受源分辨率硬约束，
颜色受内容语义约束。

用法：
  python tools/unify_tone.py --report                 只看现状，不写文件
  python tools/unify_tone.py --sheet                  产出前后对照图到 _review/
"""
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# 只改明暗、不改颜色 —— 所以这个数是"强度"，不是"目标值"
MID_STRENGTH = 0.5      # 整体亮度向目标靠拢的比例（1.0 = 全量，会抹掉明亮感）

# Rec.601 亮度权重。用整数倍的 0.299/0.587/0.114 而不是等权平均：
# 人眼对绿最敏感、对蓝最不敏感，等权平均会把蓝色大衣的明暗算错。
LUMA = np.array([0.299, 0.587, 0.114], dtype=np.float32)


def curve(lum, st, tg, mid_strength=MID_STRENGTH):
    """把亮度按三点分段线性曲线映射到目标色阶。

    ## 为什么是分段线性，而不是"仿射 + 平移"

    第一版写的是"先仿射对齐 p2/p98，再整体平移去够 p50"。它是错的，
    而且错得不显眼：平移是**加法**，会把刚对齐好的两端一起推走 ——
    实测水手服的高光被压到 p98=230（本该 255），冬大衣的暗部从 17.8
    反而升到 26.4（本该 12.3）。两端都没对上，"统一"就没发生。

    正确做法是让**三个点同时满足**：p2 对 p2、p98 对 p98 精确对齐，
    p50 按强度 partial 对齐。三点定一条单调折线，各点互不干扰。

    ## 端点之外要外推，不能夹平

    np.interp 会把区间外的一律夹到端点值，于是最深的黑和最高的白
    被压成一片死值 —— 线稿的笔锋和眼睛的高光正好在那两头上。
    所以两端按各自那一段的斜率**线性外推**，最后再整体夹到 [0,255]。

    折线必须单调（y0 < y1 < y2），否则映射会打折、出现色带。
    p50 的混合值有可能越界，所以插值前先把 y1 夹进(y0, y2)之间。
    """
    x0, x1, x2 = st["p2"], st["p50"], st["p98"]
    y0, y2 = tg["p2"], tg["p98"]
    y1 = x1 + (tg["p50"] - x1) * mid_strength
    # 保序：三段斜率都要为正
    y1 = min(max(y1, y0 + 1.0), y2 - 1.0)
    if x1 - x0 < 1e-3 or x2 - x1 < 1e-3:
        return lum
    k0 = (y1 - y0) / (x1 - x0)
    k1 = (y2 - y1) / (x2 - x1)

    mid = np.interp(lum, [x0, x1, x2], [y0, y1, y2])
    lo = y0 + (lum - x0) * k0
    hi = y2 + (lum - x2) * k1
    out = np.where(lum < x0, lo, np.where(lum > x2, hi, mid))
    return np.clip(out, 0, 255)


def apply(rgba, st, tg, mid_strength=MID_STRENGTH):
    """按亮度曲线重映射，RGB 按**比例**缩放 —— 色相与相对饱和原样保留。"""
    a = rgba.astype(np.float32)
    lum = a[:, :, :3] @ LUMA
    lum2 = curve(lum, st, tg, mid_strength)
    ratio = lum2 / np.maximum(lum, 1.0)
    out = a.copy()
    out[:, :, :3] = np.clip(a[:, :, :3] * ratio[:, :, None], 0, 255)
    return np.clip(out, 0, 255).astype(np.uint8)


def stats_of(rgba):
    """在**不透明像素**上统计色阶。

    必须排除半透明边缘：那圈像素是角色色和白底的混合，
    数值上既不算黑也不算白，会把 p2/p98 往中间拽，于是"线稿黑度"这个量就失真了。
    """
    a = rgba.astype(np.float32)
    m = a[:, :, 3] > 200
    if m.sum() < 100:
        return None
    rgb = a[:, :, :3][m]
    lum = rgb @ LUMA
    return {
        "p2": float(np.percentile(lum, 2)),
        "p50": float(np.percentile(lum, 50)),
        "p98": float(np.percentile(lum, 98))
    }


def target_of(all_stats):
    """公共目标 = 各套的**均值**。

    不用中位数：四套的样本量只有 4，取中间两个的平均本质上还是均值，
    而均值写起来直接、不用解释"偶数个样本时中位数怎么算"。
    也不用某一套当基准：那会让基准那套完全不动、其余三套全被拉动，
    "统一"就变成了"向它靠"。
    """
    keys = ("p2", "p50", "p98")
    return {k: float(np.mean([s[k] for s in all_stats])) for k in keys}


def main():
    names = ["maid", "sailor", "coat", "winter"]
    src = os.path.join(ROOT, "_review", "hires")
    if not all(os.path.exists(os.path.join(src, n + ".png")) for n in names):
        sys.exit("先跑 build_assets.py 生成 _review/hires/ 下的素材，再来做色调统一。")

    imgs = {n: np.asarray(Image.open(os.path.join(src, n + ".png")).convert("RGBA")) for n in names}
    st = {n: stats_of(imgs[n]) for n in names}
    tg = target_of([st[n] for n in names])

    print("色阶现状（不透明像素）与公共目标")
    print("  %-8s %8s %8s %8s" % ("素材", "p2", "p50", "p98"))
    for n in names:
        print("  %-8s %8.1f %8.1f %8.1f" % (n, st[n]["p2"], st[n]["p50"], st[n]["p98"]))
    print("  %-8s %8.1f %8.1f %8.1f   <- 目标" % ("目标", tg["p2"], tg["p50"], tg["p98"]))

    if "--report" in sys.argv:
        for n in names:
            print("  %-8s gain/lift 会对齐到 p2=%.1f p98=%.1f" % (n, tg["p2"], tg["p98"]))
        return

    out = {n: apply(imgs[n], st[n], tg) for n in names}

    print("\n统一后")
    print("  %-8s %8s %8s %8s" % ("素材", "p2", "p50", "p98"))
    for n in names:
        s2 = stats_of(out[n])
        print("  %-8s %8.1f %8.1f %8.1f" % (n, s2["p2"], s2["p50"], s2["p98"]))

    if "--sheet" in sys.argv:
        sheet = os.path.join(ROOT, "_review", "_对比_色调.png")
        make_sheet(names, imgs, out, sheet)
        print("\n前后对照图：", os.path.relpath(sheet, ROOT))


def make_sheet(names, before, after, path, tile_h=420, pad=8, label_h=18):
    tiles = []
    for n in names:
        b = Image.fromarray(before[n], "RGBA")
        a = Image.fromarray(after[n], "RGBA")
        sc = tile_h / b.size[1]
        b = b.resize((max(1, round(b.size[0] * sc)), tile_h), Image.LANCZOS)
        a = a.resize((max(1, round(a.size[0] * sc)), tile_h), Image.LANCZOS)
        tiles.append((b, a))
    # 棋盘底：透明区域要能看出来，纯白底会把白色边框吞掉
    cw = max(max(t[0].size[0], t[1].size[0]) for t in tiles)
    W = pad + (cw + pad) * 2 + 120
    H = pad + (tile_h + pad + label_h) * len(tiles)
    sheet = Image.new("RGB", (W, H), (236, 238, 242))
    for i, (b, a) in enumerate(tiles):
        y = pad + i * (tile_h + pad + label_h)
        for j, im in enumerate((b, a)):
            x = 120 + j * (cw + pad)
            base = Image.new("RGBA", (cw, tile_h), (0, 0, 0, 0))
            base.alpha_composite(im, ((cw - im.size[0]) // 2, 0))
            # 棋盘底
            chk = Image.new("RGB", (cw, tile_h), (255, 255, 255))
            px = chk.load()
            for yy in range(0, tile_h, 16):
                for xx in range(0, cw, 16):
                    if ((xx // 16) + (yy // 16)) % 2:
                        for y2 in range(yy, min(yy + 16, tile_h)):
                            for x2 in range(xx, min(xx + 16, cw)):
                                px[x2, y2] = (214, 217, 223)
            chk.paste(base.convert("RGB"), (0, 0), base)
            sheet.paste(chk, (x, y + label_h))
    sheet.save(path)


if __name__ == "__main__":
    main()
