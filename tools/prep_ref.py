# -*- coding: utf-8 -*-
"""预处理参考图：把「手机截图」整成抠图工具能吃的干净图。

为什么需要这一步（不是多此一举）：
  用户拿到的参考图往往是**手机相册里的截图**，不是原始插画文件。
  截图上会带着一堆东西 —— 顶部状态栏、上下灰边、底部操作栏、
  下载 App 的水印，以及"透明 PNG 被显示成棋盘格后再截屏"导致的
  棋盘纹理。这些东西直接丢给抠图工具会有两种下场：
    * 界面残留（灰带/黑条）因为不满足"白色背景"假设，
      会被整体判定成前景，抠出来的角色外面套着一圈矩形色块；
    * 棋盘格的暗格（~242）比 cut.py 的白色阈值（244）还低，
      于是整片背景都变成前景，抠出来是一张带网点纹理的实心块。

本工具只做三件事，做完就交给 cut.py / anime_cut.py：
  1. 找内容带：逐行判定"界面残留行"（整行又暗又均匀），
     取最长的连续非残留行段作为画面内容区；
  2. 按给定区间裁切（可选，用于精确切掉水印或多余留白）；
  3. 落盘成 PNG。

棋盘格背景**不在这里处理** —— 它不是"界面残留"，而是"背景色不是纯白"，
属于抠图工具的份内事：cut.py 从图像四边估背景色再按容差判定连通性，
棋盘格的暗格（~242）与背景色距离很小，会整体被判成背景吃掉。
（曾经以为这种底必须上 isnet 分割模型，实测是错的 —— 见 build_assets.py 的说明。）

用法：
    python tools/prep_ref.py <src> <dst>
    python tools/prep_ref.py <src> <dst> --crop 700,1560
    python tools/prep_ref.py <src> <dst> --probe        # 只打印检测结果
"""
import sys

import numpy as np
from PIL import Image

# 界面残留行的判定：整行又暗又均匀。
#   状态栏 / 操作栏   —— 亮度十几到几十，标准差 < 6
#   上下灰带          —— 亮度 ~85 / ~104 / ~29，标准差 1 左右
# 而画面内容行永远不满足：哪怕全是白底，只要有角色，标准差就上去了。
UI_ROW_LUM = 230
UI_ROW_STD = 6.0
MIN_BAND = 40          # 太短的段不算内容带（避免把状态栏的空白行认成内容）


def content_band(a):
    """返回 (y0, y1)：最长的连续"非界面残留"行段。"""
    lum = a.mean(2)
    keep = ~((lum.mean(1) < UI_ROW_LUM) & (lum.std(1) < UI_ROW_STD))
    bands, start = [], None
    for y, k in enumerate(keep):
        if k and start is None:
            start = y
        elif not k and start is not None:
            bands.append((start, y - 1))
            start = None
    if start is not None:
        bands.append((start, len(keep) - 1))
    bands = [b for b in bands if b[1] - b[0] >= MIN_BAND]
    if not bands:
        raise SystemExit("找不到内容带：整张图都像界面残留？")
    return max(bands, key=lambda b: b[1] - b[0])


def parse(argv):
    opt = {"crop": None, "probe": False}
    pos = []
    i = 0
    while i < len(argv):
        t = argv[i]
        if t == "--crop":
            i += 1
            opt["crop"] = tuple(int(v) for v in argv[i].split(","))
        elif t == "--probe":
            opt["probe"] = True
        else:
            pos.append(t)
        i += 1
    return pos, opt


def main():
    pos, opt = parse(sys.argv[1:])
    if len(pos) < 1:
        raise SystemExit(__doc__)
    src = pos[0]
    im = Image.open(src).convert("RGB")
    a = np.asarray(im).astype(np.float32)
    auto = content_band(a)
    y0, y1 = opt["crop"] if opt["crop"] else auto
    y0 = max(0, y0)
    y1 = min(im.height - 1, y1)
    print("%s  %s" % (src, (im.width, im.height)))
    print("   自动内容带 %s   实际裁切 %d~%d (高 %d)" % (auto, y0, y1, y1 - y0 + 1))
    if opt["probe"] or len(pos) < 2:
        return
    out = im.crop((0, y0, im.width, y1 + 1))
    out.save(pos[1])
    print("   -> %s  %s" % (pos[1], (out.width, out.height)))


if __name__ == "__main__":
    main()
