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
"""
import os
import subprocess
import sys

PY = sys.executable
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REVIEW = os.path.join(ROOT, "_review")
OUT = os.path.join(ROOT, "assets", "sprites")
# 私有素材目录：不写死本机路径，见上文「素材来源」。
REF = os.environ.get("YUKINO_REF_DIR") or os.path.join(
    os.path.dirname(ROOT), "01_需求与参考图", "服饰参考图"
)

# 所有素材统一 560 高。pet.css 用 height:100% 落位，见 README 第二节的尺寸说明。
TARGET = "560"
BORDER = "9"

# name, 源文件, 裁切区间(去掉状态栏/灰带/水印)
JOBS = [
    ("maid",   "A2_女仆装_白底.png",   (587, 1611)),
    ("sailor", "B2_水手服_白底.png",   (233, 1966)),
    # C2 整张都是内容（棋盘底不满足"又暗又均匀"，自动检测认不出来），
    # 所以给显式区间：人物在 780~1490，留够余量再切掉底部"豆包AI生成"水印。
    ("coat",   "C2_冬大衣_棋盘底.png", (700, 1560)),
]


def run(cmd):
    print("  $", " ".join(cmd))
    subprocess.run(cmd, check=True, cwd=ROOT)


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

    for name, src, band in JOBS:
        base = os.path.join(REVIEW, f"_base_{name}.png")
        print(f"== {name}")
        run([PY, "tools/prep_ref.py", f"{REF}/{src}", base,
             "--crop", "%d,%d" % band])
        run([PY, "tools/cut.py", base, f"assets/sprites/{name}.png",
             "--target", TARGET, "--border", BORDER])

    # 冬装全身：原图本身就是干净的官方立绘，无需预处理
    print("== winter")
    run([PY, "tools/cut.py", f"{REF}/D_冬装+格裙+书包.jpg", "assets/sprites/winter.png",
         "--target", TARGET, "--border", BORDER])


if __name__ == "__main__":
    main()
