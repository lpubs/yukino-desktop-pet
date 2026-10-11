# 免责声明 / Disclaimer

> 本项目是一个**非官方、非商业的同人（二创）作品**。
> 请在使用、分发或引用本项目之前，完整阅读本声明。

---

## 一、关于角色与原作的版权

「雪之下雪乃」，以及《我的青春恋爱物语果然有问题。》
（やはり俺の青春ラブコメはまちがっている。）相关的角色形象、名称、设定等
**一切知识产权，均归其原始权利人所有**，包括但不限于：

| 权利类型 | 权利人 |
|---|---|
| 原作 | 渡 航（渡航 / Wataru Watari） |
| 角色设计 / 插画 | ぽんかん⑧（Ponkan8） |
| 出版 | 小学館（ガガガ文庫） |
| 动画及相关权利 | 动画版角色设计、各制作委员会等 |

本项目与上述任何个人或机构**没有任何关联**，**未获得任何形式的授权、许可或认可**。
本项目不主张、也不应被理解为对上述知识产权拥有任何权利。

---

## 二、本仓库包含角色美术素材

**本仓库包含角色立绘素材。** 明确列出，不含糊：

```
assets/sprites/maid.png     女仆装
assets/sprites/sailor.png   水手服 + 贝雷帽
assets/sprites/coat.png     冬大衣 + 围巾
assets/sprites/winter.png   冬装
assets/tray.png             托盘图标（由 maid.png 的面部裁剪生成）
build/icon.ico              安装包图标（由 maid.png 缩放生成）
```

这些图像的来源是**公开渠道上流传的原作插画与动画截图**，经本项目自研的
纯 Python 抠图脚本（`tools/cut.py`）去背处理后得到。
**处理方式不改变权属** —— 角色形象的一切知识产权仍归第一节所列的原始权利人所有，
本项目只是把它们显示在这个桌宠程序里。

> **注意区分**：`assets/sfx/` 下的 13 个提示音**不属于**上述范围。
> 它们取自 **Kenney**（kenney.nl）的 Interface Sounds / Impact Sounds 素材包，
> 该素材包以 **CC0 1.0（公共领域）** 释出 —— **可商用、不要求署名**。
> 本项目只是做了归一化（44100Hz / 单声道 / 峰值 −15dBFS / 淡入淡出），
> 未改变其授权状态。出处记在 `assets/sfx/CREDITS.md`，
> 机器可读的来源与授权清单在 `assets/sfx/sources.json`。
>
> （v3.3 及更早的版本里这六个音是 `tools/make_sfx.py` 用 Python 标准库程序合成的；
> 那条路线因为听感不过关已废弃，脚本留档在 `tools/abandoned/`。）

> **本项目对上述角色形象不主张任何权利，也未获得任何授权、许可或认可。**

因此，使用本项目时必须遵守第三节的用途限制，其中有两条与素材直接相关：

- **不得用于任何商业目的**；
- **不要把素材单独抽取出来再分发**到别的仓库、素材站、网盘或应用市场 ——
  别人需要的话，请让对方来本仓库获取。

若你是权利人并认为这里的素材不当，请按第八节联系 ——
**我会立即移除相关素材或停止分发，无需任何法律程序。**

---

## 三、用途限制

本项目仅供**个人学习、技术研究与交流**使用。明确禁止：

- 任何形式的**商业使用**，包括但不限于：出售、出租、收费下载、捆绑销售、
  作为付费服务的一部分、通过广告或会员等方式直接或间接获利；
- 将本项目或其衍生版本**重新打包分发**至应用商店、下载站、资源站、
  网盘分享等任何公开渠道；
- 以本项目名义**冒充官方**，或以任何方式暗示与原作者 / 出版方 /
  动画制作方存在关联、合作或授权关系；
- 用于任何违反使用者所在地法律法规的用途。

---

## 四、关于台词文本

`renderer/dialogue.js` 中的全部台词均为本项目**原创撰写**，
**未使用**轻小说原作、动画字幕或任何官方文本。

其中对角色性格的把握（冷静、毒舌、外冷内热）属于**角色设定层面的描述**，
不构成对任何原作文本的复制或演绎。

