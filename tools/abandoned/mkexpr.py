# -*- coding: utf-8 -*-
"""局部确定性表情编辑 —— 只改眼部像素，其余逐像素不变。

为什么不用扩散模型重采样：
  扩散模型再生成一张闭眼图，整张图会被重新采样，眨眼瞬间五官/发丝会"跳一下"。
  这里只对眼部椭圆区域做「最近邻肤色回填 + 画眼睑线」，帧与帧之间像素级对齐。

用法:
  mkexpr.py <src> <dst> --mode blink|happy --eyes "cx,cy,rx,ry,deg;cx,cy,rx,ry,deg"
"""
import sys
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage


def parse():
    a = sys.argv[1:]
    src, dst = a[0], a[1]
    opt = {"mode": "blink", "eyes": [], "feather": 5, "blur": 4.0}
    i = 2
    while i < len(a):
        k = a[i].lstrip("-")
        if k == "mode":
            opt["mode"] = a[i + 1]
            i += 2
            continue
        if k == "eyes":
            for part in a[i + 1].split(";"):
                if part.strip():
                    opt["eyes"].append(tuple(float(v) for v in part.split(",")))
            i += 2
            continue
        if k in ("feather", "blur"):
            opt[k] = float(a[i + 1])
            i += 2
            continue
        i += 1
    return src, dst, opt


def rot_ellipse_mask(shape, cx, cy, rx, ry, deg):
    yy, xx = np.mgrid[0:shape[0], 0:shape[1]]
    th = np.deg2rad(deg)
    dx, dy = xx - cx, yy - cy
    u = dx * np.cos(th) + dy * np.sin(th)
    v = -dx * np.sin(th) + dy * np.cos(th)
    return (u / rx) ** 2 + (v / ry) ** 2 <= 1.0


def _diffuse(val, known, mask, iters, sigma):
    """在掩膜内做归一化卷积扩散（只统计 known 像素，深色像素不参与）。"""
    m3 = mask[:, :, None]
    k = known
    for _ in range(iters):
        num = np.stack([ndimage.gaussian_filter(val[:, :, c] * k, sigma) for c in range(3)], 2)
        den = ndimage.gaussian_filter(k, sigma)[:, :, None]
        val = np.where(m3, num / np.maximum(den, 1e-6), val)
    return val


def nn_fill(rgb, mask, feather=3.0):
    """眼窝回填 = 暖色肤色最近邻初值 + 金字塔由粗到细的归一化卷积扩散。

    三个必须同时满足的条件，少一个就会留痕：
      1. 取样源必须是**暖色肤色**，不能是"非深色"。
         睫毛与皮肤之间那圈灰色抗锯齿像素(约 161,158,150)亮度够高但完全不是肤色，
         一旦混进取样源，眼窝就会被填成一片灰霾。
      2. 扩散时只统计肤色像素，否则边界上的睫毛颜色会渗进来。
      3. 必须在**多个尺度上**收敛。单尺度迭代的传播距离约 sigma*sqrt(N)，
         要跨过 48px 高的眼窝需要近千次迭代；金字塔先在小图上收敛再把结果当
         初值逐级放大，既快又不会在眼窝顶部留下没收敛的灰色。
    """
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    # 判据必须够紧。睫毛/刘海与皮肤之间那圈抗锯齿像素约 (143,136,126)、
    # (211,208,193)，宽松判据(r-b>16 & r>140)会把它们当肤色放进来，
    # 眼窝顶部就被填成灰褐色。真实肤色是 (254,226,209) 这种，r-b 在 45 上下。
    skin = (r - b > 30) & (r > 170) & (g > 140)
    src = skin & ~mask
    if src.sum() < 50:
        src = (~mask) & (rgb.mean(axis=2) > 170)

    idx = ndimage.distance_transform_edt(~src, return_distances=False,
                                         return_indices=True)
    init = rgb[idx[0], idx[1]].astype(np.float32)

    known = (skin | mask).astype(np.float32)
    val = rgb.astype(np.float32).copy()
    val[mask] = init[mask]
    # 注意：这里**不能**写 val *= known。
    # 归一化卷积是 Σ(w·v·G)/Σ(w·G)，权重已经由 known 承担；
    # 若再把 val 预先置零，金字塔降采样时会把外圈的 0 混进眼窝，
    # 除以权重也补不回来，眼窝顶部就会固定偏灰。

    # 局部小半径扩散就够。
    # 不要上金字塔：粗尺度 σ 折算回原图会覆盖 ~90px，把远处脸颊/脖子的阴影
    # 也平均进来，眼窝会被填成"比周围暗一档"的灰皮。传播距离 σ√N≈5px 足够
    # 抹平最近邻的块状感，又不会把远处肤色拉进来。
    val = _diffuse(val, known, mask, 24, 1.2)

    m = ndimage.gaussian_filter(mask.astype(np.float32), feather)
    m = np.clip(m * 1.9 - 0.45, 0, 1)[:, :, None]
    return rgb * (1 - m) + val * m


