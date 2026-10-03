// 雪乃桌宠 · 渲染层状态机与行为引擎
//
// 分层：
//   素材层  三张 <img> 叠放，靠 opacity 切帧（不换 src，不会闪）
//   动作层  CSS animation，以脚底为轴做形变
//   状态层  idle / walk / drag / pomodoro 四态，互斥
//
// 一条原则：所有跟窗口位置的交互都走主进程 moveTo，渲染层不假设自己知道坐标。

const $ = (s) => document.querySelector(s);

// 窗口尺寸必须与 main.js 的 BASE_W / BASE_H 一致（100% 档）。
// 但**不要**拿它们去算位置：用户可以缩放到 72% / 128%，实际尺寸只有主进程知道。
// 所有落点计算一律用 getWorkArea() / getBounds() 返回的实时值，
// 下面这两个常量只作为"主进程还没回答"时的兜底。
const WIN_W = 404, WIN_H = 400;
// 地面基准：角色脚底恰好停在「工作区底边」（= 任务栏上沿），
// 所以落点 y = 工作区高 - 窗口高 + sink。公式必须与 main.js 的 groundYOf()
// 完全一致，否则拖拽松手后角色会停在和"初始位置/换装后位置"不同的高度上。
const groundY = (area) => (area.y || 0) + area.height - (area.petH || WIN_H) + (area.sink || 0);

const wrap = $('#petWrap');
const lookWrap = $('#lookWrap');
const fBase = $('#fBase');
const bubble = $('#bubble'), bubbleText = $('#bubbleText');
const badge = $('#badge'), badgeName = $('#badgeName'), badgeTime = $('#badgeTime');
const panel = $('#panel'), pomForm = $('#pomForm'), pomRun = $('#pomRun');
const pomInput = $('#pomInput'), pomNameEl = $('#pomName'), pomTimeEl = $('#pomTime');

const rand = (a) => a[Math.floor(Math.random() * a.length)];
function pick(arr) {                     // 避免连续抽到同一条台词
  if (!arr || !arr.length) return '';
  if (arr.length === 1) return arr[0];
  let i;
  do { i = Math.floor(Math.random() * arr.length); } while (i === pick._last);
  pick._last = i;
  return arr[i];
}

// ---------- 素材 ----------
const OUTFITS = {
  maid:   { name: '女仆装',       dir: '../assets/sprites/maid' },
  sailor: { name: '水手服+贝雷帽', dir: '../assets/sprites/sailor' },
  coat:   { name: '冬大衣+围巾',   dir: '../assets/sprites/coat' },
  winter: { name: '冬装（全身）',  dir: '../assets/sprites/winter' }
};
const frames = {};   // key -> { base: Image }

function loadFrames(key) {
  if (frames[key]) return frames[key];
  const o = OUTFITS[key];
  if (!o) return null;
  const f = { base: new Image() };
  f.base.src = o.dir + '.png';
  frames[key] = f;
  return f;
}

const state = { outfit: 'maid', mode: 'idle' };
// 缩放档的本地镜像。真值在主进程（settings.json），这里只用来算"下一档是哪一档"。
const SIZE_ORDER = ['small', 'medium', 'large'];
let curScaleKey = 'medium';

function paint() { fBase.classList.add('on'); }

// 启动时就把四套全拉进内存。换装才能是纯 src 切换：
// 本地文件也要走一次磁盘 IO，如果第一次切到某套时才现读，
// 淡出之后会淡入一片空白。
Object.keys(OUTFITS).forEach(loadFrames);

// 换装：淡出 -> 换 src -> 淡入。
// 直接赋值 src 会"啪"地跳一下（尺寸还不同，跳得更明显），
// 160ms 的交叉淡入几乎不花成本，但换装手感完全是两回事。
let swapTimer = null;
function applyOutfit(key, immediate) {
  if (!OUTFITS[key]) key = 'maid';
  state.outfit = key;
  window.pet.setSettings({ outfit: key });
  clearTimeout(swapTimer);
  if (immediate) {                       // 启动时不要淡入，否则开场白已经说了人还没出现
    fBase.src = loadFrames(key).base.src;
    paint();
    return;
  }
  fBase.classList.remove('on');
  swapTimer = setTimeout(() => {
    fBase.src = loadFrames(key).base.src;
    paint();
  }, 150);
}
window.pet.onOutfit((k) => {
  applyOutfit(k);
  say(pick(QUOTES.outfit[k] || QUOTES.idle), 3600);
  emote('✨');
});

