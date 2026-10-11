#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""发布前隐私闸门：扫出「不该出现在公开仓库里」的东西，命中即阻断发布。

## 为什么需要它

发布流程是 `_gh_build_repo.sh` 把 v3/ 里要开源的部分拷进 `_gh_repo/`，
再由 `_gh_publish.py` 推到 GitHub。**一旦本机路径 / 令牌 / 用户名混进去，
推上去就收不回来了** —— 历史重写麻烦，而且可能已经被抓取或缓存。

所以这道闸门卡在 `git commit` 之前：命中就退出码 1，脚本 set -e 直接中断。

## 设计要点：扫描器自己不含隐私

私密词的来源**全部在运行时推导**，一个都不写死在源码里 ——
否则这份扫描器本身就成了泄露源（它是要被上传的）。推导来源：

  1. **本机用户名** —— `USERNAME` / `USER` / `getpass.getuser()` / 家目录末段
  2. **家目录绝对路径** —— 正斜杠、反斜杠、大小写各种写法
  3. **环境变量里像凭证的** —— 键名含 TOKEN / KEY / SECRET / PAT / PASSWORD 的
  4. **本机黑名单文件**（可选，见下）—— 放「个人命名的目录名」这类推导不出来的词

在此之上，再叠一批**通用凭证形态**（GitHub / OpenAI / AWS / Slack / 私钥头…）。
这些是公开的格式规则，本身不含任何具体值，可以安全地随仓库分发。

## 什么算「干净」，不会被拦

* **通用系统路径**：`C:\\Windows\\Fonts\\msyh.ttc`、
  `C:\\Program Files\\...\\msedge.exe` 这类是标准安装位置，
  不含任何使用者标识，属可公开 —— 绝对路径规则带白名单前缀，命中白名单放行。
* **相对路径**：`01_需求与参考图/服饰参考图` 不含使用者标识，允许。
* **二进制文件**：PNG / ICO / ONNX 等一律跳过（按 NUL 字节嗅探，不靠扩展名）。
* 文件里写了 `scan:ignore` 标记的行跳过 —— 给确实需要写示例的地方留出口。

## 本机黑名单（可选，推荐配一份）

推导不出来的个人词（比如你给项目目录起的名字）写在**不进版本库**的文件里，
每行一个词，`#` 开头是注释：

    <项目根>/_work/privacy-denylist.txt

`_work/` 已被 `.gitignore` 排除、也不会被 `_gh_build_repo.sh` 拷进公开仓库，
所以这份黑名单永远跟着你本机走。也可以用环境变量临时补：

    YUKINO_PRIVACY_WORDS="词1,词2"

★ **扫暂存仓库时必须显式传路径**：`_gh_repo/` 下没有 `_work/`，
自动发现找不到黑名单，于是「个人目录名」这类最该拦的词会悄无声息地放行。
`_gh_build_repo.sh` 与 `_gh_publish.py` 都已经显式传了 `--words-file`；
自己手动跑的时候别忘了，或者用 `--words-file` 指错路径时它会直接报错退出（不会静默放行）。

## 用法

    python tools/scan_secrets.py                    # 扫本目录工作区
    python tools/scan_secrets.py --dir . --strict   # 有命中退出码 1（闸门模式）

    # ★ 推送前的闸门：按 git 索引扫，扫的就是将要推送的那些字节
    python tools/scan_secrets.py --dir _gh_repo --from-index --strict \
        --words-file v3/_work/privacy-denylist.txt --branch v3 --tag v3.2.2

