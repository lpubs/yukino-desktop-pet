// 雪乃桌宠 · 渲染层状态机与行为引擎
//
// 分层：
//   素材层  基准立绘 1 张 + 差分图层若干（v3.9 起；眨眼/口型/表情走图层）
//   动作层  CSS animation，以脚底为轴做形变
//   状态层  idle / walk / drag / throw / pomodoro 五态，互斥
//
// 一条原则：所有跟窗口位置的交互都走主进程 moveTo，渲染层不假设自己知道坐标。

const $ = (s) => document.querySelector(s);

// 窗口尺寸必须与 main.js 的 BASE_W / BASE_H 一致（100% 档）。
// 但**不要**拿它们去算位置：用户可以缩放到 72% / 128%，实际尺寸只有主进程知道。
// 所有落点计算一律用 getWorkArea() / getBounds() 返回的实时值，
// 下面这两个常量只作为"主进程还没回答"时的兜底。
// ★ WIN_H 是**窗口**高：它比角色显示高度多一条 TOP_PAD（顶部留给气泡的那条）。
//   凡是要算"角色占多宽"的地方都得用 petDisplayH()，用 WIN_H 会把角色算宽。
const WIN_W = 404;
const WIN_H = 489;
// ⚠ 名字**故意**带 PET_ 前缀，不要"顺手统一"成 TOP_PAD_RATIO：
//   pet.js 是普通脚本（非 module），顶层 const 落在**全局作用域**，
//   而 preview.html 的内联脚本里已经声明了一个 TOP_PAD_RATIO ——
//   同名会抛 SyntaxError（Identifier 'X' has already been declared），
//   而它发生在解析阶段，整个 pet.js 一行都不执行、页面静默变空。
const PET_TOP_PAD_RATIO = 0.22;   // 与 main.js 的 TOP_PAD_RATIO、pet.css 的 #petArea 同值
// 地面基准：角色脚底恰好停在「工作区底边」（= 任务栏上沿），
// 所以落点 y = 工作区高 - 窗口高 + sink。公式必须与 main.js 的 groundYOf()
// 完全一致，否则拖拽松手后角色会停在和"初始位置/换装后位置"不同的高度上。
const groundY = (area) => (area.y || 0) + area.height - (area.petH || WIN_H) + (area.sink || 0);

const wrap = $('#petWrap');
const petArea = $('#petArea');
const lookWrap = $('#lookWrap');
const spriteWrap = $('#spriteWrap');
const fBase = $('#fBase');
const fEye = $('#fEye'), fMouth = $('#fMouth');
// 走动时的下装两帧。可见性由 CSS 按步周期写（见 pet.css 的 .frame.hem），
// 渲染层只负责把 src 挂上去 —— 所以它们没有 applyXxxLayer()。
const fHemA = $('#fHemA'), fHemB = $('#fHemB');
const bubble = $('#bubble'), bubbleText = $('#bubbleText');
const badge = $('#badge'), badgeName = $('#badgeName'), badgeTime = $('#badgeTime');
const panel = $('#panel'), pomForm = $('#pomForm'), pomRun = $('#pomRun');
const pomInput = $('#pomInput'), pomNameEl = $('#pomName'), pomTimeEl = $('#pomTime');

