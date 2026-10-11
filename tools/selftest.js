#!/usr/bin/env node
// 雪乃桌宠 · 静态自检
//
// 目的：把那些"改了一处、忘了另一处"的错误在打包之前抓出来。
// 这类错误有个共同特点 —— 不一定报错，但功能会静默失效：
//   · 主进程发的 IPC 通道名和 preload 里注册的对不上 -> 右键换装点了没反应
//   · pet.js 里 $('#xxx') 的元素在 index.html 里根本不存在 -> 直接 TypeError
//   · 台词库里没有 QUOTES.xxx -> 气泡空白
//   · 三帧素材尺寸不一致 -> 眨眼时整张图跳一下
//   · CSP 是 script-src 'self' 却写了内联 <script> -> 整段脚本静默不执行
//
// 零依赖，只用 node 内置模块。用法：node tools/selftest.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');   // 只为第 25 节逐像素核 alpha，见 pngPixels()

const ROOT = path.resolve(__dirname, '..');
const R = (p) => path.join(ROOT, p);

let pass = 0, fail = 0;
const problems = [];

function ok(msg) { pass++; console.log('  \u2713 ' + msg); }
function bad(msg, detail) {
  fail++;
  problems.push(msg + (detail ? '  -- ' + detail : ''));
  console.log('  \u2717 ' + msg + (detail ? '\n      ' + detail : ''));
}
function section(t) { console.log('\n' + t); }

function read(p) {
  try { return fs.readFileSync(R(p), 'utf8'); } catch (e) { return null; }
}
// 剥掉 `//` 行注释后的源码。
// 给"某某写法不许再出现"这类断言用 —— 已经踩过**两次**同样的坑：
// 说明文字里正好引用了被禁的写法（"而不是逐项列举 !k && !o && !sc"、
// "现在用 wait=layers 等解码"），于是断言在代码被改回去之后**照样通过**。
// 不去块注释：本项目的渲染层代码里没有跨行 /* */。
function stripLineComments(s) {
  return s.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}
function exists(p) { return fs.existsSync(R(p)); }
function sizesIn(text, name) {
  return [...text.matchAll(new RegExp(name + '\\s*=\\s*\\[?[^\\]]*?(\\d+(?:\\s*,\\s*\\d+)*)', 'g'))];
}

// ---------- 1. 必需文件 ----------
section('[1] 必需文件');
const REQUIRED = [
  'README.md', '启动雪乃桌宠.bat', '打包成exe.bat',
  'main.js', 'preload.js', 'clamp.js', 'package.json',
  'renderer/index.html', 'renderer/pet.css', 'renderer/pet.js',
  'renderer/dialogue.js', 'renderer/stats.html', 'renderer/stats.js',
  'renderer/preview.html',
  'assets/sprites/maid.png', 'assets/sprites/sailor.png',
  'assets/sprites/coat.png', 'assets/sprites/winter.png',
  'assets/tray.png', 'build/icon.ico',
  'tools/cut.py', 'tools/build_assets.py', 'tools/prep_ref.py',
  'tools/make_icons.py', 'tools/prepare_sfx.py', 'tools/review.py',
  'assets/sfx/CREDITS.md', 'assets/sfx/sources.json',   // 素材来源与授权必须跟着走
  'tools/prep-build-cache.js', 'tools/gen_launchers.py',
  'tools/abandoned/README.md',      // 记着"眨眼差分"为什么被废掉
  // 注意：models/isnetis.onnx 与 tools/anime_cut.py **不在**必需列表里。
  // 它们是备用路径（背景连连通性都分不出时才用），默认流程不经过 —— 见 [2c]。
];
for (const f of REQUIRED) {
  if (exists(f)) ok(f);
  else bad('缺少文件: ' + f);
}

// ---------- 2. 窗口尺寸常量必须两边一致 ----------
section('[2] 窗口尺寸常量一致性');
const mainJs = read('main.js') || '';
const petJs = read('renderer/pet.js') || '';
const prevHtml = read('renderer/preview.html') || '';
function constOf(text, name) {
  const m = text.match(new RegExp('\\b' + name + '\\s*=\\s*(\\d+)'));
  return m ? Number(m[1]) : null;
}
// ---- 尺寸常量的比对：按**定义式求值**，不抓字面量 ----
// 从 v3.2.3 起窗口高不再是孤立数字，而是「角色高 + 留白」的表达式，
// 所以"抓第一个数字"会失效：注释里的示例（BASE_H = 469）反倒被当成真定义，
// 真正的表达式却被跳过 —— 报出来的结论正好是反的。
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => {
      // 行尾注释也要剥：常量定义后面常跟着 `// = 469` 这种解释，
      // 不剥掉的话表达式里会混进文字，求值直接失败（表现成"定义找不到"）。
      const i = l.indexOf('//');
      return (i >= 0 && l[i - 1] !== ':') ? l.slice(0, i) : l;   // 别把 URL 的 :// 当注释
    })
    .join('\n');
}
// 只认"独立成行"的定义 `const NAME = 表达式;`
// 不这么严的话 `const A = 1, B = 2;` 会整行被抓来求值成逗号表达式、
// 返回最后一个值 —— 数字看着对，其实张冠李戴。
function defExpr(text, name) {
  const rx = new RegExp('^(?:const|let|var)\\s+' + name + '\\s*=\\s*(.+)$');
  for (const line of stripComments(text).split('\n')) {
    const m = line.trim().match(rx);
    if (m) return m[1].trim().replace(/;\s*$/, '');
  }
  return null;
}
// 表达式会引用同文件里别的常量（BASE_H = PET_H + …），所以按**已知作用域**求值。
function numExpr(expr, scope) {
  if (!expr) return null;
  const names = Object.keys(scope || {});
  try {
    const v = new Function(...names, 'return (' + expr + ')')(...names.map((n) => scope[n]));
    return typeof v === 'number' && isFinite(v) ? v : null;
  } catch (_) { return null; }
}
// 按定义顺序求值 —— 后面的表达式可以引用前面的常量
function constsOf(text, names) {
  const scope = {};
  for (const n of names) scope[n] = numExpr(defExpr(text, n), scope);
  return scope;
}
const mainC = constsOf(mainJs, ['BASE_W', 'PET_H', 'TOP_PAD_RATIO', 'BASE_H']);
const petC = constsOf(petJs, ['WIN_W', 'WIN_H', 'PET_TOP_PAD_RATIO']);
const prevC = constsOf(prevHtml, ['BASE_W', 'TOP_PAD_RATIO', 'BASE_H']);

// 查的是 100% 档的基准尺寸，不是"当前窗口尺寸" —— 后者随缩放档变化，
// 真值只有主进程知道，渲染层一律用 getWorkArea/getBounds 问它。
// 三处必须一致：main.js（真机）/ pet.js 的 WIN_*（渲染层兜底）/ preview.html（预览舞台）。
const dims = {
  'main.js': { W: mainC.BASE_W, H: mainC.BASE_H },
  'pet.js': { W: petC.WIN_W, H: petC.WIN_H },
  'preview.html': { W: prevC.BASE_W, H: prevC.BASE_H },
};
for (const axis of ['W', 'H']) {
  const label = axis === 'W' ? '宽' : '高';
  const vals = Object.entries(dims).map(([k, v]) => [k, v[axis]]);
  const miss = vals.filter(([, v]) => v === null).map(([k]) => k);
  if (miss.length) {
    bad(`窗口${label} 的定义找不到`, miss.join(' / '));
  } else {
    const uniq = [...new Set(vals.map(([, v]) => v))];
    if (uniq.length > 1) {
      bad(`窗口${label} 三处不一致`, vals.map(([k, v]) => `${k}=${v}`).join('  '));
    } else {
      ok(`窗口${label}三处一致 = ${uniq[0]}`);
    }
  }
}

