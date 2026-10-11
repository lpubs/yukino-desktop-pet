// ---------- 前台窗口信息（可选能力）----------
//
// 一件事供三处用：
//   ① 全屏自动勿扰 —— 看全屏视频 / 打游戏时她自己躲起来（v3.12 之前只有手动开关）
//   ② 窗口栖息     —— 她坐到你正在用的那个窗口的标题栏上，窗口动她就跟着动
//   ③ 环境感知     —— 按前台应用切反应（写代码时安静看书陪、浏览器里凑过来看）
//
// ── 为什么需要原生模块 ──
// Electron **没有**"当前前台窗口是谁 / 是不是全屏"的 API（这一条 v3.7 就写在 main.js 里了，
// 当时因此选了手动勿扰）。要拿只能问 Win32：GetForegroundWindow / GetWindowRect /
// GetMonitorInfoW。所以引一个 koffi（Node-API，**预编译**，不需要编译工具链），
// 规格与打字反应的 uiohook-napi 完全一致：optional 依赖，装不上就 available()=false，
// 三处功能各自降级（菜单置灰），桌宠其余部分一切照常。
//
// ── ⚠ 隐私边界（写死在实现里，不是"我们保证"）──
//   · 只读两样东西：**进程可执行文件名**、**窗口矩形**。
//   · **不读窗口标题**（那里面才会有"某项目 - VS Code"、聊天对象名这类内容）——
//     整个文件里不存在 GetWindowText 这个调用，看代码就能确认。
//   · 不读窗口内容、不做截图、不做 OCR。
//   · 不落盘、不发送、不出本机；数据只活在一拍里，算完就丢。
//
// ── 为什么纯函数要单独放在前面 ──
// toDip / isFullscreen / sceneOf 都不依赖 electron 与 koffi，所以 selftest 能直接
// require 这个文件去测它们 —— 而"全屏判据"正是这一版最容易写错、
// 也最该被钉死的一处（见 isFullscreen 的注释）。
'use strict';

// ============================================================
// 纯函数区
// ============================================================

// 物理像素 → DIP。
// Electron 主进程在 Windows 上是 **DPI-aware** 的，于是 Win32 返回**物理像素**，
// 而 screen API 与 setBounds 全用 **DIP**。本机 150% 缩放下实测：
//   同一个窗口，Node（非 aware）看到 1721x1033，Electron 看到 2582x1550 —— 正好 1.5 倍。
// 不换算的话，栖息位置会整体偏移并放大 1.5 倍（在 150% 屏上是"她跑到窗口右下方"）。
function toDip(rect, scale) {
  const s = scale > 0 ? scale : 1;
  return { x: rect.x / s, y: rect.y / s, w: rect.w / s, h: rect.h / s };
}

// 全屏判据（win / mon 都在 DIP 下）。两条**都要**成立：
//
//   ① 覆盖整个显示器（容差 2px）
//   ② 起点不越界（x/y ≥ -2），右上右下也不越界
//
// ★ 第 ② 条是这个函数存在的意义。**Windows 最大化窗口的矩形会溢出屏幕**：
//   实测（150% 缩放，2560x1600 的屏）最大化窗口是 (-11,-11) 2582x1550 ——
//   负起点、比屏幕大。如果只写第 ① 条"差不多等于屏幕大小"，用户**最大化浏览器
//   工作时她就会消失**，而那恰恰是最不该消失的时候。
//   加上第 ② 条，最大化窗口被干净地挡在门外，只有真全屏（F11 全屏视频、
//   游戏独占全屏）才会通过 —— 它们的矩形是精确的 (0,0,W,H)。
//
//   另外注意：最大化的高度通常还要减掉任务栏（1033 < 1067），所以第 ① 条本身
//   往往也不成立；两条同时不成立 = 双重保险，不是冗余。
function isFullscreen(win, mon) {
  const covers = win.w >= mon.w - 2 && win.h >= mon.h - 2;
  const inside = win.x >= -2 && win.y >= -2 &&
    win.x + win.w <= mon.x + mon.w + 2 &&
    win.y + win.h <= mon.y + mon.h + 2;
  return covers && inside;
}

// 进程可执行名 → 场景。只用文件名匹配，不看标题。
// 顺序即优先级（先匹配到的赢）；匹配不上就是 'other'。
const SCENE_RULES = [
  ['code', /^(code|code-insiders|code - insiders|codium|devenv|idea64?|pycharm64?|webstorm64?|phpstorm64?|goland64?|clion64?|rider64?|datagrip64?|sublime_text|notepad\+\+|windowsterminal|wt|powershell|pwsh|cmd|conhost|mintty|alacritty|wezterm|gvim|nvim|emacs|zed|hx|helix)\.exe$/i],
  ['browser', /^(chrome|msedge|firefox|brave|opera|vivaldi|librewolf|360se|360chrome|chrome_proxy|qqbrowser|sogouexplorer|maxthon|iexplore|chromium)\.exe$/i],
  ['video', /^(potplayermini64|potplayermini|potplayer64|potplayer|vlc|mpc-hc64|mpc-hc|mpc-be64|mpc-be|mpv|kmplayer64|kmplayer|qqplayer|bilibili|哔哩哔哩|dyplayer|nplayer|vlcplayer)\.exe$/i],
  ['chat', /^(wechat|weixin|qq|tim|telegram|discord|dingtalk|wework|wxwork|feishu|lark|slack|whatsapp|line|signal|msteams|teams)\.exe$/i],
  ['desktop', /^explorer\.exe$/i]
];
const SCENES = SCENE_RULES.map((r) => r[0]).concat(['other']);

