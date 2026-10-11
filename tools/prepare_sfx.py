#!/usr/bin/env python3
"""雪乃桌宠 · 音效准备（CC0 素材 -> 归一化 -> assets/sfx/）

**这一版把音效从"自己合成"换成了"CC0 公共领域素材"** —— 起因很直接：
原来的合成音（纯正弦 + 18% 二次谐波）被判定"太粗糙"，那确实不是调参能解决的，
它缺的是谐波结构、瞬态和空间感，那正是录音素材才有的东西。

为什么用 CC0 而不是"网上随便一个音效库"：
    这个仓库自带 DISCLAIMER.md 和发布闸门。素材一旦来源说不清，整条发布链就断了。
    CC0（公共领域）是唯一"拿进来就能商用、能改名、能改内容、还不用署名"的授权，
    所以外部素材只从 CC0 库里取，并且把来源、原文件名、授权逐条记进 CREDITS.md。

素材来源（全部 CC0 1.0，Kenney · kenney.nl）：
    · Interface Sounds  (100 个)  —— 点击 / 确认 / 玻璃 / 问句 / 最小化 / 最大化 …
    · Impact Sounds     (130 个)  —— 落地 / 撞击的低频瞬态
    · Digital Audio     ( 60 个)  —— 备用（synthy 音色，默认未使用）

映射表 MAP 是**唯一事实源**：逻辑名（pet.js 里的 SFX_SRC）-> 素材包 + 原文件名。
tools/selftest.js 的 [11c] 会拿这张表和 pet.js / assets/sfx/*.wav 三方比对，
少一处对不上就会报出来（"加了个音效名但 wav 没生成"这类错误是静默的）。

归一化做的事（这几个音必须先过一遍，否则放一起不像一家的东西）：
    1. 降成单声道 —— 素材里有立体声也有单声道，不统一的话左右耳会有假的定位差。
    2. 重采样到 44100Hz —— **不再压到 22050**：素材源本身就是 44.1kHz 录音，
       降到 22.05 会削掉 11kHz 以上的泛音，而 glass / confirmation 那点"亮"
       恰好全在那一段，压完立刻变闷。
    3. 掐掉首尾静音 —— Kenney 的音在开头有几毫秒空白，不掐的话点击反馈会慢半拍。
    4. 首尾各做一小段淡入淡出 —— 直接起振/截断会有直流跳变，扬声器里是"啪"的一声。
    5. 峰值归一化到 PEAK_AMP —— 素材之间原始响度差得很多（glass 很轻、impact 很响），
       不归一的话有的音几乎听不见、有的会吓人一跳。
    6. 超过 MAX_MS 的截断并加长淡出 —— 提示音必须短，长了会拖在动作后面。

用法：
    python tools/prepare_sfx.py                    # 用本地缓存，缺了才下载
    python tools/prepare_sfx.py --raw DIR          # 用已经下好的 zip（离线）
    python tools/prepare_sfx.py --out DIR           # 写到别处（不动现有素材）
    python tools/prepare_sfx.py --check             # 只校验产物，不重写
"""

import argparse
import io
import json
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "assets" / "sfx"
DEFAULT_CACHE = ROOT / "_work" / "sfx_raw"      # _work/ 已被 .gitignore 排除

RATE = 44100          # 输出采样率。见文件头第 2 条，别改回 22050
PEAK_AMP = 0.18       # 峰值归一化目标 ≈ -15dBFS。桌宠长时间挂着，提示音必须"能被忽略"
FADE_MS = 3.0         # 首尾淡入淡出（短音会自动缩短，见 fade_len）
MAX_MS = 900          # 单个音效时长上限，超了截断

# ---------- 素材包 ----------
# url 是 kenney.nl 的真实下载地址（页面上的 Download 按钮指向它）。
PACKS = {
    "iface": {
        "name": "Kenney · Interface Sounds",
        "url": "https://kenney.nl/media/pages/assets/interface-sounds/"
               "fa43c1dd4d-1677589452/kenney_interface-sounds.zip",
        "license": "CC0 1.0 Universal",
        "page": "https://kenney.nl/assets/interface-sounds",
    },
    "impact": {
        "name": "Kenney · Impact Sounds",
        "url": "https://kenney.nl/media/pages/assets/impact-sounds/"
               "87b4ddecda-1677589768/kenney_impact-sounds.zip",
        "license": "CC0 1.0 Universal",
        "page": "https://kenney.nl/assets/impact-sounds",
    },
}

