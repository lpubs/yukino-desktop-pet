#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
雪乃桌宠 · 气泡尺寸探针

回答两个截图回答不了的问题：

  Q1  气泡到底有没有跟着窗口等比缩放？
  Q2  气泡（以及跟它横排的徽章）到底有没有整个落在顶部留白带以内？

为什么需要它，而不是看验收图：
    气泡尺寸用 cqw（容器查询单位，"窗口宽度的 1%"）表达。而"看起来差不多大"
    是靠不住的 —— 实测过一条错路：想在截图里按"亮且中性"的像素找出气泡的
    外框来量，结果**被预览页那块浅色假桌面骗了**：背景和气泡在亮度上是同一类，
    一行里两者连成一片，"气泡宽度"量出来永远是整个窗口宽（100%）。
    （和归档文档里"用 opaque% 判断抠图成功"是同一类翻车：指标骗人。）

    所以改成直接读浏览器的排版结果：走 Edge 的 --dump-dom 把预览页 DOM
    打出来，再从右上角那块诊断读数里把 getBoundingClientRect() 的数字取走。

判据 1（软）：`字号 / 窗口宽` 应当在五档之间基本一致（中心值 3.35%）。
    **但两端必然偏高/偏低，那不是 bug**：气泡的字号与内距都有可读性下限
    （字号 clamp(10.5px, 3.35cqw, 15px)、内距 clamp(5px, 1.7cqw, 9px)…），
    下限是**绝对像素、不跟着窗口缩**，所以极小档会撞下限（比例偏大）、
    特大档会撞上限（比例偏小）。所以这一条只报数 + 标出撞了哪一端，
    不做 pass/fail —— 真正会伤人的是判据 2。

判据 2（硬）：**顶部信息条必须整个落在留白带以内、且不越过窗口上沿**。
    留白带高 = 窗口宽 × 22%（与 main.js 的 TOP_PAD_RATIO、pet.css 的
    `#petArea { height: calc(100% - 22cqw) }` 同值）。留白带在窗口**顶部**，
    所以它的底边就是 y = 22cqw 那条线，也就是「她的头顶」。越过这两条线中的
    任何一条都会出真问题：
      top < 0        → 越过窗口上沿，被窗口裁掉（他看不见了）
      bot > 22cqw    → 越过带子底边，落到她的头/身上（截图里看得到）
    两种排布都要量："只有气泡" 和 "徽章 + 气泡"（后者是真机上番茄钟跑着时的样子）。

    ★ 这一条正是 v3.6 的入口：把三档扩到五档后跑它，极小档当场报
      「气泡底边 48px > 留白 39.8px」。根因是留白比例按拍脑袋定的 17%，
      而小档需要的比例（21.8%）远大于大档（10.8%）。

    ⚠ 两个坐标系别搞混，这里翻过车：top / bot 都是**从窗口上沿往下**量，
      而"留白带 22%"也是从**上沿**往下的一条线 —— 两者同框，直接用 bot ≤ 22cqw
      比就行。第一版改成"从下沿往上"算（拿 (窗高 − bot) 去和带高比），
      比较对象根本不是同一条线，于是给一个"气泡落在她腰上"的错位开了绿灯。
      判据写错比没有判据更危险：它会给你一个绿灯。

用法：
    python tools/measure_bubble.py
