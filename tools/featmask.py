# -*- coding: utf-8 -*-
"""从立绘里定位五官，生成**软边掩膜**，交给 ComfyUI 做潜空间局部重绘。

## 这张掩膜解决的是哪一步

差分图层方案的第一版直接让 Qwen 改图，结果它把**整张重画了**：
对照图里她的姿势、发丝、衣服细节全变了，未改动区平均色偏 27 级。
这不是提示词写得不够狠 —— **4 步蒸馏 + cfg 1.0 的编辑模型本来就会重绘**，
而"其他地方别动"这句约束在 cfg=1.0 下是失效的（负向分支被约掉了，见 gen_layers.py）。

所以真正的解法不是把话说死，而是**换工具**：用潜空间掩膜（`SetLatentNoiseMask`）
把去噪范围硬性圈住 —— 掩膜外那份 latent 就是基准图的编码，采样器根本不会去动它。
模型漂移的冲动还在，但它够不着别的地方了。

## 这张掩膜为什么是「每个五官一个椭圆」而不是靠颜色自动分割

试过按瞳色阈值自动找眼睛（项目 `mkexpr.py` 的老办法）。实测**不可靠**：

    左上眼饱和瞳色块 18x20 像素，但整只眼占 55x55；
    右眼更悬殊，饱和块 13x23，整只眼 110x70。

saturation 高的只是虹膜上那几块高光，用它的外接框按固定倍数外扩，
两只眼的倍数差了 2.5 倍 —— 这只说明「自动分割在眼皮上是猜」。

于是改成**人工标定的椭圆表**。这不是退步：
标定一次只要几分钟，而它可以被**逐张看图核对**（`--qa` 输出叠加图），
自动分割错了却不会有任何提示。表的三个数（中心、横径、纵径）
分别对应"眼在哪、眼多宽、眼多高"，改起来也直观。

## 加掩膜的两个解剖学细节

  - **眼**：闭合时上眼睑从睫毛线**往下落**，所以掩膜上边只要略高于睫毛线，
    下边却要盖到原来的下眼睑之外一点。
  - **嘴**：张嘴是**往下长**的，所以下边必须留出余量，否则"张嘴"会被裁成一条线。
"""
import argparse
import json
import os

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SPRITES = os.path.join(ROOT, "assets", "sprites")
WORK = os.path.join(ROOT, "_layerwork")

