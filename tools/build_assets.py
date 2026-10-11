# -*- coding: utf-8 -*-
"""一键产出桌宠素材：预处理 -> 抠图 -> 落地到 assets/sprites。

## 方法：全流程纯 Python 确定性抠图，不用任何模型

`tools/cut.py` 的立足点是**连通性**，不是颜色阈值：

    只有与图像四边连通的背景才是背景；
    被角色轮廓线围住的白色（头饰、围裙、衬衫、蕾丝）从边界走不到，
    因此永远是角色的一部分。

这三处是让它真正可靠的关键，缺一个都会"静默地差"：

  1. 背景色从图像四边**估计**（中位数），不写死"白色"。
     写死 `min(RGB) >= 244` 时，棋盘格的暗格（~242）会整片被判成前景，
     于是"背景不是纯白"的图必然失败。改成估色 + 容差后，
     浅灰底 / 棋盘底 / 渐变底一视同仁。
  2. flood fill 必须 **4-连通**。轮廓线是抗锯齿的，8-连通能从描边的
     对角缝隙挤进角色内部，把白蕾丝、白围裙当背景吃掉
     —— 女仆装头饰里那块灰色塌陷就是这么来的。
  3. 边缘做**反预乘**去白晕。半透明边缘 = 角色色与白底的混合，
     直接留下它，贴到深色桌面上就是一圈发白的"贴纸边"。

## 关于 isnet-anime（曾经用过，现在不是默认）

上一版认为"水手服的灰白拼贴底、冬大衣的棋盘底，白背景假设不成立，
必须上动漫专用分割模型"，于是引入了 isnet-anime（176MB）并叠了两个门限。
结论是**错的**：换成估背景色 + 4-连通之后，这两张图的纯 Python 结果
比模型版更干净（贝雷帽那圈灰雾、发梢的白雾都没有了），而且完全可复现、
可逐行调试。`tools/anime_cut.py` 与 `models/isnetis.onnx` 保留作为备用，
默认流程不再经过它们。

## 素材来源

原始手机截图归档在 `01_需求与参考图/服饰参考图/`（与本项目同级），文件名带 `2` 后缀；
手机截图的状态栏 / 灰带 / 水印由 `tools/prep_ref.py` 先切掉。

**该目录不在仓库内**（是使用者的私有素材），所以路径必须由使用者提供：
优先读环境变量 `YUKINO_REF_DIR`，未设置时回退到「本项目同级目录」的默认位置。
本文件里**不写任何绝对路径**——那会泄露使用者本机的目录结构。

## 输出高：用满源，绝不放大

`OUT_CAP = 800` 不是拍脑袋来的，是"2× HiDPI 屏上看到的那一帧"：
桌宠中档缩放的显示高是 400 CSS px，2× 屏上落到 800 个**设备像素**上。
素材高 = 800 时正好一个源像素对一个设备像素。

但"目标 800"不能无条件执行 —— 各套的**源可用高**差得很远（实测）：

    水手服 1396   女仆装 1009   冬装 790   冬大衣 762

一律做到 800 的话，冬大衣（762）和冬装（790）就是**插值放大**：
文件大了七成，细节一个都没多。实测头部锐度：女仆 +15%、水手 +14%，
而冬大衣 +3%、冬装 −3%（同一张对照图 `_review/_对比_重制.png`）。

所以规则是 `输出高 = min(OUT_CAP, 源可用高)`：

    maid 800   sailor 800   coat 762   winter 790

结果就是**四套的输出高不再相同**。这不是妥协，是把真实约束如实记下来：
素材的分辨率上限由源决定，不由目标决定。既然高不再统一，
"素材宽度上限"那条约束也顺势改成**按宽高比**判（见 main.js 的 PET_MAX_ASPECT）——
约束的本意本来就是"显示宽不能超出窗口"，而那是比值问题，跟绝对高矮无关。

## 为什么先抠再统一色调

`tools/unify_tone.py` 的统计必须只看**不透明像素**，而"哪些像素是角色"
正是抠图才能回答的问题。所以顺序是：抠图 -> 统一色调 -> 落地。
"""
import os
import subprocess
import sys

PY = sys.executable
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REVIEW = os.path.join(ROOT, "_review")
HIRES = os.path.join(REVIEW, "hires")
OUT = os.path.join(ROOT, "assets", "sprites")
# 私有素材目录：不写死本机路径，见上文「素材来源」。
REF = os.environ.get("YUKINO_REF_DIR") or os.path.join(
    os.path.dirname(ROOT), "01_需求与参考图", "服饰参考图"
)

# 输出高上限 = 2× HiDPI 屏 + 中档缩放下的设备像素数。理由见文件头。
OUT_CAP = 800
BORDER = 9

