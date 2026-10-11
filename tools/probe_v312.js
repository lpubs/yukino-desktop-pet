// 雪乃桌宠 · v3.12 真机验收（前台窗口感知 / 窗口栖息 / 全屏自动勿扰）
//
// 为什么必须有这个脚本：v3.12 三件事的正确性**全在主进程 + Win32 那一侧** ——
//   · 全屏判据到底把"最大化窗口"排除了没有
//   · 她该不该藏、藏了之后还能不能回来（轮询没被可见性闸门掐死）
//   · 栖息时她贴得对不对、窗口动了她跟不跟得上
// 自检是纯文本比对（只能验 wininfo 的纯函数与源码形态）、review.py 走的是浏览器
// 预览页（压根没有"前台窗口"这回事）。两者都碰不到上面任何一条。
//
// 它跑的是**真 main.js + 真窗口 + 真 Win32**，并且陪练窗口是一个**独立 Electron 进程**
// （见 tools/probe_v312_win.js 里的说明：同进程的窗口会被判成 self，什么都验不到）。
//
// ⚠ 所有跨进程调用（executeJavaScript / 起陪练窗）都带超时。理由是真踩过：
//   一个没有超时的 await 会让整条验收**静默挂死**（脚本还在跑、什么都不打印），
//   而"挂死"和"通过"在 CI 日志里长得一模一样。超时后要报 FAIL，不能停在那儿。
//
// 用法（需要一台能起 GUI 的机器；受限环境要加 --no-sandbox，
// 否则 GPU 进程被沙箱挡住会 FATAL —— 那是环境限制，不是这个程序的问题）：
//   node_modules/.bin/electron --no-sandbox tools/probe_v312.js
// 临时存档落在系统临时目录，**不会碰你真实的 settings.json**。
'use strict';
const { app, BrowserWindow, screen } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HELPER = path.join(__dirname, 'probe_v312_win.js');
const UD = process.env.PROBE_UD || path.join(os.tmpdir(), 'yukino-probe312-ud');
const SET = path.join(UD, 'settings.json');
const HARD_TIMEOUT_MS = 150 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readSettings = () => { try { return JSON.parse(fs.readFileSync(SET, 'utf8')); } catch (e) { return {}; } };
const patch = (o) => fs.writeFileSync(SET, JSON.stringify(Object.assign(readSettings(), o), null, 2));

const results = [];
function check(label, got, want) {
  results.push((String(got) === String(want) ? 'PASS' : 'FAIL') + ' | ' + label +
    '  (期望 ' + want + '，实际 ' + got + ')');
}
function note(label, text) { results.push('note | ' + label + '：' + text); }
function finish(code) {
  console.log('\n=== v3.12 真机验收（user-data-dir: ' + UD + '）===');
  results.forEach((r) => console.log(r));
  const bad = results.filter((r) => r.startsWith('FAIL')).length;
  console.log('=== ' + (bad ? bad + ' 项失败' : '全部通过') + ' ===');
  app.exit(code === undefined ? (bad ? 1 : 0) : code);
}

