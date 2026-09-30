// bubble.js —— 独立气泡窗口的渲染脚本
// 窗口的显示/隐藏/移动/尺寸全部由主进程控制；本窗口永久鼠标穿透，无需任何交互逻辑。
// v1.6.0：新增番茄钟/倒计时徽章（头顶 mm:ss）与结束铃声（Web Audio 合成，无音频文件依赖）。
const root = document.getElementById('bubble');
const textEl = document.getElementById('bubble-text');
const badge = document.getElementById('pomo-badge');
const badgeMode = document.getElementById('pomo-mode');
const badgeTime = document.getElementById('pomo-time');

window.pet.onBubbleShow((text) => {
  textEl.textContent = text;
  root.classList.add('show');
});

window.pet.onBubbleHide(() => {
  root.classList.remove('show');
});

// 倒计时状态广播：s = { mode, paused, remainSec, ... } 或 null（结束/关闭）
const MODE_LABEL = { focus: '专注', break: '休息', countdown: '倒计时' };
window.pet.onPomoRemaining((s) => {
  if (!s || !s.mode || s.mode === 'idle') {
    badge.classList.remove('show');
    return;
  }
  const m = Math.floor(s.remainSec / 60);
  const sec = s.remainSec % 60;
  badgeMode.textContent = (MODE_LABEL[s.mode] || '') + (s.paused ? ' · 暂停' : '');
  badgeTime.textContent = String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  badge.classList.toggle('paused', !!s.paused);
  badge.classList.add('show');
});

// 结束铃声：Web Audio 合成三音上行（清脆短音），无需任何音频文件
let audioCtx = null;
window.pet.onRing(() => {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime;
    [[880, 0], [1174.66, 0.18], [1567.98, 0.36]].forEach(([freq, dt]) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + dt);
      gain.gain.exponentialRampToValueAtTime(0.22, t0 + dt + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.9);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0 + dt);
      osc.stop(t0 + dt + 1.0);
    });
  } catch (e) {}
});

window.pet.onApplyZoom((z) => {
  document.documentElement.style.setProperty('--z', String(z));
});
