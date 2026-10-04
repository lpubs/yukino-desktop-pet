# -*- coding: utf-8 -*-
"""动漫角色抠图（**备用路径**）：isnet-anime 出掩膜 -> 交给 cut.py 收尾。

⚠️ 默认流程不走这里。四套装扮全部由 `tools/cut.py` 纯 Python 抠完，
   见 `build_assets.py` 与 README 第三节。本脚本只在"背景连连通性都分不出"
   的情况下才有必要，目前这个项目的四张图都不属于这种情况。

本脚本需要 models/isnetis.onnx（176MB，不在仓库里，见 README 第九节）。


它当初是怎么被引入的，又是怎么被证伪的
--------------------------------------
上一版（v3.1）的判断是：`cut.py` 的确定性抠图建立在一条假设上 ——
"只有与图像四边连通的白色才是背景"。于是给 B/C 两张图判了死刑：

  B 水手服 —— 背景是一整片低饱和灰白**拼贴**：同一角色的多张脸、手写体英文、
             蝴蝶、纸片。感觉上与主人物颜色完全不可分，连通性也不成立。
  C 冬大衣 —— 大面积浅色留白 + 大量飘散的发丝与半透明笔触。

**这个判断是错的。** 真正的病根是 `cut.py` 当时把背景色**写死**成
`min(RGB) >= 244`，而 C 的棋盘格暗格是 ~242 —— 正好卡在阈值下面；
B 的问题则是 flood fill 用了 8-连通，从抗锯齿描边的对角缝隙挤进了角色内部。

改成"从四边取中位数估背景色 + 4-连通 + 反预乘 + 剥浅色边"之后，
两张图的纯 Python 结果**比模型版更干净**（B 的贝雷帽灰雾、C 的发梢白雾、
A 被吃掉的头饰蕾丝，全部消失），而且可复现、可逐行调试、少 176MB 依赖。

所以结论是：**方法够用，只是参数写死了。**
如果你遇到的是真正连通性不成立的情况（背景与主体同色且边界模糊到不该用轮廓线判定），
这条路仍然是可用的 —— 模型掩膜会作为 `--alpha` 交给 `cut.py` 走同一套收尾。

模型出处与校验：huggingface 镜像 skytnt/anime-seg，官方 md5
  6f184e756bb3bd901c8849220a83e38e
本脚本会校验，不一致直接报错退出（模型不对时抠出来的东西会莫名其妙地差，
而且是静默地差 —— 这种事只能靠校验挡住）。

用法:
  anime_cut.py <src> <dst> [--target 560] [--border 9] [--probe]
  --probe  只导出掩膜预览到 _review/，不产出素材。
"""
import argparse
import hashlib
import os
import subprocess
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REVIEW = os.path.join(ROOT, "_review")
MODEL = os.path.join(ROOT, "models", "isnetis.onnx")
MODEL_MD5 = "6f184e756bb3bd901c8849220a83e38e"

# 预处理严格照 rembg 的 DisSession（isnet-anime 的官方定义）：
#   x/255 -> (x - mean) / 1.0，输入 1024x1024
# 输出做 min-max 归一化，再用 LANCZOS 缩回原尺寸。
# 自己写而不直接调 rembg，是为了让这条管线不依赖 rembg 的模型目录约定，
# 也让"到底喂了什么进去"这件事在代码里看得见。
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
SIZE = 1024

# 高置信阈值。实测：模型在真实主体上基本饱和（≥245），
# 而背景里那些"同样像动漫角色"的拼贴块最高只到 136。
# 所以直接用高阈值取主体，不搞阈值扫描 —— 扫描的结果是头发和贝雷帽先烂掉。
STRONG = 245

# 拼贴误检有一个共同外观：**被洗白、贴在浅色纸上的图层** —— 低饱和 + 高亮度。
# 人物身上则要么有颜色（皮肤 / 开衫 / 眼睛），要么是暗部（头发 / 贝雷帽阴影）。
# 这条门只作用在高置信掩膜上，是"否决项"而不是"发现项"：
# 它只能删掉模型已经认定为主体的像素，不会凭空扩大前景。
# 实测 B 图：主人物头发 V=141、贝雷帽 V=149、脸 S=44、开衫 S=37（全部通过），
# 而左邻拼贴脸 S=7 V=215、左上纸片 S=9 V=232、右上角 S=7 V=225（全部挡掉）。
GATE_S, GATE_V = 18, 190

_session = None


def session():
    global _session
    if _session is None:
        import onnxruntime as ort
        _session = ort.InferenceSession(MODEL, providers=["CPUExecutionProvider"])
    return _session


