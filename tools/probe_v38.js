// 雪乃桌宠 · v3.8 真机验收（边缘收边 / 健康提醒 / 空闲检测 / 打扰等级）
//
// 为什么单独有这个脚本：这一版四块新东西里有**三块的正确性全在主进程行为里**，
// 而自检是纯文本比对、preview.html 走的是浏览器替身 —— 两者都碰不到它们：
//   · 边缘收边是"把窗口推出屏幕外"（纯位置）。静态自检只能证明代码写了那句话，
//     证明不了窗口真的有一半在屏幕外、也证明不了"点一下能回来"。
//   · 健康提醒"到没到点"由主进程判（计时在它那边，因为托盘要显示下次提醒）。
//     渲染层只负责演 —— 而"演"这件事得有个真窗口才验得了。
//   · "你在不在"来自 powerMonitor.getSystemIdleTime()，浏览器里根本没有这个 API。
//
// 它跑的是**真 main.js + 真窗口**，断言六件事：
//   ① 收边（左）：角色轮廓真的有一半被推到屏幕外，而且不是整个推出去
//   ② 收边：推出量符合 main.js 里的 EDGE_PUSH（数值直接读源码，不另抄一份）
//   ③ 探头防误触：把她收到**远离光标**的那一侧，位置必须纹丝不动
//   ④ 取消收边：从**左侧收边态**退出 -> 角色完整回到屏幕内，并且重新贴住左边
//   ⑤ 健康提醒：主进程发一条 health -> 她抬头说那句（气泡真的出来了）
//   ⑥ 你离开又回来：主进程发 activity -> 她说一句"刚才做了什么"
//
// ★ 量"角色在哪"一律走**布局口径**（offsetLeft / offsetWidth），不用
//   getBoundingClientRect —— 后者会把两层**与窗口位置无关的形变**一起算进"位置"里，
//   于是同一个窗口位置能读出好几个不同的数（随光标抖）。实测数字与推导见下面
//   petLayout 的注释。这不是洁癖：② 曾经因此变成"光标停在屏幕右边就报失败"的隐性误报。
//
// 用法（需要一台能起 GUI 的机器；受限环境里要自己加 --no-sandbox，
// 否则 Electron 会因为 GPU 进程被沙箱挡住而 FATAL，跟这个程序无关）：
//   node_modules/.bin/electron --no-sandbox tools/probe_v38.js
// 临时存档默认落在系统临时目录，**不会碰你真实的 settings.json**。
const { app, BrowserWindow, screen } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UD = process.env.PROBE_UD || path.join(os.tmpdir(), 'yukino-probe-v38');
const SET = path.join(UD, 'settings.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readSet = () => { try { return JSON.parse(fs.readFileSync(SET, 'utf8')); } catch (e) { return {}; } };
const patch = (o) => fs.writeFileSync(SET, JSON.stringify(Object.assign(readSet(), o), null, 2));

// 从 main.js 源码里读常数，**不另抄一份** —— 抄一份就等于"验一个等效实现"，
// 而且 main.js 改了这边不会知道（这个项目在别处踩过这个坑）。
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
function numOf(name) {
  const m = mainSrc.match(new RegExp('const ' + name + ' = ([0-9.]+)'));
  return m ? Number(m[1]) : null;
}
const EDGE_PUSH = numOf('EDGE_PUSH');
const EDGE_IN = numOf('EDGE_IN');

// 探针固定跑在 medium 档（下面 patch 的就是它），于是 main.js 认定的窗口宽
// = round(BASE_W × SIZES.medium)。这两个数同样从源码里读，仍然"不另抄一份"。
// 用途：② 的容差要盖住"它认定的窗口宽"与"窗口真实内容宽"之差（见 ② 的注释）。
const PROBE_SCALE = 'medium';
const BASE_W = numOf('BASE_W');
const SIZES = (() => {
  const m = mainSrc.match(/const SIZES = \{([^}]*)\}/);
  const o = {};
  if (m) for (const kv of m[1].split(',')) {
    const [k, v] = kv.split(':');
    if (k && v) o[k.trim()] = Number(v.trim());
  }
  return o;
})();
// ★ 读不到就给 NaN，让 ② 走"容差退回 ±8 + 报警"那条路 ——
//   这里若写成 `BASE_W || 0`，容差会变成 ±200 然后永远通过，那就成了"静默失效"，
//   正是这个项目反复在防的那类失败。
const WIN_W0 = Number.isFinite(BASE_W) && Number.isFinite(SIZES[PROBE_SCALE])
  ? Math.round(BASE_W * SIZES[PROBE_SCALE])
  : NaN;                                                          // main.js 认定的窗口宽