# 人工标定的五官椭圆：(中心x, 中心y, 横半径, 纵半径)，单位 = 立绘像素。
# 标定依据写在每套上方的注释里，改任何一个数都要重跑 `--qa` 看一眼。
#
# ★ 以下划线开头的键**不是椭圆**，是这一套的显式框：
#     `_face`  整张脸的框（生成与验收用的实际范围）
#     `_mouth` 嘴区的框
#     `_hem`   下装的框（走动帧的重绘范围，v3.11）。**只圈裙子，不含腿和袜子** ——
#              理由不是保守，是实拍出来的：立绘在画面**下缘**就把腿裁断了（脚不在画面里），
#              框一旦含住袜子，模型要"迈步"就只能凭空造出脚和鞋，
#              实测出来是**另一副姿态**（双腿交叉 + 一只伸到画面外的黑鞋）。
#              收到裙子上之后，改动有界、两帧互为镜像，而且和 #petWrap 的左右倾同向。
#   为什么要显式给：原来框是"所有椭圆并集 + 一个常量外扩"推出来的，而那个常量
#   只对 maid 成立 —— 它的嘴椭圆下缘 +46 恰好压到下巴，纯属巧合。
#   四套立绘的脸大小差一倍（maid 脸宽 ~290、sailor ~200），同一个常量在 sailor 上
#   就会把下巴留在框外。框是**实际被重画的范围**，它该由逐套核对决定，不该由巧合决定。
#   （椭圆仍然保留：`feature_px()` 要用它把"本来就该变的五官像素"排除掉，
#     老的椭圆掩膜 `build()` 也还在，供对照。）
#
# ★ `_hem` 为什么只有 winter 有：**走动帧只在能看见下身的那套上成立**。
#   逐套量过（`--hem-qa` 出的刻度图，数字在 README）：
#     winter  全身像，格子裙 y≈614~722 = 立绘高的 13.7%（显示到 400px 高时约 54px）
#     sailor  胸像到裙摆，裙摆只剩 y≈730~800 = **高的 8.75%**（显示时约 35px）
#     maid    胸像，底下全是长发，没有下装可动
#     coat    胸像，底下是黑大衣下摆＋长发
#   桌面显示尺寸下的可见度是量过的：源图 20px 的横向位移 = 显示 10px，
#   要放大到 4 倍才勉强分辨得出。8.75% 那条带子摆起来**看不见** ——
#   加一层看不见的素材不是"没效果"，是多一处接缝风险 + 一份要维护的清单。
#   所以 sailor/maid/coat 刻意**不给** `_hem`：`hem_box()` 会直接报错，
#   而不是安静地生成一层永远看不出来的东西。
#
# 标定方法（可复现，别凭感觉改）：
#   1. `python tools/featmask.py <套装> <kind> --qa` 出叠加图，看椭圆有没有圈住五官；
#   2. 肉眼**读不出**准坐标（试过两张网格标尺图，换算出的原图坐标有 ±30px 误差）——
#      所以判定标准是"圈住没圈住"，不是"读出来的数是多少"；
#   3. 框的判定标准是"边落在头发/轮廓上，没切在脸颊中间，且盖住下巴"。
FEATURES = {
    "maid": {
        # 立绘 778x800。两条**互相独立**的测量互相印证：
        #   ① 瞳色（高饱和的青蓝）质心：左 (297,344)  右 (411,289)
        #   ② 眼白（被睫毛线围住的封闭亮块，min(RGB)>240）：
        #        左 (272,337)-(291,360)   右 (377,281)-(407,306) + 外眼角高光 (432,265)-(442,294)
        # 两者拼出的眼球范围：左 x≈262~320 y≈305~368；右 x≈370~452 y≈245~310。
        # 椭圆再各向外放一圈 —— 眼要给"眼皮落下"留位置，嘴要给"张开"留位置。
        "eyeL": (292, 340, 42, 38),
        "eyeR": (409, 288, 50, 40),
        "mouth": (360, 401, 30, 21),
        # 这两个值就是 v3.10 上线时实际用的框（= 椭圆并集 + 46 / 嘴椭圆 + 那圈不对称余量），
        # 逐字写下来是为了让"用什么范围生成的"不再依赖一个常量。数值没变 ⇒ 素材不用重生成。
        "_face": (204, 202, 505, 468),
        "_mouth": (300, 372, 420, 456),
    },
    "sailor": {
        # 立绘 376x800（只有 maid 一半宽，脸也小一半）。
        # 眼睛位置用"窗口内最暗像素质心"（睫毛线）先估，再按 `--qa` 叠加图逐轮修正 ——
        # 前两轮各偏了 10~30px，第三轮（带 25px 网格标尺的那张）才收敛。
        # 手举在左下方比 V，嘴区左边界刻意收窄到 171 是为了**躲开手指**：
        # 嘴帧会重画框内全部像素，手指进框就会被一起重画。
        "eyeL": (175, 220, 45, 36),
        "eyeR": (272, 224, 46, 34),
        "mouth": (207, 302, 22, 16),
        "_face": (62, 132, 368, 386),
        "_mouth": (171, 279, 249, 344),
    },
    "coat": {
        # 立绘 560x762。眼睛被刘海压住大半，只露下半 —— 这不妨碍眨眼帧：
        # 模型看到的是整张脸，它知道刘海下面是眼睑。
        # ★ 嘴被围巾**完全**遮住（`--qa` 上蓝框整个落在围巾上），所以这套**不做 mouth 层**，
        #   也刻意不给嘴椭圆：`mouth_box()` 会直接报错。宁可报错，也不要让它安静地
        #   生成一层永远看不见的嘴帧（那种失败在画面上完全看不出来）。
        "eyeL": (241, 271, 44, 28),
        "eyeR": (335, 273, 44, 28),
        "_face": (117, 185, 427, 410),
    },
    "winter": {
        # 立绘 413x790（全身像，脸在上部 1/3，比例最小）。
        "eyeL": (195, 110, 34, 30),
        "eyeR": (258, 110, 32, 28),
        "mouth": (240, 178, 22, 15),
        # 围巾从 y≈190 起，所以嘴框下边只到 207 —— 再多就把围巾的雪花纹卷进重画范围。
        "_face": (108, 18, 362, 258),
        "_mouth": (198, 155, 282, 207),
        # ★ 唯一有下半身的一套（见文件头 `_hem` 的说明）。这一框**只圈格子裙本身**，
        #   四条边都是量出来的、每条都有一个具体的失效在背后：
        #     y0 = 614  裙腰。原来写 596，把**大衣下摆**（595~625）圈进来了 ——
        #               实测那一带会被跟着重画，走动时大衣下缘一起在抖。
        #     y1 = 722  裙摆下缘。原来一直写到 790（画面底），于是模型连着大腿和长袜
        #               一起重画；而袜子再往下就出画了，它只能**凭空造出脚和鞋**
        #               （实测 walk_b 直接变成双腿交叉＋一只伸到画面外的黑鞋）。
        #     x0/x1 = 60 / 398  卡到裙摆的左右极限。原来右边界写 340，
        #               把裙子**右半边切在了框外**（实测裙子横跨 x≈70~390）——
        #               那半边动不了，摆动时中间会出现一条直线接缝。
        #   这一框与 `_face`(y≤258)、`_mouth`(y≤207) 完全不重叠，所以三层可以任意叠加。
        "_hem": (60, 614, 398, 722),
    },
}

