# -*- coding: utf-8 -*-
"""把 gen_layers.py 的「掩膜内整脸重绘」做成可以直接切换的状态帧（v3.10）。

## 这一步在解决什么

v3.9 的差分层只圈住**眼球**（两个小椭圆）。好处是帧间绝对不抖，
坏处在她身上特别致命：雪乃的上眼睑是那道又粗又黑、**两端挑出去**的睫毛线，
它有一部分落在椭圆外面 —— 闭眼图叠上去时那截旧睫毛还留着，
于是"闭了眼底下还有一道弧"。放大到 6 倍看得很清楚。

## 三条路都跑过，只有第三条能同时满足两件事

    ① 裸编辑（--nomask，denoise 1.0）   整张重画。稳定区色偏 90.6 级、
       脸外 77% 的像素都变了，连头的朝向都变了 —— 就是 v1/v2 翻车的那个形态。
    ② 裸编辑（--nomask，denoise 0.55）  线稿被重画了，语义却没改：
       眼睛根本不肯闭，稳定区色偏仍有 17 级。两头都不通。
    ③ 掩膜内整脸重绘（本文件的输入）    模型看得见整张脸（所以眼睑、皮肤、
       头发的明暗是一次画完的，没有贴片边界），但**只有掩膜内**会被重绘。

第③条的关键：它和①在"模型看到了什么"上是一样的，和②在"哪儿能改"上是一样的。
一句"直接全图生成"落到能用的实现上，就是"整张图喂进去、整块范围换出来"。

## 交出去的是什么形状

整张 PNG 直接换 src 是可能的，但会丢掉眼/嘴的**可组合性**：一层脸只能是一个状态，
于是"边眨眼边说话"就得为每种组合各生成一张。所以交出去的是**区域帧**：
PNG 尺寸与立绘一致、叠加位置与立绘一致，但 alpha 只在掩膜内非零。

    · 框外 alpha 恰好为 0 → 合成结果框外**逐位等于基准**，帧间不可能抖；
    · 框内 alpha 为 1 → 合成结果框内**就是模型重画的那块**，没有接缝；
    · 眼帧（整张脸）与嘴帧（嘴区矩形）的范围互不相交 → 两层可自由叠加，
      不会互相覆盖。这也是嘴区**不用**整张脸的原因：用脸框的话，
      嘴帧的 alpha 会盖住眼区，眨眼时眼睛会忽然睁开。

## 为什么不做全局配准

原来（`--nomask` 那版）必须做：整张图被重采样，线稿整体错开 1~3 像素，
眨眼时她会平移一下。现在掩膜外的 latent 就是基准图的编码，想错开也错不开。
实测过要不要补：在框内"稳定内容"（皮肤/头发）上搜 ±4 像素的整数平移，
最佳位移带来的改善是 0.06 / 0.65 / 0.00 / 0.30 —— 都在噪声量级，是在追噪声。
所以不做，只把"最佳位移"记下来当证据（manifest 的 `inbox_shift`）。

## 为什么也不做色阶对齐

框内整体确实带一点色偏（带符号均值 −6.2 ~ +6.3 级），看着像该修。但不能用
**一个常量**去修：过渡带上的带符号均值只有 −0.5 级，也就是这个偏差是
**中间亮、边缘已经对上**的空间分布，减一个常量会把已经对上的边缘反而推歪。
而它本身是 2% 量级的亮度差、且被羽化强制收敛到 0，所以不修，只记数
（manifest 的 `inside_tone` / `ring_tone`）。

## 验收

数字只说明"变了多少"，说明不了"变得对不对"。每次都会出对照图
`_layerwork/<套装>/<tag>/_framqa_<槽位>.png`，**必须逐张读过**再往下走。
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

DEFAULT_TAG = "facebox"
DEFAULT_THR = 14

# 量"生成图有没有在掩膜外漂移"时，从硬框往外让开多少像素。
# 让这么宽的理由：软掩膜的支撑到 ~3σ 为止，而潜空间掩膜还要按 8 像素的格子量化，
# 边缘那一两格会被带着改。64px 把这两件事都让开了，剩下的差异只可能来自
# VAE 往返本身 —— 那才是要对照的噪声地板。
DRIFT_MARGIN = 64

# roi 的宽度：硬框外扩 4σ。gaussian_filter 的截断半径默认就是 4σ，
# 所以这个范围**保证**软掩膜恒为 0 —— 于是"框外 alpha 全 0"是一条可以逐像素验的硬约束，
# 而不是一句设计意图。selftest 会真的去解 PNG 的 alpha 来核这一条。
ROI_SIGMA = 4


def ceil16(v):
    return (v + 15) // 16 * 16


# 槽位前缀 -> 用哪块区域。★ 这张表**必须**与生成时 `gen_layers.py --mask-kind` 一致。
# 两边各写一份、又互相比对的话，会按错误的范围去算"框外有没有漂移" ——
# 而框外真的没动，于是永远算不出问题（漏检）。所以两边都只认 featmask 那一份。
REGION_OF = {"eye": "face", "mouth": "mouthbox", "walk": "hem"}


def kind_of(edit):
    if edit.startswith("eye"):
        return "eye"
    if edit.startswith("mouth"):
        return "mouth"
    if edit.startswith("walk"):
        return "walk"
    raise SystemExit(f"改动名 {edit!r} 既不是 eye_* / mouth_* 也不是 walk_*，不知道贴哪块区域")


def region_of(outfit, edit):
    """返回 (软掩膜 float32 HxW, 硬框 (x0,y0,x1,y1), 羽化半径)。全部取自 featmask。"""
    import featmask
    reg = REGION_OF[kind_of(edit)]
    if reg == "face":
        m, _ = featmask.build_face(outfit)
        return m, featmask.face_box(outfit), featmask.BOX_FEATHER
    if reg == "hem":
        m, _ = featmask.build_hem(outfit)
        return m, featmask.hem_box(outfit), featmask.HEM_FEATHER
    m, _ = featmask.build_mouth(outfit)
    return m, featmask.mouth_box(outfit), featmask.MOUTH_FEATHER


def feature_px(outfit, shape, dilate=6):
    """五官椭圆的并集（再向外胀一点）。用来把"本来就该变的那些像素"排除掉，
    只看周围皮肤/头发有没有被改坏。

    走 `featmask.ellipses()` 而不是直接遍历 FEATURES[outfit] —— 后者会把
    以 `_` 开头的显式框（`_face` / `_mouth`）也当成椭圆，把 4 元组当半径算，
    范围于是悄悄算错，而且不会报错。
    """
    import featmask
    H, W = shape
    yy, xx = np.mgrid[0:H, 0:W]
    m = np.zeros(shape, bool)
    for cx, cy, rx, ry in featmask.ellipses(outfit).values():
        m |= (((xx - cx) / float(rx)) ** 2 + ((yy - cy) / float(ry)) ** 2) <= 1.0
    if dilate:
        m = ndimage.binary_dilation(m, iterations=dilate)
    return m


def rect(shape, box, grow=0):
    H, W = shape
    m = np.zeros(shape, bool)
    m[max(0, box[1] - grow):min(H, box[3] + grow),
      max(0, box[0] - grow):min(W, box[2] + grow)] = True
    return m


def load_pair(outfit, edit, tag):
    """返回 (基准 RGBA, 铺白底的基准 RGB, 生成图 RGB, (W,H))。坐标系与喂给模型的一致。"""
    base = Image.open(os.path.join(SPRITES, outfit + ".png")).convert("RGBA")
    W, H = base.size
    cw, ch = ceil16(W), ceil16(H)

    canvas = Image.new("RGB", (cw, ch), (255, 255, 255))
    canvas.paste(base, (0, 0), base)
    b = np.asarray(canvas).astype(np.int16)[:H, :W]

    p = os.path.join(WORK, outfit, tag, edit + ".png")
    if not os.path.exists(p):
        raise SystemExit(f"找不到生成图 {p}\n"
                         f"先跑：tools/gen_layers.py {outfit} {edit} "
                         f"--mask-kind {REGION_OF[kind_of(edit)]} --tag {tag}")
    gi = Image.open(p).convert("RGB")
    if gi.size != (cw, ch):
        gi = gi.resize((cw, ch), Image.LANCZOS)
    # 基准放在 (0,0)、只向右/下补白，所以裁 (0,0,W,H) 是精确还原。
    return base, b, np.asarray(gi.crop((0, 0, W, H))).astype(np.int16), (W, H)


def inbox_shift(b, g, mask, radius=4):
    """在 mask 上搜整数平移，看"框内这块内容有没有整体挪位"。

    只搜 ±4：这是"重采样错位"的量级。搜太大就会变成在拟合"哪只眼画得更像"，
    而那不是位移。
    """
    best = (0, 0, None)
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            gr = np.roll(np.roll(g, dy, axis=0), dx, axis=1)
            d = float(np.abs(b - gr).max(axis=2)[mask].mean())
            if best[2] is None or d < best[2]:
                best = (dx, dy, d)
    return best


def build_frame(b, g, soft, balpha):
    """区域帧：alpha = 软掩膜 × 基准 alpha，RGB = 基准与生成图之间的插值。

    RGB 取插值而不是直接取生成图，是为了**过渡带**：生成图是铺在白底上的
    （轮廓外那圈是白色），直接拿它的 RGB，在轮廓的半个像素上就会混进白色 ——
    描边外侧多出一圈白雾。插值到 f=0 时 RGB 恰好等于基准，那圈自然消失。
    """
    f = soft[:, :, None]
    rgb = b.astype(np.float32) * (1 - f) + g.astype(np.float32) * f
    alpha = np.clip(np.round(soft * balpha), 0, 255).astype(np.uint8)
    rgb = np.clip(rgb, 0, 255).astype(np.uint8)
    # 完全透明的像素：RGB 换成常量 0。它们在混色里的权重是 0，
    # 但 PNG 照样要存 —— 而那片是模型输出的逐像素噪声，压缩率极差。
    rgb[alpha == 0] = 0
    return np.dstack([rgb, alpha])


def compose(base, layer):
    """把区域帧叠在基准上 —— 与浏览器里 <img> 叠加**同一条公式**（source-over）。

    这一步不只是为了出对照图：它是"框外逐位等于基准"这句话的检验。
    两个短路分支（alpha 全 1 / 全 0）不是优化，是**保真**：
    没有它们，alpha=0 处会走一遍 `base*a/a` 的浮点往返再截断成整数，
    于是基准的 129 会变成 128 —— 凭空造出 1 级的"差异"。
    浏览器在 alpha=0 的层上本来就等于没叠，这里必须一致，否则量出来的
    那个数既不是真差异、也证明不了任何事。
    """
    ba = np.asarray(base)
    la8 = layer[:, :, 3]
    out = ba.copy()

    full = la8 == 255
    out[full] = layer[full]

    mid = (la8 > 0) & (~full)
    if mid.any():
        la = la8[mid].astype(np.float32)[:, None] / 255.0
        al = ba[mid][:, 3].astype(np.float32)[:, None] / 255.0
        a_out = la + al * (1 - la)
        num = (layer[mid][:, :3].astype(np.float32) * la
               + ba[mid][:, :3].astype(np.float32) * al * (1 - la))
        rgb = np.where(a_out > 0, num / np.maximum(a_out, 1e-6), 0)
        out[mid] = np.concatenate(
            [np.round(np.clip(rgb, 0, 255)), np.round(np.clip(a_out * 255, 0, 255))],
            axis=1).astype(np.uint8)
    return out


def checker_bg(W, H, tile=12):
    yy, xx = np.mgrid[0:H, 0:W]
    c = np.where(((yy // tile) + (xx // tile)) % 2 == 0, 236, 205).astype(np.uint8)
    return np.dstack([c] * 3)


def over_checker(rgba):
    a = rgba[:, :, 3:4].astype(np.float32) / 255.0
    return (rgba[:, :, :3].astype(np.float32) * a
            + checker_bg(rgba.shape[1], rgba.shape[0]) * (1 - a)).astype(np.uint8)


def qa_sheet(base_rgba, layer, comp, box, diff, dst, zoom=3):
    """两行四栏：上行整图（已缩），下行框内放大。

    中栏给的是**合成结果**而不是生成图 —— 生成图整张都被重采样过
    （框外是噪声级的差异），拿它判断画质会把"根本没贴回去的地方"也算进来，
    结论会反过来。第三栏是区域帧本身铺在棋盘底上，用来看 alpha 的分布。

    三个参数都收 ndarray：收 PIL.Image 的话 `over_checker` 里就变成
    "Image 不支持下标"，而报错点在四层调用之前 —— 不值得再踩一次。
    """
    H, W = base_rgba.shape[:2]
    heat = np.zeros((H, W, 3), np.uint8)
    heat[:, :, 0] = np.clip(diff * 4, 0, 255)
    heat[:, :, 1] = np.clip(diff * 4 - 90, 0, 255)
    heat_im = Image.fromarray(heat)
    dr = ImageDraw.Draw(heat_im)
    x0, y0, x1, y1 = [int(v) for v in box]
    dr.rectangle([x0, y0, x1 - 1, y1 - 1], outline=(60, 120, 255), width=2)

    parts = [(Image.fromarray(over_checker(base_rgba)), "基准立绘"),
             (Image.fromarray(over_checker(comp)), "合成结果（区域帧叠上去）"),
             (Image.fromarray(over_checker(layer)), "区域帧本身（棋盘底）"),
             (heat_im, "差异 x4（蓝框=掩膜范围）")]
    for im, lab in parts:
        d = ImageDraw.Draw(im)
        d.rectangle([0, 0, im.width - 1, 18], fill=(255, 255, 255))
        d.text((6, 4), lab, fill=(20, 20, 20))

    # 上行：整图缩到 300 高。这一行只用来确认"没有整只漂"，判断接缝要靠下行。
    th = 300
    tw = int(round(W * 300.0 / H))
    row1 = [im.resize((tw, th), Image.LANCZOS) for im, _ in parts]
    pad = 26
    bx = (max(0, x0 - pad), max(0, y0 - pad), min(W, x1 + pad), min(H, y1 + pad))
    row2 = []
    for im, _ in parts:
        c = im.crop(bx)
        row2.append(c.resize((c.width * zoom, c.height * zoom), Image.LANCZOS))

    gap = 8
    Wt = max(sum(c.width for c in row1) + gap * (len(row1) - 1),
             sum(c.width for c in row2) + gap * (len(row2) - 1))
    Ht = th + gap + row2[0].height
    sheet = Image.new("RGB", (Wt, Ht), (245, 245, 248))
    x = 0
    for c in row1:
        sheet.paste(c, (x, 0)); x += c.width + gap
    x = 0
    for c in row2:
        sheet.paste(c, (x, th + gap)); x += c.width + gap
    sheet.save(dst, optimize=True)
    return dst


def main():
    ap = argparse.ArgumentParser(description="掩膜内整脸重绘 -> 可叠加的区域状态帧")
    ap.add_argument("outfit")
    ap.add_argument("edits", nargs="*", help="留空 = 生成目录里的全部")
    ap.add_argument("--tag", default=DEFAULT_TAG, help=f"生成图所在子目录，默认 {DEFAULT_TAG}")
    ap.add_argument("--thr", type=int, default=DEFAULT_THR, help="判「变了」的阈值")
    ap.add_argument("--only-qa", action="store_true", help="只出对照图，不写素材")
    ap.add_argument("--outdir", default=None, help="素材输出目录，默认 assets/sprites/<套装>/")
    a = ap.parse_args()

    srcdir = os.path.join(WORK, a.outfit, a.tag)
    if not os.path.isdir(srcdir):
        sys.exit(f"没有 {srcdir} —— 先生成：gen_layers.py {a.outfit} "
                 f"--mask-kind <face|mouthbox> --tag {a.tag}")
    edits = a.edits or sorted(os.path.splitext(f)[0] for f in os.listdir(srcdir)
                              if f.endswith(".png") and not f.startswith("_"))

    base_img = Image.open(os.path.join(SPRITES, a.outfit + ".png")).convert("RGBA")
    W, H = base_img.size
    balpha = np.asarray(base_img)[:, :, 3]
    outdir = a.outdir or os.path.join(SPRITES, a.outfit)
    os.makedirs(outdir, exist_ok=True)
    man_path = os.path.join(outdir, "manifest.json")

    # 清单的写法分两种，因为两种调用意图差很远：
    #   · 不给槽位（整批重跑）→ **重建**清单。这六层是同一次重建的产物，
    #     留一条上一版的记录在里头，selftest 会把它当成"素材在、渲染层取不到"报出来。
    #   · 给了槽位（只重做某一帧）→ **合并**进现有清单。整批重写会把其余五层
    #     的记录抹掉，而素材文件还在 —— 那同样会报"素材在、清单里没有"，
    #     排查起来会以为是生成脚本坏了。
    prev = {}
    if a.edits and os.path.exists(man_path):
        try:
            prev = json.load(open(man_path, encoding="utf-8")).get("layers", {}) or {}
        except Exception:
            prev = {}
    manifest = {"outfit": a.outfit, "size": [W, H], "mode": "region-frame",
                "tag": a.tag, "thr": a.thr, "layers": dict(prev)}

    for edit in edits:
        base, b, g, (W, H) = load_pair(a.outfit, edit, a.tag)
        soft, box, feather = region_of(a.outfit, edit)
        feat = feature_px(a.outfit, (H, W))
        opaque = balpha > 200

        # ① 生成图在掩膜外漂了多少 —— "掩膜到底有没有挡住模型"的直接证据。
        #    数应停在 VAE 往返的噪声地板上；明显更大就说明掩膜没生效。
        wide = ~rect((H, W), box, DRIFT_MARGIN)
        gen_off = float(np.abs(b - g).mean(axis=2)[opaque & wide].mean())

        # ② 框内的色偏：整块（带符号）与**过渡带**分开量。分开的理由见文件头
        #    "为什么也不做色阶对齐"——整块的偏差在过渡带上已收敛到 0。
        inner = opaque & (soft >= 0.98) & (~feat)
        ring = opaque & (soft > 0.02) & (soft < 0.98)
        sign = (g.astype(np.float32) - b.astype(np.float32)).mean(axis=2)
        inside_tone = float(sign[inner].mean()) if inner.any() else 0.0
        ring_tone = float(sign[ring].mean()) if ring.any() else 0.0

        # ③ 框内位移：记下来当证据（结论是"不值得修"，见文件头）。
        fdx, fdy, fb = inbox_shift(b, g, inner, 4) if inner.any() else (0, 0, 0.0)
        fz = float(np.abs(b - g).max(axis=2)[inner].mean()) if inner.any() else 0.0

        layer = build_frame(b, g, soft, balpha)
        comp = compose(base, layer)

        # ④ 「框外逐位等于基准」必须是**算出来的**，不能是"按设计如此"。
        #    范围取 roi = 硬框外扩 4σ —— gaussian 的截断半径就是 4σ，
        #    所以这里 alpha 保证为 0，合成结果保证逐位等于基准。
        mg = int(round(ROI_SIGMA * feather))
        roi = [max(0, box[0] - mg), max(0, box[1] - mg),
               min(W, box[2] + mg), min(H, box[3] + mg)]
        outside = ~rect((H, W), box, mg)
        out_max = int(np.abs(comp.astype(np.int16)
                             - np.asarray(base).astype(np.int16)).max(axis=2)[outside].max())
        alpha_outside_max = int(layer[:, :, 3][outside].max())

        diff = np.abs(b - g).max(axis=2)
        hit = (diff > a.thr) & rect((H, W), box)
        changed = int(hit.sum())
        ys, xs = np.where(hit)
        cbox = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1] \
            if len(xs) else list(box)

        name = edit
        dst = os.path.join(outdir, name + ".png")
        rec = {"file": name + ".png", "w": W, "h": H, "kind": kind_of(edit),
               "region": REGION_OF[kind_of(edit)], "mask_box": list(box),
               "mask_feather": feather,
               "box": cbox, "changed": changed, "max_diff": int(diff[rect((H, W), box)].max()),
               "tone_off": round(gen_off, 2),
               "inside_tone": round(inside_tone, 2), "ring_tone": round(ring_tone, 2),
               "inbox_shift": [int(fdx), int(fdy)], "inbox_improve": round(fz - fb, 3),
               "outside_max_diff": out_max, "alpha_outside_max": alpha_outside_max,
               "thr": a.thr, "roi": roi}

        if not a.only_qa:
            Image.fromarray(layer, "RGBA").save(dst, optimize=True)
            manifest["layers"][name] = rec

        qa = qa_sheet(np.asarray(base), layer, comp, box, diff,
                      os.path.join(srcdir, f"_framqa_{edit}.png"))
        kb = (os.path.getsize(dst) / 1024) if not a.only_qa else 0
        print(f"  [{edit}] 区域 {REGION_OF[kind_of(edit)]} 框 {box}  "
              f"改动 {changed}px  maxΔ {rec['max_diff']}")
        print(f"       掩膜外色偏 {gen_off:.2f}   框内带符号 {inside_tone:+.2f}  "
              f"过渡带 {ring_tone:+.2f}   框内位移 ({fdx:+d},{fdy:+d})  改善 {fz - fb:+.3f}")
        print(f"       roi 外最大 alpha {alpha_outside_max} / 最大像素差 {out_max}"
              f"（两个都必须是 0）" + (f"   落盘 {kb:.0f} KB" if kb else ""))
        print(f"       对照图 {os.path.relpath(qa, ROOT)}")

    if not a.only_qa:
        # newline="\n"：不让 Windows 的默认翻译把 LF 变成 CRLF。
        # 不写这一行，清单的**字节内容就随平台变** —— 而 negtest.js 是按文本片段
        # 去改清单来构造故障的，跨平台时那些多行锚点会静默匹配不上
        # （表现是"跳过：替换目标找不到"，看起来像测试自己写错了）。
        with open(man_path, "w", encoding="utf-8", newline="\n") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
        print(f"\n清单 -> {os.path.relpath(man_path, ROOT)}（{len(manifest['layers'])} 层）")
        print("⚠ outside_max_diff / alpha_outside_max 必须恒为 0：前者是实算值，不是设计承诺。")
        print("⚠ 仍然要逐张打开对照图看 —— 数字只说明「变了多少」，说明不了「变得对不对」。")


if __name__ == "__main__":
    main()