def lid_points(cx, cy, rx, ry, deg, mode):
    """眼睑线的点序列。内眼角 -> 外眼角。
    blink: 中间比两端低(眼睑垂下来);  happy: 中间比两端高(^^ 笑眼)。"""
    th = np.deg2rad(deg)
    t = np.linspace(0.07 * np.pi, 0.93 * np.pi, 80)
    u = -rx * np.cos(t)
    s = np.sin(t)
    if mode == "blink":
        v = ry * 0.34 - ry * 0.46 * s          # 中间下垂
    else:
        v = ry * 0.20 - ry * 0.52 * s          # 中间上抬
    px = cx + u * np.cos(th) - v * np.sin(th)
    py = cy + u * np.sin(th) + v * np.cos(th)
    return list(zip(px, py))


def draw_lid(img_pil, cx, cy, rx, ry, deg, mode, lash_rgb, width=2):
    """用折线画眼睑线 + 外眼角的小睫毛。"""
    from PIL import ImageDraw
    d = ImageDraw.Draw(img_pil)
    col = tuple(int(v) for v in lash_rgb)
    pts = lid_points(cx, cy, rx, ry, deg, mode)
    d.line(pts, fill=col, width=width, joint="curve")
    # 两端收尖
    for (x, y) in (pts[0], pts[-1]):
        d.ellipse([x - width * 0.4, y - width * 0.4,
                   x + width * 0.4, y + width * 0.4], fill=col)
    # 外眼角小睫毛(blink 时更明显)
    th = np.deg2rad(deg)
    ox, oy = pts[-1]
    for k, (ln, ang) in enumerate(((9, 38), (7, 52))):
        a = np.deg2rad(ang - deg)
        ex, ey = ox + ln * np.cos(a), oy + ln * np.sin(a)
        d.line([(ox, oy), (ex, ey)], fill=col, width=max(1, width - 1))
    return img_pil


def draw_lid_np(canvas_rgb, cx, cy, rx, ry, deg, mode, lash_rgb, width=2):
    img = Image.fromarray(np.clip(canvas_rgb, 0, 255).astype(np.uint8))
    draw_lid(img, cx, cy, rx, ry, deg, mode, lash_rgb, width)
    return np.asarray(img).astype(np.float32)


def main():
    src, dst, o = parse()
    base = np.asarray(Image.open(src).convert("RGB")).astype(np.float32)

    mask = np.zeros(base.shape[:2], bool)
    for (cx, cy, rx, ry, deg) in o["eyes"]:
        mask |= rot_ellipse_mask(base.shape[:2], cx, cy, rx, ry, deg)

    out = nn_fill(base, mask, o["feather"])

    # 睫毛颜色从原图眼周最暗处取样
    ys, xs = np.where(ndimage.binary_dilation(mask, iterations=10) & ~mask)
    px = base[ys, xs]
    lash = px[px.sum(1).argsort()[: max(20, len(px) // 40)]].mean(0)
    lash = np.clip(lash, 24, 90)

    for (cx, cy, rx, ry, deg) in o["eyes"]:
        out = draw_lid_np(out, cx, cy, rx, ry, deg, o["mode"], lash, width=2)

    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(dst)

    # 对齐校验：除眼部外应当逐像素相同
    diff = np.abs(base - out).max(axis=2)
    outside = diff[~ndimage.binary_dilation(mask, iterations=6)]
    print(f"{dst.split('/')[-1]:22s} mode={o['mode']:5s} "
          f"眼区外最大像素差={outside.max():.1f} 变动像素={(diff > 2).sum()}", flush=True)
    return dst


if __name__ == "__main__":
    main()
