// 渲染层与主进程之间的安全桥。contextIsolation 开启，渲染层拿不到 node。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  // 番茄钟
  getRecords: () => ipcRenderer.invoke('pomodoro:getRecords'),
  addRecord: (rec) => ipcRenderer.invoke('pomodoro:addRecord', rec),
  clearAll: () => ipcRenderer.invoke('pomodoro:clearAll'),
  // 设置
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  // 窗口
  setPinned: (v) => ipcRenderer.invoke('pet:setPinned', v),
  moveTo: (x, y) => ipcRenderer.invoke('pet:moveTo', x, y),
  // 存"我停在哪了"。必须在拖拽松手 / 缩放之后调用，否则重启会回到默认位置。
  savePos: (x, y) => ipcRenderer.invoke('pet:savePos', x, y),
  getBounds: () => ipcRenderer.invoke('pet:getBounds'),
  getWorkArea: () => ipcRenderer.invoke('pet:getWorkArea'),
  setBlock: (v) => ipcRenderer.invoke('pet:setBlock', v),
  showStats: () => ipcRenderer.invoke('pet:showStats'),
  showMenu: () => ipcRenderer.send('pet:menu'),
  heartbeat: () => ipcRenderer.invoke('pet:heartbeat'),
  // 主进程 -> 渲染层
  onOutfit: (cb) => ipcRenderer.on('outfit', (_e, k) => cb(k)),
  onScale: (cb) => ipcRenderer.on('scale', (_e, k) => cb(k)),
  onAction: (cb) => ipcRenderer.on('action', (_e, a) => cb(a))
});