KIND_MEMBERS = {
    "eye": ("eyeL", "eyeR"),
    "mouth": ("mouth",),
}

# ---- 整张脸的矩形掩膜（v3.10）---------------------------------------------
#
# 为什么还要有它：椭圆掩膜只圈住"眼球"，而**原眼的外眼角睫毛线挑出了那个椭圆**。
# 闭眼图叠回去时，那截没被盖住的旧睫毛就留在下面 —— 这就是 v3.9 那版
# "闭了眼底下还有一道弧"的重影。
#
# 换成"整张脸"之后，重影自然消失了（旧睫毛在框内，被一起重画掉），
# 而且模型画眼睑时能看到整张脸，画出来的明暗是连着的。
# 代价从"接缝"变成"框内可能有位移"，所以框外仍然逐位不变 —— 抖动不会出脸。
#
# 框要**盖住整个脸**（含额头、下巴、两侧脸颊），不能只框眼睛：
# 框边落在皮肤中间时，模型在框内重画的皮肤色和框外会有一道色差台阶。
# 落在头发/轮廓上则几乎看不出来 —— 所以取的是脸的外接范围再外扩。
BOX_MARGIN = 46
BOX_FEATHER = 9.0

# ---- 嘴区矩形掩膜（v3.10）--------------------------------------------------
#
# 嘴**没有**理由用整张脸：出错的是眼的睫毛线挑出了椭圆，嘴是一个孤立的小特征，
# 而且它必须**与眼区不相交** —— 显示层是两层独立叠加（眼一层、嘴一层），
# 两块范围一旦重叠，上面那层就会把下面那层重画的内容盖掉，
# 于是"边眨眼边说话"时眼睛会忽然睁开。这类失效在静帧上完全看不出来。
#
# 四边余量**不对称**，各自对应一个具体的失效：
#   左/右 30px  —— 嘴角上扬时嘴唇会往两侧拉长，留窄了会把笑弧裁成断口；
#   上    8px  —— 上唇几乎不动。这一侧刻意留得**最少**：脸是侧着的，左眼椭圆
#                 下缘（y≈378）离嘴椭圆上缘（y≈380）只有 2px，上边一放宽，
#                 羽化带就会爬进左眼的下睫毛 —— 而这一层是叠在眼层**上面**的，
#                 它在那里画的是"基准（睁眼）"的内容，于是眨眼时会透出一层
#                 睁眼的残影。下边则相反，要留足。
#   下   34px  —— 张嘴是**往下长**的，这正是 v3.9 第一版"张嘴被裁成一条线"的原因。
MOUTH_MARGIN = (30, 8, 30, 34)
# 羽化比脸框小（9 → 7）：影响范围约 ±14px，上边界 y≈358，落在左眼真实下缘
# （y≈368）之上，两边不打架。
MOUTH_FEATHER = 7.0


