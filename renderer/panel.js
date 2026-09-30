// panel.js —— 专注面板渲染脚本
// 数据全部来自主进程（pomoGetData 拉初始值 + onPomoState 每秒推送），本窗口只做展示与发指令。
const $ = (id) => document.getElementById(id);

const MODE_TEXT = { idle: '空闲', focus: '专注中', break: '休息中', countdown: '倒计时' };
let lastState = null;
let lastCfg = null;

function fmt(sec) {
  return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
}

function renderState(s) {
  lastState = s;
  const chip = $('mode-chip');
  const running = s.mode !== 'idle';
  chip.textContent = MODE_TEXT[s.mode] || '空闲';
  chip.className = running ? (s.paused ? 'paused' : 'run') : '';
  chip.id = 'mode-chip';
  $('clock').textContent = fmt(running ? s.remainSec : s.cfg.focusMin * 60);
  $('round-line').textContent = running && s.mode !== 'countdown'
    ? (s.name ? '「' + s.name + '」· ' : '') + '第 ' + s.round + ' 轮 · 设定 ' + Math.round(s.totalSec / 60) + ' 分钟'
    : (running ? (s.name ? '「' + s.name + '」· ' : '') + '设定 ' + Math.round(s.totalSec / 60) + ' 分钟' : '\u00a0');
  $('btn-pause').disabled = !running;
  $('btn-pause').textContent = s.paused ? '继续' : '暂停';
  $('btn-stop').disabled = !running;
  $('btn-pomo').disabled = s.mode === 'focus' || s.mode === 'break';
  $('btn-count').disabled = running;
  lastCfg = s.cfg;
  renderPresets(s.cfg.presets);
  // 同步设置输入框（仅当未聚焦时，避免打断用户输入）
  syncInputs(s.cfg);
}

function syncInputs(cfg) {
  const map = { 'in-focus': 'focusMin', 'in-break': 'breakMin', 'in-count': 'countdownMin' };
  for (const [id, key] of Object.entries(map)) {
    const el = $(id);
    if (document.activeElement !== el && Number(el.value) !== cfg[key]) el.value = cfg[key];
  }
  const ring = $('in-ring'), bub = $('in-bubble');
  if (ring.checked !== cfg.ring) ring.checked = cfg.ring;
  if (bub.checked !== cfg.countdownBubble) bub.checked = cfg.countdownBubble;
}

function renderStats(st) {
  $('s-today-count').textContent = st.todayCount;
  $('s-today-min').textContent = st.todayMin;
  $('s-streak').textContent = st.streak;
  $('s-total-count').textContent = st.totalCount;
  const chart = $('chart'), axis = $('chart-x');
  chart.innerHTML = '';
  axis.innerHTML = '';
  const max = Math.max(1, ...st.week.map(w => w.min));
  st.week.forEach((w, i) => {
    const isToday = i === st.week.length - 1;
    const wrap = document.createElement('div');
    wrap.className = 'bar-wrap';
    const bar = document.createElement('div');
    bar.className = 'bar' + (isToday ? ' today' : '') + (w.min ? '' : ' empty');
    bar.style.height = Math.max(3, Math.round(w.min / max * 100)) + '%';
    bar.title = w.date + '：' + w.min + ' 分钟';
    wrap.appendChild(bar);
    chart.appendChild(wrap);
    const lab = document.createElement('span');
    if (isToday) { lab.textContent = '今天'; lab.className = 'today'; }
    else lab.textContent = w.date.slice(5).replace('-', '/');
    lab.title = w.date + '：' + w.min + ' 分钟';
    axis.appendChild(lab);
  });
  renderByName(st.byName || []);
}

// 按名称统计（复盘）
function renderByName(byName) {
  const box = $('by-name');
  box.innerHTML = '';
  if (!byName.length) {
    box.innerHTML = '<div class="empty-hint">还没有记录。给番茄钟起个名字开始吧。</div>';
    return;
  }
  for (const e of byName) {
    const row = document.createElement('div');
    row.className = 'bn-row';
    const rate = e.count ? Math.round(e.completed / e.count * 100) : 0;
    row.innerHTML = '<span class="bn-name"></span><span class="bn-meta"></span>';
    row.querySelector('.bn-name').textContent = e.name;
    row.querySelector('.bn-meta').textContent =
      e.count + ' 次 · 完成 ' + rate + '% · 共 ' + e.min + ' 分钟';
    box.appendChild(row);
  }
}

