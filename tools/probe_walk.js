// 雪乃桌宠 · 走路步态的无头采样验收
//
// 为什么单独有这个脚本：走路这东西的**全部信息都在动画曲线上**，而曲线是肉眼最难
// 判、也最容易在改别处时被悄悄带坏的东西。三件事静态自检证明不了：
//
//   · 「上升与下落手感不同」——"重量感"就是这么来的。而 `animation` 简写里给一个
//     缓动函数会让两段共用同一种手感，改回去在截图上一眼看不出（她确实在上下动），
//     只有把曲线采出来才看得见"接近地面时是在减速"。
//   · 「两步一个来回」——`alternate` 掉了以后她仍在动，只是变成**原地左右抖**。
//   · 「步频跟着速度走」——`--step-ms` 有没有真的接到 `animation-duration` 上。
//
// 做法：把 #petWrap 的动画**暂停**、用负 `animation-delay` 直接跳到指定相位，
// 读 `getComputedStyle().transform`。于是"动画"变成一条可以逐点核对的曲线：
// 采样 2 步（正放 + 反放各一遍），解出 translateY / scaleX / scaleY / rotate。
//
// 用法（需要能起 GUI 的机器；受限环境里要自己加 --no-sandbox）：
//   node_modules/.bin/electron --no-sandbox tools/probe_walk.js
// 临时存档落在系统临时目录，**不会碰你真实的 settings.json**。
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UD = process.env.PROBE_UD || path.join(os.tmpdir(), 'yukino-probe-walk');
const SET = path.join(UD, 'settings.json');

const results = [];
function check(label, got, want) {
  results.push((got === want ? 'PASS' : 'FAIL') + ' | ' + label +
    '  (期望 ' + want + '，实际 ' + got + ')');
}
function note(line) { results.push('···· ' + line); }

/** "matrix(a, b, c, d, e, f)" -> { ty, sx, sy, deg }。
 *  变换列表是 translateY · scale · rotate，合成后线性部分 = S·R：
 *      a = sx·cosθ   c = −sx·sinθ
 *      b = sy·sinθ   d =  sy·cosθ
 *  于是 θ = atan2(−c, a)、sx = hypot(a, c)、sy = hypot(b, d)；平移直接读 f。 */
function decode(m) {
  const v = m.match(/matrix\(([^)]+)\)/);
  if (!v) return null;
  const [a, b, c, d, e, f] = v[1].split(',').map(Number);
  return {
    ty: f,
    sx: Math.hypot(a, c),
    sy: Math.hypot(b, d),
    deg: Math.atan2(-c, a) * 180 / Math.PI,
  };
}

fs.mkdirSync(UD, { recursive: true });
// ★ 必须在加载 main.js 之前换掉存档目录（同 probe_v38.js 的理由）。
app.setPath('userData', UD);
// 跑在 **winter** 上：四套里只有它是全身像、三层（eye/mouth/walk）齐全，
// 于是这个脚本能顺带验到下装层的周期与交替。其余三套没有 walk 层，
// "没做"这件事由 selftest 第 25 节按"声明的层 vs 磁盘上的文件"逐套比对，
// 不靠这里的分支。
fs.writeFileSync(SET, JSON.stringify({ quietUntil: 0, outfit: 'winter', pinned: true,
  scale: 'medium', chatter: 'quiet' }, null, 2));
