// pet.js —— 渲染进程：状态机 / 摸头 / 久坐提醒 / 待机跑动 / 换装 / 拖拽 / 缩放 / 心跳
// v1.5.0 架构：窗口 = 立绘大小，**永久可交互**（不再有任何穿透切换）。
//   台词气泡在独立窗口显示（通过 window.pet.say 请求主进程）。
//   每 5 秒向主进程报活一次；若渲染层静默假死，主进程看门狗会自动重载本页面。
// 状态：IDLE(待机) WALK(跑动) PAT(被摸头) ANNOY(被摸烦) SLEEP(睡觉) DRAG(拖拽) BLOCK(挡屏)
const S = Object.freeze({
  IDLE: 'idle', WALK: 'walk', PAT: 'pat', ANNOY: 'annoy',
  SLEEP: 'sleep', DRAG: 'drag', BLOCK: 'block'
});

const DRAG_THRESHOLD = 6;               // 超过该像素位移才算拖拽，否则算点击
const BLOCK_AUTO_RELEASE_MS = 10 * 60 * 1000; // 挡屏 10 分钟无响应自动让开（防卡死兜底）

// ---------- DOM ----------
const inner = document.getElementById('sprite-inner');
const wrap = document.getElementById('sprite-wrap');
const blush = document.getElementById('blush');
const blockOverlay = document.getElementById('block-overlay');
const blockText = document.getElementById('block-text');
const blockAck = document.getElementById('block-ack');
const imgs = [0, 1, 2, 3].map(i => document.getElementById('outfit' + i));

// ---------- 全局状态 ----------
let cfg = null, settings = null;
let activeIdx = 0;
let state = S.IDLE;
let zoom = 1;                           // 缩放倍率（0.5 ~ 2.5）
let idleSec = 0, prevIdleSec = 0;       // 系统空闲秒数（主进程 powerMonitor 提供）
let useSec = 0;                         // 连续使用秒数
let shownLevels = new Set();            // 已提醒过的级别
let patTimes = [];                      // 摸头时间戳（判断连摸）
let rollCount = 0;                      // 待机跑动 roll 计数
let idleChatCount = 0;                  // 待机闲聊 roll 计数（v1.7.0）
let lastIdleChatAt = 0;                 // 上次闲聊时间戳（防刷屏）
let walking = null;                     // 跑动动画句柄
let staring = false;
let blockAutoReleaseTimer = null;
let screenInfo = null;                  // { bounds, workArea }（跑动方向规划用）

// 指针（鼠标）状态。关键是任何异常路径都要能把它清干净，否则会"粘住鼠标"。
let pointerDown = false, dragging = false;
let lastScreenX = 0, lastScreenY = 0, downClientX = 0, downClientY = 0;

// ---------- 台词气泡（独立窗口，主进程负责显示/隐藏/跟随） ----------
function say(text, ms) {
  if (!text) return;
  if (settings && settings.muted) return;
  window.pet.say(text, ms || (cfg ? cfg.timers.bubbleMs : 3200));
}