// ---- 顶部留白：同一个数写在五个地方，最容易漂 ----
// main.js / pet.js / preview.html 各一个 TOP_PAD_RATIO，加上 pet.css 里
// #petArea 的 `calc(100% - 22cqw)`、还有 tools/measure_bubble.py 里的
// TOP_PAD_CQW（验收工具自己也要按同一个数算留白带，否则它量的是另一条线，
// 会报出一个不存在的 bug —— 第一版就只有它漏了）。
// 这类重复定义以前就漏过（Python / JS 两份隐私白名单，写完五分钟就漂了一条）。
const measPy = read('tools/measure_bubble.py') || '';
const padVals = {
  'main.js': mainC.TOP_PAD_RATIO,
  // pet.js 里名字带 PET_ 前缀：它是普通脚本（非 module），顶层 const 落在全局作用域，
  // 直接叫 TOP_PAD_RATIO 会与 preview.html 内联脚本的同名常量撞车，
  // 解析期就抛 SyntaxError、整个 pet.js 一行不跑 —— 名字不同是**故意的**。
  'pet.js': petC.PET_TOP_PAD_RATIO,
  'preview.html': prevC.TOP_PAD_RATIO,
};
{
  const css = stripComments(read('renderer/pet.css') || '');
  const m = css.match(/#petArea\s*\{[^}]*calc\(100%\s*-\s*([\d.]+)cqw\s*\)/);
  padVals['pet.css #petArea'] = m ? Number(m[1]) / 100 : null;
  const mp = measPy.match(/^TOP_PAD_CQW\s*=\s*([\d.]+)/m);
  padVals['measure_bubble.py'] = mp ? Number(mp[1]) : null;
  const miss = Object.entries(padVals).filter(([, v]) => v === null).map(([k]) => k);
  if (miss.length) {
    bad('顶部留白比值找不到定义', miss.join(' / '));
  } else if (new Set(Object.values(padVals)).size > 1) {
    bad('顶部留白五处不一致', Object.entries(padVals).map(([k, v]) => `${k}=${v}`).join('  '));
  } else {
    ok(`顶部留白五处一致 = ${Object.values(padVals)[0]}（窗口宽的百分比）`);
  }
}

// ---- 留白带必须真的容得下气泡（v3.6 新增）----
// 上一条只保证"五个地方写的是同一个数"，不保证"这个数够大、也没把气泡放错地方"。
// v3.5 就吃过"数一致但不够大"：17% 在极小档容不下两行台词，气泡底边 48px
// 顶进她额头，而五处数值**完全一致** —— 一致性检查全程绿灯。
// 这里守三件事：
//   1) #topBar 就是那条留白带本身（`top:0; height:<留白>cqw`），
//      内容贴它的**底边**对齐（align-items: flex-end）。底边那条线 = 她头顶。
//   2) ⚠ 明确禁止 `bottom: calc(<留白>cqw …)` 这种写法：它读作"离窗口**底边**若干"，
//      而留白带在窗口**顶部** —— 气泡会被丢到她腰上。第一版就是这么写的，
//      而且当时的验收判据把方向也搞反了、给这个错位开了绿灯。
//      （教训：判据写错比没有判据更危险，它会递给你一个绿灯。）
//   3) 徽章与气泡**横排**（flex-direction: row）。竖排是把两者高度相加塞进留白带，
//      极小档必然落到她身上 —— 这正是 v3.6 修的根因。
{
  const css = stripComments(read('renderer/pet.css') || '');
  const pad = padVals['pet.css #petArea'];
  const topBar = (css.match(/#topBar\s*\{[^}]*\}/) || [''])[0];
  const hm = topBar.match(/height:\s*([\d.]+)cqw/);
  if (/bottom:\s*calc\(\s*[\d.]+cqw/.test(topBar)) {
    bad('#topBar 用了 bottom: calc(<留白>cqw …)',
      '那条线在窗口底部，留白带在顶部 —— 气泡会被丢到她腰上。' +
      '应该写 top:0 + height:<留白>cqw + align-items: flex-end');
  } else if (!hm) {
    bad('#topBar 没有 height: <留白>cqw', '它就该是那条留白带本身，否则"内容贴带底边"无从谈起');
  } else if (Number(hm[1]) / 100 !== pad) {
    bad('#topBar 的高度与留白带不同源', `#topBar=${Number(hm[1]) / 100} vs #petArea=${pad}`);
  } else if (!/align-items:\s*flex-end/.test(topBar)) {
    bad('#topBar 的内容没有贴底边对齐',
      'align-items: flex-end 才能让气泡底边落在她头顶那条线上；否则带子一高气泡就飘');
  } else if (!/flex-direction:\s*row/.test(topBar)) {
    bad('#topBar 不是横排', '竖排会把徽章高度加进气泡上方 —— 极小档必然落到她身上');
  } else {
    ok(`#topBar = 留白带本身（height ${pad}，内容贴底边）且横排 —— 气泡贴头顶、徽章并列不占高`);
  }
  // 横向让位优先级：气泡钉死不缩（一缩就多折一行、把信息条顶高），徽章可缩。
  const bub = (css.match(/#bubble\s*\{[^}]*\}/) || [''])[0];
  const bdg = (css.match(/#badge\s*\{[^}]*\}/) || [''])[0];
  if (!/flex-shrink:\s*0/.test(bub)) {
    bad('#bubble 没有 flex-shrink: 0', '气泡被压窄会多折一行 → 信息条顶高 → 落到她身上');
  } else if (!/flex-shrink:\s*1/.test(bdg)) {
    bad('#badge 没有 flex-shrink: 1', '横向挤不下时该让位的是徽章，不是气泡');
  } else {
    ok('横排让位优先级：气泡不缩、徽章可缩（坏掉的是徽章而不是她的额头）');
  }
  // 极窄窗口下徽章只留倒计时数字（收掉「专注」）—— 阈值必须落在极小档与小档之间：
  // 落了极小档就白收（余量还是只有 5px），落到小档就多收了一档（小档余量 20px 够用）。
  // 用**档位数值算出来的实际窗宽**判断，而不是把 234 / 291 抄进来 ——
  // 抄进来的话，改档位数值时这条断言会静默失真。
  const cq = css.match(/@container\s*\(max-width:\s*(\d+)px\)\s*\{\s*#badgeName\s*\{[^}]*display:\s*none/);
  const sizesInline = {};
  for (const kv of (mainJs.match(/const SIZES\s*=\s*\{([^}]*)\}/) || [, ''])[1].matchAll(/(\w+)\s*:\s*([\d.]+)/g)) {
    sizesInline[kv[1]] = Number(kv[2]);
  }
  const bw = mainC.BASE_W;
  const tinyW = Math.round(bw * sizesInline.tiny), smallW = Math.round(bw * sizesInline.small);
  if (!cq) {
    bad('没有"极窄窗口下收掉徽章名字"的容器查询',
      '极小档的气泡+徽章只差 5px 就排不下，余量太薄');
  } else {
    const thr = Number(cq[1]);
    if (!(thr >= tinyW && thr < smallW)) {
      bad('收窄徽章的阈值不在极小档与小档之间', `阈值 ${thr}px，极小档 ${tinyW}px、小档 ${smallW}px`);
    } else if (/\[data-scale/.test(cq[0])) {
      bad('收窄徽章用的是档名而不是窗宽', '挤不挤取决于窗宽；按档名判断会在改档位数值时失配');
    } else {
      ok(`极窄窗口（≤ ${thr}px）收掉徽章名字，极小档 ${tinyW}px 命中、小档 ${smallW}px 不命中`);
    }
  }
}

// ---- 验收工具自己也要跟着档位走（v3.6 新增）----
// measure_bubble.py 的 TIERS / FONT_CLAMP 是"量哪些档、撞没撞 clamp"的依据。
// 档名少一个 → 最苛刻的那一档根本没被量过，绿灯是假的。
{
  const tiers = (measPy.match(/^TIERS\s*=\s*\(([^)]*)\)/m) || [, ''])[1]
    .match(/"(\w+)"/g) || [];
  const names = tiers.map((t) => t.replace(/"/g, ''));
  // 就地解析 SIZES 的档名 —— 上面那个 scaleOf()/sMain 在这一段之后才定义（const 有 TDZ），
  // 这里引用会直接抛，所以不图省事。
  const keys = Array.from(
    (mainJs.match(/const SIZES\s*=\s*\{([^}]*)\}/) || [, ''])[1].matchAll(/(\w+)\s*:/g)
  ).map((x) => x[1]);
  if (!names.length) bad('读不到 measure_bubble.py 的 TIERS');
  else if (names.join() !== keys.join()) {
    bad('探针量的档位与 SIZES 不一致', names.join('/') + '  vs  ' + keys.join('/'));
  } else {
    ok(`探针覆盖全部 ${names.length} 档（${names.join('/')}）`);
  }
  // FONT_CLAMP 必须与 pet.css 的 #bubble font-size clamp 一致 ——
  // 不一致的话探针会把"其实没撞上限"报成"撞了上限"（或反过来），解释全错。
  // ⚠ 注意单位写法不同：CSS 里是 `3.35cqw`（百分数），探针里是 0.0335（小数），
  // 比之前要把 css 那个除以 100（第一次就是直接比，报了一条假的不一致）。
  const fc = (measPy.match(/^FONT_CLAMP\s*=\s*\(([^)]*)\)/m) || [, ''])[1].split(',').map((s) => Number(s.trim()));
  const fcss = (stripComments(read('renderer/pet.css') || '').match(/#bubble\s*\{[^}]*font-size:\s*clamp\(([\d.]+)px,\s*([\d.]+)cqw,\s*([\d.]+)px\)/) || []).slice(1).map(Number);
  if (fcss.length === 3) fcss[1] /= 100;
  if (fc.length !== 3 || fcss.length !== 3 || fc.some((v, i) => v !== fcss[i])) {
    bad('探针的字号 clamp 与 pet.css 不一致', `探针=${fc.join('/')}  css=${fcss.join('/')}`);
  } else {
    ok(`探针的字号 clamp 与 pet.css 一致（${fc[0]}px / ${fc[1]}cqw / ${fc[2]}px）`);
  }
}

// ---- 窗口必须比角色高：留白是"气泡不压头顶"的物理前提 ----
// 谁把留白去掉（BASE_H 又等于 PET_H），气泡就退回压在她头发上 —— 这条盯着它。
{
  const petH = mainC.PET_H, baseH = dims['main.js'].H;
  if (petH === null) {
    bad('main.js 里找不到 PET_H（角色显示高度）');
  } else if (baseH === null) {
    bad('main.js 里找不到 BASE_H（窗口高）');
  } else if (!(baseH > petH)) {
    bad('窗口高没有大于角色高', `BASE_H=${baseH} PET_H=${petH} —— 顶部就没有放气泡的留白了`);
  } else {
    ok(`窗口比角色高 ${baseH - petH}px（= 顶部气泡留白）`);
  }
}
// SIZES 缩放档表必须两边一致：真机按 main.js 的档位改窗口，浏览器预览按
// preview.html 的档位改舞台。不一致的话，"缩放"这一项的验收就是自欺欺人。
const scaleOf = (text) => {
  const m = text.match(/const SIZES\s*=\s*\{([^}]*)\}/);
  if (!m) return null;
  const o = {};
  for (const kv of m[1].matchAll(/(\w+)\s*:\s*([\d.]+)/g)) o[kv[1]] = Number(kv[2]);
  return o;
};
const sMain = scaleOf(mainJs), sPrev = scaleOf(prevHtml);
if (!sMain || !sPrev) {
  bad('SIZES 缩放档表找不到', `main=${!!sMain} preview=${!!sPrev}`);
} else {
  const kMain = Object.keys(sMain), kPrev = Object.keys(sPrev);
  const diff = kMain.filter((k) => sMain[k] !== sPrev[k]);
  // v3.6：比对从"同名档数值相等"升级成三件事 —— **档数 / 顺序 / 数值**。
  // 只比值是不够的：滚轮按"当前档的下标 ±1"算下一档，两边顺序不同就会跳档
  // （表现是"从大档滚一下直接飞到极小档"，而每一处单看都是对的）。
  if (kMain.length !== kPrev.length) {
    bad(`缩放档数不一致: main ${kMain.length} 档 / preview ${kPrev.length} 档`,
      kMain.join('/') + '  vs  ' + kPrev.join('/'));
  } else if (kMain.join() !== kPrev.join()) {
    bad('缩放档顺序不一致', kMain.join('/') + '  vs  ' + kPrev.join('/') +
      ' —— 滚轮靠下标 ±1 找下一档，顺序不同会跳档');
  } else if (diff.length) {
    bad('缩放档表不一致: ' + diff.join(', '), JSON.stringify(sMain) + ' vs ' + JSON.stringify(sPrev));
  } else {
    ok(kMain.length + ' 档缩放两边一致: ' + kMain.join('/'));
  }
  // 单调递增。滚轮把"下标 +1"当成"变大"，档表不单调的话手感会来回乱跳。
  const vals = kMain.map((k) => sMain[k]);
  if (vals.some((v, i) => i > 0 && v <= vals[i - 1])) bad('缩放档不是单调递增', vals.join(' / '));
  else ok('缩放档单调递增: ' + vals.join(' < '));
  // 基准档必须恰好是 1 —— 窗口尺寸、素材取景、气泡的字号全部以它为基准，
  // 它一旦不是 1，"medium 档的窗口是多大"就没人知道了。
  if (sMain.medium === 1) ok('基准档 medium = 1');
  else bad('medium 不是 1', 'medium=' + sMain.medium + '：所有窗口尺寸都以它为基准');

  // 三处顺序必须一致：main.js 的 SIZES、main.js 的 SCALE_LABELS（菜单）、
  // pet.js 的 SIZE_ORDER（滚轮）。少比任何一处，"滚轮跳档"就只会出现在真机上。
  const labelsOrder = (() => {
    const m = mainJs.match(/const SCALE_LABELS\s*=\s*\[([\s\S]*?)\];/);
    if (!m) return null;
    return Array.from(m[1].matchAll(/'(\w+)'/g)).map((x) => x[1]);
  })();
  const orderInPet = (petJs.match(/const SIZE_ORDER\s*=\s*\[([^\]]*)\]/) || [, ''])[1]
    .split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  if (!labelsOrder) {
    bad('读不到 SCALE_LABELS', '右键菜单的档位表没法和 SIZES 比对');
  } else if (labelsOrder.join() !== kMain.join()) {
    bad('SCALE_LABELS 顺序与 SIZES 不一致', labelsOrder.join('/') + '  vs  ' + kMain.join('/'));
  } else if (orderInPet.join() !== kMain.join()) {
    bad('pet.js 的 SIZE_ORDER 与 SIZES 不一致',
      orderInPet.join('/') + '  vs  ' + kMain.join('/') + ' —— 滚轮会按错误的下标找下一档');
  } else {
    ok('档位顺序三处一致（SIZES / SCALE_LABELS / SIZE_ORDER）');
  }
}

// ---------- 2b. 素材宽高比上限 ----------
// .frame 是 height:100% + width:auto，也就是"按高度锚定、宽度由素材比例决定"。
// 好处是四套装扮的显示高度一律等于**角色区**高度（换装时不会一大一小），
// 代价是素材比例太宽时两侧发梢会被窗口裁掉 —— 这一节就是那个代价的守门人。
//
// v3.4 起这里判的是**宽高比**，不再是绝对宽度。
// 原来是 `PET_MAX_SPRITE_W = BASE_W * RENDER_H / PET_H`，把结论写成了绝对像素，
// 隐含前提是"所有素材都恰好 560 高"。素材重制改成「用满源、不放大」之后
// （输出高 = min(800, 源可用高) = 800/800/762/790），那个前提就不成立了。
// 而约束的本意跟高矮无关：
//     显示宽 = 素材宽 × (PET_H / 素材高) ≤ BASE_W  ⇒  素材宽/素材高 ≤ BASE_W/PET_H
// 判比值同时更严格（任何高度下都成立）也更不脆（换素材不用改这个数）。
section('[2b] 素材宽高比上限');
const baseW = mainC.BASE_W, petH = mainC.PET_H;
// 定义式也钉住：有人改了 BASE_W / PET_H 却忘了同步这个比值时，这条会立刻响。
// ★ 必须用 PET_H（角色显示高度），不能用 BASE_H（窗口高）：
//   素材撑满的是角色区，窗口顶部那条留白里没有素材 ——
//   拿 469 当分母，比值会缩到 0.86，宽一点的装扮会被误判成"超出上限"。
const hasAspect = /PET_MAX_ASPECT\s*=\s*BASE_W\s*\/\s*PET_H\s*;/.test(stripComments(mainJs));
if (baseW === null || petH === null) {
  bad('BASE_W / PET_H 定义不全');
} else if (!hasAspect) {
  bad('PET_MAX_ASPECT 的定义式被改过',
    '它必须是 BASE_W / PET_H；改错的话素材宽高比上限会悄悄失效（发梢被窗口裁掉）');
} else {
  ok(`PET_MAX_ASPECT = ${baseW} / ${petH} = ${(baseW / petH).toFixed(4)}`);
}
const maxAspect = baseW && petH ? baseW / petH : null;
// 旧常量不该再出现 —— 留着会让人以为宽度是绝对像素卡死的
if (/PET_MAX_SPRITE_W/.test(stripComments(mainJs))) {
  bad('main.js 里还有 PET_MAX_SPRITE_W',
    'v3.4 起素材高不再统一，绝对宽度上限已失效，必须改为 PET_MAX_ASPECT');
} else {
  ok('绝对宽度上限（PET_MAX_SPRITE_W）已移除，不会与新素材打架');
}

// ---------- 2b-2. 实际素材必须塞得进窗口 ----------
// 上面那条只守住了"上限公式没被改"，守不住"素材本身变胖了"。
// 素材是 build_assets.py 生成的，重新抠一张图就可能胖出几十像素 ——
// 那时两侧发梢会被窗口默默裁掉，截图里不一定看得出来。
if (maxAspect) {
  for (const k of ['maid', 'sailor', 'coat', 'winter']) {
    const s = pngSize(`assets/sprites/${k}.png`);
    if (!s) continue;                       // 缺文件由 [6] 报
    const asp = s.w / s.h;
    if (asp > maxAspect + 1e-9) {
      bad(`${k}.png 宽高比 ${asp.toFixed(4)} > 上限 ${maxAspect.toFixed(4)}`,
        `显示时会被窗口裁掉两侧；要么把 BASE_W 调大，要么重新裁素材`);
    } else {
      const dispW = Math.round(s.w * (petH / s.h));
      ok(`${k}.png ${s.w}x${s.h} -> 窗口内显示 ${dispW}x${petH}（宽高比 ${asp.toFixed(3)} ≤ ${maxAspect.toFixed(3)}）`);
    }
  }
}

// ---------- 2c. 默认素材流程不得经过模型 ----------
// 这条是项目约定的守门人：**能不用模型就不用模型**。
// 模型只在"连通性都分不出背景"时才值得上，而且它失败起来是静默的
// （上一版把 isnet-anime 当默认路径，结果水手服贝雷帽外留了一圈灰雾都没人发现）。
// 纯 Python 那条路（边界估背景色 + 4-连通 + 反预乘）已经证明够用，
// 所以 build_assets.py 里一旦出现 anime_cut / isnet 就该报警。
section('[2c] 默认流程不依赖模型');
const buildPy = read('tools/build_assets.py') || '';
const cutRuns = [...buildPy.matchAll(/run\(\[PY,\s*"([^"]+)"/g)].map((m) => m[1]);
console.log('  build_assets.py 调用的工具:', cutRuns.join(', ') || '(一个都没有？)');
// 只扫**可执行代码**：剔除三引号 docstring 和 # 注释 ——
// 文件里恰恰要解释"为什么弃用 anime_cut"，不排掉会自己撞自己。
const buildCode = buildPy
  .replace(/"""[\s\S]*?"""/g, '')
  .split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
if (/anime_cut|isnet/i.test(buildCode)) {
  bad('build_assets.py 的代码里还在调用模型的抠图路线',
    '默认流程应当只用 tools/cut.py；模型路线要保留就放到显式的 --model 开关后面');
} else ok('默认流程只用纯 Python 的 tools/cut.py');

// ---------- 3. IPC 通道对齐 ----------
section('[3] IPC 通道对齐');
const preloadJs = read('preload.js') || '';
const mainHandled = new Set([
  ...[...mainJs.matchAll(/ipcMain\.(?:handle|on)\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
]);
const mainSent = new Set([
  ...[...mainJs.matchAll(/\.webContents\.send\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
  ...[...mainJs.matchAll(/send\(\s*['"]([^'"]+)['"]\s*,/g)].map((m) => m[1]),
]);
const preloadInvoked = [...preloadJs.matchAll(/ipcRenderer\.(?:invoke|send|on)\(\s*['"]([^'"]+)['"]/g)]
  .map((m) => ({ ch: m[1], kind: m[0].includes('on(') ? 'on' : 'invoke' }));

for (const { ch, kind } of preloadInvoked) {
  if (kind === 'on') {
    if (mainSent.has(ch)) ok(`主进程 -> 渲染层: ${ch}`);
    else bad(`preload 监听了 '${ch}'，但 main.js 从没发过它`);
  } else if (mainHandled.has(ch)) ok(`渲染层 -> 主进程: ${ch}`);
  else bad(`preload 调用了 '${ch}'，但 main.js 没有对应的 ipcMain.handle`);
}

// ---------- 4. pet.js 引用的 DOM id 必须存在于 index.html ----------
section('[4] pet.js 引用的 DOM 节点');
const indexHtml = read('renderer/index.html') || '';
const idsInHtml = new Set([...indexHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
// $('#x') / querySelector('#x')
const idsUsed = new Set([
  ...[...petJs.matchAll(/\$\(\s*'#([A-Za-z0-9_-]+)'\s*\)/g)].map((m) => m[1]),
  ...[...petJs.matchAll(/querySelector\(\s*'#([A-Za-z0-9_-]+)'\s*\)/g)].map((m) => m[1]),
]);
for (const id of [...idsUsed].sort()) {
  if (idsInHtml.has(id)) ok('#' + id);
  else bad('pet.js 要用的 #' + id + ' 不在 renderer/index.html 里', '会在启动时抛 TypeError，桌宠直接不出现');
}

// ---------- 4b. 顶部信息条：徽章与气泡必须横排 ----------
// 曾经的 bug：两者都锚在窗口正中的同一条线上（各自 position:absolute + top:6~8px），
// 于是番茄钟跑着的时候她一说台词，徽章和气泡就叠成一团。
// 现在它们横排进 #topBar，谁也不占谁的高度。
section('[4b] 顶部信息条（徽章 + 气泡）');
const petCss = read('renderer/pet.css') || '';

for (const [label, html] of [['renderer/index.html', indexHtml],
                             ['renderer/preview.html', prevHtml]]) {
  const i = html.indexOf('id="topBar"');
  if (i < 0) {
    bad(`${label} 里没有 #topBar`, '徽章与气泡会各自绝对定位、互相压住');
    continue;
  }
  const j = html.indexOf('id="panel"', i);
  const seg = html.slice(i, j > 0 ? j : undefined);
  const miss = ['badge', 'bubble'].filter((k) => !seg.includes(`id="${k}"`));
  if (miss.length) bad(`${label} 的 #topBar 里缺 #${miss.join(' / #')}`, '气泡和徽章会再度叠在同一条线上');
  else ok(`${label} 的 #topBar 装着 #badge 与 #bubble`);
}

const bubbleRule = (petCss.match(/#bubble\s*\{([^}]*)\}/) || [, ''])[1];
if (/position\s*:\s*absolute/.test(bubbleRule)) {
  bad('pet.css 的 #bubble 又变成 position:absolute 了',
    '这正是"徽章压气泡"的成因，应该交给 #topBar 排布');
} else ok('#bubble 不再绝对定位（由 #topBar 排布）');

const stageRule = (petCss.match(/#stage\s*\{([^}]*)\}/) || [, ''])[1];
if (/container-type\s*:\s*inline-size/.test(stageRule)) {
  ok('#stage 声明了 container-type: inline-size');
} else {
  bad('#stage 缺 container-type: inline-size',
    '气泡的 cqw 尺寸会失去参照物，五种缩放下会失配');
}

// v3.6：五档之后光靠一个 cqw 不够了 —— 最小档（0.58，窗口 234 宽）下
// 3.35cqw 只有 7.8px，读不了；最大档（1.58，638 宽）下是 21px，大得离谱。
// 所以允许（并推荐）写成 clamp(下限px, cqw, 上限px)。要求还是同一条：
// **中值必须随窗口走**，全写死 px 就退回"缩放时排版失配"。
if (/font-size\s*:\s*clamp\(\s*[\d.]+px\s*,\s*[\d.]+cqw\s*,\s*[\d.]+px\s*\)/.test(bubbleRule)) {
  ok('#bubble 字号用 clamp(px, cqw, px)（随窗口缩放，两端收住）');
} else if (/font-size\s*:\s*[\d.]+cqw/.test(bubbleRule)) {
  ok('#bubble 字号用 cqw（随窗口等比缩放）');
} else {
  bad('#bubble 的字号既不是 cqw 也不是 clamp(px, cqw, px)',
    '写死 px 的话，小档气泡会占掉窗口约四分之一的高度；纯 cqw 的话最小档只有 7.8px 读不了');
}

if (/backdrop-filter/.test(bubbleRule) && /@supports not\s*\(/.test(petCss)) {
  ok('#bubble 磨砂玻璃 + 无模糊时的兜底都在');
} else {
  bad('#bubble 缺磨砂玻璃或它的 @supports 兜底',
    '兜底是"backdrop-filter 失效时自动加实白底"，少了它气泡会在部分环境里看不清字');
}

// ---------- 4c. 窗口分层：窗口 ≠ 角色 ----------
// v3.2.3 起窗口比角色高一条（顶部留白给气泡），这个分层靠三层 DOM 撑着：
//   #stage（= 窗口，cqw 容器）> #petArea（= 角色区，窗口高 − 22cqw）> #petWrap > .frame
// 这几条都是"挪走/删掉之后不报错、只是画面悄悄变错"的东西，所以要显式盯着。
section('[4c] 窗口分层（窗口 ≠ 角色）');
for (const [label, html] of [['renderer/index.html', indexHtml],
                             ['renderer/preview.html', prevHtml]]) {
  const a = html.indexOf('id="petArea"');
  const w = html.indexOf('id="petWrap"');
  const st = html.indexOf('id="stage"');
  const tb = html.indexOf('id="topBar"');
  const e = html.indexOf('id="emote"');
  const p = html.indexOf('id="particles"');

  if (a < 0) {
    bad(`${label} 里没有 #petArea`, '角色就没有"只占窗口底部"的那层，气泡会又压回头顶');
  } else if (w < a) {
    bad(`${label} 里 #petWrap 不在 #petArea 内`, '层级反了，角色会撑满整个窗口');
  } else ok(`${label}：#petArea 包着 #petWrap`);

  // #topBar 的尺寸全用 cqw，需要 #stage 这个容器做参照
  if (st >= 0 && tb > st) ok(`${label}：#topBar 在 #stage 内（cqw 有容器参照）`);
  else bad(`${label} 的 #topBar 不在 #stage 内`,
    'cqw 会退化成视口单位 —— 真机上数值恰好相同，但那是巧合不是契约');

  // 漂浮表情 / 粒子的 top 是百分比，基准必须是**角色**高度
  if (a >= 0 && e > a && p > a) ok(`${label}：漂浮表情与粒子在 #petArea 内（基准 = 角色高）`);
  else bad(`${label} 的漂浮表情 / 粒子不在 #petArea 内`,
    '它们按角色高度取百分比；挂回 #stage 下会以窗口高为基准，窗口一加高就整体下移');
}

const areaRule = (petCss.match(/#petArea\s*\{([^}]*)\}/) || [, ''])[1];
if (/height\s*:\s*calc\(\s*100%\s*-\s*[\d.]+cqw\s*\)/.test(areaRule)) {
  ok('#petArea 高度 = calc(100% − 留白)（cqw，五档等比）');
} else {
  bad('#petArea 的高度算式被改过',
    '必须是 calc(100% - <留白>cqw)：写死 px 的话五档缩放下角色大小会失配');
}

// ---------- 5. 台词键 ----------
section('[5] 台词键');
const dialogueJs = read('renderer/dialogue.js') || '';
const quoteKeys = new Set([...dialogueJs.matchAll(/^\s{2}([A-Za-z_]\w*)\s*:/gm)].map((m) => m[1]));
const quoteUsed = new Set([...petJs.matchAll(/QUOTES\.([A-Za-z_]\w*)/g)].map((m) => m[1]));
for (const k of [...quoteUsed].sort()) {
  if (quoteKeys.has(k)) ok('QUOTES.' + k);
  else bad('pet.js 用到了 QUOTES.' + k + '，但 dialogue.js 里没有');
}

// ---------- 5b. 服装表必须四边对齐 ----------
// 服装是"改一处忘一处"的重灾区：
//   菜单里加了、pet.js 里没加 -> 点了没反应
//   OUTFIT_SINK 漏了 -> 那套装扮会沉进任务栏（或浮在半空）
//   台词键漏了 -> 换过去气泡一片空白
//   素材没生成 -> 白屏
section('[5b] 服装表一致性');
const menuKeys = [...((mainJs.match(/const OUTFITS\s*=\s*\[([\s\S]*?)\];/) || [, ''])[1])
  .matchAll(/\['([a-z0-9_]+)'/g)].map((m) => m[1]);
const sinkKeys = [...((mainJs.match(/const OUTFIT_SINK\s*=\s*\{([^}]*)\}/) || [, ''])[1])
  .matchAll(/([a-z0-9_]+)\s*:/g)].map((m) => m[1]);
const petKeys = [...((petJs.match(/const OUTFITS\s*=\s*\{([\s\S]*?)\n\};/) || [, ''])[1])
  .matchAll(/^\s{2}([a-z0-9_]+)\s*:/gm)].map((m) => m[1]);
const outfitKeys = [...((dialogueJs.match(/outfit:\s*\{([\s\S]*?)\n\s{2}\}/) || [, ''])[1])
  .matchAll(/([a-z0-9_]+)\s*:\s*\[/g)].map((m) => m[1]);
console.log('  main 菜单 :', menuKeys.join(', ') || '(空)');
console.log('  sink 表   :', sinkKeys.join(', ') || '(空)');
console.log('  pet.js    :', petKeys.join(', ') || '(空)');
console.log('  dialogue  :', outfitKeys.join(', ') || '(空)');
for (const k of menuKeys) {
  const miss = [];
  if (!petKeys.includes(k)) miss.push('pet.js 的 OUTFITS');
  if (!sinkKeys.includes(k)) miss.push('main.js 的 OUTFIT_SINK');
  if (!outfitKeys.includes(k)) miss.push('dialogue.js 的 outfit 台词');
  if (!exists(`assets/sprites/${k}.png`)) miss.push(`assets/sprites/${k}.png`);
  if (miss.length) bad(`服装 '${k}' 缺: ` + miss.join(' / '));
  else ok(`服装 '${k}' 四边齐备`);
}
for (const k of petKeys) if (!menuKeys.includes(k)) bad(`pet.js 有 '${k}' 但右键菜单里没有`);

// ---------- 6. 素材 ----------
section('[6] 素材');
// 素材高**不再统一**（v3.4）：各套的源分辨率差得远，重制规则是「用满源、不放大」，
// 输出高 = min(OUT_CAP, 源可用高) = 800 / 800 / 762 / 790。
// 所以这里改成守**上下界**：
//   上界 = build_assets.py 的 OUT_CAP（= 2× HiDPI 屏 + 中档缩放的设备像素高）
//   下界 = 四套里最紧的源上限（冬大衣 762）再留一点余量
// 下界这条是**防回退**用的：如果有人拿旧流水线（--target 560）重新生成素材，
// 高会掉回 560，这条立刻响 —— 而画面上只是"糊了一点"，肉眼基本看不出来。
const OUT_CAP = Number((buildPy.match(/^OUT_CAP\s*=\s*(\d+)/m) || [])[1]) || null;
const SPRITE_H_MIN = 760;
const SPRITES = ['maid', 'sailor', 'coat', 'winter'];
function pngSize(p) {
  const b = fs.readFileSync(R(p));
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
if (!OUT_CAP) {
  bad('读不到 build_assets.py 的 OUT_CAP', '素材高的上界就没法跟生成脚本对齐了');
} else if (OUT_CAP !== 800) {
  bad(`OUT_CAP = ${OUT_CAP}，期望 800`,
    '它是"2× HiDPI 屏 + 中档缩放"的设备像素高（400 CSS px × 2）；改它要先想清楚换的是哪块屏幕');
} else {
  ok(`OUT_CAP = ${OUT_CAP}（2× HiDPI 屏 × 中档缩放 = 400 × 2）`);
}
const realSprite = {};
for (const f of SPRITES) {
  const s = pngSize(`assets/sprites/${f}.png`);
  realSprite[f] = s;
  if (!s) { bad(`assets/sprites/${f}.png 不是合法 PNG`); continue; }
  if (s.h > OUT_CAP) {
    bad(`${f}.png 高 ${s.h} 超过 OUT_CAP ${OUT_CAP}`, '超出部分在显示时用不上，只是白占体积');
  } else if (s.h < SPRITE_H_MIN) {
    bad(`${f}.png 高 ${s.h} < 下界 ${SPRITE_H_MIN}`,
      '像是用旧流水线（--target 560）生成的 —— 重制成果被退回了，而画面上只是"糊一点"，看不出来');
  } else ok(`${f}.png  ${s.w}x${s.h}  (宽高比 ${(s.w / s.h).toFixed(3)})`);
}
// preview.html 里硬编码的那张素材尺寸表必须和真实 PNG 一致。
// 它参与 padX（横向夹取）的计算，过期了会让浏览器验收和真机对不上。
const prevSprites = (prevHtml.match(/const SPRITE\s*=\s*\{([^}]*)\}/) || [, ''])[1];
const prevPairs = {};
for (const m of prevSprites.matchAll(/(\w+)\s*:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/g)) {
  prevPairs[m[1]] = [Number(m[2]), Number(m[3])];
}
for (const f of SPRITES) {
  const a = realSprite[f], b = prevPairs[f];
  if (!a) continue;
  if (!b) bad(`preview.html 的 SPRITE 表缺 '${f}'`);
  else if (b[0] !== a.w || b[1] !== a.h) {
    bad(`preview.html 的 SPRITE['${f}'] = ${b}，真实是 [${a.w},${a.h}]`,
      '它参与 padX（贴边）计算，过期会让浏览器验收与真机不一致');
  } else ok(`preview SPRITE['${f}'] 与真实一致`);
}
// 已废弃的差分帧不该再出现在素材目录里，否则以后有人会以为它们还在用
for (const stale of ['maid_blink.png', 'maid_happy.png']) {
  if (exists('assets/sprites/' + stale)) {
    bad('assets/sprites/' + stale + ' 还在', '眨眼/笑眼差分已废弃，见 tools/abandoned/README.md');
  } else ok('assets/sprites/' + stale + ' 已清除');
}

// ---------- 7. CSP 与内联脚本 ----------
section('[7] CSP 与内联脚本');
for (const f of ['renderer/index.html', 'renderer/stats.html']) {
  const html = read(f);
  if (html === null) continue;
  const csp = html.match(/Content-Security-Policy["'][^>]*content="([^"]*)"/i);
  if (!csp) { ok(f + ' 无 CSP（不推荐，但不算错）'); continue; }
  const policy = csp[1];
  const scriptSrc = (policy.match(/script-src([^;]*)/) || [, ''])[1];
  const allowsInline = /unsafe-inline/.test(scriptSrc);
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .filter((m) => m[1].trim().length > 0);
  if (inline.length && !allowsInline) {
    bad(`${f} 的 CSP 是 script-src${scriptSrc}，却有 ${inline.length} 段内联脚本`,
      '浏览器会静默拒绝执行这些脚本，页面看着正常但什么都不工作');
  } else {
    ok(`${f} CSP 与脚本形式匹配`);
  }
}

// ---------- 8. 统计页必须有 .hidden 规则 ----------
section('[8] 统计页空状态');
const statsHtml = read('renderer/stats.html') || '';
const statsJs = read('renderer/stats.js') || '';
if (/classList\.toggle\(\s*'hidden'/.test(statsJs) || /classList\.add\('hidden'/.test(statsJs)) {
  if (/\.hidden\s*\{[^}]*display\s*:\s*none/.test(statsHtml)) ok('stats.html 定义了 .hidden');
  else bad('stats.js 在切 hidden 类，但 stats.html 没有 .hidden 样式',
    '有数据时"还没有记录"的空提示不会消失');
} else {
  ok('stats.js 未使用 hidden 切换');
}

// ---------- 9. 打包配置 ----------
section('[9] 打包配置');
const pkg = JSON.parse(read('package.json') || '{}');
if (pkg.main && exists(pkg.main)) ok('main = ' + pkg.main);
else bad('package.json 的 main 指向不存在的文件: ' + pkg.main);
const files = (pkg.build && pkg.build.files) || [];
for (const need of ['renderer/**/*', 'assets/**/*', 'preload.js', 'main.js', 'clamp.js']) {
  if (files.includes(need)) ok('build.files 含 ' + need);
  else bad('build.files 缺少 ' + need, '打包后运行时会缺文件');
}
const icon = pkg.build && pkg.build.win && pkg.build.win.icon;
if (icon && exists(icon)) ok('win.icon = ' + icon);
else bad('package.json 的 win.icon 指向不存在的文件: ' + icon, 'electron-builder 会直接打包失败');

// ---------- 10. 隐私：本机路径 / 令牌 / 用户名不许进仓库 ----------
// 与 tools/scan_secrets.py 同一套判定思路，但零依赖、纯 node 实现，
// 这样 `npm run selftest` 单独也能拦住；Python 版是发布流水线里的那道闸门。
// 私密词同样在运行时推导，不写死在源码里 —— 否则这份自检本身就成了泄露源。
section('[10] 隐私：本机路径 / 令牌 / 用户名不许进仓库');

const os = require('os');
// 这里只列**非下划线开头**的目录（第三方 / 构建产物）。下划线开头的
// （`_work` / `_review` / `_layerwork` …）由遍历处那条前缀规则统一跳过 ——
// 与 `.gitignore` 的 `_*/` 同一约定，理由见 walkForScan 里的说明。
const SCAN_SKIP = new Set(['node_modules', 'dist', 'models', '_work', '_review',
  '.git', '__pycache__', '.vscode', '.idea', '.mypy_cache']);
const SCAN_SKIP_EXT = new Set(['.png', '.ico', '.jpg', '.jpeg', '.webp', '.gif',
  '.bmp', '.onnx', '.exe', '.dll', '.zip', '.7z', '.ttf', '.ttc', '.woff',
  '.woff2', '.mp4', '.pdf', '.xlsx', '.sqlite', '.bin', '.node', '.wav']);

// 允许公开的通用系统路径：标准安装位置，不含任何使用者标识。
// ★ 这份列表必须与 tools/scan_secrets.py 的 SAFE_PATH_PREFIXES 完全一致 ★
// 两处规则一旦漂移，「一边拦一边放」就会静默出现 —— 下面有断言强制比对。
const SAFE_PATHS = ['c:\\windows', 'c:\\program files',
  'c:\\program files (x86)', 'c:\\programdata', 'c:\\$recycle.bin'];
const normPath = (s) => s.replace(/\\\\/g, '\\').replace(/\\/g, '/').toLowerCase();
const SAFE_NORM = SAFE_PATHS.map(normPath);
function isSafePath(seg) {
  const s = normPath(seg);
  return SAFE_NORM.some((p) => {
    if (s === p) return true;
    if (!s.startsWith(p)) return false;
    // 前缀必须落在完整目录段边界上，否则把白名单目录名延长几个字母也算通过
    return !/[A-Za-z0-9._-]/.test(s.charAt(p.length));
  });
}

const GENERIC_RULES = [
  ['GitHub classic PAT', /ghp_[A-Za-z0-9]{16,}/],
  ['GitHub 细粒度 PAT', /github_pat_[A-Za-z0-9_]{20,}/],
  ['GitHub OAuth/App 令牌', /gh[ousr]_[A-Za-z0-9]{20,}/],
  ['OpenAI 风格密钥', /sk-[A-Za-z0-9][A-Za-z0-9\-_]{19,}/],
  ['AWS Access Key ID', /AKIA[0-9A-Z]{16}/],
  ['Google API Key', /AIza[0-9A-Za-z\-_]{35}/],
  ['Slack 令牌', /xox[baprs]-[0-9A-Za-z\-]{10,}/],
  ['npm 令牌', /npm_[A-Za-z0-9]{36}/],
  ['私钥文件头', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['赋值式密钥字面量',
    /(?:api[_-]?key|secret|passwd|password|access[_-]?token|auth[_-]?token)\s*[:=]\s*["'][A-Za-z0-9._\-]{16,}["']/i],
];
const DRIVE_PATH = /(?<![A-Za-z0-9_])([A-Za-z]):([\\/])([^\s"'`)\]}>,;|]*)/g;
const USERS_PATH = /[\\/]Users[\\/][^\s"'`)\]}>,;|]+/g;

const privateTerms = new Map();
function addTerm(t, why) {
  t = (t || '').trim();
  if (t.length < 3) return;
  if (/^[\d._+-]+$/.test(t) && t.length < 4) return;
  if (!privateTerms.has(t)) privateTerms.set(t, why);
}
// 纯字母数字的词（典型是全数字的用户名）必须落在词边界上才算命中：
// 否则 package-lock.json 里几百 KB 的 base64 完整性哈希会疯狂误报。
function termHit(low, term) {
  const lt = term.toLowerCase();
  if (!/^[a-z0-9]+$/.test(lt)) return low.includes(lt);
  let i = low.indexOf(lt);
  while (i !== -1) {
    const before = low.charAt(i - 1), after = low.charAt(i + lt.length);
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    i = low.indexOf(lt, i + 1);
  }
  return false;
}
addTerm(process.env.USERNAME, 'env USERNAME');
addTerm(process.env.USER, 'env USER');
let homeDir = '';
try { homeDir = os.homedir(); } catch (e) { /* 忽略 */ }
if (homeDir) {
  addTerm(path.basename(homeDir), '家目录末段');
  if (homeDir.length >= 6) {
    addTerm(homeDir, '家目录路径');
    addTerm(homeDir.replace(/\\/g, '/'), '家目录路径(/)');
  }
}
// 推导不出来的个人词（本机目录名等）放在 _work/ 下，该目录不入库
const denyPath = path.join(ROOT, '_work', 'privacy-denylist.txt');
if (fs.existsSync(denyPath)) {
  let denyText = '';
  try { denyText = fs.readFileSync(denyPath, 'utf8'); } catch (e) { /* 忽略 */ }
  for (const raw of denyText.split(/\r?\n/)) {
    const w = raw.split('#')[0].trim();
    if (w) addTerm(w, '黑名单');
  }
}

function walkForScan(dir, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      // ★ 判断条件必须是「前缀规则」而不是「名单」：
      //   `.gitignore` 里已经约定 `_*/` —— 凡是下划线开头的目录都只属于本机
      //   （临时备份 / 试验台 / 探针存档 / 素材中间产物），不进仓库、也就没有扫的必要。
      //   原先这里逐个列举（只有 `_work` / `_review`），v3.9 新建的 `_layerwork/`
      //   （素材中间产物，179MB）没被列上 —— 它内部日志里的一行本机绝对路径
      //   直接把这条闸门顶红。**"把它补进名单"不是修法**：那只是等下一次
      //   新建目录再漏一次（`_v38_backup/` 已经这么漏过一回了）。
      //   约定写成规则，就不用靠记性 —— 这条理由与 `.gitignore` 里那句完全一样。
      if (!SCAN_SKIP.has(e.name) && !e.name.startsWith('_')) {
        walkForScan(path.join(dir, e.name), out);
      }
    } else if (!SCAN_SKIP_EXT.has(path.extname(e.name).toLowerCase())) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const scannedFiles = walkForScan(ROOT, []);
const privacyHits = [];
for (const abs of scannedFiles) {
  let text = '';
  try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { continue; }
  if (text.includes('\u0000')) continue;
  const rel = path.relative(ROOT, abs);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('scan:ignore')) continue;
    for (const [name, rx] of GENERIC_RULES) {
      // 这些正则是非全局的，test() 不会有 lastIndex 残留问题
      if (rx.test(line)) privacyHits.push(`${rel}:${i + 1}  ${name}`);
    }
    for (const m of line.matchAll(DRIVE_PATH)) {
      if (isSafePath(line.slice(m.index))) continue;
      privacyHits.push(`${rel}:${i + 1}  本机绝对路径  ${m[0].slice(0, 48)}`);
    }
    for (const m of line.matchAll(USERS_PATH)) {
      // 家目录盘符路径已由 DRIVE_PATH 处理；这里只认盘符之外的写法
      if (m[0].toLowerCase().startsWith('\\users') && line.toUpperCase().includes('C:')) continue;
      privacyHits.push(`${rel}:${i + 1}  用户目录路径  ${m[0].slice(0, 48)}`);
    }
    const low = line.toLowerCase();
    for (const [t, why] of privateTerms) {
      if (termHit(low, t)) privacyHits.push(`${rel}:${i + 1}  私密词(${why})`);
    }
  }
}

if (exists('tools/scan_secrets.py')) ok('tools/scan_secrets.py 存在（发布闸门）');
else bad('缺少 tools/scan_secrets.py', '发布流水线靠它拦本机路径与令牌，不能丢');

const gi = read('.gitignore') || '';
for (const need of ['_work/', '.env', 'node_modules/']) {
  if (gi.includes(need)) ok('.gitignore 排除 ' + need);
  else bad('.gitignore 缺少 ' + need, '本机黑名单/凭证文件可能被误提交');
}

// 两份实现的白名单必须一致：从 Python 版源码里把 SAFE_PATH_PREFIXES 抠出来比对。
// 规则漂移的后果是「一边拦、一边放」，而且完全静默 —— 所以必须断言。
const pySrc = read('tools/scan_secrets.py') || '';
const pyBlock = (pySrc.match(/SAFE_PATH_PREFIXES\s*=\s*\(([\s\S]*?)\n\)/) || [, ''])[1];
const pySafe = [...pyBlock.matchAll(/r"([^"]*)"/g)].map((m) => normPath(m[1]));
const jsSafe = SAFE_PATHS.map(normPath);
if (pySafe.length === 0) {
  bad('没能从 tools/scan_secrets.py 解析出白名单',
    '两份规则的一致性检查已失效，改扫描器时请同步这里');
} else {
  const onlyPy = pySafe.filter((p) => !jsSafe.includes(p));
  const onlyJs = jsSafe.filter((p) => !pySafe.includes(p));
  if (onlyPy.length || onlyJs.length) {
    bad('隐私白名单两份实现不一致',
      `仅 Python 有: ${onlyPy.join(', ') || '无'}\n` +
      `      仅 JS 有: ${onlyJs.join(', ') || '无'}`);
  } else {
    ok(`隐私白名单两份一致（${pySafe.length} 条）`);
  }
}

// 推送闸门的两条「静默失效」防线 —— 失效时都不会有任何报错，只会悄悄放行。
//   * 只扫工作区：索引里有、工作区已删的文件会被推上去却没人看过（已实测复现过）。
//   * 黑名单文件路径写错：以前是静默跳过，整套个人词规则直接归零。
for (const [needle, why] of [
  ['--from-index', '推送闸门必须按 git 索引扫，否则「索引有 / 工作区已删」可绕过'],
  ['"cat-file"', '从索引取 blob 内容（推送用的就是这份）'],
  ['missing_words', '--words-file 指向不存在的文件必须报错退出，不许静默跳过'],
]) {
  if (pySrc.includes(needle)) ok(`scan_secrets.py 含 ${needle}`);
  else bad(`scan_secrets.py 缺少 ${needle}`, why);
}

if (privacyHits.length === 0) {
  ok(`已扫 ${scannedFiles.length} 个文本文件：无本机路径 / 令牌 / 用户名 / 私密词`);
} else {
  const uniq = [...new Set(privacyHits)].slice(0, 12);
  bad(`发现 ${privacyHits.length} 处不该公开的内容`, uniq.join('\n      ') +
    (privacyHits.length > uniq.length ? `\n      …还有 ${privacyHits.length - uniq.length} 处` : ''));
}

// ★ 上面这条闸门守的是「规则本身有没有漏」—— 这一条专门守它。
//   `_work/` / `_review/` / `_layerwork/` 都是本机中间产物（`.gitignore` 的 `_*/`），
//   它们内部会写本机绝对路径。判据用**行为**（扫描结果里有没有它们），
//   不去搜源码文本：搜文本会被上面这段注释自己命中（v3.9 踩过同款坑）。
for (const local of ['_layerwork', '_work', '_review']) {
  if (!exists(local)) continue;
  const hit = scannedFiles.filter((p) => new RegExp(`[\\\\/]${local}[\\\\/]`).test(p));
  if (hit.length === 0) ok(`本机目录 ${local}/ 不进隐私扫描（按 _ 前缀跳过，与 .gitignore 的 _*/ 一致）`);
  else bad(`${local}/ 被扫进了隐私闸门`,
    `扫到 ${hit.length} 个文件（例如 ${hit[0]}）—— 中间产物里的本机绝对路径会把闸门顶红；` +
    '规则应按 .gitignore 的 `_*/` 整目录跳过，而不是逐个列举目录名');
}

// ---------- 11. 羁绊 / 勿扰 / 音效 ----------
// 这三块都属于"加了新东西就得在好几处同步"，而且**失效时一律不报错**：
//   · 埋了一个动作名、计分表里却没有 -> 那个互动永远不涨分，界面上看不出异常
//   · 加了音效名、wav 却没生成 -> new Audio() 静默 404，那一声就是没有
//   · 加了新 IPC、preview 的替身没跟上 -> 浏览器验收页整页 TypeError，
//     而真机（preload 有实现）完全正常 —— 于是"预览通过"这件事本身失去意义
// 所以逐条盯住。
section('[11] 羁绊 / 勿扰 / 音效');

// ---- 11a. 羁绊档位 ----
const bondLevels = [...mainJs.matchAll(
  /\{\s*lv:\s*(\d+),\s*name:\s*'([^']+)',\s*at:\s*(\d+)\s*\}/g)]
  .map((m) => ({ lv: Number(m[1]), name: m[2], at: Number(m[3]) }));

if (bondLevels.length < 2) {
  bad('解析不出 main.js 的 BOND_LEVELS',
    '档位表没了或格式变了 —— 下面几条关于羁绊的断言会全部失效');
} else {
  if (bondLevels[0].at === 0) ok('羁绊 Lv.1 的阈值是 0（一开始就已经是 Lv.1）');
  else bad('羁绊 Lv.1 的阈值不是 0', '新人一上来就没有等级，第一句"升级台词"会提前触发');

  const asc = bondLevels.every((L, i) => i === 0 || L.at > bondLevels[i - 1].at);
  if (asc) ok(`羁绊阈值严格递增（${bondLevels.map((L) => L.at).join(' < ')}）`);
  else bad('羁绊阈值不是严格递增',
    '会出现"分更高但等级更低"，或者两级之间永远跨不过去');

  const seq = bondLevels.every((L, i) => L.lv === i + 1);
  if (seq) ok(`羁绊等级从 1 连续编到 ${bondLevels.length}`);
  else bad('羁绊等级编号不连续: ' + bondLevels.map((L) => L.lv).join(', '),
    'levelUp / bond 台词是按等级索引的，缺号会取到 undefined -> 气泡空白');
}

// 台词必须覆盖每一级：升级后没话可说 = 气泡里一片空白。
const lvQuoteKeys = [...((dialogueJs.match(/levelUp:\s*\{([\s\S]*?)\n\s{2}\}/) || [, ''])[1])
  .matchAll(/^\s+(\d+)\s*:/gm)].map((m) => Number(m[1]));
const bondQuoteKeys = [...((dialogueJs.match(/bond:\s*\{([\s\S]*?)\n\s{2}\}/) || [, ''])[1])
  .matchAll(/^\s+(\d+)\s*:/gm)].map((m) => Number(m[1]));
for (const [label, keys, what] of [
  ['levelUp', lvQuoteKeys, '升到那一级时她会没话可说（气泡空白）'],
  ['bond', bondQuoteKeys, '那一级解锁不出任何新台词'],
]) {
  const miss = [];
  for (let lv = 2; lv <= bondLevels.length; lv++) if (!keys.includes(lv)) miss.push(lv);
  if (keys.length === 0 && bondLevels.length >= 2) {
    bad(`解析不出 dialogue.js 的 ${label}`);
  } else if (miss.length) {
    bad(`dialogue.js 的 ${label} 缺 Lv.${miss.join(' / Lv.')}`, what);
  } else {
    ok(`dialogue.js 的 ${label} 覆盖 Lv.2–Lv.${bondLevels.length}`);
  }
}

// ---- 11b. 埋点的动作名必须都在计分表里 ----
const gainTable = new Set([...((mainJs.match(/const BOND_GAIN\s*=\s*\{([\s\S]*?)\n\};/) || [, ''])[1])
  .matchAll(/^\s{2}([A-Za-z_]\w*)\s*:/gm)].map((m) => m[1]));
// gain('x') 和 gain(cond ? 'a' : 'b') 两种写法都要抓得到（番茄钟就是后者）
const gained = new Set();
for (const m of petJs.matchAll(/[^\w.]gain\(([^)]*)\)/g)) {
  for (const q of m[1].matchAll(/'([^']+)'/g)) gained.add(q[1]);
}
if (!gainTable.size || !gained.size) {
  bad('解析不出 BOND_GAIN 或 pet.js 的 gain() 埋点', '下面的比对没有意义');
} else {
  for (const a of [...gained].sort()) {
    if (gainTable.has(a)) ok(`埋点 '${a}' 在计分表里`);
    else bad(`pet.js 埋了 gain('${a}')，但 main.js 的 BOND_GAIN 里没有这个动作`,
      '这个互动永远不加分，而且不会有任何报错');
  }
  const unused = [...gainTable].filter((k) => !gained.has(k));
  console.log('  计分表里没被埋点的动作：' + (unused.join(', ') || '无'));
}

// ---- 11c. 音效：代码 / 生成的 wav / 来源清单，三处名字必须完全一致 ----
// v3.4 起音效不再是"合成"的，而是从 CC0 素材库转换来的（tools/prepare_sfx.py）。
// 于是"第三份名单"从 make_sfx.py 的返回值换成了 assets/sfx/sources.json ——
// 它是 prepare_sfx.py 里那张映射表落盘后的样子，同样能做三方比对。
// 另外这份清单还兼着一个作用：**授权凭证**。它记着每个音来自哪个 CC0 包，
// 少了它，"这声音从哪来"就说不清了（角色立绘有版权，音效是 CC0，两者性质不同）。
const sfxRef = [...((petJs.match(/const SFX_SRC\s*=\s*\{([\s\S]*?)\n\};/) || [, ''])[1])
  .matchAll(/:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]).sort();
const sfxFiles = exists('assets/sfx')
  ? fs.readdirSync(R('assets/sfx')).filter((f) => f.endsWith('.wav'))
      .map((f) => f.replace(/\.wav$/, '')).sort()
  : [];
let sfxGen = [];
let sfxManifest = null;
try {
  sfxManifest = JSON.parse(read('assets/sfx/sources.json') || 'null');
  sfxGen = Object.keys((sfxManifest && sfxManifest.sounds) || {}).sort();
} catch (e) {
  bad('assets/sfx/sources.json 解析失败', String(e.message || e));
}

console.log('  pet.js SFX_SRC : ' + (sfxRef.join(', ') || '(空)'));
console.log('  assets/sfx/    : ' + (sfxFiles.join(', ') || '(空)'));
console.log('  sources.json   : ' + (sfxGen.join(', ') || '(空)'));
const sfxAll = [...new Set([].concat(sfxRef, sfxFiles, sfxGen))];
if (!sfxAll.length) {
  bad('三处都没解析出音效名', '下面的比对没有意义');
} else {
  const off = sfxAll.filter((n) =>
    !(sfxRef.includes(n) && sfxFiles.includes(n) && sfxGen.includes(n)));
  if (off.length) {
    bad('音效名在三处对不上: ' + off.join(', '),
      '缺哪个都会让那一声静默不响，或者生成出来的 wav 根本没人用');
  } else ok(`音效名三处一致（${sfxAll.sort().join(', ')}）`);
}

// wav 本身也要合法：不是 RIFF/WAVE 或参数不对时，<audio> 会直接报错但不弹提示。
// 规格由 tools/prepare_sfx.py 决定（单声道 / 16bit / 44100Hz），这里卡住它 ——
// 素材是从 .ogg 转来的，哪天换了个人重新导一遍，很容易悄悄变成 22050 或立体声。
const SFX_RATE = 44100;
const SFX_MAX_KB = 128;      // 44.1kHz 让字节数比原来的 22.05kHz 翻倍，上限随之放宽
let wavBad = 0;
for (const n of sfxFiles) {
  const b = fs.readFileSync(R(`assets/sfx/${n}.wav`));
  const isRiff = b.length > 44 &&
    b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE';
  if (!isRiff) { bad(`assets/sfx/${n}.wav 不是合法 WAV`); wavBad++; continue; }
  const ch = b.readUInt16LE(22), rate = b.readUInt32LE(24), bits = b.readUInt16LE(34);
  if (ch !== 1 || bits !== 16) {
    bad(`assets/sfx/${n}.wav 是 ${ch} 声道 / ${bits}bit`,
      '应当与 tools/prepare_sfx.py 一致（单声道 16bit），否则体积白涨或音质掉一档');
  } else if (rate !== SFX_RATE) {
    bad(`assets/sfx/${n}.wav 采样率是 ${rate}，应为 ${SFX_RATE}`,
      '重采样没跑或跑漏了：素材源是 44.1kHz，降采样会削掉泛音、听起来发闷');
  } else if (b.length > SFX_MAX_KB * 1024) {
    bad(`assets/sfx/${n}.wav 有 ${(b.length / 1024).toFixed(0)}KB`,
      `提示音超过 ${SFX_MAX_KB}KB 基本就是采样率/时长写错了（提示音必须短、必须能被忽略）`);
  } else {
    ok(`assets/sfx/${n}.wav  ${(b.length / 1024).toFixed(1)}KB / ${ch}ch ${bits}bit ${rate}Hz`);
  }
}

// 授权凭证：每个音都必须能在 sources.json 里查到来源包与授权。
// 这条单独拎出来是因为它**不会以功能故障的形式暴露** —— 声音照响，
// 只是这个仓库从此说不清"这声音从哪来"。角色立绘有版权、音效是 CC0，
// 两者性质不同，混在一起含糊过去，将来是要还的。
if (sfxManifest) {
  const packs = sfxManifest.packs || {};
  const badPack = Object.entries(sfxManifest.sounds || {})
    .filter(([, v]) => !v || !packs[v.pack]).map(([k]) => k);
  const noLicense = Object.entries(packs)
    .filter(([, v]) => !/CC0|public\s*domain|公共领域/i.test(String(v.license || '')))
    .map(([k]) => k);
  if (badPack.length) bad('有音效指向了 sources.json 里不存在的素材包: ' + badPack.join(', '));
  else if (noLicense.length) bad('素材包授权不是 CC0: ' + noLicense.join(', '),
    '外部素材只从 CC0（公共领域）取 —— 别的授权会污染整条发布链');
  else ok(`音效授权可溯：${Object.keys(packs).length} 个 CC0 素材包，${sfxAll.length} 个音效全部有来源`);
}

// ---- 11d. preview 的 API 替身必须覆盖 pet.js 用到的全部 window.pet.* ----
// 这是一类特别阴的错误：pet.js 里多调一个 window.pet.xxx，而 preview.html 的
// 替身没实现 -> 浏览器里抛 TypeError，验收入口直接废掉；真机却完好无损。
// 于是"预览通过"变成了一件没有意义的事，而没有任何东西会提醒你。
const prevBridge = (prevHtml.match(/window\.pet\s*=\s*\{([\s\S]*?)\n\};/) || [, ''])[1];
const bridged = new Set([...prevBridge.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1]));
const petUsed = new Set([...petJs.matchAll(/window\.pet\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
if (!bridged.size || !petUsed.size) {
  bad('解析不出 preview.html 的替身或 pet.js 的调用', '下面的覆盖检查没有意义');
} else {
  const missing = [...petUsed].filter((m) => !bridged.has(m));
  if (missing.length) {
    bad('preview.html 的替身缺: ' + missing.join(', '),
      '浏览器验收页会在 pet.js 里抛 TypeError 整页失效，而真机正常 —— 验收本身就不再可信');
  } else ok(`preview 替身覆盖 pet.js 用到的全部 ${petUsed.size} 个 window.pet.*`);
}

// ---- 11e. CSP 必须允许加载本地音效 ----
const cspMeta = (indexHtml.match(/Content-Security-Policy["'][^>]*content="([^"]*)"/i) || [, ''])[1];
if (/media-src\s+'self'/.test(cspMeta)) ok("index.html 的 CSP 显式允许 media-src 'self'");
else bad("index.html 的 CSP 没有 media-src 'self'",
  '音效是用 <audio> 加载同目录的 file://，被 CSP 拦掉时是静默不响');

// ---- 11f. 勿扰：告别台词必须先说完，窗口才能藏 ----
const hideDelay = Number((mainJs.match(/const QUIET_HIDE_DELAY\s*=\s*(\d+)/) || [])[1]);
const byeMs = Number((petJs.match(/const QUIET_BYE_MS\s*=\s*(\d+)/) || [])[1]);
if (!hideDelay || !byeMs) {
  bad('读不到 QUIET_HIDE_DELAY / QUIET_BYE_MS',
    '这一对常量的配对关系（说完再藏）就没法校验了');
} else if (byeMs >= hideDelay) {
  bad(`告别台词 ${byeMs}ms ≥ 藏窗口延迟 ${hideDelay}ms`,
    '台词会被"人已经不见了"打断 —— 这两个数必须配对');
} else {
  ok(`勿扰：先说完 ${byeMs}ms 的告别，${hideDelay}ms 后才藏窗口`);
}

// 勿扰还必须把定时器冻住：窗口藏起来以后，待机池仍会按 12~26s 的节奏醒来。
for (const [needle, what] of [
  ["state.mode === 'idle' && !sleeping && !quiet", '待机动作池'],
  ["state.mode !== 'idle' || sleeping || quiet", '睡着判定'],
]) {
  if (petJs.includes(needle)) ok(`勿扰能冻住${what}`);
  else bad(`勿扰没冻住${what}`,
    '窗口藏起来以后它还会按时醒来说台词/放粒子 —— 看不见，但一直在跑');
}

// ---- 11g. 勿扰的可见性：一律按事实，别让任何调用把藏起来的她"叫回来" ----
// 这三条守的是 v3.7 修掉的那个真机 bug（"勿扰时她还在，而且点不到、关不掉"），
// 根因有两半，缺一半都不会出事 —— 所以两半都得钉住：
//
//   ① **moveTop() 会把隐藏的窗口重新显示出来。**
//      本机 Electron 33 实测：hide() 之后调 moveTop()，isVisible() 立刻变回 true。
//      对照组全部不会显示：setAlwaysOnTop / setSize / setPosition / setBounds /
//      setMinimumSize / setEnabled / setOpacity / focus / setIgnoreMouseEvents / webContents.send。
//      而 main.js 里有**两处**"定期重申"是无条件调的（10 分钟一次的重申置顶、
//      睡眠/解锁唤醒自愈）—— 于是"到明天早上 8 点"这种长勿扰里，
//      她每 10 分钟（或每次解锁）就自己冒出来一次。→ 必须带可见性闸门。
//
//   ② 一旦她"在勿扰里却是可见的"，穿透判定就必须还在维护。
//      旧版把可见性缓存成 quietHidden，而鼠标策略的闸门读的是那个缓存 ——
//      缓存说"她藏着呢"，于是光标巡检整个挂起，穿透态冻在隐藏前那一刻的值
//      （从托盘进勿扰时通常就是"穿透"）-> 她看得见、点不到、右键菜单也弹不出来。
//      → 闸门只能读 petWin.isVisible()，"勿扰中"不许有缓存副本。
//
// 扫之前先剥注释：真正危险的是**代码**，而这几条注释里到处都是 moveTop() 这个词。
const mainCode = stripComments(mainJs);

// ① 每个 moveTop() 前面必须先确认她确实该露面
const mtHits = [];
for (let i = mainCode.indexOf('moveTop()'); i !== -1; i = mainCode.indexOf('moveTop()', i + 1)) mtHits.push(i);
if (!mtHits.length) {
  bad('main.js 里找不到 moveTop()', '解析失效 —— 下面这条"必须带可见性闸门"的断言就形同虚设');
} else {
  const naked = mtHits.filter((i) => !mainCode.slice(Math.max(0, i - 320), i).includes('isVisible()'));
  if (naked.length) {
    bad(`有 ${naked.length} 处 moveTop() 没先确认可见`,
      'moveTop() 会把隐藏窗口重新显示出来（实测）—— 长勿扰里她会自己冒出来，而那期间鼠标策略是停的');
  } else {
    ok(`全部 ${mtHits.length} 处 moveTop() 都先确认了可见`);
  }
}

// ② 鼠标策略的闸门不许掺"勿扰"状态，且必须按 isVisible() 收敛
function fnBody(code, name) {
  const s = code.indexOf('function ' + name + '(');
  if (s < 0) return null;
  const e = code.indexOf('\n}', s);
  return e < 0 ? null : code.slice(s, e);
}
for (const fn of ['cursorPoll', 'reassertPassthrough']) {
  const body = fnBody(mainCode, fn);
  if (!body) {
    bad('解析不出 main.js 的 ' + fn + '()', '这两条关于穿透闸门的断言会一起失效');
  } else if (/\bquiet/i.test(body)) {
    bad(fn + ' 的闸门里掺了勿扰状态',
      '她一旦在勿扰里被显示出来，这里会整个挂起 -> 看得见、点不到（v3.7 的真机 bug）');
  } else if (!body.includes('isVisible()')) {
    bad(fn + ' 没有按 isVisible() 收敛',
      '她藏起来时它还在白烧，或者反过来该跳的时候不跳');
  } else {
    ok(fn + ' 的闸门只看 isVisible()');
  }
}

// ③ 别再给"可见性"造缓存副本
if (/\bquietHidden\b/.test(mainCode)) {
  bad('main.js 又把"勿扰中"缓存成变量了',
    '缓存会和事实漂开：别的路径把她显示出来时缓存还写着"藏着" -> 鼠标策略永不恢复');
} else {
  ok('"勿扰中"没有缓存副本（每次现算）');
}

// ---- 11h. 她被藏起来时必须真的停机 ----
// 实测（v3.7，真机 Electron 33）：主进程 hide() 之后 `document.hidden` **依然是 false** ——
// Electron 的 backgroundThrottling: false 文档里写着 "This also affects the
// Page Visibility API"。于是藏起来之后 rAF 仍以 ~180 帧/秒在跑、breathe 动画照转，
// "到明天早上 8 点"这一档会整整一夜朝一个没人看的窗口出帧
// （实测 2.62% 单核 -> 修完 0.10%）。
//
// 冻结是"JS 里切类名 + CSS 里落规矩"的两处配对，**漏一处都是静默失效**：
// 类切了而 CSS 没这条规矩，是一点都不冻 —— 界面上、日志里、截图上全都看不出来。
const freezeInCss = /pet-frozen/.test(petCss);
const freezeInJs = /pet-frozen/.test(petJs);
if (freezeInJs && !freezeInCss) {
  bad('pet.js 会切 .pet-frozen，但 pet.css 里没有这条规矩',
    '冻不住任何动画 —— 而且这件事完全看不出来，只体现为夜里多烧几个点 CPU');
} else if (freezeInCss && !freezeInJs) {
  bad('pet.css 定义了 .pet-frozen，但 pet.js 从没切过它', '这条 CSS 是死代码，她藏起来时依旧满帧跑');
} else if (!freezeInCss) {
  bad('找不到冻结开关（.pet-frozen）', '勿扰期间渲染层不会停机 —— 整夜空烧');
} else {
  ok('勿扰冻结：JS 切类名 + CSS 停动画，两处都在');
}

// 心跳的闸门必须挂在 quiet 上：document.hidden 在真机上永远不成立（同上），
// 只靠它等于没闸门 —— 那个 5 秒一次的心跳会整夜唤醒一个看不见的页面。
const hbBody = fnBody(petJs, 'syncHeartbeat');
if (!hbBody) {
  bad('解析不出 pet.js 的 syncHeartbeat()', '下面这条"心跳必须挂在 quiet 上"的断言会失效');
} else if (!/\bquiet\b/.test(hbBody)) {
  bad('syncHeartbeat 的闸门没挂在 quiet 上',
    'backgroundThrottling:false 让 document.hidden 永远是 false -> 她藏起来之后心跳整夜不停');
} else {
  ok('心跳的闸门挂在 quiet 上（document.hidden 在真机上不成立）');
}

// ---- 11i. 硬件加速：默认开，回退开关必须真的能回退 ----
// 见 main.js 那段注释：关掉硬件加速并不能避免"GPU 起不来"这种崩溃
// （GPU 进程两种配置都要起，起不来两种配置都 FATAL），只把整页动画压给 CPU。
// 实测同一组启动参数下：可见待机 1.25%（开）vs 2.56%（关）。
// 所以这里盯两件事：默认不许变回"无条件关闭"，以及回退开关必须还在。
const hwIdx = mainCode.indexOf('YUKINO_HWACCEL');
const disIdx = mainCode.indexOf('disableHardwareAcceleration');
if (hwIdx < 0) {
  bad('找不到 YUKINO_HWACCEL 这个回退开关',
    '硬件加速遇到驱动兼容问题时用户没有任何办法关掉它');
} else if (disIdx < 0 || disIdx - hwIdx > 160) {
  bad('disableHardwareAcceleration() 不再受环境变量约束',
    '又变成无条件关闭了：可见待机 CPU 会翻一倍（实测 1.25% -> 2.56%），而且它并不保护 GPU');
} else {
  ok('硬件加速默认开，关闭开关受 YUKINO_HWACCEL 约束');
}

// ---------- 12. 投掷物理：必然收敛 ----------
// 这一节是整个自检里**唯一**真正在跑数值的一节，因为这条不变量只能这么验。
//
// 为什么不能靠无头浏览器验：投掷积分是 rAF 驱动的，而无头模式在
// --virtual-time-budget 下 rAF 几乎不触发（实测 setInterval 走了 10 拍、
// rAF 零次；加 --screenshot 也只多 1 帧）。所以"她会不会永远弹下去"在浏览器里
// 验不出来 —— 而它恰恰是最要命的那类故障：不报错、不崩溃，只是 state.mode
// 永久停在 'throw'，于是待机池、主动靠近、睡着判定全部静默失效。
//
// 所以积分被抽到根目录的 throwphysics.js（和 clamp.js 同一个组织方式），
// 这里 require 的就是**真机上跑的那一份**，不是复刻。
//
// 断言三件事，覆盖三种不同的坏法：
//   a) 常量关系：REST > GRAVITY。这一条写反了就会永远微弹 —— 代码里注释了三遍，
//      但注释拦不住手滑，这里用断言拦住。
//   b) 收敛性：把初速度扫一遍（含极端值），全部必须在 MAX_FRAMES 内停稳，
//      而且**不能是靠帧数上限停的**（那说明能量衰减根本没生效，只是被兜底救了）。
//   c) 不越界：整个飞行过程 x 始终在 [left, right] 内、y 不穿到地下。
section('12. 投掷物理：必然收敛');

let TH = null;
try {
  TH = require(path.join(ROOT, 'throwphysics.js'));
} catch (e) {
  TH = null;
}
if (!TH) {
  bad('require 不到 throwphysics.js',
    '投掷的收敛性就完全没法验证了 —— 而它是"坏了也不报错"的那类');
} else {
  // a) 常量关系
  if (TH.REST > TH.GRAVITY) {
    ok(`REST(${TH.REST}) > GRAVITY(${TH.GRAVITY})：落地后不会无限微弹`);
  } else {
    bad(`REST(${TH.REST}) ≤ GRAVITY(${TH.GRAVITY})`,
      '落地清零后下一帧 vy 又等于 GRAVITY，阈值更小就永远满足弹跳条件 -> 无限微弹 -> mode 永久停在 throw');
  }

  // 边界用一个"典型桌面"的量级：工作区 1920×1080，窗口 404×469，角色透明边 100px
  const AREA = { x: 0, y: 0, width: 1920, height: 1080 };
  const PET_W = 404, PET_H = 469, PAD_X = 100;
  const LIM = {
    left: AREA.x - PAD_X,
    right: AREA.x + AREA.width - PET_W + PAD_X,
    ground: AREA.y + AREA.height - PET_H + 40
  };
  const run = (v0, x0, y0) => {
    const s = TH.makeState(v0, x0, y0);
    let minX = Infinity, maxX = -Infinity, maxY = -Infinity, hitCap = false;
    for (let i = 0; i < TH.MAX_FRAMES + 10; i++) {
      const r = TH.step(s, LIM);
      minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x); maxY = Math.max(maxY, s.y);
      if (r.reason === 'cap') { hitCap = true; break; }
      if (r.done) return { s, frames: s.frames, hitCap, minX, maxX, maxY, ok: true };
    }
    return { s, frames: s.frames, hitCap, minX, maxX, maxY, ok: false };
  };

  // 初速度网格：静止 / 随手一甩 / 甩满 / 向上抛满 / 斜着甩满 / 两种方向的极值
  const CASES = [
    ['静止', { vx: 0, vy: 0 }, 1900, LIM.ground],
    ['向上抛满', { vx: 0, vy: -TH.V_MAX }, 1900, LIM.ground],
    ['向右甩满', { vx: TH.V_MAX, vy: 0 }, 100, LIM.ground],
    ['向左甩满', { vx: -TH.V_MAX, vy: 0 }, 1800, LIM.ground],
    ['右上斜甩', { vx: TH.V_MAX, vy: -TH.V_MAX }, 100, LIM.ground],
    ['超出上限（应被夹住）', { vx: 9999, vy: -9999 }, 900, 0],
    ['在屏幕外起手（应被拉回）', { vx: -TH.V_MAX, vy: 20 }, 5000, LIM.ground],
    ['速度极小（应立刻停）', { vx: 0.1, vy: 0.1 }, 1900, LIM.ground - 1]
  ];

  let failed = [];
  for (const [name, v0, x0, y0] of CASES) {
    const r = run(v0, x0, y0);
    if (!r.ok) { failed.push(`${name}: 跑满 ${TH.MAX_FRAMES} 帧仍未停稳（兜底 ${r.hitCap ? '生效了' : '没生效'}）`); continue; }
    if (r.hitCap) { failed.push(`${name}: 是靠帧数上限停的 —— 能量衰减没起作用`); continue; }
    // 不越界。留 0.6px 容差：边界是浮点比较，且落地那一帧会先算再夹。
    if (r.minX < LIM.left - 0.6 || r.maxX > LIM.right + 0.6) {
      failed.push(`${name}: x 越界 [${r.minX.toFixed(1)}, ${r.maxX.toFixed(1)}] 超出 [${LIM.left}, ${LIM.right}]`);
      continue;
    }
    if (r.maxY > LIM.ground + 0.6) { failed.push(`${name}: y 穿到地下 ${r.maxY.toFixed(1)} > ${LIM.ground}`); continue; }
  }
  if (failed.length) {
    bad(`投掷物理在 ${failed.length}/${CASES.length} 组初速度下不收敛或越界`,
      failed.join(' || '));
  } else {
    const worst = CASES.map(([n, v0, x0, y0]) => run(v0, x0, y0).frames);
    ok(`投掷物理 ${CASES.length} 组初速度全部停稳（最慢 ${Math.max(...worst)} 帧，上限 ${TH.MAX_FRAMES}）`);
  }

  // c) 帧数上限必须真的比"正常收敛所需帧数"宽裕得多 ——
  //    否则兜底会变成常态，投掷看起来就像"飞到一半被掐掉"。
  const slowest = Math.max(...CASES.map(([, v0, x0, y0]) => run(v0, x0, y0).frames));
  if (slowest * 3 <= TH.MAX_FRAMES) {
    ok(`帧数上限（${TH.MAX_FRAMES}）是正常收敛（${slowest} 帧）的 ${(TH.MAX_FRAMES / slowest).toFixed(1)} 倍，兜底不会变成常态`);
  } else {
    bad(`帧数上限 ${TH.MAX_FRAMES} 相对正常收敛 ${slowest} 帧太紧`,
      '兜底一旦变成常态，表现就是"飞到一半突然落地"，而不是在救异常');
  }
}

// ---------- 13. 隐私边界：只数敲击，不读按键 ----------
// 这一节守的是 v3.4 新增的那两处"与你在做什么有关"的读取。
// 为什么必须用断言守：这两处的坏法全都是**静默**的 ——
// 一个键盘钩子开始记录 keycode、或者悄悄改成默认开启，程序照样跑，
// 用户看不出任何区别，而性质已经完全变了。注释拦不住这种改动。
section('13. 隐私边界');
// mainCode（剥掉注释的 main.js）在 [11g] 就已经算好了，这里直接复用 —— 别重新声明一遍。

// a) 全局键盘钩子是**默认关闭**的。readSettings().typing 必须是 === true 才算开，
//    不能写成"没设置就算开"（那等于默认开）。
if (/typing\s*===\s*true/.test(mainCode)) {
  ok('键盘反应是 opt-in：只有 settings.typing === true 才启用');
} else {
  bad('找不到"typing === true"这个 opt-in 判定',
    '退化成默认开启的话，用户会在不知情的情况下被挂上全局键盘钩子');
}

// b) 事件回调里不许读任何按键内容。
//    这是"不记录按了哪个键"这句承诺的**唯一**可验证形式。
//    连字段名都不该出现 —— 出现了就说明有人在读它。
const KEY_FIELDS = ['keycode', 'rawcode', 'rawCode', 'keyCode', 'event.key', 'e.key'];
const leaked = KEY_FIELDS.filter((f) => mainCode.includes(f));
if (leaked.length) {
  bad('main.js 里出现了按键内容字段: ' + leaked.join(', '),
    '键盘钩子的回调只允许计数，读 keycode / key 就等于在记录按了哪个键 —— 这与 README 和 DISCLAIMER 的承诺矛盾');
} else {
  ok('main.js 不含 keycode / rawcode / key 字段（只计数，不读按键内容）');
}

// c) keydown 监听必须只 push 时间戳，不能把事件对象存起来。
//    `(e) => { buf.push(e) }` 这种写法等于把每个按键都留在内存里。
const hookBody = (mainCode.match(/\.on\('keydown',\s*\(([^)]*)\)\s*=>\s*\{([^}]*)\}/) || []);
if (!hookBody.length) {
  bad("找不到 .on('keydown', ...) 的回调", '这一段是隐私承诺的落点，不敢让它无记录地消失');
} else {
  const params = hookBody[1].trim();
  const body = hookBody[2];
  if (params !== '') {
    bad(`keydown 回调带了参数 "(${params})"`,
      '带参数就意味着拿到了事件对象，也就意味着可以读按键内容；应为 ()');
  } else if (!/typingBuf\.push\(Date\.now\(\)\)/.test(body)) {
    bad('keydown 回调不是"只 push 时间戳"', '实际内容是：' + body.trim().slice(0, 80));
  } else {
    ok("keydown 回调形如 () => typingBuf.push(Date.now())：只留时间戳，不留按键");
  }
}

// d) DISCLAIMER 里必须有一段讲这件事。
//    功能会上线，说明可能忘了写 —— 而"没写"是用户看不到的那一侧。
const disc = read('DISCLAIMER.md') || '';
if (/全局键盘钩子|uiohook/.test(disc) && /不记录/.test(disc)) {
  ok('DISCLAIMER.md 里有键盘钩子的隐私说明');
} else {
  bad('DISCLAIMER.md 没写键盘钩子的隐私说明',
    '程序读用户的输入行为，说明必须写明读了什么、没读什么、存在哪里 —— 这是能被用户检查的唯一入口');
}

// ---------- 14. 点击穿透（v3.5）----------
// 这一节的每一条都对应一个"静默失效"的方向，而且两个方向都很隐蔽：
//   · 该穿的不穿 -> 她周围一圈空气挡住了桌面图标（用户只会觉得"你挡着我了"）
//   · 不该穿的穿了 -> 她本身某处点不到（用户只会觉得"这点不上，手感真差"）
// 两者都不报错、不影响任何其它功能，所以只能靠断言守。
section('14. 点击穿透（透明区不再挡桌面）');

// a) 建窗即穿透。起点若不是穿透，"启动那一刻鼠标恰好压在窗口上"会白吞一次点击。
const createSeg = (mainJs.match(/function createPet\(\)\s*\{[\s\S]*?\n\}/) || [''])[0];
if (/setIgnoreMouseEvents\(true,\s*\{\s*forward:\s*true\s*\}\)/.test(createSeg)) {
  ok('createPet 建窗即进入穿透态');
} else {
  bad('createPet 里没有"建窗即穿透"',
    '渲染层还没上报可交互区时整窗都该让开；少了它启动瞬间会白吞一次点击');
}

// b) forward: true 必须留着。没有它，穿透态下渲染层收不到 mousemove ——
//    摸头、以及"立刻取消穿透"的快路径会一起失效，而表现只是"反应不灵"。
const ptCode = stripComments(mainJs);
if (/setIgnoreMouseEvents\([^)]*\{\s*forward:\s*true\s*\}/.test(ptCode)) {
  ok('setIgnoreMouseEvents 带 forward: true（穿透态下仍收得到 mousemove）');
} else {
  bad('setIgnoreMouseEvents 缺 forward: true',
    '穿透态下渲染层会收不到 mousemove —— 摸头和"立刻取消穿透"都会静默失效');
}

// c) 拖拽与原生右键菜单期间必须**强制不穿透**：
//    这两种情况下鼠标一定会离开角色轮廓，只按光标位置判会把它们掐断。
const wpSeg = (mainJs.match(/function wantPassthrough\([\s\S]*?\n\}/) || [''])[0];
if (/blockMode/.test(wpSeg) && /menuOpen/.test(wpSeg)) {
  ok('拖拽（blockMode）与原生菜单（menuOpen）期间强制取消穿透');
} else {
  bad('wantPassthrough 没考虑 blockMode / menuOpen',
    '拖拽 / 右键菜单时鼠标必然离开角色轮廓，靠光标位置判断会把它们掐断');
}

// d) 穿透判定必须排在"光标没动就不发"的去重**之前**。
//    排到后面的话，鼠标一静止（也就是绝大多数时间）穿透态就没人维护了 ——
//    等于退回"设一次就不管"的老路，而那正是 v3.1 把它整个废掉的原因。
const syncIdx = ptCode.indexOf('applyPassthrough(wantPassthrough(');
const dedupeIdx = ptCode.indexOf('lastCursor.x === pt.x');
if (syncIdx > 0 && (dedupeIdx < 0 || syncIdx < dedupeIdx)) {
  ok('穿透判定排在光标去重之前（鼠标静止时也在维护）');
} else {
  bad('穿透判定排在"光标没动就不发"之后',
    '鼠标静止时穿透态就没人维护了 —— 又回到"设一次就不管"');
}

// e) 定期重申。重申的必须是**按当前事实重算的值**（reassertPassthrough 里
//    重新取了一次光标），而不是"上次设过的值" —— 重申一个已经算错的值得不到纠正。
if (/function reassertPassthrough\(/.test(ptCode) &&
    /reassertPassthrough\(\)/.test(ptCode) &&
    /getCursorScreenPoint/.test((ptCode.match(/function reassertPassthrough\([\s\S]*?\n\}/) || [''])[0])) {
  ok('穿透态按当前事实定期重申（DWM 事件后的漂移能被纠回来）');
} else {
  bad('没有按事实重申穿透态',
    'DWM 事件后它可能悄悄漂掉 —— 这正是上一版把这个 API 整个废掉的原因');
}

// f) 可交互区必须由**渲染层上报**：主进程算不出这一套装扮显示多宽、
//    番茄钟面板有没有展开。
const hitFns = (petJs.match(/function spriteBox\(\)[\s\S]*?\n\}/) || [''])[0] +
               (petJs.match(/function reportHitArea\(\)[\s\S]*?\n\}/) || [''])[0];
if (/ipcMain\.handle\('pet:hitArea'/.test(mainJs) && /pet:hitArea/.test(preloadJs)) {
  ok('可交互区走"渲染层上报"（pet:hitArea）');
} else {
  bad('可交互区没有走渲染层上报', '主进程猜不出角色实际占多宽、面板有没有展开');
}

// g) 面板必须一起报进去。它压在角色上，漏了它"开始/暂停/放弃/统计"会直接穿到桌面。
if (/panel\.classList\.contains\('hidden'\)/.test(hitFns) &&
    /add\(panel\.getBoundingClientRect\(\)\)/.test(hitFns)) {
  ok('番茄钟面板被算进可交互区');
} else {
  bad('上报可交互区时没并上番茄钟面板',
    '面板压在角色上，漏了它四个按钮会直接穿到桌面上');
}

// h) 几何必须取自**没有动画的那一层**（#petArea），不能取 #fBase 的变换后框。
//    #petWrap 上挂着呼吸 / 跳跃 / 坐下 / 投掷翻滚：坐着下沉 9px、跳跃上移 34px、
//    投掷时还在旋转 —— 任何一次上报落在动画中途，报出去的就是一个没有规律可循的错框。
if (/petArea\.getBoundingClientRect\(\)/.test(hitFns) &&
    !/fBase\.getBoundingClientRect\(\)/.test(hitFns)) {
  ok('可交互区取自 #petArea（避开 #petWrap 上的动画）');
} else {
  bad('可交互区取自 #fBase.getBoundingClientRect()',
    '那是**变换后**的框，会被呼吸/跳跃/坐下的动画带着走 —— 报出去的框会无规律地错');
}

// i) 换装 / 缩放 / 启动 / 面板显隐都必须触发重报，否则可交互区会一直停在旧几何上。
const reroute = [];
if (/fBase\.addEventListener\('load',\s*reportHitArea\)/.test(petJs)) reroute.push('素材载入');
if (/window\.addEventListener\('resize',\s*reportHitArea\)/.test(petJs)) reroute.push('窗口尺寸');
if (/MutationObserver\(reportHitArea\)\.observe\(panel/.test(petJs)) reroute.push('面板显隐');
if (/^\s*reportHitArea\(\);\s*$/m.test(petJs)) reroute.push('启动');
if (reroute.length === 4) ok('重报时机齐了：' + reroute.join(' / '));
else {
  bad('可交互区的重报时机缺了 ' + (['素材载入', '窗口尺寸', '面板显隐', '启动']
    .filter((x) => !reroute.includes(x)).join(' / ')),
    '漏掉的那个时机之后，可交互区会一直停在旧几何上（表现为"她某处点不到"）');
}

// j) 验收页要能把可交互区**画出来**。它是这一块唯一能一眼验收的方式：
//    算错的两种方向在截图上都看不出来（那一带本来就是透明的）。
if (/#hit-overlay/.test(prevHtml) && /window\.pet\._hitArea/.test(prevHtml)) {
  ok('preview.html 能画出可交互区（画的是真的报出去的那个框）');
} else {
  bad('preview.html 画不出可交互区', '算错的两种方向在截图上都看不出来，只能靠这个框');
}

// ---------- 15. 台词：库里有的必须真的念得出来 ----------
// 死台词是这个项目最容易复发的一类问题：台词写好了、代码没引用，
// 于是"她从来不说话的那几个场景"永远没人发现（不报错、不崩、只是静默）。
// v3.4 就漏了 QUOTES.throw 一整组（被甩出去时一声不吭）和 typeLong。
section('15. 台词：库里有的都得有引用路径');
const dlgJs = read('renderer/dialogue.js') || '';
// 只取**顶层**键（缩进正好两个空格）。outfit / region / mood / bond / levelUp
// 里面那些是四个空格，正则的 `^  ` 后面紧跟字母，不会误伤。
const dlgKeys = [...dlgJs.matchAll(/^  ([a-zA-Z][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]);
if (dlgKeys.length < 12) {
  bad('解析不出 dialogue.js 的顶层台词组（只拿到 ' + dlgKeys.length + ' 个）',
    '下面的死台词检查没有意义，先看是不是文件结构变了');
} else {
  const unused = dlgKeys.filter((k) => !new RegExp('QUOTES\\.' + k + '\\b').test(petJs));
  if (unused.length) {
    bad('死台词（dialogue.js 里有、pet.js 从不引用）: ' + unused.join(', '),
      '她在这几个场景里永远不会开口 —— 不报错、不崩，所以只有这条能发现它');
  } else {
    ok(`${dlgKeys.length} 组台词全部有引用路径（无死台词）`);
  }
}

// ---------- 16. 假死看门狗的"可见性"闸门（两处必须成对）----------
// 只改一边的后果是反的：渲染层不再在隐藏时跳心跳，而主进程照旧判假死，
// 于是勿扰期间她会每 35 秒被重载一次 —— 而这一档可以是"到明天早上 8 点"。
section('16. 假死看门狗的可见性闸门');
const wdSeg = (mainJs.match(/\/\/ 心跳看门狗[\s\S]*?\},\s*10000\);/) || [''])[0];
if (/!petWin\.isVisible\(\)/.test(wdSeg)) {
  ok('主进程：窗口不可见时不判假死');
} else {
  bad('看门狗没有"不可见就不判"的闸门',
    '勿扰期间渲染层是静默的，照旧判假死会整夜反复重载一个看不见的窗口');
}
if (/shownAt/.test(wdSeg)) {
  ok('看门狗：刚露面的一段时间内不判（渲染层的心跳还没轮到）');
} else {
  bad('看门狗没有"刚露面不判"的宽限',
    '她每次从勿扰回来，都会因为 lastHeartbeat 还是旧的而被立刻重载一次');
}
if (/document\.hidden/.test(petJs) && /visibilitychange/.test(petJs)) {
  ok('渲染层：隐藏时停掉心跳（背景不降频，不停就是整夜在唤醒）');
} else {
  bad('渲染层的心跳没有可见性闸门', 'backgroundThrottling:false 之下它会整夜唤醒一个看不见的页面');
}
if (/markShown/.test(mainJs) && /function showPet\(/.test(mainJs)) {
  ok('"把她叫回来"的入口统一走 showPet（markShown + 穿透重申不会漏）');
} else {
  bad('显示窗口的入口没有统一', '漏的那一处会让她回来后头几秒点不到、或先被重载一次');
}

// ---------- 17. 渲染层的两处去重（v3.5）----------
// 这两条都属于"不报错、只是白烧"的优化，所以它们唯一的守门人就是这里 ——
// 不盯着，下一个人"顺手去掉一个 if"就没了。
section('17. 渲染层去重');
if (/v !== pick\._last/.test(petJs) && !/_last\s*=\s*i\s*;/.test(petJs)) {
  ok('pick() 按**文本**去重（下标那版跨数组、跨新建数组都是失效的）');
} else {
  bad('pick() 又改回按下标去重了',
    'idleLines() 每次都新建数组，下标在两次调用之间不可比 —— 待机台词的防重会静默失效');
}
if (/t === lastLook\)\s*return/.test(petJs)) {
  ok('目光跟随的 transform 写入值不变就不写');
} else {
  bad('目光跟随每次都写 transform',
    '会不停重启 #lookWrap 上那条 .3s 过渡，缓动永远停在头一段，反而显得迟钝');
}
if (/walkFrames/.test(petJs)) {
  ok('走动时的窗口移动降频到约 30Hz');
} else {
  bad('走动又变成每帧一次 setPosition', '原生调用 + DWM 重排透明层，60Hz 没有意义');
}
if (/prefers-reduced-motion/.test(petCss) && /#petWrap\.breathe/.test(petCss)) {
  ok('pet.css 支持系统「减少动态效果」（无限循环动画退化成静态姿态）');
} else {
  bad('pet.css 没有 prefers-reduced-motion',
    '桌宠的呼吸/睡着/专注全是无限循环动画 —— 这正是前庭敏感的人最难受的那一类');
}

// ---------- 18. 生活流行为链：转移表必须是"活的" ----------
// 转移表最容易出的两种坏法都是**静默**的：
//   · 某个节点没有任何出边 —— 链进去就卡死，停在那一个动作上；
//   · 引用了不存在的节点 —— 抽到就抛，而它只在特定随机路径上出现。
// 两种都不会在"她正常站了一会儿"的截图里显形。所以这一节是纯静态地
// 把转移表当图来查：出边、引用、可达终止。
section('18. 生活流行为链（转移表必须是活的）');
const blockOf = (name) => {
  const m = petJs.match(new RegExp('const ' + name + '\\s*=\\s*\\{([\\s\\S]*?)\\n\\};'));
  return m ? m[1] : null;
};
const actBlock = blockOf('ACT');
const nextBlock = blockOf('NEXT');
const entryBlock = blockOf('CHAIN_ENTRY');
if (!actBlock || !nextBlock || !entryBlock) {
  bad('解析不出 ACT / NEXT / CHAIN_ENTRY',
    `act=${!!actBlock} next=${!!nextBlock} entry=${!!entryBlock} —— 下面的图检查没有意义`);
} else {
  const keysOf = (b) => [...b.matchAll(/^\s{2}([A-Za-z_]\w*)\s*:\s*\{/gm)].map((m) => m[1]);
  const actKeys = keysOf(actBlock);
  const nextKeys = keysOf(nextBlock);
  const entryKeys = [...entryBlock.matchAll(/([A-Za-z_]\w*)\s*:\s*(\d+)/g)].map((m) => m[1]);
  // end: true 的节点是**显式终止**。放在第一个 '}' 之前找，因为 ACT 的写法
  // 一律是 `{ ms: 900, end: true, run() {...} }`。
  const endKeys = [...actBlock.matchAll(/^\s{2}([A-Za-z_]\w*)\s*:\s*\{[^}]*?\bend:\s*true/mg)]
    .map((m) => m[1]);

  const edges = {};
  for (const m of nextBlock.matchAll(/^\s{2}([A-Za-z_]\w*)\s*:\s*\{([^}\n]*)\}/gm)) {
    edges[m[1]] = [...m[2].matchAll(/([A-Za-z_]\w*)\s*:\s*(\d+)/g)]
      .map((x) => [x[1], Number(x[2])]);
  }

  if (actKeys.length < 12) {
    bad('行为节点只有 ' + actKeys.length + ' 个（少于 12）',
      '节点太少的话链会很快重复，等于绕了一圈回到"她每隔十几秒抖一下"');
  } else {
    ok(`行为节点 ${actKeys.length} 个，其中显式终止 ${endKeys.length} 个`);
  }

  // a) 每个节点必须"有出路"：要么有出边，要么标了 end。
  //    两者都没有 = 代码读起来像还能往下走，实际进去就停住了。
  const noWayOut = actKeys.filter((k) => !nextKeys.includes(k) && !endKeys.includes(k));
  if (noWayOut.length) {
    bad('这些节点既没有出边、也没标 end: true: ' + noWayOut.join(', '),
      '链走进去就再也出不来（预算会兜底收链，但"正常收尾"的那条路没有了）');
  } else {
    ok('每个节点都有出边、或显式标了 end: true');
  }

  // b) 悬空引用。抽到不存在的节点会直接抛 TypeError —— 而且只在特定随机路径上出现。
  const ghostTargets = [];
  for (const [n, es] of Object.entries(edges)) {
    for (const [t, w] of es) if (w > 0 && t !== '_' && !actKeys.includes(t)) ghostTargets.push(n + ' → ' + t);
  }
  const ghostNodes = nextKeys.filter((k) => !actKeys.includes(k));
  const ghostEntry = entryKeys.filter((k) => !actKeys.includes(k));
  if (ghostNodes.length || ghostTargets.length || ghostEntry.length) {
    bad('转移表里有不存在的节点',
      [...ghostNodes.map((k) => 'NEXT 的键: ' + k), ...ghostTargets.map((s) => '出边: ' + s),
       ...ghostEntry.map((k) => '入口: ' + k)].join(' / '));
  } else {
    ok('NEXT 的键 / 所有出边 / 入口表，指的都是真实节点');
  }

  // c) 出边权重不能全是 0。全 0 等于隐式终止，但没标 end —— 看代码的人会以为它能走。
  const deadEdges = nextKeys.filter((k) => !(edges[k] || []).some(([, w]) => w > 0));
  if (deadEdges.length) {
    bad('这些节点的出边权重全是 0: ' + deadEdges.join(', '),
      '等于隐式终止却没标 end: true —— 读代码的人会以为它还能往下走');
  } else {
    ok('每个 NEXT 条目都至少有一条正权重出边');
  }

  // d) 可达终止。转移表里出现"环且环内无出口"时，链会永远转下去 ——
  //    预算能兜住运行时，但静态上先把这个环找出来。
  const canEnd = new Set(endKeys);
  for (let grew = true; grew;) {
    grew = false;
    for (const n of actKeys) {
      if (canEnd.has(n)) continue;
      if ((edges[n] || []).some(([t, w]) => w > 0 && (t === '_' || canEnd.has(t)))) {
        canEnd.add(n); grew = true;
      }
    }
  }
  const stuck = actKeys.filter((k) => !canEnd.has(k));
  if (stuck.length) {
    bad('这些节点走不到终止: ' + stuck.join(', '),
      '转移表里有个没有出口的环 —— 运行时靠预算兜底，但那条路永远走不到"正常收尾"');
  } else {
    ok('每个节点都存在一条走到终止的路径（转移表是活的）');
  }

  // e) 预算兜底。上面 d) 证明的是"图本身是活的"，这一条证明的是
  //    "就算图被改坏也不会卡死" —— 两条守的不是同一件事，都要有。
  const budget = Number((petJs.match(/const CHAIN_BUDGET\s*=\s*(\d+)/) || [])[1]);
  const minSteps = Number((petJs.match(/const CHAIN_MIN_STEPS\s*=\s*(\d+)/) || [])[1]);
  if (!(budget > 0)) {
    bad('读不到 CHAIN_BUDGET、或它 ≤ 0',
      '没有它，转移表一旦被写成环就会永远转下去 —— 这是唯一的运行时兜底');
  } else {
    ok(`一条链有总时长上限 ${budget}ms（结构性兜底，不靠"记得别写错"）`);
  }
  if (!(minSteps >= 2)) {
    bad('CHAIN_MIN_STEPS < 2', '只演一拍不叫"在过日子"，和旧的定时抽签没区别');
  } else {
    ok(`链至少演 ${minSteps} 拍`);
  }
  if (/chainBudget\s*>=?\s*0/.test(petJs) && /chainBudget\s*-=/.test(petJs)) {
    ok('预算真的参与判定（chainBudget -= ... 且被拿去比较）');
  } else {
    bad('CHAIN_BUDGET 只是声明了、没参与判定', '那它不是兜底，只是一句注释');
  }

  // f) 打断点必须齐全。少一处，那一处的表现就是"你刚动完她，两秒后她又自己接着演"。
  //    每一条都对应一个真实的交互入口 —— 不是"顺手都加上"，是每一处都得有。
  const breakPoints = [
    ['单击', /wrap\.addEventListener\('click'[\s\S]{0,300}?interruptChain\(\)/],
    ['拖拽按下', /wrap\.addEventListener\('mousedown'[\s\S]{0,300}?interruptChain\(\)/],
    ['摸头', /patTimer = setTimeout\(\(\) => \{[\s\S]{0,300}?interruptChain\(\)/],
    ['打字', /lastTypeTap = now;[\s\S]{0,300}?interruptChain\(\)/],
    ['右键菜单', /wrap\.addEventListener\('contextmenu'[\s\S]{0,300}?interruptChain\(\)/],
    ['番茄钟面板', /function openPomodoro\(\)[\s\S]{0,300}?interruptChain\(\)/]
  ];
  for (const [what, re] of breakPoints) {
    if (re.test(petJs)) ok(`「${what}」会打断她自己那条链`);
    else bad(`「${what}」没打断行为链`,
      '你刚跟她互动完，两秒后她又自己接着演 —— 像没听见你说话');
  }
  if (/lastInteract < CHAIN_QUIET_AFTER/.test(petJs)) {
    ok('刚互动过的几秒内不起新链（旧写法没有这条，打字时她会每十几秒闪一下）');
  } else {
    bad('runChain 没有"刚互动过就先别演"的闸门',
      '打字期间她会不断起链又被打断 —— 每十几秒闪一下');
  }
  if (/interruptChain\(\)[\s\S]{0,200}?clearTimeout\(chainTimer\)/.test(petJs) ||
      /function interruptChain\(\)[\s\S]{0,300}?clearTimeout\(chainTimer\)/.test(petJs)) {
    ok('打断是真的清掉了定时器（不是只置一个标志位）');
  } else {
    bad('interruptChain 没有清定时器', '下一拍照样会到点触发 —— 打断等于没打');
  }
}

// ---------- 19. 单击的即时反馈（250ms 迟滞） ----------
// 双击判定窗口不能取消（取消了就分不出单双击），所以"手感"只能靠把反应提前解决。
// 这一节守的就是这个拆分：视觉/音效在点击当场，台词/数值等确认。
// 拆错的两种方式都很隐蔽：把数值也提前（双击时结算两遍）、
// 或者 250ms 后重新算一次点击部位（鼠标早挪走了）。
section('19. 单击的即时反馈（250ms 迟滞）');
const clickH = (petJs.match(/wrap\.addEventListener\('click',[\s\S]*?\n\}\);/) || [''])[0];
const touchBody = (petJs.match(/function regionTouch\(region\)\s*\{([\s\S]*?)\n\}/) || [, ''])[1];
const confirmBody = (petJs.match(/function regionConfirm\(region\)\s*\{([\s\S]*?)\n\}/) || [, ''])[1];
if (!clickH || !touchBody || !confirmBody) {
  bad('解析不出 click / regionTouch / regionConfirm',
    `click=${!!clickH} touch=${!!touchBody} confirm=${!!confirmBody}`);
} else {
  if (/regionTouch\(region\)/.test(clickH) && /regionConfirm\(region\)/.test(clickH)) {
    ok('单击拆成「当场出视觉音效」+「250ms 后补台词」');
  } else {
    bad('单击还是一次性等 250ms 才反应', '手感上就是"戳她一下要愣四分之一秒"');
  }
  if (/\bgain\(|moodShift\(/.test(touchBody)) {
    bad('regionTouch 里算了 gain / moodShift',
      '双击时 touch 会跑两遍 —— 点两下算了四下，情绪值掉得比设计快一倍');
  } else {
    ok('regionTouch 只出视觉与音效，不碰数值（双击不会重复结算）');
  }
  if (/\bgain\(/.test(confirmBody) && /moodShift\(/.test(confirmBody)) {
    ok('regionConfirm 才是数值的唯一入口');
  } else {
    bad('regionConfirm 没结算数值', '情绪值与羁绊的入口就断了 —— 点她不再有任何累积');
  }
  if (/setTimeout\([\s\S]{0,160}?hitRegion\(e\)/.test(clickH)) {
    bad('250ms 之后又重新算了一次点击部位',
      '那时鼠标可能已经挪到别处 —— 摸头会摸出"拉裙摆"的反应，而且只在你手抖时出现');
  } else {
    ok('点击部位在按下的那一刻就定进闭包（不靠 250ms 后重算）');
  }
}

// ---------- 20. 醒来三拍 / 久别重逢 ----------
section('20. 醒来三拍 + 久别重逢');
if (/let waking = false/.test(petJs)) ok('waking 是独立状态（不是 sleeping 的中间值）');
else bad('没有独立的 waking 状态',
  '那"她正在醒"的两秒里，点击要么被 wakeUp 吞掉（点了没反应），要么被当成普通互动');
{
  const iWaking = clickH.indexOf('waking');
  const iWakeUp = clickH.indexOf('wakeUp()');
  if (iWaking >= 0 && iWakeUp > iWaking) {
    ok('click 里先判「正在醒」、再判「睡着」');
  } else {
    bad('click 里 waking 的判定没有排在 wakeUp 之前',
      'wakeUp 在 waking 期间返回 false，点击会落到下面被当成普通交互 —— “戳一下”变成“戳 + 跳 + 她抗议”');
  }
  if (/if \(waking\) finishWake\(false\)/.test(petJs)) ok('拖拽开始时也会把醒来过渡收掉');
  else bad('mousedown 没处理 waking',
    '醒来那两个 setTimeout 会在你拖到一半时插一个 yawn，把 dangle 顶掉');
}
if (/setPose\('wake'\)/.test(petJs) && /#petWrap\.wake\b/.test(petCss)) {
  ok('醒来有专属姿态（pet.js 会挂、pet.css 有对应规则）');
} else {
  bad('wake 姿态缺一半', '要么 JS 挂了没有样式的类，要么 CSS 写了没人挂');
}
if (/'(breathe|sleep|focus|sit|wake)'.*'wake'|wake.*forEach/.test(petJs) &&
    /\['breathe', 'sleep', 'focus', 'sit', 'wake'\]/.test(petJs)) {
  ok("setPose 的互斥列表包含 'wake'");
} else {
  bad("setPose 的互斥列表漏了 'wake'",
    '旧姿态不会被摘掉，两个动画会叠在同一个 transform 上打架');
}
if (/prefers-reduced-motion[\s\S]*#petWrap\.wake/.test(petCss)) {
  ok('「减少动态效果」里包含 wake 姿态');
} else {
  bad('reduced-motion 漏了 wake',
    '它是一条无限循环动画 —— 漏掉就等于给前庭敏感的人多留了一盏一直晃的灯');
}
// 姿态必须排在动作之前（CSS 同元素多条 animation 冲突时后声明的胜出）。
// 排反的表现是"她坐下以后打哈欠毫无反应"，截图上看不出来（她确实在动，动的是坐姿）。
{
  const poses = ['breathe', 'sleep', 'focus', 'sit', 'wake'];
  const acts = ['bounce', 'jump', 'nod', 'yawn', 'stretch', 'lookAround', 'shake', 'recoil', 'huff'];
  const lineOf = (name, list) => {
    const i = list.indexOf(name);
    return i < 0 ? -1 : petCss.indexOf(`#petWrap.${name} {`);
  };
  const lastPose = Math.max(...poses.map((p) => lineOf(p, poses)));
  const firstAct = Math.min(...acts.map((a) => lineOf(a, acts)).filter((v) => v > 0));
  if (lastPose > 0 && firstAct > 0 && lastPose < firstAct) {
    ok('所有姿态规则都排在动作规则之前（动作能盖住姿态）');
  } else {
    bad('有姿态规则排在了动作规则之后',
      `最后一个姿态在 ${lastPose}，第一个动作在 ${firstAct} —— ` +
      '排反的那个姿态会盖住动作（"坐下以后打哈欠没反应"），而截图看不出来');
  }
}
// 久别重逢：三处通道必须齐全，否则渲染层直接 TypeError。
{
  const chans = [
    ['主进程', /ipcMain\.handle\('pet:getAway'/, mainJs],
    ['preload', /getAway:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('pet:getAway'\)/, preloadJs],
    ['预览替身', /getAway:\s*async\s*\(\)\s*=>\s*\(\{\s*awayMs:/, prevHtml]
  ];
  const miss = chans.filter(([, re, txt]) => !re.test(txt)).map(([n]) => n);
  if (miss.length) bad('久别重逢的通道缺: ' + miss.join(', '),
    '渲染层会直接 TypeError，整页失效 —— 而真机看起来完全正常');
  else ok('久别重逢的 IPC 三处齐全（主进程 / preload / 预览替身）');
}
// ⚠ 顺序：先读旧值、再写此刻。反了的话差值恒为 0，久别重逢**永远不触发**，
//   而且完全静默 —— 问候照常出现，只是永远走"普通问候"那一支，没有任何报错。
//   ⚠ 判"顺序"必须在**同一段**里判。全局 indexOf 是不够的：先写后读时，
//   before-quit 里那次 markSeen() 会落在这条判断的后面，于是照样通过 ——
//   而那时功能已经是死的。所以先把 whenReady 这一段切出来。
{
  const seg = (mainJs.match(/app\.whenReady\(\)\.then\(\(\) => \{[\s\S]*?\n\}\);/) || [''])[0];
  const iRead = seg.indexOf('prevSeenAt = Number(s[SEEN_KEY])');
  const iWrite = seg.indexOf('markSeen();');
  if (!seg) bad('切不出 app.whenReady 段', '启动顺序就没法校验了');
  else if (iRead < 0 || iWrite < 0) bad('whenReady 里缺 prevSeenAt 读取 或 markSeen()');
  else if (iRead < iWrite) ok('主进程先读「上次她在」、再写此刻（同一段内）');
  else bad('whenReady 里先写后读',
    '差值恒为 0：久别重逢永不触发，而且没有任何报错 —— 最难发现的那种');
}
if (/before-quit[\s\S]{0,400}?markSeen\(\)/.test(mainJs)) {
  ok('退出前落一次时刻（正常关机拿到的是干净的时间点）');
} else {
  bad('before-quit 没有 markSeen', '正常关机的时间点会丢失，下次算出来的差值带一段误差');
}
{
  const AW = ['short', 'hours', 'day', 'long'];
  const miss = AW.filter((k) => !new RegExp('\\b' + k + ':\\s*\\[').test(dialogueJs));
  if (miss.length) bad('away 缺档位: ' + miss.join(', '), '那一档的离线时长她会一声不吭');
  else ok('久别重逢四档台词齐全（短 / 小时 / 隔天 / 三天以上）');
  if (/awayLine/.test(petJs) && /QUOTES\.away\.(short|hours|day|long)/.test(petJs)) {
    ok('分档逻辑在渲染层，主进程只回差值');
  } else {
    bad('awayLine 没有接上 QUOTES.away', '台词库摆在那儿但永远不会被念出来');
  }
}

// ---------- 21. 缩放 / 换装后必须重报可交互区 ----------
// 这一条守的不是产品、是**验收**：真机上主进程 setSize 会触发渲染层的 window resize，
// 而 resize 上挂着 reportHitArea，所以真机是兜住的。但预览页缩放走的是改 #stage 尺寸，
// **不触发 window resize** —— 于是 hitBox 停在缩放前的值，读数出现
// 「sprite 226x232 配 hit 428」（后者是 medium 档的 389+余量）这种自相矛盾的结果。
// 验收页给的数不可信，等于所有基于它的判断都不成立，所以按"替身必须和真机语义一致"补上。
section('21. 缩放 / 换装后重报可交互区');
const scaleCb = (petJs.match(/window\.pet\.onScale\(\(k\) => \{[\s\S]*?\n\}\);/) || [''])[0];
if (!scaleCb) {
  bad('解析不出 onScale 回调');
} else if (/reportHitArea\(\)/.test(scaleCb)) {
  ok('缩放后立刻重报可交互区（不等 resize）');
} else {
  bad('缩放后没有重报可交互区',
    '预览页不触发 window resize —— 验收会读到"hit 428 配 sprite 226"这种自相矛盾的值，而真机正常');
}
if (/addEventListener\('load',\s*reportHitArea\)/.test(petJs)) {
  ok('素材 load 后重报（换装会改角色显示宽）');
} else {
  bad('素材 load 后没重报可交互区',
    '换装的四套素材宽度差很多（水手服 188 / 女仆装 389），框还按上一套算 —— 窄的那套两边点不到');
}
if (/addEventListener\('resize',\s*reportHitArea\)/.test(petJs)) {
  ok('窗口 resize 也重报（真机上多一层兜底）');
} else {
  bad('没有 resize -> reportHitArea', '真机上 DWM 改窗尺寸时就没机会修正可交互区了');
}

// ---------- 22. 位置存档必须锚在底边 ----------
// v3.6 把顶部留白从 17% 提到 22%，窗口因此高了 20px。窗口位置在整套几何里是
// **以底边为锚**的（applyScale / enforceSize / groundYOf 三处都是），但存档里
// 存的是左上角 (x, y) —— 只按 y 还原的话，窗口一高，她的脚就整体下沉 20px。
// 所以存档同时记底边 bottom，启动时优先按 bottom 还原。
// 这条不盯着，下次再动窗口高度时同样的问题会以"她怎么往下掉了"的形式复发。
section('22. 位置存档锚在底边（窗口变高时她不下沉）');
{
  const seg = (mainJs.match(/ipcMain\.handle\('pet:savePos'[\s\S]*?\}\);/) || [''])[0];
  if (!/bottom\s*:\s*p\.y\s*\+\s*winSize\(\)\.h/.test(seg)) {
    bad("pet:savePos 没有把底边一起存下来",
      '只存左上角的话，窗口一变高（比如留白比例又调了）她就会整体下沉');
  } else {
    ok('pet:savePos 同时存了底边（bottom = 夹紧后的 y + 当前窗口高）');
  }
  // 启动还原：优先 bottom，没有才退回 y（老存档没有 bottom 字段）。
  // 切 createPet 自己的函数体 —— 别按 whenReady 去切：createPet 是独立函数，
  // 那段正则要么匹配不到、要么把别的函数圈进来（第一版就是这么报的假失败）。
  const createPet = (mainJs.match(/function createPet\(\)\s*\{[\s\S]*?\n\}/) || [''])[0];
  if (!/saved\.bottom\s*-\s*h/.test(createPet)) {
    bad('createPet 没有按底边还原位置',
      '存档里有 bottom 就该用它换算 y（bottom - 当前窗口高），否则等于白存');
  } else if (!/Number\.isFinite\(saved\.bottom\)/.test(createPet)) {
    bad('createPet 没做老存档兼容',
      '老存档没有 bottom 字段，不判 isFinite 会算出 NaN，窗口直接开在屏幕外');
  } else {
    ok('createPet 优先按底边还原，老存档（无 bottom）退回按 y 落位');
  }
  // 底边还原必须先于 clampPos —— 夹紧是最后一道，不能拿没换算的 y 去夹
  const m = createPet.match(/clampPos\(\s*saved\.x\s*,\s*([\s\S]{0,80}?),/);
  if (!m) {
    bad('createPet 里找不到按存档还原位置的那次 clampPos');
  } else if (!/Number\.isFinite\(saved\.bottom\)/.test(m[1])) {
    bad('createPet 把没换算过的 y 直接交给了 clampPos', '窗口高度变了之后位置就错了');
  } else {
    ok('换算在夹紧之前（先按底边换算出 y，再交给 clampPos 夹进工作区）');
  }
}

// ---------- 23. 所有 JS 必须能编译 ----------
// 为什么需要这一节：v3.6 收尾时我"顺手"删了一个换行，把 `// 注释` 和紧随其后的
// `}` 并成了一行 —— 注释把右花括号吃掉了，pet.js 整份文件语法错误。
// 而当时**自检 288 项全绿**：它只比对文本，不编译。真机上的表现是页面静默变空，
// 一句报错都没有。这类"文本看着都对、其实编译不过"的失败必须自己有一节。
// 用 vm.Script 只编译不执行 —— 不会碰到 DOM / Electron，纯粹做语法检查。
section('23. JS 语法（能编译，不执行）');
{
  const vm = require('vm');
  const files = ['main.js', 'preload.js', 'clamp.js',
                 'renderer/pet.js', 'renderer/dialogue.js', 'renderer/stats.js'];
  let badN = 0;
  for (const f of files) {
    const code = read(f);
    if (code === null || code === undefined) { bad(`读不到 ${f}`); badN++; continue; }
    try {
      new vm.Script(code, { filename: f });
    } catch (e) {
      bad(`${f} 语法错误（整份文件不会执行）`, String(e.message || e).split('\n')[0]);
      badN++;
    }
  }
  if (!badN) ok(`${files.length} 份 JS 全部能编译`);
}

// ---------- 24. 打扰等级 / 空闲检测 / 健康提醒 / 收边 / 冷落 / 盯着看（v3.8）----------
// 这一版加的六件事里有五件属于"不报错、只是行为不对"：
//   · 闸门漏了一处           -> 开了安静，她还在某条路径上叨叨（读代码看不出来）
//   · 收边没跳过几何自愈     -> 20 秒一次的巡检把她从屏幕边上拽回来（像卡顿）
//   · 提醒没判"你在不在"     -> 你不在家它也计时，回来一口气连发三条
//   · 冷落期忘了在计分前进 -> 她"不理你"但照旧给你加分
//   · 探头只有一个阈值       -> 光标停在阈值上她每 120ms 抽一下
// 所以每一件都得有一条盯着它的断言，否则下一个人"顺手简化一下"就没了。
section('24. 打扰等级 / 空闲检测 / 健康提醒 / 收边 / 冷落 / 盯着看（v3.8）');

{
  // —— 打扰等级 ——
  const CH_KEYS = ['quiet', 'normal', 'lively'];
  if (CH_KEYS.every((k) => new RegExp("\\['" + k + "',\\s*'").test(mainJs))) {
    ok('主进程有 chatter 三档表（安静 / 适中 / 活泼）');
  } else {
    bad('主进程少了 chatter 档位表', '两个菜单都列不出来');
  }
  // ★ 两个入口都要广播：setChatter（菜单点出来的）和 settings:set 分支
  //   （渲染层自己调的）。断言必须**分别**盯，不能只写"main.js 里出现过
  //   一次 send('chatter'" —— 那样删掉其中一个入口，另一处还替它撑着，
  //   断言照样绿，而坏掉的那条路径完全静默。
  const setChatterSeg = (mainJs.match(/function setChatter\(k\) \{[\s\S]*?\n\}/) || [''])[0];
  const setSetSeg = (mainJs.match(/ipcMain\.handle\('settings:set'[\s\S]*?\n\}\);/) || [''])[0];
  if (/send\('chatter'/.test(setChatterSeg) && /send\('chatter'/.test(setSetSeg)) {
    ok('两个改 chatter 的入口都会广播给渲染层（菜单 / settings:set）');
  } else {
    bad('有个入口改了 chatter 却没广播给渲染层',
      '三个档的作用全在渲染层，漏掉一个入口 = 那条路径上点了没反应、要等重启');
  }
  // 唯一的拦截点。选 quote() 而不是"给每处台词标频道"的全部理由见 pet.js 的说明。
  if (/if \(idleMute > 0\) return;/.test(petJs)) {
    ok('安静档从 quote() 这一处静音（唯一的台词出口，没有漏网路径）');
  } else {
    bad('quote() 里没有 idleMute 闸门', '安静档会漏掉全部主动台词');
  }
  if (/if \(!talkOK\(\)\) idleMute\+\+/.test(petJs) && /finally \{ if \(!talkOK\(\)\) idleMute--/.test(petJs)) {
    ok('行为链每一拍 try/finally 配对地开关静音');
  } else {
    bad('行为链没有成对地开关 idleMute',
      '漏掉还原（比如某一拍抛错）会让后续台词**永久**被吞，而她还照常在动 —— 看起来只是"她不爱说话了"');
  }
  const approachSeg = (petJs.match(/function idleApproach\(\) \{[\s\S]*?\n\}/) || [''])[0];
  if (/talkOK\(\)/.test(approachSeg)) {
    ok('主动靠近在安静档下不做');
  } else {
    bad('idleApproach 没有安静档闸门', '"她走过来看你"本身是最明显的打扰');
  }
  const typingSeg = (petJs.match(/function handleTyping\(t\) \{[\s\S]*?\n\}/) || [''])[0];
  if (/talkOK\(\)/.test(typingSeg) && /sfx\('type'\)/.test(typingSeg)) {
    ok('打字搭话在安静档下不出声，但打字音保留');
  } else {
    bad('handleTyping 的台词没有安静档闸门', '她会在你打字时照旧叨叨');
  }
  if (/CHAIN_GAP_SCALE/.test(petJs)) {
    ok('活泼档通过链间静默 + 入口权重改变"话痨程度"');
  } else {
    bad('活泼档没有改变任何节奏', '那"活泼"只是一句空话');
  }

  // —— 空闲检测 ——
  if (/powerMonitor\.getSystemIdleTime\(\)/.test(mainJs)) {
    ok('主进程用系统空闲判定"你在不在"');
  } else {
    bad('没有用 powerMonitor.getSystemIdleTime()',
      '那"你在不在"只能退回"你多久没点她"——这两件事完全不同');
  }
  if (/IDLE_AWAY_SEC/.test(mainJs)) {
    ok('空闲阈值是有名常量（2 分钟的取舍写在旁边）');
  } else {
    bad('空闲阈值写死在判断里', '下一个想调的人只能猜');
  }
  // 光有常量不算数 —— 它必须**在两处**都真的被拿去比较：
  // pollIdle（状态变化时才广播）和 pet:getIdle（启动时问一次）。
  // 只写"main.js 里出现过这个比较"是不够的：删掉其中一处，另一处还替它撑着，
  // 断言照样绿，而坏掉的那条路径完全静默（实测踩过）。
  const idleChecks = (mainJs.match(/const active = idle < IDLE_AWAY_SEC;/g) || []).length;
  if (idleChecks >= 2) {
    ok(`空闲阈值在两处都真的参与了判定（pollIdle / pet:getIdle）`);
  } else {
    bad(`空闲阈值只出现在 ${idleChecks} 处判定里（应当 ≥2）`,
      '常量在、但有一条路径用的是别的条件 —— 那条路径上"你在不在"是错的');
  }
  const sleepSeg = (petJs.match(/function sleepCheck\(\) \{[\s\S]*?\n\}/) || [''])[0];
  if (/if \(userActive\) return;/.test(sleepSeg)) {
    ok('睡着判定改用"你在不在"（你在，她就不睡）');
  } else {
    bad('sleepCheck 还在用 lastInteract',
      '你在隔壁窗口连写两小时代码，她会被判成"独处"而整段整段地睡');
  }
  if (/ipcMain\.handle\('pet:getIdle'/.test(mainJs) && /getIdle: \(\) => ipcRenderer\.invoke\('pet:getIdle'\)/.test(preloadJs)) {
    ok('有 pet:getIdle 入口（开机自启时先问一次真实状态）');
  } else {
    bad('没有 pet:getIdle 通路', '启动那一刻就已是"你不在"时，她会先当你回来了');
  }
  const bootSeg = (petJs.match(/\(async \(\) => \{[\s\S]*?\}\)\(\);/) || [''])[0];
  if (/getIdle/.test(bootSeg)) {
    ok('渲染层启动时主动问一次"你在不在"');
  } else {
    bad('渲染层启动时没问',
      '主进程的 activity 广播是**变化才发**的 —— 她会在开机自启时先问一句好、然后才睡');
  }

  // —— 健康提醒 ——
  const HR = ['sit', 'water', 'eye'];
  if (HR.every((k) => new RegExp(k + ':\\s*\\{ ms:').test(mainJs))) {
    ok('三类提醒（久坐 / 喝水 / 护眼）都有各自的定义');
  } else {
    bad('HEALTH_RULES 少了某一类');
  }
  // 两条前提分开判（而且事实只读一次盘 —— 见 main.js 里 healthTick 的说明）。
  // 断言也分开盯：合成一句 `!userActive || quietActive()` 时，只写一条正则
  // 就等于"两件事里任意一件在就行"，删掉另一半照样绿。
  if (/if \(!userActive\) return;/.test(mainJs) && /Number\(s\.quietUntil\) > now\) return;/.test(mainJs)) {
    ok('你不在 / 她藏着的时候都不累计（两条前提各判各的）');
  } else {
    bad('健康计时没判"你在不在 / 她可不可见"',
      '你不在家它也照样计时，回来一口气连发三条 —— 这正是这类功能被关掉的原因');
  }
  if (/const s = readSettings\(\);[\s\S]{0,400}healthAccum\[k\] \+= dt;/.test(mainJs)) {
    ok('健康巡检整拍只读一次设置（不是每个 key 各读一次盘）');
  } else {
    bad('健康巡检每拍重复读设置文件', '每 10 秒同步读四次盘，纯属白给的开销');
  }
  if (/Math\.min\(now - healthTickAt, 30000\)/.test(mainJs)) {
    ok('累计单拍按 30 秒封顶');
  } else {
    bad('健康计时没有封顶',
      '笔记本合盖几小时再打开，dt 是几小时 -> 三类提醒同时炸出来');
  }
  if (/healthOn\(/.test(mainJs) && /function setHealth\(/.test(mainJs)) {
    ok('每一项都能单独关');
  } else {
    bad('没有单项开关', '"提醒关不掉"是这类功能被卸载的头号原因');
  }
  if (/nextHealthText/.test(mainJs) && /tray\.setToolTip/.test(mainJs)) {
    ok('托盘悬停显示"下次提醒"（每分钟刷一次）');
  } else {
    bad('托盘看不到下次提醒', '用户只能被动等它冒出来');
  }
  if (!/new Notification\(/.test(mainJs)) {
    ok('不弹系统通知（形态保持"抬头说一句就走"）');
  } else {
    bad('用了系统通知', '这与"不抢焦点、非侵入"的约定相反 —— 用户要的是她本人来说');
  }
  if (/QUOTES\.health\[k\]/.test(petJs)) {
    ok('提醒台词按类别取（health.sit / water / eye）');
  } else {
    bad('提醒没接台词', '那"抬头说一句"就只剩抬头');
  }

  // —— 边缘收边（迷你模式）——
  if (/edge: 'left' \}/.test(petJs) && /edge: 'right' \}/.test(petJs)) {
    ok('snapX 同时判定"吸附"与"收边"（同一个条件，不会出半吊子状态）');
  } else {
    bad('snapX 没有返回 edge',
      '吸附与收边分成两处判断，迟早出现"吸过去了却没缩起来"或"缩起来了其实没贴边"');
  }
  if (/function applyEdgePos/.test(mainJs) && /function setEdge/.test(mainJs)) {
    ok('主进程有收边的位置计算（纯位置，不动窗口尺寸）');
  } else {
    bad('主进程没有实现收边');
  }
  const enfSeg = (mainJs.match(/function enforceSize\(\) \{[\s\S]*?\n\}/) || [''])[0];
  if (/if \(edgeMode\) \{ applyEdgePos\(\); return; \}/.test(enfSeg)) {
    ok('几何巡检在收边时不做"夹回屏幕内"');
  } else {
    bad('enforceSize 会把收边的她夹回屏幕内', '20 秒一次的巡检让她在屏幕边缘来回抽动');
  }
  const resnapSeg = (mainJs.match(/function resnap\(\) \{[\s\S]*?\n\}/) || [''])[0];
  if (/if \(edgeMode\) \{ applyEdgePos\(\); return; \}/.test(resnapSeg)) {
    ok('换装 / 缩放后收边位置按新尺寸重算（不会把她拽出来）');
  } else {
    bad('resnap 没处理 edgeMode', '换件衣服她就从屏幕边上被拽回屏幕里');
  }
  if (/if \(edgeMode\) setEdge\(null\);/.test(mainJs)) {
    ok('一开始拖拽就退出收边（你的手和贴边逻辑不会各写各的位置）');
  } else {
    bad('拖拽没退出收边', '你在手底下拖她，贴边逻辑还在按自己的公式写位置 —— 会抽动');
  }
  const edgeResets = (mainJs.match(/setEdge\(null\);/g) || []).length;
  if (edgeResets >= 3) {
    ok(`取消收边有 ${edgeResets} 处入口（拖拽 / 两个菜单的"回到右上角" / 菜单开关）`);
  } else {
    bad('取消收边的入口不全', '点了"回到屏幕右上角"她还是一半身子在屏幕外');
  }
  // 同一条道理：`EDGE_OUT` 声明着不用也能骗过"两个常量都存在"这种检查，
  // 所以盯的是**滞回表达式本身**，而且左右两处都要有。
  const hyst = (mainJs.match(/\(edgePeek \? EDGE_OUT : EDGE_IN\)/g) || []).length;
  if (hyst >= 2) {
    ok('探头用滞回（左右两侧都按"进 90 / 出 150"两个阈值判）');
  } else {
    bad(`滞回只用在 ${hyst} 处（左右应当各一处）`,
      '光标停在单一阈值上时她每 120ms 探头又缩回，看起来像抽搐');
  }
  if (/if \(edgeReq\) reqEdge\(null\);/.test(petJs)) {
    ok('点她一下 = 取消收边（除了菜单还有一条直觉路径）');
  } else {
    bad('收边状态下点她没有恢复路径', '用户只能去翻菜单才叫得回来');
  }
  if (/if \(edge\) reqEdge\(edge\);/.test(petJs)) {
    ok('落地收尾**之后**才请求收边（不会和落体抢位置）');
  } else {
    bad('收边时机不对', '先收边再落地，两者会互相打架 —— 她落到一半被拽回去');
  }

  // —— 连戳冷落 ——
  if (/IGNORE_HITS/.test(petJs) && /IGNORE_WINDOW/.test(petJs) && /IGNORE_MS/.test(petJs)) {
    ok('冷落的三个参数都有名（次数 / 统计窗口 / 持续时长）');
  } else {
    bad('冷落参数不明', '别人没法判断"6 秒内 6 次"是不是想要的');
  }
  const clickSeg = (petJs.match(/wrap\.addEventListener\('click'[\s\S]*?\n\}\);/) || [''])[0];
  if (clickSeg.indexOf('if (ignoring)') >= 0 &&
      clickSeg.indexOf('if (ignoring)') < clickSeg.indexOf("gain('click')")) {
    ok('冷落期的 return 排在计分**之前**（"不理你"就真的不给分）');
  } else {
    bad('冷落期内仍然会加分', '那"烦她"依旧没有代价，冷落只剩一个动画');
  }
  if (/noteHit\(\)/.test(clickSeg)) {
    ok('点击走 noteHit 累积（和冷落判定共用同一个时间窗口）');
  } else {
    bad('点击没有计入冷落判定');
  }

  // —— 被盯着看 ——
  const stareSeg = (petJs.match(/function doStare\(\) \{[\s\S]*?\n\}/) || [''])[0];
  if (/STARE_CD/.test(stareSeg)) {
    ok('盯着看有冷却（鼠标停在她身上其实是常态）');
  } else {
    bad('盯着看没有冷却', '鼠标一停住她每两秒就来一句');
  }
  if (/state\.mode !== 'idle'/.test(stareSeg)) {
    ok('盯着看只在她空闲时触发（不做自己的事时才理你）');
  } else {
    bad('盯着看没判模式', '她在看书、走动、番茄钟里都会被鼠标扫过打断');
  }

  // —— v3.8 多读了一样东西，"读了什么"必须写在说明里 ——
  //   和第 13 节守键盘钩子那条同一个理由：功能会上线，说明可能忘了写，
  //   而"没写"是用户**检查不到**的那一侧（他没法从行为上看出你在读空闲）。
  const disc24 = read('DISCLAIMER.md') || '';
  if (/getSystemIdleTime/.test(disc24) && /空闲/.test(disc24)) {
    ok('DISCLAIMER.md 里写明了「系统空闲时长」这项读取');
  } else {
    bad('DISCLAIMER.md 没写系统空闲的隐私说明',
      'v3.8 起主进程每 5 秒读一次系统空闲时长（判断你在不在），' +
      '说明里必须写明它只返回一个秒数、不落盘、不发送');
  }
}

// ---------- 25. 状态帧（v3.9 差分图层 → v3.10 区域帧） ----------
section('[25] 状态帧（立绘不再只有几张静态图）');
// v3.9 推翻了"眨眼已移除、只剩一张静态图"那个结论（见 README 第二节与 pet.js 的
// 「关于眨眼」注释）。代价是引入了一份**新的三方对齐关系**：
//
//     ① pet.js 的 OUTFITS[key].layers   渲染层按它去取槽位
//     ② assets/sprites/<key>/manifest.json   素材侧的实际产物与质检数
//     ③ assets/sprites/<key>/*.png            磁盘上的文件
//
// 三者分属不同文件，改一处**不会报错**，只会静默降级成"这一档不眨眼"
// （applyLayer 拿不到图就退回基准立绘自带的睁眼）。那在画面上只表现为
// "偶尔没反应" —— 截图看不出来，也没法从行为上判断是设计如此还是接线断了。
// 所以下面每一条都单独断言，而不是"反正启动不报错"。
//
// v3.10 把层的**形状**换了（小椭圆差分块 → 掩膜内的整块区域帧），于是多了一条
// 比上面那条对齐关系更硬的约束：
//
//     框外 alpha 必须恰好为 0 ⇒ 叠加结果在框外**逐位等于基准**
//
// 这一条是"整块重绘但不抖"的全部依据。它是**可以逐像素验的**，所以下面会真的
// 去解 PNG 的 alpha 通道来核，而不是相信 manifest 里那句 `alpha_outside_max: 0`
// —— 素材自己报的数只能证明"生成脚本这么算过"，证明不了"文件里真的是这样"。
const LAYER_KEYS = ['maid', 'sailor', 'coat', 'winter'];
// v3.11 加了 walk（走动两帧）。它和 eye/mouth 有一个本质区别：
// 可见性**不由渲染层的 .on 开关决定**，而由 CSS 按步周期硬切（见 pet.css 的
// .frame.hem）。所以下面那些槽位/文件/尺寸的断言照样适用，
// 但"到底显示没显示"要去看 tools/probe_walk.js 的读数。
const LAYER_KINDS = ['eye', 'mouth', 'walk'];
// v3.11 起，四套的层数**并不相同** —— 这是素材本身限定的，不是漏做：
//   · maid  / coat：胸像构图，画面里根本没有下装，"走动帧"无从谈起
//   · coat 另外还**没有嘴**：围巾把嘴整个遮住，做一层永远看不见的嘴帧没有意义
//   · sailor：下半身（裙摆）只占立绘高的 8.75%，源图要 30~40px 的位移才在桌面尺寸下
//     看得出来（20px 换算到显示只有 10px，放大 4 倍才勉强分辨）⇒ 做了也看不见
//   · winter：唯一全身像，下半身占 25% ⇒ 只有它做 walk
// 所以这里把"允许缺哪个、为什么缺"写成表，而**不是**把 walk 从 LAYER_KINDS 里删掉：
// 删掉的话，winter 哪天漏做 walk 也没人拦得住 —— 而"没做"和"漏做"在屏幕上是一样的。
const KIND_OPTIONAL_WHY = {
  maid: { walk: '胸像构图，画面里没有下装' },
  sailor: { walk: '裙摆只占立绘高的 8.75%，桌面显示尺寸下摆动看不见（实量，见 featmask.py 的 _hem 段）' },
  coat: {
    mouth: '嘴被围巾整个遮住 —— 做一层永远看不见的嘴帧没有意义',
    walk: '胸像构图（围巾以下就出画了）',
  },
  winter: {},
};
// 单层体积上限。v3.9 卡到 160 KB 时，每层只装改动的那几百像素（~30 KB），
// 160 KB 用来抓"透明区没清干净"（那时是 745 KB）。v3.10 每层装的是**掩膜内
// 整张脸的重绘**（实测 207~214 KB），体积本身不再是"对不对"的信号 ——
// 正确性交给下面两条逐像素断言，这个数退化成防跑飞的回归线。
const LAYER_MAX_KB = 320;
const TONE_OFF_MAX = 6;      // "掩膜外色偏"上限（裸编辑整张重绘那一版是 17~90）

function pngInfo(p) {
  if (!exists(p)) return null;
  const b = fs.readFileSync(R(p));
  if (b.length < 26 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25], kb: b.length / 1024 };
}

// 真的把 PNG 解成像素。只为下面两条断言服务：
//   · roi 之外 alpha 全为 0        —— "框外逐位等于基准"的前提
//   · alpha 为 0 处 RGB 也必须为 0 —— 否则透明区那一片噪声会按 10 倍撑大文件
// 这两条都能从 manifest 里"读出来"，那样就毫无意义（自己报自己）；只有解开
// 真实的文件才叫验证。只支持 8bit RGBA 非隔行 —— 正是 mklayer/mkframe 写出来的格式，
// 万一哪天换了格式，返回 null 会比"悄悄跳过检查"更容易被发现。
function pngPixels(p) {
  const buf = fs.readFileSync(R(p));
  let pos = 8, W = 0, H = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      W = data.readUInt32BE(0); H = data.readUInt32BE(4);
      depth = data[8]; ctype = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || ctype !== 6 || interlace !== 0 || !W || !H) return null;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch (e) { return null; }
  const bpp = 4, stride = W * bpp;
  if (raw.length < (stride + 1) * H) return null;
  const out = Buffer.alloc(stride * H);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < H; y++) {
    const base = y * (stride + 1);
    const ft = raw[base];
    const line = Buffer.from(raw.subarray(base + 1, base + 1 + stride));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const up = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (ft === 1) v = (v + a) & 255;
      else if (ft === 2) v = (v + up) & 255;
      else if (ft === 3) v = (v + ((a + up) >> 1)) & 255;
      else if (ft === 4) {
        const q = a + up - c;
        const pa = Math.abs(q - a), pb = Math.abs(q - up), pc = Math.abs(q - c);
        v = (v + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? up : c))) & 255;
      } else if (ft !== 0) return null;
      line[x] = v;
    }
    line.copy(out, y * stride);
    prev = line;
  }
  return { w: W, h: H, px: out };
}

const oufSeg = (petJs.match(/const OUTFITS = \{[\s\S]*?\n\};/) || [''])[0];
if (!oufSeg) bad('读不到 pet.js 的 OUTFITS 表');
// 取某个套装自己那一块（缩进两级的键），别把别的套装或嵌套字段读进来
function outfitBlock(key) {
  const i = oufSeg.indexOf('\n  ' + key + ':');
  if (i < 0) return null;
  const rest = oufSeg.slice(i + 1);
  const j = rest.search(/\n  \w+:\s*\{|\n\};/);
  return j < 0 ? rest : rest.slice(0, j);
}
// 槽位表 `eye: { half: 'eye_half', closed: 'eye_closed' }` -> { half: 'eye_half', ... }
function slotsOf(blk, kind) {
  const m = blk.match(new RegExp(kind + ":\\s*\\{([^}]*)\\}"));
  if (!m) return null;
  const out = {};
  for (const p of m[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)) out[p[1]] = p[2];
  return out;
}

const genPy = read('tools/gen_layers.py') || '';
const maskPy = read('tools/featmask.py') || '';
const editNames = new Set([...genPy.matchAll(/^\s{4}"([a-z_]+)":\s*\(/gm)].map((m) => m[1]));
const maskOutfits = new Set([...maskPy.matchAll(/^\s{4}"(\w+)":\s*\{/gm)].map((m) => m[1]));

let layeredCount = 0;
for (const key of LAYER_KEYS) {
  const blk = outfitBlock(key);
  if (blk === null) { bad(`pet.js 的 OUTFITS 里找不到 ${key}`); continue; }
  const manPath = `assets/sprites/${key}/manifest.json`;
  const raw = read(manPath);
  const declares = /layers:\s*\{/.test(blk);

  // —— 素材与接线必须"要么都做、要么都不做" ——
  if (!declares) {
    if (raw !== null) {
      bad(`${key} 没声明 layers，却存在 ${manPath}`,
        '只做了一半 —— 要么在 OUTFITS 里接上 layers，要么把目录删掉；' +
        '留着会让人以为功能已经生效，而屏幕上一动不动');
    } else ok(`${key} 未做差分 → 走降级路径（无 layers、无 manifest）`);
    continue;
  }
  layeredCount++;

  let man = null;
  try { man = raw === null ? null : JSON.parse(raw); } catch (e) { man = null; }
  if (!man) { bad(`${manPath} 缺失或不是合法 JSON`, '渲染层按槽位取图会全部落空'); continue; }
  if (!man.layers || !Object.keys(man.layers).length) {
    bad(`${manPath} 的 layers 是空的`, '声明了 layers 却没有任何层');
    continue;
  }
  // 形态标记。v3.9 = 小椭圆差分块，v3.10 = 掩膜内的区域帧。两者在**同一批文件名**
  // 上编码方式完全不同（一个是"差值"，一个是"框内的成品"），拿错形态去解释
  // 下面的数（changed / alpha）会得出完全相反的结论，所以先把它钉住。
  if (man.mode !== 'region-frame') {
    bad(`${manPath} 的 mode = ${JSON.stringify(man.mode)}，应为 "region-frame"`,
      '形态标记对不上 —— 清单里的 changed/alpha 要按哪种含义读，全看这个字段');
  }

  // —— 尺寸：差分图层必须与基准立绘**同尺寸**且 1:1 对齐 ——
  const base = pngInfo(`assets/sprites/${key}.png`);
  if (!base) bad(`assets/sprites/${key}.png 不是合法 PNG`);
  else if (!Array.isArray(man.size) || man.size[0] !== base.w || man.size[1] !== base.h) {
    bad(`${key}: manifest.size = ${JSON.stringify(man.size)}，基准立绘 ${base.w}x${base.h}`,
      '尺寸一旦不同，叠加就整体错位 —— 而错位在画面上是"她的眼睛歪了"');
  } else ok(`${key}: manifest.size 与基准立绘一致（${base.w}x${base.h}）`);

  // —— 命名约定：槽位名三处必须逐字一致（pet.js / manifest / 文件名 / 生成脚本）——
  const declared = new Map();     // 'eye_closed' -> 'eye.closed'
  for (const kind of LAYER_KINDS) {
    const s = slotsOf(blk, kind);
    // 缺哪一层要分两种情况看：素材本来就做不出来的（见上面 KIND_OPTIONAL_WHY）
    // 是**正常**的，必须明确报成 ok 并把理由写出来；其余才是真漏接。
    // 两者在屏幕上的表现一模一样（都是"这一档没反应"），只能靠这张表区分。
    const why = (KIND_OPTIONAL_WHY[key] || {})[kind];
    if (!s) {
      if (why) ok(`${key} 没有 ${kind} 层 —— ${why}`);
      else bad(`pet.js 的 ${key}.layers 里没有 ${kind} 段`,
        kind === 'walk'
          ? '这套是全身像、画面里看得见下装，walk 漏了 → 走动时身子在动、下装不换'
          : `${key} 按素材是应该有 ${kind} 层的（不在 KIND_OPTIONAL_WHY 里）`);
      continue;
    }
    if (why) {
      bad(`${key} 声明了 ${kind} 层，但按素材它不该有 —— ${why}`,
        '声明了就得有素材，否则渲染层会按槽位去取一张不存在的图');
    }
    for (const [slot, file] of Object.entries(s)) {
      if (file !== `${kind}_${slot}`) {
        bad(`${key}: 槽位 ${kind}.${slot} 指向 '${file}'，按约定应是 '${kind}_${slot}'`,
          '槽位名同时活在四处（OUTFITS / manifest / gen_layers 的 EDITS / 文件名），' +
          '漂一个就会有一档静默取不到图');
      }
      declared.set(file, `${kind}.${slot}`);
    }
  }
  const manFiles = new Set(Object.keys(man.layers));
  for (const f of declared.keys()) {
    if (!manFiles.has(f)) bad(`${key}: pet.js 要 '${f}'，manifest 里没有`);
  }
  for (const f of manFiles) {
    if (!declared.has(f)) {
      bad(`${key}: manifest 里有 '${f}'，pet.js 的 OUTFITS 却没接`,
        '素材做了但没人用 —— 白占体积，而且下次有人会以为它已经生效');
    }
  }
  // ★ 反向也要查：manifest 里有的层，生成脚本必须还有一条能重跑出来的提示词。
  //   否则"素材在仓库里、生成路径却丢了"—— 重跑生成会静默少一层，
  //   而这一层在画面上只是"某一档不眨眼"。
  for (const f of manFiles) {
    if (!editNames.has(f)) {
      bad(`${key}: '${f}' 在 manifest 里，tools/gen_layers.py 的 EDITS 却没有对应条目`,
        '这条素材已经无法从代码复现了 —— 重跑生成会静默丢掉它');
    }
  }
  if (declared.size === manFiles.size && declared.size > 0) {
    ok(`${key}: pet.js 槽位表 / manifest / gen_layers EDITS 三方一致（${declared.size} 层）`);
  }

  // ★ 声明了 walk 层的套装，featmask 里必须有 `_hem`。
  //   这两处的对应关系是"能不能重新生成这套素材"的前提：只有声明没有框的话，
  //   重跑 mkframe 会直接 SystemExit —— 但那要等到重跑时才发现，
  //   而那时素材已经在仓库里、清单里也记着，看起来一切正常。
  const walkSlots = slotsOf(blk, 'walk');
  if (walkSlots && !/"_hem":\s*\(/.test((maskPy.match(
    new RegExp('"' + key + '":\\s*\\{[\\s\\S]*?\\n    \\},')) || [''])[0])) {
    bad(`${key} 声明了 walk 层，featmask 的 FEATURES[${key}] 却没有 '_hem' 框`,
      '重跑生成时 hem_box() 会直接报错，这套走动帧从此无法从代码复现');
  } else if (!walkSlots && /"_hem":\s*\(/.test((maskPy.match(
    new RegExp('"' + key + '":\\s*\\{[\\s\\S]*?\\n    \\},')) || [''])[0])) {
    bad(`${key} 有 '_hem' 框，pet.js 却没声明 walk 层`,
      '框标了却不用 —— 下次有人会以为走动帧已经做了');
  } else if (walkSlots) {
    ok(`${key}: walk 层与 featmask 的 '_hem' 框成对`);
  }

  // —— 逐层：文件在、带 alpha、尺寸对、体积可控、质检数达标、护栏真的生效 ——
  const diskLayers = fs.readdirSync(R(`assets/sprites/${key}`))
    .filter((f) => f.endsWith('.png'));
  for (const f of manFiles) {
    const p = `assets/sprites/${key}/${f}.png`;
    const info = pngInfo(p);
    if (!info) { bad(`${p} 不存在或不是合法 PNG`); continue; }
    const L = man.layers[f] || {};
    // RGBA：透明区必须真的是透明的。存成 RGB（colorType 2）叠上去就是
    // 一整块白/黑方块盖住她的脸 —— 这是"图层"最基础的一条。
    if (info.colorType !== 6) {
      bad(`${p} 的 PNG 颜色类型是 ${info.colorType}，不是 6（RGBA）`,
        '没有 alpha 通道 → 叠加时会用整块底色盖住立绘');
    }
    if (base && (info.w !== base.w || info.h !== base.h)) {
      bad(`${p} 是 ${info.w}x${info.h}，基准立绘是 ${base.w}x${base.h}`);
    }
    // 清单里逐层记的 w/h 是**给人看的记录**（用来判断"这层是不是按当前立绘做的"）。
    // 记录过期不会崩，只会让下一个人拿着一个错的数去核对对齐 ——
    // 所以它必须跟着磁盘上的文件走，而不是跟着生成那一刻的记忆走。
    if ((typeof L.w === 'number' && L.w !== info.w) || (typeof L.h === 'number' && L.h !== info.h)) {
      bad(`${manPath} 的 ${f} 记着 ${L.w}x${L.h}，磁盘上的文件是 ${info.w}x${info.h}`,
        '清单没跟上素材 —— 换过立绘后要重跑 mklayer.py，手改清单不算');
    }
    if (info.kb > LAYER_MAX_KB) {
      bad(`${p} 有 ${info.kb.toFixed(0)} KB（上限 ${LAYER_MAX_KB}）`,
        '多半是透明区的 RGB 没清零 —— 那些像素权重为 0 却照样要存、要传、要解码');
    }
    // "掩膜外色偏"是本方案唯一的量化命门：生成图在掩膜之外有没有被改坏。
    // 掩膜生效时它应当停在 VAE 往返的噪声地板上（实测 2.3~3.5 级）；
    // 裸编辑整张重绘那一版是 17（去噪 0.55）~ 90（去噪 1.0）。
    if (typeof L.tone_off !== 'number') {
      bad(`${manPath} 的 ${f} 没有 tone_off`, '没有这个数就没法判断"基准像素有没有被改坏"');
    } else if (L.tone_off > TONE_OFF_MAX) {
      bad(`${key}/${f} 掩膜外色偏 ${L.tone_off} > ${TONE_OFF_MAX}`,
        '像是没用潜空间掩膜、整张被重采样了 —— 帧间对齐的保证就是靠这个数守住的');
    }
    // —— 区域帧的结构（v3.10 的核心）——
    // 这一组每条都能从真实文件里验出来。上面那些数（alpha_outside_max 之类）
    // 是生成脚本自己报的，只能说明"它这么算过"，所以这里不拿它们当结论。
    if (L.region !== 'face' && L.region !== 'mouthbox' && L.region !== 'hem') {
      bad(`${key}/${f} 的 region = ${JSON.stringify(L.region)}`,
        '不认这个区域名 —— 生成和验收必须按同一块范围算，否则"框外有没有漂移"永远算不出问题');
    }
    const wantRegion = L.kind === 'eye' ? 'face'
      : (L.kind === 'mouth' ? 'mouthbox' : (L.kind === 'walk' ? 'hem' : null));
    if (wantRegion && L.region !== wantRegion) {
      bad(`${key}/${f} 是 ${L.kind} 帧，却用 ${L.region} 区`,
        L.kind === 'eye'
          ? '眼睛必须用整张脸：实算过，闭眼/笑眼的改动有 1 万像素落在五官椭圆之外（最大差 255）' +
            '—— 用椭圆圈住它，框外那截旧睫毛就留下了，正是 v3.9 那个"闭了眼底下还有一道弧"'
          : (L.kind === 'mouth'
            ? '嘴必须用嘴区框：用整张脸的话，这一层的 alpha 会盖住眼区，边眨眼边说话时眼睛会忽然睁开'
            : '走动帧必须用下装框（`_hem`）：它和眼/嘴两块范围**都不许相交** —— ' +
              '下装那一层在走动期间是常亮的，一旦压到脸上，眨眼与说话都会被它盖掉'));
    }
    const mbx = Array.isArray(L.mask_box) ? L.mask_box : null;
    const roi = Array.isArray(L.roi) ? L.roi : null;
    if (!mbx || mbx.length !== 4) {
      bad(`${key}/${f} 没有 mask_box`, '没有它就没法把"改动量"放到正确的分母上比');
    }
    if (!roi || roi.length !== 4) {
      bad(`${key}/${f} 没有 roi`,
        'roi = 掩膜的实际影响范围，是下面"框外 alpha 必须为 0"那条断言的判据');
    } else if (base && (roi[0] < 0 || roi[1] < 0 || roi[2] > base.w || roi[3] > base.h)) {
      bad(`${key}/${f} 的 roi ${JSON.stringify(roi)} 超出画面`);
    } else {
      // ★★ 真正去解像素。两个必须在文件里成立的事实：
      //     ① roi 之外 alpha 全为 0  → 叠加结果在框外逐位等于基准（不抖的**全部**依据）
      //     ② alpha 为 0 处 RGB 也必须为 0 → 透明区没留模型噪声（体积会差一个数量级）
      const px = pngPixels(p);
      if (!px) {
        bad(`${p} 解不出像素（需要 8bit / RGBA / 非隔行）`,
          '这一节的两条核心断言都依赖解码，解不开就等于没验');
      } else {
        let outOpaque = 0, maxOutA = 0, dirtyRgb = 0, opaque = 0;
        for (let y = 0; y < px.h; y++) {
          for (let x = 0; x < px.w; x++) {
            const i = (y * px.w + x) * 4;
            const al = px.px[i + 3];
            if (al !== 0) opaque++;
            if (al === 0) {
              if (px.px[i] || px.px[i + 1] || px.px[i + 2]) dirtyRgb++;
            }
            if (x < roi[0] || y < roi[1] || x >= roi[2] || y >= roi[3]) {
              if (al !== 0) { outOpaque++; if (al > maxOutA) maxOutA = al; }
            }
          }
        }
        if (outOpaque) {
          bad(`${key}/${f}: roi 之外还有 ${outOpaque} 个不透明像素（最大 alpha ${maxOutA}）`,
            '框外一旦不是 alpha=0，叠加出来的就不再逐位等于基准 —— 眨眼时她会抖，' +
            '而这正是区域帧存在的全部理由');
        } else ok(`${key}/${f}: roi 之外 alpha 全为 0（${px.w}x${px.h} 逐像素核过）`);
        if (dirtyRgb) {
          bad(`${key}/${f}: 有 ${dirtyRgb} 个 alpha=0 的像素 RGB 不为 0`,
            '透明区的 RGB 是模型输出的逐像素噪声，权重为 0 却照样要存 —— 不清掉文件会大一个数量级');
        }
        if (!opaque) bad(`${key}/${f} 整层全透明`, '掩膜没圈住任何东西 —— 叠上去等于没有');
        // 改动量放在**掩膜面积**上比，不放在整张画面比：
        // 区域帧本来就会把框内整块重绘，拿整张画面当分母会把"框很大"误判成"模型乱改"。
        if (mbx && typeof L.changed === 'number') {
          const mArea = Math.max(1, (mbx[2] - mbx[0]) * (mbx[3] - mbx[1]));
          if (L.changed < mArea * 0.005) {
            bad(`${key}/${f} 只改了 ${L.changed} px（掩膜区 ${mArea} px）`,
              '像是生成没生效 / 模型没照做 —— 白跑一趟而画面上只表现为"这一档没反应"');
          } else if (L.changed > mArea) {
            bad(`${key}/${f} 改了 ${L.changed} px > 掩膜区 ${mArea} px`, '掩膜没圈住');
          }
        }
      }
    }
    // 改动框必须落在 roi 里：跑出去说明护栏没起作用 ——
    // 那时候模型已经在改眼睛以外的地方了，只是恰好在这次看起来还行。
    if (Array.isArray(L.box) && roi) {
      const [rx0, ry0, rx1, ry1] = roi, [bx0, by0, bx1, by1] = L.box;
      if (roi[0] < 0 || roi[1] < 0) { /* 已在上面报过 */ }
      else if (bx0 < rx0 || by0 < ry0 || bx1 > rx1 || by1 > ry1) {
        bad(`${key}/${f} 的改动框 ${JSON.stringify(L.box)} 超出 roi ${JSON.stringify(roi)}`,
          '护栏没起作用 —— 模型已经改到眼睛以外了');
      }
    }
    for (const [field, label] of [['outside_max_diff', '框外最大像素差'],
                                  ['alpha_outside_max', '框外最大 alpha']]) {
      if (L[field] !== 0) {
        bad(`${key}/${f} 的 ${field} = ${L[field]}`, `${label}必须是 0 —— 生成脚本自己也这么说`);
      }
    }
  }
  // 磁盘上不许有清单外的 PNG：孤儿文件最容易被当成"这层还在用"
  const orphans = diskLayers.filter((f) => !manFiles.has(f.replace(/\.png$/, '')));
  if (orphans.length) {
    bad(`${key} 目录里有清单外的 PNG：${orphans.join(', ')}`,
      '孤儿图层最容易被当成"这一档还在用"，而渲染层根本取不到它');
  } else ok(`${key}: 目录与清单逐文件对齐（${diskLayers.length} 个 PNG）`);

  // —— 眨眼的两条硬依赖 ——
  // ① 闭眼是底线：没有 closed 就没有眨眼，而不是"眨得少一点"。
  // ② half 决定眨眼走三拍还是两拍（pet.js 的 blinkSeq）—— 它必须有，
  //    因为"开→闭→开"在 400px 显示高上看着就是眼睛被替换了一下。
  for (const need of ['eye_closed', 'eye_half']) {
    if (!manFiles.has(need)) bad(`${key} 缺少 '${need}'`, '眨眼序列会退化成两拍 / 直接失效');
  }
  // wink（调皮眨眼）和 happy（对称笑眼）是两种表情，不能是同一个文件 ——
  // "省一个文件"会把"调皮"和"开心"合并成同一个表情，而画面上完全看不出来。
  const w = declared.get('eye_wink'), h = declared.get('eye_happy');
  if (w && h && w === h) bad(`${key}: eye.wink 与 eye.happy 指向同一个文件`, '两种表情被合并了');
  else if (w && h) ok(`${key}: wink / happy 是两个独立图层`);

  // 想重做这套的差分，掩膜标定表必须在 —— 否则得从零重新标一次五官坐标
  if (!maskOutfits.has(key)) {
    bad(`tools/featmask.py 的 FEATURES 里没有 ${key}`,
      '没法重新生成这套的潜空间掩膜 —— 素材将无法重做');
  }
}
if (layeredCount === 0) {
  bad('四套里没有一套声明了差分图层',
    'v3.9 的全部工作就是这件事；一条都没接上说明接线被退回成静态立绘了');
}

// —— DOM 节点：index.html 与 preview.html 都必须是**图层结构** ——
// 少了这两个 img，图层无处可落 —— 而 pet.js 里的 $('#fEye') 会直接抛 TypeError。
// v3.11 把 fHemA/fHemB 也纳进来：走动两帧的已知失效形态正是"两个 img 少了，
// pet.js 拿到 null，loadFrames 静默跳过"—— 那时她照样走，只是下装不换。
// 两边的舞台必须同时改，所以这里对两份 HTML 都查同一组 id。
for (const [f, html] of [['renderer/index.html', indexHtml], ['renderer/preview.html', prevHtml]]) {
  for (const id of ['fEye', 'fMouth', 'fHemA', 'fHemB']) {
    if (new RegExp(`id="${id}"`).test(html)) ok(`${f} 里有 #${id}`);
    else bad(`${f} 里没有 #${id}`, '图层没有落点（真机与无头验收的舞台必须同时改）');
  }
}
for (const id of ['fEye', 'fMouth', 'fHemA', 'fHemB']) {
  if (petJs.includes(`$('#${id}')`)) ok(`pet.js 引用了 #${id}`);
  else bad(`pet.js 没有引用 #${id}`);
}
// 图层必须与基准图**分开**写样式：.frame 上挂着 drop-shadow 和居中定位，
// 图层若继承这套规则，她的眼睛/嘴周围会多出一圈投影，而且位置会偏。
if (/\.frame\.layer\s*\{/.test(read('renderer/pet.css') || '')) {
  ok('图层有独立的样式规则（.frame.layer）');
} else bad('.frame.layer 样式不见了', '图层会继承基准图的 drop-shadow 与定位，画面上多出一圈投影');
// 走动两帧也要有自己那条基础规则。少它的后果各不相同、且都不报错：
//   · filter 没了  → 下装那一块按自己的轮廓多出一圈投影（走起来脚边一直有黑影）
//   · transition 没收到 none → 60ms 的淡入淡出把 260~600ms 的迈步糊成重影
//   · opacity 默认不是 0 → 不走路时两张下装帧直接叠在她身上
const hemBase = (stripComments(read('renderer/pet.css') || '')
  .match(/\.frame\.hem\s*\{([^}]*)\}/) || [, ''])[1];
if (!hemBase) {
  bad('pet.css 里没有 .frame.hem 规则',
    '走动两帧会继承 .frame 的 drop-shadow 与 160ms 过渡，脚边一直挂着一圈黑影');
} else {
  const miss = ['filter:\\s*none', 'pointer-events:\\s*none', 'transition:\\s*none', 'opacity:\\s*0']
    .filter((re) => !new RegExp(re).test(hemBase));
  if (miss.length) bad(`.frame.hem 缺 ${miss.join(' / ')}`, '见上面那条注释里各自的后果');
  else ok('走动两帧有独立的基础样式（无投影 / 不拦截点击 / 不做过渡 / 默认隐藏）');
}
// "这套有没有这个槽位"必须查**套装声明**（hasSlot → OUTFITS.layers），
// 不能查图层的**加载态**（layerImg）。这一条是踩出来的：
// 素材解码完成之前 layerImg() 按 naturalWidth 一律返回 null，于是开机那一两秒里
// "四拍眨眼"会被静默降级成两拍、说话干脆不动嘴 —— 而热重载（图已缓存）
// 永远复现不了，正好是最难查的那一类。
const seqBody = (petJs.match(/function blinkSeq\(\)\s*\{[\s\S]*?\n\}/) || [''])[0];
const talkBody = (petJs.match(/function talkFor\([\s\S]*?\n\}/) || [''])[0];
if (!seqBody || !talkBody) {
  bad('读不到 blinkSeq / talkFor 的函数体', '下面几条判据检查会全部落空');
} else {
  const loadState = [];
  if (/layerImg\(/.test(seqBody)) loadState.push('blinkSeq');
  if (/layerImg\(/.test(talkBody)) loadState.push('talkFor');
  if (loadState.length) {
    bad(`${loadState.join(' / ')} 用图层加载态当判据（该用 hasSlot 查套装声明）`,
      '开机那一两秒素材还没解码，判据会静默变成"这套没这个槽位"：眨眼少两拍、说话不动嘴');
  } else if (!/hasSlot\(/.test(seqBody) || !/hasSlot\(/.test(talkBody)) {
    bad('blinkSeq / talkFor 里找不到 hasSlot 判据', '两处都要按套装声明判断有没有该槽位');
  } else {
    ok('眨眼拍数与口型都按套装声明判据（不吃素材解码时序）');
  }
}
// 无头验收的三个出口必须真的存在 —— 预演页是**按名字**调它们的，
// 少一个就是"wait=layers / noblink=1 静默失效"：截图照样出，
// 但图层可能没解码完、或者被一次随机眨眼拍成半睁，而两种假象都看不出来。
['layersReady', 'onLayersReady', 'freezeBlink'].forEach((fn) => {
  if (new RegExp(`__petDemo[\\s\\S]{0,4000}?${fn}\\s*:`).test(petJs)) {
    ok(`渲染层导出了验收出口 ${fn}`);
  } else {
    bad(`渲染层没有导出验收出口 ${fn}`,
      '预演页的 wait=layers / noblink=1 会静默不生效，验收图变成随机样本');
  }
});
// hash 参数闸门必须由 p.keys() 推导，不能逐项列举。
// 逐项列举已经坑过一次：新加 ro / wait / noblink 时忘了同步进名单，
// 表现是"参数静默失效"，而它和"样式写错了"在截图上完全分不出来。
// ⚠ 判"有没有在列举"要认那条 `!k && !o && !sc` 链本身，不能去认 `if (!k`：
//   列举可能被塞进别的表达式里（例如 `|| (!k && !o && !sc)`），
//   按 `if (!k` 认会漏 —— 这条是负向测试抓出来的（第一版这么写，SILENT）。
// ⚠⚠ 必须先剥注释：上面那段注释里就写着这个被禁的写法，按全文搜会被自己的
//     说明骗过去 —— 也是负向测试抓出来的（改回去之后断言照样通过）。
const prevCode = stripLineComments(prevHtml);
if (!/\.\.\.p\.keys\(\)\]\.length/.test(prevCode)) {
  bad('preview.html 里找不到按 p.keys() 推导的参数闸门');
} else if (/!\s*k\s*&&\s*!o\s*&&\s*!sc/.test(prevCode)) {
  bad('hash 参数闸门又变回逐项列举了', '新增参数会静默失效（本次就是这么踩的）');
} else {
  ok('hash 参数闸门按"有没有参数"判（新参数不可能漏进名单）');
}
// 图层验收那组图必须自己压掉随机变量，否则它出的图**没有判据**。
// 两个具体来源，分别对应两条断言：
//   · 随机眨眼 → 所有验收图共用的 COMMON 片段里必须有 noblink=1
//   · 素材解码时序 → 图层那一组拼 hash 时必须带 wait=layers
// ⚠ 必须在**拼 hash 的那一行**上判，不能在整个函数体里搜 ——
//   函数体的注释里也写着 wait=layers（说明为什么加它），
//   按全文搜会在参数被删掉之后照样通过。这条是负向测试抓出来的。
const rev = read('tools/review.py') || '';
const revLayers = (rev.match(/def run_layers\([\s\S]*?\n    return make_sheet/) || [''])[0];
const revCommon = (rev.match(/^COMMON = "([^"]*)"/m) || [, ''])[1];
// "拼 hash 的那一行" = 同时出现 wait=layers 和 {COMMON} 的那一行（注释里不会有后者）
const revHashLine = revLayers.split('\n')
  .find((l) => l.includes('wait=layers') && l.includes('{COMMON}')) || '';
if (!revLayers) {
  bad('读不到 tools/review.py 的 run_layers');
} else if (!/noblink=1/.test(revCommon)) {
  bad('验收图没关随机眨眼',
    '眨眼间隔随机 3~7s，一次眨眼就能把"睁眼"的格子拍成半睁（和 hold=blush 是同一类问题）');
} else if (!revHashLine) {
  bad('图层验收没有等解码',
    '固定 delay 到点时图层常常还没解码，layerImg() 会静默退回基准立绘 → 与"没接线"长得一样');
} else {
  ok('验收图压掉了两个随机来源（等解码 + 关眨眼）');
}
// 读数核对必须在：图层的"接线通不通"只能由读数判，
// "没生效"和"画法不对"在截图上都是"眼睛看起来没变"。
if (/state_readout/.test(revLayers)) {
  ok('图层验收每格都核对状态读数（不靠看图判断接线）');
} else {
  bad('图层验收没有核对状态读数',
    '图层没生效（没解码完 / 被别的东西盖掉）与画法不对在截图上分不出来');
}
// run_states 里有一个**只有在截图上才看得见**的坑，而且它的两处症状都长得像"产品画错了"：
//   `h = h if "delay=" in h else f"{h}&{COMMON}&delay={D}"`
// 本意只是"自带 delay 的格子别再追加一次 delay"，但它顺手把 COMMON **整条**丢掉了 ——
// 而 run_states 里恰好有两格自带 delay（look / pat）。丢掉的后果：
//   · 丢 noblink → 随机眨眼（3~7s 一次）可能正好落在"目光跟随"那一格，
//                  而那一格的眼睛**就是唯一的验收对象**，拍到闭眼 = 假 bug；
//   · 丢 ro=0     → 右上角调试读数直接压在她头上（同 run_layers / run_bubbles 的理由）。
// 所以判两件事：① COMMON 里得有 ro=0；② 拼 hash 那一步的**每条分支**都得追加 COMMON。
// ⚠ 第 ② 条故意按"{COMMON} 在这一行里出现几次"来判，而不是认某种写法：
//   它的意思就是"两个分支各来一次"。将来若改结构（比如先无条件拼 COMMON、再单独补 delay），
//   断言会喊你 —— 那是**故意的**，它挡的正是"某条分支悄悄少拼一段"这种静默回归。
const revStates = (rev.match(/def run_states\([\s\S]*?\n    return make_sheet/) || [''])[0];
const revStateHash = revStates.split('\n')
  .find((l) => l.includes('{COMMON}')) || '';
if (!revStates) {
  bad('读不到 tools/review.py 的 run_states');
} else if (!/ro=0/.test(revCommon)) {
  bad('验收图没关调试读数',
    '读数固定贴在视口右上，而裁剪框正好覆盖她头顶那一带 → 直接压在角色/气泡上');
} else if ((revStateHash.match(/\{COMMON\}/g) || []).length < 2) {
  bad('run_states 里自带 delay 的格子没吃到 COMMON',
    'look / pat 两格会连带丢掉 noblink 与 ro=0 → 可能拍到闭眼，读数还压在她头上');
} else {
  ok('验收图压掉了随机眨眼与读数（run_states 的每条分支都拼 COMMON）');
}

// ---------- 26. 真机探针的"量法"（v3.10）----------
// 为什么这条要进静态自检：探针里"角色在哪"一旦用错口径，断言**不会**稳定报错，
// 它只在**某些光标位置**上报错 —— 等于把正确的实现报成错的。v3.10 之前 ② 就是这样：
// 用 getBoundingClientRect 量位置，而 rect 含 transform，于是 #lookWrap 的目光跟随
// （±9px，随光标变）和 #petWrap 的呼吸（1.2%）会被当成"她移动了"。
// 实测同一个窗口位置（x 都是 −188）读出三个数：179.4 / 171.8 / 189.2，
// 而布局口径恒为 178.5（= 角色宽 389 × 0.46）。
// 静态自检碰不到真窗口，但碰得到**量法这个写法本身** —— 这正是它该管的事。
const probeSrc = read('tools/probe_v38.js') || '';
const probeCode = stripLineComments(probeSrc);
if (!probeSrc) {
  bad('读不到 tools/probe_v38.js',
    '它是唯一的真机验收：自检与预览页都碰不到主进程行为（详见同名文件的头注释）');
} else if (!/const petLayout = /.test(probeCode)) {
  bad('probe_v38.js 里没有 petLayout',
    '位置断言必须走布局口径；用 rect 会让"推出量"随光标摆动 ±9px（目光跟随层）');
} else {
  const layDef = (probeCode.match(/const petLayout = \(\) => js\(`([\s\S]*?)`\)/) || [, ''])[1];
  if (!/offsetLeft/.test(layDef) || !/offsetWidth/.test(layDef)) {
    bad('probe_v38.js 的 petLayout 不再用 offsetLeft / offsetWidth',
      '只有布局值对 transform 免疫；换成 getBoundingClientRect 就又把目光跟随与呼吸算进位置了');
  } else {
    ok('真机探针的位置来自布局口径（offsetLeft / offsetWidth）');
  }
  // rect 只允许出现在那一个诊断方法里。靠"出现次数"卡住，不靠方法名 ——
  // 换个名字再写一条 rect 断言同样能拦住。
  const rectUses = (probeCode.match(/getBoundingClientRect/g) || []).length;
  if (rectUses > 1) {
    bad(`probe_v38.js 里有 ${rectUses} 处 getBoundingClientRect（只允许 1 处，留给诊断备注）`,
      '多出来的那处多半又变成了断言：rect 含 transform，同一个窗口位置能读出好几个数');
  } else {
    ok('rect 口径只留在诊断备注里，位置断言没有用它');
  }
}

// ---------- 27. 走路步态：重量感写在曲线上（v3.11）----------
// 为什么这条要进静态自检：走路的**全部信息都在动画曲线上**，而曲线恰恰是"改一处、
// 忘一处"最容易悄悄带坏的东西 —— 带坏之后她仍在上下动，截图上看着一切正常：
//   · `animation` 简写里给一个缓动函数 -> 两段共用同一种手感 -> 退回"匀速滑下去"（飘）
//   · `alternate` 掉了 -> 仍在动，只是变成**原地左右抖**，不再是一步一倾
//   · `--step-ms` 没接到 duration 上 -> walk() 按速度写进去的那个变量成了死代码
// 曲线**逐点采样的形状**由 tools/probe_walk.js 在真窗口里验（它能把动画钉在相位上读
// transform）；这里守的是**结构**：这几个字必须还在，而且必须彼此不同。
section('[27] 走路步态（v3.11）');
const walkCss = stripComments(read('renderer/pet.css') || '');
const walkRule = (walkCss.match(/#petWrap\.walk\s*\{([^}]*)\}/) || [, ''])[1];
const walkKf = (walkCss.match(/@keyframes\s+walkb\s*\{([\s\S]*?)\n\}/) || [, ''])[1];
const kfDecl = (pct) => {
  const m = walkKf.match(new RegExp('(?:^|\\n)\\s*' + pct + '%\\s*\\{([^}]*)\\}'));
  return m ? m[1] : '';
};
const kN = (pct, re) => {
  const m = kfDecl(pct).match(re);
  return m ? Number(m[1]) : null;
};
const kTy = (pct) => kN(pct, /translateY\(\s*(-?[\d.]+)px/);
const kRot = (pct) => kN(pct, /rotate\(\s*(-?[\d.]+)deg/);
const kScale = (pct) => {
  const m = kfDecl(pct).match(/scale\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
};
const kTf = (pct) => ((kfDecl(pct).match(/animation-timing-function:\s*([^;]+);/) || [, ''])[1]).trim();

if (!walkRule || !walkKf) {
  bad('pet.css 里找不到 #petWrap.walk 规则或 @keyframes walkb',
    'v3.11 的步态（落地压扁 + 顿挫 + 一步一次左右倾）整个在这两处');
} else {
  const t0 = kTy(0), t50 = kTy(50), t100 = kTy(100);
  if (t0 === null || t50 === null || t100 === null) {
    bad('walkb 读不出 0% / 50% / 100% 三个相位的 translateY',
      '一个循环 = 一步：0% 触地 -> 50% 过腿 -> 100% 下一次触地');
  } else if (t0 !== t100) {
    bad(`walkb 的 0% 与 100% 不在同一高度（${t0} vs ${t100}）`,
      '两个端点都是"触地"，高度必须相同；不同的话 alternate 反放时两步落地不一样深 = 看起来瘸');
  } else if (!(t50 < t0 - 2)) {
    bad(`walkb 过腿（50%）没有明显高于触地（${t50} vs ${t0}）`,
      '过腿必须抬起来，否则没有起伏');
  } else {
    ok(`步态三相位齐全（触地 ${t0}px / 过腿 ${t50}px，行程 ${(t0 - t50).toFixed(1)}px）`);
  }

  const s0 = kScale(0), s50 = kScale(50);
  if (!s0 || !s50) {
    bad('walkb 的关键帧里没有 scale', '落地压扁是"重量"的一半（另一半是缓动）');
  } else if (!(s0[1] < 1 && s0[0] > 1)) {
    bad(`触地没有压扁（scale ${s0[0]}, ${s0[1]}）`,
      '触地应当是竖着缩、横着涨；#petWrap 的 transform-origin 是 50% 100%，所以缩=往下压');
  } else if (!(s50[1] > 1 && s50[0] < 1)) {
    bad(`过腿没有拉长（scale ${s50[0]}, ${s50[1]}）`, '过腿是反过来的：竖着涨、横着缩');
  } else {
    ok(`落地压扁 / 过腿拉长都在（${s0.join('/')} -> ${s50.join('/')}）`);
  }

  const r0 = kRot(0), r50 = kRot(50), r100 = kRot(100);
  if (r0 === null || r50 === null || r100 === null) {
    bad('walkb 的关键帧里读不出 rotate', 'rotate 决定"这一步往哪边倾"');
  } else if (!(r0 * r100 < 0 && Math.abs(Math.abs(r0) - Math.abs(r100)) < 0.05)) {
    bad(`两端倾斜没有互为镜像（${r0}° / ${r100}°）`,
      '两端都必须是"这一步的极限倾角"；同号的话两步倾同一侧，看着像被风吹歪');
  } else if (Math.abs(r50) > 0.15) {
    bad(`过腿时没有回正（rotate ${r50}°）`, '过腿那一刻身体是中的，倾角应当经过 0');
  } else {
    ok(`一步一次左右倾（${r0}° -> ${r50}° -> ${r100}°）`);
  }

  // ★ 这条是整套设计的支点：**两段缓动必须不同**。
  //   简写里给一个（或干脆不写，用 animation 级那个）会让上升与下落同手感 ——
  //   而"接近地面时在加速"正是"重量"的来源，退化成对称的 ease-in-out 就又是飘。
  const f0 = kTf(0), f50 = kTf(50);
  if (!f0 || !f50) {
    bad('walkb 的关键帧上没有各自的 animation-timing-function',
      '缓动必须写在关键帧里；写在 animation 简写里会被两段共用');
  } else if (f0 === f50) {
    bad(`两段用了同一个缓动函数（${f0}）`,
      '上升要"快起慢收"、下落要"慢起快砸"；相同就退回匀速滑下去');
  } else {
    ok(`上升与下落手感不同（${f0} / ${f50}）`);
  }

  // ---- 走动两帧（下装层）。可见性不由 .on 开关写，而由这两条动画按步周期硬切 ----
// 三种失效都只在读数上分得清："两块都 opacity:0"（= 什么都没显示）、
// "两块都显示"（= 迈步叠成重影）、"周期不是步周期的两倍"（= 腿和身子各走各的）。
const hemCss = stripComments(read('renderer/pet.css') || '');
const hemRuleA = (hemCss.match(/#petWrap\.walk\s+#fHemA\s*\{([^}]*)\}/) || [, ''])[1];
const hemRuleB = (hemCss.match(/#petWrap\.walk\s+#fHemB\s*\{([^}]*)\}/) || [, ''])[1];
if (!hemRuleA || !hemRuleB) {
  bad('pet.css 里没有 `#petWrap.walk #fHemA/B` 两条规则',
    '走动两帧的可见性只由它们写；少了就变成"两张图一直在那儿但永远 opacity:0"');
} else {
  // ★ 周期必须**从 --step-ms 推**、且是步周期的两倍。
  //   写死一个 ms 或者漏掉 ×2，都会让迈步与步态错开 —— 而错开之后
  //   每一拍看上去都"有点不对"，说不清是哪不对。
  //
  //   坑：`animation: hemA calc(var(--step-ms, 420ms) * 2) linear infinite` 这条简写里
  //   有一个**嵌套的** `)`（`var(` 自己带一个）。用 `[^;\s]+` 之类的正则去取时长，
  //   会在 `420ms)` 那个逗号后的空格处截断，读到 `calc(var(--step-ms,` 就以为"没乘 2"
  //   —— 自检自己会误报。这里按括号深度做一次真分词，只在外层空白处切。
  const splitTop = (s) => {
    const out = []; let depth = 0, cur = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (/\s/.test(ch) && depth === 0) { if (cur) { out.push(cur); cur = ''; } }
      else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  };
  const durOf = (r) => {
    const decl = ((r.match(/animation-duration:\s*([^;]+);/) || [, ''])[1]).trim();
    if (decl) return decl;
    const short = ((r.match(/animation:\s*([^;]+);/) || [, ''])[1]).trim();
    if (!short) return '';
    // 简写的第一个 token 是 animation-name，时长是它后面第一个"时间或 calc"
    return splitTop(short).slice(1)
      .find((t) => /^calc\(/.test(t) || /^[\d.]+m?s$/.test(t)) || '';
  };
  for (const [nm, r] of [['#fHemA', hemRuleA], ['#fHemB', hemRuleB]]) {
    const d = durOf(r);
    if (!/calc\(\s*var\(--step-ms/.test(d)) {
      bad(`${nm} 的周期没有从 --step-ms 推（读到 "${d}"）`,
        '步态与迈步必须同源同一个变量，否则改速度时两者会错开 = 腿和身子各走各的');
    } else if (!/\*\s*2\s*\)/.test(d)) {
      bad(`${nm} 的周期不是步周期的两倍（读到 "${d}"）`,
        'walkb 一个迭代才是一步；不乘 2 的话迈步频率会比步态快一倍');
    } else {
      ok(`${nm} 的周期 = 步周期 × 2（${d}）`);
    }
  }
  // 取 keyframes 体。**不能**用 `[\s\S]*?\n\}` 收尾：hemA/hemB 是写成单行的
  // （`@keyframes hemA { 0%, 50% { opacity: 1; } ... }`），那样会一路吞到文件里
  // 下一个以 `}` 开头的行，把后面所有 CSS 都算进这一条关键帧里。
  // 这里允许一层嵌套花括号，单行 / 多行都能正确收住。
  const kfBody = (name) => (hemCss.match(
    new RegExp('@keyframes\\s+' + name + '\\s*\\{((?:[^{}]|\\{[^{}]*\\})*)\\}')) || [, ''])[1];
  const kA = kfBody('hemA'), kB = kfBody('hemB');
  // 读某个百分比上的 opacity。坑：关键帧里百分比可以**共用一档**
  // （`0%, 50% { opacity: 1; }`），按 `\n\s*<pct>%` 去对会完全对不上 ——
  // 这里把选择器按逗号拆开逐个比，才是真的"这个相位上 opacity 是多少"。
  const opAt = (body, pct) => {
    const want = Number(pct);
    for (const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const op = (m[2].match(/opacity:\s*([\d.]+)/) || [, ''])[1];
      if (op === '') continue;
      for (const sel of m[1].split(',')) {
        const p = sel.trim().replace('%', '');
        if (/^[\d.]+$/.test(p) && Number(p) === want) return Number(op);
      }
    }
    return null;
  };
  if (!kA || !kB) {
    bad('pet.css 里没有 @keyframes hemA / hemB', '两帧的硬切全靠这两条');
  } else if (opAt(kA, '0') !== 1 || opAt(kB, '0') !== 0
    || opAt(kA, '100') !== 0 || opAt(kB, '100') !== 1) {
    bad('hemA / hemB 不是互补的（0% 必须一显一隐、100% 反过来）',
      '不互补就会出现"两帧同时显示"（重影）或"同时隐藏"（下装那一下空掉）');
  } else {
    ok('hemA / hemB 严格互补（任一时刻有且只有一帧可见）');
  }
}

if (!/animation-direction:\s*alternate/.test(walkRule)) {
    bad('#petWrap.walk 没有 animation-direction: alternate',
      '没有它她仍在动，只是从"两步一个来回"变成"原地左右抖" —— 截图上分不出来');
  } else {
    ok('走路用 alternate 交替播放（一步正放、一步反放）');
  }
  if (!/animation-duration:\s*var\(--step-ms/.test(walkRule)) {
    bad('#petWrap.walk 的 animation-duration 没有接 --step-ms',
      '接上它步频才跟着速度走；不接，walk() 里按速度写进去的 --step-ms 就是没人读的死代码');
  } else {
    ok('走路周期由 --step-ms 驱动（步频跟着速度走）');
  }
}

// anim() 里有一句强制重排（`void wrap.offsetWidth`），动画因此**从 0 相位重启**；
// 而写 `--step-ms` 只改 duration、不重启动画 —— 相位的分母一变，当前进度就跳：
// 默认 420ms 换成赶路档的 305ms 时，进度 p 会瞬间变成 1.38p（最多跳 38% 个循环）。
// 表现是"一开始走就抖一下"，而且只在远处档才明显 —— 正好是最难复现的形态。
const petJsWalk = read('renderer/pet.js') || '';
const iStep = petJsWalk.indexOf("setProperty('--step-ms'");
const iAnimWalk = petJsWalk.indexOf("anim('walk')");
if (iStep < 0 || iAnimWalk < 0) {
  bad('pet.js 里找不到写 --step-ms 或 anim("walk") 的那两行',
    '步频与动画启动都在 walk() 里，两行都没了说明走动被改写了');
} else if (iStep > iAnimWalk) {
  bad('pet.js 里 anim("walk") 排在写 --step-ms 之前',
    'anim() 的强制重排让动画从 0 相位重启，紧接着改 duration 又让相位跳一次 = 起步时抖一下');
} else {
  ok('--step-ms 先写、anim("walk") 后挂（起步不跳相位）');
}

// ---------- 28. 前台窗口感知（v3.12）----------
//
// 这一版新增的三件事（全屏自动躲起来 / 窗口栖息 / 环境感知）**共用同一条底层能力**：
// 拿前台窗口信息。所以验收也共用一个文件（wininfo.js）。
//
// ★ 这一节的责任边界要说清楚：
//   预览页能验的是"接线 + 台词筛选"，**验不了**"主进程判得对不对"；
//   主进程的判据里唯一能静态钉死的部分是 wininfo.js 的**纯函数**
//   （toDip / isFullscreen / sceneOf）—— 它们不依赖 electron 与 koffi，
//   所以这里能直接 require 进来喂用例。剩下的（真窗口是不是全屏、栖息跟不跟得上）
//   只有真机探针能验，见 tools/probe_v312.js。
section('[28] 前台窗口感知 / 窗口栖息 / 时间感知（v3.12）');

// 从 src 的 start 位置起做花括号配平，**跳过字符串与注释**，返回块结束的下标。
//
// ⚠ 为什么不能只对"剥了注释的文本"数括号：字符串里的 `{` / `}` 一样会被数进去。
//   本文件踩过：`__petDemo` 里有一句 `t.replace(/\{(\w+)\}/g, …)` 的正则，
//   于是配平在中途就"归零"了 —— 后面几个出口全部没被抽出来，
//   而断言只会说"找不到 xxx"，看起来像产品少写了，其实是量法坏了。
//   （同类教训：判据写错比没有判据更危险。）
function blockEnd(src, start, max) {
  const lim = Math.min(src.length, start + (max || 40000));
  let d = 0, started = false, i = start;
  let mode = 0;                       // 0 代码 / 1 ' / 2 " / 3 ` / 4 行注释 / 5 块注释
  for (; i < lim; i++) {
    const c = src[i], n = src[i + 1];
    if (mode === 4) { if (c === '\n') mode = 0; continue; }
    if (mode === 5) { if (c === '*' && n === '/') { mode = 0; i++; } continue; }
    if (mode === 1) { if (c === '\\') i++; else if (c === "'") mode = 0; continue; }
    if (mode === 2) { if (c === '\\') i++; else if (c === '"') mode = 0; continue; }
    if (mode === 3) { if (c === '\\') i++; else if (c === '`') mode = 0; continue; }
    if (c === '/' && n === '/') { mode = 4; i++; continue; }
    if (c === '/' && n === '*') { mode = 5; i++; continue; }
    if (c === "'") { mode = 1; continue; }
    if (c === '"') { mode = 2; continue; }
    if (c === '`') { mode = 3; continue; }
    if (c === '{') { d++; started = true; continue; }
    if (c === '}') { d--; if (started && d === 0) return i + 1; }
  }
  return lim;
}

// 抠出一个函数 / 对象字面量的全文：先按键配平定位，再顺手剥掉行注释
// （后面的正则断言都按"没有注释"写，注释里正好引用了被禁写法的话会骗过它们）。
function bodyOf(text, header, max) {
  const i = text.indexOf(header);
  if (i < 0) return '';
  return stripLineComments(text.slice(i, blockEnd(text, i, max)));
}

let wininfo = null;
try { wininfo = require(R('wininfo.js')); } catch (e) { wininfo = null; }
if (!wininfo) {
  bad('require("wininfo.js") 失败', '这一版唯一能静态验的部分（纯函数）也跟着没了');
} else {
  // ---- 28a. 物理像素 → DIP ----
  // 本机 150% 缩放实测：Node 侧看到 1721x1033，Electron 侧看到 2582x1550。
  // 不换算的直接后果是"她跑到窗口右下方"（位置与尺寸同时放大 1.5 倍）。
  const d150 = wininfo.toDip({ x: 300, y: 300, w: 2582, h: 1550 }, 1.5);
  if (Math.abs(d150.x - 200) < 1e-6 && Math.abs(d150.y - 200) < 1e-6
      && Math.abs(d150.w - 1721.3333) < 0.01 && Math.abs(d150.h - 1033.3333) < 0.01) {
    ok('toDip：150% 下 2582×1550 物理像素 → 1721.3×1033.3 DIP');
  } else {
    bad('toDip 在 150% 下的换算不对', JSON.stringify(d150) + ' —— 期望 1721.33×1033.33');
  }
  // scale 拿不到（0 / undefined / 负数）时必须等价于 1：宁可位置按 100% 算，
  // 也不能除以 0 得到 Infinity 然后把窗口扔到屏幕外。
  const idCases = [0, undefined, null, -1];
  const idBad = idCases.filter((s) => {
    const r = wininfo.toDip({ x: 1, y: 2, w: 3, h: 4 }, s);
    return r.x !== 1 || r.y !== 2 || r.w !== 3 || r.h !== 4;
  });
  if (idBad.length) bad('toDip 在 scale 非法时没有退回 1: ' + JSON.stringify(idBad));
  else ok('toDip：scale ≤ 0 / 缺失时视为 1（不会算出 Infinity）');

  // ---- 28b. 全屏判据：两条都要 ----
  // ★ 这是整个模块里最容易写错的一处。只写"差不多等于屏幕大小"这一条的话，
  //   Windows 最大化窗口（起点 -11,-11、尺寸比屏幕还大）会被判成全屏 ——
  //   于是用户**最大化浏览器工作时她会消失**，而那正是最不该消失的时候。
  const MON = { x: 0, y: 0, w: 2560, h: 1600 };
  const FS_CASES = [
    ['真全屏（精确等于屏幕）', { x: 0, y: 0, w: 2560, h: 1600 }, true],
    ['Windows 最大化窗口（溢出屏幕）', { x: -11, y: -11, w: 2582, h: 1550 }, false],
    ['起点越界但尺寸正好等于屏幕', { x: -11, y: -11, w: 2560, h: 1600 }, false],
    ['起点越界 1px（容差内）', { x: -1, y: -1, w: 2560, h: 1600 }, true],
    ['起点越界 3px（容差外）', { x: -3, y: -3, w: 2560, h: 1600 }, false],
    ['带任务栏的高度（少 40px）', { x: 0, y: 0, w: 2560, h: 1560 }, false],
    ['小 2px（容差内，算全屏）', { x: 0, y: 0, w: 2558, h: 1598 }, true],
    ['小 3px（容差外）', { x: 0, y: 0, w: 2557, h: 1597 }, false],
    ['副屏上的真全屏', { x: 2560, y: 0, w: 1920, h: 1080 }, true, { x: 2560, y: 0, w: 1920, h: 1080 }]
  ];
  let fsBad = 0;
  for (const [name, win, want, mon] of FS_CASES) {
    const got = wininfo.isFullscreen(win, mon || MON);
    if (got !== want) { fsBad++; bad(`isFullscreen 判错：${name} → ${got}（应为 ${want}）`); }
  }
  if (!fsBad) ok(`isFullscreen：${FS_CASES.length} 个用例全对（含"最大化窗口不算全屏"这条命门）`);

  // ---- 28c. 进程名 → 场景 ----
  const SCENE_CASES = [
    ['Code.exe', 'code'], ['code-insiders.exe', 'code'], ['pycharm64.exe', 'code'],
    ['WindowsTerminal.exe', 'code'], ['nvim.exe', 'code'],
    ['CHROME.EXE', 'browser'], ['msedge.exe', 'browser'], ['360Chrome.exe', 'browser'],
    ['PotPlayerMini64.exe', 'video'], ['vlc.exe', 'video'], ['mpv.exe', 'video'],
    ['WeChat.exe', 'chat'], ['weixin.exe', 'chat'], ['TIM.exe', 'chat'], ['Feishu.exe', 'chat'],
    ['explorer.exe', 'desktop'],
    ['foobar2000.exe', 'other'], ['', 'other'], [null, 'other'], [undefined, 'other']
  ];
  const sceneBad = SCENE_CASES.filter(([exe, want]) => wininfo.sceneOf(exe) !== want)
    .map(([exe]) => JSON.stringify(exe) + '→' + wininfo.sceneOf(exe));
  if (sceneBad.length) {
    bad('sceneOf 判错: ' + sceneBad.join(', '),
      '匹配不上的那一个会让她在你写代码时沉默、在聊天时凑过来 —— 场景反了比没有场景更怪');
  } else ok(`sceneOf：${SCENE_CASES.length} 个进程名全部归对（含大小写不敏感、'explorer.exe' 归桌面）`);

  // 规则表本身：不能有重名（重名 = 后面那条永远轮不到），且必须含 'other' 兜底
  const ruleNames = wininfo.SCENE_RULES.map((r) => r[0]);
  if (new Set(ruleNames).size !== ruleNames.length) {
    bad('SCENE_RULES 有重名: ' + ruleNames.join(', '), '先匹配到的赢，重名的那条是死规则');
  } else if (wininfo.SCENES.indexOf('other') < 0) {
    bad("SCENES 里没有 'other'", '渲染层的兜底键与主进程的标签表都靠它');
  } else ok(`SCENE_RULES ${ruleNames.length} 条无重名，SCENES 含 'other' 兜底`);
}

// ---- 28d. 场景键三层对齐（wininfo ← 主进程标签 ← 台词库）----
// 这三张表分在三个文件里，靠字符串键连起来。少一个键不会有任何报错 ——
// 只是某个场景永远没话说、或者菜单上显示一个 undefined。
// 注意 scene 组是 QUOTES 的**最后一组**，后面直接跟 `};` —— 收尾没有逗号。
// （又踩了一次"注释/收尾写法"的坑：这里要按实际收尾写，别照抄 daypart 的那份。）
const sceneBlock = (dialogueJs.match(/\n  scene:\s*\{([\s\S]*?)\n  \}/) || [, ''])[1];
const quoteSceneKeys = [...sceneBlock.matchAll(/^\s{4}(\w+):\s*\[/gm)].map((m) => m[1]);
const labelBlock = (mainJs.match(/\nconst SCENE_LABELS = \{([\s\S]*?)\n\};/) || [, ''])[1];
const labelKeys = [...labelBlock.matchAll(/(\w+):\s*'/g)].map((m) => m[1]);
if (!quoteSceneKeys.length || !labelKeys.length || !wininfo) {
  bad('解析不出 QUOTES.scene / SCENE_LABELS / wininfo.SCENES',
    '场景键的对齐检查就失去了意义');
} else {
  const orphans = quoteSceneKeys.filter((k) => wininfo.SCENES.indexOf(k) < 0);
  const silent = wininfo.SCENE_RULES.map((r) => r[0]).filter((k) => quoteSceneKeys.indexOf(k) < 0);
  const noLabel = wininfo.SCENES.filter((k) => labelKeys.indexOf(k) < 0);
  if (orphans.length) bad('QUOTES.scene 里有主进程永远不会推的键: ' + orphans.join(', '),
    '死台词 —— 写了但永远不说');
  else if (silent.length) bad('这些场景在 QUOTES.scene 里没有键: ' + silent.join(', '),
    '主进程推过来时渲染层找不到台词组（desktop 可以是空数组，但不能没有键）');
  else if (noLabel.length) bad('SCENE_LABELS 缺场景: ' + noLabel.join(', '),
    '菜单/托盘上那行"当前前台"会显示成 undefined');
  else ok(`场景键三层对齐：${quoteSceneKeys.length} 组台词 ↔ ${ruleNames0()} 条规则 ↔ ${labelKeys.length} 个标签`);
}
function ruleNames0() { return wininfo ? wininfo.SCENE_RULES.length : 0; }

// ---- 28e. 勿扰宪法：全屏自动躲起来必须并进 quietActive ----
// ★ 这是这一版最大的架构风险点。"勿扰 ⟺ 窗口不可见"是 v3.7 用一次真实 bug
//   换来的宪法，而新加的自动档**很容易**被写成"在 fgPoll 里自己 hide()"——
//   那样她确实会藏起来，但穿透、光标巡检、菜单全都以为她还在。
const mainNs = stripLineComments(mainJs);
if (!/const quietActive = \(\) => manualQuiet\(\) \|\| \(autoQuietOn\(\) && fgFullscreen\)/.test(mainNs)) {
  bad('quietActive() 不是「手动 or（开关开 && 全屏）」',
    '自动档没并进勿扰判据 -> 她藏起来了但没人管（穿透/巡检/菜单都以为她还在）');
} else ok('quietActive() = 手动勿扰 ‖（自动开关 ∧ 全屏）—— 自动档确实并进了宪法');

if (!/const manualQuiet = \(\) => quietUntil\(\) > Date\.now\(\)/.test(mainNs)) {
  bad('manualQuiet() 不是一个"只看时间戳"的纯判据');
} else ok('manualQuiet() 只认时间戳（菜单置灰 / 告别开关都以它为准）');

// 勿扰子菜单必须判**手动档**而不是"她此刻藏没藏"：
// 判错的话，全屏看视频时三个勿扰档位会全变灰（用户会以为功能坏了）。
const qsBody = bodyOf(mainJs, 'function quietSubmenu()');
if (!/const q = manualQuiet\(\)/.test(qsBody)) {
  bad('quietSubmenu() 判的不是 manualQuiet()',
    '全屏自动躲起来时三个档位会全变灰 —— 用户以为功能坏了，其实只是"她此刻躲着"');
} else ok('勿扰子菜单按 manualQuiet() 置灰（自动档不会把三个档位锁死）');

// ---- 28f. 自动档不说告别 ----
const aqBody = bodyOf(mainJs, 'function applyQuiet()');
if (!/if \(manual\) setTimeout\(hideNow, QUIET_HIDE_DELAY\);\s*else hideNow\(\);/.test(aqBody)) {
  bad('applyQuiet() 里自动档没有走"立刻藏、不等告别"',
    '看全屏视频时她突然开口说"我出去了"，比直接消失更烦人');
} else ok('applyQuiet()：手动档等告别说完再藏，自动档立刻藏（不说告别）');

if (!/'quiet', \{ active, until: manual \? quietUntil\(\) : 0, bye: manual \}/.test(aqBody)) {
  bad("quiet 通知的 payload 不是 { active, until, bye }",
    'bye=false 时渲染层才知道"这次是自动档，别说话"');
} else ok("quiet payload = { active, until, bye }（自动档 until=0、bye=false）");

// ---- 28g. 前台轮询不能带可见性闸门（否则死锁）----
// 因全屏而藏 -> 若轮询也停了 -> 检测不到"已退出全屏" -> 永远回不来。
// 光标巡检有可见性闸门、前台轮询**必须没有** —— 两者不同，所以这里一并对照。
const fgBody = bodyOf(mainJs, 'function fgPoll()');
if (!fgBody) {
  bad('找不到 function fgPoll()', '前台轮询整段可能被改名/删掉');
} else {
  if (/isVisible\(/.test(fgBody)) {
    bad('fgPoll() 里出现了 isVisible()',
      '死锁：因全屏而藏 -> 不轮询 -> 检测不到退出全屏 -> 永远回不来');
  } else ok('fgPoll() 不带可见性闸门（藏起来时照样在数"退出全屏了没"）');
  if (/petWin\.(hide|show)\(/.test(fgBody)) {
    bad('fgPoll() 自己调了 hide()/show()',
      '绕过 applyQuiet 等于藏起来没人管 —— 必须走那条唯一的出口');
  } else ok('fgPoll() 只改状态、不自己开关窗口（藏/显一律经 applyQuiet）');
  if (!/applyQuiet\(\)/.test(fgBody)) {
    bad('fgPoll() 检测到全屏变化后没有调 applyQuiet()');
  } else ok('fgPoll() 检测到全屏状态变化后调 applyQuiet()');
}
const cursorBody = bodyOf(mainJs, 'function cursorPoll()');
if (!/if \(!petWin\.isVisible\(\)\) return;/.test(cursorBody)) {
  bad('cursorPoll() 的可见性闸门不见了',
    '它**应该**有闸门（看不见就别跟了），这条与 fgPoll 正好相反 —— 去掉会白白跑 120ms 一拍');
} else ok('cursorPoll() 保留可见性闸门（与 fgPoll 刻意不同，两条路的取舍写在一起）');

// 频率：1s vs 120ms，差 8 倍（同一进程里两个常驻轮询，数字本身就是设计的一部分）
const fgMs = Number((mainJs.match(/const FG_MS\s*=\s*(\d+)/) || [])[1]);
const cursorMs = Number((mainJs.match(/const CURSOR_MS\s*=\s*(\d+)/) || [])[1]);
if (!fgMs || !cursorMs || fgMs <= cursorMs) {
  bad(`前台轮询 ${fgMs}ms / 光标巡检 ${cursorMs}ms 的频次关系不对`,
    '前台窗口是慢变量，不该按 120ms 去问 Win32');
} else ok(`两个常驻轮询频次分开了：前台 ${fgMs}ms / 光标 ${cursorMs}ms`);

// startFgFeed 只在原生模块可用时才起（装不上不能变成一个空转的定时器）
const feedBody = bodyOf(mainJs, 'function startFgFeed()');
if (!/if \(fgTimer \|\| !fgAvailable\(\)\) return;/.test(feedBody)) {
  bad('startFgFeed() 没有"模块不可用就不起定时器"的提前返回');
} else ok('startFgFeed()：原生模块不可用时不空转定时器');
if (!/startFgFeed\(\);/.test(bodyOf(mainJs, 'function createPet('))) {
  bad('createPet() 里没有调 startFgFeed()', '整个前台感知不会启动');
} else ok('createPet() 里接上了 startFgFeed()');

// ---- 28h. 栖息的位置所有权 ----
// 栖息中她的位置归前台窗口管。20 秒一次的几何巡检如果**夹取**她的位置，
// 会把她从窗口上拽下来 —— 表现是"周期性抽动"，而且只在某些屏幕布局下出现。
const resnapBody = bodyOf(mainJs, 'function resnap()');
// 只取 `if (perchOn) { … }` 这一段：函数后半截的常规路径里**本来就该**有
// moveToClamped（不夹取的是栖息分支，不是整个函数）。
const perchSeg = resnapBody.slice(resnapBody.indexOf('if (perchOn)'),
  resnapBody.indexOf('const b = petWin.getBounds();'));
if (!/perchAt\(/.test(perchSeg)) {
  bad('resnap() 里栖息分支没有重贴到窗口上');
} else if (/moveToClamped|clampPos/.test(perchSeg)) {
  bad('resnap() 的栖息分支在夹取位置',
    '20s 巡检会把她从窗口上拽下来 —— 看起来像周期性抽动');
} else ok('resnap() 在栖息中只重贴、不夹取（20s 巡检不会把她拽下来）');

const enfBody = bodyOf(mainJs, 'function enforceSize()');
if (!/if \(perchOn\) \{ resnap\(\); return; \}/.test(enfBody)) {
  bad('enforceSize() 里没有"栖息中只走 resnap"的分支',
    '缩放/换装后她会先被常规路径挪开、1 秒后再跳回窗口上 = 抽搐');
} else ok('enforceSize()：栖息中把位置那一半交给 resnap()');

const setPerchBody = bodyOf(mainJs, 'function setPerch(');
if (!/if \(next && edgeMode\) setEdge\(null\);/.test(setPerchBody)) {
  bad('setPerch() 进栖息前没有先取消收边',
    '两者都在写她的位置，谁后算谁赢 —— 会互相打架');
} else ok('进入栖息前先取消收边（两个"位置所有者"互斥）');
if (!/moveToClamped\(/.test(setPerchBody)) {
  bad('setPerch() 出栖息时没有落地', '她会停在半空 —— 渲染层的角色不会自己往下掉');
} else ok('退出栖息时落地（不停在半空）');
if (!/if \(on && !fgAvailable\(\)\) return false;/.test(setPerchBody)) {
  bad('setPerch() 在模块不可用时没有拒绝进入');
} else ok('setPerch()：模块不可用时拒绝进入并返回 false（菜单据此不勾）');

// 拖拽时退出栖息：不退出的话 perchAt 每拍都在把她拽回窗口上，和拖拽打架。
const blockBody = bodyOf(mainJs, "ipcMain.handle('pet:setBlock'");
if (!/if \(perchOn\) \{ perchOn = false;/.test(blockBody)) {
  bad('pet:setBlock 里没有退出栖息',
    '拖拽/重载期间 perchAt 会每拍把她拽回去，两只手抢同一个位置');
} else if (/moveToClamped/.test(blockBody)) {
  bad('pet:setBlock 里退栖息时调了 moveToClamped()',
    '拖拽要知道她**原地**在哪 —— 这里落地会让窗口先跳一下再被拖走');
} else ok('pet:setBlock：退出栖息但**不**落地（拖拽从原地开始）');

// 栖息中不写位置存档：她此刻的位置是"跟着前台窗口的临时姿态"，不是"她住的地方"。
const saveBody = bodyOf(mainJs, "ipcMain.handle('pet:savePos'");
if (!/if \(perchOn\) return p;/.test(saveBody)) {
  bad('pet:savePos 在栖息中没有直接返回',
    '会把"贴在某扇窗口上"的临时位置存成她的家 —— 关掉那扇窗后她出现在奇怪的地方');
} else ok('栖息中不写位置存档（只存"她住的地方"）');

// ---- 28i. 渲染层的 onQuiet 是对象形态，且 bye=false 不说告别 ----
const oqBody = bodyOf(petJs, 'window.pet.onQuiet((payload) => {');
if (!/const o = \(payload && typeof payload === 'object'\)/.test(oqBody)) {
  bad('pet.js 没接住对象形态的 quiet payload');
} else if (!/if \(o\.bye\) \{/.test(oqBody)) {
  bad('pet.js 没读 bye 开关');
} else {
  const sayCount = (oqBody.match(/\bsay\(/g) || []).length;
  const frozCount = (oqBody.match(/setFrozen\(true\)/g) || []).length;
  if (sayCount !== 1 || frozCount !== 1) {
    bad(`onQuiet 里 say() 出现 ${sayCount} 次、setFrozen(true) 出现 ${frozCount} 次`,
      '期望各 1 次：告别只在 bye 分支说，自动档直接冻');
  } else ok('onQuiet：bye=true 说告别 / bye=false 直接冻住（自动档不出声）');
}
const preloadQuiet = (preloadJs.match(/onQuiet:[\s\S]{0,160}/) || [''])[0];
if (/cb\(!!/.test(preloadQuiet) || /Number\(/.test(preloadQuiet)) {
  bad('preload 的 onQuiet 把 payload 转成了布尔/数字',
    'bye 这个字段会被吃掉 —— 手动档的告别和自动档的静默就分不开了');
} else if (!/cb\(q\)/.test(preloadQuiet)) {
  bad('preload 的 onQuiet 没有原样透传 payload');
} else ok('preload 的 onQuiet 原样透传对象（不转布尔/数字）');

// ---- 28j. 时间感知：段落定义必须真的能被跑起来 ----
// 这里不是"复现一份判据"，而是把 pet.js 里**那一段源码**抠出来在 vm 里跑 ——
// 验的是真源码，不是抄一份（抄一份的话，真源码改了它照样绿）。
const vm = require('vm');
const dpFrom = petJs.indexOf('const DAYPARTS =');
const dpTo = petJs.indexOf('// 主动开口的统一闸门');
let daypartOf = null, cnHour = null, dpNames = [];
if (dpFrom < 0 || dpTo < 0 || dpTo <= dpFrom) {
  bad('抠不出 pet.js 的 DAYPARTS / daypartOf / cnHour 那一段');
} else {
  const sandbox = {};
  try {
    vm.runInNewContext(
      petJs.slice(dpFrom, dpTo) + '\nthis.__dp = { daypartOf: daypartOf, cnHour: cnHour, DAYPARTS: DAYPARTS };',
      sandbox);
    daypartOf = sandbox.__dp.daypartOf;
    cnHour = sandbox.__dp.cnHour;
    dpNames = sandbox.__dp.DAYPARTS.map((x) => x[1]);
  } catch (e) { bad('跑 DAYPARTS 那一段源码时抛了: ' + e.message); }
}
if (daypartOf) {
  const want = {
    0: 'lateNight', 4: 'lateNight', 5: 'dawn', 7: 'dawn', 8: 'morning', 10: 'morning',
    11: 'noon', 13: 'noon', 14: 'afternoon', 17: 'afternoon', 18: 'evening', 22: 'evening',
    23: 'lateNight'
  };
  const wrong = Object.keys(want).filter((h) => daypartOf(Number(h)) !== want[h])
    .map((h) => h + 'h→' + daypartOf(Number(h)));
  if (wrong.length) bad('daypartOf 判错: ' + wrong.join(', '));
  else ok('daypartOf：24 小时被六段**无缝**盖满（0~4 归深夜，与 23~24 接上）');

  const missing = [];
  for (let h = 0; h < 24; h++) if (dpNames.indexOf(daypartOf(h)) < 0) missing.push(h);
  if (missing.length) bad('有小时落进了 DAYPARTS 里没定义的段: ' + missing.join(','));
  else ok('每个小时都能映射到一个已定义的时段名');

  const cnWant = { 0: '零点', 5: '五点', 10: '十点', 14: '十四点', 19: '十九点', 20: '二十点', 23: '二十三点' };
  const cnWrong = Object.keys(cnWant).filter((h) => cnHour(Number(h)) !== cnWant[h])
    .map((h) => h + '→' + cnHour(Number(h)));
  if (cnWrong.length) bad('cnHour 判错: ' + cnWrong.join(', ') + '（整点报时那句会念错）');
  else ok('cnHour：0/10/14/19/20/23 点都念对（零点 / 十点 / 十四点 / 十九点 / 二十点 / 二十三点）');
}

// 时段名与台词库的键必须一一对应
const dpBlock = (dialogueJs.match(/\n  daypart:\s*\{([\s\S]*?)\n  \},/) || [, ''])[1];
const dpQuoteKeys = [...dpBlock.matchAll(/^\s{4}(\w+):\s*\[/gm)].map((m) => m[1]);
if (!dpQuoteKeys.length || !dpNames.length) {
  bad('解析不出 QUOTES.daypart 的键或 DAYPARTS');
} else {
  const onlyInCode = dpNames.filter((k) => dpQuoteKeys.indexOf(k) < 0);
  const onlyInQuote = dpQuoteKeys.filter((k) => dpNames.indexOf(k) < 0);
  if (onlyInCode.length || onlyInQuote.length) {
    bad('QUOTES.daypart 与 DAYPARTS 对不上',
      '只有代码: ' + JSON.stringify(onlyInCode) + ' / 只有台词: ' + JSON.stringify(onlyInQuote));
  } else ok(`QUOTES.daypart 与 DAYPARTS 六段一一对应（${dpNames.join(' / ')}）`);
}

// ---- 28k. 占位符替换必须通用（{h} 才可能被填上）----
// 原来只认 {name}。整点报时用 {h}，不改成通用替换的话她只会念出"……{h}了。"。
if (!/t\.replace\(\/\\\{\(\\w\+\)\\\}\/g/.test(petJs)) {
  bad('quote() 的占位符替换不是通用的 /\\{(\\w+)\\}/',
    '整点报时那句会原样念出 {h} —— 而截图上看不出这是 bug（气泡里确实有字）');
} else ok('quote() 占位符替换通用化（{h} / {n} 都能填，缺省仍是空串）');

const chimeBlock = (dialogueJs.match(/\n  chime:\s*\[([\s\S]*?)\n  \],/) || [, ''])[1];
const chimeLines = [...chimeBlock.matchAll(/'([^']*)'/g)].map((m) => m[1]);
if (!chimeLines.length || chimeLines.some((l) => l.indexOf('{h}') < 0)) {
  bad('QUOTES.chime 里有不带 {h} 的句子', '整点报时不说几点，等于没报时');
} else ok(`QUOTES.chime ${chimeLines.length} 句全部带 {h} 占位符`);

// 里程碑天数只认"按天数做键"的写法（与 bond / levelUp 同一个模式）
const dayNBlock = (dialogueJs.match(/\n  dayN:\s*\{([\s\S]*?)\n  \},/) || [, ''])[1];
const dayNKeys = [...dayNBlock.matchAll(/^\s{4}(\d+):\s*\[/gm)].map((m) => Number(m[1]));
if (!dayNKeys.length || dayNKeys.some((n) => !(n > 0))) {
  bad('QUOTES.dayN 的键不是天数');
} else if (dayNKeys.indexOf(1) < 0) {
  bad("QUOTES.dayN 里没有第 1 天", '头一天就是第 1 天（floor(0/一天)+1），它一定会被算到');
} else ok(`QUOTES.dayN 按天做键：${dayNKeys.join(' / ')} 天`);

// 老的两组（night / morning）必须已经并掉了 —— 留着就是两套时段判据并存。
// ⚠ 只能按**顶层键的缩进**匹配：daypart.morning / daypart.lateNight 是合法的。
if (/^  (night|morning|latenight):/m.test(stripLineComments(dialogueJs))) {
  bad('QUOTES 里还有顶层 night / morning',
    '它们与 daypart 是两套时段判据，会各自漂 —— 并进 daypart 的那六段');
} else ok('老的 night / morning 两组已并进 daypart（只剩一套时段判据）');

// ---- 28l. firstRunAt 只写一次 ----
// 写成无条件 patch 的话，每次启动都会把它刷新成"今天"，"陪你第 N 天"永远是第 1 天。
if (!/if \(!Number\(s\.firstRunAt\)\) patchSettings\(\{ firstRunAt: Date\.now\(\) \}\)/.test(mainNs)) {
  bad('firstRunAt 的写入没有"已存在就不写"的守卫',
    '每次启动都重置 -> "陪你第 N 天"永远停在第一天（而且没有任何报错）');
} else ok('firstRunAt 只在首次运行时写（有 !Number(...) 守卫）');
if (!/firstRunAt = Number\(s\.firstRunAt\) \|\| 0;/.test(petJs)) {
  bad('渲染层没有读 firstRunAt');
} else ok('渲染层从设置里读 firstRunAt（老存档读到 0 -> 不说话）');

// ---- 28m. 菜单接线：前台感知那一组要同时进右键菜单与托盘 ----
const fgMenuCount = (mainNs.match(/\{ label: '前台感知', submenu: fgSubmenu\(\) \}/g) || []).length;
if (fgMenuCount !== 2) {
  bad(`「前台感知」子菜单出现 ${fgMenuCount} 次（应为 2：右键菜单 + 托盘）`,
    '少一处 = 那个入口里没有这项功能，而用户不一定知道去哪找');
} else ok('「前台感知」子菜单同时接进右键菜单与托盘菜单');

// ---- 28n. 时间感知不许变成闹钟 ----
// 主动开口必须过 canSpeakNow()（勿扰 / 睡着 / 她自己正忙 / 你刚互动过）。
const canSpeak = (petJs.match(/const canSpeakNow = \(\) =>\n?[\s\S]{0,200}?;/) || [''])[0];
if (!/!quiet/.test(canSpeak) || !/!sleeping/.test(canSpeak)
    || !/state\.mode === 'idle'/.test(canSpeak) || !/talkOK\(\)/.test(canSpeak)
    || !/lastInteract > 30000/.test(canSpeak)) {
  bad('canSpeakNow() 的四道闸门不齐', '她会在勿扰里 / 睡着时 / 刚被你点完之后开口 —— 桌宠最怕变成闹钟');
} else ok('canSpeakNow() 四道闸门齐全（勿扰 / 睡着 / 正忙 / 刚互动过）');

const chimeBody = bodyOf(petJs, 'let lastChimeHour = -1;');
if (!/if \(h === lastChimeHour\) return;/.test(chimeBody)) {
  bad('整点报时没有"同一小时只响一次"的去重', '30s 一拍会在一分钟内把同一句念两遍');
} else ok('整点报时同一小时只响一次');
if (!/daypartOf\(h\) === 'lateNight' \? 0\.5 : 0\.35/.test(chimeBody)) {
  bad('整点报时的概率没有按深夜分档');
} else ok('整点报时：深夜概率压得更低（0.5 vs 0.35 以外的时段）');

// 深夜打哈欠必须**直接调 ACT.yawn**，不能插进行为链 ——
// 链是"她自己在一件事里连做几拍"，插进去会打乱那一拍。
// ⚠ 这一段不能用 bodyOf：它外层那个 `{` 在前面的 setInterval 行上，
//   花括号配平会一路吞到下一个函数去，把别处的 runChain 也框进来。
//   这里按"命中处往后 300 字"截，足够覆盖整条 interval 体，又够不到下一节。
const yawnFrom = petJs.indexOf("if (daypartOf(new Date().getHours()) !== 'lateNight') return;");
const yawnBody = yawnFrom < 0 ? '' : stripLineComments(petJs.slice(yawnFrom, yawnFrom + 300));
if (!/ACT\.yawn\.run\(\)/.test(yawnBody)) {
  bad('深夜那一拍不再直接调 ACT.yawn.run()',
    '困意这条特性静默消失 —— 而"她今晚没打哈欠"在截图上完全看不出来');
} else if (/runChain/.test(yawnBody)) {
  bad('深夜打哈欠走的是行为链', '困是身体反应，插进链中间会打乱那一拍的节奏');
} else ok('深夜打哈欠直接调 ACT.yawn.run()（不插进行为链）');

// 环境感知**只影响台词**、不改姿态（两个调度器会互相打断）
const sceneHandler = bodyOf(petJs, 'window.pet.onScene((s) => {');
if (/anim\(|walk\(|ACT\[/.test(sceneHandler)) {
  bad('onScene 里改了姿态', '行为链已经在管她的节奏，再按应用插一脚 = 两个调度器互相打断');
} else ok('onScene 只影响"说不说、说什么"，不动姿态（与行为链不打架）');
if (!/if \(Date\.now\(\) - lastSceneSay < SCENE_GAP\) return;/.test(sceneHandler)) {
  bad('场景台词没有低频闸门', '切窗口就说话会变成话痨');
} else ok(`场景台词有 ${(petJs.match(/const SCENE_GAP = ([^;]+);/) || [, ''])[1]} 的低频闸门`);

// 隐私：整个 wininfo.js 不许出现读窗口标题的调用（这是"只读进程名"的硬证明）
// ⚠ 必须先剥行注释：这个文件的注释里**正好**写着"整个文件里不存在 GetWindowText
//   这个调用" —— 不剥的话，那句说明本身就是唯一的命中。这个坑在本项目已经踩过两次。
const wininfoSrc = stripLineComments(read('wininfo.js') || '');
if (/GetWindowText|GetWindowTextW|GetWindowTextLength/.test(wininfoSrc)) {
  bad('wininfo.js 里出现了 GetWindowText*',
    '窗口标题里才有"某项目 - VS Code"、聊天对象名这类内容 —— 隐私边界是写死在实现里的');
} else ok('wininfo.js 里没有任何 GetWindowText*（只读进程可执行名 + 窗口矩形）');
if (!/exe\.split\('\\\\'\)\.pop\(\)/.test(wininfoSrc)) {
  bad('wininfo.js 取的不是"文件名"而是完整路径',
    '完整路径里有用户名与安装位置 —— 报给渲染层的只能是文件名');
} else ok("wininfo.js 只把文件名（exe.split('\\\\').pop()）报给渲染层");

// ---- 28o. 打包：wininfo.js 与 koffi 必须跟着走 ----
// 这一类的坏法特别隐蔽：开发态一切正常（node_modules 就在旁边），
// 装成 exe 之后前台感知整个消失，而报错只会出现在用户机器上的控制台里。
const filesList = (pkg.build && pkg.build.files) || [];
if (filesList.indexOf('wininfo.js') < 0) {
  bad('build.files 缺 wininfo.js', '打包后主进程 require 不到它 —— 安装版里前台感知整个消失');
} else ok('build.files 含 wininfo.js');
const optDeps = pkg.optionalDependencies || {};
if (!optDeps.koffi) {
  bad('optionalDependencies 里没有 koffi', '它必须是可选依赖：装不上就降级置灰，不能连累启动');
} else ok(`optionalDependencies 含 koffi ${optDeps.koffi}（与 uiohook-napi 同一规格）`);
// koffi 的 .node 其实躺在 @koromix/koffi-<平台> 里，**两个**都要解包 ——
// 只放行 koffi 的话，asar 里那个 .node 加载不了（报错的还是 wininfo 那一层）。
const unpackList = (pkg.build && pkg.build.asarUnpack) || [];
const hasKoffiUnpack = unpackList.some((p) => /node_modules\/koffi\//.test(p));
const hasKoromixUnpack = unpackList.some((p) => /@koromix/.test(p));
if (!hasKoffiUnpack || !hasKoromixUnpack) {
  bad('asarUnpack 没有同时放行 koffi 与 @koromix',
    'koffi 的 .node 在 @koromix/koffi-<平台> 里；只解包一个，装成 exe 后原生调用会失败');
} else ok('asarUnpack 同时放行 koffi 与 @koromix（原生 .node 必须解包）');

// ---------- 29. 预览页：按钮 / 演示分支 / 演示出口 三者必须对得上 ----------
//
// 这一类错误的共同点是**完全没有声音**：按钮点了没反应、或者渲染层里那句
// `demo.xxx(...)` 打在 undefined 上 —— 前者你会以为"还没做"，后者你在浏览器
// 控制台里才看得到。真机则一切正常（那条路根本不经过预览页）。
// v3.12 一口气加了 11 个按钮与 5 个演示出口，正是最容易漏的地方。
section('[29] 预览页：按钮 / 演示分支 / 演示出口三者对齐');

const demoButtons = [...prevHtml.matchAll(/data-demo="([^"]+)"/g)].map((m) => m[1]);
const ddBody = bodyOf(prevHtml, 'function dispatchDemo(k) {');
if (!demoButtons.length || !ddBody) {
  bad('解析不出 preview.html 的按钮或 dispatchDemo', '下面两条对齐检查就没有意义了');
} else {
  const handled = new Set([...ddBody.matchAll(/k === '([^']+)'/g)].map((m) => m[1]));
  const dead = [...new Set(demoButtons)].filter((b) => !handled.has(b));
  const orphan = [...handled].filter((k) => demoButtons.indexOf(k) < 0);
  if (dead.length) {
    bad('这些按钮点了没反应（dispatchDemo 里没有对应分支）: ' + dead.join(', '),
      '按钮就在那儿，点下去什么都不发生 —— 看起来像功能没做，其实是分支漏了');
  } else if (orphan.length) {
    bad('这些演示分支没有按钮也没有 hash 入口: ' + orphan.join(', '));
  } else {
    ok(`预览页 ${new Set(demoButtons).size} 个按钮与 dispatchDemo 的分支一一对应`);
  }
}

// 演示出口：preview.html 里每一句 demo.xxx(...) 都必须在 __petDemo 里有实现。
// 它和 [11d] 的"替身必须覆盖 window.pet.*"是同一类坑，只是对象换成了调试出口。
const petDemoBlock = bodyOf(petJs, 'window.__petDemo = {');
const usedDemo = [...new Set([...prevHtml.matchAll(/\bdemo\.([A-Za-z_$][\w$]*)\s*\(/g)]
  .map((m) => m[1]))];
if (!petDemoBlock || !usedDemo.length) {
  bad('解析不出 __petDemo 或 preview.html 里用到的 demo.* 调用');
} else {
  const missing = usedDemo.filter((n) =>
    !new RegExp('(^|[\\s,{])' + n.replace(/\$/g, '\\$') + '\\s*[:(,]').test(petDemoBlock));
  if (missing.length) {
    bad('preview.html 调了 __petDemo 里没有的出口: ' + missing.join(', '),
      '浏览器验收页会在那一句上抛 TypeError，而这个演示静默失效');
  } else {
    ok(`preview.html 用到的 ${usedDemo.length} 个 __petDemo 出口全部有实现`);
  }
}

// ---- 汇总 ----------
console.log('\n' + '-'.repeat(52));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n必须修掉的问题：');
  problems.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
  process.exit(1);
}
console.log('全部通过。');