# ---------- 逻辑名 -> 素材 ----------
# 左列是 pet.js 的 SFX_SRC 键，右列是 (包, 原文件名)。挑的是"同一套机台音色"：
# click/select/toggle 都出自 Interface Sounds 同一批合成器，放一起不打架；
# 落地/撞击用 Impact Sounds 的低频瞬态，它们只负责"物理感"，不需要音高。
MAP = {
    # —— 原有 6 个（行为不变，只是换成了真素材）——
    "click":    ("iface",  "click_001.ogg"),        # 100ms 轻点击
    "pat":      ("iface",  "pluck_002.ogg"),        # 165ms 拨弦，比原合成音暖
    "levelup":  ("iface",  "confirmation_002.ogg"), # 539ms 上行确认音
    "pomdone":  ("iface",  "glass_004.ogg"),        # 692ms 玻璃钟，收尾有余韵
    "quiet":    ("iface",  "minimize_002.ogg"),     # 258ms 下行"我退开了"
    "back":     ("iface",  "maximize_002.ogg"),     # 258ms 上行"我回来了"

    # —— 新增交互要用的 ——
    "type":     ("iface",  "tick_001.ogg"),         #  23ms 打字轻响（播放时会随机微调音高）
    "land":     ("impact", "impactSoft_medium_003.ogg"),  # 140ms 落地闷响
    "bounce":   ("impact", "impactTin_medium_001.ogg"),   # 174ms 撞墙（金属感，听得出来是反弹）
    "angry":    ("iface",  "error_008.ogg"),        # 139ms 生气/警告
    "question": ("iface",  "question_002.ogg"),     # 333ms 疑惑（部位识别用）
    "select":   ("iface",  "select_003.ogg"),       # 383ms 换装
    "toggle":   ("iface",  "toggle_004.ogg"),       #  66ms 缩放/开关
}


# ---------- 下载 / 读取素材 ----------
def cache_path(pack):
    return DEFAULT_CACHE / (pack + ".zip")


def ensure_pack(pack, raw_dir=None):
    """返回该包的 zip 字节。优先本地缓存，其次 --raw 目录，最后才联网。"""
    if raw_dir:
        p = Path(raw_dir) / (pack + ".zip")
        if p.exists():
            return p.read_bytes()
    cp = cache_path(pack)
    if cp.exists() and cp.stat().st_size > 10000:
        return cp.read_bytes()
    url = PACKS[pack]["url"]
    print("  下载 %s ..." % url, flush=True)
    req = urllib.request.Request(url, headers={"User-Agent": "yukino-pet/1.0"})
    with urllib.request.urlopen(req, timeout=300) as r:
        data = r.read()
    if len(data) < 10000:
        raise RuntimeError("下载的 %s 只有 %d 字节，明显不对" % (pack, len(data)))
    cp.parent.mkdir(parents=True, exist_ok=True)
    cp.write_bytes(data)
    return data


# ---------- 归一化 ----------
def read_ogg(zbytes, filename):
    """从 zip 里读一个 .ogg，返回 (numpy float32 单声道, 采样率)。"""
    import numpy as np
    import soundfile as sf
    z = zipfile.ZipFile(io.BytesIO(zbytes))
    hit = [n for n in z.namelist() if n.endswith("/" + filename) or n == filename]
    if not hit:
        raise RuntimeError("zip 里找不到 " + filename)
    with z.open(hit[0]) as f:
        data, sr = sf.read(io.BytesIO(f.read()), dtype="float32", always_2d=True)
    return data, sr     # data: (frames, channels)


def to_mono(data):
    import numpy as np
    return data.mean(axis=1) if data.shape[1] > 1 else data[:, 0].copy()


def resample(x, sr_in, sr_out):
    """线性插值重采样。提示音只有几十毫秒，线性足够；省掉一个重依赖。"""
    import numpy as np
    if sr_in == sr_out:
        return x
    n_out = max(1, int(round(len(x) * sr_out / sr_in)))
    t_out = np.linspace(0.0, len(x) - 1, n_out)
    return np.interp(t_out, np.arange(len(x)), x).astype(np.float32)


def trim_silence(x, thresh=0.004):
    """掐掉首尾低于阈值的静音。阈值按归一化前的相对幅度取。"""
    import numpy as np
    if not len(x):
        return x
    loud = np.abs(x) > thresh
    if not loud.any():
        return x
    i, j = int(np.argmax(loud)), int(len(loud) - np.argmax(loud[::-1]))
    pad = int(0.002 * RATE)          # 各留 2ms，别把起振的瞬态削掉
    return x[max(0, i - pad):min(len(x), j + pad)]


def normalize(x):
    """峰值归一化。整体缩放，绝不削顶 —— 削顶就是失真，比音量小难听得多。"""
    import numpy as np
    peak = float(np.max(np.abs(x))) if len(x) else 0.0
    if peak <= 1e-6:
        return x
    return (x * (PEAK_AMP / peak)).astype(np.float32)


