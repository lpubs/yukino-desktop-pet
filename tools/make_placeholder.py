#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
雪乃桌宠 · 占位素材生成

公开仓库里**不包含**角色立绘（形象版权归原作者，见 DISCLAIMER.md），
只放这套程序画出来的纯几何灰色占位图。文件名与真素材完全一致，
所以克隆下来直接就能跑、能打包 —— 只是画面里是一个灰块剪影。

**换成你自己的素材**：把同名 PNG 覆盖到 assets/sprites/ 下即可。
四张的宽高可以各不相同（窗口按高度锚定，见 README 第六节）。
本表的尺寸刻意抄的是**当前真素材**的尺寸，所以它同时也是
"用满源、不放大"那条规则的样本：四套高度并不相同（800/800/762/790），
而 selftest 卡的是**宽高比**（≤ BASE_W/PET_H）而不是绝对高矮。

生成完记得跑一次 tools/make_icons.py 重做 build/icon.ico 与 assets/tray.png，
否则托盘和安装包图标还是占位图的脸。

用法：
    python tools/make_placeholder.py              # 写入 assets/sprites/
    python tools/make_placeholder.py --out DIR    # 写到别的目录（不覆盖真素材）
"""

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent

# 与真素材一一对应的尺寸。故意保持不同的宽**和不同的高**：
# 窗口是按高度锚定的，显示高一律撑满角色区；素材高只决定"像素密度"，
# 由源分辨率决定（见 tools/build_assets.py 的「用满源，不放大」）。
# 占位图照抄这套差异，才能真实地暴露"素材太宽会被窗口裁掉两侧"这类问题
# （selftest 的 [2b-2] 就在按宽高比卡这个）。
SIZES = {
    "maid":   (778, 800),
    "sailor": (376, 800),
    "coat":   (560, 762),
    "winter": (413, 790),
}

LABEL = {
    "maid":   "女仆装",
    "sailor": "水手服",
    "coat":   "冬大衣",
    "winter": "冬装",
}

BODY = (158, 164, 178, 232)
EDGE = (104, 110, 126, 255)
INK = (72, 78, 96, 255)
MUTED = (120, 126, 142, 255)

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhl.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    "/System/Library/Fonts/PingFang.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
]


def font(size):
    for p in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    return ImageFont.load_default()


def centered(d, text, f, cx, y, fill):
    """按实际渲染宽度居中 —— 中文字体的 bbox 左右不对称，不能靠估算。"""
    box = d.textbbox((0, 0), text, font=f)
    d.text((cx - (box[2] - box[0]) / 2 - box[0], y), text, font=f, fill=fill)


def draw_silhouette(w, h, name):
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    cx = w / 2.0

    # 肩线：头底下一点，躯干从这里往下张开到画布底
    shoulder = h * 0.30
    half_top = w * 0.19
    half_bot = w * 0.43

    # 躯干（下宽上窄的梯形）。用 polygon 而不是矩形，剪影才像"个人"。
    d.polygon(
        [(cx - half_top, shoulder), (cx + half_top, shoulder),
         (cx + half_bot, h), (cx - half_bot, h)],
        fill=BODY,
    )

    # 头：椭圆压扁一点，别做成正圆（正圆看着像图标不像剪影）
    hr = min(w * 0.32, h * 0.175)
    d.ellipse([cx - hr, shoulder - hr * 1.62, cx + hr, shoulder + hr * 0.34],
              fill=BODY)

    # 脖子：把头和肩之间那道缝补上，否则中间会透出一条透明横带
    d.rectangle([cx - hr * 0.34, shoulder - hr * 0.5, cx + hr * 0.34, shoulder + 8],
                fill=BODY)

    # 描边：跟真素材的"贴纸白边"呼应一下，一眼看出这是个占位方块
    d.ellipse([cx - hr, shoulder - hr * 1.62, cx + hr, shoulder + hr * 0.34],
              outline=EDGE, width=3)
    d.line([(cx - half_top, shoulder), (cx - half_bot, h)], fill=EDGE, width=3)
    d.line([(cx + half_top, shoulder), (cx + half_bot, h)], fill=EDGE, width=3)
    return im


def annotate(im, name):
    """在胸口位置写「占位素材 / 请自备立绘」+ 装扮名。

    字体大小跟着宽度走 —— sailor 只有 263px 宽，用大字号会撑出画布。
    """
    w, h = im.size
    d = ImageDraw.Draw(im)
    cx = w / 2.0

    f_main = font(max(13, int(min(w * 0.115, h * 0.052))))
    f_name = font(max(11, int(min(w * 0.088, h * 0.040))))

    y0 = h * 0.56
    centered(d, "占位素材", f_main, cx, y0, INK)
    centered(d, "请自备立绘", f_main, cx, y0 + f_main.size * 1.35, INK)
    # 装扮名单独一行、淡一点，避免和上面两行抢注意力
    centered(d, LABEL[name], f_name, cx, y0 + f_main.size * 2.95, MUTED)
    return im


def dashed_frame(im):
    """最外圈虚线框 —— 截图/缩略图里一眼能认出"这是占位图，不是成品"。"""
    w, h = im.size
    d = ImageDraw.Draw(im)
    step, dash, inset = 16, 9, 4
    for x in range(inset, w - inset, step):
        d.line([(x, inset), (min(x + dash, w - inset), inset)], fill=EDGE, width=2)
        d.line([(x, h - inset - 1), (min(x + dash, w - inset), h - inset - 1)],
               fill=EDGE, width=2)
    for y in range(inset, h - inset, step):
        d.line([(inset, y), (inset, min(y + dash, h - inset))], fill=EDGE, width=2)
        d.line([(w - inset - 1, y), (w - inset - 1, min(y + dash, h - inset))],
               fill=EDGE, width=2)
    return im


def build(name):
    w, h = SIZES[name]
    return dashed_frame(annotate(draw_silhouette(w, h, name), name))


def main():
    ap = argparse.ArgumentParser(description="生成四张灰色占位立绘")
    ap.add_argument("--out", default=str(ROOT / "assets" / "sprites"),
                    help="输出目录，默认 assets/sprites")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    for name in SIZES:
        im = build(name)
        dst = out / f"{name}.png"
        im.save(dst, format="PNG", optimize=True)
        print(f"  {dst}  {im.width}x{im.height}  {dst.stat().st_size / 1024:.1f} KB")

    print("\n换真素材：把同名 PNG 覆盖上去，然后重跑 tools/make_icons.py。")


if __name__ == "__main__":
    main()
