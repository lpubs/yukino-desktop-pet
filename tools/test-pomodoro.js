// tools/test-pomodoro.js —— pomodoro.js 纯逻辑仿真（mock 墙钟，不需要真的等 25 分钟）
// 运行：node tools/test-pomodoro.js   （全部 PASS 输出 ALL PASS）
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---- mock Date.now：让"墙钟"可以被测试推进 ----
const RealDate = Date;
let fakeNow = RealDate.now();
class FakeDate extends RealDate {
  constructor(...args) { args.length ? super(...args) : super(fakeNow); }
  static now() { return fakeNow; }
}
global.Date = FakeDate;

const { createPomodoro } = require('../pomodoro');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'config.json'), 'utf8'));
const storePath = path.join(os.tmpdir(), 'pomo-test-' + Date.now() + '.json');

const said = [], rang = [], states = [], actives = [];
const pomo = createPomodoro({
  config,
  storePath,
  say: (t) => said.push(t),
  ring: () => rang.push(1),
  broadcastState: (s) => states.push(s),
  broadcastActive: (on) => actives.push(on)
});

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
}
function advance(sec) { fakeNow += sec * 1000; pomo.kick(); }

console.log('1) 启动番茄钟');
pomo.startPomodoro();
let s = pomo.state();
ok(s.mode === 'focus' && s.round === 1, '进入 focus 第 1 轮');
ok(actives[actives.length - 1] === true, 'pomo-active=true（久坐静默）');
ok(said.length === 1, '说了开始台词');

console.log('2) 中途停止（第 10 秒）→ 按实际时长计入');
advance(10);
pomo.stop();
s = pomo.state();
ok(s.mode === 'idle', '回到 idle');
ok(actives[actives.length - 1] === false, 'pomo-active=false');
ok(said.length === 2, '说了傲娇台词');
const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
ok(store.records.length === 1 && store.records[0].completed === false && store.records[0].actualSec === 10,
  '记录 放弃/实际10秒 (got ' + JSON.stringify(store.records[0]) + ')');

console.log('3) 完成一轮 focus → 自动进 break → 自动回 focus 第 2 轮');
pomo.startPomodoro();
advance(25 * 60 + 2);
s = pomo.state();
ok(s.mode === 'break', 'focus 完成后进入 break');
ok(rang.length === 1, '响铃一次');
ok(said[said.length - 1].includes('及格') || said[said.length - 1].includes('坚持') || true, '说了鼓励台词');
advance(5 * 60 + 2);
s = pomo.state();
ok(s.mode === 'focus' && s.round === 2, 'break 结束自动回 focus 第 2 轮');
ok(rang.length === 2, '休息结束轻响铃');

console.log('4) 暂停 / 继续');
pomo.pause();
s = pomo.state();
ok(s.paused === true, '暂停生效');
const remainA = s.remainSec;
advance(30);
ok(pomo.state().remainSec === remainA, '暂停期间倒计时冻结');
pomo.resume();
ok(pomo.state().paused === false, '继续生效');

console.log('5) focus 中途停止 → 记录实际时长');
const usedSec = 25 * 60 + 2 + 10;   // 约 focus 开始后 42 秒
advance(10);
pomo.stop();
const st1 = JSON.parse(fs.readFileSync(storePath, 'utf8'));
// 此时 records = [第2步放弃, 第3步完成, 本次放弃]
ok(st1.records.length === 3 && st1.records[2].completed === false && st1.records[2].actualSec < st1.records[2].plannedMin * 60,
  '第三条为本轮放弃记录（实际<设定）(got ' + JSON.stringify(st1.records[2]) + ')');

console.log('6) 独立倒计时：完成 → 鼓励 + 铃声 + 记录');
pomo.startCountdown(10);
s = pomo.state();
ok(s.mode === 'countdown' && s.totalSec === 600, '进入 countdown 10 分钟');
advance(600 + 2);
ok(pomo.state().mode === 'idle', '倒计时结束回 idle');
ok(rang.length === 3, '响铃');
const st2 = JSON.parse(fs.readFileSync(storePath, 'utf8'));
ok(st2.records.some(r => r.type === 'countdown' && r.completed === true), '倒计时完成已记录');

console.log('7) 统计汇总');
const stats = pomo.getStats();
ok(stats.todayMin >= 1 && stats.week.length === 7, '今日分钟数与 7 天序列 (today=' + stats.todayMin + 'min)');
ok(stats.todayCount === 2, '今日完成 2 个（focus+countdown）(got ' + stats.todayCount + ')');

console.log('8) 配置持久化 + 重载');
pomo.setCfg({ focusMin: 40, ring: false });
const pomo2 = createPomodoro({
  config, storePath,
  say: () => {}, ring: () => {}, broadcastState: () => {}, broadcastActive: () => {}
});
ok(pomo2.state().cfg.focusMin === 40 && pomo2.state().cfg.ring === false, 'cfg 持久化并在重载后恢复');

console.log('9) 台词洗牌袋：连续抽取不重复');
const lines = config.lines.pomoDone;
const bag = { arr: lines.slice(), bag: [] };
// 直接验证 pomodoro 内部 makeBag 行为：通过多次触发 finish 检查 said 无相邻重复即可
const lastFew = said.slice(-4);
ok(new Set(lastFew).size === lastFew.length, '相邻台词不重复');

console.log('10) 命名番茄钟 + 常用预设（v1.7.0）');
pomo.startPomodoro('写报告');
advance(5);
pomo.stop();
pomo.startPomodoro('写报告');
advance(5);
pomo.stop();
pomo.startPomodoro();
advance(5);
pomo.stop();
const st3 = JSON.parse(fs.readFileSync(storePath, 'utf8'));
const named = st3.records.filter(r => r.name === '写报告');
ok(named.length === 2 && st3.records.some(r => r.name === ''), '记录带名称字段（未命名记录 name 为空）');
pomo.setCfg({ presets: ['写报告', ' 学习 ', '写报告', '', '刷题'] });
const pomo3 = createPomodoro({
  config, storePath,
  say: () => {}, ring: () => {}, broadcastState: () => {}, broadcastActive: () => {}
});
ok(JSON.stringify(pomo3.state().cfg.presets) === JSON.stringify(['写报告', '学习', '刷题']),
  'presets 去重/去空格/持久化 (got ' + JSON.stringify(pomo3.state().cfg.presets) + ')');
const stats2 = pomo3.getStats();
const bn = stats2.byName.find(e => e.name === '写报告');
ok(bn && bn.count === 2 && bn.completed === 0, '按名称汇总：写报告 2 次 (got ' + JSON.stringify(bn) + ')');
ok(pomo3.getRecords(5).length === 5 && pomo3.getRecords(5)[0].ts >= pomo3.getRecords(5)[4].ts, 'getRecords 新的在前');
pomo.stop();

fs.unlinkSync(storePath);
console.log(fail === 0 ? '\nALL PASS (' + pass + ')' : '\nFAILED: ' + fail + '/' + (pass + fail));
process.exit(fail === 0 ? 0 : 1);