def fade(x, ms=None):
    """首尾淡入淡出。

    **淡变长度必须随音长自适应**，这是实测出来的：
    固定 3ms 的淡入会把 12ms 的 tick 削掉四分之一，而打击音的峰值恰好就在起振那几毫秒
    —— 量出来峰值只有 0.057 而不是目标 0.18，瞬态被生生打软了。
    现在按音长的 5% 取（夹在 0.6~3ms 之间），短音只吃一两毫秒。
    """
    import numpy as np
    n = len(x)
    if n < 4:
        return x
    if ms is None:
        ms = max(0.6, min(FADE_MS, n / RATE * 1000.0 * 0.05))
    k = min(int(RATE * ms / 1000.0), n // 5)
    if k < 2:
        return x
    win = np.ones(n, dtype=np.float32)
    ramp = np.linspace(0.0, 1.0, k, dtype=np.float32)
    win[:k] = ramp
    win[-k:] = ramp[::-1]
    return (x * win).astype(np.float32)


def limit_ms(x, max_ms=MAX_MS):
    """超长截断，并在截断处补一段淡出（硬切会"啪"）。"""
    import numpy as np
    n_max = int(RATE * max_ms / 1000.0)
    if len(x) <= n_max:
        return x
    x = x[:n_max].copy()
    k = min(int(RATE * 0.02), len(x) // 4)
    if k > 2:
        x[-k:] *= np.linspace(1.0, 0.0, k, dtype=np.float32)
    return x


def write_wav16(path, x):
    """16bit 单声道 PCM。直接用 wave 写，不引 soundfile 的输出路径（保持可控）。"""
    import numpy as np
    import wave
    clipped = np.clip(x, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2").tobytes()
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm)
    return len(pcm) + 44


def convert(zbytes, filename):
    """素材字节 -> 归一化后的单声道样本（完整流水线）。

    ⚠ 顺序有讲究：**淡变在前、归一化在后**。
    反过来的话，峰值如果落在淡入区就会被削低，而后面再没有一步把它拉回来 ——
    表现是"这个音怎么这么小声"，但看代码完全正常。
    """
    data, sr = read_ogg(zbytes, filename)
    x = to_mono(data)
    x = resample(x, sr, RATE)
    x = trim_silence(x)
    x = limit_ms(x)
    x = fade(x)
    x = normalize(x)
    return x, sr


# ---------- 产物清单 ----------
def write_manifest(out, entries):
    """sources.json = 逻辑名 -> 素材来源。selftest 拿它做三方比对，CREDITS 拿它生成。"""
    payload = {
        "note": "由 tools/prepare_sfx.py 生成。逻辑名与 renderer/pet.js 的 SFX_SRC 一一对应。",
        "rate": RATE,
        "peak_amp": PEAK_AMP,
        "packs": {k: {"name": v["name"], "license": v["license"], "page": v["page"]}
                  for k, v in PACKS.items()},
        "sounds": entries,
    }
    (out / "sources.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_credits(out):
    """给人看的授权说明。放在 assets/sfx/ 里，跟着素材一起进仓库。"""
    lines = [
        "# 音频素材来源与授权",
        "",
        "`assets/sfx/*.wav` 全部由 `tools/prepare_sfx.py` 从下列 **CC0 公共领域** 素材",
        "转换而来（降单声道、重采样 44.1kHz、掐静音、归一化、加淡入淡出）。",
        "",
        "> **CC0 1.0 Universal（公共领域献出）**：可商用、可修改、可再分发，**无署名义务**。",
        "> 这里的署名是主动做的，目的是让「这声音从哪来」有据可查 —— 与仓库其余部分",
        "> （角色立绘**有**版权、仅限个人非商业）的性质完全不同。",
        "",
    ]
    for pack, meta in PACKS.items():
        lines += [
            "## %s" % meta["name"],
            "",
            "- 授权：%s" % meta["license"],
            "- 来源页：%s" % meta["page"],
            "- 作者：Kenney（https://kenney.nl）",
            "",
        ]
    lines += [
        "## 逻辑名 -> 素材对照",
        "",
        "| 逻辑名 | 用途 | 素材包 | 原文件 |",
        "|---|---|---|---|",
    ]
    for name, (pack, src) in sorted(MAP.items()):
        lines.append("| `%s` | %s | %s | `%s` |" % (name, USAGE.get(name, ""), pack, src))
    lines += [
        "",
        "要换掉某个音：改上面的 MAP，重跑 `python tools/prepare_sfx.py` 即可。",
        "原始素材包缓存在 `_work/sfx_raw/`（不进仓库），也可用 `--raw DIR` 指定已下好的 zip。",
        "",
    ]
    (out / "CREDITS.md").write_text("\n".join(lines), encoding="utf-8")


# 用途备注，只用于生成 CREDITS 表格
USAGE = {
    "click": "单击", "pat": "摸头", "levelup": "羁绊升级", "pomdone": "番茄完成",
    "quiet": "进入勿扰", "back": "勿扰结束", "type": "打字反应",
    "land": "落地", "bounce": "投掷撞墙", "angry": "生气/警告",
    "question": "部位识别·疑惑", "select": "换装", "toggle": "缩放/开关",
}


# ---------- 校验 ----------
# 和下面的生成共用一个 MAP，所以"改了映射忘了重跑"会立刻被这里抓住。
def check(out):
    import wave
    problems = []
    wavs = {p.stem: p for p in out.glob("*.wav")}
    for name in sorted(MAP):
        p = wavs.pop(name, None)
        if p is None:
            problems.append("%s.wav 不存在" % name)
            continue
        try:
            with wave.open(str(p)) as w:
                ch, bits, rate, n = (w.getnchannels(), w.getsampwidth() * 8,
                                     w.getframerate(), w.getnframes())
        except Exception as e:
            problems.append("%s.wav 打不开：%s" % (name, e))
            continue
        if ch != 1 or bits != 16:
            problems.append("%s.wav 是 %d声道/%dbit，应为单声道 16bit" % (name, ch, bits))
        if rate != RATE:
            problems.append("%s.wav 采样率 %d，应为 %d" % (name, rate, RATE))
        ms = n / rate * 1000
        if ms > MAX_MS + 30:
            problems.append("%s.wav %dms 超过上限 %dms" % (name, ms, MAX_MS))
    for extra in sorted(wavs):
        problems.append("%s.wav 不在 MAP 里（孤儿文件，没人会播放它）" % extra)

    man = out / "sources.json"
    if not man.exists():
        problems.append("sources.json 不存在")
    else:
        try:
            got = set(json.loads(man.read_text(encoding="utf-8")).get("sounds", {}))
            miss = set(MAP) - got
            extra = got - set(MAP)
            if miss:
                problems.append("sources.json 缺: " + ", ".join(sorted(miss)))
            if extra:
                problems.append("sources.json 多出: " + ", ".join(sorted(extra)))
        except Exception as e:
            problems.append("sources.json 解析失败：%s" % e)
    if not (out / "CREDITS.md").exists():
        problems.append("CREDITS.md 不存在（授权说明必须跟着素材走）")

    if problems:
        print("校验失败：")
        for x in problems:
            print("  ✗ " + x)
        return 1
    print("校验通过：%d 个音效，格式与清单一致。" % len(MAP))
    return 0


# ---------- 入口 ----------
def main():
    ap = argparse.ArgumentParser(description="把 CC0 音效素材整理成 assets/sfx/")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="输出目录，默认 assets/sfx/")
    ap.add_argument("--raw", default=None, help="已下好的 zip 所在目录（离线用）")
    ap.add_argument("--check", action="store_true", help="只校验产物，不重写")
    args = ap.parse_args()

    try:
        import numpy  # noqa: F401
        import soundfile  # noqa: F401
    except ImportError as e:
        print("缺少依赖：%s\n请先装：pip install soundfile numpy" % e, file=sys.stderr)
        return 2

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    if args.check:
        return check(out)

    need = sorted({p for p, _ in MAP.values()})
    zips = {}
    print("准备素材包（%s）" % ", ".join(need))
    for p in need:
        zips[p] = ensure_pack(p, args.raw)
        print("  %s  ok  %.0f KB" % (p, len(zips[p]) / 1024))

    print("\n转换 %d 个音效 -> %s" % (len(MAP), out))
    entries, total = {}, 0
    for name in sorted(MAP):
        pack, src = MAP[name]
        x, sr_in = convert(zips[pack], src)
        path = out / (name + ".wav")
        size = write_wav16(path, x)
        entries[name] = {
            "pack": pack,
            "source": src,
            "source_rate": sr_in,
            "ms": round(len(x) / RATE * 1000),
            "bytes": size,
        }
        total += size
        print("  %-10s %-28s %5dms  %5.1f KB" % (name, src, len(x) / RATE * 1000, size / 1024))

    write_manifest(out, entries)
    write_credits(out)
    print("\n共 %d 个音效，%.1f KB（单声道 16bit %dHz）" % (len(MAP), total / 1024, RATE))
    print("已写 sources.json（供 selftest 三方比对）与 CREDITS.md（授权说明）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
