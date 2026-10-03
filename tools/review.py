#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
雪乃桌宠 · 视觉验收工具

为什么要这个：归档文档里最痛的一条教训是
    「当时是靠 opaque% 之类的**指标**判断抠图成功的 —— 指标骗了我。
      必须逐张读图验收。」
所以这里干脆把"读图"这一步做成可复跑的脚本：无头渲染各个状态 -> 拼成对照图 -> 人眼过一遍。

它不启动 Electron（本机沙箱里 Electron 会 FATAL: GPU process isn't usable），
而是用 Edge/Chrome 的 headless 模式打开 renderer/preview.html，
走的是和真机**完全同一份** pet.js。

用法：
    python tools/review.py              # 全量
    python tools/review.py outfits      # 只出四套装扮对照
    python tools/review.py states       # 只出各状态对照
    python tools/review.py stats        # 只出统计页

输出落在 _review/ 下。
"""

import os
import re
import subprocess
import sys
import tempfile
import urllib.parse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
RENDERER = ROOT / "renderer"
OUT = ROOT / "_review"
OUT.mkdir(exist_ok=True)

# ---- 视口与几何 ----
# preview.html 把**浏览器视口本身**当作虚拟工作区：舞台坐标 = 屏幕坐标，
# 于是"贴左边缘""被拖到屏幕外"这类演示的读数与像素一一对应，不再是"看起来像"。
#
# 于是这里的数字必须是**真实的视口尺寸**，不能想当然地写 --window-size 的值：
# Edge 的 headless=new 把 --window-size 当**外框**，实测 1280x800 只换来
# 1250x658 的内容区（页内 readout 会打出真实值）。差 30x142 时，窗口的
# 落点会整体偏左上，裁剪框就裁到角色以外的位置 —— 验收图看起来"下半身没了"，
# 其实是被裁歪了。所以 shot() 会反向补偿这个差值，让视口回到 VP_W × VP_H。
VP_W, VP_H = 1280, 800
WIN_PAD_W, WIN_PAD_H = 30, 142
BASE_W, BASE_H = 404, 400
SINK_SIDE = 40                     # 四套都是半身像，见 main.js 的 OUTFIT_SINK
SIZES = {"small": 0.72, "medium": 1.0, "large": 1.28}

STAGE_W, STAGE_H = BASE_W, BASE_H
STAGE_X = VP_W - STAGE_W - 60                       # 816
STAGE_Y = VP_H - STAGE_H + SINK_SIDE                # 440
# 裁剪框到视口底边为止 —— 超出视口的部分（sink）本来就看不见
STAGE_BOX = (STAGE_X, STAGE_Y, STAGE_X + STAGE_W, VP_H)
# 脸部：眼睛大致在舞台高度的 45% 附近，往上留出刘海、往下留出下巴
FACE_BOX = (STAGE_X, STAGE_Y, STAGE_X + STAGE_W, STAGE_Y + 250)
# 被夹到屏幕最左边时用（角色外轮廓压在 x=0 上，窗口本身会探出去一截）
LEFT_BOX = (0, STAGE_Y, STAGE_W, VP_H)


def stage_box_for(scale="medium"):
    """缩放后窗口尺寸变了，裁剪框也要跟着走。

    与 main.js 的 applyScale / preview.html 的 applyVirtualScale 同一套锚点：
    以**底边 + 水平中心**为锚。
    """
    s = SIZES.get(scale, 1.0)
    w, h = round(BASE_W * s), round(BASE_H * s)
    x = round(STAGE_X + STAGE_W / 2 - w / 2)
    y = round(STAGE_Y + STAGE_H - h)
    return (x, y, x + w, VP_H)

BROWSERS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]


def find_browser():
    for p in BROWSERS:
        if os.path.exists(p):
            return p
    raise SystemExit("找不到 Edge/Chrome，无法做无头渲染。")


def url_for(page, hash_=""):
    p = (RENDERER / page).as_posix()
    u = "file:///" + urllib.parse.quote(p, safe="/:")
    return u + ("#" + hash_ if hash_ else "")


def shot(browser, page, hash_, out_name, budget=3500, w=VP_W, h=VP_H, tries=2):
    """无头渲染一页并截图。

    用独立 user-data-dir，免得和用户正在用的浏览器抢 profile。
    这里必须容错：Edge 的 headless 偶尔会不吐图就挂着不退（尤其是页面里
    有 requestAnimationFrame 循环时，--virtual-time-budget 可能一直等不到
    虚拟时间推进），所以给单次尝试设硬超时，失败就换 profile 重来一次。
    """
    dst = OUT / out_name
    for attempt in range(tries):
        if dst.exists():
            dst.unlink()
        try:
            with tempfile.TemporaryDirectory(prefix="yukino-review-") as profile:
                cmd = [
                    browser, "--headless=new", "--disable-gpu", "--no-sandbox",
                    "--no-first-run", "--hide-scrollbars",
                    "--force-device-scale-factor=1",
                    # 补偿外框与内容区的差值，让**视口**正好是 w × h
                    f"--window-size={w + WIN_PAD_W},{h + WIN_PAD_H}",
                    f"--virtual-time-budget={budget}",
                    f"--user-data-dir={profile}",
                    f"--screenshot={dst.as_posix()}",
                    url_for(page, hash_),
                ]
                r = subprocess.run(cmd, capture_output=True, text=True,
                                   errors="replace", timeout=60)
        except subprocess.TimeoutExpired:
            print(f"  · {out_name} 第 {attempt + 1} 次超时，重试")
            continue
        if dst.exists():
            return dst
        print("  ! 截图失败:", out_name, (r.stderr or "")[-300:])
    return dst if dst.exists() else None


def font(size):
    for f in [r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\msyh.ttf",
              r"C:\Windows\Fonts\simhei.ttf"]:
        if os.path.exists(f):
            try:
                return ImageFont.truetype(f, size)
            except Exception:
                pass
    return ImageFont.load_default()


def make_sheet(cells, cols, cell_w, cell_h, path, label_h=24, gap=10, pad=14,
               title=None, title_h=34):
    """cells: [(label, PIL.Image), ...] —— 拼成对照图并存盘。"""
    rows = (len(cells) + cols - 1) // cols
    W = pad * 2 + cols * cell_w + (cols - 1) * gap
    H = pad * 2 + (title_h if title else 0) + rows * (cell_h + label_h) + (rows - 1) * gap
    sheet = Image.new("RGB", (W, H), (250, 250, 252))
    d = ImageDraw.Draw(sheet)
    f_lb, f_ti = font(15), font(18)
    y = pad
    if title:
        d.text((pad, y + 6), title, fill=(45, 50, 65), font=f_ti)
        y += title_h
    for i, (label, im) in enumerate(cells):
        r, c = divmod(i, cols)
        x = pad + c * (cell_w + gap)
        yy = y + r * (cell_h + label_h + gap)
        # 棋盘底，方便看清透明边缘/白描边
        cell = Image.new("RGB", (cell_w, cell_h + label_h), (255, 255, 255))
        cd = ImageDraw.Draw(cell)
        for by in range(0, cell_h + label_h, 12):
            for bx in range(0, cell_w, 12):
                if (bx // 12 + by // 12) % 2 == 0:
                    cd.rectangle([bx, by, bx + 11, by + 11], fill=(244, 245, 248))
        cd.text((6, 4), label, fill=(60, 66, 84), font=f_lb)
        if im is not None:
            cell.paste(im.convert("RGB"), (0, label_h))
        sheet.paste(cell, (x, yy))
    sheet.save(path)
    return path


def crop(png, box):
    im = Image.open(png)
    return im.crop(box)


# ---------------- 各场景 ----------------

def run_outfits(browser):
    """四套装扮各定格一张。

    四张现在都出自 `tools/cut.py`（纯 Python 确定性抠图），
    但**必须逐张读图验收** —— "透明背景比例"这类指标完全看不出
    "贝雷帽外留了一圈灰雾""白蕾丝被吃掉"这种问题，而它恰恰是前几轮翻车的地方。
    """
    scenes = [
        ("maid",   "女仆装"),
        ("sailor", "水手服 + 贝雷帽"),
        ("coat",   "冬大衣 + 围巾"),
        ("winter", "冬装"),
    ]
    cells = []
    for k, label in scenes:
        png = shot(browser, "preview.html", f"o={k}&quiet=1&delay=500",
                   f"app_outfit_{k}.png", budget=2500)
        cells.append((label, crop(png, STAGE_BOX) if png else None))
    return make_sheet(cells, 4, STAGE_W, STAGE_H, OUT / "sheet_outfits.png",
                      title="四套装扮对照（真机背景透明；棋盘只为看清边缘与白描边）")


def run_states(browser):
    # delay 必须大于开机问候的 700ms。
    # pet.js 启动时会在 700ms 说一句"早/又见面了"，比它早触发的演示
    # 台词会被这句问候覆盖掉 —— 表现为"点了按钮但气泡说的是问候语"。
    D = 1500
    # 短动画（腮红 1.7s）**不能靠调 budget 去"抓动画中段"**：截图用的是
    # --virtual-time-budget，虚拟时间轴和 CSS 动画时间轴对不齐 —— 同一组参数
    # 跑两次，一次抓到中段、一次抓到已经收尾的那一帧（readout 的 blush 值会是 0），
    # 验收结果全看运气。所以走 hold=blush 把它定格在动画中段的浓度，
    # 人眼要看的是"画在哪、浓淡如何"，流畅度在真机按钮上看。
    LEFT_BOX = (0, STAGE_Y, STAGE_W, STAGE_Y + STAGE_H)   # 被夹到屏幕最左边时用
    #        key, hash, label, budget, 裁剪框
    scenes = [
        ("idle",      "demo=idle",                 "待机（开机问候）",        4200, STAGE_BOX),
        ("blush",     "demo=blush&hold=blush",     "腮红（双击/摸头的反馈）", 3000, STAGE_BOX),
        ("look",      "demo=look&delay=2200",      "目光跟随（朝左上看）",    4200, STAGE_BOX),
        # 大档的窗口更大、位置也不同，裁剪框必须跟着走 —— 否则裁到的是
        # medium 的位置，角色的左肩会被切掉一块，看起来像"放大后画错了"。
        ("scale",     "sc=large",                  "大小：大档",              4200, stage_box_for("large")),
        ("pomodoro",  "demo=pomodoro",             "番茄钟面板",              4200, STAGE_BOX),
        ("outfit",    "demo=outfit",               "换装 → 水手服",           4200, STAGE_BOX),
        ("sleep",     "demo=sleep",                "睡着",                    4200, STAGE_BOX),
        ("pat",       f"demo=pat&delay={D + 600}", "摸头",                    4200, STAGE_BOX),
        ("double",    "demo=double",               "双击（跳 + 爱心）",       4200, STAGE_BOX),
        ("walk",      "demo=walk",                 "走两步",                  4200, STAGE_BOX),
        ("dropL",     "demo=dropL",                "松手贴左边缘",            4200, LEFT_BOX),
        ("offscreen", "demo=offscreen",            "被拖到屏幕外 → 被夹回边缘", 3000, LEFT_BOX),
    ]
    cells = []
    for name, h, label, budget, box in scenes:
        h = h if "delay=" in h else f"{h}&delay={D}"
        png = shot(browser, "preview.html", h, f"app_{name}.png", budget=budget)
        im = crop(png, box) if png else None
        # 缩放档的裁剪框尺寸和别的格子不一样，统一缩到格子大小再拼
        if im is not None and im.size != (STAGE_W, STAGE_H):
            im = im.resize((STAGE_W, STAGE_H), Image.LANCZOS)
        cells.append((label, im))
    return make_sheet(cells, 3, STAGE_W, STAGE_H, OUT / "sheet_states.png",
                      title="各状态对照（真机里背景是透明的，这里垫的棋盘只为看清边缘）")


def run_stats(browser):
    """两种状态都要看：有数据的环形图 / 没数据时的空状态。

    #demo 会让 stats.js 的浏览器替身返回一份示例数据。
    """
    ok = shot(browser, "stats.html", "demo", "app_stats.png", w=680, h=780)
    empty = shot(browser, "stats.html", "", "app_stats_empty.png", w=680, h=520)
    cells = [("有数据", Image.open(ok) if ok else None),
             ("空状态", Image.open(empty) if empty else None)]
    return make_sheet(cells, 1, 680, 780, OUT / "sheet_stats.png")


def main():
    browser = find_browser()
    print("browser:", browser)
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    made = []
    if which in ("all", "outfits"):
        print("[outfits] ...")
        made.append(run_outfits(browser))
    if which in ("all", "states"):
        print("[states] ...")
        made.append(run_states(browser))
    if which in ("all", "stats"):
        print("[stats] ...")
        made.append(run_stats(browser))
    for m in made:
        print("->", m)


if __name__ == "__main__":
    main()