def ellipses(outfit):
    """这一套的五官椭圆（过滤掉 `_face` / `_mouth` 这类**不是椭圆**的显式框键）。

    单独抽出来是因为这件事容易漏：凡是遍历 `FEATURES[outfit].values()` 的地方，
    多一个 `_face` 键就会把一个 4 元组当椭圆去算半径 —— 不报错，只是范围悄悄算错。
    """
    tab = FEATURES.get(outfit)
    if not tab:
        raise SystemExit(f"没有 {outfit} 的五官标定表，请在 FEATURES 里补上")
    return {k: v for k, v in tab.items() if not k.startswith("_")}


def mouth_box(outfit, margin=MOUTH_MARGIN):
    """嘴区矩形：(x0, y0, x1, y1)。与 mkframe.variable_box 同源 ——
    生成用哪块、验收按哪块算，必须是同一份。

    显式给了 `_mouth` 就用它；否则由嘴椭圆 + `margin` 推。**没有嘴椭圆就报错**：
    coat 的嘴被围巾完全遮住，安静地给它推一个框出来，只会生成一层永远看不见的嘴帧。
    """
    tab = FEATURES.get(outfit)
    if not tab:
        raise SystemExit(f"没有 {outfit} 的五官标定表，请在 FEATURES 里补上")
    if "_mouth" in tab:
        return tuple(tab["_mouth"])
    if "mouth" not in tab:
        raise SystemExit(
            f"{outfit} 没有嘴区（FEATURES[{outfit!r}] 里既没有 '_mouth' 也没有 'mouth'）——\n"
            f"  通常意味着这套立绘的嘴看不见（比如被围巾遮住），那它就不该有 mouth 层。\n"
            f"  确属误标的话，补一个嘴椭圆或直接写 '_mouth': (x0, y0, x1, y1)。")
    cx, cy, rx, ry = tab["mouth"]
    l, t, r, b = margin
    return (max(0, int(cx - rx - l)), max(0, int(cy - ry - t)),
            int(cx + rx + r), int(cy + ry + b))


def build_mouth(outfit, feather=MOUTH_FEATHER):
    """嘴区软边矩形掩膜。"""
    im = Image.open(os.path.join(SPRITES, outfit + ".png")).convert("RGBA")
    W, H = im.size
    x0, y0, x1, y1 = mouth_box(outfit)
    m = np.zeros((H, W), np.float32)
    m[y0:min(y1, H), x0:min(x1, W)] = 1.0
    if feather > 0:
        m = ndimage.gaussian_filter(m, feather)
        m = np.clip(m / max(m.max(), 1e-6), 0.0, 1.0)
    return m, (W, H)


# ---- 下装／下摆的矩形掩膜（v3.11 走动帧）-----------------------------------
# 羽化比脸框更大：这一层的上边界切在**衣服**上（裙腰、大衣下摆），
# 而衣服上有扣子、褶皱这类高频内容 —— 9px 的羽化在那个尺度上会留一条能看见的横线。
# 加大到 16px 之后，"要不要重画"这件事在 30px 的带上渐变过去，
# 走动时她本身还在上下起伏、左右倾，那点过渡被动作盖住了。
HEM_FEATHER = 16.0


def hem_box(outfit):
    """下装／下摆的框。**没有就报错**，理由见文件头 `_hem` 那一段：
    三套胸像摆起来看不见，给它们安静地推一个框出来只会多一层看不见的素材。"""
    tab = FEATURES.get(outfit)
    if not tab:
        raise SystemExit(f"没有 {outfit} 的五官标定表，请在 FEATURES 里补上")
    if "_hem" not in tab:
        raise SystemExit(
            f"{outfit} 没有下装区（FEATURES[{outfit!r}] 里没有 '_hem'）——\n"
            f"  通常意味着这套立绘看不到下装（胸像），那它就不该有 walk 层。\n"
            f"  确属误标的话，核对完 `--hem-qa` 的刻度图再补 '_hem': (x0, y0, x1, y1)。")
    return tuple(tab["_hem"])


