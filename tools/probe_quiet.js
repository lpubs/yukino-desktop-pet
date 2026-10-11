// 雪乃桌宠 · 勿扰可见性的真机验收
//
// 为什么单独有这个脚本：勿扰这条链上的正确性**全在主进程行为里**
// （hide() 到底有没有生效、有没有别的路径把她重新显示出来），
// 而自检是纯文本比对、review.py 走的是浏览器预览页 —— 两者都碰不到它。
// v3.7 那个真机 bug（"勿扰里她还在、还点不到、也关不掉"）就是从这个盲区里出来的。
//
// 它跑的是**真 main.js + 真窗口**，断言四件事：
//   ① 启动即在勿扰 -> 不许出现
//   ② 对隐藏窗口调 moveTop() 会把她显示出来（这是要防的那条 Electron 事实本身）
//   ③ 带可见性闸门的重申（修复后的写法）不许惊动藏起来的她
//   ④ 取消勿扰 -> 必须回来
//
// 用法（需要一台能起 GUI 的机器；受限环境里要自己加 --no-sandbox，
// 否则 Electron 会因为 GPU 进程被沙箱挡住而 FATAL，与这个程序无关）：
//   node_modules/.bin/electron tools/probe_quiet.js
// 临时存档默认落在系统临时目录，**不会碰你真实的 settings.json**。
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UD = process.env.PROBE_UD || path.join(os.tmpdir(), 'yukino-probe-ud');
const SET = path.join(UD, 'settings.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = () => { try { return JSON.parse(fs.readFileSync(SET, 'utf8')); } catch (e) { return {}; } };
const patch = (o) => fs.writeFileSync(SET, JSON.stringify(Object.assign(read(), o), null, 2));

const results = [];
function check(label, got, want) {
  results.push((got === want ? 'PASS' : 'FAIL') + ' | ' + label +
    '  (期望 ' + want + '，实际 ' + got + ')');
}

fs.mkdirSync(UD, { recursive: true });
// ★ 必须先把她真实的存档目录改到临时目录再加载 main.js：
//   main.js 读的是 app.getPath('userData')，不改的话这个脚本会去读（而且会写）
//   你**真实**的 settings.json —— 那既可能让验收结论失真（真存档里有没有勿扰？
//   通常是"没有"，于是①必挂），也会污染 lastSeenAt 这种"久别重逢"的计时基准。
app.setPath('userData', UD);
patch({ quietUntil: Date.now() + 90 * 1000, outfit: 'maid', pinned: true, scale: 'medium' });

require(path.join(ROOT, 'main.js'));

app.whenReady().then(async () => {
  await sleep(3500);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { console.log('FAIL | 没拿到窗口'); app.exit(1); return; }

  check('① 运行在勿扰时段：启动就不该显示', win.isVisible(), false);

  // ② 复现被修掉的那条路径所依赖的 Electron 事实。
  //    旧代码在"10 分钟置顶巡检"和"睡眠/解锁自愈"里无条件调的就是它。
  win.setAlwaysOnTop(true, 'screen-saver');
  win.moveTop();
  await sleep(400);
  check('② 【Electron 事实】对隐藏窗口调 moveTop() 会把她显示出来', win.isVisible(), true);

  // ③ 修复后的写法：先问可见性，再决定动不动 z 序
  if (win.isVisible()) win.hide();
  await sleep(400);
  const gated = (w) => { if (w.isVisible()) w.moveTop(); };
  gated(win);
  await sleep(400);
  check('③ 【修复后】带闸门的置顶重申不会惊动藏起来的她', win.isVisible(), false);

  // ④ 再等几拍（跨过 15s 轮询），确认没有别的路径把她拉出来
  await sleep(3000);
  check('④ 勿扰持续期间（跨过巡检节拍）她依然不在', win.isVisible(), false);

  // ⑤ 勿扰到点 -> 必须回来
  patch({ quietUntil: 0 });
  await sleep(16000);                      // 15s 轮询 + 1.5s 告别延迟
  const w2 = BrowserWindow.getAllWindows()[0];
  check('⑤ 取消勿扰之后她必须回来', w2 ? w2.isVisible() : null, true);

  console.log('\n=== 验收结果（user-data-dir: ' + UD + '）===');
  results.forEach((r) => console.log(r));
  const bad = results.filter((r) => r.startsWith('FAIL')).length;
  console.log('=== ' + (bad ? bad + ' 项失败' : '全部通过') + ' ===');
  app.exit(bad ? 1 : 0);
});