// 最近记录明细
function renderRecords(records) {
  const box = $('records');
  box.innerHTML = '';
  if (!records || !records.length) {
    box.innerHTML = '<div class="empty-hint">暂无记录。</div>';
    return;
  }
  for (const r of records) {
    const row = document.createElement('div');
    row.className = 'rec-row';
    const d = new Date(r.ts);
    const hh = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const mm = Math.floor((r.actualSec || 0) / 60), ss = (r.actualSec || 0) % 60;
    const dur = (r.completed ? mm : mm + ':' + String(ss).padStart(2, '0'));
    const tag = r.completed ? '<span class="rec-ok ok">完成</span>' : '<span class="rec-ok giveup">中断</span>';
    row.innerHTML =
      '<span class="rec-time"></span><span class="rec-name"></span>' +
      '<span class="rec-dur"></span>' + tag;
    row.querySelector('.rec-time').textContent = r.date.slice(5) + ' ' + hh;
    row.querySelector('.rec-name').textContent = (r.name || '未命名') + '（' + (r.type === 'countdown' ? '倒计时' : '番茄钟') + '）';
    row.querySelector('.rec-dur').textContent = r.completed ? dur + ' 分' : dur;
    row.title = r.date + ' ' + hh + ' · 设定 ' + r.plannedMin + ' 分钟 · 实际 ' + Math.floor((r.actualSec||0)/60) + ' 分 ' + ss + ' 秒';
    box.appendChild(row);
  }
}

// ---- 名称预设（v1.7.0）----
function renderPresets(presets) {
  const box = $('presets');
  box.innerHTML = '';
  (presets || []).forEach((name) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const label = document.createElement('span');
    label.textContent = name;
    label.title = '点击选用「' + name + '」';
    label.addEventListener('click', () => { $('in-name').value = name; });
    const del = document.createElement('span');
    del.className = 'del';
    del.textContent = '×';
    del.title = '删除常用「' + name + '」';
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      window.pet.pomoSaveCfg({ presets: (lastCfg.presets || []).filter(p => p !== name) });
    });
    chip.appendChild(label);
    chip.appendChild(del);
    box.appendChild(chip);
  });
}

function savePreset() {
  const name = $('in-name').value.trim();
  if (!name) return;
  const list = lastCfg.presets || [];
  if (!list.includes(name) && list.length >= 12) return;   // 上限 12 个
  window.pet.pomoSaveCfg({ presets: list.includes(name) ? list : [...list, name] });
}

function saveCfg() {
  window.pet.pomoSaveCfg({
    focusMin: Number($('in-focus').value),
    breakMin: Number($('in-break').value),
    countdownMin: Number($('in-count').value),
    ring: $('in-ring').checked,
    countdownBubble: $('in-bubble').checked
  });
}

$('btn-pomo').addEventListener('click', () => window.pet.pomoStart($('in-name').value));
$('btn-count').addEventListener('click', () => window.pet.pomoStartCountdown(undefined, $('in-name').value));
$('btn-save-preset').addEventListener('click', savePreset);
$('btn-pause').addEventListener('click', () => { if (lastState && lastState.paused) window.pet.pomoResume(); else window.pet.pomoPause(); });
$('btn-stop').addEventListener('click', () => window.pet.pomoStop());
$('btn-close').addEventListener('click', () => window.pet.pomoClosePanel());
for (const id of ['in-focus', 'in-break', 'in-count', 'in-ring', 'in-bubble']) {
  $(id).addEventListener('change', saveCfg);
}

window.pet.onPomoState((s) => renderState(s));

// 初始拉取：状态 + 统计 + 记录明细
window.pet.pomoGetData().then(({ state, stats, records }) => {
  renderState(state);
  renderStats(stats);
  renderRecords(records);
}).catch(() => {});
