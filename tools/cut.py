# -*- coding: utf-8 -*-
"""确定性抠图 —— 纯 Python，不用任何分割模型 / 扩散模型。

为什么这么做（而不是用 rembg / isnet）：
  这类插画是白底 + 角色自带轮廓线，白背景与角色内部的白（围裙、头饰、
  衬衫）在颜色上无法区分，但**在连通性上可以区分**：
  只有与图像四边连通的背景才是背景，被线条围住的白色是角色的一部分。

三处关键细节（都是踩过坑的）：

  1. **背景色从图像四边估计，不用硬阈值**。
     原来写死 `min(RGB) >= 244` 就当前景，遇到浅灰底 / 棋盘格底 / 渐变底
     会整片误判（棋盘格的暗格 ~242 正好卡在阈值下面，整块背景都成了前景）。
     改成：取四边像素的中位数当背景色，按 Chebyshev 距离 + 容差判定。
     这样"背景是不是纯白"不再影响结果。

  2. **flood fill 必须 4-连通**，不能 8-连通。
     轮廓线是抗锯齿的，8-连通能从描边的**对角缝隙**挤进角色内部，
     把白蕾丝 / 白围裙 / 白衬衫当成背景一起吃掉
     （女仆装肩上的白蕾丝就是这么消失的）。4-连通挤不过对角缝。

  3. **边缘要做反预乘去白晕**。
     半透明边缘像素 = 角色色与白底的混合，直接留着它，
     贴到深色桌面上就是一圈白乎乎的"贴纸边"。
     按 `F = (observed - (1-a)*255) / a` 反解出原色，
     只重写真正半透明的像素，完全不透明的像素颜色一个字节都不动。

流程：
  1. 估计背景色 -> 容差内且与四边连通的像素判为背景（4-连通）
  2. 逐环剥掉紧贴背景的"浅色贴纸边"，遇到深色描边自动停
  3. binary_fill_holes 补回角色内部的白（围裙/头饰/衬衫）
  4. 去碎屑 -> 只保留最大连通主体（防止零散笔触被当成角色）
  5. 反预乘去白晕 + 收紧 1px 去抗锯齿白边
  6. 程序自合成均匀白描边（贴纸风），而不是指望原图那圈边缘
  7. 裁到内容包围盒 + 等比缩放

用法:
  cut.py <src> <dst> [--alpha mask.png] [--target H] [--border N]
                       [--tol T] [--shave N] [--no-decon]

  --alpha  外部掩膜（灰度 PNG，>127 为前景）。给了它就**跳过**背景判断，
           直接用这份掩膜。只在背景完全无法用连通性区分时才需要，
           见 tools/anime_cut.py 的说明。
  --tol    背景色容差，默认 38（Chebyshev 距离）
  --shave  剥几环浅色贴纸边，默认 4，0 关闭
  --no-decon  关掉反预乘去白晕
"""
import os
import sys
import numpy as np
from PIL import Image
from scipy import ndimage

# 4-连通：十字形结构元。**不要**改成 3x3 全 1，
# 8-连通会从抗锯齿描边的对角缝隙漏进角色内部（见文件头第 2 条）。
STRUCT4 = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=bool)


def parse():
    a = sys.argv[1:]
    src, dst = a[0], a[1]
    opt = {"border": 8, "thresh": 244, "target": 520, "mask": None,
           "alpha": None, "tol": 38, "shave": 4, "decon": True}
    i = 2
    while i < len(a):
        k = a[i].lstrip("-")
        if k == "mask-top-right":
            opt["mask"] = tuple(int(v) for v in a[i + 1].split(","))
            i += 2
            continue
        if k == "alpha":
            opt["alpha"] = a[i + 1]
            i += 2
            continue
        if k == "shave":
            opt["shave"] = int(a[i + 1])
            i += 2
            continue
        if k in ("border", "thresh", "target", "tol"):
            opt[k] = int(a[i + 1])
            i += 2
            continue
        if k == "no-decon":
            opt["decon"] = False
            i += 1
            continue
        i += 1
    return src, dst, opt


def bg_color(a):
    """背景色 = 图像四边像素的中位数。

    用中位数而不是均值：边框上只要有一小段被角色压到（比如头发垂出画面），
    均值会被拉偏，中位数不会。
    """
    border = np.concatenate([a[0, :, :], a[-1, :, :], a[:, 0, :], a[:, -1, :]], axis=0)
    return np.median(border.astype(np.float32), axis=0)


def bg_mask(a, tol):
    """与四边连通的背景像素（4-连通 flood fill）。

    这是整个抠图的立足点：角色内部的白色（头饰、围裙、衬衫）虽然颜色上
    和背景一样，但被轮廓线围住、**从边界走不到**，所以不会被判成背景。
    """
    bgc = bg_color(a)
    dist = np.abs(a.astype(np.float32) - bgc[None, None, :]).max(axis=2)
    near = dist <= tol

    lab, n = ndimage.label(near, structure=STRUCT4)
    if n == 0:
        return np.zeros(a.shape[:2], dtype=bool)
    ids = set(lab[0, :].tolist()) | set(lab[-1, :].tolist())
    ids |= set(lab[:, 0].tolist()) | set(lab[:, -1].tolist())
    ids.discard(0)
    if not ids:
        return np.zeros(a.shape[:2], dtype=bool)
    return np.isin(lab, list(ids))


