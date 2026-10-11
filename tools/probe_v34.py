# -*- coding: utf-8 -*-
"""v3.4 五项新交互的无头验收探针。

为什么单独写成脚本而不是手敲命令行：
  1. 项目路径里带中文，手敲时 bash 的编码会把 file:// 地址搞坏（实测：直拼字符串
     会得到一份空 DOM，看上去像"页面根本没跑起来"）；
  2. 每次要跑 4~6 组参数并**只**把右上角那份 readout 抠出来对比，
     逐条手跑等于把同一个坑踩四遍；
  3. 这几条的判据是"读数"，不是"截图好看" —— 项目里踩过的坑：
     无头模式走的是虚拟时间轴，和 CSS 动画的时间轴对不齐，
     看像素会得出错误结论（见 tools/abandoned/README.md）。

⚠ 已知边界：rAF 驱动的动作（走动位移、投掷飞行）在这个模式下**验不了** ——
  --virtual-time-budget 不会推进 rAF（实测 5000ms 内 setInterval 走了 10 拍、
  rAF 零次；加 --screenshot 也只多 1 帧）。所以本探针只验"决策与目标"
  （有没有进入 walk、往哪走、pattern/情绪/目光对不对），
  积分本身的收敛性由 tools/selftest.js 第 12 节直接跑 throwphysics.js 来验。

用法：python tools/probe_v34.py
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
V3 = os.path.dirname(HERE)
PREVIEW = os.path.join(V3, "renderer", "preview.html")

EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]

# 每组：[标签, hash 片段, 虚拟时间预算(ms)]
# 预算不能一律给 2500：投掷物理是 rAF 驱动的，要让它真的跑完落地，
# 得给足帧数（600 帧上限 ≈ 10s 虚拟时间，这里给 9000 已经能过 RATE 衰减那条路）。
PROBES = [
    ("look（目光跟随，喂 nx=-0.9 ny=0.7）", "demo=look", 2500),
    ("approachForce（跳过时间守卫，walk 目标应为 683→356 dir=←）", "demo=approachForce", 6000),
    ("approach（时间守卫应拒绝 -> walk 保持 -）", "demo=approach", 2500),
    ("throw（应进入 throw；飞行跑不完是已知限制）", "demo=throw", 9000),
    ("throw + 水手服（padX 应 ≈108，R 应 ≈851）",
     "o=sailor&demoDelay=600&demo=throw", 3500),
    ("rSkirt（戳裙摆，情绪应下降 + huff）", "demo=rSkirt", 2500),
    # 打字反应：连喂 7 次高频敲击，应触发 tap 小动效（rate 8 > TYPE_FAST 5）
    ("type（连喂 7 次高频敲击 -> anim 应为 tap）", "demo=type", 2500),
]

READOUT_RE = re.compile(
    r'id="state-readout"[^>]*>(.*?)</div>', re.S)


def find_edge():
    for p in EDGE_CANDIDATES:
        if os.path.exists(p):
            return p
    sys.exit("找不到 Edge，无法跑无头验收")


def url_for(hash_frag, w=1177, h=485):
    # pathlib 的 as_uri() 会给出带百分号编码的 file:// 地址，
    # 中文路径必须走这条路 —— 直接拼字符串的话 Edge 会按 latin-1 解，白跑。
    base = urllib.request.pathname2url(PREVIEW)
    return "file:///" + base.lstrip("/") + "#" + hash_frag


def run(edge, url, budget):
    # ⚠ profile 必须落在**系统临时目录**，不能放仓库里。
    #   Edge 会往 user-data-dir 写一堆带绝对路径和扩展名的日志，
    #   放在仓库内的话 selftest 的隐私闸门会（正确地）报一片"本机绝对路径"。
    #   第一版就是踩了这个 —— 闸门把探针自己的垃圾抓出来了，这不是误报。
    out = tempfile.mkdtemp(prefix="yukino-probe-")
    try:
        cmd = [
            edge, "--headless=new", "--disable-gpu", "--no-sandbox",
            # 高度要给够：headless 的 --window-size 是**外框**，实测视口比它矮 ~142px。
            # 而窗口本身有 469 高 —— 视口比窗口还矮时，地面的 y 会变成负数，
            # 物理直接退化（她一开始就站在地平面以下），验出来的全是假的。
            "--window-size=1177,800",
            "--virtual-time-budget=%d" % budget,
            "--user-data-dir=" + out,
            "--dump-dom", url,
        ]
        r = subprocess.run(cmd, capture_output=True, timeout=180)
        return r.stdout.decode("utf-8", "replace")
    finally:
        shutil.rmtree(out, ignore_errors=True)


def readout_of(dom):
    m = READOUT_RE.search(dom)
    if not m:
        return "(没有抓到 readout —— 页面可能没跑起来)"
    txt = re.sub(r"<[^>]+>", "", m.group(1))
    lines = [ln.strip() for ln in txt.splitlines() if ln.strip()]
    keep = ("viewport", "mode", "mood", "cursor", "throw", "anim", "walk", "throwp", "look", "pos")
    picked = [ln for ln in lines if ln.split(":")[0].strip() in keep]
    return " | ".join(picked) if picked else txt.strip()


def main():
    edge = find_edge()
    for label, frag, budget in PROBES:
        url = url_for(frag)
        try:
            dom = run(edge, url, budget)
        except subprocess.TimeoutExpired:
            print("== %s ==\n  超时\n" % label)
            continue
        print("== %s ==" % label)
        print("  " + readout_of(dom))
        print()


if __name__ == "__main__":
    main()