---

## 五、第三方组件与代码许可

本项目基于 [Electron](https://www.electronjs.org/) 构建。
Electron 及其所有依赖（完整列表见 `package.json` / `package-lock.json`）
分别遵循各自的许可协议，本项目不对它们作任何修改或再许可。

本项目**自身代码**以 **MIT 许可**发布，全文见 [`LICENSE`](LICENSE)。

> ⚠️ **MIT 许可仅覆盖代码，不覆盖任何角色知识产权。**
> 它授予你使用、修改、分发**代码**的权利，
> 但**不授予**你对「雪之下雪乃」这一角色形象的任何权利。

---

## 六、隐私说明

v3.4 起，程序读取两样与「你正在做什么」有关的东西；v3.8 又加了第三样。
三样都**只在内存里存在、不落盘、不联网、不发送到任何地方**，但值得单独说清楚。

**1. 全局光标位置（始终开启）**

主进程每 120ms 调用一次 Electron 的 `screen.getCursorScreenPoint()`，
把光标的**屏幕坐标**推给渲染层，用途只有一个：让她转头看你的鼠标。
坐标不进日志、不存文件；光标没移动时不推送。

**2. 键盘敲击**次数（**默认关闭，需在右键菜单里显式打开**）

开启后，程序挂一个全局键盘钩子（npm 包 `uiohook-napi`，基于 libuiohook），
用来判断"你现在打字快不快"。隐私边界不是口头承诺，而是写死在实现里：

- 只监听 `'keydown'` **这个事件本身**；事件对象里的 `keycode` 等字段**连读都不读**；
- **不记录你按了哪个键**、不把按键组合成文字、不做任何形式的键记录；
- 数据只活在一个 **1 秒的滑动窗口**里（用来算这一秒敲了多少下），随后被丢弃；
- 不落盘、不发送到任何地方；关闭开关时钩子会立即停止并注销。

你可以在源码里自行核对：`main.js` 的「键盘反应」一节中，整个文件没有出现
`keycode` / `rawcode` / `key` 这些字段名。不需要这个功能的话保持关闭即可，
其余全部功能不受影响。

> ⚠ 另外提醒一句：全局键盘钩子正是键盘记录器所用的那类系统 API，
> 因此**杀毒软件可能会报警或拦截**。这是该 API 的固有性质，不是本项目的特例 ——
> 若你自行打包发布，请在说明里告知使用者。

**3. 系统空闲时长（v3.8 起，始终开启）**

主进程每 5 秒调用一次 Electron 的 `powerMonitor.getSystemIdleTime()`，
它返回的是一个**秒数**：系统层面（键盘 + 鼠标，不论焦点在哪个窗口）已经多久没有输入。
用途两个，都是"你在不在"：

- 你离开一段时间后她会睡着、"你不在的时候我做了什么"那句话、健康提醒在你离开时暂停计时。

隐私边界同样是写死的：它**只返回一个时长**，没有按键内容、没有按键身份、
没有窗口标题、没有应用名 —— 这不是"我们不读"，而是这个 API 本身就不提供。
时长只在内存里参与一次比较（`> 120 秒`），随即被丢弃；不落盘、不发送。

> **另注**：你的设置（装扮 / 大小 / 位置 / 勿扰、打扰等级 / 健康提醒开关 /
> 音效与打字反应开关 / 羁绊分与统计）都存在**本机**的 `settings.json` 里（Electron 的
> `userData` 目录），程序不联网、不上传、没有账号体系 —— 想看它到底写了什么，
> 打开那个文件即可。

---

## 七、免责与责任限制

本项目按**「现状」（as-is）**提供，不提供任何形式的明示或暗示担保，
包括但不限于对适销性、特定用途适用性及非侵权性的担保。

在适用法律允许的最大范围内，作者**不对**因使用或无法使用本项目而产生的
任何直接、间接、附带、特殊或后果性损害承担责任 ——
包括但不限于数据丢失、系统故障、硬件损坏、时间损失或任何其他损失。

桌面宠物程序会创建一个**始终置顶的透明无边框窗口**并读写本地配置。
尽管已针对长期挂机做了加固（详见 `README.md` 第五节），
仍请你自行评估在你的环境中运行它的风险。

> **下载、安装、运行或使用本项目，即表示你已阅读、理解并同意本声明的全部内容。**
> 如果你不同意其中任何一条，请不要使用本项目。

---

## 八、权利方通知（Notice to Rights Holders）

本项目**无意侵犯任何人的合法权益**。

如果你是本项目所涉及知识产权的权利人，并认为本项目中的任何内容不当，
请通过仓库的 Issue 与我联系。

**我在收到有效通知后会立即删除相关内容或停止分发，无需经过任何法律程序。**

---

## English Summary

This is an **unofficial, non-commercial fan-made project**. It is not affiliated
with, endorsed by, sponsored by, or licensed by the original rights holders of
*My Youth Romantic Comedy Is Wrong, As I Expected*
(やはり俺の青春ラブコメはまちがっている。) or the character Yukinoshita Yukino.
All character-related intellectual property belongs to its respective owners
(the original author, the character designer/illustrator, the publisher, and the
anime production committees).

**This repository includes character artwork.** The four cropped sprites under
`assets/sprites/`, plus `assets/tray.png` and `build/icon.ico` derived from
them, come from publicly circulating illustrations and anime screenshots of the
character, cut out with this project's own Python tooling. Cutting them out
changes nothing about ownership: **all rights to the character and its likeness
belong to the original rights holders listed above**, and this project claims
none of them. It has no license, sponsorship, or endorsement from any rights
holder, and the artwork is included solely so that this fan-made desktop pet can
display the character. Use is limited to personal, non-commercial purposes:
**do not use it commercially, and do not re-extract and redistribute the
artwork elsewhere.** Upon valid notice from a rights holder, the artwork will be
removed or distribution stopped.

> **Note the distinction:** the 13 sound effects under `assets/sfx/` are **not**
> part of the above. They come from **Kenney**'s Interface Sounds / Impact Sounds
> packs, released under **CC0 1.0 (public domain)** — free for commercial use,
> no attribution required. This project only normalises them (44100 Hz / mono /
> −15 dBFS peak / fade in-out), which does not change their licence status.
> Provenance is recorded in `assets/sfx/CREDITS.md` and, machine-readably, in
> `assets/sfx/sources.json`.

**Permitted use:** personal study, technical research, and non-commercial
educational exchange only. **Commercial use of any kind is prohibited**, as is
repackaging and redistributing this project to app stores, download sites, or
file-sharing platforms, or implying any official affiliation.

All dialogue in `renderer/dialogue.js` is originally written for this project
and does not reproduce any text from the light novel, the anime, or any other
official source.

**Privacy:** the app polls the global cursor position every 120 ms (used only to
make the character look toward your pointer). An **optional, off-by-default**
global keyboard hook (npm `uiohook-napi`, based on libuiohook) counts **how many
key-down events occur per second** to gauge typing pace. It never reads which
keys were pressed (no `keycode` is read anywhere, verifiable in `main.js`), never
generates text, never writes to disk, and never sends data anywhere; the count
lives in a 1-second sliding window in memory and is then discarded. Note that a
global keyboard hook relies on the same OS APIs keyloggers use, so antivirus
software may flag it.

The project is built on [Electron](https://www.electronjs.org/), which and whose
dependencies remain under their own respective licenses. This project's own
source code is released under the **MIT License** (see [`LICENSE`](LICENSE)) —
which **covers the code only and grants no rights to any character intellectual
property**.

The software is provided **"as is"**, without warranty of any kind, express or
implied. To the maximum extent permitted by applicable law, the author shall not
be liable for any direct, indirect, incidental, special, or consequential
damages arising from the use of or inability to use this project. The program
creates an always-on-top transparent borderless window and reads/writes local
configuration files; please evaluate that risk for your own environment.

**By downloading, installing, running, or otherwise using this project, you
acknowledge that you have read, understood, and agreed to this disclaimer in
full.** If you do not agree with any part of it, please do not use this project.

**Notice to rights holders:** if you believe any content here is inappropriate,
please open an issue. I will remove the content or stop distribution promptly
upon receiving valid notice, without requiring any legal process.