const rand = (a) => a[Math.floor(Math.random() * a.length)];
// 抽一条台词，避免**连着两次抽到同一条**。
//
// ⚠ 这里比的是**文本**，不是下标。原来存的是下标（pick._last），而它是一个全局量：
//   · 跨数组调用时，"避开上一个下标"避的是**另一个数组**的同号元素，等于没避；
//   · 更要命的是 idleLines() 每次调用都**新建一个数组**，下标在两次调用之间
//     根本不可比 —— 也就是她最常说的那批待机台词，防重一直是失效的
//     （这正是"她怎么老是这一句"的来源）。
// 比文本就没有这两个问题：同一个字符串连着出现两次才是玩家感知得到的重复。
// 最多试 8 次，全撞上就认了 —— 数组里全是同一条时才可能发生，不能为此死循环。
function pick(arr) {
  if (!arr || !arr.length) return '';
  if (arr.length === 1) return arr[0];
  for (let n = 0; n < 8; n++) {
    const v = arr[Math.floor(Math.random() * arr.length)];
    if (v !== pick._last) { pick._last = v; return v; }
  }
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---------- 素材 ----------
// 两段结构：
//   dir     基准立绘 `dir.png`
//   layers  差分图层 `dir/<槽位>.png`（可选）
//
// 「可选」是刻意的，而且 v3.11 之后**四套的层数并不相同**：
//   · coat 没有 mouth（嘴被围巾完全遮住）；
//   · sailor / maid / coat 没有 walk（胸像，看不到下装，或下装只占立绘高的 8.75%）；
//   · 只有 winter 三层齐全（它是唯一的全身像）。
// 没做的那几套必须**照常跑**、只是不眨眼/不说话动嘴/走路不做迈步动作 ——
// 而不是报错、或者露出一块空白。降级路径由 selftest 第 25 节逐条断言。
//
// 槽位名一旦定下就别改：它同时出现在这里、tools/gen_layers.py 的改动名、
// 以及 assets/sprites/<套装>/manifest.json 里，selftest 会把三处比一遍。
const OUTFITS = {
  maid: {
    name: '女仆装',
    dir: '../assets/sprites/maid',
    layers: {
      eye: { half: 'eye_half', closed: 'eye_closed', wink: 'eye_wink', happy: 'eye_happy' },
      mouth: { smile: 'mouth_smile', open: 'mouth_open' }
    }
  },
  sailor: {
    name: '水手服+贝雷帽',
    dir: '../assets/sprites/sailor',
    // v3.11 三套补齐。**没有 walk**：这套是胸像到裙摆，裙摆只占立绘高的 8.75%，
    // 在桌面显示尺寸下摆动看不见（量过，见 tools/featmask.py 的 `_hem` 段）。
    // 加一层看不见的素材不是"没效果"，是多一处接缝 + 一份要维护的清单。
    layers: {
      eye: { half: 'eye_half', closed: 'eye_closed', wink: 'eye_wink', happy: 'eye_happy' },
      mouth: { smile: 'mouth_smile', open: 'mouth_open' }
    }
  },
  coat: {
    name: '冬大衣+围巾',
    dir: '../assets/sprites/coat',
    // **没有 mouth**：嘴被围巾完全遮住，生成一层永远看不见的嘴帧没有意义。
    // **没有 walk**：胸像，底下是黑大衣下摆＋长发。
    layers: {
      eye: { half: 'eye_half', closed: 'eye_closed', wink: 'eye_wink', happy: 'eye_happy' }
    }
  },
  winter: {
    name: '冬装（全身）',
    dir: '../assets/sprites/winter',
    // ★ 四套里**唯一**有 walk 的：只有它是全身像，看得到裙摆、大腿和袜子
    //   （下半身占立绘高的 25%）。走动两帧按步周期硬切，见 pet.css 的 .frame.hem。
    layers: {
      eye: { half: 'eye_half', closed: 'eye_closed', wink: 'eye_wink', happy: 'eye_happy' },
      mouth: { smile: 'mouth_smile', open: 'mouth_open' },
      walk: { a: 'walk_a', b: 'walk_b' }
    }
  }
};
const LAYER_KINDS = ['eye', 'mouth', 'walk'];
const frames = {};   // key -> { base: Image, eye: {槽位: Image}, mouth: {...}, walk: {a,b: Image} }

function loadFrames(key) {
  if (frames[key]) return frames[key];
  const o = OUTFITS[key];
  if (!o) return null;
  const f = { base: new Image(), eye: {}, mouth: {}, walk: {} };
  f.base.src = o.dir + '.png';
  // 图层的加载态要能反过来通知显示层：图层是**异步**到的，而眨眼可能 2 秒后就发生。
  // 不做这件事的话，"启动后第一次眨眼没反应，之后才有"——
  // 一个只在冷启动出现、热重载永远复现不了的 bug。
  const onload = () => {
    applyEyeLayer();
    applyMouthLayer();
    if (layersReady()) layerReadyCbs.splice(0).forEach((cb) => cb());
  };
  LAYER_KINDS.forEach((kind) => {
    const tab = (o.layers && o.layers[kind]) || {};
    Object.keys(tab).forEach((slot) => {
      // walk 层是**例外**：它的可见性由 CSS 动画写（按步周期硬切），
      // 不走 `.on` 那套开关，所以直接拿 DOM 里那两个 <img> 当载体 ——
      // 再建一份 Image 就只是为了它不显示，白解码一遍。
      // 登记进 f.walk 是必须的：layersReady() 靠它判"这一层解码完了没"。
      const im = kind === 'walk' ? { a: fHemA, b: fHemB }[slot] : new Image();
      if (!im) return;
      im.onload = onload;
      im.src = o.dir + '/' + tab[slot] + '.png';
      f[kind][slot] = im;
    });
  });
  frames[key] = f;
  return f;
}

const state = { outfit: 'maid', mode: 'idle' };
// 缩放档的本地镜像。真值在主进程（settings.json），这里只用来算"下一档是哪一档"。
// ⚠ 顺序必须与 main.js 的 SIZES / SCALE_LABELS 的键顺序**逐字一致** ——
// 滚轮是按"当前档的下标 ±1"算下一档的，顺序不一致会跳档（selftest 比对这三处）。
// v3.6 三档 → 五档，既有的三个键一个都没动，只在两头加了 tiny / huge。
const SIZE_ORDER = ['tiny', 'small', 'medium', 'large', 'huge'];
let curScaleKey = 'medium';

// ---------- 羁绊 / 勿扰 / 音效的本地镜像 ----------
// 真值全在主进程（affinity.json / settings.json）。这里只是缓存，免得每响一次
// 音效、每看一眼状态都要发一次 IPC。**等级绝不在这里重算** —— 主进程返回什么就是什么。
let bondLevel = 1;
let lastBond = { level: 1, points: 0, nextAt: null };
let quiet = false;          // 勿扰中（窗口已被主进程藏起来）
let sfxEnabled = true;
let chatter = 'normal';     // 打扰等级：quiet / normal / lively（见下面的说明）
let userActive = true;      // 你此刻坐在电脑前吗（由主进程的系统空闲检测驱动）

// ---------- 打扰等级（话痨程度）----------
// 三档，管的是**她主动开口**的频率，不是"她在不在"：
//   quiet   只在你主动找她时开口。生活流的自言自语、主动靠近、打字搭话全停；
//           她照样会动、会看书、会看窗外 —— 关掉的是"她在说话"，不是"她还在"。
//   normal  默认，与 v3.7 的手感完全一致（这一档一个数都没改）。
//   lively  更爱冒泡：链与链之间的静默缩短、主动靠近更频繁。
//
// 为什么需要它：她有十几个会开口的时机（生活流、主动靠近、打字搭话……），
// 但此前**没有总闸** —— 想让她"在但不说话"只能整个勿扰，而那是让她消失。
// 这两件事本来就不是一回事。
//
// ★ 拦截点选在 quote() 这个**唯一出口**上，而不是"给每处台词标一个频道"：
//   台词散在十几处调用点，逐个标注迟早漏一个，而漏掉的那处会**静默**地不受控
//   （你开了安静，她还在某条路径上叨叨）。现在只有一个开关要维护：
//   "她此刻是不是在做自己的事"。
const talkOK = () => chatter !== 'quiet';
// >0 表示"她正在做自己的事"（生活流那一拍）。安静档下这期间的台词被吞掉，
// 但动作、表情、粒子照常 —— 她还在过日子，只是不出声。
let idleMute = 0;

// ---------- 音效 ----------
// v3.4 起这 13 个音**不再是自己算的合成音**，而是从 Kenney 的 CC0 公共领域素材
// （Interface / Impact Sounds）转换来的真录音，由 tools/prepare_sfx.py 统一
// 降单声道、重采样 44.1kHz、掐静音、归一化、加淡入淡出。
//   · 为什么换：合成音被判定"太粗糙" —— 缺的是谐波结构、瞬态、空间感，
//     那是录音素材才有的东西，加谐波数量堆不出来。详见 tools/abandoned/make_sfx.py。
//   · 授权为什么仍然干净：CC0 可商用、可改、**免署名**；来源逐条记在
//     assets/sfx/CREDITS.md 与 sources.json 里。这跟 sprites/ 那四张立绘不同 ——
//     立绘有版权、仅限个人非商业，音效是公共领域。
// 名字与 assets/sfx/*.wav、sources.json 必须一一对应（selftest 的 [11c] 会三方比对）。
//
// 为什么用 <audio> 而不是 Web Audio / fetch：**file:// 页面里 fetch 会被 CORS 挡掉**，
// 而 media 元素加载同目录的 file:// 是允许的。这条踩过，别再改回去。
const SFX_SRC = {
  click: 'click', pat: 'pat', levelup: 'levelup',
  pomdone: 'pomdone', quiet: 'quiet', back: 'back',
  // v3.4 新增：新交互要用的音
  type: 'type',           // 打字轻响（12ms，会随机微调音高）
  land: 'land',           // 落地闷响
  bounce: 'bounce',       // 投掷撞到屏幕边缘
  angry: 'angry',         // 情绪转坏
  question: 'question',   // 疑惑（部位识别的歧义反应）
  select: 'select',       // 换装
  toggle: 'toggle'        // 缩放 / 开关（复选框）
};
const sfxCache = {};
function sfx(name, opts) {
  if (!sfxEnabled || !SFX_SRC[name]) return;
  try {
    let a = sfxCache[name];
    if (!a) {
      a = new Audio('../assets/sfx/' + SFX_SRC[name] + '.wav');
      // 素材本身已经峰值归一化到约 -15dBFS，这里再留一点余量：桌宠是长时间挂着的，
      // 提示音要"能被忽略"。真嫌吵就去右键菜单把音效关掉。
      a.volume = 0.5;
      sfxCache[name] = a;
    }
    // 打字音随机微调音高（±8%）。同一条 12ms 采样在你连续敲键时一秒要响好几次，
    // 音高不动的话立刻变成"复读机"；拉开一点就变成"节奏"。
    // 这是游戏音频里让单个素材听起来不腻的标准做法，代价为零。
    const rate = (opts && opts.rate) ||
      (name === 'type' ? 0.94 + Math.random() * 0.16 : 1);
    if (a.playbackRate !== rate) a.playbackRate = rate;
    a.currentTime = 0;              // 连点的时候从头放，不要排队等上一声放完
    const pr = a.play();
    if (pr && pr.catch) pr.catch(() => {});   // 设备缺失/自动播放策略 —— 静默
  } catch (e) { /* 放不出声绝不能中断交互 */ }
}
// 菜单里刚把音效打开时，主进程会发一个名字过来试听
window.pet.onSfx((name) => { sfxEnabled = true; sfx(name || 'click'); });

// ---------- 羁绊埋点 ----------
// 埋点一律是"报一句我做了什么"，分值与冷却那张表只在主进程里有一份 ——
// 渲染层复制一份迟早会漂。返回值里带着本次加了多少、有没有升级。
//   gain > 0 -> 给一声轻音效（有反馈）
//   gain = 0 -> **什么都不做**（冷却中）。给了反馈却不涨分，玩家会以为坏了。
//   leveledUp -> 走升级演出
function gain(action) {
  if (!window.pet.addBond) return;
  window.pet.addBond(action).then((r) => {
    if (!r) return;
    lastBond = r;
    bondLevel = r.level;
    if (r.leveledUp) levelUpShow(r);
    else if (r.gain > 0) sfx('click');
  }).catch(() => { /* 记不上分不该影响交互 */ });
}

let levelShowTimer = null;
function levelUpShow(r) {
  clearTimeout(levelShowTimer);
  // 每级一条专属台词（见 dialogue.js）。等级是唯一依据，所以重装/清档也不会错位。
  const line = pick(QUOTES.levelUp[r.level] || QUOTES.levelUp[6]);
  say(line, 4200);
  levelShowTimer = setTimeout(() => { levelShowTimer = null; }, 4300);
  particles(['💗', '✨', '🎀'], 6);
  blush();
  emote('💞');
  sfx('levelup');
}

// 已达到的等级所解锁的台词，会并进平时的自言自语池 ——
// 这就是"养成"的全部可见内容：她的自言自语慢慢变得不设防。
function idleLines() {
  const extra = [];
  for (const k of Object.keys(QUOTES.bond)) {
    if (Number(k) <= bondLevel) extra.push.apply(extra, QUOTES.bond[k]);
  }
  return QUOTES.idle.concat(extra);
}

// ---------- 情绪值（她此刻的脸色）----------
// 和羁绊一样**刻意不做数值面板** —— 看得见的只有"她这一面"。
// 差别在于时间尺度：羁绊是几个月的关系，情绪是这几分钟的心情。
// 所以情绪**不落盘**：重启就该回到中性，不需要"昨天她还生着气"这种连续性。
//
// 它只影响三件事：① 她的台词倾向 ② 还愿不愿意被摸头 ③ 会不会主动靠近你。
// 连续戳她（尤其是裙摆）会把她推到 annoyed / angry，摸头会拉回来，
// 放着不管会自己慢慢回落到中性。
const MOOD_NEUTRAL = 50;
let mood = MOOD_NEUTRAL;
const moodBandOf = (v) => (v >= 70 ? 'happy' : v <= 15 ? 'angry' : v <= 35 ? 'annoyed' : 'calm');
let moodBand = moodBandOf(mood);

function onMoodBand(band) {
  // 跨档才说话。每一点变化都吭声的话，她会变成一个很吵的东西。
  if (band === 'angry') {
    anim('huff', 700);
    emote('💢');
    sfx('angry');
    quote(QUOTES.mood.angry, 2600);
  } else if (band === 'annoyed') {
    emote('…');
    sfx('question');
    quote(QUOTES.mood.annoyed, 2400);
  } else if (band === 'happy') {
    blush();
    emote('💗');
    quote(QUOTES.mood.happy, 2800);
  }
}

function moodShift(d) {
  const before = moodBand;
  mood = Math.max(0, Math.min(100, mood + d));
  const after = moodBandOf(mood);
  if (after !== before) { moodBand = after; onMoodBand(after); }
  return mood;
}
// 生气时她不接受摸头。这不是"惩罚玩家"，是让情绪这件事真的有后果 ——
// 否则情绪就只是一组没人看的数字。
const canPamper = () => moodBand !== 'angry';

// 自然回落：每 8 秒朝中性走 1 点。约 3 分钟从满值回到中性 ——
// 生气了晾一会儿就好，但不会"转个身就忘"。
setInterval(() => {
  if (quiet || state.mode !== 'idle') return;
  if (mood > MOOD_NEUTRAL) moodShift(-1);
  else if (mood < MOOD_NEUTRAL) moodShift(1);
}, 8000);

// ---------- 健康提醒：抬头说一句就走 ----------
// 到点与否由**主进程**判（它管计时 —— 托盘悬停要能显示"下次什么时候提醒"，
// 而渲染层被冻住时不工作，那时托盘照样该说得准）。这里只负责"怎么演"。
//
// 形态是刻意选的：不弹系统通知、不抢焦点、不动窗口位置。
// 她停下手上的事、抬头说一句、放个表情，然后回去做自己的事。
// 同类工具里被认可的就是这种非侵入式做法 —— 提醒本身不该变成新的负担。
//
// ★ 它**不受打扰等级影响**。安静档压的是"她主动闲聊"，而健康提醒是你在菜单里
//   显式要的一项服务 —— 开了安静就把自己设的提醒也吞掉，那是功能失灵，不是安静。
//   真嫌吵的正解是把对应那一项关掉（托盘 / 右键菜单里都能单独关）。
//
// 四种情况**直接放弃**这一拍（不是排队延后）：
//   · 勿扰中 —— 她"出去了"，隔着隐藏窗口说给谁听
//   · 正在被拖动 / 正在飞 / 正在走动 —— 那时她没法"抬头说一句"
//   · 30 秒内刚开过口 —— 两句台词叠在一起就是吵
// 放弃而不是排队：健康提醒过期就没意义了（"该起来动动"晚五分钟还行，
// 但攒三条一起说就成了骚扰）。主进程那边也不补发，两边口径一致。
window.pet.onHealth((k) => remindHealth(k));
let lastHealthNote = 0;

// 抽成具名函数是为了 preview.html 能直接调它 —— 验收必须走**同一段**逻辑，
// 另写一段演示等于没验。真机里它只被上面那条 IPC 回调调用。
function remindHealth(k) {
  if (quiet) return;
  if (dragging || throwing || state.mode === 'walk') return;
  if (Date.now() - lastHealthNote < 30000) return;
  const lines = QUOTES.health[k];
  if (!lines) return;
  lastHealthNote = Date.now();
  // 她睡着就**静默唤醒**：提醒的目的是让你起身，她必须干脆。
  // 走 wakeUp() 那三拍会变成"先迷糊两秒、再打个哈欠、然后才说该起来动动"——
  // 时效性直接没了；何况那三拍本来就是"你回来了"的戏，用在这里不对位。
  if (sleeping || waking) {
    sleeping = false; waking = false; clearWakeTimers();
    setPose('breathe');
    eyeForced = null; applyEyeLayer();   // 静默唤醒同样要放开眼睛，否则她会一直"闭着眼"坐着
  }
  interruptChain();                      // 停下手上的事
  lastInteract = Date.now();
  quote(lines);
  emote({ sit: '🙆', water: '💧', eye: '👀' }[k] || '💡');
  sfx('question');
}

// ---------- 勿扰（安静一会儿）----------
// 藏窗口是主进程的活。渲染层做两件主进程做不到的事：
//   ① **把定时器冻住** —— 窗口藏起来以后，待机动作池还会按 12~26s 的节奏醒来，
//      对着一个看不见的窗口说台词、放粒子；睡着的判定也一样。进勿扰时冻结，回来时解冻。
//   ② **把她整个冻住（CSS 动画 + 心跳）** —— 见下面 setFrozen 的说明。
//
// QUIET_BYE_MS 与主进程的 QUIET_HIDE_DELAY 是**配对**的：告别台词必须先说完，
// 窗口才能藏起来。selftest 会把两个数读出来比大小，防止只改一边。
const QUIET_BYE_MS = 1400;

// 冻结：把整个页面停下来（CSS 动画暂停 + 心跳停跳）。
//
// 为什么必须显式做，而不能指望 `document.hidden`：
//   Electron 的 backgroundThrottling: false（这个窗口在用，理由是"被别的窗口遮挡时
//   她不能卡住"）文档里明确写着 **"This also affects the Page Visibility API"**。
//   也就是说：主进程 hide() 之后，`document.hidden` 依然是 false。
//   实测（v3.7，真机 Electron 33）藏起来之后 rAF 仍以 ~180 帧/秒在跑、
//   breathe 这个 infinite 动画照转 —— 「到明天早上 8 点」这一档会整夜
//   朝一个没人看的窗口出帧，白烧约 2.5% CPU（对照：从没显示过窗口 = 0.07%）。
//   顺带一提，那个 heartbeat 的 `document.hidden` 闸门因此**从来没生效过**，
//   所以它现在也一并挂在 quiet 上。
//
// 为什么要延迟 QUIET_BYE_MS 才冻：进勿扰后窗口还会多留 1.5s 让她把告别说完。
// 那一刻立刻冻住动画，看起来就是"气泡淡入到一半卡住、人也不动了"。
// 冻的时机跟着"说完了吗"走，与主进程 QUIET_HIDE_DELAY 是同一个节拍。
function setFrozen(on) {
  document.documentElement.classList.toggle('pet-frozen', !!on);
  syncHeartbeat();                       // 心跳跟着一起停/起（它只该在"她真的在"时跳）
}
let freezeTimer = null;
function freezeAfterBye() {
  if (freezeTimer) { clearTimeout(freezeTimer); freezeTimer = null; }
  freezeTimer = setTimeout(() => {
    freezeTimer = null;
    if (quiet) setFrozen(true);          // 这 1.4s 内被叫回来过？那就不冻
  }, QUIET_BYE_MS);
}
window.pet.onQuiet((payload) => {
  // ⚠ v3.12 起 payload 是**对象** { active, until, bye }（主进程只发这一种形态）。
  //   为了兼容老写法（数字 = until）这里两种都吃，但别在别处再写数字了。
  const o = (payload && typeof payload === 'object')
    ? payload
    : { active: !!payload, bye: !!payload };
  const wasQuiet = quiet;
  quiet = !!o.active;
  if (quiet === wasQuiet) return;
  if (quiet) {
    // ★ bye = false 是**全屏自动躲起来**（v3.12）：她静默消失，不说那句告别。
    //   看全屏视频时突然冒出一句"我出去了"，比直接消失更烦人 —— 这是刻意的。
    if (o.bye) {
      say(pick(QUOTES.quiet), QUIET_BYE_MS);
      sfx('quiet');
      stopTalk();                        // 告别那句说完就别再动嘴了
      freezeAfterBye();                  // 说完再冻（进勿扰后窗口还会多留 1.5s）
    } else {
      setFrozen(true);                   // 自动档：没有告别要说，立刻冻
    }
  } else {
    if (freezeTimer) { clearTimeout(freezeTimer); freezeTimer = null; }
    setFrozen(false);
    lastInteract = Date.now();
    quote(QUOTES.back);
    sfx('back');
  }
});

function paint() { fBase.classList.add('on'); }

// ---------- 差分图层：眨眼 / 口型 / 表情 ----------
//
// 为什么这次能做（README 第二节说眨眼已**删除**）：那条结论针对的是两条路 ——
// 程序合成眼睑、扩散模型全图重绘 —— 它们都同时做不到「画得像」和「帧间不漂」。
// 这里换了个分法，把两件事拆给两个执行者：
//
//     内容 交给模型画      → 睫毛线的锥度是**画**出来的，不是算出来的
//     对齐 交给确定性算法  → 图层之外，基准立绘逐字节不变
//
// 于是「不漂」不再依赖模型的服从度，而是数据结构自带的性质：
// 拿不到某个槽位（这套没做差分 / 图还没加载完）就退回去用基准立绘的眼睛，
// 而不是留一块空白。素材怎么来的见 tools/gen_layers.py 与 mklayer.py。
//
// 三条图层共用一个通道，优先级从高到低：
//     ① eyeForced  睡着 / 刚醒，由状态机强制
//     ② eyeHold    表情（眨眼调皮 / 笑眼），限时
//     ③ eyeWant    自动眨眼
// 不设优先级的话会发生的事很具体：她"笑到一半被一次眨眼顶掉"，
// 看起来像笑错了。互斥只需要一个比较，比事后去各处补 if 可靠。
let eyeWant = null;      // 期望槽位；null = 基准立绘自带的睁眼
let eyeForced = null;    // 强制槽位（睡着 closed / 刚醒 half）
let eyeHold = 0;         // 表情槽位的保持截止时刻
let mouthWant = null;
let blinkTimer = null, talkTimer = null;
let autoBlink = true;    // 只在无头验收里关掉，见 freezeBlink()
// 图层解码完成时的通知队列。带外给验收入口用，见 onLayersReady()。
const layerReadyCbs = [];

function layerImg(kind, slot) {
  const f = frames[state.outfit];
  const im = slot && f && f[kind] ? f[kind][slot] : null;
  // naturalWidth 为 0 = 还没解码完（或文件根本不在）。
  // 必须查它、不能只看 `im` 存在：直接挂一个尚未加载的 src，
  // 那一帧会闪一下空白 —— 在 60ms 的过渡里这一下是看得见的。
  return im && im.naturalWidth ? im : null;
}

function applyLayer(el, kind, slot) {
  const im = layerImg(kind, slot);
  if (!im) { el.classList.remove('on'); return null; }
  if (el.src !== im.src) el.src = im.src;
  el.classList.add('on');
  return slot;
}

function applyEyeLayer() {
  // 优先级：强制 > 期望。拿不到这一层就退回基准立绘自带的睁眼。
  if (applyLayer(fEye, 'eye', eyeForced || eyeWant) === null) eyeWant = null;
}
function applyMouthLayer() { applyLayer(fMouth, 'mouth', mouthWant); }

// 当前套装声明了哪些槽位。无头验收要用它来判断"没反应"是该套根本没做差分，
// 还是接线断了 —— 这两种情况在截图上长得一模一样。
function layerSlots(kind) {
  const o = OUTFITS[state.outfit];
  return Object.keys((o && o.layers && o.layers[kind]) || {});
}

function showEye(slot) { eyeWant = slot; applyEyeLayer(); }
function showMouth(slot) { mouthWant = slot; applyMouthLayer(); }

// ---------- 给无头验收的三个出口 ----------
// 它们不参与真机行为，但**必须放在渲染层里**而不是预演页里：
// 判据只有一份（layersReady 用的是这里真实的解码状态），
// 复刻一份到预演页就等于在验一个等效实现 —— 真机可能压根没接上。

// 素材是否全部解码就绪。
// 为什么需要：截图跑的是 `--virtual-time-budget`，虚拟时钟推进得比真实 IO 快得多。
// 用固定 delay 的动作演示，到点时图层 PNG 常常还没解码完，而 layerImg() 是按
// naturalWidth 判空的 —— 于是"演示跑了、图层没叠上"，截出来和"接线断了"长得一样。
function layersReady() {
  const f = frames[state.outfit];
  if (!f || !f.base.complete || !f.base.naturalWidth) return false;
  return LAYER_KINDS.every((k) => Object.keys(f[k] || {})
    .every((s) => f[k][s].complete && f[k][s].naturalWidth > 0));
}

// 就绪时回调一次。**事件驱动**，不是轮询：
// 轮询要靠定时器，而定时器走的正是那条被拉快的虚拟时间轴 —— 会把 8 秒预算
// 在几十毫秒真实时间里烧完，然后在图还没解码时放弃。
function onLayersReady(cb) {
  if (layersReady()) cb();
  else layerReadyCbs.push(cb);
}

// 关掉自动眨眼。只给无头验收用：眨眼间隔是随机的（3~7s），
// 而验收要"把某一档表情钉住看接缝"。一次自动眨眼就能把"基准"那一格
// 拍成半睁 —— 而半睁和基准的差别，正好是这组图要判的东西。
// 调过之后不会自愈（要重新加载页面），真机不调。
function freezeBlink() { autoBlink = false; clearTimeout(blinkTimer); blinkTimer = null; }

// 一次眨眼：开 → 半 → 闭 → 半 → 开。
// 为什么不是直接"开→闭→开"：在 400 CSS px 的显示高度上，只切一档看着就是
// 眼睛被替换了一下（跳帧）。半睁帧把 120ms 撑成一段看起来像"合拢"的过程。
//
// ★ 序列按**当前套装实际有的槽位**拼，不是写死三档再靠 if 兜底。
//   素材是分套装做的，将来做第二套时很可能只做闭眼 —— 那时候"没有半睁帧"
//   必须表现为"两拍眨眼"，而不是"眨一下中间闪一下空白"。
//   半睁帧怎么来的见 tools/gen_layers.py 的 --denoise：模型只肯在睁/闭两端跳，
//   中间态是靠**部分去噪**让源图的信息留一部分活下来得到的。
// "这套有没有这个槽位"看的是**套装声明**（OUTFITS.layers），不是图层的加载态。
// 之前这里写的是 layerImg('eye','half')，那是个只在冷启动出现的 bug：
// 素材还在解码的那一两秒里，"四拍眨眼"会被降级成"两拍"、说话干脆不动嘴。
// 而热重载（图已缓存）永远复现不了 —— 正好是最难查的那一类。
function hasSlot(kind, slot) {
  const o = OUTFITS[state.outfit];
  return !!(o && o.layers && o.layers[kind] && o.layers[kind][slot]);
}

function blinkSeq() {
  return hasSlot('eye', 'half')
    ? [['half', 40], ['closed', 55], ['half', 45], [null, 0]]
    : [['closed', 85], [null, 0]];
}

function blinkBlocked() {
  // eyeForced 已经覆盖了"睡着/刚醒"，不必再查 sleeping（那样这两个状态就各写了一遍）
  return !!eyeForced || quiet || document.hidden || Date.now() < eyeHold;
}

function blinkOnce() {
  if (blinkBlocked()) return false;
  // 每一拍都在**触发时**再查一次闸门，而不是排程时就决定 ——
  // 排程到执行之间隔着几十毫秒，她完全可能在这期间睡着或被拖起来。
  let t = 0;
  blinkSeq().forEach(([slot, wait]) => {
    setTimeout(() => { if (!blinkBlocked()) showEye(slot); }, t);
    t += wait;
  });
  // 约两成的眨眼是连着的两下，固定单次会像节拍器
  if (Math.random() < 0.2) setTimeout(blinkOnce, 240);
  return true;
}

function scheduleBlink() {
  clearTimeout(blinkTimer);
  // 3~7s。真人静息眨眼 15~20 次/分钟（3~4s 一次），但桌宠是**被看着**的，
  // 按真人频率会显得一直很忙；拉长一点更像"她在发呆"。
  // 勿扰/睡着时这个定时器照跑但什么都不做 —— 一个几秒一次的判空，
  // 与 v3.7 那个"整夜 180fps 出帧"不是一回事，不值得再引一层冻结机制。
  blinkTimer = setTimeout(() => {
    if (autoBlink && state.mode === 'idle') blinkOnce();
    scheduleBlink();
  }, 3000 + Math.random() * 4000);
}

// 说话时的口型。节拍 110ms（≈9Hz）：打字机是 26ms 一个字，口型直接跟着它切
// 就是 38Hz 的抖动，比不动还难看；人说话的口型开合本来就在 5~9Hz。
// "不是每一拍都张"（也有一拍闭嘴）是让它在有节奏的同时不呆板。
const TALK_TICK = 110;

function stopTalk() {
  if (talkTimer) { clearInterval(talkTimer); talkTimer = null; }
  showMouth(null);
}

function talkFor(ms) {
  stopTalk();
  // 同上：判据是套装**声明**有没有嘴型槽位，不是图有没有解码完。
  // 用加载态判的话，"开机第一句话"恰好落在素材解码窗口里就没口型了。
  if (!hasSlot('mouth', 'open') && !hasSlot('mouth', 'smile')) return;
  const until = Date.now() + Math.max(120, ms);
  talkTimer = setInterval(() => {
    if (Date.now() >= until || quiet) { stopTalk(); return; }
    const r = Math.random();
    showMouth(r < 0.45 ? 'open' : (r < 0.8 ? 'smile' : null));
  }, TALK_TICK);
}

// 表情通道。返回 false = 这套没有该槽位（调用方可以据此跳过别的配套反馈）。
function expression(slot, ms) {
  if (!layerImg('eye', slot)) return false;
  const hold = ms || 900;
  eyeHold = Date.now() + hold;
  showEye(slot);
  setTimeout(() => { if (Date.now() >= eyeHold - 5) showEye(null); }, hold + 30);
  return true;
}

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
    applyEyeLayer(); applyMouthLayer();
    return;
  }
  stopTalk();                            // 换装时嘴留在半张的状态会很怪
  fBase.classList.remove('on');
  swapTimer = setTimeout(() => {
    fBase.src = loadFrames(key).base.src;
    paint();
    // 图层要跟着换 src：同一套是 `maid/eye_closed.png`，
    // 换到没做差分的那三套时会拿不到，于是自动退回睁眼 —— 降级在这里发生，只此一处。
    applyEyeLayer(); applyMouthLayer();
  }, 150);
}
window.pet.onOutfit((k) => {
  applyOutfit(k);
  say(pick(QUOTES.outfit[k] || QUOTES.idle), 3600);
  emote('✨');
  gain('outfit');
});

