// preload.js —— 安全暴露给渲染进程的 API（桌宠窗口与气泡窗口共用）
// v1.5.0：桌宠窗口永久可交互（不再有任何穿透切换）；
//         气泡在独立窗口展示，渲染层通过 say() 请求，主进程负责显示/隐藏/跟随。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  getBoot: () => ipcRenderer.invoke('get-boot'),              // { settings, config }
  getScreenInfo: () => ipcRenderer.invoke('get-screen-info'), // { bounds, workArea }（跑动方向规划）
  saveSettings: (s) => ipcRenderer.send('save-settings', s),
  moveBy: (dx, dy) => ipcRenderer.send('move-by', dx, dy),
  moveTo: (x, y) => ipcRenderer.send('move-to', x, y),
  setZoom: (z) => ipcRenderer.send('set-zoom', z),
  resizeBlockMode: (on) => ipcRenderer.send('resize-block-mode', on),
  say: (text, ms) => ipcRenderer.send('say', text, ms),       // 请求显示台词气泡
  heartbeat: () => ipcRenderer.send('hb'),                    // 渲染层报活（看门狗用）
  showContextMenu: () => ipcRenderer.send('show-context-menu'),
  onIdleTime: (cb) => ipcRenderer.on('idle-time', (_, t) => cb(t)),
  onSetOutfit: (cb) => ipcRenderer.on('set-outfit', (_, i) => cb(i)),
  onSettingsChanged: (cb) => ipcRenderer.on('settings-changed', (_, s) => cb(s)),
  onApplyZoom: (cb) => ipcRenderer.on('apply-zoom', (_, z) => cb(z)),
  // 仅气泡窗口使用
  onBubbleShow: (cb) => ipcRenderer.on('bubble-show', (_, t) => cb(t)),
  onBubbleHide: (cb) => ipcRenderer.on('bubble-hide', () => cb()),
  // ---- 番茄钟 / 倒计时（v1.6.0；v1.7.0 支持名称与常用预设）----
  // 桌宠窗口用 onPomoActive（久坐静默）；气泡窗口用 onRing / onPomoRemaining；面板用其余
  pomoStart: (name) => ipcRenderer.send('pomo:start', name),
  pomoStartCountdown: (min, name) => ipcRenderer.send('pomo:start-countdown', min, name),
  pomoPause: () => ipcRenderer.send('pomo:pause'),
  pomoResume: () => ipcRenderer.send('pomo:resume'),
  pomoStop: () => ipcRenderer.send('pomo:stop'),
  pomoSaveCfg: (patch) => ipcRenderer.send('pomo:save-cfg', patch),
  pomoClosePanel: () => ipcRenderer.send('pomo:close-panel'),
  pomoGetData: () => ipcRenderer.invoke('pomo:get'),          // { state, stats }
  onPomoState: (cb) => ipcRenderer.on('pomo-state', (_, s) => cb(s)),
  onPomoActive: (cb) => ipcRenderer.on('pomo-active', (_, on) => cb(on)),
  onRing: (cb) => ipcRenderer.on('ring', () => cb()),
  onPomoRemaining: (cb) => ipcRenderer.on('pomo-remaining', (_, s) => cb(s))
});
