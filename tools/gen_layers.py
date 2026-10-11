# -*- coding: utf-8 -*-
"""用 ComfyUI（Qwen-Image-Edit-2511）生成「只改一小块」的整图，供 mklayer.py 提取差分图层。

## 为什么是"生成整图再提取差分"，而不是直接生成图层

项目里眨眼功能被删掉的原因是两条死路（见 README 第二节）：

  1. **程序合成**不出雪乃那条带锥度、挑出外眼角的粗睫毛线；
  2. **扩散模型全图重采样**会让五官漂移 —— 这正是 v1/v2 整版翻车的根因。

但这两条并不互斥：可以让扩散模型只负责**画内容**（眼睑、嘴型），
让确定性算法负责**对齐**（把新画的像素按原位贴回，其余像素一个字节都不动）。
于是本脚本只做前半段：产出一张"改了那一块的整图"；

    mklayer.py 负责把它和基准图求差、羽化、裁成 RGBA 差分图层。
    基准像素因此**逐位不变** —— 帧间对齐是算出来的，不是求模型别动的。

## 参考图为什么取"已抠好的立绘铺在白底上"

基准就是 `assets/sprites/<outfit>.png`（已抠图、已色调统一）。
把它原样铺在白底上叠回白描边，得到的就是模型最容易理解的那张"贴纸立绘"。
**画布尺寸向上取到 16 的倍数**，这样生成结果的坐标系与基准图**1:1 重合**，
差分不需要任何缩放（缩放会引入重采样模糊，对齐就成了估算）。

## 参数为什么是 4 步 / cfg 1.0

沿用本机 ComfyUI 里那份已实跑验证的「中文改图 · Qwen-Edit-2511 四步」工作流
（`user/default/workflows/` 下，链路见 build_wf 的注释）。
两个副作用要记住：

  - **cfg=1.0 时负向提示词是失效的**（标准 CFG 下输出等于正向外推，无条件分支被约掉）。
    所以"不要改别的地方"这类约束**只能写在正向提示词里**，写 negative 是自我安慰。
  - Lightning 蒸馏会把细节磨软，眼部这种小结构需要单独看。**必须逐张读图**，
    不能只看"跑通了"。
"""
import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request

import numpy as np
from PIL import Image

HOST = os.environ.get("COMFY_HOST") or "http://127.0.0.1:8188"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SPRITES = os.path.join(ROOT, "assets", "sprites")
WORK = os.path.join(ROOT, "_layerwork")

UNET = "qwen-image-edit-2511-Q4_K_M.gguf"
LORA = "qwen\\Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors"
CLIP = "qwen_2.5_vl_7b_fp8_scaled.safetensors"
VAE = "qwen_image_vae.safetensors"

# ---- 提示词 ---------------------------------------------------------------
#
# 共同前缀：既然改动范围已经由潜空间掩膜**硬性圈住**了（见 build_wf），
# 提示词就不再需要靠"别动其他地方"这种句子去拦模型 —— 那是拦不住的。
# 它现在只负责一件事：**让画出来的那一小块，和画面其余部分像同一个画师一次画完的**。
# 所以重点从"不许改"转成了"对上风格"：线条粗细、上色方式、笔触密度。
KEEP = ("这是同一张日系Q版二头身贴纸立绘的局部重绘。只修改下面指定的那一处，"
        "画风必须与画面其余部分完全一致：同样的线条粗细、同样的赛璐璐平涂上色、"
        "同样的笔触密度，看起来像原本就是同一个画师一次画完的。"
        "不要在指定处之外画任何新东西，不要添加装饰物、文字或符号。")