退出码：0 = 干净；1 = 有命中（仅 --strict）；2 = 用法/路径错误（含 --words-file 不存在）。
"""
from __future__ import annotations

import argparse
import getpass
import os
import re
import subprocess
import sys
from pathlib import Path

# --------------------------------------------------------------------------
# 1) 通用凭证形态 —— 公开格式规则，不含具体值，可安全随仓库分发
# --------------------------------------------------------------------------
GENERIC_RULES: list[tuple[str, re.Pattern]] = [
    ("GitHub classic PAT", re.compile(r"ghp_[A-Za-z0-9]{16,}")),
    ("GitHub 细粒度 PAT", re.compile(r"github_pat_[A-Za-z0-9_]{20,}")),
    ("GitHub OAuth/App 令牌", re.compile(r"gh[ousr]_[A-Za-z0-9]{20,}")),
    ("OpenAI 风格密钥", re.compile(r"sk-[A-Za-z0-9][A-Za-z0-9\-_]{19,}")),
    ("Anthropic 风格密钥", re.compile(r"sk-ant-[A-Za-z0-9\-_]{20,}")),
    ("AWS Access Key ID", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("Google API Key", re.compile(r"AIza[0-9A-Za-z\-_]{35}")),
    ("Slack 令牌", re.compile(r"xox[baprs]-[0-9A-Za-z\-]{10,}")),
    ("npm 令牌", re.compile(r"npm_[A-Za-z0-9]{36}")),
    ("私钥文件头", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    (
        "硬编码 Authorization 头",
        re.compile(
            r"Authorization\s*[:=]\s*[\"']?(?:Bearer|token)\s+[A-Za-z0-9._\-]{20,}",
            re.I,
        ),
    ),
    (
        "赋值式密钥字面量",
        re.compile(
            r"(?:api[_-]?key|secret|passwd|password|access[_-]?token|auth[_-]?token)"
            r"\s*[:=]\s*[\"'][A-Za-z0-9._\-]{16,}[\"']",
            re.I,
        ),
    ),
]

# --------------------------------------------------------------------------
# 2) 本机绝对路径 —— 带白名单前缀
# --------------------------------------------------------------------------
SAFE_PATH_PREFIXES = (
    r"c:\windows",
    r"c:\program files",
    r"c:\program files (x86)",
    r"c:\programdata",
    r"c:\$recycle.bin",
)


def _norm_path(s: str) -> str:
    """统一成小写正斜杠形态，便于比对白名单前缀。

    两个坑：
      * 源码里可能写成转义过的双反斜杠，先把 \\\\ 折成单个反斜杠；
      * 路径里的空格会让「匹配出的片段」在空格处截断，
        所以比对时必须用抹平后的整行片段，不能只看匹配到的那一小段。
    """
    return s.replace("\\\\", "\\").replace("\\", "/").lower()


_SAFE_NORM = tuple(_norm_path(p) for p in SAFE_PATH_PREFIXES)


def _is_safe_path(seg: str) -> bool:
    """seg 是「从盘符起点到行尾」的原文，不是截断片段。

    前缀必须落在**完整的目录段边界**上：白名单前缀之后只能跟分隔符或
    非路径字符，否则把白名单目录名往后延长几个字母写成的路径，
    会被误判成落在白名单里。
    """
    s = _norm_path(seg)
    for pre in _SAFE_NORM:
        if s == pre:
            return True
        nxt = s[len(pre):len(pre) + 1]
        if s.startswith(pre) and not (nxt.isalnum() or nxt in "._-"):
            return True
    return False


# 盘符路径：字母 + 冒号 + 分隔符。lookbehind 排除「前一个字符是词字符」的伪命中 ——
# 协议头（http、file）与正则转义写法都会踩到这里。
_DRIVE_PATH = re.compile(
    r"(?<![A-Za-z0-9_])([A-Za-z]):([\\/])([^\s\"'`)\]}>,;|]*)"
)
# Git-Bash 风格的家目录路径，以及任何出现「Users」目录段的地方
_USERS_PATH = re.compile(r"[\\/]Users[\\/][^\s\"'`)\]}>,;|]+")

# --------------------------------------------------------------------------
# 3) 默认跳过的目录 / 文件
# --------------------------------------------------------------------------
EXCLUDE_DIRS = {
    ".git", "node_modules", "dist", "models", "__pycache__",
    ".venv", "venv", "_work", "_review", ".idea", ".vscode", ".mypy_cache",
}
SKIP_EXT = {
    ".png", ".ico", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".onnx",
    ".exe", ".dll", ".zip", ".7z", ".ttf", ".ttc", ".woff", ".woff2",
    ".mp4", ".pdf", ".xlsx", ".sqlite", ".bin", ".node", ".wav",
}
MAX_BYTES = 2 * 1024 * 1024
SMALL_NUMBERS = re.compile(r"^[\d._\-+]+$")


def decode_text(raw: bytes) -> str | None:
    """二进制 / 超大一律返回 None；解码顺序 utf-8 → gbk。

    `.bat` 是 GBK 落盘的（见 tools/gen_launchers.py），必须单独兜一层。
    """
    if len(raw) > MAX_BYTES or b"\x00" in raw[:8192]:
        return None
    for enc in ("utf-8", "gbk"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


def read_text(p: Path) -> str | None:
    try:
        raw = p.read_bytes()
    except OSError:
        return None
    return decode_text(raw)


def iter_index_files(root: Path) -> list[tuple[str, str]] | None:
    """枚举 **git 索引**里的文件，返回 [(仓库内相对路径, 文本)]。

    ★ 为什么推送前必须按索引扫，而不是按工作区扫：

    推送走的是 `git ls-files -s` 取 sha、再 `git cat-file blob <sha>` 取内容 ——
    也就是**索引里的 blob**。工作区与索引可能不一致，而两个方向都能让闸门失效：

      * 索引里有、工作区已删 —— 扫工作区看不到它，但推送**会**把它带上去；
      * 索引与工作区内容不同（`git add` 之后又被改过）—— 闸门扫的是 A，推的是 B。

    所以 `--from-index` 让闸门扫「将要离开本机的那些字节」本身，
    而不是扫一份可能与它不同的副本。这比事后比对文件清单更彻底。

    返回 None 表示这不是一个 git 仓库。
    """
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            check=True,
        ).stdout
    except Exception:
        return None

    items: list[tuple[str, str]] = []
    for name in out.split("\0"):
        if not name:
            continue
        if Path(name).suffix.lower() in SKIP_EXT:
            continue
        # `:path` 取索引版本 —— 不是 HEAD、也不是工作区
        raw = subprocess.run(
            ["git", "-C", str(root), "cat-file", "blob", f":{name}"],
            capture_output=True,
        ).stdout
        text = decode_text(raw)
        if text is not None:
            items.append((name, text))
    return items


def iter_files(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        # ★ 下划线开头的目录一律跳过（`_work` / `_review` / `_layerwork` …）：
        #   与 `.gitignore` 的 `_*/` 同一约定 —— 它们只属于本机、不进仓库。
        #   ⚠ `--from-index` 那条路**故意不做**这个跳过：扫索引时查的是
        #   "将要离开本机的那些字节"，若真有人把下划线目录强 add 进索引，
        #   那正是该被拦下来的情况（跳过它才是放水）。
        dirnames[:] = [d for d in dirnames
                       if d not in EXCLUDE_DIRS and not d.startswith("_")]
        for fn in filenames:
            p = Path(dirpath) / fn
            if p.suffix.lower() in SKIP_EXT:
                continue
            yield p


# --------------------------------------------------------------------------
# 4) 运行时推导的本机私密词
# --------------------------------------------------------------------------
def derived_terms(root: Path) -> dict[str, list[str]]:
    """返回 {词: [来源说明]}。全部由运行环境推导，不写死在源码里。"""
    out: dict[str, list[str]] = {}

    def add(term: str, why: str) -> None:
        term = (term or "").strip()
        if len(term) < 3:
            return
        # 纯数字词（比如全数字的用户名）短于 4 位就不收，避免满屏误报
        if SMALL_NUMBERS.match(term) and len(term) < 4:
            return
        out.setdefault(term, []).append(why)

    for var in ("USERNAME", "USER", "LOGNAME"):
        v = os.environ.get(var)
        if v:
            add(v, f"环境变量 {var}")
    try:
        add(getpass.getuser(), "getpass.getuser()")
    except Exception:
        pass

    home = Path.home()
    if home.name:
        add(home.name, "家目录末段")
    for form in (str(home), home.as_posix(), str(home).replace("/", "\\")):
        if len(form) >= 6:
            out.setdefault(form, []).append("家目录路径")

    home_env = os.environ.get("USERPROFILE") or os.environ.get("HOME")
    if home_env and len(home_env) >= 6:
        out.setdefault(home_env, []).append("家目录环境变量")
        out.setdefault(home_env.replace("\\", "/"), []).append("家目录环境变量(/)")

    # 环境变量里看着像凭证的，只按「值」拦，不打印值本身
    for k, v in os.environ.items():
        if not re.search(r"TOKEN|KEY|SECRET|PASSWD|PASSWORD|_PAT$|CREDENTIAL", k, re.I):
            continue
        v = (v or "").strip()
        if len(v) >= 8:
            out.setdefault(v, []).append(f"环境变量 {k}")

    return out


def load_denylist(paths: list[Path], root: Path) -> tuple[dict[str, str], list[str]]:
    """返回 ({词: 来源}, [显式指定却不存在的文件])。

    ★ 两种来源的缺文件行为必须不同：

      * `--words-file` **显式指定**的文件不存在 → 报错退出。
        这条路装的正是「从环境推导不出来」的个人词（个人目录名之流），
        静默跳过 = 闸门在最关键的一类规则上失效，而且全程无提示。
        路径写错一个字符就能让整套黑名单形同虚设。
      * `root/_work/...` **自动发现**的候选不存在 → 正常。
        比如推送前扫的是 `_gh_repo/`，它本来就没有 `_work/`。

    返回值里带回 missing，由 main 决定怎么处理（库函数不该直接 exit）。
    """
    words: dict[str, str] = {}

    missing = [str(c) for c in paths if not c.is_file()]

    candidates = list(paths) + [
        root / "_work" / "privacy-denylist.txt",
        root / ".privacy-denylist",
    ]
    for c in candidates:
        if not c.is_file():
            continue
        text = read_text(c) or ""
        for line in text.splitlines():
            line = line.split("#", 1)[0].strip()
            if line:
                words[line] = f"黑名单 {c.name}"

    env = os.environ.get("YUKINO_PRIVACY_WORDS", "")
    for w in env.split(","):
        w = w.strip()
        if w:
            words[w] = "环境变量 YUKINO_PRIVACY_WORDS"

    return words, missing


# --------------------------------------------------------------------------
# 5) 扫描
# --------------------------------------------------------------------------
class Hit:
    __slots__ = ("path", "line", "rule", "sample")

    def __init__(self, path: Path, line: int, rule: str, sample: str):
        self.path, self.line, self.rule, self.sample = path, line, rule, sample


def redact(s: str) -> str:
    s = s.strip()
    if len(s) <= 12:
        return s
    return s[:6] + "…" + f"(len={len(s)})"


_ALNUM_TERM = re.compile(r"^[a-z0-9]+$")


def _term_hit(low: str, term: str) -> bool:
    """私密词是否命中该行。

    纯字母数字的词（典型是全数字的用户名）必须落在**词边界**上：
    否则 package-lock.json 里几百 KB 的 base64 完整性哈希会疯狂误报 ——
    全数字的用户名很容易恰好是某段哈希的子串。
    含符号或中文的词不受此限（它们本来就够独特）。
    """
    if not _ALNUM_TERM.match(term):
        return term in low
    for m in re.finditer(re.escape(term), low):
        before = low[m.start() - 1] if m.start() else ""
        after = low[m.end():m.end() + 1]
        if not re.match(r"[a-z0-9]", before) and not re.match(r"[a-z0-9]", after):
            return True
    return False


def scan_text(text: str, path: Path, terms: dict[str, list[str]]) -> list[Hit]:
    hits: list[Hit] = []
    low_terms = {t.lower(): why for t, why in terms.items()}

    for lineno, line in enumerate(text.splitlines(), 1):
        if "scan:ignore" in line:
            continue

        for name, rx in GENERIC_RULES:
            m = rx.search(line)
            if m:
                hits.append(Hit(path, lineno, name, redact(m.group(0))))

        for m in _DRIVE_PATH.finditer(line):
            # 用「从盘符起点到行尾」的原文比对白名单，
            # 否则带空格的安装路径会在空格处被截成前半段，从而漏判。
            if _is_safe_path(line[m.start():]):
                continue
            hits.append(Hit(path, lineno, "本机绝对路径", redact(m.group(0))))

        for m in _USERS_PATH.finditer(line):
            frag = m.group(0)
            if frag.lower().startswith(r"\users") and "c:" in line.lower():
                continue  # 家目录盘符路径已由盘符规则处理
            hits.append(Hit(path, lineno, "用户目录路径", redact(frag)))

        low = line.lower()
        for term, why in low_terms.items():
            if _term_hit(low, term):
                hits.append(Hit(path, lineno, f"私密词（{' / '.join(why)}）", redact(term)))

    return hits


def check_git_identity(root: Path, terms: dict) -> list[str]:
    """查提交元数据。

    只有**邮箱**是隐私向量：必须落在 GitHub 的 noreply 域下
    （否则真实的个人邮箱会永久留在提交历史里，谁都删不掉）。
    作者姓名是项目署名，可以公开 —— 但若含本机私密词（用户名、
   黑名单里的词）同样要拦，那属于误把本机信息当成了署名。
    """
    if not (root / ".git").exists():
        return []
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "log", "--format=%an|%ae|%cn|%ce", "-n", "200"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            check=True,
        ).stdout
    except Exception:
        return []
    bad: set[str] = set()
    for line in out.splitlines():
        who = [p.strip() for p in line.split("|")]
        if len(who) < 4:
            continue
        for email in (who[1], who[3]):
            if email and not email.endswith("@users.noreply.github.com"):
                bad.add(f"提交邮箱非匿名：{email}")
        for name in (who[0], who[2]):
            low = name.lower()
            for t in terms:
                if _term_hit(low, t):
                    bad.add(f"提交者姓名含私密词：{name}")
                    break
    return sorted(bad)


# --------------------------------------------------------------------------
# 6) 入口
# --------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(
        description="发布前隐私闸门：扫本机路径 / 令牌 / 用户名等不该公开的内容")
    ap.add_argument("--dir", default=".", help="要扫描的目录（默认当前目录）")
    ap.add_argument("--strict", action="store_true", help="有命中则退出码 1")
    ap.add_argument("--from-index", action="store_true",
                    help="按 git 索引扫（扫的就是将要推送的那些字节），推送前必用")
    ap.add_argument("--words-file", action="append", default=[],
                    help="额外的私密词文件，可重复")
    ap.add_argument("--branch", default="", help="仅用于打印发布上下文")
    ap.add_argument("--tag", default="", help="仅用于打印发布上下文")
    ap.add_argument("--quiet", action="store_true", help="只在有命中时输出")
    args = ap.parse_args()

    root = Path(args.dir).expanduser().resolve()
    if not root.is_dir():
        print(f"[X] 目录不存在：{root}", file=sys.stderr)
        return 2

    terms = derived_terms(root)
    words, missing_words = load_denylist([Path(p).expanduser() for p in args.words_file], root)
    if missing_words:
        for m in missing_words:
            print(f"[X] --words-file 指定的文件不存在：{m}", file=sys.stderr)
        print("    黑名单装的是环境推导不出来的个人词，静默跳过等于闸门失效。\n"
              "    确认这次不需要黑名单，就去掉 --words-file 参数（而非留个错路径）。",
              file=sys.stderr)
        return 2
    for w, why in words.items():
        terms.setdefault(w, []).append(why)

    if not args.quiet:
        ctx = ""
        if args.branch or args.tag:
            ctx = f"  （发布上下文：branch={args.branch or '-'} tag={args.tag or '-'}）"
        print(f"== 隐私闸门：{root}{ctx}")
        print(f"   运行时推导私密词 {len(terms) - len(words)} 个"
              f" + 黑名单 {len(words)} 个 + 通用规则 {len(GENERIC_RULES)} 条")

    # 扫什么：默认工作区；--from-index 时扫 git 索引里的 blob（= 将要推送的字节）
    if args.from_index:
        indexed = iter_index_files(root)
        if indexed is None:
            print(f"[X] {root} 不是 git 仓库，--from-index 无法使用", file=sys.stderr)
            return 2
        scanned: list[tuple[str, str]] = list(indexed)
    else:
        scanned = []
        for p in iter_files(root):
            t = read_text(p)
            if t is not None:
                scanned.append((str(p.relative_to(root)), t))

    hits: list[Hit] = []
    for rel, text in scanned:
        hits.extend(scan_text(text, root / rel, terms))

    bad_identity = check_git_identity(root, terms)

    if not args.quiet:
        src = "git 索引（= 将要推送的内容）" if args.from_index else "工作区"
        print(f"   已扫{src}的文本文件 {len(scanned)} 个")

    if hits:
        print(f"\n[X] 命中 {len(hits)} 处不该公开的内容：\n")
        for h in sorted(hits, key=lambda x: (str(x.path), x.line)):
            try:
                rel = h.path.relative_to(root)
            except ValueError:
                rel = h.path
            print(f"   {rel}:{h.line}")
            print(f"       {h.rule}  →  {h.sample}")
        print("\n   处理方式：改成从环境变量 / 相对路径取；确需保留示例的行加 scan:ignore 标记。")

    if bad_identity:
        print(f"\n[X] git 提交元数据有问题：")
        for b in bad_identity:
            print(f"   {b}")

    if hits or bad_identity:
        print("\n[X] 隐私闸门未通过 —— 发布已阻断。")
        return 1 if args.strict else 0

    if not args.quiet:
        print("   ✓ 未发现本机路径 / 令牌 / 私密词，可以发布。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
