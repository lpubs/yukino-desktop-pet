// pomodoro.js —— 番茄钟 / 倒计时引擎（纯主进程模块，不依赖任何渲染层定时器）
//
// 设计要点：
// - 计时全部基于墙钟（endAt = Date.now() + remaining）：事件循环卡顿、渲染层重载、
//   看门狗救活都不影响计时准确性；系统睡眠唤醒后最多 1 秒内补走完成流程。
// - 与 v1.5.0 架构解耦：本模块只管状态与统计；台词 / 铃声 / 广播通过 deps 注入，
//   由 main.js 接线（台词→气泡、铃声→气泡窗口 Web Audio、状态→面板）。
// - 统计：每次结束（自然完成或手动停止）都记一条，保留 90 天。
//   手动停止按实际专注时长计入（用户确认的口径）。
// - 久坐静默：运行期间向桌宠渲染层广播 pomo-active=true；久坐时长照常累计、
//   只是不弹提醒（用户确认的口径，由 pet.js 实现抑制）。
//
// 状态机： idle → focus(专注) → break(休息) → focus ...（循环）
//          idle → countdown（独立倒计时）；focus/break/countdown 任意时刻可停止或暂停

const fs = require('fs');

const KEEP_DAYS = 90;      // 统计记录保留天数
const RETAIN_MAX = 2000;   // 记录条数硬上限（防文件无限膨胀）

function todayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// 洗牌袋：袋内不重复、抽空重洗、跨袋不与上一句重复（与 pet.js 同一套约定）
function makeBag(lines) {
  const arr = (lines && lines.length) ? lines.slice() : ['……'];
  let bag = [], last = null;
  function refill() {
    bag = arr.slice();
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    if (bag.length > 1 && bag[bag.length - 1] === last) bag.unshift(bag.pop());
  }
  return {
    next() {
      if (!bag.length) refill();
      last = bag.pop();
      return last;
    }
  };
}