EDITS = {
    # 眼部四档。都写成**绝对状态**而不是"闭一半"这类相对描述 ——
    # 模型对相对描述的理解不稳定（"比原来闭一点"会得到三种完全不同的结果）。
    "eye_closed": (
        "只把她的眼睛改成**完全闭合**：上下眼睑合拢，"
        "闭合的眼睑画成一条带锥度的深色睫毛曲线，外眼角略粗、内眼角略细，"
        "线条粗细与原来的上睫毛线一致。眼睑下方不要露出眼白和瞳孔。"
        "眉毛保持原样不动。"),
    "eye_half": (
        "只把她的眼睛改成**只睁开一条缝**：上眼睑大幅度下落，遮住瞳孔的三分之二，"
        "眼睛变成细长的缝隙形状，只能看到瞳孔下缘的一小条和少许眼白，"
        "睫毛线随眼睑一起下移、贴在缝隙上方。不要画成睁开的眼睛。"
        "眉毛保持原样不动。"),
    "eye_happy": (
        "只把她的眼睛改成**两只都闭起来的弯月形笑眼**：左右两只眼睛的形状必须**完全对称**，"
        "都是向上拱起的弧线（像 ^ 形），弧线中部略粗、两端收细，笔触与原来的上睫毛线一致。"
        "不要画瞳孔，不要一睁一闭，不要画成单眼眨眼。"
        "眉毛保持原样不动。"),
    # 调皮的单眼眨眼。
    # ⚠ 现在跑这条**不会**得到仓库里那张 eye_wink.png：那张是早期一版"弯月笑眼"的措辞
    #   在 4 步蒸馏下被模型理解成了单眼眨眼的**副产物** —— 效果反而比它本来该产出的
    #   "对称笑眼"更适合当"调皮"这一档，所以留下了。这里的措辞是把它**明确固化**的版本，
    #   属于"把一次侥幸变成一条可复现的指令"；但既然措辞变了，重跑出来就是一张新图，
    #   必须按项目铁律逐张读图验收（`_qa_*.png` 三栏对照），不能假定它和旧图一致。
    #   左右方向按**画面**描述 —— 模型没有"她的左眼"这个概念，只会按画面坐标理解。
    "eye_wink": (
        "只把她的眼睛改成**调皮的单眼眨眼**：画面左侧的那只眼睛闭合成向上拱起的弧形笑眼，"
        "弧线中部略粗、两端收细，笔触与原来的上睫毛线一致，不画瞳孔；"
        "画面右侧的那只眼睛保持睁开、瞳孔与高光都不变。两只眼睛的形状必须明显不同。"
        "眉毛保持原样不动。"),
    # 口型两档。
    "mouth_smile": (
        "只把她的嘴巴改成**闭嘴的浅笑**：嘴角略微上扬，嘴唇闭合，"
        "画成一条细的单线弧线，不要露牙齿、不要张嘴。"),
    "mouth_open": (
        "只把她的嘴巴改成**微微张开**：嘴巴张开成一个小小的竖向椭圆，"
        "像正在说话，能看到一点深色的口腔内部，不要露舌头、不要露牙齿。"),
    # 走动两帧（v3.11）。**只有 winter 有** —— 它是四套里唯一的全身像，
    # 其余三套是胸像/半身，下装要么看不见要么只占立绘高的 8.75%（量过，见 featmask 的 `_hem`）。
    # 两帧描述成**绝对状态**而不是"比刚才摆一点"：模型对相对描述不稳定（同 eye_half 的教训）。
    # 方向按**画面**说 —— 模型没有"她的左腿"这个概念。
    # ★ 走动两帧（v3.11）。**只晃裙摆**，不去摆腿 —— 这条是实拍量出来的，不是保守：
    #   源立绘在画面**下缘**就把腿裁断了（脚根本不在画面里，见 _hem_probe 那张对照）。
    #   提示词一旦写"腿向前迈"，模型就只能凭空造出脚和鞋来补全，
    #   出来的是**另一副姿态**（实测 walk_b 直接变成双腿交叉＋一只伸到画面外的黑鞋）。
    #   所以这里改成"腿和袜子保持原样、只让格子裙摆向一侧扬起"：
    #   裙摆整个在画面内，改动有界，而且和 #petWrap 的左右倾是同一个方向感。
    "walk_a": (
        "只把她的**格子裙裙摆**改成被走动带起、向**画面左侧**扬起的样子："
        "裙褶被拉向同一侧，裙摆边缘离开它原本的位置，裙子下缘因此成了一条左高右低的斜线。"
        "**以下全部保持原样不动**：两条腿与长袜的位置和形状、大衣下摆、挎包、围巾、上半身。"
        "**不要画出脚或鞋子**，不要在画面下缘之外补任何东西。"
        "整体构图与裁切范围完全不变。"),
    "walk_b": (
        "只把她的**格子裙裙摆**改成被走动带起、向**画面右侧**扬起的样子："
        "裙褶被拉向同一侧，裙摆边缘离开它原本的位置，裙子下缘因此成了一条右高左低的斜线。"
        "**以下全部保持原样不动**：两条腿与长袜的位置和形状、大衣下摆、挎包、围巾、上半身。"
        "**不要画出脚或鞋子**，不要在画面下缘之外补任何东西。"
        "整体构图与裁切范围完全不变。"),
}

# 固定种子：同一目标多次重跑要能对比，seed 一变就成了比"两张不同的图"。
BASE_SEED = 20261008