def shave_light_rim(a, bg, iterations=4, rim_tol=55.0, min_light=195):
    """逐环剥掉紧贴背景的"浅色贴纸边"。

    扩散模型 / 抗锯齿都会在轮廓外面留一圈发白的边。它颜色接近背景、
    又足够亮，所以可以吃；但角色的深色描边既不够亮、颜色也离背景远，
    两道判据都不过，自动停住 —— 于是永远吃不进角色本体。
    """
    if iterations <= 0:
        return bg
    bgc = bg_color(a)
    dist = np.abs(a.astype(np.float32) - bgc[None, None, :]).max(axis=2)
    edible = (dist <= rim_tol) & (a.min(axis=2) >= min_light)

    cur = bg.copy()
    for _ in range(iterations):
        ring = ndimage.binary_dilation(cur, structure=STRUCT4) & ~cur
        eat = ring & edible
        if not eat.any():
            break
        cur = cur | eat
    return cur


def cut(src, dst, border=8, thresh=244, target=520, mask=None, alpha=None,
        tol=38, shave=4, decon=True):
    img = Image.open(src).convert("RGB")
    a = np.asarray(img).astype(np.uint8).copy()
    h, w, _ = a.shape

    # 0) 抹掉水印区（置为背景色，让它并入"外部背景"）
    if mask:
        x0, y0, x1, y1 = mask
        a[y0:y1, x0:x1] = 255

    # 1) 前景掩膜。两条来源：
    if alpha:
        # 外部模型给的掩膜。白背景假设不成立时走这条 ——
        # 后面的收尾全部照旧，所以两种来源出来的素材风格一致。
        m = Image.open(alpha).convert("L")
        if m.size != (w, h):
            m = m.resize((w, h), Image.Resampling.LANCZOS)
        fg = np.asarray(m) > 127
    else:
        bg = bg_mask(a, tol)
        if shave:
            bg = shave_light_rim(a, bg, iterations=shave)
        fg = ~bg

    # 2) 补回角色内部的白
    fg = ndimage.binary_fill_holes(fg)

    # 3) 去碎屑
    core = ndimage.binary_erosion(fg, iterations=2)
    lab2, n2 = ndimage.label(core)
    if n2 > 0:
        sizes = np.bincount(lab2.ravel())
        sizes[0] = 0
        min_area = max(24, int(fg.size * 0.0004))
        keep = np.where(sizes >= min_area)[0]
        if len(keep):
            core = np.isin(lab2, keep)
    fg = ndimage.binary_dilation(core, iterations=2) & fg
    fg = ndimage.binary_fill_holes(fg)

    # 4) 只保留最大连通主体（防止零散笔画被当成角色）
    lab3, n3 = ndimage.label(fg)
    if n3 > 1:
        sizes = np.bincount(lab3.ravel())
        sizes[0] = 0
        fg = lab3 == int(np.argmax(sizes))

    # 5) 收 1px 去抗锯齿白边
    fg_core = ndimage.binary_erosion(fg, iterations=1)

    alpha_f = ndimage.gaussian_filter(fg_core.astype(np.float32), 1.0)
    alpha_f = np.clip(alpha_f * 1.8 - 0.4, 0.0, 1.0)

    # 5b) 反预乘去白晕：半透明边缘是角色色与白底的混合，
    #     直接留着它，贴到深色桌面上就是一圈发白的"贴纸边"。
    rgb = a.astype(np.float32)
    if decon:
        af = np.clip(alpha_f, 1e-3, 1.0)[:, :, None]
        f_lin = np.clip((rgb - (1.0 - af) * 255.0) / af, 0, 255)
        partial = ((alpha_f > 0.02) & (alpha_f < 0.995))[:, :, None]
        rgb = np.where(partial, f_lin, rgb).astype(np.float32)

    char = np.dstack([rgb, np.round(alpha_f * 255.0)]).astype(np.uint8)

    # 6) 合成白描边
    if border > 0:
        grow = ndimage.binary_dilation(fg_core, iterations=border)
        b_alpha = ndimage.gaussian_filter(grow.astype(np.float32), 1.0)
        b_alpha = np.clip(b_alpha * 1.8 - 0.4, 0.0, 1.0)
        white = np.dstack([np.full((h, w), 255, np.uint8),
                           np.full((h, w), 255, np.uint8),
                           np.full((h, w), 255, np.uint8),
                           (b_alpha * 255).astype(np.uint8)])
        canvas = np.where(char[:, :, 3:4] > 0, char, white).astype(np.uint8)
        canvas_mask = grow
    else:
        canvas, canvas_mask = char, fg_core

    out = Image.fromarray(canvas, "RGBA")

    ys, xs = np.where(canvas_mask)
    if len(xs):
        pad = max(2, border)
        x0, x1 = max(0, xs.min() - pad), min(w, xs.max() + 1 + pad)
        y0, y1 = max(0, ys.min() - pad), min(h, ys.max() + 1 + pad)
        out = out.crop((x0, y0, x1, y1))

    ow, oh = out.size
    sc = target / oh
    out = out.resize((max(1, int(round(ow * sc))), target), Image.LANCZOS)
    out.save(dst)

    op = (np.asarray(out)[:, :, 3] > 128).mean() * 100
    print(f"{os.path.basename(src):20s} {img.size} -> {out.size}  opaque={op:5.1f}%", flush=True)
    return dst


if __name__ == "__main__":
    s, d, o = parse()
    cut(s, d, **o)