// 缩放（右键菜单 / Ctrl+滚轮）。窗口由主进程按"底边 + 水平中心"重排，
// 渲染层只需要把新位置记下来 —— 否则下次启动会回到缩放前的位置。
window.pet.onScale((k) => {
  curScaleKey = k;
  emote(k === 'small' ? '🔍' : k === 'large' ? '🔎' : '👌');
  window.pet.getBounds().then((b) => { if (b) window.pet.savePos(b.x, b.y); });
});

// ---------- 动画 ----------
const ANIMS = ['bounce', 'jump', 'shake', 'dangle', 'nod', 'spin', 'walk'];
function anim(name, dur) {
  ANIMS.forEach((c) => wrap.classList.remove(c));
  void wrap.offsetWidth;                 // 强制重排，才能重启动画
  wrap.classList.add(name);
  if (dur) setTimeout(() => wrap.classList.remove(name), dur);
}
function setPose(cls) {                  // 互斥的待机姿态
  ['breathe', 'sleep', 'focus'].forEach((c) => wrap.classList.remove(c));
  if (cls) wrap.classList.add(cls);
}

// ---------- 说话 / 表情 ----------
let bubbleTimer = null, typeTimer = null;
function say(text, dur) {
  if (!text) return;
  clearTimeout(bubbleTimer); clearInterval(typeTimer);
  bubble.classList.remove('hidden');
  bubbleText.textContent = '';
  let i = 0;
  typeTimer = setInterval(() => {
    bubbleText.textContent = text.slice(0, ++i);
    if (i >= text.length) clearInterval(typeTimer);
  }, 26);
  bubbleTimer = setTimeout(() => bubble.classList.add('hidden'), dur || 3600);
}
function quote(arr, vars) {
  const t = pick(arr);
  if (!t) return;
  say(t.replace(/\{name\}/g, vars || ''), 3200 + t.length * 55);
}
function emote(ch) {
  const e = $('#emote');
  e.textContent = ch;
  e.classList.remove('hidden');
  e.style.animation = 'none'; void e.offsetWidth; e.style.animation = '';
  setTimeout(() => e.classList.add('hidden'), 1450);
}
function particles(chars, n) {
  const box = $('#particles');
  for (let i = 0; i < (n || 3); i++) {
    setTimeout(() => {
      const p = document.createElement('div');
      p.className = 'pt';
      p.textContent = rand(chars);
      p.style.left = (28 + Math.random() * 44) + '%';
      p.style.top = (34 + Math.random() * 26) + '%';
      p.style.setProperty('--dx', ((Math.random() - .5) * 64) + 'px');
      p.style.setProperty('--rot', ((Math.random() - .5) * 44) + 'deg');
      box.appendChild(p);
      setTimeout(() => p.remove(), 1800);
    }, i * 200);
  }
}
function blush() {
  const b = $('#blush');
  b.classList.remove('on');
  void b.offsetWidth;                    // 强制重排，动画才能重播
  b.classList.add('on');
}

// ---------- 关于"眨眼" ----------
// 已移除，并且**不要**再加回来。
// 做过两版差分，都是废的：
//   v1 —— 矩形 mask 走 inpaint，模型直接吐出灰块 / 黑条 / 蓝条。
//   v2 —— 把眼区抹平再画一根眼睑弧线。睫毛、下眼睑、外眼角全部消失，
//         只剩一根 1~2px 的细线；眼窝还因为填充算法留下灰霾。
// 根因不是参数没调好，而是**雪乃的上眼睑是又粗又黑的睫毛线**：
// 用程序合成画不出这个画法，用扩散模型局部重绘又会丢角色特征。
// 想真正做对只有两条成熟路线：
//   a) Live2D —— 眼睛是独立图层，眨眼是图层变换，不需要重绘。需要建模师。
//   b) 差分立绘 —— 请画师（或拿到官方差分）画一张闭眼，直接用。
// 两者都不是"再调一版算法"能解决的，所以先把这块去掉，
// 改用叠加式腮红（#blush）承担情绪反馈。

