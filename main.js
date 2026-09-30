// main.js —— 主进程：窗口管理 / 气泡窗口 / 心跳看门狗 / 系统空闲检测 / 右键菜单 / 缩放 / 挡屏 / 持久化
//            + v1.6.0 番茄钟 / 倒计时 / 专注面板
// v1.5.0 架构级稳定版：根治"放久以后无法触碰、拖不动"
//
//   v1.3.x：渲染层 mousemove + setIgnoreMouseEvents(true,{forward:true}) —— Windows 上 forward
//           转发在锁屏/息屏后静默失效 → 永远卡在穿透态。
//   v1.4.0：主进程轮询光标切换穿透 —— 轮询本身可靠，但"反复切换 WS_EX_TRANSPARENT 样式"
//           这条路径在部分机器上依然会失效（用户实测仍复现）。
//   v1.5.0：**彻底废除"穿透切换"机制**（VPet / Shimeji 等成熟桌宠验证过的架构）：
//     1) 桌宠窗口 = 立绘大小，永久可交互。程序从创建到退出**从不调用** setIgnoreMouseEvents
//        —— 不切换就不会坏，这一整类失效被整体消灭。
//     2) 台词气泡拆分到独立窗口（永久穿透、纯展示、永不需要交互）。
//     3) 心跳看门狗：渲染层每 5s 报活；主进程 35s 收不到 → 自动重载页面。
//        覆盖"画面定格但交互全死"的渲染层静默假死（与用户症状吻合的另一候选根因）。
//     4) 每 10 分钟 + 系统唤醒时重申置顶 / 可用状态。
//   代价：立绘矩形内的透明边角（她身体两侧的小块空白）也会接住鼠标，不再穿透到下层窗口。
const { app, BrowserWindow, ipcMain, Menu, screen, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const { createPomodoro } = require('./pomodoro');

const ZOOM_MIN = 0.5, ZOOM_MAX = 2.5;     // 缩放范围

// --- 透明窗口的 GPU 组合（Windows 透明是机器相关的，见 electron#40515）---
// 实测可用组合：禁用硬件加速 + 保留透明视觉。不要加 disable-gpu / disable-gpu-compositing（会出黑边）。
// 如果换机器后出现黑/蓝矩形：把下面两行删掉再重启试一次（即全默认硬件加速）。
app.commandLine.appendSwitch('enable-transparent-visuals');
app.disableHardwareAcceleration();
// 番茄钟结束铃声在气泡窗口用 Web Audio 合成；桌宠场景没有用户手势，放开自动播放限制
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null;                           // 桌宠窗口（立绘大小，永久可交互）
let bubbleWin = null;                     // 气泡窗口（永久穿透，纯展示）
let settingsPath = null;
let config = null;                        // assets/config.json（尺寸的单一数据源）
let blockMode = false;                    // 是否处于挡屏模式
let prevBounds = null;                    // 挡屏前的窗口位置（退出挡屏时精确还原）
let bubbleVisible = false;
let bubbleTimer = null;
let panelWin = null;                      // 专注面板窗口（v1.6.0，可交互，按需创建）
let pomo = null;                          // 番茄钟引擎（v1.6.0）
// 用户设置（白名单字段），存放在 userData/settings.json
const DEFAULT_SETTINGS = { outfit: 0, muted: false, remindPaused: false, zoom: 1 };
let settings = { ...DEFAULT_SETTINGS };

// ---------- 心跳看门狗状态 ----------
let lastHb = Date.now();                  // 渲染层最近一次报活时间
let reloadCount = 0;                      // 本小时内已自动重载次数
let reloadHourStart = Date.now();

function clampZoom(z) { return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(z) || 1)); }

function loadSettings() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch (e) {}
  settings = { ...DEFAULT_SETTINGS };
  // 只接受白名单字段，忽略旧版本写入的多余 key
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in raw) settings[k] = raw[k];
  if (!Number.isFinite(settings.zoom)) settings.zoom = 1;
  settings.zoom = clampZoom(settings.zoom);
}
function saveSettings() {
  try { fs.writeFileSync(settingsPath, JSON.stringify(settings)); } catch (e) {}
}

function sendToPet(ch, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, ...args);
}
function sendToBubble(ch, ...args) {
  if (bubbleWin && !bubbleWin.isDestroyed()) bubbleWin.webContents.send(ch, ...args);
}
function sendToPanel(ch, ...args) {
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send(ch, ...args);
}

