// 番茄统计 · 渲染逻辑
//
// 注意：这里必须是**外部文件**，不能写回 stats.html 的内联 <script>。
// stats.html 的 CSP 是 script-src 'self'，内联脚本会被直接拦掉，
// 页面会一直显示空数据 —— 而且不报错，很难发现。
//
// 单独用浏览器打开 stats.html 时没有 preload 提供的 window.pet，
// 所以下面给一份替身（带 #demo 的示例数据），方便脱离 Electron 验收。

const $ = (s) => document.querySelector(s);

// ---- 浏览器替身（Electron 下不会执行，window.pet 已由 preload 注入） ----
if (!window.pet) {
  const day = 86400000, now0 = Date.now();
  const SAMPLE = [
    ['高数', 30, true, 0, 0.0], ['高数', 25, true, 0, 0.4], ['英语阅读', 25, true, 0, 0.2],
    ['有机化学', 45, true, 1, 0.0], ['有机化学', 20, false, 1, 0.2], ['写代码', 60, true, 2, 0.1],
    ['写代码', 30, true, 2, 0.3], ['高数', 15, true, 3, 0.0], ['英语阅读', 45, true, 3, 0.5],
    ['写代码', 90, true, 4, 0.0]
  ].map(([name, minutes, completed, daysAgo, frac], i) => ({
    name, minutes, completed, planned: minutes,
    startedAt: now0 - daysAgo * day - frac * day - i * 60000,
    endedAt: now0 - daysAgo * day - frac * day - i * 60000 + minutes * 60000
  }));

  window.pet = {
    getRecords: async () => {
      const raw = localStorage.getItem('pom_demo');
      if (raw) { try { return JSON.parse(raw); } catch (e) { /* 坏数据就当没有 */ } }
      return /(^|[#?&])demo/.test(location.hash) ? SAMPLE : [];
    },
    clearAll: async () => { localStorage.setItem('pom_demo', '[]'); }
  };
}

// 占比配色：低饱和，七色循环。占比另外用数字标出，不单靠颜色区分。
const COLORS = ['#4a6fa5', '#5f9e8b', '#c08a3e', '#a86a86', '#7b8092', '#6b7fa8', '#8aa26b'];

function fmtMin(m) {
  if (m < 60) return m + '<small>分钟</small>';
  return Math.floor(m / 60) + '<small>小时</small> ' + (m % 60) + '<small>分</small>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render(records) {
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const today = records.filter((r) => r.endedAt >= today0.getTime() && r.completed);

  // 只统计"完成"的时长；放弃的单独计数，不参与占比
  const byName = {};
  let totalMin = 0;
  for (const r of records) {
    const k = r.name || '未命名番茄';
    byName[k] = byName[k] || { done: 0, drop: 0, min: 0 };
    if (r.completed) { byName[k].done++; byName[k].min += r.minutes; totalMin += r.minutes; }
    else { byName[k].drop++; }
  }

  $('#cToday').innerHTML = today.length + '<small>个</small>';
  $('#cMin').innerHTML = fmtMin(totalMin);
  $('#cKinds').innerHTML = Object.keys(byName).length + '<small>类</small>';

  const rows = Object.entries(byName).sort((a, b) => b[1].min - a[1].min);
  const has = rows.some(([, v]) => v.min > 0);

  $('#chartBox').classList.toggle('hidden', !has);
  $('#emptyTip').classList.toggle('hidden', has);
  $('#emptyTip2').classList.toggle('hidden', rows.length > 0);

  const tbody = $('#tbody');
  tbody.innerHTML = '';
  rows.forEach(([name, v]) => {
    const pc = totalMin ? (v.min / totalMin * 100) : 0;
    const tr = document.createElement('tr');
    tr.innerHTML = '<td class="nm">' + escapeHtml(name) + '</td>' +
      '<td>' + v.done + '</td><td>' + (v.drop || '—') + '</td>' +
      '<td>' + v.min + ' 分</td>' +
      '<td>' + pc.toFixed(1) + '%</td>';
    tbody.appendChild(tr);
  });

  // 环形图
  const svg = $('#donut'), R = 46, C = 2 * Math.PI * R;
  svg.innerHTML = '';
  const ns = 'http://www.w3.org/2000/svg';
  const ring = document.createElementNS(ns, 'circle');
  ring.setAttribute('cx', 60); ring.setAttribute('cy', 60); ring.setAttribute('r', R);
  ring.setAttribute('fill', 'none'); ring.setAttribute('stroke', '#eef0f5'); ring.setAttribute('stroke-width', 16);
  svg.appendChild(ring);

  let acc = 0;
  const legend = $('#legend');
  legend.innerHTML = '';
  rows.filter(([, v]) => v.min > 0).forEach(([name, v], i) => {
    const frac = v.min / totalMin;
    const seg = document.createElementNS(ns, 'circle');
    seg.setAttribute('cx', 60); seg.setAttribute('cy', 60); seg.setAttribute('r', R);
    seg.setAttribute('fill', 'none');
    seg.setAttribute('stroke', COLORS[i % COLORS.length]);
    seg.setAttribute('stroke-width', 16);
    seg.setAttribute('stroke-dasharray', (frac * C) + ' ' + C);
    seg.setAttribute('stroke-dashoffset', -acc * C);
    seg.setAttribute('transform', 'rotate(-90 60 60)');
    svg.appendChild(seg);
    acc += frac;

    const lg = document.createElement('div');
    lg.className = 'lg';
    lg.innerHTML = '<span class="sw" style="background:' + COLORS[i % COLORS.length] + '"></span>' +
      '<span class="nm">' + escapeHtml(name) + '</span>' +
      '<span class="pc">' + (frac * 100).toFixed(1) + '%</span>';
    legend.appendChild(lg);
  });

  if (totalMin > 0) {
    const t1 = document.createElementNS(ns, 'text');
    t1.setAttribute('x', 60); t1.setAttribute('y', 57); t1.setAttribute('text-anchor', 'middle');
    t1.setAttribute('font-size', '19'); t1.setAttribute('fill', '#23222a');
    t1.textContent = Math.round(totalMin);
    svg.appendChild(t1);
    const t2 = document.createElementNS(ns, 'text');
    t2.setAttribute('x', 60); t2.setAttribute('y', 72); t2.setAttribute('text-anchor', 'middle');
    t2.setAttribute('font-size', '9'); t2.setAttribute('fill', '#8b90a0');
    t2.textContent = '分钟';
    svg.appendChild(t2);
  }
}

async function refresh() {
  const records = await window.pet.getRecords();
  records.sort((a, b) => b.endedAt - a.endedAt);
  render(records);
  $('#fileHint').textContent = '共 ' + records.length + ' 条记录';
}

$('#btnClear').addEventListener('click', async () => {
  if (!confirm('确定清空全部番茄记录？此操作不可撤销。')) return;
  await window.pet.clearAll();
  refresh();
});

refresh();