// ---------- 待机动作池 ----------
const idlePool = [
  () => { anim('nod', 900); quote(QUOTES.idle); },
  () => { anim('spin', 1000); emote('♪'); },
  () => { emote('…'); },
  () => { particles(['❄', '☕', '📖'], 2); },
  () => { anim('bounce', 560); },
  () => { quote(QUOTES.idle); },
  () => { anim('nod', 900); emote('👀'); }
];
(function idleLoop() {
  setTimeout(() => {
    if (state.mode === 'idle' && !sleeping) rand(idlePool)();
    idleLoop();
  }, 12000 + Math.random() * 14000);
})();

// ---------- 长时间无互动 -> 睡着 ----------
let lastInteract = Date.now(), sleeping = false;
function wakeUp() {
  if (!sleeping) return false;
  sleeping = false;
  setPose('breathe');
  quote(QUOTES.wake);
  return true;
}
function sleepCheck() {
  if (state.mode !== 'idle' || sleeping) return;
  if (Date.now() - lastInteract > 3 * 60 * 1000) {
    sleeping = true;
    setPose('sleep');
    quote(QUOTES.sleep);
    emote('💤');
  }
}
setInterval(sleepCheck, 20000);

// ---------- 拖拽（自由落体 + 边缘吸附） ----------
let dragging = false, dragOff = { x: 0, y: 0 }, pos = null;

// 角色在窗口里实际占多宽。素材按 height:100% 落位，所以
// 显示宽 = 素材宽 × (窗口高 / 素材高)。
function spriteW(petH) {
  const w = fBase.naturalWidth, h = fBase.naturalHeight;
  if (!w || !h) return petH * WIN_W / WIN_H;   // 图还没解码完，按窗口比例估一个
  return w * (petH / h);
}

// 松手时的横向吸附：把**角色的外轮廓**贴到屏幕边缘。
// 不能夹窗口边缘 —— 角色在窗口里是水平居中的，而角色宽度往往远小于窗口宽度
// （水手服只有 264px，窗口 404），夹窗口会在角色和屏幕边之间留一大条缝，
// 看起来像"贴了个寂寞"。
const SNAP = 26;
function snapX(x, area, petW, sw) {
  const left = x + (petW - sw) / 2;
  const right = left + sw;
  if (left - area.x < SNAP) return Math.round(area.x - (petW - sw) / 2);
  if ((area.x + area.width) - right < SNAP) {
    return Math.round(area.x + area.width - petW + (petW - sw) / 2);
  }
  return Math.round(x);
}

wrap.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  dragging = true;
  lastInteract = Date.now();
  wakeUp();
  wrap.classList.add('grabbing');
  anim('dangle');
  quote(QUOTES.drag);
  emote('💢');
  window.pet.setBlock(true);       // 拖拽期间停掉几何巡检，免得跟手的动作抢
  window.pet.getBounds().then((b) => {
    if (!b) return;
    pos = { x: b.x, y: b.y };
    dragOff = { x: e.screenX - b.x, y: e.screenY - b.y };
  });
});

window.addEventListener('mousemove', (e) => {
  if (!dragging || !pos) return;
  pos = { x: e.screenX - dragOff.x, y: e.screenY - dragOff.y };
  window.pet.moveTo(pos.x, pos.y);
});

let fallRAF = 0;
// 松手后的收尾：垂直自由落体 + 水平匀速滑向吸附位。
// 水平**不加**速度渐变 —— 加了看起来像被"吸"过去，匀速才像自己挪过去。
function settle(x0, y0, x1, y1) {
  const finish = () => {
    anim('bounce', 560);
    quote(QUOTES.drop);
    particles(['💥'], 1);
    window.pet.savePos(x1, y1);     // 记住她停在哪，重启不会再回到右上角
  };
  if (y0 >= y1 - 1 && Math.abs(x1 - x0) < 2) {
    window.pet.moveTo(x1, y1);
    finish();
    return;
  }
  let x = x0, y = y0, v = 2;
  const step = () => {
    if (dragging) return;
    if (y < y1) { v = Math.min(v + 2.0, 34); y = Math.min(y + v, y1); } else { y = y1; }
    const dx = x1 - x;
    x = Math.abs(dx) <= 6 ? x1 : x + Math.sign(dx) * 6;
    window.pet.moveTo(x, y);
    if (y === y1 && x === x1) { finish(); return; }
    fallRAF = requestAnimationFrame(step);
  };
  step();
}

