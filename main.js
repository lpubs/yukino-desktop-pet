// 雪乃桌宠 · 主进程
//
// 架构原则（这三条是被长期挂机实测逼出来的，不是风格偏好）：
//   1. 桌宠窗口从创建到销毁**永不调用 setIgnoreMouseEvents**。
//      Windows 上鼠标转发会在锁屏/息屏/DWM 事件后静默失效，
//      窗口会永久卡在穿透态 —— 用户表现为"挂机以后点不到"。
//      反复切换这个状态也治不好（调用成功、状态却漂移），所以直接废除它。
//   2. 周期巡检并还原窗口几何。DWM 在锁屏/息屏/睡眠/分辨率变更后会悄悄改掉
//      透明无边框窗口的尺寸，而代码只在用户主动缩放时才设置尺寸，于是错误一旦
//      发生就永久停留 —— 用户表现为"窗口被压扁"。
//   3. 渲染层心跳看门狗。渲染进程假死不一定会触发 unresponsive /
//      render-process-gone，主进程根本不知道出事了 —— 用户表现为"人还在，
//      点什么都没反应"。
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, powerMonitor, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
// 位置约束的纯数学。抽成独立文件是为了让 renderer/preview.html 的替身能用同一份，
// 从而"拖不出屏幕"这件事在浏览器里就能验收（本机 Electron 起不来）。
const { clampPos: clampInto } = require('./clamp.js');

app.commandLine.appendSwitch('enable-transparent-visuals');
app.disableHardwareAcceleration();

// ---------- 窗口尺寸 ----------
// 为什么是 404 而不是 360（这是被素材逼出来的，不是拍脑袋）：
//   素材统一 560 高，pet.css 用 height:100% 落位，所以**显示高度 = 窗口高度**，
//   显示宽度 = 素材宽 × (窗口高 / 560)。最宽的一套是女仆装（544px），
//   它要在 400 高的窗口里完整显示需要 544×400/560 ≈ 389px 的宽度。
//   上一版窗口只有 360 宽，于是女仆装被宽度限制压到 367 高，而水手服能到 400 高 ——
//   换装时角色会**肉眼可见地变大变小**，且 360 宽里塞一个 196px 宽的水手服
//   会留下大片空白接住鼠标。404 让四套全部按 400 高显示，高度一致、空白也更少。
//   约束的代价：素材宽度不得超过 PET_MAX_SPRITE_W（selftest 会卡住这条）。
const BASE_W = 404, BASE_H = 400;
const RENDER_H = 560;                                          // 素材高度，与 build_assets.py 的 --target 一致
const PET_MAX_SPRITE_W = Math.floor(BASE_W * RENDER_H / BASE_H); // = 565，超出就会被窗口裁掉发梢

// 三档大小。缩放只改窗口尺寸，sink / 地面线 / 位置约束都跟着 winSize() 走，
// 所以放大缩小以后落点依然正确（不会因为换了尺寸就沉进任务栏或悬空）。
const SIZES = { small: 0.72, medium: 1, large: 1.28 };
let petScale = SIZES.medium;

const DATA_DIR = () => app.getPath('userData');

// 每个服装的"入地"像素：素材以底边对齐（窗口底边 == 图像底边）。
//
// 四套**全都是半身像** —— 参考图本身就在大腿处切断，原画没画脚
// （冬装那张看着像全身，其实原图底部就是"裙摆 + 大腿 + 长袜"的切面）。
// 所以四套统一 sink = 40：把这刀切面沉到任务栏后面去。
// 少了它，切面会明晃晃地横在任务栏上沿，像立在桌面上的一截纸片。
//
// 真·全身像（脚底是自然收尾）才该用 0 —— 那时脚正好踩在工作区底边。
// 表留着就是为了记住这个区分，别再把半身像填成 0。
//
// 注意 sink 是**屏幕物理量**（任务栏高度），不随缩放变 —— 角色放大后
// 切口仍在窗口底边，遮挡关系和原来一样。
const OUTFIT_SINK = { maid: 40, sailor: 40, coat: 40, winter: 40 };
const sinkOf = (k) => OUTFIT_SINK[k] || 0;