// ---------- 尺寸（唯一数据源：config.json 的 window 段 = 立绘大小） ----------
function baseSize() {
  const w = (config && config.window && config.window.width) || 220;
  const h = (config && config.window && config.window.height) || 320;
  return { w, h };
}
function winSize() {
  const z = settings.zoom;
  const b = baseSize();
  return { w: Math.round(b.w * z), h: Math.round(b.h * z), z };
}
function bubbleSize() {
  const z = settings.zoom;
  return { w: Math.round(300 * z), h: Math.round(150 * z) };   // v1.6.0: 150 = 台词气泡 + 顶部倒计时徽章空间
}
function defaultPosition() {
  const wa = screen.getPrimaryDisplay().workArea;
  const { w, h } = winSize();
  return { x: wa.x + wa.width - w - 40, y: wa.y + wa.height - h };
}
// 窗口当前所在的显示器（多屏支持）
function currentDisplay() {
  if (!win || win.isDestroyed()) return screen.getPrimaryDisplay();
  const b = win.getBounds();
  return screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
}

// ---------- 气泡 ----------
// 气泡永远出现在桌宠窗口正上方，尾巴指向头顶；跟随桌宠移动；被工作区上边缘截住
function placeBubble() {
  if (!bubbleWin || bubbleWin.isDestroyed() || !win || win.isDestroyed()) return;
  const { w: bw, h: bh } = bubbleSize();
  const b = win.getBounds();
  const wa = currentDisplay().workArea;
  const bx = Math.min(Math.max(Math.round(b.x + (b.width - bw) / 2), wa.x), wa.x + wa.width - bw);
  const by = Math.max(Math.round(b.y - bh + 10 * settings.zoom), wa.y);
  bubbleWin.setMinimumSize(1, 1);
  bubbleWin.setSize(bw, bh);
  bubbleWin.setPosition(bx, by);
}
function showBubble(text, ms) {
  if (!bubbleWin || bubbleWin.isDestroyed() || blockMode) return;   // 挡屏时用遮罩字幕，不用气泡
  clearTimeout(bubbleTimer);
  placeBubble();
  sendToBubble('bubble-show', text);
  bubbleWin.showInactive();               // 不抢焦点
  bubbleVisible = true;
  bubbleTimer = setTimeout(hideBubble, Math.max(800, ms || 3200));
}
function hideBubble() {
  clearTimeout(bubbleTimer);
  bubbleVisible = false;
  if (bubbleWin && !bubbleWin.isDestroyed()) bubbleWin.hide();
}

