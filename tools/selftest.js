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
  'tools/make_icons.py', 'tools/review.py', 'tools/prep-build-cache.js',
  'tools/gen_launchers.py',
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
const mainC = constsOf(mainJs, ['BASE_W', 'PET_H', 'TOP_PAD_RATIO', 'BASE_H', 'RENDER_H']);
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

// ---- 顶部留白：同一个数写在四个地方，最容易漂 ----
// main.js / pet.js / preview.html 各一个 TOP_PAD_RATIO，加上 pet.css 里
// #petArea 的 `calc(100% - 17cqw)`。这类重复定义以前就漏过
// （Python / JS 两份隐私白名单，写完五分钟就漂了一条）。
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
  const miss = Object.entries(padVals).filter(([, v]) => v === null).map(([k]) => k);
  if (miss.length) {
    bad('顶部留白比值找不到定义', miss.join(' / '));
  } else if (new Set(Object.values(padVals)).size > 1) {
    bad('顶部留白四处不一致', Object.entries(padVals).map(([k, v]) => `${k}=${v}`).join('  '));
  } else {
    ok(`顶部留白四处一致 = ${Object.values(padVals)[0]}（窗口宽的百分比）`);
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
  const diff = Object.keys(sMain).filter((k) => sMain[k] !== sPrev[k]);
  if (diff.length) bad('缩放档表不一致: ' + diff.join(', '), JSON.stringify(sMain) + ' vs ' + JSON.stringify(sPrev));
  else ok('SIZES 三档一致: ' + Object.keys(sMain).join('/'));
}

// ---------- 2b. 素材宽度上限 ----------
// .frame 是 height:100% + width:auto，也就是"按高度锚定、宽度由素材比例决定"。
// 好处是四套装扮的显示高度一律等于**角色区**高度（换装时不会一大一小），
// 代价是素材太宽时两侧发梢会被窗口裁掉 —— 这一节就是那个代价的守门人。
section('[2b] 素材宽度上限');
const renderH = mainC.RENDER_H;
const baseW = mainC.BASE_W, petH = mainC.PET_H;
// PET_MAX_SPRITE_W 是个表达式而不是字面量，所以单独认它（顺带把公式也钉住：
// 一旦有人改了 BASE_W / PET_H 却忘了同步上限，这条会立刻响）
// ★ 分母必须是 PET_H（角色显示高度），不能是 BASE_H（窗口高）：
//   素材撑满的是角色区，窗口顶部那条留白里没有素材 ——
//   拿 469 当分母上限会缩到 482，宽一点的装扮会被误判成"超出上限"。
const hasFormula = /PET_MAX_SPRITE_W\s*=\s*Math\.floor\(\s*BASE_W\s*\*\s*RENDER_H\s*\/\s*PET_H\s*\)/
  .test(stripComments(mainJs));
if (renderH === null || baseW === null || petH === null) {
  bad('RENDER_H / BASE_W / PET_H 定义不全');
} else if (!hasFormula) {
  bad('PET_MAX_SPRITE_W 的定义式被改过',
    '它必须是 Math.floor(BASE_W * RENDER_H / PET_H)，否则素材宽度上限会悄悄失效');
} else {
  ok(`PET_MAX_SPRITE_W = floor(${baseW} × ${renderH} / ${petH}) = ${Math.floor(baseW * renderH / petH)}`);
}
const maxSpriteW = hasFormula && baseW && renderH && petH
  ? Math.floor(baseW * renderH / petH) : null;