// 缩放（右键菜单 / 滚轮）。窗口由主进程按"底边 + 水平中心"重排，
// 渲染层需要做两件事：记下新档位，以及**重新上报可交互区**。
window.pet.onScale((k) => {
  curScaleKey = k;
  emote(k === 'tiny' || k === 'small' ? '🔍' : k === 'large' || k === 'huge' ? '🔎' : '👌');
  // ★ 缩放后必须重报可交互区。这一条原来是**漏的**（v3.5 遗留）。
  //
  // 真机上勉强不会出事：主进程 setSize 会触发渲染层的 window resize，
  // 而下面挂了 `window.addEventListener('resize', reportHitArea)` —— 兜住了。
  // 但预览页里缩放是改 #stage 的尺寸，**不触发 window resize**，
  // 于是 hitBox 一直停在缩放前的值：从大档切到极小档，读到的是
  // `sprite 226x232` 配 `hit 428`（那是 medium 档的 389+余量），
  // 可交互框比窗口宽 183% —— 而真机上看不出任何异常。
  // 也就是说：**这一条错的不是产品，是验收**。而验收不可信 = 整套判断都不成立，
  // 所以按"替身必须和真机语义一致"的规矩，这里显式补上（真机上它还更及时，
  // 同步生效，不用等 resize 那一帧）。
  // 同步读 getBoundingClientRect 会强制一次布局，所以拿到的已经是新尺寸。
  reportHitArea();
  window.pet.getBounds().then((b) => { if (b) window.pet.savePos(b.x, b.y); });
});

// ---------- 点击穿透：上报"我哪里可交互" ----------
// 完整动机见 main.js 的"透明区点击穿透（v3.5）"一节。这里只做渲染层那一半：
// 把**角色和番茄钟面板实际占的那块矩形**报给主进程，主进程拿光标去撞它，
// 撞不到就把整窗切成穿透态 —— 她周围那圈空气因此不再挡住桌面。
//
// 为什么不用 #fBase.getBoundingClientRect()（那个更"直接"）：
// 它返回的是**变换后**的框，而 #petWrap 上挂着呼吸 / 跳跃 / 坐下 / 投掷翻滚。
// 坐着时她整体下沉 9px、跳跃中会上移 34px、投掷时还在旋转 ——
// 只要有一次上报恰好落在动画中途，报出去的就是一个错的框（而且错得没有规律）。
// 所以从 #petArea 推：那一层没有动画，几何是稳的；角色的显示宽按
// 「素材宽 × 角色区高 / 素材高」算出来 —— 与 main.js 的 spriteDisplayW() /
// padXOf() 是同一个式子（主进程那份还多一个缩放档，所以不共用代码，
// 但两边都盯着同一个前提：素材是 height:100% + 水平居中 + 底边对齐）。
function spriteBox() {
  const area = petArea.getBoundingClientRect();
  const nw = fBase.naturalWidth, nh = fBase.naturalHeight;
  if (!nw || !nh || !area.height) return area;   // 图还没解码：先按整个角色区报（偏保守）
  const dispW = nw * (area.height / nh);
  const left = area.left + (area.width - dispW) / 2;
  return { left: left, top: area.top, right: left + dispW, bottom: area.bottom };
}

let hitBox = null;      // 最后报出去的那个框（窗口本地 CSS px）。也给验收读数用。
function reportHitArea() {
  if (!window.pet.setHitArea) return;
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  const add = (x) => {
    l = Math.min(l, x.left); t = Math.min(t, x.top);
    r = Math.max(r, x.right); b = Math.max(b, x.bottom);
  };
  add(spriteBox());
  // 番茄钟面板贴在窗口底边、压着角色。它必须一起报进去 ——
  // 少了它，"开始 / 暂停 / 放弃 / 统计"四个按钮点上去会直接穿到桌面上。
  if (!panel.classList.contains('hidden')) add(panel.getBoundingClientRect());
  if (!Number.isFinite(l)) { window.pet.setHitArea(null); hitBox = null; return; }
  // 留一点余量：发梢、裙摆边缘，以及 #lookWrap 那 ±9px 的目光偏移都落在这条带子里。
  // 按宽度取比例而不是写死的 px —— 三档缩放（291 / 404 / 517 宽）下余量要跟着变。
  const pad = Math.min(24, Math.max(6, (r - l) * 0.05));
  hitBox = { l: l - pad, t: t - pad, r: r + pad, b: b + pad };
  window.pet.setHitArea(hitBox);
}

// 面板的显隐散落在五处（右键菜单打开 / 开始 / 放弃 / 暂停后收起 / 点面板外收起），
// 逐个去挂调用迟早漏一个 —— 而漏了的那次会让她"面板看得见、点不动"。
// 盯 #panel 的 class 比盯人可靠：不管谁改的、什么时候改的，改完就重报一次。
new MutationObserver(reportHitArea).observe(panel, { attributes: true, attributeFilter: ['class'] });
// 换装后素材宽高比变了 -> 显示宽变了；窗口缩放 / 分辨率变化 -> 角色区变了。
// 换装那条其实还会被 fBase 的 load 再触发一次，但两次上报是幂等的，不值得为省一次去加分支。
fBase.addEventListener('load', reportHitArea);
window.addEventListener('resize', reportHitArea);

// forward 过来的 mousemove：穿透态下渲染层**仍然收得到**鼠标移动
// （setIgnoreMouseEvents(true, { forward: true }) 的作用）。
// 用它把"鼠标压上她"的延迟从主进程那 120ms 的一拍压到一帧 ——
// 只发上升沿，另外每 1.5s 补发一次，兜住"主进程那一拍恰好判错"的情况。
// 注意它**只能取消穿透**：恢复穿透永远由主进程按光标位置决定，
// 所以这里即使算错，代价也只是多接一会儿鼠标事件，不会让她变成点不到。
let overSelf = false, lastOverAt = 0;
function hintOver(inside) {
  if (!window.pet.markOver) return;
  if (!inside) { overSelf = false; return; }
  const now = Date.now();
  if (overSelf && now - lastOverAt < 1500) return;
  overSelf = true; lastOverAt = now;
  window.pet.markOver();
}
window.addEventListener('mousemove', (e) => {
  if (!hitBox) return;
  hintOver(e.clientX >= hitBox.l && e.clientX <= hitBox.r &&
           e.clientY >= hitBox.t && e.clientY <= hitBox.b);
});

// ---------- 动画 ----------
const ANIMS = ['bounce', 'jump', 'shake', 'dangle', 'nod', 'spin', 'walk',
                'recoil', 'huff', 'tap', 'yawn', 'stretch', 'lookAround'];
