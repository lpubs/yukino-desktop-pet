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

# 面部方框（在 maid.png 的像素坐标里，源图 549x560）。
# 由 --check 输出的预览图目视标定：上边压在发饰顶上、下边过下巴一点，
# 让 32px 的托盘图标里整张脸都在框内，而不是切掉下巴或塞满黑头发。
FACE_BOX = (75, 0, 425, 350)      # 350x350 正方形

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

    # ---- 安装包图标：整个立绘补成正方形 ----
    ICON.parent.mkdir(parents=True, exist_ok=True)
    icon = square_pad(src, ICON_PAD)
    icon.save(ICON, format="ICO", sizes=ICO_SIZES)
    print("icon.ico  ->", ICON, icon.size)

    # ---- 托盘图标：只取脸，32x32 ----
    tray = tray_icon(src.crop(FACE_BOX), 32)
    tray.save(TRAY, format="PNG")
    print("tray.png  ->", TRAY, tray.size)

    if "--check" in sys.argv:
        # 裁剪框预览：大图 + 红框 + 右侧实际 32px 效果放大
        PREVIEW.parent.mkdir(exist_ok=True)
        big = src.copy()
        d = ImageDraw.Draw(big)
        d.rectangle(FACE_BOX, outline=(220, 40, 40), width=3)
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