def build_hem(outfit, feather=HEM_FEATHER):
    """下装／下摆的软边矩形掩膜。"""
    im = Image.open(os.path.join(SPRITES, outfit + ".png")).convert("RGBA")
    W, H = im.size
    x0, y0, x1, y1 = hem_box(outfit)
    m = np.zeros((H, W), np.float32)
    m[y0:min(y1, H), x0:min(x1, W)] = 1.0
    if feather > 0:
        m = ndimage.gaussian_filter(m, feather)
        m = np.clip(m / max(m.max(), 1e-6), 0.0, 1.0)
    return m, (W, H)


def face_box(outfit, margin=BOX_MARGIN):
    """整张脸的框：优先用显式的 `_face`，否则由所有椭圆并集外扩 margin。

    生成时用哪块、验收时按哪块算漂移，必须是同一个范围，否则验收会漏掉溢出的部分。
    """
    tab = FEATURES.get(outfit)
    if not tab:
        raise SystemExit(f"没有 {outfit} 的五官标定表，请在 FEATURES 里补上")
    if "_face" in tab:
        return tuple(tab["_face"])
    x0 = min(v[0] - v[2] for v in tab.values()) - margin
    y0 = min(v[1] - v[3] for v in tab.values()) - margin
    x1 = max(v[0] + v[2] for v in tab.values()) + margin
    y1 = max(v[1] + v[3] for v in tab.values()) + margin
    return (max(0, int(x0)), max(0, int(y0)), int(x1), int(y1))


def build_face(outfit, feather=BOX_FEATHER, margin=BOX_MARGIN):
    """整张脸的软边矩形掩膜。软边是必须的：硬框会在皮肤上留一条直线接缝。"""
    im = Image.open(os.path.join(SPRITES, outfit + ".png")).convert("RGBA")
    W, H = im.size
    x0, y0, x1, y1 = face_box(outfit, margin)
    m = np.zeros((H, W), np.float32)
    m[y0:min(y1, H), x0:min(x1, W)] = 1.0
    if feather > 0:
        m = ndimage.gaussian_filter(m, feather)
        m = np.clip(m / max(m.max(), 1e-6), 0.0, 1.0)
    return m, (W, H)


def ellipse_mask(size, cx, cy, rx, ry, soft=1.0):
    """硬边椭圆。soft 只是把边缘做 1px 抗锯齿，真正的大羽化在后面统一做。"""
    W, H = size
    yy, xx = np.mgrid[0:H, 0:W]
    d = ((xx - cx) / float(rx)) ** 2 + ((yy - cy) / float(ry)) ** 2
    m = np.clip((1.0 - d) / max(soft, 1e-6) * 0.5 + 0.5, 0.0, 1.0)
    return m.astype(np.float32)


def build(outfit, kind, feather=4.0, scale=1.0):
    """返回 (mask float32 HxW, size)。kind 为 eye / mouth。

    ★ 这是 v3.9 的**椭圆掩膜**，v3.10 生成时已经不用它（改用 build_face / build_mouth）。
    留着是为了让"椭圆版"与"整脸版"能对照 —— 第二节那张三条路对照表里的
    "掩膜内整脸重绘"就是这么比的。
    """
    im = Image.open(os.path.join(SPRITES, outfit + ".png")).convert("RGBA")
    W, H = im.size
    tab = ellipses(outfit)
    m = np.zeros((H, W), np.float32)
    for name in KIND_MEMBERS[kind]:
        cx, cy, rx, ry = tab[name]
        # 立绘尺寸变了标定就失效 —— 缩放系数由调用方按当前立绘高与标定时的源高之比给出，
        # 直接硬套会在换素材时静默错位。
        m = np.maximum(m, ellipse_mask((W, H), cx * scale, cy * scale,
                                       rx * scale, ry * scale))
    if feather > 0:
        m = ndimage.gaussian_filter(m, feather)
        m = np.clip(m / max(m.max(), 1e-6), 0.0, 1.0)
    return m, (W, H)


def to_canvas(m, W, H):
    """补到 16 倍画布 —— 必须与 gen_layers.make_ref 的补法**完全一致**（向右/下补），
    否则掩膜和参考图之间会整体错开几个像素，而错开几像素在合成图上几乎看不出来。"""
    cw, ch = (W + 15) // 16 * 16, (H + 15) // 16 * 16
    out = np.zeros((ch, cw), np.float32)
    out[:H, :W] = m
    return out, (cw, ch)