def canvas_size(w, h):
    """画布向上取到 16 的倍数 —— 生成坐标系与基准图 1:1 重合，见文件头。"""
    return ((w + 15) // 16 * 16, (h + 15) // 16 * 16)


def make_ref(outfit, dst):
    """把 RGBA 立绘铺在白底上 → RGB 参考图，连同画布尺寸一起返回。

    铺白底是**必须**的：模型看到透明通道会渲染成黑/格纹底，
    而我们要的是它眼里那张"带白描边的贴纸"。
    """
    im = Image.open(os.path.join(SPRITES, outfit + ".png")).convert("RGBA")
    w, h = im.size
    cw, ch = canvas_size(w, h)
    canvas = Image.new("RGB", (cw, ch), (255, 255, 255))
    canvas.paste(im, (0, 0), im)
    canvas.save(dst)
    return cw, ch, (w, h)


def upload(path, name):
    boundary = "----yukinolayer7"
    with open(path, "rb") as f:
        data = f.read()
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; "
            f"filename=\"{name}\"\r\nContent-Type: image/png\r\n\r\n").encode() \
        + data + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(HOST + "/upload/image", data=body,
                                 headers={"Content-Type":
                                          f"multipart/form-data; boundary={boundary}"})
    return json.loads(urllib.request.urlopen(req, timeout=180).read())["name"]


def build_wf(ref_name, w, h, prompt, seed, steps=4, cfg=1.0, prefix="yk_layer",
             mask_name=None, denoise=1.0):
    """沿用 03 号工作流的四步链路（已实跑验证），外加**潜空间掩膜**。

    mask_name 不给时是裸编辑（会整张重绘，只用于对照）；
    给了时 14→15→16 三个节点把去噪范围圈死在掩膜内 ——
    `SetLatentNoiseMask` 之后，掩膜外那份 latent 就是参考图的编码，
    采样器每步只更新掩膜内的部分，所以**框外像素不受模型漂移影响**。
    """
    wf = {
        "1": {"class_type": "UnetLoaderGGUF", "inputs": {"unet_name": UNET}},
        "2": {"class_type": "LoraLoaderModelOnly",
              "inputs": {"model": ["1", 0], "lora_name": LORA, "strength_model": 1.0}},
        "3": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["2", 0], "shift": 3.0}},
        "4": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": CLIP, "type": "qwen_image", "device": "default"}},
        "5": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "6": {"class_type": "LoadImage", "inputs": {"image": ref_name}},
        "7": {"class_type": "ImageScale",
              "inputs": {"image": ["6", 0], "upscale_method": "lanczos",
                         "width": w, "height": h, "crop": "disabled"}},
        "8": {"class_type": "VAEEncode", "inputs": {"pixels": ["7", 0], "vae": ["5", 0]}},
        "9": {"class_type": "TextEncodeQwenImageEditPlus",
              "inputs": {"clip": ["4", 0], "vae": ["5", 0], "image1": ["7", 0], "prompt": prompt}},
        # cfg=1.0 下这个节点形同虚设（见文件头），但链路里保留它，
        # 是因为提速换 8 步 / cfg=2.5 时要能直接用。
        "10": {"class_type": "TextEncodeQwenImageEditPlus",
               "inputs": {"clip": ["4", 0], "vae": ["5", 0], "image1": ["7", 0], "prompt": ""}},
        "11": {"class_type": "KSampler",
               "inputs": {"model": ["3", 0], "positive": ["9", 0], "negative": ["10", 0],
                          "latent_image": ["8", 0], "seed": seed, "steps": steps, "cfg": cfg,
                          "sampler_name": "euler", "scheduler": "simple", "denoise": denoise}},
        "12": {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["5", 0]}},
        "13": {"class_type": "SaveImage", "inputs": {"images": ["12", 0], "filename_prefix": prefix}},
    }
    if mask_name:
        wf["14"] = {"class_type": "LoadImage", "inputs": {"image": mask_name}}
        # ⚠ 不能直接用 LoadImage 的 MASK 口：那个口是 `1 - alpha`，
        #   而无 alpha 的 PNG 会返回全 0（nodes.py 里的 `else: zeros(64,64)`）。
        #   掩膜是以 RGB 灰度存的，取红通道才是原值。
        wf["15"] = {"class_type": "ImageToMask",
                    "inputs": {"image": ["14", 0], "channel": "red"}}
        wf["16"] = {"class_type": "SetLatentNoiseMask",
                    "inputs": {"samples": ["8", 0], "mask": ["15", 0]}}
        wf["11"]["inputs"]["latent_image"] = ["16", 0]
    return wf


