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
  // 久别重逢：我（她）独处了多久。回的是**差值**不是时间戳，
  // 分档规则只写在渲染层一处（pet.js 的 awayLine），主进程不掺和。
  getAway: () => ipcRenderer.invoke('pet:getAway'),
  // 你此刻在不在、离开多久了。同样只回差值（分档在 pet.js 的 awayDoingLine）。
  // 这是"系统层面的空闲"，不是"你多久没点她"—— 你在别的窗口写字也算"在"。
  getIdle: () => ipcRenderer.invoke('pet:getIdle'),
  // 羁绊（互动累积）。addBond 会返回最新快照 + 本次是否升级，
  // 渲染层靠它决定要不要放升级演出 —— 别自己再算一遍等级。
  getBond: () => ipcRenderer.invoke('bond:get'),
  addBond: (action) => ipcRenderer.invoke('bond:add', action),
  // 勿扰（安静一会儿）。until 是时间戳，0 = 取消。
  setQuiet: (until) => ipcRenderer.invoke('pet:setQuiet', until),
  // 窗口栖息：坐到当前前台窗口的上沿 / 从上面下来。返回值是**实际生效的状态**，
  // 原生模块不可用时进不去（返回 false）—— 与 setTyping 同一约定，别自己猜。
  setPerch: (v) => ipcRenderer.invoke('pet:setPerch', v),
  // 前台窗口快照（可用性 / 是否全屏 / 场景 / 是否在栖息）。
  // 只有验收探针用得上；渲染层的场景一律走 onScene 推送。
  getForeground: () => ipcRenderer.invoke('pet:getForeground'),
  // 开机自启（仅打包后可用，开发模式下主进程会直接返回 false）
  getAutostart: () => ipcRenderer.invoke('app:getAutostart'),
  setAutostart: (v) => ipcRenderer.invoke('app:setAutostart', v),
  // 窗口
  setPinned: (v) => ipcRenderer.invoke('pet:setPinned', v),
  moveTo: (x, y) => ipcRenderer.invoke('pet:moveTo', x, y),
  // 存"我停在哪了"。必须在拖拽松手 / 缩放之后调用，否则重启会回到默认位置。
  savePos: (x, y) => ipcRenderer.invoke('pet:savePos', x, y),
  getBounds: () => ipcRenderer.invoke('pet:getBounds'),
  getWorkArea: () => ipcRenderer.invoke('pet:getWorkArea'),
  setBlock: (v) => ipcRenderer.invoke('pet:setBlock', v),
  // 点击穿透。渲染层上报"我现在哪些地方可交互"（窗口本地 CSS px，含番茄钟面板），
  // 主进程拿光标去撞这个矩形，逐拍重算穿透态 —— 透明区因此不再挡住桌面。
  // setHitArea(null) = 整窗不接鼠标事件。
  setHitArea: (r) => ipcRenderer.invoke('pet:hitArea', r),
  // 光标此刻压在我身上。**只用于立刻取消穿透**（把延迟从 120ms 压到一帧）；
  // 恢复穿透一律由主进程的光标巡检决定，所以这里算错也不会让她变成点不到。
  markOver: () => ipcRenderer.invoke('pet:over'),
  showStats: () => ipcRenderer.invoke('pet:showStats'),
  // 边缘收边（迷你模式）的进出。松手吸附到屏幕边时传 'left' / 'right'，
  // 点她一下、或者要让她归位时传 null。真值在主进程 —— 位置只有它算得准。
  setEdge: (mode) => ipcRenderer.invoke('pet:setEdge', mode),
  showMenu: () => ipcRenderer.send('pet:menu'),
  heartbeat: () => ipcRenderer.invoke('pet:heartbeat'),
  // 主进程 -> 渲染层
  onOutfit: (cb) => ipcRenderer.on('outfit', (_e, k) => cb(k)),
  onScale: (cb) => ipcRenderer.on('scale', (_e, k) => cb(k)),
  onAction: (cb) => ipcRenderer.on('action', (_e, a) => cb(a)),
  // 勿扰状态变化。⚠ v3.12 起 payload 是**对象**而不是"until 时间戳"：
  //   { active, until, bye } —— active=该不该藏；until=手动档的截止时刻（自动档恒 0）；
  //   bye=**要不要说那句告别**。手动勿扰说（"我出去了"），自动勿扰（全屏）不说：
  //   看全屏视频时她突然开口比直接消失更烦。
  onQuiet: (cb) => ipcRenderer.on('quiet', (_e, q) => cb(q)),
  // 前台应用换了：{ scene, exe }。scene ∈ code/browser/video/chat/desktop/other。
  // 只给**进程名**，不含窗口标题 —— 隐私边界见 main.js 与 wininfo.js 的说明。
  onScene: (cb) => ipcRenderer.on('scene', (_e, s) => cb(s)),
  // 窗口栖息的开关变了（菜单点的、或者她自己下来了）
  onPerch: (cb) => ipcRenderer.on('perch', (_e, v) => cb(v)),
  // 打扰等级（quiet / normal / lively）。作用全在渲染层，主进程只负责广播。
  onChatter: (cb) => ipcRenderer.on('chatter', (_e, k) => cb(k)),
  // 你在不在。active:false 时 awayMs 恒为 0；active:true 时 awayMs 是这次离开的时长。
  onActivity: (cb) => ipcRenderer.on('activity', (_e, a) => cb(a)),
  // 健康提醒到点了。k = 'sit' | 'water' | 'eye' —— 主进程只报"该提醒哪一类"，
  // 说什么、怎么演全在渲染层（它才是唯一知道她此刻在干嘛的一方）。
  onHealth: (cb) => ipcRenderer.on('health', (_e, k) => cb(k)),
  // 音效试听（菜单里刚把音效打开时，主进程发一个名字过来）
  onSfx: (cb) => ipcRenderer.on('sfx', (_e, name) => cb(name)),
  // 全局光标方位（主进程 120ms 轮询，静止时不发）。
  // 渲染层靠它做"目光跟随"和"主动靠近" —— 窗口内的 mousemove 看不到窗口外。
  onCursor: (cb) => ipcRenderer.on('cursor', (_e, c) => cb(c)),
  // 键盘反应。payload 里**只有 rate**（这一秒敲了多少下），
  // 没有键码、没有内容 —— 主进程那边就只统计次数，见 main.js 的说明。
  onTyping: (cb) => ipcRenderer.on('typing', (_e, t) => cb(t))
});
