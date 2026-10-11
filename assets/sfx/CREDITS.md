# 音频素材来源与授权

`assets/sfx/*.wav` 全部由 `tools/prepare_sfx.py` 从下列 **CC0 公共领域** 素材
转换而来（降单声道、重采样 44.1kHz、掐静音、归一化、加淡入淡出）。

> **CC0 1.0 Universal（公共领域献出）**：可商用、可修改、可再分发，**无署名义务**。
> 这里的署名是主动做的，目的是让「这声音从哪来」有据可查 —— 与仓库其余部分
> （角色立绘**有**版权、仅限个人非商业）的性质完全不同。

## Kenney · Interface Sounds

- 授权：CC0 1.0 Universal
- 来源页：https://kenney.nl/assets/interface-sounds
- 作者：Kenney（https://kenney.nl）

## Kenney · Impact Sounds

- 授权：CC0 1.0 Universal
- 来源页：https://kenney.nl/assets/impact-sounds
- 作者：Kenney（https://kenney.nl）

## 逻辑名 -> 素材对照

| 逻辑名 | 用途 | 素材包 | 原文件 |
|---|---|---|---|
| `angry` | 生气/警告 | iface | `error_008.ogg` |
| `back` | 勿扰结束 | iface | `maximize_002.ogg` |
| `bounce` | 投掷撞墙 | impact | `impactTin_medium_001.ogg` |
| `click` | 单击 | iface | `click_001.ogg` |
| `land` | 落地 | impact | `impactSoft_medium_003.ogg` |
| `levelup` | 羁绊升级 | iface | `confirmation_002.ogg` |
| `pat` | 摸头 | iface | `pluck_002.ogg` |
| `pomdone` | 番茄完成 | iface | `glass_004.ogg` |
| `question` | 部位识别·疑惑 | iface | `question_002.ogg` |
| `quiet` | 进入勿扰 | iface | `minimize_002.ogg` |
| `select` | 换装 | iface | `select_003.ogg` |
| `toggle` | 缩放/开关 | iface | `toggle_004.ogg` |
| `type` | 打字反应 | iface | `tick_001.ogg` |

要换掉某个音：改上面的 MAP，重跑 `python tools/prepare_sfx.py` 即可。
原始素材包缓存在 `_work/sfx_raw/`（不进仓库），也可用 `--raw DIR` 指定已下好的 zip。