def qa_overlay(outfit, W, H, mask, dst):
    """把掩膜叠在立绘上，用来**逐张核对**：椭圆有没有圈住五官、框有没有切在脸颊中间。

    `_face` / `_mouth` 画成矩形、其余画成椭圆 —— 两者都在同一张图上，
    因为改其中一个通常要看另一个（比如"把框往下放"和"下巴还在不在框里"）。
    """
    im = Image.open(os.path.join(SPRITES, outfit + ".png")).convert("RGBA")
    bg = Image.new("RGB", im.size, (255, 255, 255))
    bg.paste(im, (0, 0), im)
    a = np.asarray(bg).astype(np.float32)
    red = np.zeros_like(a)
    red[:, :, 0] = 255
    k = np.clip(np.asarray(mask) * 0.55, 0, 1)[:, :, None]
    out = (a * (1 - k) + red * k).astype(np.uint8)
    img = Image.fromarray(out)
    d = ImageDraw.Draw(img)
    for name, (cx, cy, rx, ry) in ellipses(outfit).items():
        d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], outline=(0, 90, 220), width=2)
        d.text((cx - rx, cy - ry - 14), name, fill=(0, 90, 220))
    for key, color in (("_face", (220, 0, 0)), ("_mouth", (0, 140, 60)),
                       ("_hem", (210, 0, 200))):
        if key in FEATURES.get(outfit, {}):
            x0, y0, x1, y1 = FEATURES[outfit][key]
            d.rectangle([x0, y0, x1, y1], outline=color, width=2)
            d.text((x0 + 2, y0 + 2), key, fill=color)
    img.save(dst)
    return dst


def main():
    ap = argparse.ArgumentParser(description="生成五官软边掩膜（供潜空间局部重绘）")
    ap.add_argument("outfit")
    ap.add_argument("kind", choices=["eye", "mouth", "face", "mouthbox", "hem"],
                    help="eye/mouth = 老椭圆掩膜（只用于对照）；face = 整张脸；"
                         "mouthbox = 嘴区；hem = 下装/下摆（走动帧）")
    ap.add_argument("--feather", type=float, default=4.0)
    ap.add_argument("--qa", action="store_true", help="额外输出叠加核对图")
    ap.add_argument("--show", action="store_true", help="只输出叠加核对图，不写掩膜")
    a = ap.parse_args()

    if a.kind == "face":
        m, (W, H) = build_face(a.outfit)
    elif a.kind == "mouthbox":
        m, (W, H) = build_mouth(a.outfit)
    elif a.kind == "hem":
        m, (W, H) = build_hem(a.outfit)
    else:
        m, (W, H) = build(a.outfit, a.kind, feather=a.feather)
    outdir = os.path.join(WORK, a.outfit)
    os.makedirs(outdir, exist_ok=True)

    cw_m, (cw, ch) = to_canvas(m, W, H)
    qa = qa_overlay(a.outfit, W, H, m, os.path.join(outdir, f"_maskqa_{a.kind}.png"))
    print(f"  [{a.outfit}/{a.kind}] 掩膜 {cw}x{ch}（立绘 {W}x{H}）"
          f"  占比 {m.mean() * 100:.1f}%  核对图 {os.path.relpath(qa, ROOT)}")
    if a.show:
        return

    dst = os.path.join(outdir, f"_mask_{a.kind}.png")
    # 存成 RGB 灰度：ComfyUI 的 LoadImage 对无 alpha 的图返回**全 0** 掩膜
    # （源码里 `else: mask = zeros(64,64)`），所以不能直接吃 LoadImage 的 MASK 口，
    # 要走 ImageToMask 取红通道。这里因此把掩膜写在 R/G/B 三个通道上。
    g = np.round(np.clip(cw_m, 0, 1) * 255).astype(np.uint8)
    Image.fromarray(np.dstack([g, g, g]), "RGB").save(dst)
    print(f"       掩膜 -> {os.path.relpath(dst, ROOT)}")


if __name__ == "__main__":
    main()