function createPomodoro(deps) {
  const { config, storePath, say, ring, broadcastState, broadcastActive } = deps;
  const P = (config && config.pomodoro) || {};

  // 可被面板修改并持久化的配置
  // presets：常用番茄钟名称（v1.7.0），面板里可保存/删除，开始时一键选用
  const defCfg = { focusMin: 25, breakMin: 5, countdownMin: 10, ring: true, countdownBubble: true, presets: [] };
  let cfg = { ...defCfg, ...(P.defaults || {}) };
  let records = [];

  function loadStore() {
    try {
      const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      if (Array.isArray(raw.records)) records = raw.records;
      if (raw.cfg) for (const k of Object.keys(defCfg)) if (k in raw.cfg) cfg[k] = raw.cfg[k];
    } catch (e) {}
  }
  function saveStore() {
    try {
      prune();
      fs.writeFileSync(storePath, JSON.stringify({ cfg, records }));
    } catch (e) {}
  }
  function prune() {
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    records = records.filter(r => r && r.ts >= cutoff).slice(-RETAIN_MAX);
  }
  loadStore();

  const bags = {
    start:     makeBag(config.lines && config.lines.pomoStart),
    done:      makeBag(config.lines && config.lines.pomoDone),
    quit:      makeBag(config.lines && config.lines.pomoQuit),
    breakOver: makeBag(config.lines && config.lines.pomoBreakOver)
  };

  // ---- 运行时状态 ----
  let mode = 'idle';         // idle | focus | break | countdown
  let paused = false;
  let endAt = 0;             // 墙钟截止
  let remainMs = 0;          // 暂停时保存的剩余
  let round = 0;             // 番茄钟轮次（从 1 起）
  let plannedSec = 0;        // 本段设定时长
  let startedAt = 0;         // 本段开始墙钟（算实际用时）
  let currentName = '';      // 本轮番茄钟名称（v1.7.0，空 = 未命名）
  let timer = null;

  function cleanName(n) {
    const s = String(n == null ? '' : n).trim().slice(0, 20);
    return s;
  }

  function remaining() {
    if (mode === 'idle') return 0;
    if (paused) return Math.max(0, Math.round(remainMs / 1000));
    return Math.max(0, Math.round((endAt - Date.now()) / 1000));
  }
  function state() {
    return { mode, paused, round, name: currentName, remainSec: remaining(), totalSec: plannedSec, cfg: { ...cfg } };
  }
  function emit() { try { broadcastState(state()); } catch (e) {} }
  function setActive(on) { try { broadcastActive(on); } catch (e) {} }

  function startTick() {
    stopTick();
    timer = setInterval(tick, 1000);
  }
  function stopTick() { if (timer) { clearInterval(timer); timer = null; } }

  function startRun(kind, ms) {
    mode = kind; paused = false;
    startedAt = Date.now();
    plannedSec = Math.round(ms / 1000);
    endAt = startedAt + ms;
    remainMs = ms;
    startTick();
    setActive(true);
    emit();
  }

  function record(type, completed, actualSecOverride) {
    const actual = Math.max(0, Math.round((actualSecOverride != null ? actualSecOverride : plannedSec)));
    records.push({
      ts: Date.now(), date: todayKey(Date.now()),
      type, name: currentName || '',
      plannedMin: Math.round(plannedSec / 60),
      actualSec: actual, completed: !!completed
    });
    saveStore();
  }

  // ---- 对外动作 ----
  function startPomodoro(name) {
    if (mode === 'focus' || mode === 'break') return;
    if (mode === 'countdown') stopInternal(false);   // 开始番茄钟时静默取消倒计时
    currentName = cleanName(name);
    round = 0;
    say(bags.start.next(), 4200);
    nextFocus();
  }
  function nextFocus() {
    round += 1;
    startRun('focus', Math.max(1, cfg.focusMin) * 60000);
  }
  function finishFocus() {
    record('pomodoro', true);
    if (cfg.ring) ring();
    say(bags.done.next(), 4200);
    startRun('break', Math.max(1, cfg.breakMin) * 60000);
  }
  function finishBreak() {
    if (cfg.ring) ring();
    say(bags.breakOver.next(), 3800);
    nextFocus();
  }
  function startCountdown(min, name) {
    if (mode === 'focus' || mode === 'break') stopInternal(true);   // 倒计时优先，静默结束番茄钟（不记完成）
    currentName = cleanName(name);
    const m = Math.max(1, Math.min(600, Number(min) || cfg.countdownMin));
    startRun('countdown', m * 60000);
  }
  function finishCountdown() {
    record('countdown', true);
    if (cfg.ring) ring();
    say(bags.done.next(), 4200);
    mode = 'idle';
    stopTick();
    setActive(false);
    emit();
  }
  function finish() {
    if (mode === 'focus') finishFocus();
    else if (mode === 'break') finishBreak();
    else if (mode === 'countdown') finishCountdown();
  }
  // 用户手动停止。silentStop=true 用于"被另一种计时取代"的场景，不说话不记傲娇账
  function stopInternal(silentStop) {
    if (mode === 'idle') return;
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const wasMode = mode;
    mode = 'idle'; paused = false;
    stopTick();
    setActive(false);
    if (wasMode === 'focus') {
      // 中途停止：按实际专注时长计入统计（用户确认的口径）
      record('pomodoro', false, Math.min(elapsed, plannedSec));
      if (!silentStop) say(bags.quit.next(), 4200);
    } else if (wasMode === 'countdown') {
      if (elapsed >= 30) record('countdown', false, Math.min(elapsed, plannedSec));
      if (!silentStop) say(bags.quit.next(), 4200);
    }
    // break 被手动停止：不是产出，不记录、不说话
    emit();
  }
  function pause() {
    if (mode === 'idle' || paused) return;
    remainMs = endAt - Date.now();
    if (remainMs <= 0) { finish(); return; }
    paused = true;
    stopTick();
    emit();
  }
  function resume() {
    if (mode === 'idle' || !paused) return;
    paused = false;
    endAt = Date.now() + remainMs;
    startTick();
    emit();
  }
  function setCfg(patch) {
    if (!patch || typeof patch !== 'object') return;
    for (const k of Object.keys(defCfg)) {
      if (!(k in patch)) continue;
      if (k === 'focusMin' || k === 'breakMin' || k === 'countdownMin') {
        const v = Math.round(Number(patch[k]));
        if (Number.isFinite(v) && v > 0) cfg[k] = Math.min(k === 'focusMin' ? 240 : 120, Math.max(1, v));
      } else if (k === 'ring' || k === 'countdownBubble') {
        cfg[k] = !!patch[k];
      } else if (k === 'presets') {
        // 常用番茄钟名称：字符串数组，去空格/去重/非空，1~20 字，最多 12 个
        if (Array.isArray(patch.presets)) {
          const seen = new Set();
          cfg.presets = patch.presets
            .map(n => String(n == null ? '' : n).trim().slice(0, 20))
            .filter(n => n && !seen.has(n) && seen.add(n))
            .slice(0, 12);
        }
      }
    }
    saveStore();
    emit();
  }
  function kick() { if (mode !== 'idle' && !paused) tick(); }   // 睡眠唤醒后立即补查

  function tick() {
    if (mode === 'idle' || paused) return;
    if (Date.now() >= endAt) { finish(); return; }
    emit();
  }

  // ---- 统计汇总（面板展示用） ----
  function getStats() {
    const today = todayKey(Date.now());
    let todayCount = 0, todaySec = 0, totalSec = 0, totalCount = 0;
    const byDay = new Map();
    for (const r of records) {
      byDay.set(r.date, (byDay.get(r.date) || 0) + (r.actualSec || 0));
      totalSec += r.actualSec || 0;
      if (r.completed) totalCount++;
      if (r.date === today) {
        todaySec += r.actualSec || 0;
        if (r.completed) todayCount++;
      }
    }
    const week = [];
    for (let i = 6; i >= 0; i--) {
      const d = todayKey(Date.now() - i * 86400000);
      week.push({ date: d, min: Math.round((byDay.get(d) || 0) / 60) });
    }
    let streak = 0, t = Date.now();
    if (!byDay.has(todayKey(t))) t -= 86400000;   // 今天还没开始也算上昨天的连击
    while (byDay.has(todayKey(t))) { streak++; t -= 86400000; }
    // 按名称汇总（复盘用）：每个名字的次数 / 完成数 / 总专注分钟，按总时长降序
    const byNameMap = new Map();
    for (const r of records) {
      const key = r.name || '未命名';
      const e = byNameMap.get(key) || { name: key, count: 0, completed: 0, sec: 0 };
      e.count++;
      if (r.completed) e.completed++;
      e.sec += r.actualSec || 0;
      byNameMap.set(key, e);
    }
    const byName = [...byNameMap.values()]
      .map(e => ({ ...e, min: Math.round(e.sec / 60) }))
      .sort((a, b) => b.sec - a.sec);
    return {
      todayCount, todayMin: Math.round(todaySec / 60),
      totalCount, totalMin: Math.round(totalSec / 60),
      streak, week, byName
    };
  }

  // 最近 n 条明细（复盘用），新的在前
  function getRecords(n) {
    return records.slice(-Math.max(1, n)).reverse();
  }

  return {
    startPomodoro, startCountdown, pause, resume, stop: () => stopInternal(false),
    setCfg, getStats, getRecords, kick,
    state, isRunning: () => mode !== 'idle'
  };
}

module.exports = { createPomodoro };
