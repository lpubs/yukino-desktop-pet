# -*- coding: utf-8 -*-
"""把 gen_layers.py 生成的「局部改动版整图」提取成 RGBA 差分图层。

## 核心：对齐是算出来的，不是求模型别动的

差分方案能成立，恰恰因为**它不要求模型保持不动**：

    基准立绘（逐位保留）  +  差分层（只覆盖改动过的那一小块）
    ────────────────────────────────────────────────────────
    合成结果里，改动区之外**每一个字节都还是基准图的**。

所以"帧间像素级对齐"不需要靠参数调优去换 —— 它是这个数据结构自带的性质。
模型漂移多少都无所谓：漂移出来的差异要么落在掩膜内（被当成本次改动接受），
要么低于阈值（被丢掉）。真正需要人眼把关的只有一件事：
**被接受的那块改动，画得对不对**（见本文件末"验收"一节）。

## 掩膜怎么定：差异 + 保底约束

  1. `|基准 − 生成| > thr` 的像素算"改过"。阈值不能太低 ——
     VAE 往返 + 4 步蒸馏会让**全图**都有 1~3 级的浮动，阈值压到 5 就会把整张脸都收进来。
  2. **可选 ROI 硬约束**：眼/嘴这类改动有时会连带把发梢也重画一笔，
     那种差异在物理上真实、在动画里却是错的（她眨一下眼，一缕头发跟着换位置）。
     给一个矩形把改动锁在解剖学上该在的地方。
  3. **只允许落在基准不透明区**：差分层绝不能画到角色轮廓外面去，
     否则透明底上会多出一块白斑（贴到深色桌面上极其显眼）。
  4. 开运算去斑点 + 闭运算连断笔 + 丢掉过小的孤立块。

## 验收（沿用项目的铁律）

指标（changed 像素数、最大差异）**只能说明"有东西变了"，说明不了"变对了"**。
所以本脚本每次都会输出一张对照图 `_layerwork/<outfit>/_qa_<edit>.png`：

    左：基准（改动区用红框标出）   中：模型输出   右：合成结果

**必须逐张读过这张图**再往下走 —— 这是 v2 那次翻车（靠 opaque% 判断抠图成功、
结果 4 套全是废图）唯一可靠的补救方式。
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SPRITES = os.path.join(ROOT, "assets", "sprites")
WORK = os.path.join(ROOT, "_layerwork")

STRUCT = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=bool)

# ROI 直接由 featmask 的五官标定表推出来，**不另抄一份坐标**。
# 抄一份的代价是很具体的：改了 featsmask 的椭圆却忘了改这里，
# 生成用的是新范围、提取用的是旧范围，而两边都不会报错 ——
# 结果就是"改动的边缘被切掉一条"，只会在对照图里显形。
ROI_MARGIN = 14   # 掩膜外再放一圈：改动的边缘（羽化带、模型顺手带出的阴影）要收进来


def roi_for(outfit, kind):
    """把 `<kind>` 对应的椭圆并集的包围盒，各向外扩 ROI_MARGIN。"""
    try:
        import featmask
        tab = featmask.FEATURES[outfit]
        names = featmask.KIND_MEMBERS[kind]
    except (ImportError, KeyError):
        return None
    x0 = min(tab[n][0] - tab[n][2] for n in names) - ROI_MARGIN
    y0 = min(tab[n][1] - tab[n][3] for n in names) - ROI_MARGIN
    x1 = max(tab[n][0] + tab[n][2] for n in names) + ROI_MARGIN
    y1 = max(tab[n][1] + tab[n][3] for n in names) + ROI_MARGIN
    return (max(0, x0), max(0, y0), x1, y1)


def ceil16(v):
    return (v + 15) // 16 * 16


def load_pair(outfit, edit):
    base = Image.open(os.path.join(SPRITES, outfit + ".png")).convert("RGBA")
    W, H = base.size
    cw, ch = ceil16(W), ceil16(H)

    # 基准铺白底，与 gen_layers.py 喂给模型的那张**同构**（同一个画布、同一个原点）。
    canvas = Image.new("RGB", (cw, ch), (255, 255, 255))
    canvas.paste(base, (0, 0), base)
    b = np.asarray(canvas).astype(np.int16)

    gen_path = os.path.join(WORK, outfit, edit + ".png")
    if not os.path.exists(gen_path):
        raise SystemExit(f"找不到生成图 {gen_path}，先跑 tools/gen_layers.py {outfit} {edit}")
    # 裁回立绘尺寸：基准放在 (0,0)，只向右/下补白，所以裁 (0,0,W,H) 是精确还原。
    g_img = Image.open(gen_path).convert("RGB")
    if g_img.size != (cw, ch):
        g_img = g_img.resize((cw, ch), Image.LANCZOS)
    g = np.asarray(g_img.crop((0, 0, W, H))).astype(np.int16)

    return base, b[:, :W], g, (W, H)


def detect(b, g, alpha, roi, thr, min_area_frac=0.00004):
    diff = np.abs(b - g).max(axis=2)
    m = diff > thr

    if roi is not None:
        x0, y0, x1, y1 = roi
        keep = np.zeros_like(m)
        keep[max(0, y0):y1, max(0, x0):x1] = True
        m &= keep

    # 只允许落在基准的不透明区（护栏 3）。
    # 用 200 而不是 0：半透明的贴纸描边边缘上叠加会二次混合，越描越白。
    m &= (alpha > 200)

    m = ndimage.binary_opening(m, structure=STRUCT, iterations=1)
    m = ndimage.binary_closing(m, structure=STRUCT, iterations=2)

    lab, n = ndimage.label(m, structure=np.ones((3, 3), bool))
    if n:
        sizes = np.bincount(lab.ravel())
        sizes[0] = 0
        min_area = max(6, int(m.size * min_area_frac))
        keep = np.where(sizes >= min_area)[0]
        if not len(keep):
            keep = [int(np.argmax(sizes))]
        m = np.isin(lab, keep)

    return m, diff


def build_alpha(m, feather, base_alpha):
    """羽化掩膜。

    羽化不是为了"好看"，是为了**去掉硬接缝**：差分层边缘和基准之间若按 0/1 硬切，
    皮肤上会出现一条肉眼可见的接缝线（尤其是颜色略有色差时）。
    1px 左右的高斯就够 —— 再宽会把改动区边缘的细节糊掉。
    """
    a = ndimage.gaussian_filter(m.astype(np.float32), feather)
    a = np.clip(a * 1.7 - 0.35, 0.0, 1.0)
    a[a < 0.02] = 0.0
    # 羽化会让 alpha 溢出到轮廓外，再夹一次（护栏 3 的第二次执行）
    a = np.where(base_alpha > 8, a, 0.0)
    return a


def qa_sheet(base_rgba, gen_rgb, comp_rgb, m, dst):
    """三栏对照图，左右两栏都铺在棋盘底上 —— 透明区域有没有多出白斑，只有棋盘底看得出来。"""
    gen_rgb = np.asarray(gen_rgb).astype(np.uint8)
    comp_rgb = np.asarray(comp_rgb).astype(np.uint8)
    W, H = base_rgba.size
    tile = 12
    yy, xx = np.mgrid[0:H, 0:W]
    checker = np.where(((yy // tile) + (xx // tile)) % 2 == 0, 236, 205).astype(np.uint8)
    checker = np.dstack([checker] * 3)

    def over(rgba):
        a = rgba[:, :, 3:4].astype(np.float32) / 255.0
        return (rgba[:, :, :3].astype(np.float32) * a + checker * (1 - a)).astype(np.uint8)

    left = over(np.asarray(base_rgba))
    li = Image.fromarray(left)
    d = ImageDraw.Draw(li)
    # 改动区的外框：红框在基准栏里，方便一眼看出"动的是不是该动的地方"
    ys, xs = np.where(m)
    if len(xs):
        d.rectangle([xs.min(), ys.min(), xs.max(), ys.max()], outline=(220, 30, 30), width=2)

    right = over(np.dstack([comp_rgb, np.asarray(base_rgba)[:, :, 3]]))
    ry, rx = np.where(m)
    if len(rx):
        rr = Image.fromarray(right)
        dr = ImageDraw.Draw(rr)
        dr.rectangle([rx.min(), ry.min(), rx.max(), ry.max()], outline=(30, 150, 60), width=2)
        right = np.asarray(rr)

    gap = np.full((H, 8, 3), 255, np.uint8)
    sheet = np.concatenate([np.asarray(li), gap,
                            np.asarray(gen_rgb), gap, right], axis=1)
    Image.fromarray(sheet).save(dst)
    return dst


def main():
    ap = argparse.ArgumentParser(description="提取差分图层")
    ap.add_argument("outfit")
    ap.add_argument("edits", nargs="*")
    ap.add_argument("--thr", type=int, default=14, help="差异阈值，默认 14")
    ap.add_argument("--feather", type=float, default=1.1)
    ap.add_argument("--roi", default=None, help="覆盖 ROI：x0,y0,x1,y1")
    ap.add_argument("--roi-kind", default=None, choices=["eye", "mouth", "none"],
                    help="用预设的哪一类 ROI（默认按改动名自动判）")
    ap.add_argument("--prefix", default=None, help="输出名前缀，默认跟改动名")
    a = ap.parse_args()

    outfit = a.outfit
    outdir = os.path.join(WORK, outfit)
    edits = a.edits or sorted(f for f in os.listdir(outdir)
                              if f.endswith(".png") and not f.startswith("_"))
    edits = [os.path.splitext(f)[0] for f in edits]

    manifest_path = os.path.join(SPRITES, outfit, "manifest.json")
    W, H = Image.open(os.path.join(SPRITES, outfit + ".png")).size
    manifest = {"outfit": outfit, "size": [W, H], "layers": {}}
    if os.path.exists(manifest_path):
        manifest = json.load(open(manifest_path, encoding="utf-8"))

    out_sp = os.path.join(SPRITES, outfit)
    os.makedirs(out_sp, exist_ok=True)

    for edit in edits:
        kind = a.roi_kind
        if kind is None:
            kind = "eye" if edit.startswith("eye") else ("mouth" if edit.startswith("mouth") else "none")
        if a.roi:
            roi = tuple(int(v) for v in a.roi.split(","))
        elif kind == "none":
            roi = None
        else:
            roi = roi_for(outfit, kind)
            if roi is None:
                print(f"  [{edit}] 没有 {outfit}/{kind} 的五官标定，本次**不加 ROI 约束**"
                      f"（改动可能溢出到不该动的地方，务必看对照图）")

        base, b, g, (W, H) = load_pair(outfit, edit)
        balpha = np.asarray(base)[:, :, 3]
        m, diff = detect(b, g, balpha, roi, a.thr)
        if not m.any():
            print(f"  [{edit}] 没检出任何改动（阈值 {a.thr} 太高？），跳过")
            continue

        alpha = build_alpha(m, a.feather, balpha)
        # 透明的像素里 RGB 是没用的，但 PNG 照样会把它们存下来 ——
        # 而那一大片是模型输出的**噪声**（每像素都不一样），压缩率极差：
        # 实测三张图层各 ~745KB，其中九成九的体积花在"看不见的噪声"上。
        # 抹成 0 之后整片变成常量，体积掉一个数量级。
        # 安全性：半透明像素一个都不碰，只碰 alpha 恰好为 0 的
        #（浏览器插值按预乘 alpha 算，α=0 的 RGB 不参与混色）。
        rgb_l = np.asarray(g).astype(np.uint8).copy()
        rgb_l[np.round(alpha * 255).astype(np.uint8) == 0] = 0
        layer = np.dstack([rgb_l, np.round(alpha * 255).astype(np.uint8)])
        name = a.prefix or edit
        dst = os.path.join(out_sp, name + ".png")
        Image.fromarray(layer, "RGBA").save(dst, optimize=True)

        comp = (g.astype(np.float32) * alpha[:, :, None]
                + b.astype(np.float32) * (1 - alpha[:, :, None])).astype(np.uint8)
        qa = qa_sheet(base, g, comp, m, os.path.join(outdir, f"_qa_{edit}.png"))

        ys, xs = np.where(m)
        # 未改动区的色偏：如果有明显色偏（>3 级），说明模型整张调过色，
        # 这层贴回去会在皮肤上留一块色斑，必须先做色阶对齐再谈别的。
        off = int(np.abs(b[~m] - g[~m]).mean())
        rec = {"file": name + ".png", "w": W, "h": H,
               "box": [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1],
               "changed": int(m.sum()), "max_diff": int(diff[m].max()), "tone_off": off,
               "thr": a.thr, "feather": a.feather, "roi": list(roi) if roi else None}
        manifest["layers"][name] = rec
        print(f"  [{edit}] -> {os.path.relpath(dst, ROOT)}  {W}x{H}  "
              f"改动 {rec['changed']}px  框 {rec['box']}  maxΔ {rec['max_diff']}  "
              f"未改动区色偏 {off}")
        print(f"       对照图 {os.path.relpath(qa, ROOT)}")

    manifest["size"] = [W, H]
    # newline="\n"：别让 Windows 的默认翻译把 LF 变成 CRLF —— 清单的字节不该随平台变。
    # 见 mkframe.py 同一处的说明（negtest.js 按文本片段改清单来造故障）。
    with open(manifest_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"\n清单已写入 {os.path.relpath(manifest_path, ROOT)}（{len(manifest['layers'])} 层）")
    print("⚠ 现在**逐张打开对照图看**，别只看上面这几行数字。")


if __name__ == "__main__":
    main()