// ---------- 素材尺寸表 ----------
// 主进程必须知道每套素材的宽高比。原因：横向约束夹的是**角色外轮廓**而不是
// 窗口矩形（见 clamp.js 的 padX），而角色在窗口里是水平居中的，
// 所以要算出两侧各有多少透明边。
// 直接读 PNG 头就行 —— IHDR 里宽高各占 4 字节，偏移 16 / 20，
// 比为了一个比值去引图像库便宜得多，也不会因为解码大图拖慢启动。
function pngSize(file) {
  try {
    const b = fs.readFileSync(file);
    if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  } catch (e) { return null; }
}
const SPRITE = {};
for (const k of Object.keys(OUTFIT_SINK)) {
  const s = pngSize(path.join(__dirname, 'assets', 'sprites', k + '.png'));
  if (s) SPRITE[k] = s;
}
// 角色显示宽（素材按 height:100% 落位，所以显示宽 = 素材宽 × 窗口高 / 素材高）
function spriteDisplayW(outfit, winH) {
  const s = SPRITE[outfit];
  if (!s || !s.h) return 0;
  return s.w * (winH / s.h);
}
// 两侧的透明边。夹取时把它放到屏幕外，角色才能真正贴住屏幕边缘。
function padXOf(outfit, winH) {
  const sw = spriteDisplayW(outfit, winH);
  if (!sw) return 0;
  return Math.max(0, Math.round((winSize().w - sw) / 2));
}

let petWin = null, statsWin = null, tray = null;
let pinned = true;
let currentOutfit = 'maid';
let blockMode = false, blockUntil = 0;   // 拖拽 / 重载期间暂停巡检，避免打架

const winSize = () => ({
  w: Math.round(BASE_W * petScale),
  h: Math.round(BASE_H * petScale)
});

// ---------- 位置约束 ----------
// 桌宠绝不允许离开屏幕。一旦离开，用户除了手改配置文件没有任何办法叫回来
// （它不在任务栏、没有窗口列表入口）。所以**所有** setPosition 都必须先过这里。
//
// 用 workArea 而不是 workAreaSize：前者带 x/y，多显示器/任务栏在左侧时才算得对。
let waCache = null;
function workAreaFor(x, y) {
  // moveTo 每次 mousemove 都会被调用（~60/s），getDisplayNearestPoint 是原生调用，
  // 不缓存的话拖拽会明显发涩。落在上次结果范围内就直接复用。
  if (waCache &&
      x >= waCache.x - 64 && x <= waCache.x + waCache.width + 64 &&
      y >= waCache.y - 64 && y <= waCache.y + waCache.height + 64) return waCache;
  waCache = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }).workArea;
  return waCache;
}
function clampPos(x, y, outfit) {
  const { w, h } = winSize();
  const of = outfit || currentOutfit;
  return clampInto(x, y, workAreaFor(x, y), w, h, sinkOf(of), padXOf(of, h));
}
function moveToClamped(x, y) {
  if (!petWin || petWin.isDestroyed()) return null;
  const p = clampPos(x, y, currentOutfit);
  petWin.setPosition(p.x, p.y);
  return p;
}
function groundYOf(display, outfit) {
  const wa = display.workArea;
  return wa.y + wa.height - winSize().h + sinkOf(outfit);
}
// 换装 / 缩放后地面线与窗口尺寸都会变，把窗口按新约束拉回合法位置
function resnap() {
  if (!petWin || petWin.isDestroyed()) return;
  const b = petWin.getBounds();
  moveToClamped(b.x, b.y);
}

// 改窗口尺寸，**以底边 + 水平中心为锚**。
// 以顶边为锚会让人物在放大时往上蹿、缩小时沉进任务栏；
// 以底边为锚则"脚一直踩在原地"，符合直觉。
function applyScale(next) {
  petScale = SIZES[next] ? SIZES[next] : SIZES.medium;
  if (!petWin || petWin.isDestroyed()) return;
  const b = petWin.getBounds();
  const cx = b.x + b.width / 2;
  const bottom = b.y + b.height;
  const { w, h } = winSize();
  if (b.width === w && b.height === h) return;
  petWin.setMinimumSize(1, 1);        // 窗口是 resizable:false，先松绑再改尺寸
  petWin.setSize(w, h);
  petWin.setPosition(Math.round(cx - w / 2), Math.round(bottom - h));
  resnap();
}

