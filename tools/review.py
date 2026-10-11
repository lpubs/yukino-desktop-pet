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
    python tools/review.py layers       # 只出状态帧对照（裁剪到五官、放大 3×，maid）
    python tools/review.py layers:sailor  # 指定套装（maid / sailor / coat / winter）
    python tools/review.py bubbles      # 只出对话气泡对照
    python tools/review.py bond         # 只出羁绊（升级演出 / 解锁台词）
    python tools/review.py v312         # 只出 v3.12（环境感知 / 时间感知 / 自动勿扰）
    python tools/review.py stats        # 只出统计页

输出落在 _review/ 下。
"""

import json
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
# 与 main.js 一致：BASE_H 是**窗口**高 = 角色显示高 400 + 顶部气泡留白 89（22%）。
# 它同时也决定了预览页那个"虚拟窗口"（#stage）的高度，所以裁剪框必须跟着它走 ——
# 只改 main.js 忘了这里，验收图会整体裁歪（角色看起来被切了半截）。
BASE_W, BASE_H = 404, 489
SINK_SIDE = 40                     # 四套都是半身像，见 main.js 的 OUTFIT_SINK
# 五档，与 main.js 的 SIZES 一致（selftest 会比对那边的档名集合）
SIZES = {"tiny": 0.58, "small": 0.72, "medium": 1.0, "large": 1.28, "huge": 1.58}

STAGE_W, STAGE_H = BASE_W, BASE_H
STAGE_X = VP_W - STAGE_W - 60                       # 816
STAGE_Y = VP_H - STAGE_H + SINK_SIDE                # 440
# 裁剪框到视口底边为止 —— 超出视口的部分（sink）本来就看不见
STAGE_BOX = (STAGE_X, STAGE_Y, STAGE_X + STAGE_W, VP_H)
# 脸部：眼睛大致在舞台高度的 45% 附近，往上留出刘海、往下留出下巴
FACE_BOX = (STAGE_X, STAGE_Y, STAGE_X + STAGE_W, STAGE_Y + 250)
# 被夹到屏幕最左边时用（角色外轮廓压在 x=0 上，窗口本身会探出去一截）
LEFT_BOX = (0, STAGE_Y, STAGE_W, VP_H)

# 所有验收图共用的 hash 片段 —— 装的是"必须压掉的随机变量"。
# 每一条都对应一个"截到哪一帧全看运气"的东西：
#   quiet=1    藏住气泡（中文台词会挡住她的脸）
#   noblink=1  关掉自动眨眼。眨眼间隔是随机的 3~7 秒，**一次眨眼就能把"睁眼"的格子
#              拍成半睁** —— 而"基准 vs 半睁"正是状态帧那组图要判的东西。
#   ro=0       藏掉右上角那块调试读数。★ 它从 v3.12 起**变高了**（多了 scene / time
#              两行），于是不再停在"她头顶以上"，而是压进裁剪框、糊在她头发上 ——
#              表现是"验收图里多了一块等宽文字"，看起来像渲染坏了。
#              读数本身没丢：state_readout() 走的是 --dump-dom 的文本，
#              元素 display:none 也照样抓得到（它自己那条注释里还记着这个坑）。
# 这和 hold=blush 是同一个道理（见 preview.html 里那段说明）：
# 靠运气验收不可靠，随机的东西要么定格、要么关掉。
COMMON = "quiet=1&noblink=1&ro=0"


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


# ---- 状态帧的裁剪框（v3.9 起）----# 眼睛在整身截图里只有 40x40 像素：偏移两个像素、或者多出一圈投影，
# 在这个尺度上**根本看不出来** —— 而那恰好是状态帧唯一会坏的方式。
# 所以单独裁到五官再放大 3 倍。
#
# 框不硬编码像素，而是从 tools/featmask.py 的 FEATURES 表算出来 ——
# 那张表本来就在标定"眼睛/嘴在哪、多大"（掩膜用的就是它）。
# 只有一份坐标来源，改素材时掩膜和验收图会一起动，不会各飘各的。
FEATMASK = ROOT / "tools" / "featmask.py"
# 角色显示高 = 窗口高 − 顶部给气泡的留白。与 main.js 的 TOP_PAD_RATIO、
# pet.css 的 #petArea(calc(100% - 22cqw)) 是同一个 22%（selftest 会比这几处）。
TOP_PAD_RATIO = 0.22


def feature_ellipses(outfit="maid"):
    """从 featmask.py 里读出 (中心x, 中心y, 横半径, 纵半径) 列表。"""
    src = FEATMASK.read_text(encoding="utf-8")
    m = re.search(r'"%s":\s*\{(.*?)\n    \}' % re.escape(outfit), src, re.S)
    if not m:
        raise SystemExit(f"featmask.py 的 FEATURES 里没有 {outfit}")
    out = [tuple(int(g) for g in e.groups()) for e in re.finditer(
        r'"(?:eyeL|eyeR|mouth|eye|head)":\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)',
        m.group(1))]
    if not out:
        raise SystemExit(f"featmask.py 里 {outfit} 的椭圆没解析出来（格式变了吗？）")
    return out


def sprite_box(outfit="maid", pad=14):
    """把五官椭圆从「素材像素」投影到「屏幕像素」，得到一个只看五官的裁剪框。

    .frame 的定位是 height:100% + left:50% + translateX(-50%) + bottom:0
    （见 pet.css），所以换算就是"等比缩放到角色显示高、底边对齐、水平居中"。
    """
    sw, sh = Image.open(ROOT / "assets" / "sprites" / f"{outfit}.png").size
    disp_h = BASE_H - round(TOP_PAD_RATIO * BASE_W)
    s = disp_h / sh
    x0 = STAGE_X + (BASE_W - sw * s) / 2      # 素材左边缘的屏幕横坐标
    y0 = STAGE_Y + (BASE_H - disp_h)          # 素材上边缘的屏幕纵坐标（底边对齐）
    xs, ys = [], []
    for cx, cy, rx, ry in feature_ellipses(outfit):
        xs += [x0 + (cx - rx) * s, x0 + (cx + rx) * s]
        ys += [y0 + (cy - ry) * s, y0 + (cy + ry) * s]
    return (int(min(xs) - pad), int(min(ys) - pad), int(max(xs) + pad), int(max(ys) + pad))


def generic_head_box(pad=0):
    """给"没做差分的套装"用的通用头部框。

    不能套 maid 的五官表 —— 那三套的立绘尺寸与构图都不同，套过去会裁到肩上。
    共同的只有一条：显示高 = 窗口高 − 留白、底边对齐。按这条取头顶往下 250px
    的一条横带，够看清"她照常跑、脸上没有多出白块 / 空图层"。
    """
    disp_h = BASE_H - round(TOP_PAD_RATIO * BASE_W)
    top = STAGE_Y + (BASE_H - disp_h)
    return (STAGE_X + 60 - pad, top - pad, STAGE_X + 340 + pad, top + 250 + pad)

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


def state_readout(browser, hash_, budget=6000):
    """把预览页右上角那块状态读数当**文本**取回来。

    为什么不截图再裁：读数是等宽多行的，位置随内容浮动，裁剪要么截断要么得猜坐标。
    `--dump-dom` 拿到的是同一份 DOM，还顺带避开虚拟时间轴。

    用途见 run_layers：状态帧的"接线通不通"必须由读数来判，不能靠看图 ——
    「图层没生效」（素材没解码完 / 被别的东西盖掉）和「图层的画法不对」
    在截图上都是"眼睛看起来没变"，靠人眼分不开。
    """
    with tempfile.TemporaryDirectory(prefix="yukino-readout-") as profile:
        cmd = [
            browser, "--headless=new", "--disable-gpu", "--no-sandbox",
            "--no-first-run", "--hide-scrollbars",
            "--force-device-scale-factor=1",
            f"--window-size={VP_W + WIN_PAD_W},{VP_H + WIN_PAD_H}",
            f"--virtual-time-budget={budget}",
            f"--user-data-dir={profile}",
            "--dump-dom",
            url_for("preview.html", hash_),
        ]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True,
                               errors="replace", timeout=90)
        except subprocess.TimeoutExpired:
            return None
    # ⚠ 不能写成 `<div id="state-readout">`：带 ro=0 时它多一个 style 属性，
    #   按字面匹配会**静默抓不到**（读数是空的，而空读数会被当成"没差异"）。
    m = re.search(r'<div id="state-readout"[^>]*>(.*?)</div>', r.stdout, re.S)
    if not m:
        return None
    out = {}
    for line in m.group(1).split("\n"):
        s = line.strip()
        for key in ("eye", "mouth"):
            if not s.startswith(key):
                continue
            mm = re.match(rf"{key}\s*:\s*(.+?)\s+on=(true|false)\b", s)
            if mm:
                out[key] = {"slot": mm.group(1).strip().strip("()"),
                            "on": mm.group(2) == "true"}
    return out


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
        png = shot(browser, "preview.html", f"o={k}&{COMMON}&delay=500",
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
        # ⚠ 不要写成 "带 delay= 就整串跳过 COMMON"。
        #   那样只是省掉重复的 delay，却把 COMMON **整条**丢掉了 ——
        #   look / pat 两格会连带失去 noblink 和 ro=0，后果是两个：
        #     ① 随机眨眼（3~7s 一次）可能正好落在"目光跟随"这一格里 ——
        #        而那一格的眼睛**正是唯一的验收对象**，拍到闭眼就是假 bug；
        #     ② 调试读数直接压在她头上（同 run_layers / run_bubbles 的理由）。
        #   自带 delay= 的格子只需**不重复追加** delay，COMMON 照给。
        #   URLSearchParams.get() 取第一个值，所以自带那个 delay 仍然生效。
        h = f"{h}&{COMMON}" if "delay=" in h else f"{h}&{COMMON}&delay={D}"
        png = shot(browser, "preview.html", h, f"app_{name}.png", budget=budget)
        im = crop(png, box) if png else None
        # 缩放档的裁剪框尺寸和别的格子不一样，统一缩到格子大小再拼
        if im is not None and im.size != (STAGE_W, STAGE_H):
            im = im.resize((STAGE_W, STAGE_H), Image.LANCZOS)
        cells.append((label, im))
    return make_sheet(cells, 3, STAGE_W, STAGE_H, OUT / "sheet_states.png",
                      title="各状态对照（真机里背景是透明的，这里垫的棋盘只为看清边缘）")


def run_layers(browser, outfit="maid"):
    """状态帧：每一档**定住**截一张，逐张看有没有对齐、有没有多出白边/投影。

    这一组和 states 分开，是因为它验的东西不一样：
      · 那些槽位的正常存活时间只有 40~130ms（一次眨眼），截到哪一档全看运气；
        所以走 demo=eyeXxx —— 预览页那边用 expression 把槽位钉住（见 pet.js）。
      · 眼睛只有 40x40 像素，整身图放大也看不出"两个像素的偏移"，
        而状态帧唯一会坏的方式就是**偏移**（尺寸不同 / 定位不同 / 忘了跟着翻转）。

    ⚠ 第一格"基准"必须一起出：它是判断"眼睑到底有没有动"的参照物。
      没有它，就只能凭记忆比 —— 而记忆比不出 2 像素。
    ⚠ 最后一格是**没做差分的套装**：降级路径要表现为"照常跑、脸上没有多出白块"，
      而不是报错或空图层。

    ⚠⚠ 每一格都**先查读数、再出图**，而且读数不对会明确报警。
      这张表两次踩过同一个坑，都是"图是干净的、结论却是错的"：
        · 素材没解码完：layerImg() 按 naturalWidth 判空 → 静默退回基准立绘，
          于是"半睁"那一格和"基准"逐像素相同 —— 看起来像图层没接线。
          现在用 wait=layers 等解码事件（见 pet.js 的 onLayersReady）。
        · 随机眨眼：间隔 3~7s，一次眨眼就能把"基准（睁眼）"拍成半睁，
          而"基准 vs 半睁"的差别正是这组图要判的东西。现在用 noblink=1 关掉。
      这两个坑的共同点是**静默**：不查读数的话，只能靠"这两格怎么长得一样"
      这种后续追问才能发现。所以判据必须由读数负责，图只负责看定位和接缝。
    """
    D = 1500                      # 大于开机问候的 700ms（那一句要念三四秒）
    # (文件名, demo, 说明, 期望槽位) —— 期望槽位 None 表示"这一档不叠图层"。
    scenes = [
        ("none",    "demo=eyeNone",    "基准：不叠图层（立绘自带的睁眼）",  ("eye", None)),
        ("half",    "demo=eyeHalf",    "半睁（眨眼四拍的中间两拍）",        ("eye", "half")),
        ("closed",  "demo=eyeClosed",  "闭眼（眨眼的落点 / 睡着）",         ("eye", "closed")),
        ("wink",    "demo=eyeWink",    "调皮眨眼（摸头）",                  ("eye", "wink")),
        ("happy",   "demo=eyeHappy",   "笑眼（双击 / 情绪转好）",           ("eye", "happy")),
        ("mouthO",  "demo=mouthOpen",  "张嘴（说话的口型）",                ("mouth", "open")),
        ("mouthS",  "demo=mouthSmile", "浅笑（说话的口型）",                ("mouth", "smile")),
    ]
    # ro=0：藏掉右上角的调试读数。它固定贴在视口右上，而这里的裁剪框
    # 正好覆盖她头部右侧 —— 不藏的话读数会直接糊在她脸上（见 preview.html 的说明）。
    # 另外三个是上面那两条教训固化成的东西：等解码、关随机眨眼、掐掉口型节拍。
    # ★ 这一套**真的**声明了哪些层，从 manifest.json 读 —— 不能拿 maid 的表硬跑。
    #   对着不存在的层去截图，"图层没叠上"（素材没解码完 → layerImg() 按 naturalWidth
    #   判空、静默退回基准立绘）与"这套根本没做这一层"在图上长得完全一样：
    #   都是"这一格和基准逐像素相同"。所以期望值只能来自该套自己的声明。
    man = json.loads((ROOT / "assets" / "sprites" / outfit / "manifest.json")
                     .read_text(encoding="utf-8"))
    kinds = {v["kind"] for v in man["layers"].values()}
    dropped = [s[2] for s in scenes if s[3][1] is not None and s[3][0] not in kinds]
    scenes = [s for s in scenes if s[3][1] is None or s[3][0] in kinds]
    if dropped:
        print(f"  [layers] {outfit} 没有这些层，跳过对应格子：" + "、".join(dropped))

    EXTRA = f"{COMMON}&ro=0&wait=layers&delay={D}"
    box = sprite_box(outfit)
    cw, ch = box[2] - box[0], box[3] - box[1]
    Z = 3                          # 放大倍数：40px 的眼睛放到 120px 才看得清接缝
    cells, bad = [], []
    for name, h, label, (kind, want) in scenes:
        full = f"{h}&{EXTRA}"
        st = state_readout(browser, full)
        if st is None:
            print(f"  ! [{name}] 抓不到读数，无法确认图层是否真的叠上了")
        else:
            got = st.get(kind) or {"slot": "?", "on": False}
            ok = (got["on"] is False) if want is None else \
                 (got["on"] and got["slot"] == want)
            print(f"  [layers] {label.replace(chr(10), ' '):22s} "
                  f"{kind}={got['slot'] or '(空)'} on={str(got['on']).lower()}  "
                  f"{'OK' if ok else '✗ 与预期不符'}")
            if not ok:
                bad.append(f"{name}: 读到 {kind}={got['slot']} on={got['on']}，"
                           f"期望 {'不叠图层' if want is None else want + ' on=true'}")
        png = shot(browser, "preview.html", full, f"app_layer_{name}.png", budget=4200)
        im = crop(png, box) if png else None
        if im is not None:
            im = im.resize((cw * Z, ch * Z), Image.LANCZOS)
        cells.append((label, im))
    if bad:
        # 报警而不只是打印：读数不对时这张表**没有判据**，
        # 看它得出的任何"对齐/接缝"结论都不成立。
        print("  ✗ 图层接线核对未通过 —— 下面这张对照图不能用来判断定位与接缝：")
        for b in bad:
            print("      ·", b)
    else:
        print(f"  [layers] 读数核对：{len(scenes)}/{len(scenes)} 与预期一致")
    # 最后一格换另一套的立绘：同一段叠图代码换张脸，确认它照常跑、脸上不会
    # 多出白块或空图层。（这格原先验的是"没做差分那套走降级路径"，
    # v3.11 四套都做了差分之后它没有样例了 —— 降级路径现在由 selftest 第 25 节
    # 与 negtest 守着：素材缺失/判据被改掉都会当场响。）
    other = next((o for o in ("sailor", "maid", "coat", "winter") if o != outfit), "maid")
    gb = generic_head_box()
    png = shot(browser, "preview.html", f"o={other}&{COMMON}&ro=0&delay={D}",
               f"app_layer_other_{outfit}.png", budget=4200)
    im = crop(png, gb) if png else None
    if im is not None:
        im = im.resize((cw * Z, ch * Z), Image.LANCZOS)
    cells.append((f"{other}（换另一套的脸，同一段叠图代码）", im))
    suffix = "" if outfit == "maid" else f"_{outfit}"
    title = f"{outfit} 状态帧对照（裁剪框按 featmask.py 的五官标定表投影，放大 3×）"
    if dropped:
        title += "　｜　这套没有：" + "、".join(dropped)
    return make_sheet(cells, 4, cw * Z, ch * Z, OUT / f"sheet_layers{suffix}.png",
                      title=title)


def run_stats(browser):
    """两种状态都要看：有数据的环形图 / 没数据时的空状态。

    #demo 会让 stats.js 的浏览器替身返回一份示例数据。
    """
    ok = shot(browser, "stats.html", "demo", "app_stats.png", w=680, h=780)
    empty = shot(browser, "stats.html", "", "app_stats_empty.png", w=680, h=520)
    cells = [("有数据", Image.open(ok) if ok else None),
             ("空状态", Image.open(empty) if empty else None)]
    return make_sheet(cells, 1, 680, 780, OUT / "sheet_stats.png")


# 用库里最长的一档台词（24 字，会折两行）—— 气泡最容易露怯的情况。
# 必须 percent-encode：preview.html 的 hash 解析是 decodeURIComponent 之后再交给
# URLSearchParams 的，中文直接塞进去会被当成 URL 里的非法字符。
BUBBLE_LINE = "跳一下怎么了。人类偶尔需要应激反应——这是科学。"
SAY = urllib.parse.quote(BUBBLE_LINE, safe="")


def run_bubbles(browser):
    """对话气泡的专门验收。

    v3.2.3 起窗口顶部多留了一条（窗口宽的 22%），气泡悬在她头顶上方 ——
    所以这里看的**不是**"有没有压住"，而是那条留白到底够不够：
    留白按窗口宽等比缩，而气泡的字号/内距有绝对像素的可读性下限，
    小档需要的比例比大档大得多（极小档 21.8% vs 特大档 10.8%），
    按大档拍比例，小档就会顶进她额头 —— v3.6 修的就是这个。
    要盯的四件事：
      ① 四套装扮下气泡都在头顶上方、不压发梢（素材宽窄差 2 倍）；
      ② 五档的尺寸是否跟着窗口走，两端有没有因为 clamp 而失控；
      ③ 徽章和气泡同时在场时的排布（v3.6 起横排，不再互相顶）；
      ④ **极小档**：最苛刻的一档，留白够不够在这里才看得出来。
    逐张看图，不要只看"渲染成功了"。
    """
    scenes = [
        ("maid",   f"o=maid&say={SAY}&delay=900",     "女仆装"),
        ("sailor", f"o=sailor&say={SAY}&delay=900",   "水手服（窄）"),
        ("coat",   f"o=coat&say={SAY}&delay=900",     "冬大衣"),
        ("winter", f"o=winter&say={SAY}&delay=900",   "冬装（窄）"),
        ("tiny",   f"o=maid&sc=tiny&say={SAY}&delay=900",
         "极小档（0.58）—— 留白最苛刻的一档，最该看它"),
        ("small",  f"o=maid&sc=small&say={SAY}&delay=900",
         "小档（0.72）—— 尺寸该跟着窗口缩小"),
        ("large",  f"o=maid&sc=large&say={SAY}&delay=900",
         "大档（1.28）—— 尺寸该跟着窗口放大"),
        ("huge",   f"o=maid&sc=huge&say={SAY}&delay=900",
         "特大档（1.58）—— 字号撞上限，看气泡会不会显得太小"),
        ("badge",  f"o=maid&badge=1&say={SAY}&delay=900",
         "徽章 + 气泡同时在（v3.6 起横排，不再上下顶）"),
        ("tinytag", f"o=maid&sc=tiny&badge=1&say={SAY}&delay=900",
         "极小档 + 徽章 —— 最挤的排布，横排到底排不排得下"),
    ]
    cells = []
    for k, h, label in scenes:
        png = shot(browser, "preview.html", h, f"app_bubble_{k}.png", budget=4200)
        box = stage_box_for(k if k in ("tiny", "small", "large", "huge") else "medium")
        cells.append((label, crop(png, box) if png else None))
    return make_sheet(cells, 4, STAGE_W, STAGE_H, OUT / "sheet_bubbles.png",
                      title="对话气泡：磨砂玻璃材质 + 随窗口等比缩放 + 与徽章堆叠")


def run_v312(browser):
    """v3.12 的"说的话"：前台应用（环境感知）/ 时间感知 / 自动勿扰。

    为什么单独一组：这三件事在真机上**根本没有可见的形状** ——
    场景台词是她突然开口说一句、整点报时是每小时最多一次、自动勿扰是"她不见了"。
    真机验收（tools/probe_v312.js）能证明"判据与接线对"，却证明不了
    "那句话说得对不对、{h} 有没有被填上、自动档到底有没有多嘴"
    —— 后半截只能逐张读图。所以这里把每一句都拉出来定格拍一张。

    ⚠ 这一组**不能**用 COMMON 里的 quiet=1：那里的作用是藏住气泡免得挡脸，
      而这里要看的正是气泡。除了"自动勿扰"那一格（它要验的恰恰是气泡为空）。
    """
    D = 1500          # 必须大于开机问候的 700ms，否则演示台词会被问候盖掉
    # ro=0 藏掉右上角那块调试读数 —— 它固定贴在视口右上，而这里的裁剪框正好覆盖
    # 她头顶那一带，不藏的话读数会直接压在气泡上（与 run_layers 同一条理由）。
    # noblink=1 只压随机眨眼；气泡要留着（COMMON 里的 quiet=1 **不能**用）。
    BASE = "noblink=1&ro=0"
    scenes = [
        ("sceneCode",    f"demo=sceneCode&{BASE}",          "场景·写代码"),
        ("sceneBrowser", f"demo=sceneBrowser&{BASE}",       "场景·浏览器"),
        ("sceneVideo",   f"demo=sceneVideo&{BASE}",         "场景·看视频"),
        ("sceneChat",    f"demo=sceneChat&{BASE}",          "场景·聊天"),
        ("chime",        f"demo=chime&{BASE}",              "整点报时（{h} 必须被填上）"),
        ("lateNight",    f"demo=lateNight&{BASE}",          "深夜的问候"),
        ("dayN",         f"demo=dayN&{BASE}",               "陪你第 7 天"),
        # ★ 最后两格是一组对照，必须放在一起看：
        #   手动勿扰说告别、自动勿扰（全屏）一声不吭 —— 这是 bye 那个字段
        #   唯一可见的差别，也是这一版最容易被改回去的地方。
        ("quietBye",     f"demo=quietBye&{BASE}",           "手动勿扰：她会说一句告别"),
        ("autoQuiet",    f"demo=autoQuiet&{BASE}&quiet=1",  "全屏自动躲：**静默**（气泡必须为空）"),
    ]
    cells = []
    for k, h, label in scenes:
        png = shot(browser, "preview.html", f"{h}&delay={D}", f"app_v312_{k}.png", budget=4200)
        cells.append((label, crop(png, STAGE_BOX) if png else None))
    return make_sheet(cells, 3, STAGE_W, STAGE_H, OUT / "sheet_v312.png",
                      title="v3.12：前台应用 / 时间感知 / 自动勿扰（自动档不说告别）")


def run_bond(browser):
    """羁绊（互动养成）的专门验收。

    要看三件事：
      ① 升级演出：台词 + 爱心粒子 + 腮红 + 表情**四样同时**出现，会不会互相压住；
      ② 等级越高台词不一样（每级一条），所以 Lv.3 与 Lv.6 要各看一张；
      ③ 解锁台词：`demo=bond6` 是从**待机池本身**抽一句 —— 抽到 Lv.6 那几句，
         就说明"解锁的台词真的并进了待机池"。这是这个功能唯一可见的效果，
         光看 selftest 的"表里有 6 条"是验不出来的。
    气泡是"说完就收"的短流程，`lu=` 与 `demo=bond6` 都会把它定格，否则
    无头截图抓到的多半是已经收尾的那一帧（和 hold=blush 同一个坑）。
    """
    scenes = [
        ("levelup3", "lu=3&delay=700",        "升级演出（Lv.3）"),
        ("levelup6", "lu=6&delay=700",        "升级演出（Lv.6）"),
        ("bond6",    "demo=bond6&delay=700",  "羁绊 Lv.6：从待机池抽一句（应为解锁台词）"),
    ]
    cells = []
    for k, h, label in scenes:
        png = shot(browser, "preview.html", h, f"app_bond_{k}.png", budget=4200)
        cells.append((label, crop(png, STAGE_BOX) if png else None))
    return make_sheet(cells, 3, STAGE_W, STAGE_H, OUT / "sheet_bond.png",
                      title="羁绊：升级演出 + 解锁台词")


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
    if which in ("all", "layers") or which.startswith("layers:"):
        outfits = (["maid"] if which in ("all", "layers")
                   else [which.split(":", 1)[1]])
        for o in outfits:
            print(f"[layers:{o}] ...")
            made.append(run_layers(browser, o))
    if which in ("all", "bubbles"):
        print("[bubbles] ...")
        made.append(run_bubbles(browser))
    if which in ("all", "bond"):
        print("[bond] ...")
        made.append(run_bond(browser))
    if which in ("all", "v312"):
        print("[v312] ...")
        made.append(run_v312(browser))
    if which in ("all", "stats"):
        print("[stats] ...")
        made.append(run_stats(browser))
    for m in made:
        print("->", m)


if __name__ == "__main__":
    main()
