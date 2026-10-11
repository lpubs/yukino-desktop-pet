#!/usr/bin/env node
/**
 * 雪乃桌宠 · 负向测试（assertion self-check）
 *
 * 自检（tools/selftest.js）能证明"现在是绿的"，但证明不了**断言本身会不会响**：
 * 一条写错的断言（条件写反、字段名抄错、正则匹配不到）永远返回"通过"，
 * 而它的沉默和"确实没问题"长得一模一样。这个文件就是拆穿沉默用的：
 * 它逐条**故意破坏**一处真实约束，跑一次自检，要求指定的那条问题必须出现。
 *
 * 为什么值得单独一个文件：v3.6 的新断言有 20+ 条，靠人手一条条改回去试
 * 是做不到的（做过一次，13 条改完手都酸了）。而这几条守的恰好都是
 * "静默失效"—— 不试就不会知道它到底响不响。
 *
 * ⚠ 它会**原地修改** main.js / pet.css / preview.html，跑完立刻还原。
 *   中断（Ctrl-C）时也会还原 —— 但仍然建议先 commit 再跑。
 *
 * 用法： node tools/negtest.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SELF = path.join(ROOT, 'tools', 'selftest.js');
const F = {
  self: 'tools/selftest.js',
  css: 'renderer/pet.css',
  main: 'main.js',
  pet: 'renderer/pet.js',
  meas: 'tools/measure_bubble.py',
  html: 'renderer/index.html',
  man: 'assets/sprites/maid/manifest.json',
  gen: 'tools/gen_layers.py',
  mask: 'tools/featmask.py',
  prev: 'renderer/preview.html',
  rev: 'tools/review.py',
  probe: 'tools/probe_v38.js',
  wininfo: 'wininfo.js',
  pkg: 'package.json',
  dlg: 'renderer/dialogue.js',
};

// pet.js 里那行的原文 —— 用来构造"删掉换行、注释吞掉右花括号"这个真实错误
const PET_TAIL = '  return r.height || Math.round(WIN_H - PET_TOP_PAD_RATIO * WIN_W);   // 首帧布局未就绪时兜底';

// 每条：把 file 里的 from 换成 to，要求自检报出 expect 这条
const CASES = [
  {
    file: 'css', what: '#topBar 改回 bottom: calc(<留白>cqw)（那条线在窗口底部，气泡会被丢到她腰上）',
    from: 'top: 0; left: 0; right: 0;\n  height: 22cqw;',
    to: 'left: 0; right: 0;\n  bottom: calc(22cqw + 2px);\n  height: auto;',
    expect: '#topBar 用了 bottom: calc',
  },
  {
    file: 'css', what: '#topBar 改回竖排（徽章高度又加进气泡上方）',
    from: 'flex-direction: row; align-items: flex-end;',
    to: 'flex-direction: column; align-items: flex-end;',
    expect: '#topBar 不是横排',
  },
  {
    file: 'css', what: '内容不再贴带子底边对齐（带子一高气泡就飘）',
    from: 'height: 22cqw;\n  display: flex; flex-direction: row; align-items: flex-end;',
    to: 'height: 22cqw;\n  display: flex; flex-direction: row; align-items: center;',
    expect: '#topBar 的内容没有贴底边对齐',
  },
  {
    file: 'css', what: '把带子高度改成别的数（底边就不再是她头顶那条线）',
    from: 'height: 22cqw;', to: 'height: 20cqw;',
    expect: '#topBar 的高度与留白带不同源',
  },
  {
    file: 'css', what: '#bubble 允许被压窄（会多折一行、把信息条顶高）',
    from: '  flex-shrink: 0;', to: '  flex-shrink: 1;',
    expect: '#bubble 没有 flex-shrink: 0',
  },
  {
    file: 'css', what: '#badge 不许收缩（挤不下时坏掉的是气泡）',
    from: '  flex-shrink: 1;\n  min-width: 0;', to: '  flex-shrink: 0;\n  min-width: 0;',
    expect: '#badge 没有 flex-shrink: 1',
  },
  {
    file: 'css', what: '极窄窗口不再收窄徽章（极小档只剩 5px 余量）',
    from: '@container (max-width: 280px) {', to: '@container (max-width: 100px) {',
    expect: '收窄徽章的阈值不在极小档与小档之间',
  },
  {
    file: 'meas', what: '探针里的留白比值忘了跟着改（它量的就是另一条线）',
    from: 'TOP_PAD_CQW = 0.22', to: 'TOP_PAD_CQW = 0.17',
    expect: '顶部留白五处不一致',
  },
  {
    file: 'meas', what: '探针少量一档（最苛刻的那档根本没被量过）',
    from: 'TIERS = ("tiny", "small", "medium", "large", "huge")',
    to: 'TIERS = ("tiny", "small", "medium", "large")',
    expect: '探针量的档位与 SIZES 不一致',
  },
  {
    file: 'meas', what: '探针的字号 clamp 与 pet.css 脱节（"撞没撞上下限"的判断会全错）',
    from: 'FONT_CLAMP = (10.5, 0.0335, 15.0)', to: 'FONT_CLAMP = (10.5, 0.031, 15.0)',
    expect: '探针的字号 clamp 与 pet.css 不一致',
  },
  {
    file: 'main', what: '存档不再记底边（窗口一变高她就整体下沉）',
    from: 'patchSettings({ pos: { x: p.x, y: p.y, bottom: p.y + winSize().h } });',
    to: 'patchSettings({ pos: { x: p.x, y: p.y } });',
    expect: 'pet:savePos 没有把底边一起存下来',
  },
  {
    file: 'main', what: '启动时不按底边还原（存了也白存）',
    from: 'Number.isFinite(saved.bottom) ? saved.bottom - h : saved.y', to: 'saved.y',
    expect: 'createPet 没有按底边还原位置',
  },
  {
    file: 'main', what: '不判老存档（没有 bottom 的老存档会算出 NaN）',
    from: 'Number.isFinite(saved.bottom) ? saved.bottom - h : saved.y',
    to: 'saved.bottom ? saved.bottom - h : NaN',
    expect: 'createPet 没做老存档兼容',
  },
  {
    // 复现 v3.6 收尾时真犯过的错：删掉一个换行，注释把 `}` 吃掉 → 整份文件语法错误
    file: 'pet', what: 'pet.js 被改成语法错误（注释吞掉右花括号）—— 页面会静默变空',
    from: PET_TAIL + '\n}', to: PET_TAIL + '}',
    expect: '语法错误',
  },
  {
    // 复现 v3.7 那个真机 bug 的一半：置顶巡检不再问"她此刻可见吗"
    file: 'main', what: '10 分钟置顶巡检丢掉可见性闸门（长勿扰里她每 10 分钟自己冒出来一次）',
    from: 'if (petWin && !petWin.isDestroyed() && petWin.isVisible() && pinned) {',
    to: 'if (petWin && !petWin.isDestroyed() && pinned) {',
    expect: '没先确认可见',
  },
  {
    // 另一半：鼠标策略的闸门又去读"勿扰中"，于是她一旦被显示出来就永久点不到
    file: 'main', what: '光标巡检的闸门掺进"勿扰中"（她一旦被显示出来就永久点不到、也关不掉）',
    from: '  if (!petWin.isVisible()) return;                     // 她藏起来了：不跟、不判、不维护',
    to: '  if (!petWin.isVisible() || quietUntil() > Date.now()) return;   // 她藏起来了',
    expect: 'cursorPoll 的闸门里掺了勿扰状态',
  },
  {
    file: 'main', what: '又给"可见性"造了一个缓存副本（缓存一漂，鼠标策略就不恢复）',
    // v3.12 起这里是 manualQuiet（手动档），自动档并进了 quietActive —— 目标跟着改。
    from: 'const manualQuiet = () => quietUntil() > Date.now();',
    to: 'let quietHidden = false;\nconst manualQuiet = () => quietUntil() > Date.now();',
    expect: '又把"勿扰中"缓存成变量了',
  },
  {
    // 冻結开关是"JS 切类名 + CSS 落规矩"的两处配对，而漏了 CSS 是完全静默的
    file: 'css', what: '冻结的 CSS 规矩被删掉（JS 还在切类名，但一点都冻不住）',
    from: 'html.pet-frozen * {', to: 'html.pet-stopped * {',
    expect: 'pet.css 里没有这条规矩',
  },
  {
    // document.hidden 在真机上永远不成立（backgroundThrottling: false 的副作用），
    // 所以心跳一旦只挂它，等于没有闸门
    file: 'pet', what: '心跳的闸门退回只靠 document.hidden（真机上它永远是 false）',
    from: 'const want = !document.hidden && !quiet;', to: 'const want = !document.hidden;',
    expect: 'syncHeartbeat 的闸门没挂在 quiet 上',
  },
  {
    file: 'main', what: '硬件加速又变成无条件关闭（可见待机 CPU 翻一倍，且它并不保护 GPU）',
    from: "if (process.env.YUKINO_HWACCEL === '0') app.disableHardwareAcceleration();",
    to: 'app.disableHardwareAcceleration();',
    expect: '找不到 YUKINO_HWACCEL 这个回退开关',
  },

  // ========== v3.8 ==========
  // 打扰等级
  {
    file: 'pet', what: '安静档的台词闸门被删（开了安静她照旧叨叨）',
    from: '  if (idleMute > 0) return;',
    to: '  // 闸门被删',
    expect: 'quote() 里没有 idleMute 闸门',
  },
  {
    file: 'pet', what: '行为链只开不关静音（抛一次错，她从此再也不说话 —— 而她还在动）',
    from: '\n  finally { if (!talkOK()) idleMute--; }',
    to: '',
    expect: '行为链没有成对地开关 idleMute',
  },
  {
    file: 'pet', what: '主动靠近漏了安静档闸门（她会走过来杵在你面前）',
    from: '  if (!talkOK()) return false;\n  // 判"有没有光标数据"',
    to: '  // 判"有没有光标数据"',
    expect: 'idleApproach 没有安静档闸门',
  },
  {
    file: 'main', what: 'settings:set 改了 chatter 却不广播（那条路径上点了没反应）',
    from: '  if (s.chatter !== undefined) send(\'chatter\', chatterOf());',
    to: '',
    expect: '有个入口改了 chatter 却没广播给渲染层',
  },
  // 空闲检测
  {
    file: 'pet', what: '睡着判定退回"你多久没点我"（你在隔壁写字，她睡一整段）',
    from: '  if (userActive) return;              // 你在 —— 她就不睡。就这一条。',
    to: '  if (Date.now() - lastInteract < 3 * 60 * 1000) return;',
    expect: 'sleepCheck 还在用 lastInteract',
  },
  {
    file: 'main', what: '空闲阈值声明了却没用（形同虚设的常量）',
    from: '  const active = idle < IDLE_AWAY_SEC;\n  if (active === userActive) return;',
    to: '  const active = true;\n  if (active === userActive) return;',
    expect: '空闲阈值只出现在',
  },
  {
    file: 'pet', what: '启动时不问"你在不在"（开机自启时她先问一句好、再睡）',
    from: '    const ia = await window.pet.getIdle();',
    to: '    const ia = { active: true };',
    expect: '渲染层启动时没问',
  },
  // 健康提醒
  {
    file: 'main', what: '健康计时不判"你在不在"（你不在家也计时，回来一口气连发三条）',
    from: '  if (!userActive) return;                    // 你不在：不累计（提醒没有意义）',
    to: '',
    expect: '健康计时没判',
  },
  {
    file: 'main', what: '健康累计不封顶（合盖几小时再打开，三类提醒同时炸出来）',
    from: 'const dt = Math.min(now - healthTickAt, 30000);',
    to: 'const dt = now - healthTickAt;',
    expect: '健康计时没有封顶',
  },
  // 边缘收边
  {
    file: 'pet', what: 'snapX 不再返回 edge（吸过去了却没缩起来，半吊子状态）',
    from: "  if (left - area.x < SNAP) return { x: Math.round(area.x - (petW - sw) / 2), edge: 'left' };",
    to: '  if (left - area.x < SNAP) return { x: Math.round(area.x - (petW - sw) / 2) };',
    expect: 'snapX 没有返回 edge',
  },
  {
    file: 'main', what: '几何巡检不再跳过收边（20 秒一次把她从屏幕边上拽回来）',
    // v3.12 在 enforceSize 里插了"栖息中只走 resnap"那一支，原来那个跨行目标不再相邻；
    // 而这行**在 resnap 里也有一份**（一模一样），所以必须点名第 2 处（enforceSize 的）。
    from: '  if (edgeMode) { applyEdgePos(); return; }\n',
    to: '',
    nth: 2,
    expect: 'enforceSize 会把收边的她夹回屏幕内',
  },
  {
    file: 'main', what: '开始拖拽时不退出收边（你的手和贴边公式各写各的位置）',
    from: '    if (edgeMode) setEdge(null);\n',
    to: '',
    expect: '拖拽没退出收边',
  },
  {
    file: 'main', what: '探头只留一个阈值（光标停在阈值上她每 120ms 抽一下）',
    from: '      ? pt.x < wa.x + (edgePeek ? EDGE_OUT : EDGE_IN)',
    to: '      ? pt.x < wa.x + EDGE_IN',
    expect: '滞回只用在',
  },
  {
    file: 'pet', what: '点她不再取消收边（除了菜单没别的办法叫她出来）',
    from: '  if (edgeReq) reqEdge(null);',
    to: '',
    expect: '收边状态下点她没有恢复路径',
  },
  {
    file: 'pet', what: '收边时机提前到落地之前（她落到一半被贴边逻辑拽回去）',
    from: '    if (edge) reqEdge(edge);',
    to: '',
    expect: '收边时机不对',
  },
  // 冷落 / 盯着看
  {
    file: 'pet', what: '冷落期的 return 挪到计分之后（"不理你"却照旧加分）',
    from: '  if (ignoring) { anim(\'shake\', 420); return; }',
    to: '',
    expect: '冷落期内仍然会加分',
  },
  {
    file: 'pet', what: '盯着看没有冷却（鼠标一停住她每两秒来一句）',
    from: '  if (Date.now() - lastStare < STARE_CD) return false;',
    to: '',
    expect: '盯着看没有冷却',
  },
  // ---- v3.9/v3.10 状态帧：守的是"三方对齐"（pet.js 槽位表 / manifest / 磁盘 PNG）
  //      以及 v3.10 新增的"框外 alpha 必须为 0"----
  // 这些破坏的共同点是**都不会报错**：改错了，自检若沉默，屏幕上只是
  // "某一档不眨眼"或"她眼睛歪了" —— 从截图和行为都看不出来。
  {
    file: 'man', what: '掩膜外色偏回到 27（等于没用潜空间掩膜、整张被重采样了）',
    from: '"tone_off": 3.23,',
    to: '"tone_off": 27,',
    expect: '掩膜外色偏 27',
  },
  {
    file: 'man', what: '形态标记退回 v3.9 的差分块（同一批文件名、含义完全不同，读数会被反向解释）',
    from: '"mode": "region-frame",',
    to: '"mode": "diff-layer",',
    expect: '应为 "region-frame"',
  },
  {
    file: 'man', what: '眼睛帧改用嘴区框（框外那截旧睫毛留下来 —— v3.9 那个"闭了眼底下还有一道弧"）',
    from: '"kind": "eye",\n      "region": "face",',
    to: '"kind": "eye",\n      "region": "mouthbox",',
    expect: '却用 mouthbox 区',
  },
  {
    file: 'man', what: '区域名漂一个字母（生成按一块、验收按另一块，"框外有没有漂移"永远算不出问题）',
    from: '"region": "face",',
    to: '"region": "faceX",',
    expect: '不认这个区域名',
  },
  {
    file: 'man', what: 'roi 收窄到框内（框外那些不透明像素立刻让"逐位等于基准"失效 —— 眨眼时她会抖）',
    from: '"roi": [\n        168,',
    to: '"roi": [\n        260,',
    expect: 'roi 之外还有',
  },
  {
    file: 'man', what: 'roi 字段被改名/丢掉（判据没了，那条逐像素断言会整条静默跳过）',
    from: '"roi": [',
    to: '"roiX": [',
    expect: '没有 roi',
  },
  {
    file: 'man', what: '生成脚本自报的框外像素差不再为 0（它自己都承认框外动了）',
    from: '"outside_max_diff": 0,',
    to: '"outside_max_diff": 3,',
    expect: 'outside_max_diff = 3',
  },
  {
    file: 'man', what: '清单里记的层尺寸与磁盘上的文件对不上（记录过期，下一个人会拿错的数去核对对齐）',
    from: '"w": 778,',
    to: '"w": 770,',
    expect: '磁盘上的文件是 778x800',
  },
  {
    file: 'man', what: '清单里的层名漂了一个字母（同时戳破：pet.js 取不到、图层变孤儿、生成脚本没这条）',
    from: '"eye_half": {',
    to: '"eye_halfx": {',
    expect: 'manifest 里没有',
  },
  {
    file: 'pet', what: '槽位名与文件名不符合 <kind>_<槽位> 约定（三处对齐里最先松掉的那颗螺丝）',
    from: "closed: 'eye_closed'",
    to: "closed: 'eye_happy'",
    expect: '槽位 eye.closed 指向',
  },
  {
    file: 'pet', what: '整个 layers 段被拿掉（素材还在、接线没了 → 静默不眨眼）',
    from: 'layers: {',
    to: 'layersOff: {',
    expect: '没声明 layers，却存在',
  },
  {
    file: 'html', what: 'index.html 少了 #fEye（图层没有落点，真机上直接 TypeError）',
    from: 'id="fEye"',
    to: 'id="fEyeX"',
    expect: 'renderer/index.html 里没有 #fEye',
  },
  {
    file: 'css', what: '.frame.layer 独立样式被改名（图层继承基准图的 drop-shadow，眼睛周围多一圈投影）',
    from: '.frame.layer {',
    to: '.frame.layerX {',
    expect: '.frame.layer 样式不见了',
  },
  {
    file: 'pet', what: 'blinkSeq 改回用图层加载态当判据（开机那一两秒眨眼会被静默降成两拍）',
    from: "return hasSlot('eye', 'half')",
    to: "return layerImg('eye', 'half')",
    expect: 'blinkSeq 用图层加载态当判据',
  },
  {
    file: 'pet', what: 'talkFor 改回用图层加载态当判据（开机第一句话没有口型）',
    from: "  if (!hasSlot('mouth', 'open') && !hasSlot('mouth', 'smile')) return;",
    to: "  if (!layerImg('mouth', 'open') && !layerImg('mouth', 'smile')) return;",
    expect: 'talkFor 用图层加载态当判据',
  },
  {
    file: 'pet', what: '验收出口少一个（noblink=1 静默失效，随机眨眼会把基准格拍成半睁）',
    from: '    freezeBlink: () => { freezeBlink(); return true; },',
    to: '',
    expect: '渲染层没有导出验收出口 freezeBlink',
  },
  {
    file: 'prev', what: 'hash 参数闸门改回逐项列举（新参数静默失效 —— ro/wait/noblink 就是这么踩的）',
    from: 'if (![...p.keys()].length) return;',
    to: 'if (![...p.keys()].length || (!k && !o && !sc)) return;',
    expect: 'hash 参数闸门又变回逐项列举了',
  },
  {
    file: 'rev', what: '图层验收不等解码（固定 delay 到点时图层可能还没解码，静默退回基准立绘）',
    from: 'EXTRA = f"{COMMON}&ro=0&wait=layers&delay={D}"',
    to: 'EXTRA = f"{COMMON}&ro=0&delay={D}"',
    expect: '图层验收没有等解码',
  },
  {
    file: 'rev', what: '验收图不关随机眨眼（一次眨眼就能把"睁眼基准"那一格拍成半睁）',
    from: 'COMMON = "quiet=1&noblink=1&ro=0"',
    to: 'COMMON = "quiet=1&ro=0"',
    expect: '验收图没关随机眨眼',
  },
  {
    file: 'rev', what: '验收图不关调试读数（读数固定贴视口右上，裁剪框正好盖她头顶）',
    from: 'COMMON = "quiet=1&noblink=1&ro=0"',
    to: 'COMMON = "quiet=1&noblink=1"',
    expect: '验收图没关调试读数',
  },
  {
    file: 'rev',
    what: 'run_states 里自带 delay 的格子又整串跳过 COMMON（look / pat 连带丢掉 noblink 与 ro=0）',
    from: 'h = f"{h}&{COMMON}" if "delay=" in h else f"{h}&{COMMON}&delay={D}"',
    to: 'h = h if "delay=" in h else f"{h}&{COMMON}&delay={D}"',
    expect: 'run_states 里自带 delay 的格子没吃到 COMMON',
  },
  {
    file: 'rev', what: '图层验收不核对读数（"没生效"与"画法不对"在截图上分不出来）',
    from: 'state_readout(browser, full)',
    to: 'None  # 核对去掉',
    expect: '图层验收没有核对状态读数',
  },
  {
    file: 'gen', what: 'EDITS 里少了 wink 的提示词（这张素材从此无法从代码复现）',
    from: '"eye_wink": (',
    to: '"eye_winkX": (',
    expect: 'EDITS 却没有对应条目',
  },
  {
    file: 'mask', what: '五官标定表少了 maid（掩膜没法重做 → 这套素材无法再生成）',
    from: '"maid": {',
    to: '"maidx": {',
    expect: 'FEATURES 里没有 maid',
  },
  {
    file: 'probe', what: '真机探针的位置口径改回 getBoundingClientRect（量法被目光跟随污染，'
      + '同一个窗口位置能读出好几个数）',
    from: '    const w = f.offsetWidth, l = f.offsetLeft;',
    to: '    const r = f.getBoundingClientRect(); const w = r.width, l = r.left + r.width / 2;',
    expect: 'petLayout 不再用 offsetLeft / offsetWidth',
  },
  // ---- 27 节：走路步态 ----
  // 这一组守的都是"她照样在动、只是动错了"的失效 —— 截图上看不出来，
  // 所以每一条都必须有负向用例，否则改坏了没人知道（第 27 节的头注释有完整理由）。
  {
    file: 'css', what: '走路去掉 alternate（两遍迭代一模一样 = 从"两步一个来回"'
      + '退化成"原地左右抖"）',
    from: '  animation-direction: alternate;',
    to: '  animation-direction: normal;',
    expect: '没有 animation-direction: alternate',
  },
  {
    file: 'css', what: '下落段改回和上升段同一个缓动（两段同手感 = 又变成匀速滑下去，飘）',
    from: '         animation-timing-function: ease-in; }',
    to: '         animation-timing-function: ease-out; }',
    expect: '两段用了同一个缓动函数',
  },
  {
    file: 'css', what: '走路周期不再接 --step-ms（步频跟着速度走从此是句空话，'
      + 'walk() 写进去的变量没人读）',
    from: '  animation-duration: var(--step-ms, 420ms);',
    to: '  animation-duration: 420ms;',
    expect: '没有接 --step-ms',
  },
  {
    file: 'css', what: '触地不再压扁（"重量"的另一半没了，她会在半空里匀速平移）',
    from: 'transform: translateY(1.8px)  scale(1.013, .985) rotate(-1.9deg);',
    to: 'transform: translateY(1.8px)  scale(1, 1) rotate(-1.9deg);',
    expect: '触地没有压扁',
  },
  {
    file: 'pet', what: 'pet.js 里 anim("walk") 抢在写 --step-ms 之前'
      + '（anim() 的重排让动画从 0 相位重启，紧接着改 duration 又让相位跳一次 = 起步抖一下）',
    from: "  wrap.style.setProperty('--step-ms', stepMs);\n  anim('walk');",
    to: "  anim('walk');\n  wrap.style.setProperty('--step-ms', stepMs);",
    expect: 'anim("walk") 排在写 --step-ms 之前',
  },
  {
    file: 'css', what: '走动两帧的 transition 没收到 none（60ms 淡入淡出把 260ms 的迈步糊成重影）',
    from: '.frame.hem {\n  filter: none;\n  pointer-events: none;\n  transition: none;\n  opacity: 0;\n}',
    to: '.frame.hem {\n  filter: none;\n  pointer-events: none;\n  opacity: 0;\n}',
    expect: '.frame.hem 缺',
  },
  {
    file: 'html', what: '真机舞台上少了下装那一帧的落点（pet.js 拿到 null，静默跳过这一层）',
    from: '          <img id="fHemA" class="frame hem" alt="" aria-hidden="true" draggable="false">\n',
    to: '',
    expect: '没有 #fHemA',
  },
  {
    file: 'prev', what: '无头验收舞台上少了下装落点（真机改了、验收舞台没跟上 —— 走动这一层永远验不到）',
    from: '          <img id="fHemB" class="frame hem" alt="" aria-hidden="true" draggable="false">\n',
    to: '',
    expect: '没有 #fHemB',
  },
  {
    file: 'self', what: '隐私闸门从「_ 前缀规则」退回「逐个列举目录名」'
      + '（新建的中间产物目录会被扫进来，它内部的本机绝对路径把闸门顶红）',
    from: "      if (!SCAN_SKIP.has(e.name) && !e.name.startsWith('_')) {",
    to: "      if (!SCAN_SKIP.has(e.name)) {",
    expect: '被扫进了隐私闸门',
  },

  // ---- v3.12：前台窗口感知 / 窗口栖息 / 时间感知 ----
  // 这一组守的都是"静默失效"型错误：全屏时她不躲、栖息时她抽动、
  // 自动档突然开口说话 —— 三种在截图里都看不出异常。
  {
    file: 'wininfo', what: '全屏判据砍掉「起点不越界」那一条（只剩"尺寸差不多"）'
      + '—— 用户最大化浏览器工作时她会消失',
    from: '  const inside = win.x >= -2 && win.y >= -2 &&\n'
      + '    win.x + win.w <= mon.x + mon.w + 2 &&\n'
      + '    win.y + win.h <= mon.y + mon.h + 2;\n  return covers && inside;',
    to: '  return covers;',
    expect: 'isFullscreen 判错：起点越界但尺寸正好等于屏幕',
  },
  {
    file: 'wininfo', what: 'toDip 不再换算（物理像素当成 DIP 直接用）'
      + '—— 150% 屏上她跑到窗口右下方',
    from: '  const s = scale > 0 ? scale : 1;\n  return { x: rect.x / s, y: rect.y / s, w: rect.w / s, h: rect.h / s };',
    to: '  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };',
    expect: 'toDip 在 150% 下的换算不对',
  },
  {
    file: 'wininfo', what: '场景规则表漏掉聊天（微信里她再也不说话 —— 而菜单上看不出少了谁）',
    from: "  ['chat', /^(wechat|weixin|qq|tim|telegram|discord|dingtalk|wework|wxwork|feishu|lark|slack|whatsapp|line|signal|msteams|teams)\\.exe$/i],\n",
    to: '',
    expect: 'sceneOf 判错',
  },
  {
    file: 'main', what: 'quietActive() 退回只看手动档（全屏自动躲起来整条路被架空）',
    from: 'const quietActive = () => manualQuiet() || (autoQuietOn() && fgFullscreen);',
    to: 'const quietActive = () => manualQuiet();',
    expect: 'quietActive() 不是',
  },
  {
    file: 'main', what: '自动档也走"等告别说完再藏"（看全屏视频时她突然开口说"我出去了"）',
    from: '      if (manual) setTimeout(hideNow, QUIET_HIDE_DELAY);\n      else hideNow();',
    to: '      setTimeout(hideNow, QUIET_HIDE_DELAY);',
    expect: 'applyQuiet() 里自动档没有走',
  },
  {
    file: 'main', what: '前台轮询加上可见性闸门（死锁：因全屏而藏 → 不轮询 → 永远回不来）',
    from: 'function fgPoll() {\n  if (!petWin || petWin.isDestroyed()) return;',
    to: 'function fgPoll() {\n  if (!petWin || petWin.isDestroyed()) return;\n  if (!petWin.isVisible()) return;',
    expect: 'fgPoll() 里出现了 isVisible()',
  },
  {
    file: 'main', what: 'fgPoll 自己调 hide() 而不走 applyQuiet（藏起来没人管：穿透/巡检/菜单都以为她还在）',
    from: '    fgFullscreen = fs;\n    applyQuiet();',
    to: '    fgFullscreen = fs;\n    if (fs) petWin.hide();\n    applyQuiet();',
    expect: 'fgPoll() 自己调了 hide()/show()',
  },
  {
    file: 'main', what: 'startFgFeed 去掉"模块不可用就不起"的守卫（装不上时白跑一个 1s 定时器）',
    from: '  if (fgTimer || !fgAvailable()) return;',
    to: '  if (fgTimer) return;',
    expect: 'startFgFeed() 没有',
  },
  {
    file: 'main', what: 'resnap 的栖息分支也夹取位置（20s 巡检把她从窗口上拽下来 = 周期性抽动）',
    from: "  if (perchOn) {\n    if (fgTarget) perchAt(fgTarget.win, fgTarget.work);\n    else fgKey = '';\n    return;\n  }",
    to: "  if (perchOn) {\n    if (fgTarget) perchAt(fgTarget.win, fgTarget.work);\n    else fgKey = '';\n    if (petWin) moveToClamped(petWin.getBounds().x, petWin.getBounds().y);\n    return;\n  }",
    expect: 'resnap() 的栖息分支在夹取位置',
  },
  {
    file: 'main', what: '栖息中照样写位置存档（"贴在某扇窗上"的临时姿态被存成她家）',
    from: '  if (perchOn) return p;\n',
    to: '',
    expect: 'pet:savePos 在栖息中没有直接返回',
  },
  {
    file: 'main', what: '拖拽时不退出栖息（perchAt 每拍把她拽回窗口上，和你的手抢位置）',
    from: "    if (perchOn) { perchOn = false; fgTarget = null; send('perch', false); refreshTray(); }\n",
    to: '',
    expect: 'pet:setBlock 里没有退出栖息',
  },
  {
    file: 'main', what: 'firstRunAt 改成无条件写（"陪你第 N 天"永远停在第一天）',
    from: 'if (!Number(s.firstRunAt)) patchSettings({ firstRunAt: Date.now() });',
    to: 'patchSettings({ firstRunAt: Date.now() });',
    expect: 'firstRunAt 的写入没有',
  },
  {
    file: 'main', what: '「前台感知」只挂进一处菜单（另一个入口里没有这项功能）',
    from: "    { label: '前台感知', submenu: fgSubmenu() },\n",
    to: '',
    expect: '「前台感知」子菜单出现 1 次',
  },
  {
    file: 'pet', what: 'onQuiet 不再读 bye（自动档和手动档又分不开 —— 看全屏视频时她开口告别）',
    from: '    if (o.bye) {',
    to: '    if (true) {',
    expect: 'pet.js 没读 bye 开关',
  },
  {
    file: 'pet', what: '场景台词去掉低频闸门（切一次窗口说一句 = 她变成话痨）',
    from: '  if (Date.now() - lastSceneSay < SCENE_GAP) return;\n',
    to: '',
    expect: '场景台词没有低频闸门',
  },
  {
    file: 'pet', what: 'onScene 里顺手改姿态（按应用插一脚 → 与行为链两个调度器互相打断）',
    from: "  sceneNow = SCENE_KEYS.indexOf(s.scene) >= 0 ? s.scene : 'other';",
    to: "  sceneNow = SCENE_KEYS.indexOf(s.scene) >= 0 ? s.scene : 'other';\n  anim('nod', 600);",
    expect: 'onScene 里改了姿态',
  },
  {
    file: 'pet', what: '深夜那一拍改成走行为链（困意不再直接触发，而是插进她那一拍中间）',
    from: '  ACT.yawn.run();',
    to: '  runChain();',
    expect: '深夜那一拍不再直接调 ACT.yawn.run()',
  },
  {
    file: 'pet', what: 'daypartOf 丢掉"0~4 点归深夜"的回绕（凌晨三点她跟你说早安）',
    from: "  let cur = 'lateNight';",
    to: "  let cur = 'dawn';",
    expect: 'daypartOf 判错',
  },
  {
    file: 'dlg', what: 'QUOTES.scene 少一个键（那个场景永远没话说，而菜单上还写着它的名字）',
    from: "    browser: [\n      '在看什么。……不用给我看。',\n      '开那么多标签，效率是会掉的。'\n    ],\n",
    to: '',
    expect: '这些场景在 QUOTES.scene 里没有键',
  },
  {
    file: 'dlg', what: 'QUOTES.daypart 少一段（那一小时她不会打招呼，也没有任何报错）',
    from: "    noon: [\n      '中午了。饭要吃，别拿咖啡糊弄过去。',\n      '这个点还在忙？吃饭是基本人权。'\n    ],\n",
    to: '',
    expect: 'QUOTES.daypart 与 DAYPARTS 对不上',
  },
  {
    file: 'dlg', what: '整点报时那句忘了写 {h}（"整点了"——等于没报时，而气泡里确实有字）',
    from: "    '{h}了。',",
    to: "    '整点了。',",
    expect: 'QUOTES.chime 里有不带 {h} 的句子',
  },
  {
    file: 'dlg', what: '老的顶层 night 键又加回来（两套时段判据并存，各自会漂）',
    from: '  greeting: [',
    to: "  night: ['……'],\n  greeting: [",
    expect: 'QUOTES 里还有顶层 night / morning',
  },
  {
    file: 'prev', what: '验收页替身丢了 onScene（pet.js 启动即注册 → 整页 TypeError，而真机正常）',
    from: '  onScene: (cb) => { callbacks.scene.push(cb); },\n',
    to: '',
    expect: 'preview.html 的替身缺: onScene',
  },
  {
    file: 'pkg', what: 'build.files 漏掉 wininfo.js（开发态正常，装成 exe 后前台感知整个消失）',
    from: '      "wininfo.js",\n',
    to: '',
    expect: 'build.files 缺 wininfo.js',
  },
  {
    file: 'pkg', what: 'asarUnpack 只放行 koffi、忘了 @koromix（.node 其实躺在后者里）',
    from: '      "**/node_modules/koffi/**",\n      "**/node_modules/@koromix/**"\n',
    to: '      "**/node_modules/koffi/**"\n',
    expect: 'asarUnpack 没有同时放行 koffi 与 @koromix',
  },
  {
    file: 'prev', what: '预览页的按钮被删了、演示分支成了孤儿'
      + '（那条路只剩 hash 入口，按钮栏里再也找不到它）',
    from: '  <button data-demo="quietBye">手动勿扰（会说告别）</button>\n',
    to: '',
    expect: '这些演示分支没有按钮也没有 hash 入口',
  },
  {
    file: 'pet', what: '__petDemo 里少了 manualQuiet'
      + '（预览页那句 demo.manualQuiet() 打在 undefined 上，那个演示静默失效）',
    from: '    manualQuiet: () => {\n',
    to: '    manualQuietX: () => {\n',
    expect: 'preview.html 调了 __petDemo 里没有的出口',
  },
];

function runSelf() {
  try {
    return execFileSync(process.execPath, [SELF], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');   // 有失败时自检用退出码 1，输出仍在 stdout
  }
}

// 先把所有要动的文件读进内存，任何情况下都能还原
//
// ★ 行尾必须**先归一化再比对**。本仓库的源文件是 CRLF，而 CASES 里那些跨行的
//   `from` 字面量写的是 LF —— 直接 `raw.includes(from)` 会在**每一条跨行用例**上
//   失配，报出来是"替换目标找不到"，看着像用例自己写错了，其实是这条用例根本没跑。
//   （实测 65 条里有 6 条是这种，全是含 `\n` 的。）所以：
//     · 比对与替换一律在 LF 视图上做；
//     · 写回时按文件**原本**的行尾还原，免得整个文件被顺带重写成另一种行尾；
//     · 还原走 backup 里的原文，逐字节一致。
const backup = {};   // rel -> 原始文本（逐字节还原用）
const lfView = {};   // rel -> 行尾归一化成 LF 的视图（比对 / 替换用）
const eol = {};      // rel -> '\r\n' 或 '\n'
for (const rel of new Set(CASES.map((c) => F[c.file]))) {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  backup[rel] = raw;
  lfView[rel] = raw.replace(/\r\n/g, '\n');
  eol[rel] = /\r\n/.test(raw) ? '\r\n' : '\n';
}
const writeWithEol = (rel, lfText) => fs.writeFileSync(
  path.join(ROOT, rel), eol[rel] === '\n' ? lfText : lfText.replace(/\n/g, '\r\n'));
function restoreAll() {
  for (const [rel, text] of Object.entries(backup)) {
    const p = path.join(ROOT, rel);
    if (fs.readFileSync(p, 'utf8') !== text) fs.writeFileSync(p, text);
  }
}
process.on('SIGINT', () => { restoreAll(); console.log('\n已还原，退出。'); process.exit(130); });
process.on('uncaughtException', (e) => { restoreAll(); console.error(e); process.exit(1); });

let hit = 0;
const miss = [];
// 可选 nth：替换第 n 次出现（默认第 1 次）。
// 有的约束在两处长得一模一样（resnap 与 enforceSize 都写着
// `if (edgeMode) { applyEdgePos(); return; }`），这时必须指定第几处 ——
// 否则改的是另一个函数，这条用例验的就成了别的东西。
function nthIndexOf(text, sub, n) {
  let i = -1;
  for (let k = 0; k < n; k++) { i = text.indexOf(sub, i + 1); if (i < 0) return -1; }
  return i;
}
try {
  for (const c of CASES) {
    const rel = F[c.file];
    const p = path.join(ROOT, rel);
    const at = nthIndexOf(lfView[rel], c.from, c.nth === undefined ? 1 : c.nth);
    if (at < 0) {
      miss.push(`${c.what} —— 替换目标找不到（是这条测试自己写错了，不是产品的问题）`);
      console.log(`  ? 跳过：${c.what}`);
      continue;
    }
    writeWithEol(rel, lfView[rel].slice(0, at) + c.to + lfView[rel].slice(at + c.from.length));
    const out = runSelf();
    fs.writeFileSync(p, backup[rel]);     // 逐字节还原，别顺带改行尾
    if (out.includes(c.expect)) { hit++; console.log(`  ✓ 会响：${c.what}`); }
    else { miss.push(`${c.what} —— 期望「${c.expect}」没出现`); console.log(`  ✗ SILENT（断言没响）：${c.what}`); }
  }
} finally {
  restoreAll();
}

// 还原之后必须回到全绿 —— 否则说明这个文件自己把项目改坏了
const stillGreen = /通过 \d+ 项，失败 0 项/.test(runSelf());
console.log(`\n负向测试：${hit}/${CASES.length} 会响；还原后${stillGreen ? '全绿 ✓' : '没恢复全绿 ✗'}`);
if (miss.length) {
  console.log('\n没响的（这些断言守不住东西）：');
  miss.forEach((m) => console.log('  - ' + m));
}
if (!stillGreen) console.log('\n⚠ 还原后自检没全绿 —— 先跑 node tools/selftest.js 看剩下的问题。');
process.exit(miss.length || !stillGreen ? 1 : 0);