// ---------- 2b-2. 实际素材必须塞得进窗口 ----------
// 上面那条只守住了"上限公式没被改"，守不住"素材本身变胖了"。
// 素材是 build_assets.py 生成的，重新抠一张图就可能宽出几十像素 ——
// 那时两侧发梢会被窗口默默裁掉，截图里不一定看得出来。
if (maxSpriteW) {
  for (const k of ['maid', 'sailor', 'coat', 'winter']) {
    const s = pngSize(`assets/sprites/${k}.png`);
    if (!s) continue;                       // 缺文件由 [6] 报
    if (s.w > maxSpriteW) {
      bad(`${k}.png 宽 ${s.w} > 上限 ${maxSpriteW}`,
        `显示时会被窗口裁掉两侧；要么把 BASE_W 调大，要么重新裁素材`);
    } else {
      const dispW = Math.round(s.w * (petH / renderH));
      ok(`${k}.png ${s.w}px 宽 -> 窗口内显示 ${dispW}px（上限 ${maxSpriteW}）`);
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

// ---------- 4b. 顶部信息条：徽章与气泡必须堆叠 ----------
// 曾经的 bug：两者都锚在窗口正中的同一条线上（各自 position:absolute + top:6~8px），
// 于是番茄钟跑着的时候她一说台词，徽章和气泡就叠成一团。
// 现在它们摞在 #topBar 这个纵向 flex 里，谁出现谁占位。
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
    '这正是"徽章压气泡"的成因，应该交给 #topBar 堆叠');
} else ok('#bubble 不再绝对定位（由 #topBar 堆叠）');

const stageRule = (petCss.match(/#stage\s*\{([^}]*)\}/) || [, ''])[1];
if (/container-type\s*:\s*inline-size/.test(stageRule)) {
  ok('#stage 声明了 container-type: inline-size');
} else {
  bad('#stage 缺 container-type: inline-size',
    '气泡的 cqw 尺寸会失去参照物，三种缩放下会失配');
}

if (/font-size\s*:\s*[\d.]+cqw/.test(bubbleRule)) {
  ok('#bubble 字号用 cqw（随窗口等比缩放）');
} else {
  bad('#bubble 的字号不是 cqw', '写死 px 的话，小档（291 宽）气泡会占掉窗口约四分之一的高度');
}

if (/backdrop-filter/.test(bubbleRule) && /@supports not\s*\(/.test(petCss)) {
  ok('#bubble 磨砂玻璃 + 无模糊时的兜底都在');
} else {
  bad('#bubble 缺磨砂玻璃或它的 @supports 兜底',
    '兜底是"backdrop-filter 失效时自动加实白底"，少了它气泡会在部分环境里看不清字');
}

// ---------- 4c. 窗口分层：窗口 ≠ 角色 ----------
// v3.2.3 起窗口比角色高一条（顶部留白给气泡），这个分层靠三层 DOM 撑着：
//   #stage（= 窗口，cqw 容器）> #petArea（= 角色区，窗口高 − 17cqw）> #petWrap > .frame
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
  ok('#petArea 高度 = calc(100% − 留白)（cqw，三档等比）');
} else {
  bad('#petArea 的高度算式被改过',
    '必须是 calc(100% - <留白>cqw)：写死 px 的话三档缩放下角色大小会失配');
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
const SPRITE_H = 560;      // build_assets.py 的 --target，所有素材必须统一
const SPRITES = ['maid', 'sailor', 'coat', 'winter'];
function pngSize(p) {
  const b = fs.readFileSync(R(p));
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
const realSprite = {};
for (const f of SPRITES) {
  const s = pngSize(`assets/sprites/${f}.png`);
  realSprite[f] = s;
  if (!s) { bad(`assets/sprites/${f}.png 不是合法 PNG`); continue; }
  if (s.h !== SPRITE_H) {
    bad(`${f}.png 高度是 ${s.h}，应为 ${SPRITE_H}`,
      '各套装高度不一致会让她们站在不同高度上（换装时整个人会跳一下）');
  } else if (maxSpriteW !== null && s.w > maxSpriteW) {
    bad(`${f}.png 宽 ${s.w} 超过上限 ${maxSpriteW}`,
      '.frame 是 height:100% + width:auto，超宽的素材两侧会被窗口裁掉发梢');
  } else ok(`${f}.png  ${s.w}x${s.h}`);
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
const SCAN_SKIP = new Set(['node_modules', 'dist', 'models', '_work', '_review',
  '.git', '__pycache__', '.vscode', '.idea', '.mypy_cache']);
const SCAN_SKIP_EXT = new Set(['.png', '.ico', '.jpg', '.jpeg', '.webp', '.gif',
  '.bmp', '.onnx', '.exe', '.dll', '.zip', '.7z', '.ttf', '.ttc', '.woff',
  '.woff2', '.mp4', '.pdf', '.xlsx', '.sqlite', '.bin', '.node']);

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
      if (!SCAN_SKIP.has(e.name)) walkForScan(path.join(dir, e.name), out);
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

// ---------- 汇总 ----------
console.log('\n' + '-'.repeat(52));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n必须修掉的问题：');
  problems.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
  process.exit(1);
}
console.log('全部通过。');