// ---------- 台词：洗牌袋抽取（袋内不重复，换袋也不与上一句重复） ----------
function makeBag(arr) {
  let pool = [], last = null;
  return () => {
    if (!pool.length) {
      pool = [...arr];
      for (let i = pool.length - 1; i > 0; i--) {   // Fisher-Yates
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      if (last && pool.length > 1 && pool[pool.length - 1] === last) {
        [pool[0], pool[pool.length - 1]] = [pool[pool.length - 1], pool[0]];
      }
    }
    last = pool.pop();
    return last;
  };
}
const bags = {};
function pick(catOrArr) {
  const arr = Array.isArray(catOrArr) ? catOrArr : (cfg.lines[catOrArr] || []);
  if (!arr.length) return '';
  if (Array.isArray(catOrArr)) return arr[Math.floor(Math.random() * arr.length)];
  if (!bags[catOrArr]) bags[catOrArr] = makeBag(arr);
  return bags[catOrArr]();
}
const rand = (a, b) => a + Math.random() * (b - a);

// ---------- 状态类切换（互斥！见 style.css 文件头约定） ----------
const ANIM_CLASSES = ['breathe', 'bob', 'wiggle', 'struggle', 'sleep', 'annoy', 'stare'];
function setAnim(...names) {
  ANIM_CLASSES.forEach(c => inner.classList.remove(c));
  names.forEach(c => inner.classList.add(c));
}
function toIdle() {
  if (state === S.BLOCK) return;
  state = S.IDLE;
  setAnim(staring ? 'stare' : 'breathe');
}

// ---------- 缩放 ----------
function applyZoom(z) {
  zoom = z;
  document.documentElement.style.setProperty('--z', String(z));
}
function changeZoom(factor) {
  if (state === S.BLOCK) return;
  const next = Math.min(2.5, Math.max(0.5, zoom * factor));
  applyZoom(next);                          // 本地立即生效，视觉无延迟
  window.pet.setZoom(next);                 // 主进程同步调整窗口尺寸并持久化
}

// ---------- 服装 ----------
function applyFit(img, o) {
  img.style.transformOrigin = '50% 100%';
  img.style.transform = `translate(${o.offsetX || 0}px, ${o.offsetY || 0}px) scale(${o.scale || 1})`;
}
function setOutfit(i, announce = true) {
  if (!cfg || i === activeIdx || i < 0 || i >= cfg.outfits.length) return;
  const o = cfg.outfits[i];
  imgs[activeIdx].classList.remove('active');  // 200ms 淡出（CSS transition）
  imgs[i].classList.add('active');             // 同时淡入，交叉过渡无空档
  activeIdx = i;
  toIdle();                                    // 回到 IDLE，避免动画错位
  if (announce) say(pick(o.switchLines));
  window.pet.saveSettings({ outfit: i });      // 记住选择，重启恢复
}

// ---------- 摸头（窗口 = 立绘，任意位置点击都算摸） ----------
function pat() {
  const now = Date.now();
  if (state === S.ANNOY || state === S.BLOCK || state === S.DRAG) return;
  if (state === S.SLEEP) wake();               // 睡觉时被摸醒
  if (state === S.WALK) stopWalk();
  patTimes = patTimes.filter(t => now - t < cfg.timers.annoyWindowMs);
  patTimes.push(now);
  if (patTimes.length >= cfg.timers.annoyPatCount) { enterAnnoy(); return; }
  state = S.PAT;
  setAnim(staring ? 'stare' : 'breathe');
  void inner.offsetWidth;                      // 重启动画
  inner.classList.add('wiggle');               // wiggle 播完后，底层 stare/breathe 自动恢复
  blush.classList.add('show');                 // 脸红一瞬
  setTimeout(() => blush.classList.remove('show'), 900);
  say(pick('pat'));
  setTimeout(() => { if (state === S.PAT) toIdle(); }, 600);
}
function enterAnnoy() {
  state = S.ANNOY;
  patTimes = [];
  setAnim('annoy');                            // 转身背对（镜像，独立状态，不被盯人覆盖）
  say(pick('annoy'));
  setTimeout(() => { if (state === S.ANNOY) toIdle(); }, cfg.timers.annoyDurationMs);
}

// ---------- 待机 / 睡眠 ----------
function enterSleep() {
  state = S.SLEEP;
  setAnim('sleep');
  if (Math.random() < 0.5) say('……（睡着了。别吵。）');
}
function wake() {
  state = S.IDLE;
  setAnim(staring ? 'stare' : 'breathe');
  rollCount = 0;
  if (Math.random() < 0.4) say(pick('backTalk'));
}

// ---------- 待机跑动（先规划方向，绝不往屏幕外跑） ----------
async function refreshScreenInfo() {
  try { screenInfo = await window.pet.getScreenInfo(); } catch (e) {}
}
function startWalk() {
  if (state !== S.IDLE) return;
  let dir = Math.random() < 0.5 ? -1 : 1;
  let dist = rand(...cfg.timers.walkDistancePx);
  if (screenInfo) {
    const { bounds, workArea } = screenInfo;
    const roomLeft = bounds.x - workArea.x;
    const roomRight = workArea.x + workArea.width - (bounds.x + bounds.width);
    if (dist > (dir < 0 ? roomLeft : roomRight)) {
      // 首选方向没空间 → 换另一侧；两侧都不够 → 取较大一侧并缩短距离
      const other = dir < 0 ? roomRight : roomLeft;
      if (dist <= other) dir = -dir;
      else { dir = roomRight >= roomLeft ? 1 : -1; dist = Math.max(roomLeft, roomRight); }
    }
    if (dist < 30) return;                     // 两侧都没空间，放弃这次跑动
  }
  state = S.WALK;
  setAnim('bob');
  if (Math.random() < 0.5) say(pick('walkTalk'));
  const dur = rand(...cfg.timers.walkDurationSec) * 1000;
  const vx = dir * dist / dur;                 // px/ms
  const t0 = performance.now();
  let last = t0;
  const step = (t) => {
    if (state !== S.WALK) return;              // 被打断（用户回来/被拖/被摸）
    // 兜底：窗口被遮挡时 rAF 可能长时间冻结，恢复后一次性补跑会瞬移——超时直接结束
    if (t - t0 > dur * 3 + 1000) { walking = null; toIdle(); return; }
    const dt = Math.min(50, t - last); last = t;
    window.pet.moveBy(vx * dt, 0);
    if (t - t0 < dur) walking = requestAnimationFrame(step);
    else { walking = null; toIdle(); }
  };
  step(t0);
}
function stopWalk() {
  if (walking) { cancelAnimationFrame(walking); walking = null; }
}

// ---------- 久坐提醒 ----------
// 番茄钟/倒计时运行期间（pomoActive）：连续使用时长照常累计，但提醒全部静默——
// 不弹台词也不弹挡屏；结束后若仍超过阈值会在下一秒自动补弹（shownLevels 未标记）。
let pomoActive = false;
window.pet.onPomoActive((on) => { pomoActive = !!on; });

function checkReminders() {
  if (settings.remindPaused || state === S.BLOCK) return;
  if (pomoActive) return;                                    // 番茄钟静默（时长继续累计）
  const levels = cfg.timers.remindMinutes;                   // [60,120,180,240]
  const lineKeys = ['remind60', 'remind120', 'remind180', 'remind240'];
  for (let i = levels.length - 1; i >= 0; i--) {
    const sec = levels[i] * 60;
    if (useSec >= sec && !shownLevels.has(i)) {
      shownLevels.add(i);
      if (i === levels.length - 1) enterBlock();             // 最高级：挡屏
      else say(pick(lineKeys[i]), 4200);
      break;
    }
  }
}
function enterBlock() {
  state = S.BLOCK;
  stopWalk();
  document.body.classList.add('blocking');
  window.pet.resizeBlockMode(true);                          // 铺满工作区（主进程记住原位置并隐藏气泡）
  blockText.textContent = pick('remind240');
  blockOverlay.classList.add('show');
  // 兜底：10 分钟无响应自动让开，防止按钮点不到被卡死
  clearTimeout(blockAutoReleaseTimer);
  blockAutoReleaseTimer = setTimeout(() => { if (state === S.BLOCK) exitBlock(true); }, BLOCK_AUTO_RELEASE_MS);
}
function exitBlock(auto) {
  clearTimeout(blockAutoReleaseTimer);
  blockOverlay.classList.remove('show');
  document.body.classList.remove('blocking');
  window.pet.resizeBlockMode(false);                         // 精确还原挡屏前位置
  useSec = 0;                                                // 重置连续使用计时
  shownLevels.clear();
  state = S.IDLE;
  setAnim(staring ? 'stare' : 'breathe');
  if (auto) say('……这次先放过你。下不为例。');
}
blockAck.addEventListener('click', () => exitBlock(false));

// ---------- 交互：拖拽 / 摸头 / 右键 ----------
// 结束拖拽并恢复一切状态（任何异常路径都要走这里，避免"粘住鼠标"）
function endDrag(announce) {
  const wasDragging = dragging;
  pointerDown = false;
  dragging = false;
  if (state === S.DRAG) toIdle();
  if (wasDragging && announce) say(pick('dragTalk'));        // 放下后的抱怨
  if (wasDragging) refreshScreenInfo();      // 拖完刷新屏幕信息（下次跑动规划用）
}

document.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !cfg) return;
  pointerDown = true; dragging = false;
  downClientX = e.clientX; downClientY = e.clientY;
  lastScreenX = e.screenX; lastScreenY = e.screenY;
});