function sceneOf(exe) {
  if (!exe) return 'other';
  for (const [name, re] of SCENE_RULES) {
    if (re.test(exe)) return name;
  }
  return 'other';
}

// ============================================================
// 原生部分（惰性加载；装不上就整个模块降级）
// ============================================================
let impl = null, tried = false;

const GWL_STYLE = -16;
const WS_MAXIMIZE = 0x01000000;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const MONITOR_DEFAULTTONEAREST = 2;

function ensureImpl() {
  if (tried) return impl;
  tried = true;
  let koffi;
  try { koffi = require('koffi'); } catch (e) { return null; }
  try {
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');

    // ⚠ koffi 的两条规矩，都是踩过的：
    //   ① 结构体的**注册名**就是函数签名里要引用的类型名。写成 `koffi.struct('YP_RECT', …)`
    //      却在签名里写 `_Out_ RECT *r`，koffi 会报 `Unknown or invalid type name 'RECT'`
    //      —— 它不是按变量名找类型，是按注册名。
    //   ② 同名 struct 在同一进程里重复注册会抛（koffi 的类型表是全局的）。
    //      本模块只加载一次，但探针 / 预览页可能各 require 一份，所以注册要容错：
    //      注册失败（说明已存在）也无妨 —— 名字已在 koffi 的类型表里，签名照样能解析。
    const RECT_NAME = 'YP_RECT', MI_NAME = 'YP_MONITORINFO';
    try { koffi.struct(RECT_NAME, { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' }); }
    catch (e) { /* 已注册，忽略 */ }
    let miSize = 40;                    // MONITORINFO = DWORD + RECT + RECT + DWORD = 40，兜底值
    try {
      const MI = koffi.struct(MI_NAME, {
        cbSize: 'uint32', rcMonitor: RECT_NAME, rcWork: RECT_NAME, dwFlags: 'uint32'
      });
      miSize = koffi.sizeof(MI);
    } catch (e) { /* 已注册，用兜底值 */ }

    impl = {
      sizeOfMonitorInfo: miSize,
      GetForegroundWindow: user32.func('void *GetForegroundWindow()'),
      GetWindowRect: user32.func('bool GetWindowRect(void *h, _Out_ ' + RECT_NAME + ' *r)'),
      GetWindowThreadProcessId: user32.func('uint32 GetWindowThreadProcessId(void *h, _Out_ uint32 *pid)'),
      IsZoomed: user32.func('bool IsZoomed(void *h)'),
      IsIconic: user32.func('bool IsIconic(void *h)'),
      GetWindowLongPtrW: user32.func('int64 GetWindowLongPtrW(void *h, int idx)'),
      MonitorFromWindow: user32.func('void *MonitorFromWindow(void *h, uint32 flags)'),
      GetMonitorInfoW: user32.func('bool GetMonitorInfoW(void *hMon, _Inout_ ' + MI_NAME + ' *mi)'),
      OpenProcess: kernel32.func('void *OpenProcess(uint32 a, bool b, uint32 pid)'),
      QueryFullProcessImageNameW: kernel32.func(
        'bool QueryFullProcessImageNameW(void *h, uint32 f, _Out_ char16_t *name, _Inout_ uint32 *size)'),
      CloseHandle: kernel32.func('bool CloseHandle(void *h)')
    };
  } catch (e) {
    impl = null;
  }
  return impl;
}

// 模块可用吗（菜单据此置灰，与 typingAvailable 同一套路）
function available() {
  if (impl || tried) return !!impl;
  return !!ensureImpl();
}

// 拿一次前台窗口的**原始**信息（物理像素 + 原始显示器矩形）。
// 换算成 DIP 是调用方的事 —— 只有主进程知道每个显示器的 scaleFactor。
// 返回 null = 拿不到（没装模块 / 没有前台窗口 / 调用失败），调用方一律按"不知道"处理。
function foreground() {
  const p = ensureImpl();
  if (!p) return null;
  try {
    const hwnd = p.GetForegroundWindow();
    if (!hwnd) return null;
    const r = {};
    if (!p.GetWindowRect(hwnd, r)) return null;

    const pidArr = [0];
    p.GetWindowThreadProcessId(hwnd, pidArr);
    const pid = pidArr[0];

    let exe = '';
    const h = p.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (h) {
      const buf = Buffer.alloc(2048);
      const size = [1024];
      if (p.QueryFullProcessImageNameW(h, 0, buf, size)) {
        exe = buf.toString('utf16le', 0, size[0] * 2);
      }
      p.CloseHandle(h);
    }

    const hMon = p.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    const mi = { cbSize: p.sizeOfMonitorInfo };
    const gotMon = hMon ? p.GetMonitorInfoW(hMon, mi) : false;

    const style = p.GetWindowLongPtrW(hwnd, GWL_STYLE);
    return {
      pid,
      exe: exe ? exe.split('\\').pop() : '',
      rect: { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top },
      monitor: gotMon ? {
        x: mi.rcMonitor.left, y: mi.rcMonitor.top,
        w: mi.rcMonitor.right - mi.rcMonitor.left,
        h: mi.rcMonitor.bottom - mi.rcMonitor.top
      } : null,
      work: gotMon ? {
        x: mi.rcWork.left, y: mi.rcWork.top,
        w: mi.rcWork.right - mi.rcWork.left,
        h: mi.rcWork.bottom - mi.rcWork.top
      } : null,
      maximized: p.IsZoomed(hwnd) || !!(style & WS_MAXIMIZE),
      minimized: p.IsIconic(hwnd)
    };
  } catch (e) {
    return null;
  }
}

module.exports = {
  available, foreground,
  toDip, isFullscreen, sceneOf,
  SCENE_RULES, SCENES
};