// ---------- 窗口创建 ----------
function createWindows() {
  const { w, h } = winSize();
  const pos = defaultPosition();
  win = new BrowserWindow({
    width: w, height: h,
    x: pos.x, y: pos.y,
    transparent: true,                     // 背景透明
    backgroundColor: '#00000000',
    frame: false,                          // 无边框
    resizable: false,
    alwaysOnTop: true,                     // 始终置顶
    skipTaskbar: true,                     // 不显示在任务栏
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false          // 别让 Chromium 把"被遮挡窗口"的定时器/动画降频
    }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 气泡窗口：纯展示。setIgnoreMouseEvents(true) 只在创建时调用一次，之后**永不更改**
  // —— 它不需要任何鼠标交互，所以也不存在"切不回来"的失效问题。
  const bs = bubbleSize();
  bubbleWin = new BrowserWindow({
    width: bs.w, height: bs.h,
    show: false,
    x: pos.x, y: pos.y - bs.h,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  bubbleWin.setAlwaysOnTop(true, 'screen-saver');
  bubbleWin.loadFile(path.join(__dirname, 'renderer', 'bubble.html'));
  bubbleWin.once('ready-to-show', () => {
    try { bubbleWin.setIgnoreMouseEvents(true); } catch (e) {}   // 一次性，永不再动
  });

  // 渲染层健康：崩溃 / 无响应 → 退出挡屏并重载（心跳看门狗兜底静默假死，见下方循环）
  win.webContents.on('render-process-gone', (_, details) => {
    if (details.reason === 'crashed' && reloadCount < 6) rescueReload(details.reason);
  });
  win.webContents.on('unresponsive', () => rescueReload('unresponsive'));
  win.on('closed', () => { win = null; app.quit(); });
}

// 渲染层抢救性重载（崩溃 / 无响应 / 心跳超时共用）
function rescueReload() {
  if (!win || win.isDestroyed()) return;
  reloadCount++;
  lastHb = Date.now();
  if (blockMode) hardExitBlock();          // 重载后渲染层状态会丢，先退出挡屏防"全屏卡死没按钮"
  try { win.webContents.reload(); } catch (e) {}
}

// 渲染层重载后 block 状态会丢，主进程同步退出挡屏，避免"全屏窗口卡住没有按钮"
function hardExitBlock() {
  if (!blockMode) return;
  blockMode = false;
  clearTimeout(bubbleTimer);
  hideBubble();
  if (win && !win.isDestroyed()) {
    win.setMinimumSize(1, 1);
    if (prevBounds) win.setBounds(prevBounds);
    else { const { w, h } = winSize(); const p = defaultPosition(); win.setBounds({ x: p.x, y: p.y, width: w, height: h }); }
  }
  prevBounds = null;
}

// ---------- 专注面板窗口（v1.6.0）----------
// 可交互的独立小窗口：设置时长、开始/暂停/停止、看统计。按需创建，关闭只是隐藏可复用。
function openPanel() {
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.show();
    panelWin.focus();
    sendToPanel('pomo-state', pomo.state());
    return;
  }
  panelWin = new BrowserWindow({
    width: 420, height: 800,   // v1.7.0：加名称/预设/明细区域，加高
    show: false,
    frame: false, resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#f7f8fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  panelWin.setAlwaysOnTop(true, 'screen-saver');
  panelWin.loadFile(path.join(__dirname, 'renderer', 'panel.html'));
  panelWin.once('ready-to-show', () => {
    panelWin.show();
    if (pomo) sendToPanel('pomo-state', pomo.state());
  });
  panelWin.on('closed', () => { panelWin = null; });
}

// ---------- 周期性自愈 ----------
// 1) 心跳看门狗：渲染层每 5s 报活；35s 没有心跳 → 判定静默假死，自动重载。
//    这覆盖"她还在屏幕上（定格画面）但点什么都没反应"的情况。
// 2) 每 10 分钟重申置顶 / 可用（防系统事件悄悄改掉窗口属性）。
function reassertWindows() {
  try {
    if (win && !win.isDestroyed()) {
      win.setEnabled(true);
      win.setAlwaysOnTop(true, 'screen-saver');
      win.moveTop();
    }
    if (bubbleWin && !bubbleWin.isDestroyed()) {
      bubbleWin.setEnabled(true);
      bubbleWin.setAlwaysOnTop(true, 'screen-saver');
    }
  } catch (e) {}
}
function startWatchdogs() {
  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const now = Date.now();
    if (now - reloadHourStart > 3600000) { reloadHourStart = now; reloadCount = 0; }
    if (now - lastHb > 35000 && reloadCount < 6) {
      rescueReload();
    }
  }, 10000);
  setInterval(reassertWindows, 10 * 60 * 1000);
}

// ---------- 按当前 zoom 调整窗口尺寸，保持"底部中心"锚点不动 ----------
function applySize() {
  if (!win || win.isDestroyed() || blockMode) return;
  const b = win.getBounds();
  const { w, h } = winSize();
  const cx = b.x + b.width / 2;            // 底部中心 x
  const by = b.y + b.height;               // 底边 y
  win.setMinimumSize(1, 1);
  win.setSize(w, h);
  win.setPosition(Math.round(cx - w / 2), Math.round(by - h));
  if (bubbleVisible) placeBubble();        // 气泡跟着重新定位
}

// 修改缩放：立即应用窗口尺寸，并广播给两个渲染进程
function setZoom(z) {
  if (blockMode) return;                   // 挡屏期间不响应缩放，避免立绘/遮罩错乱
  settings.zoom = clampZoom(z);
  saveSettings();
  applySize();
  sendToPet('apply-zoom', settings.zoom);
  sendToBubble('apply-zoom', settings.zoom);
}

// ---------- 右键菜单 ----------
function buildContextMenu() {
  const outfitItems = config.outfits.map((o, i) => ({
    label: o.name,
    type: 'checkbox',
    checked: i === settings.outfit,
    click: () => sendToPet('set-outfit', i)
  }));
  // 专注模式子菜单（v1.6.0）：文案随运行状态变化
  const ps = pomo ? pomo.state() : { mode: 'idle', paused: false };
  const running = ps.mode !== 'idle';
  const modeLabel = { focus: '番茄钟进行中…', break: '休息中…', countdown: '倒计时进行中…' };
  const focusItems = [
    { label: running ? (modeLabel[ps.mode] || '进行中…') : '开始番茄钟',
      enabled: !running,
      click: () => { pomo.startPomodoro(); openPanel(); } },
    { label: '开始倒计时',
      enabled: !running,
      click: () => { pomo.startCountdown(); openPanel(); } },
    { label: ps.paused ? '继续' : '暂停', enabled: running,
      click: () => (ps.paused ? pomo.resume() : pomo.pause()) },
    { label: '停止', enabled: running, click: () => pomo.stop() },
    { type: 'separator' },
    { label: '打开专注面板', click: () => openPanel() }
  ];
  return Menu.buildFromTemplate([
    { label: '更换服装', submenu: outfitItems },
    { type: 'separator' },
    { label: '专注模式', submenu: focusItems },
    { type: 'separator' },
    { label: '放大', click: () => setZoom(settings.zoom * 1.15), enabled: !blockMode },
    { label: '缩小', click: () => setZoom(settings.zoom / 1.15), enabled: !blockMode },
    { label: `重置大小（当前 ${Math.round(settings.zoom * 100)}%）`, click: () => setZoom(1), enabled: !blockMode },
    { label: '回到默认位置', click: () => { if (!blockMode) { const p = defaultPosition(); movePetTo(p.x, p.y); } } },
    { type: 'separator' },
    {
      label: settings.remindPaused ? '恢复提醒' : '暂停提醒',
      click: () => {
        settings.remindPaused = !settings.remindPaused;
        saveSettings();
        if (settings.muted) hideBubble();
        sendToPet('settings-changed', { ...settings });
      }
    },
    {
      label: settings.muted ? '取消静音' : '静音',
      click: () => {
        settings.muted = !settings.muted;
        saveSettings();
        if (settings.muted) hideBubble();  // 静音立即收起气泡
        sendToPet('settings-changed', { ...settings });
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]);
}

ipcMain.on('show-context-menu', () => {
  if (!win || win.isDestroyed()) return;
  buildContextMenu().popup({ window: win });
});

// ---------- 气泡 / 心跳 IPC ----------
ipcMain.on('say', (_, text, ms) => {
  if (typeof text !== 'string' || !text) return;
  if (settings.muted) return;              // 静音：不显示
  showBubble(text, ms);
});
ipcMain.on('hb', () => { lastHb = Date.now(); });

// ---------- 番茄钟 / 倒计时 IPC（v1.6.0）----------
ipcMain.on('pomo:start', (_, name) => { if (pomo) pomo.startPomodoro(name); });
ipcMain.on('pomo:start-countdown', (_, min, name) => { if (pomo) pomo.startCountdown(min, name); });
ipcMain.on('pomo:pause', () => { if (pomo) pomo.pause(); });
ipcMain.on('pomo:resume', () => { if (pomo) pomo.resume(); });
ipcMain.on('pomo:stop', () => { if (pomo) pomo.stop(); });
ipcMain.on('pomo:save-cfg', (_, patch) => { if (pomo) pomo.setCfg(patch); });
ipcMain.on('pomo:close-panel', () => { if (panelWin && !panelWin.isDestroyed()) panelWin.hide(); });
ipcMain.handle('pomo:get', () => ({
  state: pomo.state(),
  stats: pomo.getStats(),
  records: pomo.getRecords(60)     // v1.7.0：最近明细，供面板复盘
}));

// ---------- 窗口移动（拖拽 / 跑动）——桌宠和气泡同步移动 ----------
// 限制在"窗口当前所在显示器"内，至少保留一部分可见，避免被拖出去"找不回来"
function clampToScreen(x, y, w, h) {
  const d = screen.getDisplayNearestPoint({ x: x + w / 2, y: y + h / 2 });
  const wa = d.workArea;
  const keepX = Math.min(80, w / 2);      // 横向至少可见 80px
  const keepY = Math.min(80, h / 4);      // 纵向至少可见 80px
  return {
    x: Math.min(Math.max(x, wa.x - w + keepX), wa.x + wa.width - keepX),
    y: Math.min(Math.max(y, wa.y - 20), wa.y + wa.height - keepY)
  };
}
function movePetTo(x, y) {
  if (!win || win.isDestroyed() || blockMode) return;
  const b = win.getBounds();
  const p = clampToScreen(Math.round(x), Math.round(y), b.width, b.height);
  const dx = p.x - b.x, dy = p.y - b.y;
  if (!dx && !dy) return;
  win.setPosition(p.x, p.y);
  if (bubbleVisible && bubbleWin && !bubbleWin.isDestroyed()) {
    const bb = bubbleWin.getBounds();
    bubbleWin.setPosition(bb.x + dx, bb.y + dy);
  }
}
ipcMain.on('move-by', (_, dx, dy) => {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  movePetTo(b.x + Math.round(dx), b.y + Math.round(dy));
});
ipcMain.on('move-to', (_, x, y) => movePetTo(Math.round(x), Math.round(y)));

// ---------- 缩放 ----------
ipcMain.on('set-zoom', (_, z) => setZoom(z));

// ---------- 屏幕信息（渲染进程规划跑动方向用） ----------
ipcMain.handle('get-screen-info', () => {
  if (!win || win.isDestroyed()) return null;
  return { bounds: win.getBounds(), workArea: currentDisplay().workArea };
});

// ---------- 挡屏模式（240 分钟） ----------
// 进入：隐藏气泡，记录原始位置，窗口铺满当前显示器工作区；退出：精确还原原始位置
ipcMain.on('resize-block-mode', (_, on) => {
  if (!win || win.isDestroyed()) return;
  if (on) {
    if (blockMode) return;
    blockMode = true;
    hideBubble();
    prevBounds = win.getBounds();
    const wa = currentDisplay().workArea;  // 铺满 = 天然不会超出屏幕
    win.setMinimumSize(1, 1);
    win.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
  } else {
    hardExitBlock();
  }
});

// ---------- 渲染进程启动数据 ----------
ipcMain.handle('get-boot', () => ({ settings: { ...settings }, config }));

ipcMain.on('save-settings', (_, s) => {
  const patch = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in s) patch[k] = s[k];
  if ('zoom' in patch) patch.zoom = clampZoom(patch.zoom);
  Object.assign(settings, patch);
  saveSettings();
});

// ---------- 单实例锁：双击两次只开一个桌宠 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) win.focus();
  });

  app.whenReady().then(() => {
    config = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'config.json'), 'utf-8'));
    settingsPath = path.join(app.getPath('userData'), 'settings.json');
    loadSettings();
    // 兜底：设置里的服装索引越界时回到默认
    if (!Number.isInteger(settings.outfit) || settings.outfit < 0 || settings.outfit >= config.outfits.length) {
      settings.outfit = 0;
    }
    createWindows();

    // 番茄钟引擎（v1.6.0）：台词走气泡、铃声发给气泡窗口合成、状态推给面板、
    // 运行状态通知桌宠渲染层（久坐静默用）。计时基于墙钟，不依赖渲染层。
    pomo = createPomodoro({
      config,
      storePath: path.join(app.getPath('userData'), 'pomodoro.json'),
      say: (text, ms) => { if (!settings.muted) showBubble(text, ms); },
      ring: () => sendToBubble('ring'),
      broadcastState: (s) => {
        sendToPanel('pomo-state', s);
        // 头顶倒计时徽章：运行中每秒推送；关闭气泡显示与否由 cfg.countdownBubble 决定
        sendToBubble('pomo-remaining', (s.mode !== 'idle' && s.cfg.countdownBubble) ? s : null);
      },
      broadcastActive: (on) => sendToPet('pomo-active', on)
    });

    // 每秒向渲染进程广播系统空闲时长（秒），用于待机跑动 + 久坐计时
    setInterval(() => {
      sendToPet('idle-time', powerMonitor.getSystemIdleTime());
    }, 1000);

    startWatchdogs();

    // 系统从睡眠/锁屏恢复：立即重申窗口状态 + 补发空闲时长 + 番茄钟补查超时
    const rearm = () => setTimeout(() => {
      reassertWindows();
      sendToPet('idle-time', powerMonitor.getSystemIdleTime());
      if (pomo) pomo.kick();
    }, 1500);
    powerMonitor.on('resume', rearm);
    powerMonitor.on('unlock-screen', rearm);
  });
}

app.on('window-all-closed', () => app.quit());
