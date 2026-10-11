// 雪乃桌宠 · v3.12 真机探针的"陪练窗口"（辅助进程）
//
// ★ 为什么必须是一个**独立进程**：
//   主进程的 fgPoll 会把"前台窗口就是我自己"判成 self 并跳过（否则用户点一下她，
//   场景就会跳成 other、栖息也会当场退出）。于是如果在本进程里开一个测试窗去当前台，
//   探针验的永远是"她自己"，一条都测不到 —— 看起来全绿，其实什么都没验。
//
// 用法（由 tools/probe_v312.js 自动拉起，一般不用手跑）：
//   electron tools/probe_v312_win.js <norm|max|full>
// 行为：开窗 -> 显示、按模式变形、抢焦点 -> 打印 READY（含自己的 pid 与 bounds）
//       -> 6 秒时自己搬一次家并再抢焦点 -> 打印 MOVED -> 之后每 1.5s 补一次焦点。
//
// ⚠ 两个踩过的坑，别改回去：
//   ① `process.argv[2]` 不是模式。Electron 的 process.argv 里**带着 Chromium 的开关**
//      （--no-sandbox 就在里面），所以脚本路径与模式都往后挪了一位。
//      结果就是"三种模式开出来的窗一样大"，而探针会以为自己在验全屏 ——
//      它只是把 norm 窗又验了一遍。改成按内容找。
//   ② `maximize()` / `setFullScreen()` 必须在 `show()` **之后**调。
//      对还没显示的窗口调，Windows 上会被丢掉（窗照常按初始尺寸显示）。
'use strict';
const { app, BrowserWindow } = require('electron');
const os = require('os');
const path = require('path');

const mode = process.argv.find((a) => /^(norm|max|full)$/.test(a)) || 'norm';
const out = (tag, obj) => { try { console.log(tag + ' ' + JSON.stringify(obj)); } catch (e) { /* 忽略 */ } };

// 每个陪练进程一个独立的 userData：多个 Electron 共用一份会互相抢缓存锁，
// 刷出一屏 "Unable to move the cache"，把探针真正的输出淹掉。
app.setPath('userData', path.join(os.tmpdir(), 'yukino-probe-win-' + process.pid));

app.whenReady().then(() => {
  const opts = { x: 300, y: 520, width: 700, height: 420 };   // norm 的落点：y 必须够大，
                                                             // 否则她站上窗沿会被工作区上边夹住
  if (mode === 'max') { delete opts.x; delete opts.y; opts.width = 900; opts.height = 640; }
  if (mode === 'full') { delete opts.x; delete opts.y; opts.width = 800; opts.height = 600; }

  const w = new BrowserWindow(Object.assign({
    show: false, frame: true, title: 'yukino-probe-window',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  }, opts));

  w.loadURL('data:text/html,' + encodeURIComponent(
    '<body style="margin:0;background:#223047;color:#e8eefc;font:15px/1.6 sans-serif;' +
    'display:flex;align-items:center;justify-content:center">probe window (' + mode + ')</body>'));

  w.once('ready-to-show', () => {
    w.show();
    // ★ 变形一律在 show() 之后（见文件头的坑②）
    if (mode === 'max') w.maximize();
    if (mode === 'full') w.setFullScreen(true);
    w.focus();
    setTimeout(() => out('READY', { pid: process.pid, mode, bounds: w.getBounds() }), 600);
    // 搬家：验"窗口动了她跟着动"。两处位置都写死，好让探针能算出期望值 ——
    // 并且两个 y 都留了足够的上方空间（她的窗口高 492，栖息要站在窗沿上）。
    setTimeout(() => {
      if (mode === 'norm') { try { w.setBounds({ x: 620, y: 560, width: 700, height: 420 }); } catch (e) {} }
      w.focus();
    }, 6000);
    setTimeout(() => out('MOVED', { pid: process.pid, mode, bounds: w.getBounds() }), 6600);
    // 保住前台：Windows 会拦"抢焦点"，隔一会儿补一次最省事。
    setInterval(() => { try { w.focus(); } catch (e) {} }, 1500);
  });
});

app.on('window-all-closed', () => app.exit(0));