document.addEventListener('mousemove', (e) => {
  if (!cfg) return;
  // 兜底：系统层面按键已松开（例如在窗口外松手导致 mouseup 丢失）→ 立即结束拖拽
  if (pointerDown && e.buttons === 0) endDrag(true);

  wrap.style.cursor = pointerDown ? 'grabbing' : 'grab';

  if (pointerDown) {
    // 拖拽：按屏幕坐标位移移动窗口
    const dx = e.screenX - lastScreenX, dy = e.screenY - lastScreenY;
    lastScreenX = e.screenX; lastScreenY = e.screenY;
    if (!dragging && Math.hypot(e.clientX - downClientX, e.clientY - downClientY) > DRAG_THRESHOLD) {
      dragging = true;
      stopWalk();
      if (state !== S.BLOCK) {
        state = S.DRAG;
        setAnim('struggle');                                  // 被拖时挣扎
        if (Math.random() < 0.6) say(pick('struggleTalk'));
      }
    }
    if (dragging) window.pet.moveBy(dx, dy);
    return;
  }

  // 未按键：系统空闲跑动时用户动了鼠标 → 回 IDLE
  if (idleSec < 5 && prevIdleSec >= cfg.timers.idleWalkSec) {
    stopWalk();
    if (state === S.WALK || state === S.SLEEP) wake();
    else if (state === S.IDLE) toIdle();
  }
});