const results = [];
function check(label, got, want) {
  results.push((got === want ? 'PASS' : 'FAIL') + ' | ' + label +
    '  (期望 ' + want + '，实际 ' + got + ')');
}
function note(line) { results.push('···· ' + line); }

fs.mkdirSync(UD, { recursive: true });
// ★ 必须在加载 main.js **之前**把存档目录改到临时目录 —— main.js 读的是
//   app.getPath('userData')，不改的话这个脚本会读写你**真实**的 settings.json，
//   既会让结论失真（真存档里可能是勿扰中/收边中），也会污染 lastSeenAt 这种计时基准。
app.setPath('userData', UD);
patch({ quietUntil: 0, outfit: 'maid', pinned: true, scale: PROBE_SCALE, chatter: 'normal' });
//  ↑ 缩放档用 PROBE_SCALE（定义在上面）：② 的容差按它算，两处必须是同一个值。

require(path.join(ROOT, 'main.js'));

app.whenReady().then(async () => {
  await sleep(4000);                       // 等素材解码 + 渲染层启动块跑完
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { console.log('FAIL | 没拿到窗口'); app.exit(1); return; }
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const wa = screen.getPrimaryDisplay().workArea;

  if (!EDGE_PUSH || !EDGE_IN) {
    note('⚠ 读不到 EDGE_PUSH / EDGE_IN —— 收边的数值断言会失真');
  }

  // 角色的**布局**轮廓：transform 免疫的那一份（断言一律用它）。
  //
  // 为什么不能用 getBoundingClientRect：它量的是"合成到屏幕上之后"的位置，于是会把
  // 两层**与窗口位置无关的形变**一并算进去 ——
  //   · #lookWrap 的目光跟随 translate(nx*9px, ny*5px)，随光标位置变（pet.js 的 lookAtCursor）；
  //   · #petWrap 的呼吸 scale(1.012, 0.988)。
  // 实测（同一份代码、窗口 x 都是 −188，只改注入的 nx）：
  //     rect  口径推出 = 179.4（nx=0）/ 171.8（nx=+1）/ 189.2（nx=−1）
  //     布局  口径推出 = 178.5 / 178.5 / 178.5
  // 真值是 178.5 = 角色显示宽 389 × EDGE_PUSH(0.46)，而 rect 口径会跟着光标摆动 ±9px。
  // 原来那条"推出 170 / 期望 180"就是这么来的：**收边一直是对的，是量法在跟着光标抖**。
  //
  // 布局口径怎么来（见 pet.css 的 .frame）：#fBase 是 left:50% + translateX(-50%) 居中，
  //   · offsetWidth            == 角色显示宽（= main.js 的 spriteDisplayW 口径）
  //   · offsetLeft − width/2   == padX（角色左轮廓相对窗口内容区的位置）
  // 而 #fBase 的 offsetParent 链一路是 left:0 / inset:0（#stage → #petArea → #petWrap →
  // #lookWrap → #spriteWrap），所以这个"相对窗口内容区"就等于"相对窗口原点"，
  // 于是"屏幕上的角色左边界 = 窗口 x + 这个 left"。
  const petLayout = () => js(`(function(){
    const f = document.getElementById('fBase');
    const w = f.offsetWidth, l = f.offsetLeft;
    return { left: l - w / 2, right: l + w / 2, width: w };
  })()`);

  // rect 口径只留给诊断备注（见 ② 的 note），用来现场展示"两者差多少"。
  const petRect = () => js(`(function(){
    const r = document.getElementById('fBase').getBoundingClientRect();
    return { left: r.left, right: r.right, width: r.width };
  })()`);
  const petGaze = () => js('document.getElementById("lookWrap").style.transform || "(空)"');

  // ---- ① / ② 收边（左边缘）----
  let pushAtEdge = null;                   // 收边时量到的推出量；④ 拿它做对照
  await js('window.pet.setEdge("left")');
  await sleep(500);                        // 跨过光标巡检的 120ms 一拍
  let b = win.getBounds();
  let box = await petLayout();
  const petLeftOnScreen = b.x + box.left;      // 角色左轮廓落在屏幕的哪个 x
  const petRightOnScreen = b.x + box.right;

  check('① 收边（左）：角色轮廓确实越过了屏幕左边界', petLeftOnScreen < wa.x, true);
  check('① 收边（左）：但不是整个人都被推出去（还看得见）', petRightOnScreen > wa.x + 1, true);

  if (EDGE_PUSH) {
    // 推出量 = 屏幕边 − 角色布局左边界，应当 ≈ 角色显示宽 × EDGE_PUSH。
    //
    // 容差是**推出来的**，不是拍的。它要盖住三件事，全都实测过：
    //   1. padX 的口径差 |视口宽 − main.js 认定的窗口宽| / 2。
    //      推出量里含 padX：main.js 用 (w_它认定的 − 角色宽)/2 算，而浏览器真正用的是
    //      (真实视口宽 − 角色宽)/2，两者差多少，推出量就偏多少。
    //      ★ 实测这条差会随**每一次 setPosition** 涨 1px（150% 缩放下物理像素取整）：
    //        同一轮里 408 → 409 → 410 → 411 → 412 后停住。② 只经历一次 setEdge，
    //        所以稳定读到 408；而 ④ 经历四五次，会走到 412（见 ④ 的注释）。
    //   2. 窗口被摆到负坐标时，实际位置会比 main.js 请求的位置再偏 1px（DPI 取整）。
    //      这一项与环境有关，不该算成"收边算错了"。
    //   3. 两次取整（offsetWidth ≤0.5、setPosition ≤0.5）。
    // 实测：视口 408 时推出 178.5 / 期望 178.9，差 0.4px。
    const winW = await js('document.documentElement.clientWidth');
    const tol = Number.isFinite(WIN_W0) ? 2 + Math.abs(winW - WIN_W0) / 2 : 8;
    if (!Number.isFinite(WIN_W0)) note('⚠ 读不到 BASE_W / SIZES.medium —— ② 的容差退回 ±8');
    const push = wa.x - petLeftOnScreen;
    const want = box.width * EDGE_PUSH;
    const okNum = Math.abs(push - want) <= tol;
    pushAtEdge = push;
    check(`② 推出量符合 EDGE_PUSH（${EDGE_PUSH}）：推出 ${Math.round(push)}px / 期望约 ${Math.round(want)}px` +
      `（容差 ±${tol}，视口宽 ${winW} 对 ${WIN_W0}）`, okNum, true);

    // 现场留证：同一刻换 rect 口径读一遍，差多少就是目光偏移有多少。
    // 这条不是断言（它本来就该随光标变），是给以后改探针的人看的 —— 免得有人看到
    // rect 口径的数字对不上又把它写回断言里。
    const rect = await petRect();
    const rectPush = wa.x - (b.x + rect.left);
    note(`   布局口径推出 ${push.toFixed(1)}px（角色显示宽 ${box.width}px）｜` +
         `同一刻 rect 口径读到 ${rectPush.toFixed(1)}px（差 ${(rectPush - push).toFixed(1)}px）；` +
         `#lookWrap 当前 ${await petGaze()}`);
  }

  // ---- ③ 探头防误触：收到**远离光标**的那一侧，位置必须不变 ----
  await js('window.pet.setEdge(null)');
  await sleep(400);
  const pt = screen.getCursorScreenPoint();
  const farSide = pt.x < wa.x + wa.width / 2 ? 'right' : 'left';
  // 光标离这一侧的距离必须大于 EDGE_IN，否则这条断言本身不成立（会被误判成"探头了"）
  const distToFarSide = farSide === 'left'
    ? pt.x - wa.x
    : (wa.x + wa.width) - pt.x;
  await js(`window.pet.setEdge("${farSide}")`);
  await sleep(600);                        // 多等几拍
  const b1 = win.getBounds();
  await sleep(600);
  const b2 = win.getBounds();
  if (distToFarSide > (EDGE_IN || 90) + 40) {
    check('③ 探头防误触：光标在远侧时，收边位置纹丝不动', b1.x === b2.x, true);
  } else {
    note(`③ 跳过探头防误触：光标离屏幕${farSide === 'left' ? '左' : '右'}边只有 ${Math.round(distToFarSide)}px，` +
         '落进了 EDGE_IN 的判定范围 —— 这一条在这个光标位置上验不了（不是失败）');
  }

  // ---- ④ 取消收边 -> 回到常规位置 ----
  // ⚠ 两个坑，这一条都踩过：
  //
  //  1) 不能依赖"她此刻在哪"。取消收边走的是 resnap() -> moveToClamped()，而它只做
  //     **夹取**、不做搬运 —— 于是她停在原来那一侧。新存档默认把她放在右下角
  //     （x≈1242），"贴住左边"这条断言就必然失败，而它验的其实只是"窗口一开始在哪"。
  //     所以先显式 setEdge('left')，把起点钉死在左边。
  //  2) 断言不能写"窗口 x 回到屏幕内"：这套几何里**窗口**本来就允许有一部分在屏幕外 ——
  //     横向夹的是**角色轮廓**（clamp.js 的 padX），所以贴边站立时窗口 x 就比屏幕边
  //     多出 7~60px（取决于这身装扮的透明边有多宽）。第一版探针就是这么写错的。
  //     真正该验的是"角色轮廓回到屏幕内、并且贴住边缘"。
  await js('window.pet.setEdge("left")');
  await sleep(400);
  await js('window.pet.setEdge(null)');
  await sleep(500);
  b = win.getBounds();
  box = await petLayout();
  const winWAfter = await js('document.documentElement.clientWidth');
  const petLeftAfter = b.x + box.left;
  const pushAfter = wa.x - petLeftAfter;   // 负数 = 她整条轮廓已经在屏幕内、离屏幕边还有几像素
  // 断言的写法：不写"她恰好在屏幕边上（±1px）"，改成"推出量已经收回"。
  //   · 真值：贴住左边时推出量 = 0；实测 −4px（也就是她整条在屏幕内、离边还有 4px）。
  //   · 那 4px 不是收边算错，是同一件事的又一次露面：main.js 的 padX 按**它认定的**窗口宽算
  //     （BASE_W × SIZES.medium = 404），而窗口真实内容宽会随每一次 setPosition 涨 1px ——
  //     这一轮从 408 一路走到 412（见 ② 的注释）。差值的一半原样进位置，
  //     (412 − 388)/2 = 12 对 main.js 以为的 (404 − 389)/2 = 8，正好 4px。
  //     收边时它被 178px 的推出量淹没、看不出来，取消收边后它才浮出来。
  //   · 上限 8 = 上面那 4px + 两次取整 + 那 1px 的 DPI 位移，再留一点余量。
  // 对照收边时的 178px：这条仍然能抓住"取消收边没生效、她还半个身子在屏幕外"。
  check('④ 取消收边：角色轮廓回到屏幕内', petLeftAfter >= wa.x - 3, true);
  check(`④ 取消收边：推出量已收回（收边时 ${pushAtEdge === null ? '—' : Math.round(pushAtEdge)}px -> ` +
        `现在 ${Math.round(pushAfter)}px，负数=整条轮廓都在屏幕内）`, pushAfter <= 8, true);
  note(`   取消收边后：窗口 x=${Math.round(b.x)}（宽 ${b.width}），角色左轮廓落在 ${Math.round(petLeftAfter)}` +
       `（屏幕边 ${Math.round(wa.x)}），角色显示宽 ${box.width}px，视口宽 ${winWAfter}`);

  // ---- ⑤ 健康提醒：主进程直接发一条（真机里由 healthTick 到点触发）----
  // 这里刻意**不**去等 45 分钟 —— 验的是"到点之后那条链路能不能把话说出来"。
  // 计时本身（只在你在的时候累计、到点清零、单拍封顶）由自检第 24 节盯着。
  await js('document.getElementById("bubble").classList.add("hidden")');
  win.webContents.send('health', 'sit');
  await sleep(1600);                       // 打字机是 26ms/字，等它打完
  const shown = await js('!document.getElementById("bubble").classList.contains("hidden")');
  const talk = await js('document.getElementById("bubbleText").textContent');
  check('⑤ 健康提醒：气泡真的出来了', shown, true);
  check('⑤ 健康提醒：说的是"久坐"那一组', /起来|坐太久|椅子|腰/.test(talk), true);
  note(`   她说的是：「${talk}」`);

  // ---- ⑥ 你离开又回来 ----
  await js('document.getElementById("bubble").classList.add("hidden")');
  win.webContents.send('activity', { active: false, awayMs: 0 });
  await sleep(300);
  win.webContents.send('activity', { active: true, awayMs: 12 * 60 * 1000 });
  await sleep(1600);
  const back = await js('document.getElementById("bubbleText").textContent');
  check('⑥ 你离开 12 分钟又回来：她说了一句', back.length > 0, true);
  note(`   她说的是：「${back}」`);

  // 顺带确认这几条新通道都没让渲染层崩掉（能读到 DOM 就说明页面还活着）
  const alive = await js('!!document.getElementById("fBase")');
  check('⑦ 一串新消息之后渲染层仍然活着（没被这些通道搞崩）', alive, true);

  // pet:getIdle 的返回结构（渲染层启动时用它初始化"你在不在"）
  const idl = await js('window.pet.getIdle()');
  check('⑧ pet:getIdle 返回 { active: boolean }',
    !!(idl && typeof idl.active === 'boolean'), true);

  console.log('\n=== v3.8 真机验收（user-data-dir: ' + UD + '）===');
  results.forEach((r) => console.log(r));
  const bad = results.filter((r) => r.startsWith('FAIL')).length;
  const skip = results.filter((r) => r.startsWith('····')).length;
  console.log('=== ' + (bad ? bad + ' 项失败' : '全部通过') + (skip ? `（${skip} 条备注）` : '') + ' ===');
  app.exit(bad ? 1 : 0);
});