require(path.join(ROOT, 'main.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await sleep(4000);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { console.log('FAIL | 没拿到窗口'); app.exit(1); return; }
  const js = (code) => win.webContents.executeJavaScript(code, true);

  // ---- 1. --step-ms 有没有真的接到 animation-duration 上 ----
  // 这条是"步频跟着速度走"的**唯一**证据：walk() 按速度把 --step-ms 写进去，
  // 如果 CSS 那边没接，它就是个没人读的 CSS 变量（改速度时步子数量不变）。
  const dur = await js(`(function(){
    const wrap = document.getElementById('petWrap');
    const save = wrap.className;
    const last = wrap.style.getPropertyValue('--step-ms');
    wrap.className = 'walk';
    const out = {};
    for (const ms of [420, 260, 600]) {
      wrap.style.setProperty('--step-ms', ms + 'ms');
      out[ms] = getComputedStyle(wrap).animationDuration;
    }
    wrap.className = save;
    if (last) wrap.style.setProperty('--step-ms', last); else wrap.style.removeProperty('--step-ms');
    return out;
  })()`);
  note('--step-ms -> animation-duration: ' +
    Object.keys(dur).map((k) => k + 'ms -> ' + dur[k]).join('   '));
  for (const ms of [420, 260, 600]) {
    check(`步频跟着速度走：--step-ms=${ms}ms 时动画周期也是 ${ms}ms`,
      dur[ms], (ms / 1000) + 's');
  }

  // ---- 2. 把动画钉在相位上采样两步 ----
  // 采样 2 个**动画迭代**（不是 2 个视觉循环）：迭代 1 正放、迭代 2 反放，
  // 于是"两步"正好被这两遍覆盖 —— `alternate` 一旦掉了，第 2 遍会和第 1 遍完全一样。
  const N = 48;
  const raw = await js(`(function(){
    const wrap = document.getElementById('petWrap');
    const save = wrap.className, saveMs = wrap.style.getPropertyValue('--step-ms');
    wrap.style.setProperty('--step-ms', '420ms');
    wrap.className = 'walk';
    wrap.style.animationPlayState = 'paused';
    const T = parseFloat(getComputedStyle(wrap).animationDuration) * 1000;
    const rows = [];
    for (let i = 0; i <= ${N}; i++) {
      const p = i / (${N} / 2);                 // 0 .. 2（两遍迭代）
      wrap.style.animationDelay = (-p * T) + 'ms';
      rows.push({ p: p, m: getComputedStyle(wrap).transform });
    }
    wrap.className = save;
    wrap.style.animationDelay = '';
    wrap.style.animationPlayState = '';
    if (saveMs) wrap.style.setProperty('--step-ms', saveMs); else wrap.style.removeProperty('--step-ms');
    return { T: T, rows: rows };
  })()`);

  const rows = raw.rows.map((r) => ({ p: r.p, m: decode(r.m) }));
  if (rows.some((r) => !r.m)) {
    check('能解出变换矩阵（matrix(...) 形式）', false, true);
    console.log(results.join('\n')); app.exit(1); return;
  }
  note(`采样 ${raw.rows.length} 点，覆盖 2 遍迭代（周期 ${raw.T}ms/步）`);
  note('  相位    translateY   scaleX   scaleY    rotate');
  rows.forEach((r, i) => {
    if (i % 3) return;
    const m = r.m;
    note(`  ${r.p.toFixed(2)}   ${m.ty.toFixed(2).padStart(8)}px` +
      `${m.sx.toFixed(3).padStart(9)}${m.sy.toFixed(3).padStart(9)}` +
      `${m.deg.toFixed(2).padStart(9)}°`);
  });

  const at = (p) => rows[Math.round(p * (N / 2))].m;
  const ys = rows.map((r) => r.m.ty);
  const yMax = Math.max.apply(null, ys), yMin = Math.min.apply(null, ys);

  // 峰值/最低点必须在"该在的相位"上：落地 p=0/1、过腿 p=0.5/1.5。
  for (const [p, want, tag] of [[0, yMax, '触地'], [1, yMax, '触地'], [2, yMax, '触地'],
                                [0.5, yMin, '过腿'], [1.5, yMin, '过腿']]) {
    check(`${tag}（p=${p}）落在垂直方向的${want === yMax ? '最低点' : '最高点'}`,
      Math.abs(at(p).ty - want) < 0.35, true);
  }

  // 落地压扁 / 过腿拉长 —— 这是"重量"的第二半（第一半是缓动）。
  for (const p of [0, 1, 2]) {
    check(`触地（p=${p}）压扁：scaleY<1 且 scaleX>1`,
      at(p).sy < 1 && at(p).sx > 1, true);
  }
  for (const p of [0.5, 1.5]) {
    check(`过腿（p=${p}）拉长：scaleY>1 且 scaleX<1`,
      at(p).sy > 1 && at(p).sx < 1, true);
  }

  // `alternate`：两遍迭代的**倾斜方向相反**。没有它，第 2 遍会和第 1 遍逐位相同
  // （原地左右抖），而"她仍在上下动"这一点在截图上看不出区别。
  const d0 = at(0).deg, d1 = at(1).deg;
  note(`倾斜：p=0 是 ${d0.toFixed(2)}°，p=1 是 ${d1.toFixed(2)}°`);
  check('两步的倾斜方向相反（alternate 生效，不是原地左右抖）',
    d0 * d1 < 0 && Math.abs(Math.abs(d0) - Math.abs(d1)) < 0.3, true);
  check('过腿时回正（rotate ≈ 0）', Math.abs(at(0.5).deg) < 0.15, true);

  // ★ 「顿挫」的可量定义：**下落末段比首段快**（砸下来），上升末段比首段慢（弹上去）。
  //   两段对称的 ease-in-out 会让这两个比值都 ≈ 1 —— 那就是"匀速滑下去"，
  //   正是 v3.4~v3.10 那版看起来在飘的原因。
  const drop = [];
  for (let i = Math.round(0.5 * (N / 2)); i <= N / 2; i++) drop.push(rows[i].m.ty);
  const rise = [];
  for (let i = 0; i <= Math.round(0.5 * (N / 2)); i++) rise.push(rows[i].m.ty);
  const seg = (arr, k) => {                    // 第 k 段（共 5 段）的平均速度
    const L = arr.length, a = Math.floor(k * (L - 1) / 5), b = Math.floor((k + 1) * (L - 1) / 5);
    return (arr[b] - arr[a]) / Math.max(1, b - a);
  };
  const dropTail = seg(drop, 4), dropHead = seg(drop, 0);
  const riseTail = seg(rise, 4), riseHead = seg(rise, 0);
  note(`下落速度：首段 ${Math.abs(dropHead).toFixed(3)}px/格 -> 末段 ` +
    `${Math.abs(dropTail).toFixed(3)}px/格（末段/首段 = ${(Math.abs(dropTail) / Math.abs(dropHead)).toFixed(2)}）`);
  note(`上升速度：首段 ${Math.abs(riseHead).toFixed(3)}px/格 -> 末段 ` +
    `${Math.abs(riseTail).toFixed(3)}px/格（末段/首段 = ${(Math.abs(riseTail) / Math.abs(riseHead)).toFixed(2)}）`);
  check('下落是"加速砸下来"（末段速度 ≥ 首段的 1.5 倍）',
    Math.abs(dropTail) >= Math.abs(dropHead) * 1.5, true);
  check('上升是"减速弹上去"（末段速度 ≤ 首段的 0.7 倍）',
    Math.abs(riseTail) <= Math.abs(riseHead) * 0.7, true);

  // 幅度：太小就看不出来，太大就变成蹦迪。
  const travel = yMax - yMin;
  note(`垂直行程 ${travel.toFixed(2)}px（最大 ${yMax.toFixed(2)} / 最小 ${yMin.toFixed(2)}）`);
  check('垂直行程在 4~10px 之间（看得见且有重量、不蹦迪）',
    travel >= 4 && travel <= 10, true);

  // ---- 3. 走动两帧（下装层）：周期必须是步周期的两倍，且两帧严格交替 ----
  // 为什么这条要单独验：`animation: hemA calc(var(--step-ms, 420ms) * 2) ...` 里
  // **calc 配 var 一旦被浏览器拒掉，整条简写都失效** —— 而失效的表现是
  // "两张图都停在 opacity:0"，也就是"走路什么都不显示"，不是报错。
  // 另外两帧还有两种只在读数上分得清的失效：都显示（叠在一起 = 重影）
  // 和都不显示（= 完全没接上）。
  const hem = await js(`(function(){
    const wrap = document.getElementById('petWrap');
    const A = document.getElementById('fHemA'), B = document.getElementById('fHemB');
    const save = wrap.className, saveMs = wrap.style.getPropertyValue('--step-ms');
    wrap.style.setProperty('--step-ms', '420ms');
    wrap.className = 'walk';
    const dur = [getComputedStyle(A).animationDuration, getComputedStyle(B).animationDuration];
    const T = parseFloat(dur[0]) * 1000;
    const rows = [];
    A.style.animationPlayState = B.style.animationPlayState = 'paused';
    for (const p of [0.0, 0.25, 0.5, 0.6, 0.75, 0.9]) {
      A.style.animationDelay = B.style.animationDelay = (-p * T) + 'ms';
      rows.push({ p: p,
        a: parseFloat(getComputedStyle(A).opacity),
        b: parseFloat(getComputedStyle(B).opacity) });
    }
    const natW = [A.naturalWidth, B.naturalWidth];
    A.style.animationDelay = B.style.animationDelay = '';
    A.style.animationPlayState = B.style.animationPlayState = '';
    wrap.className = save;
    if (saveMs) wrap.style.setProperty('--step-ms', saveMs); else wrap.style.removeProperty('--step-ms');
    return { dur: dur, rows: rows, natW: natW };
  })()`);

  note('下装两帧：animation-duration = ' + hem.dur.join(' / ') +
    '（--step-ms=420ms 时应当是 0.84s = 两步）');
  note('  相位    hemA  hemB');
  hem.rows.forEach((r) => note(`  ${r.p.toFixed(2)}   ${r.a.toFixed(2)}  ${r.b.toFixed(2)}`));

  if (!hem.natW[0] || !hem.natW[1]) {
    // 这套没有 walk 层（胸像）。**这不是失败** —— 层是可选的，
    // 但必须明确报出来，否则"没做"和"接断了"在结论里长得一样。
    note(`当前套装没有下装层（naturalWidth ${hem.natW.join('/')}）` +
      ' —— 这是预期：只有全身像那套做得了。');
  } else {
    check('下装两帧的周期 = 步周期的 2 倍（calc(var(--step-ms) * 2) 真的生效）',
      hem.dur[0], '0.84s');
    check('两帧不会同时显示（同时显示 = 迈步叠成重影）',
      hem.rows.some((r) => r.a > 0.5 && r.b > 0.5), false);
    check('两帧不会同时隐藏（同时隐藏 = 走路时下装那一下空掉）',
      hem.rows.every((r) => r.a < 0.01 && r.b < 0.01), false);
    check('两帧严格互补：任一相位恒有且只有一帧可见',
      hem.rows.every((r) => Math.abs(r.a + r.b - 1) < 0.02), true);
  }

  console.log(results.join('\n'));
  const bad = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n=== ${results.filter((r) => r.startsWith('PASS')).length} 项通过 / ${bad} 项失败 ===`);
  app.exit(bad ? 1 : 0);
}).catch((e) => { console.log('FAIL | 探针自身出错: ' + e.message); app.exit(1); });