// ---------- 几何自愈 ----------
function enforceSize() {
  if (!petWin || petWin.isDestroyed()) return;
  if (blockMode && Date.now() < blockUntil) return;
  const b = petWin.getBounds();
  const { w, h } = winSize();
  if (b.width !== w || b.height !== h) {
    // 以**底边**为锚还原：角色站在地面上，按顶边还原会让她沉进任务栏或浮到半空。
    // （winSize() 已经把当前缩放档算进去了，所以这一条同时也自愈"缩放没生效"。）
    const bottomY = b.y + b.height;
    petWin.setMinimumSize(1, 1);
    petWin.setSize(w, h);
    petWin.setPosition(Math.round(b.x + (b.width - w) / 2), Math.round(bottomY - h));
  }
  // 位置也要自愈。只还原尺寸是不够的：窗口若是被拖到屏幕外（或被 DWM 挪出去），
  // 尺寸完全正常、巡检却看不出任何问题，用户就只能看到桌宠凭空消失了。
  const b2 = petWin.getBounds();
  const p = clampPos(b2.x, b2.y, currentOutfit);
  if (p.x !== b2.x || p.y !== b2.y) petWin.setPosition(p.x, p.y);
}

function createPet() {
  const d = screen.getPrimaryDisplay();
  const wa = d.workArea;
  const { w, h } = winSize();
  // 位置也持久化：不然每次重启都回到右上角，用户拖动过的位置白拖了。
  const saved = loadJSON(setFile(), {}).pos;
  const start = saved
    ? clampPos(saved.x, saved.y, currentOutfit)
    : {
        x: Math.max(wa.x, wa.x + wa.width - w - 60),
        y: groundYOf(d, currentOutfit)      // 落地位置与"拖拽松手"用的是同一条地面线
      };
  petWin = new BrowserWindow({
    width: w, height: h,
    x: start.x,
    y: start.y,
    transparent: true, frame: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    focusable: true, fullscreenable: false, maximizable: false, minimizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,      // 被遮挡时 rAF/timer 不被节流
      contextIsolation: true, nodeIntegration: false
    }
  });
  petWin.setAlwaysOnTop(true, 'screen-saver');
  petWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  petWin.on('closed', () => { petWin = null; });

  setInterval(enforceSize, 20000);                       // 20s 几何巡检
  setInterval(() => {                                     // 10min 重申置顶
    if (petWin && !petWin.isDestroyed() && pinned) {
      petWin.setAlwaysOnTop(true, 'screen-saver');
      petWin.moveTop();
    }
  }, 10 * 60 * 1000);

  const revive = () => setTimeout(() => {                 // 系统事件自愈
    if (!petWin || petWin.isDestroyed()) return;
    petWin.setEnabled(true);
    if (pinned) petWin.setAlwaysOnTop(true, 'screen-saver');
    petWin.moveTop();
    enforceSize();
  }, 1500);
  powerMonitor.on('resume', revive);
  powerMonitor.on('unlock-screen', revive);
}

// ---------- 持久化 ----------
function loadJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { return def; }
}
function saveJSON(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  } catch (e) { /* 静默：写不进去不该让桌宠崩掉 */ }
}
const pomFile = () => path.join(DATA_DIR(), 'pomodoro_records.json');
const setFile = () => path.join(DATA_DIR(), 'settings.json');
const readSettings = () => loadJSON(setFile(), { outfit: 'maid', pinned: true, scale: 'medium' });
function patchSettings(patch) {
  const next = Object.assign(readSettings(), patch);
  saveJSON(setFile(), next);
  return next;
}