function endDrag() {
  if (!dragging) return;
  dragging = false;
  cancelAnimationFrame(fallRAF);
  wrap.classList.remove('grabbing');
  window.pet.setBlock(false);
  const p = pos; pos = null;
  Promise.all([window.pet.getWorkArea(), window.pet.getBounds()]).then(([area, b]) => {
    const petW = (b && b.width) || area.petW || WIN_W;
    const petH = (b && b.height) || area.petH || WIN_H;
    const targetY = groundY(area);
    let x = p ? p.x : (b ? b.x : 0);
    const y = p ? p.y : targetY;
    x = snapX(x, area, petW, spriteW(petH));
    // 原来这里是 `if (startY < targetY) fall(); else 只弹一下不移动` ——
    // 那个 else 什么都不做，于是每拖一次就往下沉一截，拖几次人整个掉出屏幕。
    // 现在两条分支都走 settle()，不存在"什么都不做"的出口。
    settle(x, y, x, targetY);
  });
}
window.addEventListener('mouseup', endDrag);
window.addEventListener('blur', endDrag);   // 鼠标甩出窗口、收不到 mouseup 时兜底

// ---------- Ctrl + 滚轮缩放 ----------
// 只认 Ctrl，普通滚轮不劫持 —— 不然鼠标无意中在桌宠上滚一下就变了大小。
window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const i = SIZE_ORDER.indexOf(curScaleKey);
  const next = SIZE_ORDER[Math.min(SIZE_ORDER.length - 1, Math.max(0, i + (e.deltaY > 0 ? -1 : 1)))];
  if (next === curScaleKey) return;
  window.pet.setSettings({ scale: next });   // 主进程改窗口 -> 回广播 'scale'
}, { passive: false });

// ---------- 点击 / 双击 ----------
let clickCount = 0, clickTimer = null;
wrap.addEventListener('click', () => {
  lastInteract = Date.now();
  if (wakeUp()) return;
  clickCount++;
  if (clickCount === 1) {
    clickTimer = setTimeout(() => {
      clickCount = 0;
      anim('bounce', 560);
      quote(QUOTES.click);
      emote(rand(['❓', '❗', '…']));
    }, 250);
  } else {
    clearTimeout(clickTimer);
    clickCount = 0;
    anim('jump', 720);
    quote(QUOTES.doubleClick);
    particles(['💗', '✨', '💕'], 5);
    blush();
  }
});

// ---------- 目光跟随 + 摸头（共用一个 mousemove） ----------
// 目光跟随：鼠标在窗口里时整层微移。幅度刻意做小（横 ±5px / 纵 ±2.5px）——
// 大了就变成"人物在飘"，而不是"转头看你"；配合 #lookWrap 上 .45s 的缓动才像有意识。
let patTimer = null;
function lookAt(e) {
  const r = wrap.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const nx = Math.max(-.5, Math.min(.5, (e.clientX - r.left) / r.width - .5));
  const ny = Math.max(-.5, Math.min(.5, (e.clientY - r.top) / r.height - .5));
  lookWrap.style.transform =
    'translate(' + (nx * 10).toFixed(1) + 'px,' + (ny * 5).toFixed(1) + 'px)';
}
function lookAway() { lookWrap.style.transform = ''; }

wrap.addEventListener('mousemove', (e) => {
  if (!dragging) lookAt(e);
  const r = wrap.getBoundingClientRect();
  const inHead = (e.clientY - r.top) < r.height * 0.32;
  if (inHead) {
    if (!patTimer) {
      patTimer = setTimeout(() => {
        patTimer = null;
        lastInteract = Date.now();
        particles(['💗', '♡', '✨'], 5);
        quote(QUOTES.pat);
        anim('nod', 900);
        blush();
      }, 1100);
    }
  } else if (patTimer) {
    clearTimeout(patTimer);
    patTimer = null;
  }
});
wrap.addEventListener('mouseleave', () => {
  lookAway();
  if (patTimer) { clearTimeout(patTimer); patTimer = null; }
});