def submit(wf):
    req = urllib.request.Request(
        HOST + "/prompt", data=json.dumps({"prompt": wf}).encode(),
        headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=90).read())["prompt_id"]


def wait(pid, timeout=1800):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            h = json.loads(urllib.request.urlopen(HOST + f"/history/{pid}", timeout=20).read())
        except Exception:
            time.sleep(2)
            continue
        if pid in h:
            st = h[pid].get("status", {})
            if st.get("status_str") == "error":
                raise RuntimeError("ComfyUI 报错: " + json.dumps(st, ensure_ascii=False)[:800])
            for _node, out in h[pid].get("outputs", {}).items():
                for img in out.get("images", []):
                    return img["filename"], img.get("subfolder", "")
            return None, None
        time.sleep(2)
    raise TimeoutError(f"等待超时 {pid}")


def fetch(fname, subfolder, dest):
    q = urllib.parse.urlencode({"filename": fname, "subfolder": subfolder, "type": "output"})
    with urllib.request.urlopen(HOST + "/view?" + q, timeout=300) as r:
        data = r.read()
    with open(dest, "wb") as f:
        f.write(data)


def run_one(outfit, edit, steps=4, seed=None, force=False, nomask=False, denoise=1.0,
            tag=None, mask_kind=None):
    if edit not in EDITS:
        raise SystemExit(f"未知的改动名 {edit}（可选：{', '.join(EDITS)}）")
    # tag 只影响落盘位置，不影响任何生成参数。
    # 存在的理由很具体：整帧版和差分版要能**并存**，否则比对时只能重跑一次，
    # 而重跑会覆盖掉上一版 —— 而"这一版是不是真的更好"正是这次要回答的问题。
    outdir = os.path.join(WORK, outfit, tag) if tag else os.path.join(WORK, outfit)
    os.makedirs(outdir, exist_ok=True)
    dst = os.path.join(outdir, f"{edit}.png")
    if os.path.exists(dst) and not force:
        print(f"  [{outfit}/{edit}] 已存在，跳过（--force 覆盖）")
        return dst

    ref = os.path.join(outdir, "_ref.png")
    cw, ch, (sw, sh) = make_ref(outfit, ref)
    print(f"  [{outfit}/{edit}] 画布 {cw}x{ch}（立绘 {sw}x{sh}）", flush=True)

    # 掩膜类型由改动名推出：eye_* 圈眼睛，mouth_* 圈嘴。
    # 这层映射是**刻意显式**的 —— 掩膜圈错地方不会报错，只会安静地生成一张错图。
    # 另外两档是 v3.10 加的，各自针对一种**椭圆掩膜解决不了**的失效：
    #   face     圈**整张脸**。椭圆只圈住眼球，而原眼的外眼角睫毛挑在椭圆外，
    #            叠回去时那截旧睫毛就留在下面 —— 就是"闭了眼底下还有一道弧"。
    #   mouthbox 圈**嘴区矩形**。不用整张脸，是为了让眼/嘴两块范围**不相交**：
    #            两层叠加时上面那层会盖掉下面那层重画的结果，重叠就等于
    #            "边眨眼边说话时眼睛忽然睁开"。
    # walk_* 的两帧共用同一个"下装"掩膜（见 featmask 的 `_hem`）。
    kind = mask_kind or ({"walk": "hem"}.get(edit.split("_", 1)[0])
                         or (edit.split("_", 1)[0] if edit.startswith(("eye", "mouth")) else None))
    mask_name = None
    if kind and not nomask:
        import featmask
        if kind == "face":
            m, _ = featmask.build_face(outfit)
        elif kind == "mouthbox":
            m, _ = featmask.build_mouth(outfit)
        elif kind == "hem":
            m, _ = featmask.build_hem(outfit)
        else:
            m, _ = featmask.build(outfit, kind)
        cm, (mcw, mch) = featmask.to_canvas(m, sw, sh)
        assert (mcw, mch) == (cw, ch), f"掩膜画布 {mcw}x{mch} 与参考图 {cw}x{ch} 不一致"
        mg = np.round(np.clip(cm, 0, 1) * 255).astype(np.uint8)
        mp = os.path.join(outdir, f"_mask_{kind}.png")
        Image.fromarray(np.dstack([mg, mg, mg]), "RGB").save(mp)
        mask_name = upload(mp, f"ykl_{outfit}_mask_{kind}.png")
        print(f"  [{outfit}/{edit}] 掩膜 {kind}：覆盖 {cm.mean() * 100:.1f}% 画布", flush=True)

    ref_name = upload(ref, f"ykl_{outfit}_ref.png")
    wf = build_wf(ref_name, cw, ch, KEEP + EDITS[edit],
                  seed if seed is not None else BASE_SEED, steps=steps,
                  prefix=f"ykl_{outfit}_{edit}", mask_name=mask_name, denoise=denoise)
    t0 = time.time()
    pid = submit(wf)
    print(f"  [{outfit}/{edit}] pid={pid} 开始采样", flush=True)
    fname, sub = wait(pid)
    if not fname:
        print(f"  [{outfit}/{edit}] 没有输出")
        return None
    fetch(fname, sub, dst)
    print(f"  [{outfit}/{edit}] OK {round(time.time() - t0)}s -> {os.path.relpath(dst, ROOT)}",
          flush=True)
    return dst