// ---------- IPC ----------
ipcMain.handle('pomodoro:getRecords', () => loadJSON(pomFile(), []));
ipcMain.handle('pomodoro:addRecord', (e, rec) => {
  const list = loadJSON(pomFile(), []);
  list.push(rec);
  saveJSON(pomFile(), list);
  return true;
});
ipcMain.handle('pomodoro:clearAll', () => { saveJSON(pomFile(), []); return true; });

ipcMain.handle('settings:get', () => readSettings());
ipcMain.handle('settings:set', (e, s) => {
  const next = patchSettings(s);
  if (s.outfit !== undefined) { currentOutfit = s.outfit; resnap(); }
  if (s.pinned !== undefined) pinned = !!s.pinned;
  if (s.scale !== undefined) applyScale(s.scale);
  return next;
});

ipcMain.handle('pet:setPinned', (e, v) => {
  pinned = !!v;
  if (petWin && !petWin.isDestroyed()) petWin.setAlwaysOnTop(pinned, 'screen-saver');
  return pinned;
});
ipcMain.handle('pet:moveTo', (e, x, y) => moveToClamped(x, y));
// 拖拽松手 / 缩放之后落一次位置。存的是**夹紧后**的坐标，
// 不然被夹回边缘的窗口会把自己贴边的坐标覆盖掉，下次启动又跑到屏幕外。
ipcMain.handle('pet:savePos', (e, x, y) => {
  const p = clampPos(x, y, currentOutfit);
  patchSettings({ pos: p });
  return p;
});
ipcMain.handle('pet:getBounds', () => (petWin && !petWin.isDestroyed() ? petWin.getBounds() : null));
ipcMain.handle('pet:getWorkArea', () => {
  const b = petWin && !petWin.isDestroyed() ? petWin.getBounds() : null;
  const d = b ? screen.getDisplayNearestPoint({ x: b.x, y: b.y }) : screen.getPrimaryDisplay();
  const { w, h } = winSize();
  // 带上 sink 与当前窗口尺寸，渲染层才能算出和主进程**完全一致**的地面线，
  // 以及"角色在窗口里实际占多宽"（边缘吸附要用）。缩放以后 petH 变了，
  // 渲染层不去问主进程的话就会按旧的 400 算，落点会差一截。
  return Object.assign({}, d.workArea, { sink: sinkOf(currentOutfit), petW: w, petH: h });
});
ipcMain.handle('pet:setBlock', (e, v) => {
  blockMode = !!v;
  // 拖拽时若鼠标移出窗口，mouseup 可能收不到，blockMode 就会永久为真，
  // 于是自愈被永久关掉 —— 桌宠飞出去再也回不来。给个硬超时兜底。
  blockUntil = v ? Date.now() + 60 * 1000 : 0;
});
ipcMain.handle('pet:showStats', () => createStatsWin());

// 心跳看门狗
let lastHeartbeat = Date.now();
let reloadCount = 0;
setInterval(() => {
  if (Date.now() - lastHeartbeat > 35000 && reloadCount < 6) {
    reloadCount++;
    blockMode = false;
    if (petWin && !petWin.isDestroyed()) {
      enforceSize();                       // 重载前先校正几何，否则重载完还是扁的
      petWin.webContents.reload();
    }
  }
}, 10000);
setInterval(() => { reloadCount = Math.max(0, reloadCount - 1); }, 10 * 60 * 1000);
ipcMain.handle('pet:heartbeat', () => { lastHeartbeat = Date.now(); return true; });