// 鼠标靠近就把睡着的人叫醒 —— 不用点，路过就醒，比"必须点一下"自然得多。
// 但要等一下（350ms）：鼠标只是路过时不该把她吵醒。
let nearTimer = null;
wrap.addEventListener('mouseenter', () => {
  if (!sleeping) return;
  nearTimer = setTimeout(() => { nearTimer = null; wakeUp(); }, 350);
});
wrap.addEventListener('mouseleave', () => {
  if (nearTimer) { clearTimeout(nearTimer); nearTimer = null; }
});

// ---------- 右键菜单 ----------
wrap.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.pet.showMenu();
});

// ---------- 走动 ----------
async function walk() {
  if (state.mode !== 'idle') return;
  state.mode = 'walk';
  wakeUp();
  quote(QUOTES.walk);
  anim('walk');
  const area = await window.pet.getWorkArea();
  const b = await window.pet.getBounds();
  if (!b) { state.mode = 'idle'; setPose('breathe'); return; }

  const dir = Math.random() < .5 ? -1 : 1;
  let x = b.x;
  const y = groundY(area);
  // 用 getBounds() 的实际宽度，不用常量 —— 缩放后窗口宽度是变的
  const target = Math.min(Math.max(x + dir * (140 + Math.random() * 320), area.x),
                          area.x + area.width - b.width);
  fBase.style.transform = 'translateX(-50%) scaleX(' + (dir < 0 ? -1 : 1) + ')';

  const step = () => {
    if (state.mode !== 'walk') return;
    if (Math.abs(x - target) < 3) { endWalk(); return; }
    x += dir * 2.6;
    window.pet.moveTo(x, y);
    requestAnimationFrame(step);
  };
  step();
  setTimeout(() => { if (state.mode === 'walk') endWalk(); }, 5200);

  function endWalk() {
    state.mode = 'idle';
    ANIMS.forEach((c) => wrap.classList.remove(c));
    fBase.style.transform = '';
    setPose('breathe');
    // 走完也记一下位置：不然她走到屏幕另一头，重启后又回原处
    window.pet.getBounds().then((nb) => { if (nb) window.pet.savePos(nb.x, nb.y); });
  }
}

// ---------- 番茄钟 ----------
let pom = null;
const fmt = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');

document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
  document.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
  c.classList.add('active');
}));

function openPomodoro() {
  if (state.mode === 'pomodoro') return;
  panel.classList.remove('hidden');
  pomRun.classList.add('hidden');
  pomForm.classList.remove('hidden');
  pomInput.focus();
}

$('#btnStart').addEventListener('click', () => {
  const chip = document.querySelector('.chip.active') || document.querySelector('.chip');
  const mins = parseInt(chip.dataset.min, 10) || 25;
  const name = pomInput.value.trim() || '未命名番茄';
  pom = { name, total: mins * 60, left: mins * 60, paused: false, quarterSaid: false, startedAt: Date.now() };
  state.mode = 'pomodoro';
  sleeping = false;

  pomForm.classList.add('hidden');
  pomRun.classList.remove('hidden');
  pomNameEl.textContent = name;
  badge.classList.remove('hidden');
  badgeName.textContent = name;
  badgeTime.textContent = fmt(pom.left);
  setPose('focus');
  quote(QUOTES.pomStart, name);
  emote('📖');
  pom.timer = setInterval(tick, 1000);
});

function tick() {
  if (!pom || pom.paused) return;
  pom.left--;
  if (pom.left < 0) pom.left = 0;
  badgeTime.textContent = fmt(pom.left);
  pomTimeEl.textContent = fmt(pom.left);
  const passed = pom.total - pom.left;
  if (!pom.quarterSaid && passed >= Math.floor(pom.total / 4)) {
    pom.quarterSaid = true;
    quote(QUOTES.pomQuarter);
    emote('☕');
  }
  if (pom.left <= 0) finishPomodoro(true);
}

