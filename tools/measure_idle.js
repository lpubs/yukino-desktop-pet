// 雪乃桌宠 · 待机开销测量（在真机上跑真 main.js）
//
// 为什么要这个：所有"优化"如果没有数字就是玄学。桌宠是那种一挂一整天的程序，
// 真正值得优化的只有一件事 —— **她什么也不做的时候，到底吃多少 CPU**。
// 这个脚本把两件事分开量：
//   A. 她正常站在桌面上（可见、无人操作）
//   B. 勿扰把她藏起来之后
// 两者之差就是"看得见"这件事本身的价格；A 的绝对值则是"挂着"的价格。
//
// 为什么必须量到分进程：主进程那条 120ms 光标轮询、渲染层的动画/合成，
// 花的是**不同进程**的 CPU，混成一个数字看不出该改哪边。
//
// 用法（需要一台能起 GUI 的机器；受限环境里要自己加 --no-sandbox，
// 否则 Electron 会因为 GPU 进程被沙箱挡住而 FATAL，与这个程序无关）：
//   node_modules/.bin/electron tools/measure_idle.js              只看可见那一档
//   node_modules/.bin/electron tools/measure_idle.js hidden       只看"启动就藏着"那一档
// 临时存档默认落在系统临时目录，**不会碰你真实的 settings.json**（见下面 setPath 那行）。
// 想指定别处就设 PROBE_UD=<目录>。
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const UD = process.env.PROBE_UD || path.join(require('os').tmpdir(), 'yukino-measure-ud');
const SET = path.join(UD, 'settings.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const patch = (o) => {
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(SET, 'utf8')); } catch (e) { /* 首次 */ }
  fs.writeFileSync(SET, JSON.stringify(Object.assign(cur, o), null, 2));
};

fs.mkdirSync(UD, { recursive: true });
// ★ 先把她真实的存档目录改到临时目录，再加载 main.js —— 否则测的是你**真实**的
//   设置（可能正在勿扰），而且会写进 lastSeenAt。不改的话"A 可见"那一档直接失真。
app.setPath('userData', UD);
// 模式 hidden：从启动就处于勿扰（窗口一次都没显示过）。用来回答
// "藏起来以后开销没降"到底是渲染还在跑，还是主进程自己的定时器。
const START_HIDDEN = process.argv.includes('hidden');
patch({ quietUntil: START_HIDDEN ? Date.now() + 30 * 60 * 1000 : 0, outfit: 'maid', pinned: true, scale: 'medium' });
require(path.join(__dirname, '..', 'main.js'));

// 采一段时间里每个进程的 CPU%（percentCPUUsage 以单核为 100）与内存
async function sample(label, ms) {
  const acc = new Map();
  const ticks = Math.round(ms / 1000);
  for (let i = 0; i < ticks; i++) {
    await sleep(1000);
    for (const m of app.getAppMetrics()) {
      const key = m.type + (m.name && m.name !== m.type ? '/' + m.name : '');
      const a = acc.get(key) || { cpu: [], mem: [] };
      a.cpu.push(m.cpu ? m.cpu.percentCPUUsage : 0);
      a.mem.push(m.memory ? m.memory.workingSetSize : 0);   // KB
      acc.set(key, a);
    }
  }
  const avg = (xs) => xs.reduce((s, v) => s + v, 0) / (xs.length || 1);
  console.log('\n--- ' + label + '（' + ticks + ' 秒平均）---');
  let total = 0;
  for (const [k, a] of [...acc.entries()].sort((x, y) => avg(y[1].cpu) - avg(x[1].cpu))) {
    const c = avg(a.cpu);
    total += c;
    console.log('  ' + k.padEnd(28) + ' CPU ' + c.toFixed(2).padStart(6) + '%' +
      '   内存 ' + (avg(a.mem) / 1024).toFixed(1).padStart(7) + ' MB');
  }
  console.log('  ' + '★ 合计'.padEnd(26) + ' CPU ' + total.toFixed(2).padStart(6) + '%');
  return total;
}

app.whenReady().then(async () => {
  await sleep(6000);                                   // 让启动那阵子（加载/解码）过去
  if (START_HIDDEN) {
    const w0 = BrowserWindow.getAllWindows()[0];
    console.log('\n（启动即在勿扰，isVisible = ' + (w0 ? w0.isVisible() : 'null') + '）');
    await sample('B 从前台起就一直藏着（窗口一次都没显示过）', 15000);
    app.exit(0);
    return;
  }
  const vis = await sample('A 可见 · 无人操作', 15000);

  patch({ quietUntil: Date.now() + 120 * 1000 });      // 进勿扰：15s 轮询会在 1.5s 后藏她
  await sleep(20000);
  const w = BrowserWindow.getAllWindows()[0];
  console.log('\n（勿扰中，isVisible = ' + (w ? w.isVisible() : 'null') + '）');
  const hid = await sample('B 勿扰 · 已藏起来', 15000);

  console.log('\n=== 结论 ===');
  console.log('看得见这件事的价格：' + (vis - hid).toFixed(2) + ' 个百分点（可见 ' + vis.toFixed(2) +
    '% / 隐藏 ' + hid.toFixed(2) + '%）');
  app.exit(0);
});