// ---------- 统计窗口 ----------
function createStatsWin() {
  if (statsWin && !statsWin.isDestroyed()) { statsWin.show(); statsWin.focus(); return; }
  statsWin = new BrowserWindow({
    width: 660, height: 640, autoHideMenuBar: true,
    title: '番茄统计 · 雪乃',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  statsWin.loadFile(path.join(__dirname, 'renderer', 'stats.html'));
  statsWin.on('closed', () => { statsWin = null; });
}

// ---------- 右键菜单 ----------
const OUTFITS = [
  ['maid', '女仆装'],
  ['sailor', '水手服 + 贝雷帽'],
  ['coat', '冬大衣 + 围巾'],
  ['winter', '冬装（全身）']
];
const SCALE_LABELS = [['small', '小'], ['medium', '中'], ['large', '大']];
function currentScaleKey() {
  const hit = SCALE_LABELS.find(([k]) => SIZES[k] === petScale);
  return hit ? hit[0] : 'medium';
}
function setScale(key) {
  applyScale(key);
  patchSettings({ scale: key });
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('scale', key);
}
function petMenu() {
  return Menu.buildFromTemplate([
    {
      label: '服装', submenu: OUTFITS.map(([k, label]) => ({
        label, type: 'radio', checked: k === currentOutfit,
        click: () => {
          currentOutfit = k;
          patchSettings({ outfit: k });
          resnap();
          if (petWin && !petWin.isDestroyed()) petWin.webContents.send('outfit', k);
        }
      }))
    },
    {
      label: '大小（Ctrl + 滚轮）', submenu: SCALE_LABELS.map(([k, label]) => ({
        label, type: 'radio', checked: k === currentScaleKey(),
        click: () => setScale(k)
      }))
    },
    { type: 'separator' },
    { label: '开始番茄钟', click: () => send('action', 'open-pomodoro') },
    { label: '番茄统计', click: () => createStatsWin() },
    { type: 'separator' },
    { label: '走两步', click: () => send('action', 'walk') },
    {
      label: pinned ? '取消置顶' : '置顶',
      click: () => {
        pinned = !pinned;
        if (petWin && !petWin.isDestroyed()) petWin.setAlwaysOnTop(pinned, 'screen-saver');
        patchSettings({ pinned });
      }
    },
    { type: 'separator' },
    { label: '回到屏幕右上角', click: () => {
        const d = screen.getPrimaryDisplay();
        moveToClamped(d.workArea.x + d.workArea.width - winSize().w - 60, groundYOf(d, currentOutfit));
      } },
    { label: '打开数据目录', click: () => shell.openPath(DATA_DIR()) },
    { label: '退出', click: () => app.quit() }
  ]);
}
function send(channel, payload) {
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send(channel, payload);
}

// ---------- 托盘 ----------
function createTray() {
  let img = nativeImage.createEmpty();
  try {
    const p = path.join(__dirname, 'assets', 'tray.png');
    if (fs.existsSync(p)) img = nativeImage.createFromPath(p);
  } catch (e) { /* 图标缺失不该影响启动 */ }
  tray = new Tray(img);
  tray.setToolTip('雪乃桌宠');
  // 托盘是"桌宠不见了"时唯一的找回入口（它不在任务栏、没有窗口列表），
  // 所以「回到屏幕右上角」必须放在这里，而不只是右键菜单里。
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示雪乃', click: () => { if (petWin) { petWin.show(); petWin.moveTop(); } } },
    { label: '回到屏幕右上角', click: () => {
        const d = screen.getPrimaryDisplay();
        applyScale(currentScaleKey());      // 顺带把尺寸也还原（万一被改过）
        moveToClamped(d.workArea.x + d.workArea.width - winSize().w - 60, groundYOf(d, currentOutfit));
        if (petWin) { petWin.show(); petWin.moveTop(); }
      } },
    {
      label: '大小', submenu: SCALE_LABELS.map(([k, label]) => ({
        label, type: 'radio', checked: k === currentScaleKey(), click: () => setScale(k)
      }))
    },
    { label: '番茄统计', click: () => createStatsWin() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]));
  tray.on('click', () => { if (petWin) { petWin.show(); petWin.moveTop(); } });
}

app.whenReady().then(() => {
  const s = readSettings();
  currentOutfit = s.outfit || 'maid';
  pinned = s.pinned !== false;
  petScale = SIZES[s.scale] || SIZES.medium;   // 缩放要在 createPet 之前生效，否则窗口先按旧尺寸建出来
  createPet();
  createTray();
  ipcMain.on('pet:menu', () => {
    if (!petWin || petWin.isDestroyed()) return;
    petMenu().popup({ window: petWin });
  });
});

// 托盘常驻，关掉窗口不退出
app.on('window-all-closed', () => {});
