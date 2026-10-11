#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
雪乃桌宠 · 图标生成

产出两样打包必需的东西：
    build/icon.ico      electron-builder 的 win.icon（安装包/桌面快捷方式）
    assets/tray.png     主进程常驻托盘用的图标（32x32）

图标来源就是 assets/sprites/maid.png —— 不去"设计"一个图标，
直接用角色本人的脸，这样任务栏/托盘里一眼能认出来。

用法：
    python tools/make_icons.py            # 生成
    python tools/make_icons.py --check    # 额外输出一张裁剪框预览图，人眼确认
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SPRITE = ROOT / "assets" / "sprites" / "maid.png"
ICON = ROOT / "build" / "icon.ico"
TRAY = ROOT / "assets" / "tray.png"
PREVIEW = ROOT / "_review" / "icon_crop_preview.png"

# 面部方框：**以素材高为单位**的 (中心x, 中心y, 边长)。
#
# 原来写的是绝对像素 (75, 0, 425, 350)，并注明"在 maid.png 的像素坐标里，
# 源图 549x560"。那个写法有两个问题，v3.4 重制素材时一起暴露了：
#   1. 素材一重制（maid 从 544x560 变成 778x800），方框就整体偏到左上角，
#      托盘图标会切成半张脸 —— 而这只在图标上看得出来，极容易漏。
#   2. 注释里的 549x560 和实际 544x560 已经对不上，说明它早就开始漂了。
#
# 改成"素材高的几分之几"之后，方框自动跟着任何尺寸走，而且**天然是正方形**
# （边长与中心都用同一个基准 —— 素材高）。用宽高比当基准会让方框变成长方形：
# 素材不是正方形，横向比例和纵向比例不是同一个数。
#
# 数值由原来的绝对方框换算得到，换算基准是**显示高**：
#   显示时素材一律撑满角色区高 400px，所以"素材高的几分之几"= 显示时的固定像素，
#   换分辨率不会让取景变。
FACE_BOX_REL = (0.4464, 0.3125, 0.625)   # cx=250/560  cy=175/560  边长=350/560


def face_box(img):
    """把相对方框换算成这张图上的像素方框，并夹进图像范围。

    夹边界是必要的：素材换了取景（角色在画布里偏左/偏高）时，
    方框可能有一角越出图像，crop 出来的图会带黑边而不是报错。
    """
    h = img.height
    side = max(8, round(h * FACE_BOX_REL[2]))
    cx = round(h * FACE_BOX_REL[0])
    cy = round(h * FACE_BOX_REL[1])
    x0 = min(max(0, cx - side // 2), max(0, img.width - side))
    y0 = min(max(0, cy - side // 2), max(0, h - side))
    return (x0, y0, min(img.width, x0 + side), min(h, y0 + side))

# 安装包图标用整幅立绘，四周留一点边距，贴边会显得很挤
ICON_PAD = 1.14

ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def square_pad(im, pad=1.0):
    """补成透明正方形，角色居中 —— 保证缩放到任意尺寸都不变形。"""
    s = int(max(im.width, im.height) * pad)
    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    canvas.paste(im, ((s - im.width) // 2, (s - im.height) // 2), im)
    return canvas


def tray_icon(face, size=32):
    """托盘图标：浅色圆角底片 + 人脸。

    为什么不直接把人脸抠图丢进托盘：她是深色头发，而 Windows 任务栏
    多半是深色的，纯透明底的深色头放在上面基本糊成一片。
    垫一层浅底片，深浅任务栏都看得清。
    """
    S = size * 4                      # 先按 4 倍画，再降采样，边缘才不糊
    bg = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(bg).rounded_rectangle([0, 0, S - 1, S - 1],
                                         radius=int(S * 0.22), fill=(246, 247, 251, 255))
    fg = square_pad(face).resize((int(S * 0.88),) * 2, Image.LANCZOS)
    bg.paste(fg, ((S - fg.width) // 2, (S - fg.height) // 2), fg)
    return bg.resize((size, size), Image.LANCZOS)


def main():
    if not SPRITE.exists():
        raise SystemExit(f"找不到素材：{SPRITE}")

    src = Image.open(SPRITE).convert("RGBA")
    box = face_box(src)

    # ---- 安装包图标：整个立绘补成正方形 ----
    ICON.parent.mkdir(parents=True, exist_ok=True)
    icon = square_pad(src, ICON_PAD)
    icon.save(ICON, format="ICO", sizes=ICO_SIZES)
    print("icon.ico  ->", ICON, icon.size)

    # ---- 托盘图标：只取脸，32x32 ----
    tray = tray_icon(src.crop(box), 32)
    tray.save(TRAY, format="PNG")
    print("tray.png  ->", TRAY, tray.size, " 取景方框:", box, "（素材 %dx%d）" % src.size)

    if "--check" in sys.argv:
        # 裁剪框预览：大图 + 红框 + 右侧实际 32px 效果放大
        PREVIEW.parent.mkdir(exist_ok=True)
        big = src.copy()
        d = ImageDraw.Draw(big)
        d.rectangle(box, outline=(220, 40, 40), width=3)
        big = big.resize((big.width * 2, big.height * 2), Image.NEAREST)

        tray_big = tray.resize((160, 160), Image.NEAREST)
        W = big.width + 200
        H = max(big.height, 200)
        sheet = Image.new("RGB", (W, H), (248, 249, 251))
        for by in range(0, H, 14):
            for bx in range(0, W, 14):
                if (bx // 14 + by // 14) % 2 == 0:
                    d2 = ImageDraw.Draw(sheet)
                    d2.rectangle([bx, by, bx + 13, by + 13], fill=(240, 242, 246))
        sheet.paste(big, (0, (H - big.height) // 2), big)
        sheet.paste(tray_big, (big.width + 20, 20), tray_big)
        try:
            f = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 15)
        except Exception:
            f = ImageFont.load_default()
        ImageDraw.Draw(sheet).text((big.width + 20, 190), "tray.png 放大 5x", fill=(50, 56, 72), font=f)
        sheet.save(PREVIEW)
        print("preview   ->", PREVIEW)


if __name__ == "__main__":
    main()