def main():
    ap = argparse.ArgumentParser(description="生成「局部改动版」整图（Qwen-Image-Edit-2511）")
    ap.add_argument("outfit", help="套装，如 maid")
    ap.add_argument("edits", nargs="*", help=f"改动名，留空=全部。可选：{', '.join(EDITS)}")
    ap.add_argument("--steps", type=int, default=4)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--force", action="store_true", help="已存在也重跑")
    ap.add_argument("--nomask", action="store_true",
                    help="不做潜空间掩膜，裸编辑。只用于对照（裸编辑会整张重绘，见 build_wf 说明）")
    # ★ 掩膜 + 部分去噪 = 在「基准态」和「目标态」之间插值。
    #   这是分层方案里最有用的一根杠杆：模型只肯在"睁/闭"两端跳（eye_half 试了两次
    #   都拿不到中间态），但把 denoise 降到 0.7 就能让源图的信息部分存活，
    #   于是同一个提示词直接给出中间态 —— 不需要模型理解"一半"这个概念。
    #   代价：Lightning 是 4 步蒸馏的，denoise 0.7 实际只剩 2~3 步，
    #   所以中间态要配 --steps 8 用，否则细节会糊。
    ap.add_argument("--denoise", type=float, default=1.0,
                    help="去噪强度。1.0=完全重绘掩膜内；0.5~0.8 在基准态与目标态之间插值")
    # ★ v3.10「整帧替换」用的就是这条路：--nomask 把潜空间掩膜摘掉，
    #   模型于是能看到整张脸（而不是一个椭圆里的眼球），画出来的眼睑
    #   和周围的皮肤、头发、明暗是一次画完的 —— 没有贴片边界，也就没有
    #   v3.9 那版的"底下还留着半截旧睫毛"的重影。
    #   代价从"接缝"换成了"漂移"：整张图都会被重采样，发丝、描边会微动。
    #   所以这一路必须配 --tag full 落到独立目录，再由 mkframe.py 做全局配准与量化。
    ap.add_argument("--tag", default=None,
                    help="输出到 _layerwork/<套装>/<tag>/，与旧素材并存（比对用）")
    # 掩膜范围的显式覆盖。默认按改动名推（eye_*/mouth_*），
    # face = 整张脸、mouthbox = 嘴区矩形 —— 用来消掉椭圆掩膜漏掉的那截旧睫毛（v3.10）。
    ap.add_argument("--mask-kind", default=None,
                    choices=["eye", "mouth", "face", "mouthbox", "hem"],
                    help="覆盖掩膜范围；face = 整张脸，mouthbox = 嘴区矩形，hem = 下装/下摆")
    a = ap.parse_args()

    try:
        urllib.request.urlopen(HOST + "/system_stats", timeout=8)
    except Exception:
        sys.exit(f"连不上 ComfyUI（{HOST}）。请先启动本机的 ComfyUI 服务再重跑"
                 f"（启动脚本在 ComfyUI 安装目录下，本文件不写本机绝对路径 —— 见第九节隐私闸门）")

    targets = a.edits or list(EDITS)
    for e in targets:
        try:
            run_one(a.outfit, e, steps=a.steps, seed=a.seed, force=a.force, nomask=a.nomask,
                    denoise=a.denoise, tag=a.tag, mask_kind=a.mask_kind)
        except Exception as ex:
            print(f"  [{a.outfit}/{e}] 失败：{repr(ex)[:400]}", flush=True)
    print("完成。")


if __name__ == "__main__":
    main()
