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

## 二、本仓库不包含任何角色美术素材

**为避免再分发原作品的美术资源，本仓库不包含任何角色立绘、插画或官方图像。**

以下文件全部是 `tools/make_placeholder.py` **程序生成的纯几何灰色占位图**
（圆 + 梯形 + 虚线框 + 说明文字），**不含任何角色形象**：

```
assets/sprites/maid.png     assets/sprites/sailor.png
assets/sprites/coat.png     assets/sprites/winter.png
assets/tray.png             build/icon.ico
```

如果你希望在本地使用真实的角色立绘，需要**自行准备并替换**。但请注意：

> **替换素材是你个人的行为，由此产生的一切版权责任由你自行承担。**
> 请确保你使用的素材来源合法，并仅限于你个人的学习与观赏用途 ——
> **不要再把它重新分发出去。**

替换方法见 `README.md` 第三节。

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

## 六、免责与责任限制

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

## 七、权利方通知（Notice to Rights Holders）

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

**This repository contains no character artwork.** Every image under
`assets/sprites/`, plus `assets/tray.png` and `build/icon.ico`, is a
procedurally generated grey placeholder produced by
`tools/make_placeholder.py`, containing no character likeness. If you replace
them with real artwork locally, that is your own action and your own
responsibility — do not redistribute it.

**Permitted use:** personal study, technical research, and non-commercial
educational exchange only. **Commercial use of any kind is prohibited**, as is
repackaging and redistributing this project to app stores, download sites, or
file-sharing platforms, or implying any official affiliation.

All dialogue in `renderer/dialogue.js` is originally written for this project
and does not reproduce any text from the light novel, the anime, or any other
official source.

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