// ---------- 陪练窗口的进程管理 ----------
function spawnWin(mode) {
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;          // 预置了这个变量的话 electron 会退化成纯 node
  const proc = spawn(process.execPath, ['--no-sandbox', HELPER, mode],
    { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const h = { proc, last: {} };
  proc.stdout.on('data', (b) => {
    for (const raw of b.toString().split('\n')) {
      const m = /^(READY|MOVED) (\{.*\})$/.exec(raw.trim());
      if (m) { try { h.last[m[1]] = JSON.parse(m[2]); } catch (e) { /* 忽略 */ } }
    }
  });
  proc.stderr.on('data', () => { /* 陪练窗的日志无用，别让它堵住管道 */ });
  return h;
}
async function killWin(h) {
  if (!h) return;
  const pid = h.last.READY && h.last.READY.pid;
  try { if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']); } catch (e) { /* 忽略 */ }
  try { h.proc.kill(); } catch (e) { /* 忽略 */ }
  await sleep(700);
}
async function waitFor(h, tag, ms) {
  const t0 = Date.now();
  while (!h.last[tag] && Date.now() - t0 < ms) await sleep(100);
  return h.last[tag] || null;
}

fs.mkdirSync(UD, { recursive: true });
// ★ 先把她真实的存档目录改到临时目录再加载 main.js —— 与 probe_quiet.js 同一条纪律。
app.setPath('userData', UD);
patch({
  quietUntil: 0, outfit: 'maid', pinned: true, scale: 'medium',
  autoQuiet: true, firstRunAt: Date.now()
});

require(path.join(ROOT, 'main.js'));
const wininfo = require(path.join(ROOT, 'wininfo.js'));

// 硬超时：宁可报 FAIL 也不要静默挂着（挂死与通过在日志里长得一样）
setTimeout(() => { check('硬超时（' + HARD_TIMEOUT_MS / 1000 + 's 内没跑完）', 'TIMEOUT', '<未超时>'); finish(1); },
  HARD_TIMEOUT_MS);

app.whenReady().then(async () => {
  await sleep(4000);                          // 等窗口 + 渲染层起来
  const petWin = BrowserWindow.getAllWindows()[0];
  if (!petWin) { check('拿到桌宠窗口', false, true); finish(1); return; }

  // 所有渲染层调用都带超时：她藏起来时 executeJavaScript 有可能不返回，
  // 没有这层保险的话整个验收会卡死在第 ④ 步。
  const js = (code, ms) => Promise.race([
    petWin.webContents.executeJavaScript(code).catch((e) => 'ERR ' + e.message),
    sleep(ms || 6000).then(() => 'TIMEOUT')
  ]);
  const fg = () => js('window.pet.getForeground()');
  const petSb = () => petWin.getBounds();

  // ---------- ① 模块可用性 + DPI ----------
  check('① wininfo.available()（koffi 能在 Electron 主进程里加载）', wininfo.available(), true);
  const raw = wininfo.foreground();
  check('① foreground() 拿到前台窗口', !!(raw && raw.monitor), true);

  const d = screen.getPrimaryDisplay();
  const wantPhysW = Math.round(d.bounds.width * d.scaleFactor);
  const gotPhysW = raw && raw.monitor ? raw.monitor.w : -1;
  // 这一条守的是 toDip 的前提：Win32 给物理像素、Electron 给 DIP，两者差一个 scaleFactor。
  // 若哪天 Electron 变成 non-DPI-aware（或本机 scale 变了），这里会先响。
  check('① Win32 物理宽度 == DIP × scaleFactor（' + wantPhysW + '）',
    Math.abs(gotPhysW - wantPhysW) <= 2, true);
  note('① 本机缩放', d.scaleFactor + '×，屏幕 DIP ' + d.bounds.width + '×' + d.bounds.height +
    '，Win32 报 ' + gotPhysW + '×' + (raw && raw.monitor ? raw.monitor.h : '?'));

  // ---------- ② 隐私边界（真机侧）----------
  check('② exe 只有文件名、不含路径分隔符', /[\\/]/.test(raw.exe), false);
  check('② 快照里没有任何"标题"字段（只读进程名 + 窗口矩形）',
    Object.keys(raw).some((k) => /title|text/i.test(k)), false);
  note('② 探针起步时的前台进程名', raw.exe || '（空：场景没变过，主进程不会重复推）');

  // ---------- ③ 最大化 ≠ 全屏（这一版的命门）----------
  // 只写"尺寸差不多等于屏幕"的话，这里会判成全屏 —— 用户最大化浏览器工作时她会消失。
  let h = spawnWin('max');
  const r3 = await waitFor(h, 'READY', 8000);
  check('③ 陪练窗（最大化）起来了', !!r3, true);
  await sleep(3000);
  const s3 = await fg();
  check('③ 最大化窗口没有被判成全屏', s3.fullscreen, false);
  check('③ 最大化时她**没有**消失（这就是那个 bug 的反面）', petWin.isVisible(), true);
  check('③ 场景归到 other（electron.exe 不在规则表里）', s3.scene, 'other');
  check('③ quiet=false（自动档没被误触发）', s3.quiet, false);
  const rawMax = wininfo.foreground();
  if (rawMax) {
    note('③ Win32 原始矩形（物理）', JSON.stringify(rawMax.rect) + ' maximized=' + rawMax.maximized +
      '；屏幕物理 ' + rawMax.monitor.w + '×' + rawMax.monitor.h);
    check('③ 陪练窗确实是"最大化"（否则这一条测的不是命门）', rawMax.maximized, true);
  }
  await killWin(h);

  // ---------- ④ 真全屏 -> 自动躲起来 ----------
  h = spawnWin('full');
  const r4 = await waitFor(h, 'READY', 8000);
  check('④ 陪练窗（全屏）起来了', !!r4, true);
  await sleep(3000);
  const s4 = await fg();
  check('④ 检测到全屏', s4.fullscreen, true);
  check('④ 她自动藏起来了（不说告别、立刻藏）', petWin.isVisible(), false);
  check('④ quiet=true —— 自动档确实并进了勿扰判据', s4.quiet, true);
  check('④ manualQuiet=false —— 这不是手动档（菜单里三个档位不该变灰）', s4.manualQuiet, false);
  // 渲染层也收到了 —— 而且验的是**可见效果**：她冻结要靠 `pet-frozen` 那个类
  // （JS 切类名 + CSS 落规矩两处配对，漏一处是静默失效）。
  // ⚠ 别用 window.__petDemo：那个调试出口只在 preview.html 里开
  //   （真机不设 __PET_DEBUG__，故意不把内部函数泄到 window 上）。
  check('④ 渲染层也冻住了（html.pet-frozen 挂上）',
    await js("document.documentElement.classList.contains('pet-frozen')"), true);

  // ---------- ⑤ 退出全屏 -> 必须回来（轮询没被可见性闸门掐死）----------
  await killWin(h);
  await sleep(3000);
  check('⑤ 退出全屏后她自己回来了', petWin.isVisible(), true);
  const s5 = await fg();
  check('⑤ fullscreen 复位', s5.fullscreen, false);

  // ---------- ⑥ 窗口栖息 ----------
  h = spawnWin('norm');
  const r6 = await waitFor(h, 'READY', 8000);
  check('⑥ 陪练窗（普通）起来了', !!r6, true);
  await sleep(2500);

  const wa = await js('window.pet.getWorkArea()');       // { x,y,width,height, sink, petW, petH }
  check('⑥ 拿到工作区（含 sink / petW）', !!(wa && wa.petW), true);
  const r6b = r6 ? r6.bounds : null;
  check('⑥ setPerch(true) 生效', await js('window.pet.setPerch(true)'), true);
  await sleep(1200);
  const b6 = petSb();
  const s6 = await fg();
  check('⑥ 主进程那边也认了（perch=true）', s6.perch, true);
  if (r6b && wa && wa.petW) {
    // 口径：她的**脚踩在窗口上沿那条线**（脚 = 窗口底边 − sink）。
    // 容差给 5px 是因为两个数各有取整：getBounds() 报的是整数，而 winSize() 是小数
    // （本机 medium 档 406×490.x），两者叠加会有几个像素的口径差。
    // 真正强的那条断言是第 ⑦ 步的**相对位移**（窗挪多少她就挪多少，精确相等）。
    check('⑥ 她踩在陪练窗的上沿（底边 ≈ 窗上沿 + sink，容差 5px）',
      Math.abs((b6.y + b6.height) - (r6b.y + wa.sink)) <= 5, true);
    const wantX = Math.round(r6b.x + (r6b.width - wa.petW) / 2);
    check('⑥ 她横向居中于那扇窗', Math.abs(b6.x - wantX) <= 3, true);
    // 陪练窗上方得真有空间，否则上面那条是在"她被夹到屏幕顶"的情况下通过的，
    // 看起来一样绿，其实没验到"贴窗口上沿"这件事。
    check('⑥ 上方确实还有空间（不是在屏幕顶上夹出来的）', b6.y > d.workArea.y + 20, true);
  }
  note('⑥ 栖息位置', JSON.stringify(b6) + '；陪练窗 ' + JSON.stringify(r6b) +
    ' sink=' + (wa && wa.sink) + ' petW=' + (wa && wa.petW) + ' petH=' + (wa && wa.petH) +
    ' 实测底边高于窗沿 ' + (b6.y + b6.height - r6b.y) + 'px');

  // 栖息中不写位置存档（她此刻的位置是临时姿态，不是"她住的地方"）
  const posBefore = JSON.stringify(readSettings().pos || null);
  await js('window.pet.savePos(' + (b6.x + 5) + ',' + (b6.y + 5) + ')', 4000);
  await sleep(400);
  check('⑥ 栖息中 savePos 不写盘', JSON.stringify(readSettings().pos || null), posBefore);

  // ---------- ⑦ 窗口动了她跟着动 ----------
  const mv = await waitFor(h, 'MOVED', 14000);
  check('⑦ 陪练窗搬家了', !!mv, true);
  await sleep(1800);
  const b7 = petSb();
  if (mv && wa && wa.petW && r6b) {
    // ★ 这一条是整节里最硬的：窗口挪了多少，她就该挪多少 —— **精确相等**，
    //   不掺任何取整。它能一次抓住"她没跟着走""跟了但只跟了一半"
    //   "跟错轴"这三种坏法，而且不依赖 sink / 尺寸那些有口径争议的数。
    check('⑦ 窗挪多少她就挪多少（横向，精确）', b7.x - b6.x, mv.bounds.x - r6b.x);
    check('⑦ 窗挪多少她就挪多少（纵向，精确）', b7.y - b6.y, mv.bounds.y - r6b.y);
    check('⑦ 跟着搬到新窗口的上沿（底边 ≈ 新窗上沿 + sink，容差 5px）',
      Math.abs((b7.y + b7.height) - (mv.bounds.y + wa.sink)) <= 5, true);
    const wantX7 = Math.round(mv.bounds.x + (mv.bounds.width - wa.petW) / 2);
    check('⑦ 横向也跟着居中了', Math.abs(b7.x - wantX7) <= 3, true);
    note('⑦ 搬家', JSON.stringify(b6) + ' -> ' + JSON.stringify(b7) +
      '（陪练窗 ' + JSON.stringify(r6b) + ' -> ' + JSON.stringify(mv.bounds) + '）');
  }

  // ---------- ⑧ 下来要落地 ----------
  check('⑧ setPerch(false) 生效', await js('window.pet.setPerch(false)'), false);
  await sleep(1000);
  const b8 = petSb();
  check('⑧ 退出栖息后落地（不再悬在半空）', b8.y > b7.y + 50, true);
  const s8 = await fg();
  check('⑧ 主进程那边也复位了（perch=false）', s8.perch, false);
  note('⑧ 落地位置', JSON.stringify(b8) + '（工作区底边 ' + (d.workArea.y + d.workArea.height) + '）');

  await killWin(h);
  finish();
});
