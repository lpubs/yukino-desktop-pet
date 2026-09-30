# -*- coding: utf-8 -*-
"""
素材预处理脚本（一次性工具）
- 对四张参考图做抠图（rembg，只做背景透明化，不重绘、不改色、不加配饰）
- 背景上的拼贴文字/水印不在主体上，抠图后自动消失
- 按"头部对齐"统一缩放并放入 440x640 统一画布（头部中心固定在同一个点上）
- 输出 assets/outfits/outfit1~4.png，以及对齐预览图 tools/preview.png

用法:
  python prepare_assets.py             # 全流程（首次会下载 u2net 模型）
  python prepare_assets.py --no-cut    # 跳过抠图，只用已有 cut*.png 重新对齐

参数调整: 改下面的 ALIGN（原图中的像素坐标估计值），跑完看 preview.png 校对微调。
"""

import os
import sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
INPUT_DIR = os.path.join(HERE, "input")
OUT_DIR = os.path.join(ROOT, "assets", "outfits")
PREVIEW = os.path.join(HERE, "preview.png")

CANVAS_W, CANVAS_H = 440, 640   # 统一画布（窗口内按 0.5 显示为 220x320）
# 注：早期版本这里还有一个 TARGET_HEAD_H（按"头高归一"缩放），改成显式 scale（眼距归一）后
# 就不再使用了，已删除，避免误改。
HEAD_TOP_Y = 30                 # 头顶在画布上的 y
HEAD_CX = CANVAS_W // 2         # 头部中心 x

# 每张图的头部定位参数（原图坐标，基于网格读数）
#   head_top: 最顶端(发顶/帽顶) y —— 该点统一落在画布 y=30
#   head_cx : 脸部中心 x —— 该点统一落在画布 x=220
#   scale   : 显式缩放（按"眼距归一"手工标定，保证四套图眼睛大小一致）
ALIGN = {
    1: {"src": "outfit1_src.jpg", "head_top": 88,  "head_cx": 428, "scale": 0.65},
    2: {"src": "outfit2_src.png", "head_top": 18,  "head_cx": 295, "scale": 0.70},
    3: {"src": "outfit3_src.png", "head_top": 85,  "head_cx": 318, "scale": 0.39},
    4: {"src": "outfit4_src.png", "head_top": 15,  "head_cx": 285, "scale": 0.39},
}


def cutout(idx: int, p: dict) -> Image.Image:
    """抠图（只透明化背景），结果缓存为 cutN.png"""
    cut_path = os.path.join(HERE, f"cut{idx}.png")
    if os.path.exists(cut_path):
        return Image.open(cut_path).convert("RGBA")
    from rembg import remove
    src = os.path.join(INPUT_DIR, p["src"])
    print(f"[outfit{idx}] rembg 抠图中: {p['src']}")
    im = Image.open(src).convert("RGBA")
    out = remove(im)
    out.save(cut_path)
    return out


def process(idx: int, recut: bool = False) -> Image.Image:
    p = ALIGN[idx]
    path = os.path.join(HERE, f"cut{idx}.png")
    if recut and os.path.exists(path):
        os.remove(path)
    cut = cutout(idx, p)

    # 按 alpha 包围盒裁掉多余透明边，同时记录偏移用于坐标换算
    bbox = cut.getchannel("A").getbbox()
    ox, oy = bbox[0], bbox[1]
    cut = cut.crop(bbox)

    # 显式 scale（眼距归一），头顶锚在 y=30、脸部中心锚在 x=220
    scale = p["scale"]
    new_w = max(1, int(cut.width * scale))
    new_h = max(1, int(cut.height * scale))
    cut = cut.resize((new_w, new_h), Image.LANCZOS)

    head_top_in_cut = (p["head_top"] - oy) * scale
    face_cx_in_cut = (p["head_cx"] - ox) * scale

    canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    px = int(round(HEAD_CX - face_cx_in_cut))
    py = int(round(HEAD_TOP_Y - head_top_in_cut))
    canvas.paste(cut, (px, py), cut)
    print(f"[outfit{idx}] scale={scale:.3f} paste=({px},{py}) body={new_w}x{new_h}")
    return canvas


def main():
    recut = "--no-cut" not in sys.argv
    os.makedirs(OUT_DIR, exist_ok=True)
    sheet = Image.new("RGBA", (CANVAS_W * 4, CANVAS_H), (235, 235, 240, 255))
    for i in range(1, 5):
        out = process(i, recut=recut)
        out.save(os.path.join(OUT_DIR, f"outfit{i}.png"))
        sheet.paste(out, (CANVAS_W * (i - 1), 0), out)
    sheet.save(PREVIEW)
    print("对齐预览图:", PREVIEW)


if __name__ == "__main__":
    main()