"""
import os
import re
import subprocess
import tempfile
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGE = "renderer/preview.html"
# 用库里最长的一档台词（24 字，会折两行）—— 气泡最容易露怯的情况
LINE = "跳一下怎么了。人类偶尔需要应激反应——这是科学。"

BROWSERS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]

# 与 review.py 同一套换算：Edge 的 --window-size 是**外框**，不等于视口。
VP_W, VP_H = 1280, 800
WIN_PAD_W, WIN_PAD_H = 30, 142
# 顶部留白（给气泡的那条）= 窗口宽 × 22%。与 main.js 的 TOP_PAD_RATIO、
# pet.css #petArea 的 `calc(100% - 22cqw)`、pet.js / preview.html 的常量同值
# —— selftest 会把这几处一起比对，因为漏一处就会量出一个不存在的 bug。
TOP_PAD_CQW = 0.22

# 五档，顺序与 SIZES / SIZE_ORDER 一致（selftest 会比对档名集合）
TIERS = ("tiny", "small", "medium", "large", "huge")

# 气泡字号的 clamp 上下限 —— 用来解释"为什么这一档比例偏离中心值"。
# 与 pet.css 的 `font-size: clamp(10.5px, 3.35cqw, 15px)` 必须一致（selftest 比对）。
FONT_CLAMP = (10.5, 0.0335, 15.0)


def find_browser():
    for p in BROWSERS:
        if os.path.exists(p):
            return p
    raise SystemExit("找不到 Edge/Chrome，无法读取排版结果。")


def read_state(browser, hash_):
    url = "file:///" + urllib.parse.quote((ROOT / PAGE).as_posix(), safe="/:")
    with tempfile.TemporaryDirectory(prefix="yukino-measure-") as prof:
        p = subprocess.run(
            [browser, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
             "--force-device-scale-factor=1",
             "--window-size=%d,%d" % (VP_W + WIN_PAD_W, VP_H + WIN_PAD_H),
             "--virtual-time-budget=4200",
             "--user-data-dir=" + prof,
             "--dump-dom", url + "#" + hash_],
            capture_output=True, text=True, errors="replace", timeout=120)
    dom = p.stdout or ""
    out = {}
    for key, pat in (("viewport", r"viewport:\s*(\S+)"),
                     ("scale", r"scale\s*:\s*\w+\s*\((\d+x\d+)\)"),
                     ("bubble", r"bubble\s*:\s*([^\n<]+)"),
                     ("topBar", r"topBar\s*:\s*([^\n<]+)")):
        m = re.search(pat, dom)
        out[key] = m.group(1).strip() if m else None
    return out


def clamp_culprit(font_px):
    """这一档的字号撞了 clamp 的哪一端 —— 用来解释比例为何偏离中心值。"""
    lo, mid, hi = FONT_CLAMP
    if abs(font_px - lo) < 0.01:
        return "撞下限"
    if abs(font_px - hi) < 0.01:
        return "撞上限"
    return ""


def measure(browser, sc, badge):
    st = read_state(browser, "o=maid&sc=%s&say=%s&delay=900%s" % (sc, urllib.parse.quote(LINE, safe=""),
                                                                 "&badge=1" if badge else ""))
    win_w = win_h = 0
    if st["scale"]:
        win_w, win_h = (int(v) for v in st["scale"].split("x"))
    out = {"sc": sc, "badge": badge, "win_w": win_w, "win_h": win_h,
           "band": TOP_PAD_CQW * win_w, "bubble": st["bubble"], "topBar": st["topBar"]}
    m = re.match(r"(\d+)x(\d+)\s+font\s+([\d.]+)px\s+([\d.]+)%\s+of\s+win\s+top\s+(-?\d+)px\s+bot\s+(-?\d+)px",
                 st["bubble"] or "")
    if m:
        out.update(bw=int(m.group(1)), bh=int(m.group(2)), fs=float(m.group(3)),
                   pct=float(m.group(4)), btop=int(m.group(5)), bbot=int(m.group(6)))
        out["ratio"] = 100.0 * out["fs"] / win_w if win_w else 0.0
    t = re.match(r"band\s+(\d+)px\s+badge\s+(\d+)x(\d+)\s+kids\s+(-?\d+)\.\.(-?\d+)"
                 r"\s+v\s+(-?\d+)\.\.(-?\d+)", st["topBar"] or "")
    if t:
        # band_page 是**预览页自己**按 TOP_PAD_RATIO 算出来的带高，留作交叉核对：
        # 判据仍用本文件的 TOP_PAD_CQW（五处一致性由 selftest 守），
        # 两者不等就说明有人只改了一处 —— 那种情况下量出来的"通过"没有意义。
        out.update(band_page=int(t.group(1)), bdw=int(t.group(2)), bdh=int(t.group(3)),
                   kidl=int(t.group(4)), kidr=int(t.group(5)),
                   vtop=int(t.group(6)), vbot=int(t.group(7)))
    return out


def main():
    browser = find_browser()
    print("留白带（给气泡的那条）＝ 窗口宽 × %g%%；台词用库里最长的一档（会折两行）\n"
          % (TOP_PAD_CQW * 100))
    print("%-7s%-10s%-13s%-11s%-15s%s" % ("档位", "窗口", "气泡(宽x高)", "字号", "字号/窗宽", "撞clamp"))
    rows = []
    for sc in TIERS:
        r = measure(browser, sc, False)
        if "bh" not in r:
            print("%-7s没读到读数（viewport=%s）" % (sc, r["win_w"]))
            continue
        rows.append(r)
        print("%-7s%-10s%-13s%-11s%-15s%s"
              % (sc, "%dx%d" % (r["win_w"], r["win_h"]), "%dx%d" % (r["bw"], r["bh"]),
                 "%.2fpx" % r["fs"],
                 "%.2f%%" % r["ratio"],
                 clamp_culprit(r["fs"]) or "—（中心值）"))

    print("\n【判据 1（软）】中心值 %.2f%%；两端偏离是可读性下限/上限造成的，不是 bug"
          % (FONT_CLAMP[1] * 100))
    if rows:
        lo = min(r["ratio"] for r in rows)
        hi = max(r["ratio"] for r in rows)
        print("   实测 %.2f%% ~ %.2f%%" % (lo, hi))

    # ── 判据 2（硬）：顶部信息条的内容必须整个落在留白带内、且不越过窗口上沿 ──
    # 量的是**内容并集**（徽章 + 气泡两个子项），不是 #topBar 的框：
    # v3.6 起 #topBar 就是那条带子本身（top:0; height:22cqw），它自己的上下界
    # 恒等于 0 和带高，拿它去比"在不在带子里"永远成立 —— 这条检查空转过两次了。
    # 同框比较：vtop / vbot 与留白带高**都是从窗口上沿往下**量的。
    #   上沿那条线是 y = 0；带子底边是 y = 22cqw（= 她头顶）。
    # 所以只需 vbot ≤ 带高 且 vtop ≥ 0，两个方向都在同一个坐标系里。
    fail = 0
    for badge in (False, True):
        title = "徽章 + 气泡（番茄钟跑着时的样子）" if badge else "只有气泡"
        print("\n【判据 2（硬）】%s —— 必须 内容顶 ≥ 0（不被窗口裁）"
              " 且 内容底 ≤ 留白带高（不落到她头上/身上）" % title)
        for sc in TIERS:
            r = measure(browser, sc, badge)
            if "vbot" not in r:
                print("   %-7s 没读到 topBar 读数" % sc)
                fail += 1
                continue
            clipped = r["vtop"] < -0.5                        # 越过窗口上沿 → 被裁掉
            sunk = r["vbot"] > r["band"] + 0.5                 # 越过带子底边 → 落到她身上
            # 横排还有个横向风险：气泡 max-width 68% + 徽章是定宽，两者相加会超窗宽。
            # 超了 flex 会把气泡压窄 → 台词多折一行 → 反而把信息条顶高。所以一起守。
            wide = r["kidl"] < -0.5 or r["kidr"] > r["win_w"] + 0.5
            # 真空测试守卫：徽章那一轮如果徽章根本没显示出来，这条测试等于没测
            ghost = badge and r["bdh"] == 0
            # 交叉核对：预览页自己算的带高必须和本文件算出的一致（五处一致由 selftest 兜底，
            # 这里再显式看一眼 —— 只改一处的话"通过"是假的）
            drift = r.get("band_page") is not None and abs(r["band_page"] - r["band"]) > 1
            ok = not clipped and not sunk and not wide and not ghost and not drift
            if not ok:
                fail += 1
            note = ""
            if drift:
                note = ("  ✗ 带高对不上：本文件 %g%% 算出 %.1f，页面 %d（有人只改了一处）"
                        % (TOP_PAD_CQW * 100, r["band"], r["band_page"]))
            elif clipped:
                note = "  ✗ 被窗口上沿裁掉 %dpx" % -r["vtop"]
            elif sunk:
                note = "  ✗ 落到她身上 %dpx（她自己不会说）" % (r["vbot"] - r["band"])
            elif wide:
                note = "  ✗ 横排超宽：子项 %d..%d 超出窗宽 %d" % (r["kidl"], r["kidr"], r["win_w"])
            elif ghost:
                note = "  ✗ 徽章没显示（这轮等于没测）"
            print("   %-7s 窗高%4d 带高%6.1f | 内容顶%5d 底%5d | 徽章%3dx%-3d | 子项 %4d..%-4d"
                  "  %s%s"
                  % (sc, r["win_h"], r["band"], r["vtop"], r["vbot"],
                     r["bdw"], r["bdh"], r["kidl"], r["kidr"],
                     "✓" if ok else "✗", note))

    print()
    if fail:
        print("✗ 有 %d 项不达标 —— 留白带不够高，或徽章/气泡的尺寸下限太大。" % fail)
        print("  修法：抬 TOP_PAD_RATIO（main.js / pet.js / preview.html / pet.css / 本文件五处同改），")
        print("  或收小 #bubble / #badge 的 clamp 下限。别只改一处 —— selftest 会拦。")
    else:
        print("✓ 五档 × 两种排布全部达标：气泡与徽章都落在留白带内，也没越过窗口上沿。")


if __name__ == "__main__":
    main()