document.addEventListener('mouseup', (e) => {
  if (e.button !== 0 || !cfg) return;
  if (!pointerDown) return;
  const wasDragging = dragging;
  endDrag(true);                             // 统一复位
  if (!wasDragging && state !== S.BLOCK) pat();             // 短按（没拖动）= 摸头
});

// 兜底：指针被系统取消 / 窗口失焦 → 复位，防止状态卡死
document.addEventListener('pointercancel', () => endDrag(false));
window.addEventListener('blur', () => endDrag(false));

// 双击：切换"抱臂盯人"伪姿态（独立状态，取代 breathe，才能真正显示出来）
document.addEventListener('dblclick', () => {
  if (state === S.BLOCK || !cfg) return;
  staring = !staring;
  setAnim(staring ? 'stare' : 'breathe');
  if (staring) say(pick('stareTalk'));
});

// 右键：整个窗口都是她，直接弹菜单
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (cfg) window.pet.showContextMenu();
});

// 滚轮缩放：Ctrl + 滚轮 或 直接在角色上滚轮
document.addEventListener('wheel', (e) => {
  if (!cfg || state === S.BLOCK) return;
  e.preventDefault();
  changeZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
}, { passive: false });

// 快捷键：Ctrl+1~4 换服装，Ctrl+=/-/0 缩放（需点击过桌宠让窗口获得焦点）
document.addEventListener('keydown', (e) => {
  if (!cfg || !e.ctrlKey) return;
  if (e.key === '=' || e.key === '+') { changeZoom(1.15); e.preventDefault(); }
  else if (e.key === '-' || e.key === '_') { changeZoom(1 / 1.15); e.preventDefault(); }
  else if (e.key === '0') { applyZoom(1); window.pet.setZoom(1); e.preventDefault(); }
  else if (['1', '2', '3', '4'].includes(e.key)) {
    const i = Number(e.key) - 1;
    if (i < cfg.outfits.length) { setOutfit(i); e.preventDefault(); }
  }
});