// 记下最后一次触发的动作。这不是调试残留 —— 无头截图里**动画帧抓不准**
// （虚拟时间轴和 CSS 动画对不齐，项目文档里记过这个坑），所以"这个动作到底触发了没"
// 只能靠读数证明，不能靠像素。preview.html 的 readout 会把它摆出来。
let lastAnim = { name: '', at: 0 };
function anim(name, dur) {
  ANIMS.forEach((c) => wrap.classList.remove(c));
  void wrap.offsetWidth;                 // 强制重排，才能重启动画
  wrap.classList.add(name);
  lastAnim = { name, at: Date.now() };
  if (dur) setTimeout(() => wrap.classList.remove(name), dur);
}
function setPose(cls) {                  // 互斥的待机姿态
  // v3.4 加了 'sit'（坐下），v3.6 加了 'wake'（刚醒的迷糊）。
  // 新增姿态必须加进这个列表 ——
  // 漏掉的话旧姿态不会被摘掉，两个动画会叠在同一个 transform 上打架。
  ['breathe', 'sleep', 'focus', 'sit', 'wake'].forEach((c) => wrap.classList.remove(c));
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
  // 口型只跟**打字**这一段走。气泡挂着的剩余时间里她其实已经说完了，
  // 再动嘴就成了"声音停了嘴还在动"。
  talkFor(340 + text.length * 26);
}
function quote(arr, vars) {
  // 安静档下、她正在做自己的事期间不出声（见 idleMute 的说明）。
  // 这是**唯一**的拦截点：主动台词全部从 quote 出去，所以不存在漏网的路径 ——
  // 也因此不必去改那十几处调用点。
  if (idleMute > 0) return;
  const t = pick(arr);
  if (!t) return;
  // 占位符替换。v3.12 从"只认 {name}"改成通用替换 —— 整点报时要 {h}、纪念日要 {n}。
  // ⚠ 老调用点有传**字符串**的（例如 quote(QUOTES.pomStart, name)），所以两种形态都要吃。
  // ⚠ 而且 {name} 缺省时必须仍然是**空串**（v3.11 以前就是那么做的）；
  //   改成"原样保留"会让气泡里冒出字面的 {name}。
  const v = typeof vars === 'string' ? { name: vars } : (vars || {});
  const text = t.replace(/\{(\w+)\}/g, (m, k) =>
    (k in v) ? String(v[k]) : (k === 'name' ? '' : m));
  say(text, 3200 + t.length * 55);
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
function blush(eye) {
  const b = $('#blush');
  b.classList.remove('on');
  void b.offsetWidth;                    // 强制重排，动画才能重播
  b.classList.add('on');
  // 正向反馈顺带给一个眼部表情。**默认笑眼**，摸头那类更亲昵的场合传 'wink'。
  // 挂在 blush() 里而不是各个调用点：腮红本来就是"正向反馈"这件事的唯一出口，
  // 眼部表情属于同一件事。分两处写就会出现"某处漏了表情"，而那种漏在画面上
  // 只表现为"这次她没笑" —— 没法从截图里看出是设计如此还是接线断了。
  // 参数只开一个槽位、不开时长：三个调用点都是"开心一下"，一个 1.2s 的统一节拍
  // 反而让"开心"这件事有一致的分量；分开调只会得到三个说不清为什么的数字。
  expression(eye || 'happy', 1200);
}

// ---------- 关于"眨眼"：v3.9 加回来了（v3.10 修好了融洽度），但**不是**原来那两版 ----------
//
// 之前删掉它，并且写了"不要再加回来"。那条结论在当时的条件下是对的，
// 但它否掉的是**两种做法**，不是这件事本身：
//   v1 —— 矩形 mask 走 inpaint，模型直接吐出灰块 / 黑条 / 蓝条。
//   v2 —— 把眼区抹平再画一根眼睑弧线。睫毛、下眼睑、外眼角全部消失，
//         只剩一根 1~2px 的细线；眼窝还因为填充算法留下灰霾。
// 两者都栽在同一处：**想用一只手同时干成两件事**。
//   程序合成：对齐完美（逐像素可控），但画不出雪乃那条带锥度的粗睫毛线；
//   扩散重绘：画得出睫毛线，但整张会被重新采样，帧间就对不齐了。
//
// v3.9 的分法是把两件事拆给两个执行者（见 tools/gen_layers.py 与 mkframe.py）：
//   模型只画掩膜内那块  → 睫毛线是画出来的
//   对齐是算出来的      → 掩膜之外，基准立绘逐字节不变
// 关键的一步是**潜空间掩膜**（SetLatentNoiseMask）：去噪范围被硬性圈在掩膜内，
// 模型想重绘别处也够不着。这一条把它和 v2/v3 那次"全图重绘丢特征"彻底分开 ——
// 实测同一次生成的"掩膜外色偏"从 27（去噪 0.55）~ 92 级（去噪 1.0）
// 降到 4.6 级 —— 而"纯 VAE 往返、什么都没改"在同一块区域上量出来也是 4.6 级，
// 也就是那点差异与模型无关，是 VAE 自己的重建误差。
//
// v3.10 又把掩膜从"两个眼球椭圆"换成"整张脸"：闭眼的改动有 1 万个像素落在
// 椭圆之外，所以 v3.9 那个圈法**在结构上**就必然在眼皮底下留下一道旧睫毛弧。
// 换了范围之后，掩膜外照样一点不动，框内则是一次画完的整张脸 ——
// "既融洽又不抖"是这两件事一起给的，不是调参调出来的。
//
// 交出去的层因此是**区域帧**：尺寸与定位都跟立绘一致，但 alpha 只在框内非零。
// 于是它在数学上等价于"整张替换"（框外逐位等于基准），又保住了眼/嘴两层
// 自由组合 —— 叠的是独立的两层，所以"边眨眼边说话"不需要一张合成图。
//
// 当初列的两条成熟路线（Live2D / 请画师画差分）依然有效，只是不再是**唯一**的路。
// 那条"不要再加回来"的警告现在改成：**不要再用程序合成或全图重绘去实现它**。

// ---------- 待机：生活流 ----------
// ★ v3.6 把"每 12~26 秒独立抽一条动作"换成了**连续行为链**。
//
// 旧写法有两个"挂机一小时就暴露、但盯着单条代码看不出来"的毛病：
//   · 拍与拍之间**没有关系**。上一拍点头、下一拍看窗外、再下一拍伸懒腰 ——
//     读起来是"她每隔十几秒抖一下"，而不是"她在过日子"。
//     之前把池子从 7 条扩到 15 条也没改善，因为问题不在条目数，在条目**之间**。
//   · 节奏是**死的**。12~26 秒被反复采样，很快就能听出拍子。
//
// 现在的结构是「节点 + 权重转移」：一条自主行为从入口表进，演 2~4 拍，
// 每拍结束按权重决定下一拍，撞到终止就收，链与链之间才静默。
// 于是**总密度没怎么变、观感却静得多** —— 连续的那几拍被读成一件事了。
//
// 转移表的权重就是"她的性格"：在看书这条线上，下一拍更可能是翻页或喝茶，
// 而不是突然站起来散步。
//
// ⚠ 每个节点要么在 NEXT 里有正权重出边，要么显式标 `end: true`。
//   转移表最容易出的两种坏法都是**静默**的：某个节点没有任何出边（进去就卡死）、
//   或引用了不存在的节点（抽到就崩）。两种都由 selftest 第 15 节逐一断言。
//   另外 chainBudget 是**结构性兜底**：就算转移表被写成一个环，预算耗尽也会强制收链 ——
//   所以"她永远卡在同一个动作上"在结构上不可能发生，不需要靠"记得别写错"。
const ACT = {
  // —— 她自己在做的事：带物件或朝向，注意力不在你身上 ——
  read:    { ms: 2600, run() { anim('nod', 900); particles(['📖', '✎'], 2); quote(QUOTES.read); } },
  window:  { ms: 2200, run() { anim('lookAround', 1600); particles(['❄'], 1); quote(QUOTES.window); } },
  tidy:    { ms: 1600, run() { anim('shake', 620); emote('🎀'); quote(QUOTES.tidy); } },
  tea:     { ms: 2400, run() { emote('☕'); particles(['☕', '♨'], 2); quote(QUOTES.tea); } },
  // —— 身体状态 ——
  yawn:    { ms: 2000, run() { anim('yawn', 1400); quote(QUOTES.yawn); emote('💤'); } },
  stretch: { ms: 2100, run() { anim('stretch', 1500); quote(QUOTES.stretch); } },
  glance:  { ms: 1900, run() { anim('lookAround', 1600); quote(QUOTES.lookAround); } },
  // 坐下是**姿态**不是动作。下一拍大概率是 stand（转移表里给了最高权重）；
  // 万一链提前收了，endChain 会兜底把她拉起来。
  sit:     {
    ms: 6000,
    run() {
      if (wrap.classList.contains('sit')) return false;   // 已经坐着了 —— 这一拍作废
      setPose('sit');
      quote(QUOTES.sit);
    }
  },
  stand:   {
    ms: 1000,
    run() { if (!wrap.classList.contains('sit')) return false; setPose('breathe'); }
  },
  // —— 轻的小动作（多半不说话）——
  hum:     { ms: 1200, run() { anim('spin', 1000); emote('♪'); } },
  hop:     { ms: 1000, run() { anim('bounce', 560); } },
  think:   { ms: 1100, run() { emote('…'); } },
  look:    { ms: 1100, run() { anim('nod', 900); emote('👀'); } },
  // 台词走 idleLines() 而不是 QUOTES.idle —— 它会并入已解锁的羁绊台词。
  nod:     { ms: 1100, run() { anim('nod', 900); quote(idleLines()); } },
  drift:   { ms: 1700, run() { particles(['❄', '☕', '📖'], 2); } },
  // —— 会离开原地的两拍：一律**收链**（end: true）——
  // 走动/靠近期间 state.mode 会变成 'walk'，链继续推进的话那几拍的动画
  // 会全部打在走动状态上（看不见），等走完回来她已经"演完一场空戏"。
  wander:  { ms: 900, end: true, run() { walk(); } },
  approach:{ ms: 900, end: true, run() { return idleApproach(); } }
};

// 入口权重 = "一条链最可能从哪件事开始"。走动 / 靠近刻意给得低：
// 它们是**会被你注意到**的两件事，不该像看书那样频繁
// （换算下来约 5~10 分钟才有一条链以走动开头）。
const CHAIN_ENTRY = {
  read: 3, window: 3, think: 2, drift: 2, glance: 2, nod: 2,
  yawn: 2, stretch: 2, tea: 2, sit: 2, wander: 2,
  tidy: 1, hum: 1, hop: 1, look: 1, approach: 1
};

// 转移表。键是"现在这一拍"，值是"下一拍各去哪、权重多少"。
// '_' = 这条链到此为止。
const NEXT = {
  read:    { read: 2, window: 2, yawn: 2, tea: 3, think: 2, nod: 1, _: 3 },
  window:  { read: 2, think: 2, yawn: 2, drift: 2, glance: 1, _: 3 },
  tidy:    { glance: 2, hum: 2, stand: 1, _: 3 },
  tea:     { window: 2, think: 2, read: 2, look: 1, _: 4 },
  yawn:    { stretch: 3, sit: 2, think: 1, _: 3 },
  stretch: { sit: 2, window: 2, tea: 2, _: 3 },
  glance:  { read: 2, nod: 2, think: 2, hop: 1, _: 3 },
  // sit **没有 '_' 出边**：坐下就该接着做点什么，或者站起来。
  // 这条链路不靠"必须有出边"来保证，靠 endChain 的兜底（见那里的说明）。
  sit:     { stand: 4, read: 3, tea: 3, window: 2 },
  stand:   { stretch: 2, glance: 2, hop: 1, _: 4 },
  hum:     { nod: 2, look: 2, hop: 1, _: 3 },
  hop:     { glance: 2, think: 1, _: 3 },
  think:   { window: 2, nod: 2, read: 2, drift: 2, _: 3 },
  look:    { nod: 2, think: 1, _: 3 },
  nod:     { think: 2, read: 1, _: 3 },
  drift:   { glance: 2, think: 2, window: 1, _: 3 }
};

// 至少两拍。一拍不叫"在过日子"，跟旧方案没区别。
const CHAIN_MIN_STEPS = 2;
// 一条链的总时长上限。**为什么用时间限而不是拍数限**：节点时长差得很远
// （think 1.1s，sit 6s），按拍数限会让"坐下喝茶"那条链长得离谱，
// 而"快点想一下"那条又短得没形。
const CHAIN_BUDGET = 14000;
// 链与链之间的静默。比原来的 12~26s 拉开一些：链本身已经是连续好几拍了，
// 间隔不跟着放大的话，总量反而比原来更吵。
const CHAIN_GAP_MIN = 11000, CHAIN_GAP_MAX = 24000;
// 活泼档整体缩短这个间隔（"更爱冒泡"就体现在它和下面的 chainEntry() 上）。
const CHAIN_GAP_SCALE = { quiet: 1, normal: 1, lively: 0.6 };
// 最近一次互动之后的"不开链"窗口。你刚点过她 / 摸过她 / 还在敲键盘时，
// 她自己那出戏不但会被你打断，还会跟她正在做的反应抢同一个动画
// （anim() 会清掉 #petWrap 上所有动作类）。
// 旧写法没有这一条，所以"打字时她每十几秒闪一下"是存在过的。
const CHAIN_QUIET_AFTER = 8000;

// 抽一条出边。权重 <= 0 的边视为不存在 —— "临时关掉某条路"只需要改数字。
// allowEnd 为假时 '_' 不参与抽取，用来保证链至少演够 CHAIN_MIN_STEPS 拍。
function pickWeighted(spec, allowEnd) {
  const keys = Object.keys(spec || {}).filter((k) => spec[k] > 0 && (allowEnd || k !== '_'));
  if (!keys.length) return '_';
  let total = 0;
  for (const k of keys) total += spec[k];
  let r = Math.random() * total;
  for (const k of keys) { r -= spec[k]; if (r < 0) return k; }
  return keys[keys.length - 1];          // 浮点边界兜底
}

let chainTimer = null, chainGapTimer = null;
let chainNow = '', chainSteps = 0, chainBudget = 0, chainIdle = 0;
// 只给验收读：最近一拍是谁、第几拍、有没有真做成。无头截图抓不准动画帧，
// "这个动作到底触发了没"只能靠读数证明（和 lastAnim 同一个理由）。
let lastChain = null;

// 入场权重按当前打扰等级取。活泼档下走动 / 靠近的权重翻倍 ——
// 那两件是"你会注意到她"的事，也正是"活泼"这个词的意思
// （不是单纯把自言自语调密：那样只会变成更吵的同一个人）。
function chainEntry() {
  if (chatter !== 'lively') return CHAIN_ENTRY;
  const e = Object.assign({}, CHAIN_ENTRY);
  e.wander = (e.wander || 0) * 2;
  e.approach = (e.approach || 0) * 2;
  return e;
}

function runChain() {
  if (chainTimer) return false;
  if (state.mode !== 'idle' || sleeping || quiet) return false;
  if (Date.now() - lastInteract < CHAIN_QUIET_AFTER) return false;   // 你刚动过，先别演
  chainSteps = 0;
  chainIdle = 0;
  chainBudget = CHAIN_BUDGET;
  chainNow = pickWeighted(chainEntry(), false);
  chainTick();
  return true;
}

function chainTick() {
  const a = ACT[chainNow];
  // 每一拍开始前**重验前提**。不满足就整条收掉，不是跳过 ——
  // 跳过的话，"她正在走动 / 投掷 / 番茄钟"期间链会照常推进，
  // 等那些结束回来时已经跑到第三拍了，而前几拍的动画全打在别的状态上（根本没显示）。
  if (!a || state.mode !== 'idle' || sleeping || quiet) { endChain(); return; }

  let did = true;
  // 安静档：这一拍只演动作与表情，不出声。用计数器包一层就够了 ——
  // a.run() 全是同步的（台词从 quote 出去，在那里被拦），
  // 不必给每个节点再写一个"静音版"（那会变成两份要同步维护的行为表）。
  if (!talkOK()) idleMute++;
  try { did = a.run() !== false; } catch (e) { did = false; }
  finally { if (!talkOK()) idleMute--; }
  lastChain = { node: chainNow, step: chainSteps + 1, did: did };

  if (did) {
    chainSteps++;
    chainBudget -= a.ms;
    chainIdle = 0;
  } else if (++chainIdle > 3) {
    // 连着四拍都做不成（典型情形：入口抽到 sit，但她已经坐着了）。
    // 不能无限重抽 —— 那是同步递归，会把渲染线程钉死。
    endChain(); return;
  }

  let nxt = '_';
  if (!did && a.end) {
    // 这一拍**根本没发生**（前提不满足），那就没理由因为它收链 —— 重抽一个入口重来。
    // 不这么做的话：入口抽到 approach（她走过来看你），而光标正好在她旁边
    // （dist < 340）时它是做不成的 —— 用户看到的是"点了生活流，她一动没动"，
    // 而且完全没有报错。这是这条链上最容易出现的静默失败，所以单独处理。
    nxt = pickWeighted(chainEntry(), false);
  } else if (!a.end && chainBudget > 0) {
    nxt = pickWeighted(NEXT[chainNow], chainSteps >= CHAIN_MIN_STEPS);
  }
  const wait = did ? a.ms : 0;
  if (nxt === '_' || !ACT[nxt]) {
    // 收尾也要等这一拍**演完**再收 —— 立刻 endChain 会把最后那下动画掐断。
    chainTimer = setTimeout(() => { chainTimer = null; endChain(); }, wait);
    return;
  }
  chainNow = nxt;
  chainTimer = setTimeout(chainTick, wait);
}

function endChain() {
  if (chainTimer) { clearTimeout(chainTimer); chainTimer = null; }
  // 兜底：链结束了她还坐着就起来。不能指望"转移表里 sit 后面一定接 stand"——
  // 链可能因为预算耗尽、或你突然点她而提前收，那时她正坐着。
  // 让她以坐姿进入静默期的话，下一次呼吸动画会被 sit 的类顶掉，
  // 她会保持坐姿站一整段静默，看起来像卡住了。
  if (wrap.classList.contains('sit')) setPose('breathe');
  scheduleChain();
}

// 链与链之间的等待时长，按打扰等级取（活泼档缩短）。
function chainGap() {
  const k = CHAIN_GAP_SCALE[chatter] || 1;
  return (CHAIN_GAP_MIN + Math.random() * (CHAIN_GAP_MAX - CHAIN_GAP_MIN)) * k;
}

function scheduleChain() {
  if (chainGapTimer) clearTimeout(chainGapTimer);
  chainGapTimer = setTimeout(() => {
    chainGapTimer = null;
    if (state.mode === 'idle' && !sleeping && !quiet) runChain();
    else scheduleChain();          // 前提不满足就接着等，别把链丢掉
  }, chainGap());
}

// 你一碰她就打断。为什么要打断、而不是"让她跑完"：
// 链的下一拍是个 setTimeout，不打断的话你在链中间点了她一下，
// 她回完话两秒后又自己接着"看窗外"—— 像没听见你说话。
// 何况 anim() 会清掉 wrap 上所有动作类，那一拍的动画其实已经被你的交互顶掉了，
// 只是链自己不知道，还会照原计划走过去。
function interruptChain() {
  if (!chainTimer) return false;
  clearTimeout(chainTimer);
  chainTimer = null;
  endChain();
  return true;
}

scheduleChain();

// ---------- 长时间无互动 -> 睡着（醒来分三拍）----------
let lastInteract = Date.now(), sleeping = false;
// waking = 正在醒。这是一个**独立状态**，不是 sleeping 的中间值：
// sleeping 已经为假（"她醒了"），但过渡还没走完，而这段时间里点击必须被特殊处理。
let waking = false, wakeTimers = [];

function clearWakeTimers() { wakeTimers.forEach(clearTimeout); wakeTimers = []; }

// 醒来分三拍：迷糊 -> 打哈欠 -> 回神。
// 原来是一下切回 breathe 然后说话 —— 那不像"醒来"，像"被拔了电又插上"。
// 三拍之间她一直处在 wake 姿态（沉一点、缓一点），所以看得出她还没缓过来。
function wakeUp() {
  if (!sleeping || waking) return false;
  sleeping = false;
  waking = true;
  interruptChain();                  // 睡着时链本来就停了，这里防的是"醒来接着跑旧链"
  setPose('wake');
  // 醒来那三拍里她是**半睁**的。只用闭眼/睁眼两档的话，
  // "迷糊"这一段就只能靠姿态表达；半睁把"还没缓过来"直接写在眼睛上。
  eyeForced = 'half'; applyEyeLayer();
  quote(QUOTES.wakeGroggy, 2400);
  wakeTimers.push(setTimeout(() => {
    anim('yawn', 1400);
    wakeTimers.push(setTimeout(() => finishWake(true), 1500));
  }, 1200));
  return true;
}

// 把过渡立刻结束。两条路会走到这：
//   soft = true   正常走完三拍，补一句"清醒后"的台词
//   soft = false  你在她迷糊的两秒里又戳了一下 —— 那就别迷糊了
//
// 第二条是**必须**的：不提供"跳过"的话，刚醒的那两秒里点击会被 wakeUp 吞掉
// （返回 true 就 return 了），表现为"点了没反应"；而且第二次点击还会被 250ms 的
// 双击判定算成双击，于是变成"戳一下 → 跳一下 + 她说'别突然做那种事'"。
function finishWake(soft) {
  if (!waking) return false;
  waking = false;
  clearWakeTimers();
  setPose('breathe');
  eyeForced = null; applyEyeLayer();     // 三拍走完才算真的醒了，眼睛放回自动眨眼
  if (soft) quote(QUOTES.wake);
  else quote(QUOTES.wakeRush, 2200);
  return true;
}

// ★ v3.8：判据从"你多久没点我"改成"你到底在不在"（userActive，来自主进程的系统空闲检测）。
//   旧判据把两件事混成了一件：「你没理我」和「你人不在」。后果是你在隔壁窗口
//   连写两小时代码、一下没碰她 —— 她早就睡了，而她其实一直坐在旁边陪着你。
//   这件事在设计上说不通：桌宠睡着该是"你不在，我打个盹"，
//   不该是"你不理我，我生气了"。
//   现在只有系统层面 2 分钟没有输入才算你走了，她才会睡。
// 入睡这件事只写一遍。原来 sleepCheck() 和演示入口 __demo.sleep() 各写一份，
// 加"闭眼图层"时就是两处要改 —— 漏一处只会表现为"演示里她睁着眼睡"，
// 而演示正是用来验收的，那种不一致最误导人。
function fallAsleep() {
  if (state.mode !== 'idle' || sleeping) return false;
  sleeping = true;
  setPose('sleep');
  // 睡着时把眼睛换成闭眼图层。
  // 这是差分图层顺带修掉的一处旧毛病：原来她"睡着"只是整体缩小、下沉，
  // 眼睛还是睁着的 —— 因为当时根本没有闭眼素材可用。
  // 走 eyeForced 而不是 eyeWant：睡着是一个**状态**，不该被下一次自动眨眼顶掉。
  eyeForced = 'closed'; applyEyeLayer();
  quote(QUOTES.sleep);
  emote('💤');
  return true;
}

function sleepCheck() {
  if (state.mode !== 'idle' || sleeping || quiet) return;
  if (userActive) return;              // 你在 —— 她就不睡。就这一条。
  fallAsleep();
}
setInterval(sleepCheck, 20000);

// ---------- 你在不在（系统空闲）----------
// 真值在主进程 —— 只有它问得到 powerMonitor.getSystemIdleTime()。
// 这里只是一个镜像，供三处使用：上面的睡着判定、下面的"你回来时她汇报一句"、
// 以及健康提醒演出时"你不在就别开口"。
window.pet.onActivity((a) => {
  if (!a) return;
  const was = userActive;
  userActive = !!a.active;
  if (!userActive && was) {
    // 你刚走：把她自己那条链收掉 —— 别对着一个空房间继续演。
    interruptChain();
    return;
  }
  if (userActive && !was) onUserBack(Number(a.awayMs) || 0);
});

// 你回到电脑前。
//   她睡着 -> 叫醒。醒来那三拍本身就是"你回来了"的回应，够了，不再叠一句汇报。
//   她醒着 -> 如果你离开得够久，她说一句"刚才做了什么"。
function onUserBack(awayMs) {
  lastInteract = Date.now();
  if (waking) { finishWake(false); return; }
  if (sleeping) { wakeUp(); return; }
  if (quiet) return;                     // 她"出去了"：回来也不该隔着隐藏窗口出声
  quote(awayDoingLine(awayMs));
}

// 你离开多久 -> 回来时她汇报什么。
// ⚠ 与 awayLine（久别重逢）是**两个尺度**，别合并：
//     awayLine   跨进程：上次桌宠运行到现在隔了多久（重启 / 关机再开），档位是小时和天。
//     awayDoing  同一次运行内：你只是离开键盘一会儿，档位是分钟。
//   合并的后果是离开半小时她说"你终于来了"—— 那句话是给隔了三天准备的。
// 返回**数组**交给 quote 去抽（不是抽好的字符串）：这样"防连抽同一条"仍然有效。
const AWAY_DOING_MIN = 3 * 60 * 1000;
const AWAY_DOING_LONG = 30 * 60 * 1000;
function awayDoingLine(awayMs) {
  const d = Number(awayMs) || 0;
  if (d < AWAY_DOING_MIN) return null;   // 去倒杯水就回来，她汇报什么
  return d < AWAY_DOING_LONG ? QUOTES.awayDoing : QUOTES.awayDoingLong;
}

// ---------- 拖拽（自由落体 + 边缘吸附 + 投掷） ----------
let dragging = false, dragOff = { x: 0, y: 0 }, pos = null;

// 松手瞬间的速度：不是"最后两帧的差"，而是**最近 90ms 的位移 / 时间**。
// 用两帧差的话，手在松手前一瞬停了一下（这是很自然的动作）速度就直接归零，
// 于是"想甩"却甩不出去 —— 手感会变得很不可靠。
let trail = [];
function pushTrail(x, y) {
  const t = performance.now();
  trail.push({ x, y, t });
  while (trail.length > 24 || (trail.length > 2 && t - trail[0].t > 220)) trail.shift();
}
function releaseVelocity() {
  if (trail.length < 2) return { vx: 0, vy: 0 };
  const last = trail[trail.length - 1];
  // 从尾部往回找一个"至少隔了 40ms"的采样点，太近的话噪声会被放大
  let first = trail[0];
  for (let i = trail.length - 1; i >= 0; i--) {
    if (last.t - trail[i].t >= 40) { first = trail[i]; break; }
  }
  const dt = Math.max(8, last.t - first.t);
  return { vx: (last.x - first.x) / dt * 16.7, vy: (last.y - first.y) / dt * 16.7 };  // -> px/帧
}

// 角色在窗口里显示多高。直接量 DOM（#petWrap 的高 = #petArea 的高）——
// 算式只写在 pet.css 的 #petArea 里一处，这里不复制，CSS 改了自动跟随。
function petDisplayH() {
  const r = wrap.getBoundingClientRect();
  return r.height || Math.round(WIN_H - PET_TOP_PAD_RATIO * WIN_W);   // 首帧布局未就绪时兜底
}

// 角色在窗口里实际占多宽。素材按 height:100% 落位，所以
// 显示宽 = 素材宽 × (角色显示高度 / 素材高)。
function spriteW() {
  const w = fBase.naturalWidth, h = fBase.naturalHeight;
  const dh = petDisplayH();
  if (!w || !h || !dh) return WIN_W;   // 尺寸未知时按最宽保守估（角色不会比窗口宽）
  return w * (dh / h);
}

// 松手时的横向吸附：把**角色的外轮廓**贴到屏幕边缘。
// 不能夹窗口边缘 —— 角色在窗口里是水平居中的，而角色宽度往往远小于窗口宽度
// （水手服只有 264px，窗口 404），夹窗口会在角色和屏幕边之间留一大条缝，
// 看起来像"贴了个寂寞"。
//
// ★ 返回值从"一个数"变成 `{ x, edge }`。edge 非空 = 这一下贴到了左/右屏幕边。
//   为什么让同一次判断同时决定"吸附"和"收边"：这两件事的触发条件**完全相同**
//   （角色轮廓贴到屏幕边），分成两处判断迟早会出现半吊子状态 ——
//   吸过去了却没缩起来，或者缩起来了其实没贴边。
const SNAP = 26;
function snapX(x, area, petW, sw) {
  const left = x + (petW - sw) / 2;
  const right = left + sw;
  if (left - area.x < SNAP) return { x: Math.round(area.x - (petW - sw) / 2), edge: 'left' };
  if ((area.x + area.width) - right < SNAP) {
    return { x: Math.round(area.x + area.width - petW + (petW - sw) / 2), edge: 'right' };
  }
  return { x: Math.round(x), edge: null };
}

// 收边状态的**本地镜像**，只用来少发几次 IPC（见 reqEdge）。真值在主进程 ——
// 位置只有它算得准（要看角色显示宽、当前显示器、缩放档）。
// ⚠ 它会和主进程漂开：用户在托盘菜单里点了「取消收边」不会经过这里。
//   所以它**只能**用来决定"要不要多发一条请求"，绝不能拿来判断"她此刻是不是收着"。
let edgeReq = null;
function reqEdge(mode) {
  edgeReq = mode;
  return window.pet.setEdge(mode).then((real) => { edgeReq = real || null; return real; });
}

wrap.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  dragging = true;
  trail = [];
  lastInteract = Date.now();
  interruptChain();                // 一按下去，她自己那条链就该停
  // 她正在醒的时候被拖起来：直接把过渡收掉。不收的话那两个 setTimeout
  // 会在你拖到一半时插一个 yawn 进来，把 dangle 顶掉（两个动画都挂在 #petWrap 上）。
  if (waking) finishWake(false); else wakeUp();
  cancelThrow();
  wrap.classList.add('grabbing');
  anim('dangle');
  quote(QUOTES.drag);
  emote('💢');
  window.pet.setBlock(true);       // 拖拽期间停掉几何巡检，免得跟手的动作抢
  window.pet.getBounds().then((b) => {
    if (!b) return;
    pos = { x: b.x, y: b.y };
    dragOff = { x: e.screenX - b.x, y: e.screenY - b.y };
    pushTrail(b.x, b.y);
  });
});

