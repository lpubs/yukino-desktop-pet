#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
雪乃桌宠 · 气泡尺寸探针

回答一个截图回答不了的问题：**气泡到底有没有跟着窗口等比缩放？**

为什么需要它，而不是看验收图：
    气泡尺寸用 cqw（容器查询单位，"窗口宽度的 1%"）表达。而"看起来差不多大"
    是靠不住的 —— 实测过一条错路：想在截图里按"亮且中性"的像素找出气泡的
    外框来量，结果**被预览页那块浅色假桌面骗了**：背景和气泡在亮度上是同一类，
    一行里两者连成一片，"气泡宽度"量出来永远是整个窗口宽（100%）。
    （和归档文档里"用 opaque% 判断抠图成功"是同一类翻车：指标骗人。）

    所以改成直接读浏览器的排版结果：走 Edge 的 --dump-dom 把预览页 DOM
    打出来，再从右上角那块诊断读数里把 getBoundingClientRect() 的数字取走。
    preview.html 会把 `bubble : <宽>x<高> font <字号>px <占窗口宽百分比>` 打进读数。

判据：
    `字号 / 窗口宽` 在 small / medium / large 三档之间必须一致（都是 3.10%）。
    一致 → cqw 生效，气泡随窗口等比；偏大 → 字号其实还是写死的 px，小档会格外占地。

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
                     ("bubble", r"bubble\s*:\s*([^\n<]+)")):
        m = re.search(pat, dom)
        out[key] = m.group(1).strip() if m else None
    return out


def main():
    browser = find_browser()
    say = urllib.parse.quote(LINE, safe="")
    print("%-8s%-14s%-16s%-12s%s" % ("档位", "窗口", "气泡(宽x高)", "字号", "占窗口宽"))
    ratios = []
    for sc in ("small", "medium", "large"):
        st = read_state(browser, "o=maid&sc=%s&say=%s&delay=900" % (sc, say))
        if not st["bubble"]:
            print("%-8s没读到读数（viewport=%s）" % (sc, st["viewport"]))
            continue
        m = re.match(r"(\d+)x(\d+)\s+font\s+([\d.]+)px\s+([\d.]+)%", st["bubble"])
        if not m:
            print("%-8s%s" % (sc, st["bubble"]))
            continue
        bw, bh, fs, pct = int(m.group(1)), int(m.group(2)), float(m.group(3)), float(m.group(4))
        win_w = win_h = 0
        if st["scale"]:
            win_w, win_h = (int(v) for v in st["scale"].split("x"))
        ratio = (100.0 * fs / win_w) if win_w else 0.0
        ratios.append(ratio)
        print("%-8s%-14s%-16s%-12s%.1f%%   (字号/窗宽 %.2f%%)"
              % (sc, "%dx%d" % (win_w, win_h), "%dx%d" % (bw, bh),
                 "%.2fpx" % fs, pct, ratio))

    if len(ratios) >= 2 and max(ratios) - min(ratios) < 0.15:
        print("\n✓ 三档的「字号 / 窗口宽」一致（%.2f%%~%.2f%%）—— cqw 生效，气泡随窗口等比"
              % (min(ratios), max(ratios)))
    else:
        print("\n✗ 三档比例不一致 —— 检查 pet.css 里 #bubble 的字号是不是写成了 px，"
              "以及 #stage 有没有 container-type: inline-size")


if __name__ == "__main__":
    main()