# name, 源文件, 裁切区间(去掉状态栏/灰带/水印)
JOBS = [
    ("maid",   "A2_女仆装_白底.png",   (587, 1611)),
    ("sailor", "B2_水手服_白底.png",   (233, 1966)),
    # C2 整张都是内容（棋盘底不满足"又暗又均匀"，自动检测认不出来），
    # 所以给显式区间：人物在 780~1490，留够余量再切掉底部"豆包AI生成"水印。
    ("coat",   "C2_冬大衣_棋盘底.png", (700, 1560)),
    # 冬装全身：原图本身就是干净的官方立绘，无需预处理。但它只有 630x821 的手机截图，
    # 源可用高 790（1.41× 于旧版 560）—— 四套里最紧的一套，决定了整体的上限在哪。
    ("winter", "D_冬装+格裙+书包.jpg", None),
]


def run(cmd, capture=False):
    print("  $", " ".join(cmd))
    r = subprocess.run(cmd, check=True, cwd=ROOT, capture_output=capture, text=True)
    return (r.stdout or "") if capture else ""


def prep(name, src, band):
    """裁切区间 -> _review/_base_<name>.png。无需裁切的（冬装）直接返回原图。"""
    if band is None:
        return f"{REF}/{src}"
    base = os.path.join(REVIEW, f"_base_{name}.png")
    run([PY, "tools/prep_ref.py", f"{REF}/{src}", base, "--crop", "%d,%d" % band])
    return base


def native_height(base):
    """源里角色实际占的像素高 —— 输出的硬上限。

    先探再切，而不是先切了看结果：探这一步就是**闸门**。
    没有它，把 OUT_CAP 调到 1200 会静默地把两套装备放大 1.6 倍，
    文件变大、细节不变，而画面上看不出任何异常。
    """
    out = run([PY, "tools/cut.py", base, os.devnull, "--border", str(BORDER),
               "--probe"], capture=True)
    for line in out.splitlines():
        if "源可用高" in line:
            return int(line.split("源可用高")[1].split("px")[0].strip())
    raise SystemExit("探测源分辨率失败，输出：\n" + out)


def main():
    if not os.path.isdir(REF):
        sys.exit(
            "找不到私有素材目录（本脚本不携带该目录，也不在仓库内）。\n"
            f"  当前解析到：{REF}\n"
            "  请用环境变量指定：YUKINO_REF_DIR=<你的素材目录> python tools/build_assets.py\n"
            "  目录内需要的文件见本文件顶部「素材来源」。"
        )

    os.makedirs(OUT, exist_ok=True)
    os.makedirs(REVIEW, exist_ok=True)
    os.makedirs(HIRES, exist_ok=True)

    print("== 1/3 抠图（按 min(%d, 源可用高) 定输出高）" % OUT_CAP)
    heights = {}
    for name, src, band in JOBS:
        base = prep(name, src, band)
        nat = native_height(base)
        h = min(OUT_CAP, nat)
        note = "用满源" if h < OUT_CAP else "源有富余，按上限 %d" % OUT_CAP
        print(f"   {name}: 源可用高 {nat} -> 输出 {h}  ({note})")
        run([PY, "tools/cut.py", base, os.path.join(HIRES, name + ".png"),
             "--target", str(h), "--border", str(BORDER)])
        heights[name] = h

    print("\n== 2/3 色调统一（只对齐色阶，不动色相/饱和）")
    sys.path.insert(0, HERE)
    import unify_tone  # noqa: E402  (必须在 ROOT/HERE 就绪后导入)
    import numpy as np
    from PIL import Image

    names = [j[0] for j in JOBS]
    imgs = {n: np.asarray(Image.open(os.path.join(HIRES, n + ".png")).convert("RGBA"))
            for n in names}
    st = {n: unify_tone.stats_of(imgs[n]) for n in names}
    tg = unify_tone.target_of([st[n] for n in names])
    print("   目标色阶 p2=%.1f p50=%.1f p98=%.1f" % (tg["p2"], tg["p50"], tg["p98"]))
    for n in names:
        print("   统一前 %-8s p2=%6.1f p50=%6.1f p98=%6.1f" % (n, st[n]["p2"], st[n]["p50"], st[n]["p98"]))
    unified = {n: unify_tone.apply(imgs[n], st[n], tg) for n in names}
    for n in names:
        s2 = unify_tone.stats_of(unified[n])
        print("   统一后 %-8s p2=%6.1f p50=%6.1f p98=%6.1f" % (n, s2["p2"], s2["p50"], s2["p98"]))

    print("\n== 3/3 落地到 assets/sprites")
    for n in names:
        dst = os.path.join(OUT, n + ".png")
        Image.fromarray(unified[n], "RGBA").save(dst)
        print("   %s  %dx%d  %.1fKB" % (
            os.path.relpath(dst, ROOT),
            unified[n].shape[1], unified[n].shape[0], os.path.getsize(dst) / 1024))

    print("\n⚠ 素材高不再统一（%s）。" % " ".join("%s=%d" % (n, heights[n]) for n in names))
    print("   两处随之更新：renderer/preview.html 的 SPRITE 表、tools/make_placeholder.py 的表。")
    print("   然后跑 node tools/selftest.js 确认尺寸/宽高比断言仍成立。")


if __name__ == "__main__":
    main()