def verify_model():
    if not os.path.exists(MODEL):
        sys.exit(
            f"缺少模型: {MODEL}\n"
            "  这是**备用路径**，默认抠图流程（tools/cut.py）不需要模型。\n"
            "  确实要用的话，从 hf-mirror 下载 skytnt/anime-seg 的 isnetis.onnx 放到该路径\n"
            "  （176MB，超过 GitHub 单文件上限，所以没有随仓库发布）。"
        )
    h = hashlib.md5(open(MODEL, "rb").read()).hexdigest()
    if h != MODEL_MD5:
        sys.exit(f"模型 md5 不符，抠图结果会静默变差，拒绝继续。\n  实际 {h}\n  期望 {MODEL_MD5}")


def mask_of(img, gate=True):
    """返回与原图同尺寸的 uint8 灰度掩膜（0/255）。"""
    im = img.convert("RGB").resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    a = np.asarray(im).astype(np.float32)
    a = a / max(float(a.max()), 1e-6)
    a = (a - MEAN).transpose(2, 0, 1)[None]
    out = session().run(None, {"img": a.astype(np.float32)})[0]
    pred = np.squeeze(out[:, 0])
    mi, ma = float(pred.min()), float(pred.max())
    pred = (pred - mi) / max(ma - mi, 1e-6)
    m = Image.fromarray((pred * 255).astype(np.uint8), mode="L")
    m = np.asarray(m.resize(img.size, Image.Resampling.LANCZOS))

    fg = m > STRONG
    if gate:
        rgb = np.asarray(img.convert("RGB")).astype(np.int16)
        sat = rgb.max(2) - rgb.min(2)
        val = rgb.max(2)
        fg &= (sat > GATE_S) | (val < GATE_V)
    from scipy import ndimage
    fg = ndimage.binary_fill_holes(fg)
    return np.where(fg, 255, 0).astype(np.uint8)


def probe(src, tag):
    """把掩膜 / 抠图结果 / 棋盘底合成并排导出，供肉眼验收。"""
    img = Image.open(src).convert("RGB")
    m = mask_of(img)
    Image.fromarray(m, "L").save(os.path.join(REVIEW, f"_alpha_{tag}.png"))

    rgba = np.dstack([np.asarray(img), m]).astype(np.uint8)
    comp = Image.fromarray(rgba, "RGBA")
    H = 520
    def fit(im):
        w = max(1, int(round(im.width * H / im.height)))
        return im.resize((w, H), Image.LANCZOS)

    tiles = [("原图", fit(img)), ("isnet-anime 掩膜", fit(Image.fromarray(m, "L").convert("RGB")))]
    board = Image.new("RGB", (fit(comp).width, H), (245, 246, 250))
    for by in range(0, H, 16):
        for bx in range(0, board.width, 16):
            if (bx // 16 + by // 16) % 2 == 0:
                board.paste((232, 235, 242), (bx, by, min(bx + 16, board.width), min(by + 16, H)))
    c = fit(comp)
    board.paste(c, (0, 0), c)
    tiles.append(("抠图结果（棋盘底）", board))

    from PIL import ImageDraw, ImageFont
    f = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 16)
    W = sum(t.width for _, t in tiles) + 16 * (len(tiles) - 1)
    sheet = Image.new("RGB", (W, H + 28), (250, 250, 252))
    dr = ImageDraw.Draw(sheet)
    x = 0
    for lab, t in tiles:
        dr.text((x + 4, 6), lab, fill=(30, 34, 46), font=f)
        sheet.paste(t, (x, 28))
        x += t.width + 16
    dst = os.path.join(REVIEW, f"probe_{tag}.png")
    sheet.save(dst)
    on = (m > 127).mean() * 100
    print(f"  {tag}: 前景占比 {on:.1f}%  -> {dst}", flush=True)
    return dst


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst", nargs="?")
    ap.add_argument("--target", type=int, default=560)
    ap.add_argument("--border", type=int, default=9)
    ap.add_argument("--probe", action="store_true")
    a = ap.parse_args()

    os.makedirs(REVIEW, exist_ok=True)
    verify_model()
    tag = os.path.splitext(os.path.basename(a.src))[0].split("_")[0]

    if a.probe:
        probe(a.src, tag)
        return

    if not a.dst:
        sys.exit("缺少 dst")

    m = mask_of(Image.open(a.src).convert("RGB"))
    apng = os.path.join(REVIEW, f"_alpha_{tag}.png")
    Image.fromarray(m, "L").save(apng)
    # 掩膜交给 cut.py —— 去碎屑、最大连通主体、抗锯齿收敛、白描边、裁包围盒、
    # 等比缩放这六步与 A/D 完全共用，风格不会跑偏。
    subprocess.run(
        [sys.executable, os.path.join(HERE, "cut.py"), a.src, a.dst,
         "--alpha", apng, "--target", str(a.target), "--border", str(a.border)],
        check=True, cwd=ROOT)


if __name__ == "__main__":
    main()