function finishPomodoro(completed) {
  if (!pom) return;
  clearInterval(pom.timer);
  const minutes = Math.max(1, Math.round((pom.total - pom.left) / 60));
  window.pet.addRecord({
    name: pom.name, minutes, completed,
    startedAt: pom.startedAt, endedAt: Date.now(), planned: Math.round(pom.total / 60)
  });
  badge.classList.add('hidden');
  panel.classList.add('hidden');
  pomRun.classList.add('hidden');
  pomForm.classList.remove('hidden');
  setPose('breathe');
  state.mode = 'idle';

  if (completed) {
    anim('jump', 720);
    particles(['🎉', '✨', '☕', '💯'], 7);
    quote(QUOTES.pomDone, pom.name);
    emote('🎉');
    blush();
  } else {
    quote(QUOTES.pomAbandon, pom.name);
    emote('💧');
  }
  pom = null;
}

$('#btnPause').addEventListener('click', () => {
  if (!pom) return;
  pom.paused = !pom.paused;
  $('#btnPause').textContent = pom.paused ? '继续' : '暂停';
  if (pom.paused) emote('⏸'); else quote(QUOTES.pomQuarter);
});
$('#btnStop').addEventListener('click', () => finishPomodoro(false));
$('#btnStats').addEventListener('click', () => window.pet.showStats());
$('#btnStats2').addEventListener('click', () => window.pet.showStats());

// 点面板外部收起
document.addEventListener('mousedown', (e) => {
  if (state.mode === 'idle' && !panel.classList.contains('hidden') && !panel.contains(e.target)) {
    panel.classList.add('hidden');
  }
});

window.pet.onAction((a) => {
  if (a === 'walk') walk();
  if (a === 'open-pomodoro') openPomodoro();
});

// ---------- 启动 ----------
(async () => {
  const s = await window.pet.getSettings();
  if (s.scale) curScaleKey = s.scale;
  applyOutfit(s.outfit || 'maid', true);   // 首次不做淡入，别让开场白先于人出现
  setPose('breathe');
  const h = new Date().getHours();
  setTimeout(() => {
    if (h >= 23 || h < 5) quote(QUOTES.night);
    else if (h < 11) quote(QUOTES.morning);
    else quote(QUOTES.greeting);
  }, 700);
})();

// ---------- 心跳（主进程靠它判断渲染层是否假死） ----------
setInterval(() => window.pet.heartbeat(), 5000);

// ---------- 调试出口 ----------
// 只给 renderer/preview.html 用（它会在加载本文件前设置 window.__PET_DEBUG__ = true）。
// 真机上这个开关永远是 undefined，所以这些内部函数不会泄露到 window 上，
// 免得渲染层多出一堆可被外部脚本乱调的全局入口。
if (window.__PET_DEBUG__) {
  window.__petDemo = {
    blush, anim, emote, particles, quote,
    walk, openPomodoro, applyOutfit,
    lookAt, lookAway,
    // 验收"边缘吸附"用：把角色放到指定 x，然后走一遍真实的松手收尾
    // （scrub -> snapX -> settle），不是另写一段演示逻辑。
    dropAt(px, py) {
      return Promise.all([window.pet.getWorkArea(), window.pet.getBounds()]).then(([area, b]) => {
        if (!b) return null;
        const sw = spriteW(b.height);
        const sx = snapX(px, area, b.width, sw);
        const ty = groundY(area);
        settle(sx, (py === undefined ? ty : py), sx, ty);
        return { dropped: px, snapped: sx, sw: Math.round(sw) };
      });
    },
    setScale: (k) => window.pet.setSettings({ scale: k }),
    sleep() {
      if (state.mode !== 'idle' || sleeping) return;
      sleeping = true;
      setPose('sleep');
      quote(QUOTES.sleep);
      emote('💤');
    },
    forceSleep() { lastInteract = Date.now() - 4 * 60 * 1000; sleepCheck(); },
    wake: wakeUp,
    pet(k) {
      // 走一遍和真机右键菜单完全相同的路径：主进程发 outfit -> 渲染层 onOutfit
      window.pet._fireOutfit && window.pet._fireOutfit(k);
    },
    action(a) { window.pet._fireAction && window.pet._fireAction(a); },
    getState: () => ({ ...state, sleeping, hasPom: !!pom, scale: curScaleKey })
  };
}