// ---------- 主循环 ----------
// 连续使用计时规则：
//  - 系统空闲 < awayThresholdSec（默认 300s）都算"人在"（看视频/读文档也累计）
//  - 空闲 ≥ awayThresholdSec 判定为离开，回来后从零重算（等于休息过了）
//  - 用墙钟差检测系统休眠/定时器挂起：挂起期间不计入使用（这就是 uptime 校准的作用）
window.pet.onIdleTime((t) => { prevIdleSec = idleSec; idleSec = t; });
let lastTickAt = Date.now();
setInterval(() => {
  if (!cfg) return;
  const now = Date.now();
  const elapsedMs = now - lastTickAt;
  lastTickAt = now;
  const suspended = elapsedMs > 4000;          // 系统刚睡过/定时器被挂起，这段时间不算使用
  const awaySec = cfg.timers.awayThresholdSec;

  if (idleSec >= awaySec) {
    if (useSec > 0) { useSec = 0; shownLevels.clear(); }   // 休息满 5 分钟：清零重算
  } else if (!suspended && state !== S.BLOCK) {
    useSec++;
    checkReminders();
  }

  // 睡眠判定：空闲超过 sleepSec
  if (state === S.IDLE && idleSec >= cfg.timers.sleepSec) { enterSleep(); return; }
  // 待机闲聊（v1.7.0）：人在电脑前（空闲 1~5 分钟）但没摸她时，偶尔自言自语——
  // 天气、吐槽、关心。低频（每 30 秒 roll 一次、8% 概率、两次间隔 ≥3 分钟），睡着/跑动/盯人不说话
  if (state === S.IDLE && idleSec >= 60 && idleSec < cfg.timers.awayThresholdSec) {
    idleChatCount++;
    if (idleChatCount >= cfg.timers.walkRollSec) {
      idleChatCount = 0;
      if (Date.now() - lastIdleChatAt > 180000 && Math.random() < 0.08) {
        lastIdleChatAt = Date.now();
        say(pick('idleTalk'), 4200);
      }
    }
  }
  // 待机跑动：空闲超过 idleWalkSec 后，每 walkRollSec 秒 roll 一次，walkChance 概率触发
  if (state === S.IDLE && idleSec >= cfg.timers.idleWalkSec) {
    rollCount++;
    if (rollCount >= cfg.timers.walkRollSec) {
      rollCount = 0;
      if (Math.random() < cfg.timers.walkChance) startWalk();
    }
  }
}, 1000);

// ---------- 心跳：每 5 秒向主进程报活（静默假死时主进程看门狗会重载本页面） ----------
setInterval(() => window.pet.heartbeat(), 5000);

// ---------- 启动 ----------
(async function boot() {
  const bootData = await window.pet.getBoot();
  cfg = bootData.config;
  settings = bootData.settings;

  applyZoom(settings.zoom || 1);          // 恢复上次的缩放

  // 四套立绘全部开始加载，应用各自的 scale/offset 微调
  imgs.forEach((img, i) => {
    img.src = '../assets/outfits/' + cfg.outfits[i].file;
    applyFit(img, cfg.outfits[i]);
  });
  await Promise.all(imgs.map(img => img.decode().catch(() => null)));

  const o = settings.outfit;
  activeIdx = (Number.isInteger(o) && o >= 0 && o < cfg.outfits.length) ? o : 0;
  imgs[activeIdx].classList.add('active');

  window.pet.onSetOutfit((i) => setOutfit(i));
  window.pet.onSettingsChanged((s) => { settings = s; });
  window.pet.onApplyZoom((z) => applyZoom(z));   // 菜单里点了放大/缩小

  window.pet.heartbeat();                 // 启动即报活
  refreshScreenInfo();

  // 开场台词
  setTimeout(() => say(pick('startup'), 3600), 900);
})();
