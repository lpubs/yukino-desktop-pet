#!/usr/bin/env python3
"""雪乃桌宠 · 音效合成 —— ⚠ 已废弃，见 tools/abandoned/README.md

**这个脚本不再参与任何流程，也不要再跑它。**
它生成的 6 个 wav 曾经是正式素材，v3.4 起已全部换成 CC0 录音素材，
由 tools/prepare_sfx.py 生成。

废弃原因一句话：**合成音听起来"太粗糙"，而这不是调参能解决的。**
纯正弦 + 18% 二次谐波 + 指数衰减，缺的是谐波结构、瞬态和空间感 ——
那是录音素材才有的东西，靠加谐波数量堆不出来（试过，只是从"电子表"变成"电子琴"）。
所以改成从 CC0 公共领域素材库取真录音，授权依然干净（CC0 无署名义务、可商用），
来源逐条记在 assets/sfx/CREDITS.md。

保留这个文件是为了记住：**"自己算"并不天然优于"用现成的"** ——
当时选合成是为了躲授权问题，而 CC0 素材把这个问题解决得更彻底，音质还高一大截。

---- 以下为原始说明（历史存档）----

雪乃桌宠 · 音效合成

**不引入任何音频素材，也不用第三方库** —— 纯标准库 `wave` + `math` 算出几个
柔和提示音。两条理由：

1. 音频是最容易踩授权雷的一类资源（免费音效站的授权条款参差不齐，
   而桌宠一旦公开就要能说清"这声音从哪来"）。自己算出来的波形版权干净。
2. 体积。六个音加起来约 110 KB，而随便下几个 mp3 就是几百 KB。

设计约束（这几条决定了它听起来"轻"，而不是"叮"）：

* **22050Hz / 16bit / 单声道**。桌宠的提示音不需要频响，44100 只是白白翻倍体积。
* **每个音都必须有 attack/release 包络**。没有包络的话首尾会有一次直流跳变，
  扬声器里就是"啪"的一声爆音 —— 这是合成音最常见的翻车点。
* **峰值压到 -18dBFS 上下**（约 0.12 幅度）。桌宠是长时间挂着的，
  提示音必须"能被忽略"；响了会让人想关掉的东西，不如不做。
* **叠一点二次谐波**。纯正弦听着像老式电子表，加 18% 的二次谐波会温和很多。
* **同一家族的音用同一套参数**（音色、包络、音量一致），只有音高序列不同，
  这样六个音听起来是"一个人的声音"，不是六个来源。

用法：
    python tools/make_sfx.py            # 写到 assets/sfx/
    python tools/make_sfx.py --out DIR  # 写到别处（不覆盖现有素材）
"""

import argparse
import math
import struct
import wave
from pathlib import Path

RATE = 22050          # 采样率。22050 对提示音足够，体积是 44100 的一半
HARMONIC = 0.18       # 二次谐波比例，让音色温和
AMP = 0.12            # 基准幅度 ≈ -18dBFS。**别调大** —— 见文件头第三条

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "assets" / "sfx"


def tone(freq, dur, amp=AMP, attack=0.008, tau=None):
    """一个带包络的单音，返回浮点样本列表（范围约 ±amp）。

    tau 是衰减时间常数；不给就取 dur/3.5，让它在 dur 末尾正好衰减到 ~3%，
    于是"音长"就是 dur，不需要额外做淡出。
    """
    n = max(1, int(RATE * dur))
    tau = tau or (dur / 3.5)
    a = max(1, int(RATE * attack))
    out = []
    for i in range(n):
        t = i / RATE
        env = min(1.0, i / a) * math.exp(-t / tau)   # 线性起音 + 指数衰减
        s = math.sin(2 * math.pi * freq * t) + HARMONIC * math.sin(4 * math.pi * freq * t)
        out.append(amp * env * s)
    return out


def seq(*parts):
    """顺序拼接（用来做两三个音的小旋律）。"""
    buf = []
    for p in parts:
        buf.extend(p)
    return buf


# 音名 -> 频率（十二平均律，A4 = 440）
N = {
    "C5": 523.25, "D5": 587.33, "E5": 659.25, "G5": 783.99, "A5": 880.00,
    "B5": 987.77, "C6": 1046.50, "E6": 1318.51,
}


def build():
    """返回 {文件名: 样本列表}。所有音共用上面那套音色参数。"""
    return {
        # 单击：一个短促的上行点 —— 像被人轻轻碰了一下
        "click.wav": tone(N["C6"], 0.075, amp=0.10),

        # 摸头 / 落地：两个音的小上行，比 click 暖一点、长一点
        "pat.wav": seq(
            tone(N["E5"], 0.10, amp=0.10),
            tone(N["B5"], 0.13, amp=0.10),
        ),

        # 升级：四个音的上行琶音，最后一个是长音（"这件事值得记一笔"）
        "levelup.wav": seq(
            tone(N["C5"], 0.11),
            tone(N["E5"], 0.11),
            tone(N["G5"], 0.11),
            tone(N["C6"], 0.42, tau=0.22),
        ),

        # 番茄完成：双音叠加的柔和钟声，衰减长，收尾有余韵
        "pomdone.wav": [
            a + b for a, b in zip(
                tone(N["A5"], 0.85, amp=0.085, tau=0.30),
                tone(N["E6"], 0.85, amp=0.045, tau=0.22),
            )
        ],

        # 进入勿扰：下行两音（"我先离开一下"）
        "quiet.wav": seq(
            tone(N["G5"], 0.10, amp=0.09),
            tone(N["D5"], 0.20, amp=0.09, tau=0.14),
        ),

        # 勿扰结束 / 重新出现：上行两音（"我回来了"）
        "back.wav": seq(
            tone(N["D5"], 0.10, amp=0.09),
            tone(N["A5"], 0.22, amp=0.09, tau=0.15),
        ),
    }


def write_wav(path, samples):
    """16bit 单声道 PCM。超幅就整体缩放，绝不削顶（削顶=刺耳）。"""
    peak = max((abs(x) for x in samples), default=0.0)
    if peak > 0.99:
        samples = [x * 0.99 / peak for x in samples]
    data = b"".join(
        struct.pack("<h", int(max(-1.0, min(1.0, x)) * 32767)) for x in samples
    )
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(data)
    return len(data)


def main():
    ap = argparse.ArgumentParser(description="合成桌宠提示音（纯标准库）")
    ap.add_argument("--out", default=str(DEFAULT_OUT),
                    help="输出目录，默认 assets/sfx/")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    total = 0
    for name, samples in build().items():
        # 首尾各补 3ms 静音：有些播放器在样本 0 直接起振会有一点咔哒
        pad = [0.0] * int(RATE * 0.003)
        samples = pad + samples + pad
        size = write_wav(out / name, samples)
        total += size
        print(f"  {name:<14} {size / 1024:6.1f} KB   {len(samples) / RATE * 1000:5.0f} ms")
    print(f"\n写入 {len(build())} 个音效到 {out}，共 {total / 1024:.1f} KB")


if __name__ == "__main__":
    main()