window.addEventListener('mousemove', (e) => {
  if (!dragging || !pos) return;
  pos = { x: e.screenX - dragOff.x, y: e.screenY - dragOff.y };
  pushTrail(pos.x, pos.y);
  window.pet.moveTo(pos.x, pos.y);
});

let fallRAF = 0;
// 松手后的收尾：垂直自由落体 + 水平匀速滑向吸附位。
// 水平**不加**速度渐变 —— 加了看起来像被"吸"过去，匀速才像自己挪过去。
//
// edge 非空 = 这一趟落点贴到了屏幕边，落地收尾时要进"收边"（迷你）态。
// ⚠ 收边必须等 settle **走完**再进，不能提前：settle 会一路 moveTo，
//   而收边态下窗口位置由主进程的贴边逻辑全权接管（那条路会把窗口推出屏幕外）。
//   先收边再落地，两者会互相打架 —— 表现是她落到一半被拽回去。
function settle(x0, y0, x1, y1, edge) {
  const finish = () => {
    anim('bounce', 560);
    quote(QUOTES.drop);
    particles(['💥'], 1);
    sfx('land');
    window.pet.savePos(x1, y1);     // 记住她停在哪，重启不会再回到右上角
    gain('drop');
    if (edge) reqEdge(edge);        // 贴边 -> 收起来，只露小半个身子
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

// ---------- 投掷物理 ----------
// 原来松手只有"落体 + 贴边"，扔不远也弹不起来。现在把松手速度接进一个真的
// 运动积分里：重力 + 水平速度 + 撞屏幕左右边缘反弹（带阻尼）+ 落地小弹一下。
//
// ⚠ 积分本身**不在这个文件里** —— 它在根目录的 throwphysics.js，和 clamp.js 同一个
// 组织方式。原因只有一个：rAF 驱动的东西在无头验收里跑不起来
// （实测：--virtual-time-budget=5000 时 setInterval 走了 10 拍、rAF 一次没触发；
// 加 --screenshot 也只多 1 帧）。抽出去之后 selftest 能在 Node 里把初始速度扫一遍，
// 断言"必然收敛"这条不变量 —— 而它恰恰是最不该靠读代码确认的那类
// （它坏了不报错，只是待机池 / 走动 / 睡觉全静默失效）。
//
// 这里只留三件属于**应用层**的事：
//   1. 边界怎么算（左右按角色外轮廓，不按窗口矩形 —— 理由见下）
//   2. 什么时候算"甩了一下"（松手速度阈值）
//   3. 触发撞击音效的节流（物理层不该知道音效）
const TH = PetThrow;
let throwRAF = 0, throwing = false;

function cancelThrow() {
  if (throwRAF) cancelAnimationFrame(throwRAF);
  throwRAF = 0;
  if (throwing) {
    throwing = false;
    wrap.style.transform = '';
    if (state.mode === 'throw') state.mode = 'idle';
    setPose('breathe');
  }
}

async function throwIt(v0) {
  const [area, b] = await Promise.all([window.pet.getWorkArea(), window.pet.getBounds()]);
  if (!b || dragging) return;
  const petW = b.width;
  const padX = Math.max(0, (petW - spriteW()) / 2);   // 窗口两边的透明边
  // 左右边界按**角色外轮廓**算，不是窗口矩形。水手服显示宽只有 188px 而窗口 404，
  // 按窗口撞墙的话她会在离屏幕边 100 多像素的地方"弹回来"，像撞在空气上。
  const lim = {
    left: area.x - padX,                       // 角色左轮廓能到的位置
    right: area.x + area.width - petW + padX,  // 角色右轮廓能到的位置
    ground: groundY(area)
  };

  const s = TH.makeState(v0, b.x, b.y);
  let wallHitAt = 0, groundHitAt = 0;
  // 记下这一趟的边界与夹后的初速度，供无头验收读。
  // 为什么要专门摆出来："左右边界按**角色外轮廓**算"是最容易无声改坏的一条 ——
  // 换成窗口矩形在画面上几乎看不出来（她只是提前 100 来像素弹回来），
  // 但窄套装（水手服）会明显得像撞空气。摆出 padX 和左右极限，
  // 这条就从"看画面对比"变成"读一个数"。
  lastThrow = {
    vx: Math.round(s.vx), vy: Math.round(s.vy),
    left: Math.round(lim.left), right: Math.round(lim.right),
    ground: Math.round(lim.ground), padX: Math.round(padX)
  };

  state.mode = 'throw';
  throwing = true;
  ANIMS.forEach((c) => wrap.classList.remove(c));
  setPose(null);          // 清 pose：CSS 动画优先级高于 inline style，不清的话 breathe 会盖掉 rotate
  // 被甩出去的那一声。QUOTES.throw 是**为这一刻写的**（"等一下——！"那一组），
  // 但 v3.4 上线时漏接了 —— 于是她整个飞行过程一声不吭，只会在落地时才说话，
  // 看起来像"被扔出去这件事她没反应过来"。台词库里有、代码里没引用，
  // 是这一版最容易再犯的错，所以 selftest 加了"不死台词"这条。
  quote(QUOTES.throw, 2000);
  emote('💦');

  const step = () => {
    if (dragging) { cancelThrow(); return; }
    const r = TH.step(s, lim);

    // 撞击音效在这里发，不在物理层 —— 物理层不该知道有音效这回事。
    // 两条都按 120ms 节流：连续滚地时每帧都发声会变成电流噪音。
    const now = performance.now();
    if (r.wall && now - wallHitAt > 120) { wallHitAt = now; sfx('bounce'); }
    if (r.ground && now - groundHitAt > 120) { groundHitAt = now; sfx('land'); }

    wrap.style.transform = 'rotate(' + s.rot.toFixed(1) + 'deg)';
    window.pet.moveTo(Math.round(s.x), Math.round(s.y));

    if (r.done) { landFromThrow(s.rot, s.x, s.y); return; }
    throwRAF = requestAnimationFrame(step);
  };
  step();
}

// 落地收尾：把翻滚角度**转回 0**（不是"啪"地清掉）—— 清掉的话她会瞬间站正，
// 像被剪掉的动画。转回来的这 180ms 才是"站稳"这件事本身。
function landFromThrow(rot, x, y) {
  const t0 = performance.now();
  const from = ((rot % 360) + 540) % 360 - 180;         // 归一化到 [-180,180)，转最近的一边
  const dur = 180;
  const back = () => {
    const k = Math.min(1, (performance.now() - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    wrap.style.transform = 'rotate(' + (from * (1 - e)).toFixed(1) + 'deg)';
    if (k < 1) { throwRAF = requestAnimationFrame(back); return; }
    wrap.style.transform = '';
    throwing = false;
    throwRAF = 0;
    state.mode = 'idle';
    setPose('breathe');
    anim('bounce', 560);
    quote(rand([QUOTES.thud, QUOTES.settleAfterThrow]));
    particles(['💥', '✨'], 2);
    blush();
    window.pet.savePos(Math.round(x), Math.round(y));
    gain('drop');
    moodShift(-10);
  };
  back();
}

function endDrag() {
  if (!dragging) return;
  dragging = false;
  cancelAnimationFrame(fallRAF);
  wrap.classList.remove('grabbing');
  window.pet.setBlock(false);
  const p = pos; pos = null;
  const v0 = releaseVelocity();
  const power = Math.hypot(v0.vx, v0.vy);
  // 甩得够快才走投掷，否则还是"放下"。阈值按 px/帧 定：约 6px/帧 ≈ 360px/s，
  // 大致就是"刻意甩一下"的力度，随手放下够不到。
  if (power > 6 && p) { throwIt(v0); return; }
  Promise.all([window.pet.getWorkArea(), window.pet.getBounds()]).then(([area, b]) => {
    const petW = (b && b.width) || area.petW || WIN_W;
    const targetY = groundY(area);
    let x = p ? p.x : (b ? b.x : 0);
    const y = p ? p.y : targetY;
    const snap = snapX(x, area, petW, spriteW());
    // 原来这里是 `if (startY < targetY) fall(); else 只弹一下不移动` ——
    // 那个 else 什么都不做，于是每拖一次就往下沉一截，拖几次人整个掉出屏幕。
    // 现在两条分支都走 settle()，不存在"什么都不做"的出口。
    settle(snap.x, y, snap.x, targetY, snap.edge);
  });
}
window.addEventListener('mouseup', endDrag);
window.addEventListener('blur', endDrag);   // 鼠标甩出窗口、收不到 mouseup 时兜底

// ---------- 滚轮缩放（两条通道）----------
// v3.6 起普通滚轮也认，但**只在光标真压在她身上时**。
//
// 原来只认 Ctrl，理由是"鼠标无意中在她身上滚一下就变了大小"。这个担心是对的，
// 但正解不是"必须按 Ctrl"，而是"她周围那片透明区不该算数"：
// 窗口 404×469 里角色只有 188px 宽，两侧全是空气，而空气里的滚动本来就该落到
// 下面的窗口去（v3.5 的穿透已经做到了）。所以判据从"按没按 Ctrl"换成
// "光标是不是真在她身上"，误触概率比原来更低，顺手程度却是两回事。
let lastWheelAt = 0;
window.addEventListener('wheel', (e) => {
  // hitRegion 要 clientX/clientY —— WheelEvent 带这两个属性，与 click 同源。
  // 它声明在下面（函数声明会提升），拿的是 fBase 的实时矩形。
  if (!e.ctrlKey && !hitRegion(e)) return;
  e.preventDefault();
  // 节流：触控板的一"滑"会连发几十个 wheel 事件，不拦的话一滑直接从"极小"飞到"特大"。
  // 130ms 对人手滚轮完全无感（一格滚轮本来就是一次事件），只挡连发。
  const now = Date.now();
  if (now - lastWheelAt < 130) return;
  lastWheelAt = now;
  const i = SIZE_ORDER.indexOf(curScaleKey);
  const next = SIZE_ORDER[Math.min(SIZE_ORDER.length - 1, Math.max(0, i + (e.deltaY > 0 ? -1 : 1)))];
  if (next === curScaleKey) return;          // 已经在头/尾档，不重复写
  // 另外有个天然限流：主进程以「底边 + 水平中心」为锚改尺寸，所以缩放后
  // 鼠标常常已经不在她身上了，下一格滚轮自然就落空 —— 这是好事，不用管。
  window.pet.setSettings({ scale: next });   // 主进程改窗口 -> 回广播 'scale'
}, { passive: false });

// ---------- 连戳冷落（戳太多次她会真的不理你）----------
// 短时间戳太多次 -> 她转过头去，几秒内既不给反应也不给分。
//
// 和 mood（情绪值）不是一回事，别合并：
//   mood 是"脸色" —— 自己会回落到中性，只影响台词倾向与愿不愿意被摸头；
//   这个是**有时限的交互闸门** —— 这几秒里她"不在"。
// 为什么要有：原来连戳唯一的下场是把 mood 推到 angry，而 angry 只是"不给摸头"，
// 你照样能戳、她也照样回话。也就是说"烦她"这件事**没有代价** ——
// 而冷落正是现实里会发生的代价，也是这个角色最像她的地方（她本来就会不理人）。
const IGNORE_HITS = 6;         // 6 次
const IGNORE_WINDOW = 6000;    // 落在 6 秒内
const IGNORE_MS = 7000;        // 冷落 7 秒
let hitTimes = [], ignoring = false, ignoreTimer = null;

function noteHit() {
  const now = Date.now();
  hitTimes = hitTimes.filter((t) => now - t < IGNORE_WINDOW);   // 只留窗口内的那几次
  hitTimes.push(now);
  if (hitTimes.length >= IGNORE_HITS) startIgnore();
}

function startIgnore() {
  hitTimes = [];
  if (ignoring) return;
  ignoring = true;
  clearTimeout(ignoreTimer);
  ignoreTimer = setTimeout(() => { ignoring = false; ignoreTimer = null; }, IGNORE_MS);
  interruptChain();
  // 冷落**不重置姿态**：她正坐着就继续坐着背对你 —— 那比站起来更像"不理你"。
  anim('huff', 900);
  emote('💢');
  sfx('angry');
  quote(QUOTES.ignore);
  moodShift(-8);
}

// ---------- 部位识别 ----------
// "点了她"变成"碰了她身上哪里" —— 同一个人，摸头和拉裙摆的反应必须不一样，
// 否则"互动形式变多"就只是句空话。
//
// 判定靠**几何分带**，不是像素级 alpha 测试。这条是被 file:// 的沙箱规则挡回来的：
// 本来想把素材画到离屏 canvas 上读 alpha 拿精确轮廓，但 file:// 载入的图片
// 会把 canvas 标记成"受污染"，`getImageData` 直接抛 SecurityError（CSP 也拦）。
// 所以退到按包围盒的纵向分带 —— 够用，而且零成本。
//
// 分带边界按素材实测：maid.png 里虹膜在 y 36.8%~48.8%，腮红贴在颧骨（约 47%~48%），
// 所以"脸"那一带取 0.33~0.58 才能同时盖住眼睛和脸颊。
// 四套素材取景比例不同（见 README 已知限制），但头/身/裙的**相对**位置是一致的。
const REGIONS = [
  { key: 'head',  y0: 0.00, y1: 0.33 },
  { key: 'face',  y0: 0.33, y1: 0.58 },
  { key: 'body',  y0: 0.58, y1: 0.82 },
  { key: 'skirt', y0: 0.82, y1: 1.01 }
];

// 命中的是**角色实际占的那块矩形**，不是窗口矩形 ——
// 窗口比角色宽得多（水手服只有 188px 显示宽，窗口 404），两侧全是透明带。
//
// ⚠ 这段注释原来写着"透明带照样接住鼠标（本项目禁用了 setIgnoreMouseEvents）"，
//   那是 v3.5 之前的架构，早就不是事实了。判定本身却**一个都不能删**，
//   它现在管三件事：
//     · 穿透态是 120ms 一轮维护的，两个轮次之间窗口会短暂地整块接事件；
//     · 命中框比角色大一圈（下面留了 6% / 2% 的余量），框内依然有纯空气；
//     · v3.6 起滚轮缩放靠它决定"这一下算不算在她身上"。
//   所以点在空处仍然必须判成"没碰她"。
function hitRegion(e) {
  const b = fBase.getBoundingClientRect();
  if (!b.width || !b.height) return null;
  const mx = b.width * 0.06, my = b.height * 0.02;   // 留点余量，发梢边缘也点得中
  const px = (e.clientX - b.left - mx) / (b.width - mx * 2);
  const py = (e.clientY - b.top - my) / (b.height - my * 2);
  if (px < 0 || px > 1 || py < 0 || py > 1) return null;
  const band = REGIONS.find((r) => py >= r.y0 && py < r.y1) || REGIONS[REGIONS.length - 1];
  return band.key;
}

// 各区反应。语气沿"头顶 → 脸 → 身体 → 裙摆"一路收紧，
// 这条滑道本身就是可见的养成内容 —— 关系好时连裙摆她都会忍着不说。
//
// ★ v3.6 把它拆成「立刻」和「确认」两半，为的是消掉单击那 250ms 的迟滞。
//
// 原来的写法是"单击 -> 等 250ms 看有没有第二下 -> 才做反应"，
// 于是你戳她一下，她要愣四分之一秒才动 —— 250ms 是手指明确能感觉到的长度。
// 双击判定本身不能取消（取消了就没法区分单双击），所以改成把反应切成两半：
//   regionTouch    点击**当场**就出：动作、表情、音效
//   regionConfirm  250ms 后确认是单击了，再补：台词、情绪、羁绊
// 于是手感是即时的，而"她说了什么"仍然等确认 —— 说话本来就允许慢半拍。
//
// 数值（mood / gain）统统放在 confirm 那一半，为了**双击不重复结算**：
// 双击会把 confirm 的定时器清掉，所以不会出现"点两下算了三下的账"。
function regionTouch(region) {
  // 生气时摸头会被甩开。给了"情绪"就得让它在交互上真的挡一下路 ——
  // 而且这一下**必须**在 touch 里：它是"她在拒绝你"，延迟 250ms 就变成迟钝了。
  if (region === 'head' && !canPamper()) {
    anim('shake', 500);
    emote('💢');
    sfx('angry');
    return;
  }
  switch (region) {
    case 'head':
      anim('nod', 900);
      particles(['💗', '♡', '✨'], 5);
      sfx('pat');
      blush();
      emote('💗');
      break;
    case 'face':
      anim('bounce', 560);
      blush();
      emote(rand(['💗', '😳', '❗']));
      sfx('click');
      break;
    case 'body':
      anim('recoil', 520);
      emote('…');
      sfx('question');
      break;
    default:                       // skirt
      anim('huff', 700);
      emote('💢');
      sfx('angry');
      break;
  }
}

function regionConfirm(region) {
  if (region === 'head' && !canPamper()) {
    quote(QUOTES.mood.angry, 2200);
    return;                        // 生气时摸头：给她那句台词，但不加情绪、不加分
  }
  quote(QUOTES.region[region] || QUOTES.click);
  switch (region) {
    case 'head':  gain('pat');   moodShift(6);   break;
    case 'face':  gain('click'); moodShift(2);   break;
    case 'body':  gain('click'); moodShift(-6);  break;
    default:      gain('click'); moodShift(-18); break;
  }
}

// 验收专用：把两半**按真实顺序**走完，供 preview.html 一次点击看全效果。
// 真机上这两半是被 click 的两条分支分开调的（中间隔着 CLICK_CONFIRM_MS），
// 这里同步连着调只是为了单点触发方便 —— 别拿它当"真机节奏"的证据。
function regionReact(region) {
  regionTouch(region);
  regionConfirm(region);
}

// ---------- 点击 / 双击 ----------
// CLICK_CONFIRM_MS 是"这两下算一次还是两次"的判定窗口。
// ⚠ 手感**不靠**缩短它来解决 —— 缩短会让双击变得更难打中，
//   而"反应慢半拍"这件事已经由 regionTouch 提前到点击当下了（见那边的说明）。
const CLICK_CONFIRM_MS = 250;
let clickCount = 0, clickTimer = null;
wrap.addEventListener('click', (e) => {
  const region = hitRegion(e);
  if (!region) return;                  // 点了透明处 —— 不算碰她，也不涨分
  lastInteract = Date.now();
  interruptChain();                     // 你一碰她，她自己那条链就该停
  // 收边（迷你态）下点她 = "叫她出来"。放在最前面：她在屏幕边只露半个身子时，
  // 这一下首先是"我要她恢复"，其次才谈得上互动。
  if (edgeReq) reqEdge(null);
  // 正在醒：这一下用来"催她清醒"，不当作互动本身（见 finishWake 的说明）。
  // 必须排在 wakeUp 之前 —— wakeUp 在 waking 期间返回 false，
  // 落到下面就会被当成一次普通点击，于是"戳一下"变成"戳 + 跳 + 她抗议"。
  if (waking) { finishWake(false); return; }
  if (wakeUp()) return;
  // 冷落期内：给一个"别过头"的轻反馈，但不给反应、不给分、也不计数。
  // 必须有这个反馈 —— 什么都不做的话看起来就像"点坏了"。
  if (ignoring) { anim('shake', 420); return; }
  noteHit();                            // 记一次戳；够多次就进入冷落
  clickCount++;
  if (clickCount === 1) {
    regionTouch(region);                // ★ 立即反馈：动作 / 表情 / 音效
    // 部位在**这一刻**就定下来存进闭包。原来这里 250ms 后重新 hitRegion(e) 算一次，
    // 那时鼠标可能已经挪到别处了 —— 摸头摸出个"拉裙摆"的反应。
    clickTimer = setTimeout(() => {
      clickCount = 0;
      regionConfirm(region);            // 250ms 后确认是单击，补台词与数值
    }, CLICK_CONFIRM_MS);
  } else {
    clearTimeout(clickTimer);
    clickCount = 0;
    // 双击：单击那半已经出过动作 / 音效 / 表情了，这里只追加"跳"。
    // 不重复 gain('click') / moodShift —— 那些在 regionConfirm 里，已被 clearTimeout 拦住。
    anim('jump', 720);
    quote(QUOTES.doubleClick);
    particles(['💗', '✨', '💕'], 5);
    blush();
    gain('dblclick');
    moodShift(4);
  }
});

// ---------- 目光跟随（全局光标）+ 摸头 ----------
// 目光跟随的数据来自**主进程**（screen.getCursorScreenPoint，120ms 一次），
// 不再是窗口内的 mousemove —— 因为鼠标一离开窗口她就看不见你了，
// 而"她在看你操作"这件事恰恰发生在鼠标**不在**她身上的时候。
// 渲染层只把它变成一个 transform，不碰坐标（和"所有位置交互走主进程"是同一条原则）。
//
// 幅度：横 ±9px / 纵 ±5px。大了就变成"人物在飘"而不是"转头看你"；
// 配合 #lookWrap 上的 .3s 缓动才像有意识地在看。主进程那边已经按距离归一化并夹到 ±1，
// 所以屏幕角落的鼠标不会让她把脸拧过头。
let cursor = { nx: 0, ny: 0, dist: 9999, inside: false, x: 0, y: 0 };
let lastLook = null;
function lookAtCursor() {
  // 拖动 / 投掷中不做目光跟随：那时整层在跟着手走，再叠一个偏移会晃得难受
  if (dragging || state.mode === 'throw') return;
  const t = 'translate(' + (cursor.nx * 9).toFixed(1) + 'px,' + (cursor.ny * 5).toFixed(1) + 'px)';
  // 写入值没变就不写。主进程 120ms 推一次，而光标常常只挪了一两个像素 ——
  // 每次都写一遍会**不停重启** #lookWrap 上那条 .3s 的过渡（transition 被打断
  // 就从头开始算），于是缓动永远停在头一小段，"转头看你"反而糊成一团。
  // 这里要守的只有一件事：同一个目标值不重复写。
  if (t === lastLook) return;
  lastLook = t;
  lookWrap.style.transform = t;
}
function lookAway() { lookWrap.style.transform = ''; lastLook = null; }
window.pet.onCursor((c) => { if (c) { cursor = c; lookAtCursor(); } });

// 摸头：鼠标**停在她头上**一会儿才触发，路过不算。
// 这条仍然用窗口内的 mousemove ——"停住"这件事只有本地事件流判断得准，
// 120ms 的轮询看不出一秒内有没有微动。
let patTimer = null;
wrap.addEventListener('mousemove', (e) => {
  const r = wrap.getBoundingClientRect();
  const inHead = (e.clientY - r.top) < r.height * 0.32;
  const hx = r.width ? (e.clientX - r.left) / r.width : 0.5;
  // 横向也要判：窗口比角色宽得多，两侧是透明带，在空气里停一秒不该算摸头
  if (inHead && hx > 0.2 && hx < 0.8) {
    if (!patTimer) {
      patTimer = setTimeout(() => {
        patTimer = null;
        lastInteract = Date.now();
        interruptChain();            // 摸头也算"你在跟她说话"，她自己那条链该停
        if (!canPamper()) {          // 生气时被摸头会被甩开
          anim('shake', 500);
          emote('💢');
          sfx('angry');
          return;
        }
        particles(['💗', '♡', '✨'], 5);
        quote(QUOTES.pat);
        anim('nod', 900);
        // 摸头是全项目唯一的"亲昵级"交互，给她一个调皮的单眼眨眼。
        // 双击和情绪转好仍然用默认笑眼 —— 三处都不一样才有区分度，
        // 全给眨眼会让眨眼从"调皮"贬值成"又一个开心"。
        blush('wink');
        sfx('pat');
        gain('pat');
        moodShift(5);
      }, 1100);
    }
  } else {
    if (patTimer) {
      clearTimeout(patTimer);
      patTimer = null;
    }
    // 不在头顶 -> 看看是不是停在她**身上**（见下面的 stareCheck）。
    stareCheck(e);
  }
});

// 被盯着看：鼠标停在她身上（不是头顶）超过两秒，她会回看你一眼 / 有点不自在。
// 以前只有"停在头顶"算数（那是摸头），停在别处什么都不发生 ——
// 像对着一张不会注意到你的图片。这条补的是"她感觉得到你在看她"。
//
// 三条防打扰，缺一条都会让它变成负担：
//   · 只在她**空闲**时触发（正做自己的事、走动、番茄钟里都不插嘴）
//   · 30 秒冷却 —— 鼠标停在她身上其实是常态，没冷却会不停触发
//   · 生气时不触发（那时她本来就别着脸）
// 时间阈值（2s）和摸头（1.1s）不同，是有意的：摸头是"你明确在摸她"，
// 这个只是"你的视线停在她身上"，门槛该高一截。
const STARE_MS = 2000, STARE_CD = 30000;
let stareTimer = null, lastStare = 0;
function clearStare() { if (stareTimer) { clearTimeout(stareTimer); stareTimer = null; } }
function stareCheck(e) {
  const region = hitRegion(e);
  const onHerself = region === 'face' || region === 'body';
  if (!onHerself) { clearStare(); return; }
  if (stareTimer) return;
  stareTimer = setTimeout(() => { stareTimer = null; doStare(); }, STARE_MS);
}

// 抽成具名函数是为了 preview.html 能直接调它 —— 验收必须走**同一段**逻辑。
// ★ 它自带全部闸门（模式 / 睡着 / 迷糊 / 勿扰 / 冷落 / 生气 / 30 秒冷却），
//   所以在浏览器里调用后"什么都没发生"不一定是接线断了，也可能只是闸门没过去。
//   返回值就是给这条用的：false = 被闸门挡下，true = 真的触发了。
function doStare() {
  if (state.mode !== 'idle' || sleeping || waking || quiet || ignoring) return false;
  if (moodBand === 'angry') return false;
  if (Date.now() - lastStare < STARE_CD) return false;
  lastStare = Date.now();
  lastInteract = Date.now();
  interruptChain();
  quote(QUOTES.stare);
  emote('👀');
  sfx('question');
  moodShift(1);
  gain('click');
  return true;
}

wrap.addEventListener('mouseleave', () => {
  if (patTimer) { clearTimeout(patTimer); patTimer = null; }
  clearStare();
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
  interruptChain();                 // 要开菜单了，先把她的独角戏收掉
  window.pet.showMenu();
});

// 走动两帧的当前可见度（0~1）。给无头验收读 —— 见 getState 里的说明。
function hemOpacity(id) {
  const el = document.getElementById(id);
  if (!el || !el.naturalWidth) return null;      // 没有这一层：报 null，不是报 0
  return Math.round(parseFloat(getComputedStyle(el).opacity) * 100) / 100;
}

// ---------- 走动 ----------
// v3.4 起 walk 接受参数：`walk({ x, line })`。
// 带了 x 就是"主动靠近"（走向光标所在的横坐标），不带就是原来那种随机散步。
// 两件事共用同一套位移逻辑 —— 不另写一份"走过去"的代码，
// 否则落地高度、朝向翻转、位置记忆这些细节迟早会两边不一致。
// 最近一次走动的起终目标。只给验收读，不参与任何逻辑。
let lastWalk = null;
// 最近一次投掷的边界计划。同样只给验收读。
let lastThrow = null;
async function walk(opts) {
  if (state.mode !== 'idle') return;
  const o = opts || {};
  state.mode = 'walk';
  wakeUp();
  quote(o.line || QUOTES.walk);
  const area = await window.pet.getWorkArea();
  const b = await window.pet.getBounds();
  if (!b) { state.mode = 'idle'; setPose('breathe'); return; }

  const y = groundY(area);
  let x = b.x;
  // 用 getBounds() 的实际宽度，不用常量 —— 缩放后窗口宽度是变的
  let goal;
  if (typeof o.x === 'number') {
    goal = Math.round(o.x - b.width / 2);        // 让窗口中心落到光标那一带
  } else {
    const dir0 = Math.random() < .5 ? -1 : 1;
    goal = x + dir0 * (140 + Math.random() * 320);
  }
  goal = Math.min(Math.max(goal, area.x), area.x + area.width - b.width);
  const dir = goal >= x ? 1 : -1;
  // 速度按距离分档（v3.11）：近处散步、远处赶路。
  // 不是为了好看 —— "步频跟着速度走"这条机制需要一个**真的会变**的速度，
  // 否则按它算出来的步周期永远等于同一个数，那就是一段死代码。
  const span = Math.abs(goal - x);
  const speed = span > 520 ? 3.4 : 2.6;
  // 步长固定 ⇒ 速度越快、一步用时越短。62px 是让她在 400 CSS px 的显示高度下
  // 每步大约走自身高度的 1/6 —— 再长看着像跨栏，再短就是原地踏步。
  // 这个数只在这里算，CSS 那边只管读 —— 步态表现与移动积分就不会各说各话。
  const STEP_PX = 62;
  // ★ 下面两行的**顺序不能反**（自检第 27 节会断言）。
  //   anim() 里有一句强制重排（`void wrap.offsetWidth`），动画因此从第 0 相位重新开始；
  //   而写 `--step-ms` 只改 duration、不重启动画 —— 相位的分母一变，当前进度就**跳**：
  //   默认 420ms 换成赶路档的 305ms 时，读作 p 的进度瞬间变成 1.38p，
  //   最多跳掉 38% 个循环。表现是"一开始走就抖一下"，而且只在远处档才明显。
  const stepMs = Math.round(STEP_PX / speed * 16.7) + 'ms';
  wrap.style.setProperty('--step-ms', stepMs);
  anim('walk');
  const frames = span / speed;
  // 记一下这一趟的起终目标，供无头验收读。
  // 为什么要这个：走动位移是 rAF 驱动的，而无头模式下 rAF 几乎不触发
  // （见 throwphysics.js 的说明），所以"她到底有没有朝光标走过去"在浏览器里
  // 只能验到**决策**这一层 —— 目标算得对不对。积分本身由第 12 节的自检保证。
  lastWalk = { from: Math.round(b.x), goal: Math.round(goal), dir: dir, at: Date.now() };
  // 翻转写在 #spriteWrap（容器）上，不是 #fBase 上 ——
  // 图层是 #fBase 的兄弟节点，写在 #fBase 上眼睛不会跟着翻。
  spriteWrap.style.transform = 'scaleX(' + (dir < 0 ? -1 : 1) + ')';

  const step = () => {
    if (state.mode !== 'walk') return;
    if (Math.abs(x - goal) < 3) { x = goal; endWalk(); return; }
    x += dir * speed;
    // 窗口移动降频到约 30Hz。走一步是 2.6px，合并两帧变成 5.2px 一跳 ——
    // 挂在呼吸动画和 2.6px 的步进上，肉眼看不出差别；而每帧一次 setPosition
    // 是原生调用，在 Windows 上会牵动 DWM 重排透明层，60Hz 纯属浪费。
    // ★ 投掷**不**降频：它的落点靠逐帧积分决定，而且整个飞行只有一两秒。
    if ((walkFrames++ & 1) === 0) window.pet.moveTo(x, y);
    requestAnimationFrame(step);
  };
  let walkFrames = 0;
  step();
  // 超时按**实际距离**算（帧数 × 16.7ms）再留一倍余量。
  // 原来写死 5200ms：屏幕很宽时她走一半就被叫停，看着像卡住了。
  setTimeout(() => { if (state.mode === 'walk') endWalk(); }, Math.min(12000, frames * 17 * 2 + 800));

  function endWalk() {
    // 落一次精确位置。降频之后最后一帧可能还没提交（步进是 2 帧一次），
    // 少这一下的话她每次散步都会停在离目标 2~5px 的地方 —— 看不出来，
    // 但 savePos 存下去的坐标和"她看起来站的位置"会差一点，累积几次就歪了。
    window.pet.moveTo(Math.round(x), y);
    state.mode = 'idle';
    ANIMS.forEach((c) => wrap.classList.remove(c));
    spriteWrap.style.transform = '';
    setPose('breathe');
    // 走完也记一下位置：不然她走到屏幕另一头，重启后又回原处
    window.pet.getBounds().then((nb) => { if (nb) window.pet.savePos(nb.x, nb.y); });
    gain('walk');
  }
}

// ---------- 主动靠近 ----------
// 久无互动、而且你的鼠标在别处时，她自己走过去看看。
// 这是"她也在过日子"最直接的一条 —— 原来她只会在原地等你点。
// 四个前提缺一不可，而且每一条都是"不加就会显得很烦"的那种：
//   · 鼠标就在旁边（<340px）-> 不用挪，凑过去像在挤你
//   · 正在生气 -> 不理你
//   · 你 45 秒内动过 -> 别打断（这时她该做的是一起待着，不是走过来）
//   · 三分钟内已经靠近过一次 -> 频率上限
let lastApproach = 0;
// 返回**有没有真的走过去**。行为链要靠这个返回值决定"这一拍算不算数"：
// 返 false 时链会换一拍而不是白白占用时间（前提不满足是常态，不是异常）。
function idleApproach() {
  const now = Date.now();
  // 安静档：不走过去。她"走过来看你"本身就是最明显的打扰 ——
  // 比说一句话扰人得多（那会动窗口、直接进了你的视野）。
  if (!talkOK()) return false;
  // 判"有没有光标数据"只能看 dist，不能看 x —— 光标贴在屏幕最左边时 x 正好是 0，
  // 而 0 是 falsy，`!cursor.x` 会把"光标在左边缘"误判成"没有光标数据"。
  if (cursor.dist > 9000 || cursor.dist < 340) return false;
  if (moodBand === 'angry') return false;
  if (now - lastInteract < 45 * 1000) return false;
  if (now - lastApproach < 3 * 60 * 1000) return false;
  lastApproach = now;
  walk({ x: cursor.x, line: QUOTES.approach });
  return true;
}

// ---------- 打字反应（可选功能 · 默认关）----------
// 主进程挂全局键盘钩子，每 120ms 最多推一次 `{ rate }`（rate = 这一秒敲了多少下）。
// 渲染层只做三件事：出一声轻响、偶尔一个小动效、节奏太快时说一句。
//
// 三个节流是必须的，不是保守 —— 这些事件一秒来 8 次，不加节流她会变成噪音机器。
// 阈值都是"手感值"：改之前想清楚"一秒 8 次已经很密了"。
const TYPE_SFX_MS = 130;      // 打字音最多约 8 次/秒
const TYPE_TAP_MS = 380;      // 小动效最多约 2.6 次/秒（再快就像抽搐）
const TYPE_FAST = 5;          // 一秒 5 下以上算"敲得猛"
const TYPE_LONG_MS = 150000;  // 陪了 2.5 分钟以上才算"陪你熬了一段"
const TYPE_CASUAL_MS = 100000;// 正常节奏随口搭话的下限（约 1.7 分钟一次机会、命中率 0.22）
let lastTypeSfx = 0, lastTypeTap = 0, lastTypeLine = 0, fastStreak = 0;

window.pet.onTyping((t) => handleTyping(t));

// 抽成具名函数是为了 preview.html 能直接调它 —— 验收必须走**同一段**逻辑，
// 另写一段演示等于没验。真机里它只被上面的 IPC 回调调用。
function handleTyping(t) {
  if (!t || !t.rate) return;
  if (quiet) return;                 // 勿扰里她"出去了"，不该还在听你打字
  const now = Date.now();
  lastInteract = now;                // 打字也算"你在" —— 否则她会当你不在家而睡着

  if (now - lastTypeSfx > TYPE_SFX_MS) { lastTypeSfx = now; sfx('type'); }
  if (now - lastTypeTap > TYPE_TAP_MS && state.mode === 'idle' && !sleeping) {
    lastTypeTap = now;
    // 你开始敲键盘了 —— 她自己那条链该停。打字期间她的位置是"在旁边陪着你"，
    // 不该同时还在看书/看窗外；何况 anim() 会清掉链那一拍的动画，链却不知道，
    // 会照原计划继续往下走（"你敲着键盘，她一声不响地又打了个哈欠"）。
    interruptChain();
    anim('tap', 200);
  }
  // 安静档：打字音与那个轻轻起伏都留着（那是"她在旁边"的存在感，不算说话），
  // 但**一句台词都不说** —— 你正打着字被搭话，是最典型的那种"被打扰"。
  if (!talkOK()) return;
  // "敲得猛"看的是**持续**，不是单帧尖峰 —— 敲一个回车不该触发。
  // 所以用连续计数：达标 +1，不达标 -1，攒到 6 才算数（约等于连续 3~5 秒在猛敲）。
  if (t.rate >= TYPE_FAST) fastStreak++; else fastStreak = Math.max(0, fastStreak - 1);
  if (fastStreak >= 6 && now - lastTypeLine > 45000) {
    fastStreak = 0;
    lastTypeLine = now;
    quote(QUOTES.typeFast, 2600);
    emote('💦');
  } else if (now - lastTypeLine > TYPE_LONG_MS && Math.random() < 0.3) {
    // 陪着敲了很久（>= 2.5 分钟）—— 语气是"我在旁边坐了一阵了"，
    // 用的是 typeLong 那一组。**不是** type：那组是"随口看一眼"的语气，
    // 放在"陪你熬了一段"这个位置上会把关系说浅。
    lastTypeLine = now;
    quote(QUOTES.typeLong, 2600);
  } else if (now - lastTypeLine > TYPE_CASUAL_MS && Math.random() < 0.22) {
    // 正常节奏下偶尔搭一句。QUOTES.type 原本没有任何引用路径 ——
    // 加上这条它才有出口，而概率和冷却都压得很低（约 8 分钟一句），
    // 免得她变成"你每敲几下就插话"的东西。
    lastTypeLine = now;
    quote(QUOTES.type, 2600);
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
  interruptChain();                // 面板要出来了，别让她的独角戏在面板底下接着演
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
  eyeForced = null; applyEyeLayer();     // 开番茄钟是"叫醒她"的一种，眼睛要跟着放开
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
    sfx('pomdone');
  } else {
    quote(QUOTES.pomAbandon, pom.name);
    emote('💧');
  }
  // 番茄钟在计分表里权重最高（完成 +10）：它是唯一"真的陪了你半小时"的互动，
  // 而点一下只值 1 分。养成要奖励的是陪伴，不是手速。
  gain(completed ? 'pomDone' : 'pomAbandon');
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
  // 键盘反应的开关反馈。这一条必须说明"我在听什么" ——
  // 全局键盘监听是需要用户知情的东西，光给个勾选框不够。
  if (a === 'typing-on') { quote(QUOTES.typingOn, 3400); emote('👂'); }
  if (a === 'typing-off') { emote('💤'); }
});

// ---------- 久别重逢 ----------
// 她独处了多久 -> 第一句说什么。分档建在主进程算好的**差值**上
// （它只回 awayMs，不回时间戳），所以这里不需要任何"现在几点"的知识。
//
// 半小时以内不算久别：重启一次电脑、清一次缓存都落在这一档，
// 那时她要是说"你终于来了"，只会让这套东西显得很廉价。
const AWAY_MIN = 30 * 60 * 1000;
const AWAY_HOUR = 60 * 60 * 1000;
const AWAY_DAY = 24 * AWAY_HOUR;
function awayLine(awayMs) {
  const d = Number(awayMs) || 0;
  if (d < AWAY_MIN) return null;              // 含首次运行 / 清过配置（awayMs 为 0）
  if (d < AWAY_HOUR) return QUOTES.away.short;
  if (d < AWAY_DAY) return QUOTES.away.hours;
  if (d < 3 * AWAY_DAY) return QUOTES.away.day;
  return QUOTES.away.long;
}

// ---------- 打扰等级的变化 ----------
// 只改这一个字就够了：所有判据（talkOK / chainEntry / chainGap）都是**现算**的，
// 没有任何"按档位预先算好、存起来"的东西需要在这里重新应用。
// 少一份派生状态就少一处能和事实漂开的地方。
window.pet.onChatter((k) => {
  chatter = ['quiet', 'normal', 'lively'].indexOf(k) >= 0 ? k : 'normal';
});

// ---------- 时间感知（v3.12）----------
// 她开始"看表"了。四件事，全部只用本地时钟：零依赖、零网络。
//   ① 时段问候 —— 原来只有 night / morning / greeting 三档（下午三点和晚上十点
//      共用同一句）；现在细分成六段，因为她是个连红茶都要趁热喝的人。
//   ② 整点报时 —— 每小时**最多**一次，且要她自己闲着、你没刚碰过她。
//   ③ 陪你第 N 天 —— 只有里程碑那天说一句（天数靠主进程的 firstRunAt）。
//   ④ 深夜更容易困 —— 这个点她本来就该打哈欠。
//
// ⚠ 别把它做成"每小时必响"的闹钟：桌宠最怕变成一个有存在感的提醒工具。
//   所以下面每一条都带闸门（勿扰 / 安静档 / 她自己正忙 / 你刚互动过就不说）。
let firstRunAt = 0;                        // 启动时从 settings 读，见文件末尾的启动 IIFE
const DAYPARTS = [[5, 'dawn'], [8, 'morning'], [11, 'noon'], [14, 'afternoon'], [18, 'evening'], [23, 'lateNight']];
// 六段：5~8 清晨 / 8~11 上午 / 11~14 中午 / 14~18 下午 / 18~23 晚上 / 23~5 深夜。
// 0~4 点落进 lateNight —— 它比 5 小，循环里不会被任何一段覆盖，所以初值就是它。
function daypartOf(h) {
  let cur = 'lateNight';
  for (const [from, name] of DAYPARTS) if (h >= from) cur = name;
  return cur;
}
const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
function cnHour(h) {                       // 14 → 十四点，20 → 二十点，0 → 零点
  if (h === 0) return '零点';
  if (h <= 10) return CN_NUM[h] + '点';
  if (h < 20) return '十' + CN_NUM[h - 10] + '点';
  if (h === 20) return '二十点';
  return '二十' + CN_NUM[h - 20] + '点';
}
// 主动开口的统一闸门。四条缺一不可，理由见上面那段"别做成闹钟"。
const canSpeakNow = () =>
  !quiet && !sleeping && state.mode === 'idle' && talkOK() && Date.now() - lastInteract > 30000;

// 整点报时。每 30 秒看一眼 —— 只认"整点那一分钟"，同一个小时只报一次。
// 深夜照报（"……两点了"正是她该说的话），只是概率压得更低。
let lastChimeHour = -1;
setInterval(() => {
  const now = new Date();
  const h = now.getHours();
  if (now.getMinutes() !== 0) return;
  if (h === lastChimeHour) return;       // 这一小时已经响过（也可能是被闸门挡下的那次）
  lastChimeHour = h;
  if (!canSpeakNow()) return;
  if (Math.random() > (daypartOf(h) === 'lateNight' ? 0.5 : 0.35)) return;
  quote(QUOTES.chime, { h: cnHour(h) });
}, 30 * 1000);

// 深夜更容易困：每分钟掷一次，命中就打哈欠（平均约 8 分钟一次）。
// 直接调 ACT.yawn 而**不走行为链**：链是"她自己在一件事里连做几拍"，
// 而困是身体反应 —— 插进链中间会打乱那一拍的节奏。
setInterval(() => {
  if (daypartOf(new Date().getHours()) !== 'lateNight') return;
  if (!canSpeakNow()) return;
  if (Math.random() > 0.12) return;
  ACT.yawn.run();
}, 60 * 1000);

// 陪你第 N 天。**按天数做键**（与 bond / levelUp 同一个模式），只有里程碑那天会说。
// "今天已经问候过"记在 localStorage：这是纯渲染层的状态（"这一档今天响过没有"），
// 不值得为它加一条 IPC。取不到就一直问候 —— 反正只有里程碑那天才有话说。
const DAY_MILESTONES = Object.keys(QUOTES.dayN).map(Number);
function dayNLine() {
  if (!firstRunAt) return null;
  const n = Math.floor((Date.now() - firstRunAt) / 86400000) + 1;   // 头一天就是第 1 天
  const KEY = 'yukino.dayGreeted';
  let last = 0;
  try { last = Number(localStorage.getItem(KEY)) || 0; } catch (e) { /* 忽略 */ }
  if (last === n) return null;                                       // 今天已经打过招呼
  try { localStorage.setItem(KEY, String(n)); } catch (e) { /* 忽略 */ }
  if (DAY_MILESTONES.indexOf(n) < 0) return null;
  return pick(QUOTES.dayN[n]);
}

// ---------- 前台应用（环境感知，v3.12）----------
// 主进程 1s 盯一次前台窗口，**只在场景变了**时推一条过来。
// 这里只做一件事：把"她注意到你在干什么"变成一句台词 —— 而且是**低频**的。
// ★ 刻意不让她改变姿态：行为链（v3.6）已经在管她自己的节奏，再按应用插一脚，
//   两个调度器会互相打断。这一版只影响"说不说、说什么"。
const SCENE_KEYS = Object.keys(QUOTES.scene);
const SCENE_GAP = 8 * 60 * 1000;           // 同一次陪聊至少隔 8 分钟
let sceneNow = 'other';
let lastSceneSay = 0;
window.pet.onScene((s) => {
  if (!s || !s.scene) return;
  sceneNow = SCENE_KEYS.indexOf(s.scene) >= 0 ? s.scene : 'other';
  const lines = QUOTES.scene[sceneNow];
  if (!lines || !lines.length) return;     // desktop 故意留空：回到常态不必开口
  if (Date.now() - lastSceneSay < SCENE_GAP) return;
  if (!canSpeakNow()) return;
  lastSceneSay = Date.now();
  quote(lines);
});

// ---------- 启动 ----------
(async () => {
  const s = await window.pet.getSettings();
  if (s.scale) curScaleKey = s.scale;
  sfxEnabled = s.sfx !== false;              // 缺省视为开（见主进程的 sfxOn）
  // "陪你第 N 天"的起点（主进程第一次运行那天写下的时间戳）。
  // 老存档没有这个字段 -> 0 -> dayNLine 直接返回 null，不会说错话。
  firstRunAt = Number(s.firstRunAt) || 0;
  quiet = Number(s.quietUntil) > Date.now(); // 启动时若还在勿扰时段，保持安静
  // 打扰等级：只认三个合法值，别的（老存档 / 手改坏了）一律退回默认的"适中"。
  chatter = ['quiet', 'normal', 'lively'].indexOf(s.chatter) >= 0 ? s.chatter : 'normal';
  // 启动就在勿扰里（比如"到明天早上 8 点"之后被开机自启拉起来）：
  // 直接冻住，别等到 onQuiet 那条消息 —— 那条在窗口从没显示过时根本不会来。
  if (quiet) setFrozen(true);
  // 你在不在：主进程的 activity 广播是**状态变化才发**的，而开机自启那一刻
  // 状态本来就可能已经是"你不在"。不主动问一次的话，她会在你人不在的时候
  // 先当你回来了（问一句好、然后才睡），健康提醒也会白跑一段。
  try {
    const ia = await window.pet.getIdle();
    if (ia) userActive = !!ia.active;
  } catch (e) { /* 拿不到就按"你在" */ }

  // 羁绊等级要先拿到：idleLines() 靠它决定解锁了哪些自言自语。
  try {
    const b = await window.pet.getBond();
    if (b) { lastBond = b; bondLevel = b.level; }
  } catch (e) { /* 拿不到就按 Lv.1 */ }

  applyOutfit(s.outfit || 'maid', true);   // 首次不做淡入，别让开场白先于人出现
  setPose('breathe');
  // 先报一次可交互区。此刻素材通常还没解码完，报出去的是"整个角色区"（偏保守，
  // 也就是她会多接一会儿鼠标事件）—— fBase 的 load 一到就会收紧成真实轮廓。
  // 反过来（先不报）的话，那一段时间 hitArea 为 null = 整窗穿透，
  // 她刚出现的那半秒是点不到的。
  reportHitArea();
  // 自动眨眼从这里起跳。
  // 放在启动 IIFE 的末尾而不是模块顶层：它要读 sleeping / quiet / state.mode，
  // 而这些在顶层执行的时刻还没就位（sleeping 是下面才声明的 let）——
  // 顶层起跳会撞上 TDZ，而且是"启动即抛异常、整个脚本一行不生效"的那种。
  scheduleBlink();
  const h = new Date().getHours();
  setTimeout(async () => {
    if (quiet) return;                     // 勿扰中，别对着一个看不见的窗口说话
    // 久别重逢**优先于**时段问候。两个都是"她见到你的第一句"，只能出一个，
    // 而"你终于来了"承载的信息比"早安"多得多 —— 隔了三天回来先听到一句"早安"，
    // 那三天就白隔了。
    let line = null;
    try {
      const p = await window.pet.getAway();
      line = awayLine(p && p.awayMs);
    } catch (e) { /* 拿不到就当没离开过，走普通问候 */ }
    // 优先级：久别重逢 > 陪你第 N 天（里程碑）> 时段问候。
    // 三个都是"她见到你的第一句"，一次只能出一个 ——
    // 而"你终于来了"承载的信息最多，排最前；里程碑次之（一年也就几次）。
    if (line) quote(line);
    else {
      const dn = dayNLine();
      if (dn) quote([dn]);
      else quote(QUOTES.daypart[daypartOf(h)] || QUOTES.greeting);
    }
  }, 700);
})();

// ---------- 心跳（主进程靠它判断渲染层是否假死） ----------
// ⚠ 只在窗口**可见**的时候跳，而且主进程那边的看门狗也**同步**加了
// "不可见就不判假死"的闸门（见 main.js）。两处必须成对改：
// 只改这一边的话，主进程会把"她藏起来了"误判成"渲染层假死"，
// 于是勿扰期间每 35 秒重载她一次 —— 而这一档可以是"到明天早上 8 点"。
//
// ⚠⚠ `document.hidden` 这一支在真机上**永远不成立**（backgroundThrottling: false
//    会让 Page Visibility API 一直报"可见"，实测），所以真正生效的闸门是 `quiet`。
//    两个都留着：一个对应"窗口被藏"，一个对应"她被冻住"，哪个先到算哪个。
let hbTimer = null;
function syncHeartbeat() {
  const want = !document.hidden && !quiet;
  if (want && !hbTimer) hbTimer = setInterval(() => window.pet.heartbeat(), 5000);
  else if (!want && hbTimer) { clearInterval(hbTimer); hbTimer = null; }
}
document.addEventListener('visibilitychange', syncHeartbeat);
syncHeartbeat();

// ---------- 调试出口 ----------
// 只给 renderer/preview.html 用（它会在加载本文件前设置 window.__PET_DEBUG__ = true）。
// 真机上这个开关永远是 undefined，所以这些内部函数不会泄露到 window 上，
// 免得渲染层多出一堆可被外部脚本乱调的全局入口。
if (window.__PET_DEBUG__) {
  window.__petDemo = {
    blush, anim, emote, particles, quote,
    walk, openPomodoro, applyOutfit,
    lookAtCursor, lookAway,
    // 点击穿透的验收出口。hitBox 是**真的报出去的那个框**（不是另算一遍），
    // preview.html 拿它画一个虚线框 —— 于是"可交互区到底是整窗还是角色轮廓"
    // 这件事从"读一段坐标"变成"看一眼框"。
    reportHitArea,
    getHitBox: () => hitBox,
    overSelf: () => overSelf,
    // 验收"边缘吸附"用：把角色放到指定 x，然后走一遍真实的松手收尾
    // （scrub -> snapX -> settle），不是另写一段演示逻辑。
    dropAt(px, py) {
      return Promise.all([window.pet.getWorkArea(), window.pet.getBounds()]).then(([area, b]) => {
        if (!b) return null;
        const sw = spriteW();
        const snap = snapX(px, area, b.width, sw);
        const ty = groundY(area);
        settle(snap.x, (py === undefined ? ty : py), snap.x, ty, snap.edge);
        return { dropped: px, snapped: snap.x, edge: snap.edge, sw: Math.round(sw) };
      });
    },
    // v3.4 的验收出口 —— 五项新交互在浏览器里都要能单独触发。
    // 这些走的都是**和真机同一个函数**（regionReact / throwIt / 打字处理里的那段逻辑
    // 被抽成 handleTyping 才可能这样测），不是另写一段演示。
    region: (k) => regionReact(k || 'head'),
    hitAt: (cx, cy) => hitRegion({ clientX: cx, clientY: cy }),
    throwAt: (vx, vy) => throwIt({ vx: vx === undefined ? 22 : vx, vy: vy === undefined ? -18 : vy }),
    // 模拟主进程推来的光标方位。
    // 第 4 个参数是光标的**屏幕 x** —— 真机里主进程给的就是绝对坐标，
    // 而 idleApproach 要靠它决定"往哪边走"。预览里没有真实光标，
    // 由调用方按当前虚拟窗口位置反算一个传进来（见 preview.html 的 cursorScreenX）。
    // 不给的话 x = 0，那"走过去"就永远朝着屏幕左上角走。
    setCursor(nx, ny, dist, screenX) {
      cursor = { nx: nx || 0, ny: ny || 0, dist: dist === undefined ? 400 : dist,
                 x: screenX === undefined ? 0 : screenX, y: 0, inside: false };
      lookAtCursor();
      return cursor;
    },
    typing: (rate) => handleTyping({ rate: rate === undefined ? 6 : rate }),
    approach: () => idleApproach(),
    // 主动靠近有 4 个前提（鼠标在远处 / 没生气 / 你 45s 没动过 / 3 分钟没靠近过）。
    // 验收需要能**跳过前两个时间前提**，否则要么得在浏览器里空等 45 秒，
    // 要么就只能验到"它正确地什么都没做"。forceApproach 把计时器往回拨，
    // 走的仍然是同一个 idleApproach —— 不是另一段演示逻辑。
    forceApproach() {
      lastInteract = Date.now() - 60 * 1000;
      lastApproach = 0;
      idleApproach();
      return true;
    },
    setMood(v) { mood = Math.max(0, Math.min(100, v)); moodBand = moodBandOf(mood); return mood; },
    getMood: () => ({ value: Math.round(mood), band: moodBand }),
    setScale: (k) => window.pet.setSettings({ scale: k }),
    sleep() { return fallAsleep(); },
    // ---- v3.9/v3.10：状态帧（眼/嘴两层）的演示入口 ----
    // 一律走**真机同一段逻辑**，不另写演示（另写一段等于验了个等效实现，
    // 而真机可能压根没接上）：
    //   blink   就是 scheduleBlink 会调的那一次
    //   mouth   直接改期望槽位，走 applyMouthLayer
    //   eye     见下面那条（要定住，不能只改期望槽位）
    //   expression 就是摸头/番茄完成会走的那个
    blink: () => blinkOnce(),
    // ★ eye() 用 expression 把槽位**钉住**，不是 showEye。
    //   理由很具体：这些档位的正常存活时间只有 40~130ms（一次眨眼），
    //   而截图要等 4 秒 —— 用 showEye 的话，截到的是哪一档完全看运气，
    //   验收图会变成随机样本，没法判断"接线对不对"。
    //   expression 会同时设 eyeHold，自动眨眼在此期间被闸门挡住。
    //   eye(null) 才是"放回基准睁眼"，用来出一张对照。
    eye: (slot) => {
      if (slot === undefined || slot === null) { eyeHold = 0; showEye(null); return null; }
      return expression(slot, 12000) ? slot : (eyeForced || eyeWant || null);
    },
    // ★ mouth() 必须先 stopTalk()：真机的口型节拍（说话时 110ms 一拍）会盖掉
    //   这里钉的槽位。开机问候那一句要念三四秒，正好把演示期整段盖住 ——
    //   不掐掉的话，验收图截到的是"节拍恰好停在闭嘴那一拍"的随机样本，
    //   而它和"嘴部图层根本没生效"在画面上分不出来（实测就踩了这个坑：
    //   两张口型图逐像素相同，看起来像接线断了，其实是节拍把它擦了）。
    mouth: (slot) => {
      stopTalk();
      showMouth(slot === undefined ? null : slot);
      return mouthWant;
    },
    expression: (slot, ms) => expression(slot, ms),
    talk: (ms) => { talkFor(ms === undefined ? 800 : ms); return true; },
    // 验收专用（见上面那三个函数的说明）：等素材解码 / 关掉随机眨眼。
    layersReady: () => layersReady(),
    onLayersReady: (cb) => onLayersReady(cb),
    freezeBlink: () => { freezeBlink(); return true; },
    forceSleep() { lastInteract = Date.now() - 4 * 60 * 1000; sleepCheck(); },
    wake: wakeUp,
    // v3.6 醒来是三拍。wake 只放第一拍，后面两拍要靠时间走完 ——
    // 单独暴露 finishWake 是为了验"在她迷糊时又戳一下，能催她立刻清醒"那条路。
    finishWake: () => finishWake(false),
    // —— 行为链 ——
    chain: () => runChain(),
    // 验收要能**立刻**看一条链：既不能等 11~24 秒的静默期，也不该被
    // CHAIN_QUIET_AFTER 拦住（在浏览器里刚点完按钮，lastInteract 就是"刚刚"）。
    // 时间闸门往回拨，走的仍然是同一个 runChain —— 不是另写一段演示。
    // ⚠ 拨回的量**不能大**：lastInteract 同时是"她该睡了吗"的计时基准，
    //   拨过头（比如置 0）会让她在 20 秒内被判成"三分钟没互动"而当场睡着。
    forceChain() {
      lastInteract = Date.now() - CHAIN_QUIET_AFTER - 1;
      if (chainTimer) interruptChain();
      return runChain();
    },
    interrupt: () => interruptChain(),
    chainInfo: () => ({
      node: lastChain ? lastChain.node : '', step: lastChain ? lastChain.step : 0,
      did: lastChain ? lastChain.did : null, running: !!chainTimer,
      steps: chainSteps, budget: Math.round(chainBudget),
      nodes: Object.keys(ACT)
    }),
    // —— 久别重逢 ——
    away: (ms) => awayLine(ms),
    awaySay: (ms) => { const l = awayLine(ms); if (l) quote(l); return l || null; },
    pet(k) {
      // 走一遍和真机右键菜单完全相同的路径：主进程发 outfit -> 渲染层 onOutfit
      window.pet._fireOutfit && window.pet._fireOutfit(k);
    },
    action(a) { window.pet._fireAction && window.pet._fireAction(a); },
    // 羁绊 / 勿扰 / 音效的验收出口。
    // setBond 是必要的：预览里没有主进程，也就没有 affinity.json，
    // 不摆一个状态出来，"解锁台词"这件事在浏览器里根本验不了。
    gain, sfx, idleLines,
    showLevelUp: (lv) => levelUpShow({ level: lv || 2 }),
    setBond(level, points) {
      bondLevel = level || 1;
      lastBond = { level: bondLevel, points: points || 0, nextAt: null };
      return lastBond;
    },
    getState: () => ({
      ...state, sleeping, waking, hasPom: !!pom, scale: curScaleKey,
      bond: bondLevel, points: lastBond.points, quiet, sfx: sfxEnabled,
      // v3.9/v3.10：状态帧的可读状态。
      // 为什么必须摆出来：眨眼只有 120ms，无头截图（虚拟时间轴）根本抓不到那一帧 ——
      // 和文档里记的"动画帧抓不准"是同一个坑。所以"她到底眨没眨"
      // 只能靠读数证明，不能靠像素。eyeForced/eyeWant 分开报，
      // 是为了让"睡着时不眨眼"和"眨眼失败"这两件事在读数上能分开。
      eye: eyeForced || eyeWant || null, eyeForced, eyeWant,
      mouth: mouthWant, eyeOn: fEye.classList.contains('on'),
      mouthOn: fMouth.classList.contains('on'),
      eyeSlots: layerSlots('eye'), mouthSlots: layerSlots('mouth'),
      // v3.11：走动两帧的可见性。它们是**纯 CSS 动画**写的 opacity（按步周期硬切），
      // 所以"这一拍该显示哪一帧"只能读 computed opacity —— 这正是无头验收
      // 要判的东西（两张图都在、却都没显示 / 同时显示，都是"看不到"）。
      // 用 getComputedStyle 而不是读 CSS 变量：读变量只能证明"变量写对了"，
      // 证明不了动画真的在跑。
      walkSlots: layerSlots('walk'), hemA: hemOpacity('fHemA'), hemB: hemOpacity('fHemB'),
      // v3.8：打扰等级 / 你在不在 / 是否正在冷落她 / 收边请求。
      // 这四个不摆出来的话，无头截图完全判断不了"安静档到底有没有把台词吞掉"
      // "她是不是因为你不在才睡的""贴边那一下有没有发出收边请求"。
      chatter, active: userActive, ignoring, edge: (window.pet && window.pet._edge) || null,
      mood: Math.round(mood), moodBand, cursorDist: cursor.dist, throwing,
      walkGoal: lastWalk ? (lastWalk.from + '→' + lastWalk.goal) : '-',
      walkDir: lastWalk ? lastWalk.dir : 0,
      throwPlan: lastThrow
        ? ('v' + lastThrow.vx + ',' + lastThrow.vy + ' padX' + lastThrow.padX +
           ' L' + lastThrow.left + ' R' + lastThrow.right + ' G' + lastThrow.ground)
        : '-',
      anim: lastAnim.name, animAge: lastAnim.at ? Date.now() - lastAnim.at : -1,
      // 行为链：她此刻自己那条链走到第几拍了。
      // 链是 setTimeout 驱动的，无头截图**抓不准动画帧**（虚拟时间轴和 CSS 动画对不齐），
      // 所以"链有没有真的往下走"只能靠读数证明，和 lastAnim 是同一个理由。
      chain: lastChain ? (lastChain.node + '#' + lastChain.step + (lastChain.did ? '' : '×')) : '-',
      chainRun: !!chainTimer, chainSteps, chainBudget: Math.round(chainBudget),
      // ---- v3.12：前台应用 / 时间 ----
      // scene 是"渲染层此刻持有的那个场景" —— 正是要验的东西：主进程推了 scene 之后
      //   渲染层有没有真的接住（onScene 的接线），无头截图上看不出来。
      // daypart 是"此刻该用哪一组问候"，纯函数，可以直接断言。
      // hour/chimeHour 是整点报时的旁证：真时钟等不到整点，但"上次报的是哪一小时"
      //   摆出来就能确认调度逻辑跑过（而不是只写了一行没人调用的代码）。
      scene: sceneNow, daypart: daypartOf(new Date().getHours()),
      hour: new Date().getHours(), chimeHour: lastChimeHour,
      sceneKeys: SCENE_KEYS.length
    }),
    // 点击穿透：报出去的可交互框 + 渲染层是否主动喊过"光标压在我身上"。
    // 这两个数不摆出来的话，浏览器里完全看不出"可交互区算得对不对" ——
    // 而算错的方向恰恰是"她点不到"（框比角色小），截图上是看不出异常的空档。
    // sprite 只给**尺寸**不给坐标：坐标在真机是窗口本地、在预览页是页面坐标，
    // 摆出来只会让人拿两套坐标系互相印证；尺寸两边一致，也正好和 box 对得上。
    hitInfo: () => {
      const b = spriteBox();
      return {
        box: hitBox,
        over: overSelf,
        sprite: Math.round(b.right - b.left) + 'x' + Math.round(b.bottom - b.top)
      };
    },

    // ---- v3.8：打扰等级 / 你在不在 / 健康提醒 / 冷落 / 盯着看 / 收边 ----
    // 一律走**真机同一段逻辑**的入口，不另写演示 —— 另写一段等于验了个等效实现：
    //   setChatter  触发 onChatter 回调（与主进程广播走同一条路）
    //   activity    触发 onActivity 回调（真机里由系统空闲检测驱动）
    //   remind      就是主进程到点时调的那个 remindHealth
    //   hits        走 noteHit —— 和真人连点时累积的是**同一个**时间窗口
    //   stare       就是 stareCheck 的定时器会调的那一段（自带全部闸门）
    setChatter: (k) => { window.pet._fireChatter && window.pet._fireChatter(k); return chatter; },
    activity(awayMs, active) {
      const on = active === undefined ? true : !!active;
      window.pet._active = on;
      if (window.pet._fireActivity) window.pet._fireActivity({ active: on, awayMs: awayMs || 0 });
      return userActive;
    },
    remind: (k) => { remindHealth(k); return true; },
    hits: (n) => {
      const c = n === undefined ? IGNORE_HITS : n;
      for (let i = 0; i < c; i++) noteHit();
      return ignoring;
    },
    getIgnoring: () => ignoring,
    // 被盯着看：返回 false = 被闸门挡下了（模式 / 睡着 / 生气 / 冷却），
    // true = 真的触发了。这个返回值是必需的 —— 否则"什么都没发生"分不清是
    // 接线断了还是闸门生效了。
    stare: () => doStare(),
    // 你离开多久 -> 回来她汇报哪一档。同样只喂差值，分档逻辑只有一份。
    awayDoing: (ms) => awayDoingLine(ms),
    awayDoingSay: (ms) => { const l = awayDoingLine(ms); if (l) quote(l); return !!l; },
    edge: () => (window.pet && window.pet._edge) || null,

    // ---- v3.12：前台应用 / 时间感知 ----
    // scene     —— 喂一个场景进去。走的是渲染层**同一个** onScene 回调
    //              （预览页替身把它接到 _fireScene），不是另写一段演示。
    // chime     —— 直接演一次整点报时（真机要等真整点，截图里等不到）。
    // dayN      —— 直接演一次"陪你第 N 天"（同理由，里程碑要等好多天）。
    // autoQuiet —— 演一次**自动勿扰**：她静默消失、不说告别。与 setQuiet（手动档，
    //              会说"我出去了"）对照着看 —— 这正是两条路唯一可见的差别，必须验得了。
    scene: (k) => {
      // 与 forceChain 同一个手法：**只把时间闸门往回拨**，其余闸门（勿扰 / 安静档 /
      // 她自己正忙）全部照常 —— 不拨的话验收时根本说不了这句。
      // 两道闸门都要拨：
      //   ① 8 分钟的陪聊冷却（第二次点就得等 8 分钟，等于没法验）
      //   ② canSpeakNow() 里那句"你至少 30s 没碰过我" —— 页面刚打开时必然不满足，
      //      不拨的话演示出去的是**开机问候**（时段台词），而不是场景台词。
      // ⚠ 拨回的量必须保守（31s，和 forceChain 一样）：lastInteract 同时是
      //   "她该睡了吗"的计时基准，拨过头会让她当场睡着。
      lastSceneSay = 0;
      lastInteract = Date.now() - 31000;
      if (window.pet._fireScene) window.pet._fireScene({ scene: k, exe: 'demo.exe' });
      return sceneNow;
    },
    chime: (h) => { quote(QUOTES.chime, { h: cnHour(h === undefined ? new Date().getHours() : h) }); return true; },
    dayN: (n) => {
      const arr = QUOTES.dayN[n];
      if (!arr) return null;
      const line = pick(arr);
      quote([line]);
      return line;
    },
    daypart: (h) => daypartOf(h === undefined ? new Date().getHours() : h),
    dayparts: () => DAYPARTS.map(([, name]) => name),
    cnHour: (h) => cnHour(h),
    autoQuiet: () => {
      if (window.pet._fireQuiet) window.pet._fireQuiet({ active: true, until: 0, bye: false });
      return quiet;
    },
    // 手动勿扰（菜单里"安静一会儿"）：与 autoQuiet 唯一的可见差别就是**它会说告别**。
    // 两条并排点一次，就能看出 bye 这个字段到底有没有被接住 —— 而这件事
    // 在无头截图之外完全看不出来（真机上两者都是"她不见了"）。
    manualQuiet: () => {
      if (window.pet._fireQuiet) window.pet._fireQuiet({ active: true, until: Date.now() + 60000, bye: true });
      return quiet;
    }
  };
}
