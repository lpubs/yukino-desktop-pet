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
// 查的是 BASE_W / BASE_H（100% 档的基准尺寸），不是"当前窗口尺寸" ——
// 后者随缩放档变化，真值只有主进程知道，渲染层一律用 getWorkArea/getBounds 问它。
for (const k of ['BASE_W', 'BASE_H']) {
  const a = constOf(mainJs, k);
  const b = constOf(petJs, k) ?? constOf(prevHtml, k);
  if (a === null) bad(k + ' 在 main.js 里找不到定义');
  else if (b === null) bad(k + ' 在 pet.js / preview.html 里找不到定义');
  else if (a !== b) bad(`${k} 不一致`, `main.js=${a} 渲染层=${b}`);
  else ok(`${k} = ${a}`);
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
// 好处是四套装扮的显示高度一律等于窗口高度（换装时不会一大一小），
// 代价是素材太宽时两侧发梢会被窗口裁掉 —— 这一节就是那个代价的守门人。
section('[2b] 素材宽度上限');
const renderH = constOf(mainJs, 'RENDER_H');
const baseW = constOf(mainJs, 'BASE_W'), baseH = constOf(mainJs, 'BASE_H');
// PET_MAX_SPRITE_W 是个表达式而不是字面量，所以单独认它（顺带把公式也钉住：
// 一旦有人改了 BASE_W 却忘了同步上限，这条会立刻响）
const hasFormula = /PET_MAX_SPRITE_W\s*=\s*Math\.floor\(\s*BASE_W\s*\*\s*RENDER_H\s*\/\s*BASE_H\s*\)/.test(mainJs);
if (renderH === null || baseW === null || baseH === null) {
  bad('RENDER_H / BASE_W / BASE_H 定义不全');
} else if (!hasFormula) {
  bad('PET_MAX_SPRITE_W 的定义式被改过',
    '它必须是 Math.floor(BASE_W * RENDER_H / BASE_H)，否则素材宽度上限会悄悄失效');
} else {
  ok(`PET_MAX_SPRITE_W = floor(${baseW} × ${renderH} / ${baseH}) = ${Math.floor(baseW * renderH / baseH)}`);
}
const maxSpriteW = hasFormula && baseW && renderH && baseH
  ? Math.floor(baseW * renderH / baseH) : null;

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
      const dispW = Math.round(s.w * (baseH / renderH));
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

// ---------- 汇总 ----------
console.log('\n' + '-'.repeat(52));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n必须修掉的问题：');
  problems.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
  process.exit(1);
}
console.log('全部通过。');
