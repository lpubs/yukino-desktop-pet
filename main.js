// 雪乃桌宠 · 主进程
//
// 架构原则（前三条是被长期挂机实测逼出来的，不是风格偏好）：
//   1. **凡是"设一次就指望它一直在"的窗口状态，一律改成每拍按事实重算。**
//      DWM 在锁屏/息屏/睡眠/分辨率变更后会悄悄改掉透明无边框窗口的尺寸，
//      也会让鼠标转发状态漂移，而代码只在用户主动操作时才设置它们，
//      于是错误一旦发生就永久停留。历史上有三次踩同一个坑：
//        · 窗口被压扁（几何只在缩放时设置）-> 现在 20s 巡检还原，见 enforceSize。
//        · 挂机以后点不到（穿透态只用事件切一次）-> 现在 120ms 按光标位置重算，
//          见"透明区点击穿透"一节。**注意：不是废除穿透，是不再用事件驱动地切它。**
//        · 勿扰里她还在、还点不到（缓存了一个 quietHidden，而"可见性"被别的路径
//          改掉时缓存不会跟着变）-> 现在可见性一律问 petWin.isVisible()，
//          并且所有会动 z 序的地方都先确认她确实该露面，见"勿扰"一节。
//   2. 周期巡检并还原窗口几何。（同上，见 enforceSize。）
//   3. 渲染层心跳看门狗。渲染进程假死不一定会触发 unresponsive /
//      render-process-gone，主进程根本不知道出事了 —— 用户表现为"人还在，
//      点什么都没反应"。
//   4. 她藏起来的时候（勿扰 / 不可见）不做任何判定：不跟目光、不判穿透、
//      不判假死。那时渲染层是静默的，拿"心跳停了"去重载一个看不见的窗口，
//      或者在看不见的时候维护穿透态，都只是白烧 —— 而且"到明天早上 8 点"
//      这一档会持续一整夜。
//      ⚠ 这条的闸门**只能是 petWin.isVisible()**，不能是"勿扰中"这类缓存的标记：
//        缓存一旦和事实不一致，这里会把鼠标策略整个挂起（她看得见但点不到）。
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, powerMonitor, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
// 位置约束的纯数学。抽成独立文件是为了让 renderer/preview.html 的替身能用同一份，
// 从而"拖不出屏幕"这件事在浏览器里就能验收（本机 Electron 起不来）。
const { clampPos: clampInto } = require('./clamp.js');
// 前台窗口信息（可选能力：koffi + user32）。一次拿取供三处用 ——
// **全屏自动躲起来 / 窗口栖息 / 环境感知**。装不上就 available()=false，
// 三处各自降级（菜单置灰），桌宠其余部分一切照常。规格与打字反应的 uiohook 一致。
const wininfo = require('./wininfo.js');

app.commandLine.appendSwitch('enable-transparent-visuals');

// ── 硬件加速：默认**开**（v3.7 改）。个别机器要关就设 YUKINO_HWACCEL=0 ──
// 这里原来是**无条件**调 app.disableHardwareAcceleration() 的，理由写在旧注释里是
// "本机沙箱里 GPU 进程起不来，Chromium 直接 FATAL，整个程序起不来"。
// v3.7 实测发现**这个理由不成立**：关掉硬件加速并不会让 GPU 进程消失 ——
// 它照样要起来做软件合成（实测：关掉时那个 GPU 进程自己吃掉 2.19% CPU），
// 而它起不来时两种配置**都一样** FATAL:GPU process isn't usable. Goodbye.
// 也就是说那个开关没有起到它表面上的"保护"作用，只剩代价：整页动画只能由 CPU
// 一帧帧画出来。tools/measure_idle.js 实测（同一组启动参数，只差这一项）：
//     可见待机  2.80% -> 1.47%     （隐藏待机两边都是 0.11%）
//     两种配置的窗口截图逐像素比对：0 个差异像素（612x735 RGBA）
// 所以改成默认开。留 YUKINO_HWACCEL=0 是给"某些驱动 + 透明无边框窗口"组合
// 出问题的机器准备的 —— 那种症状是闪烁/黑块，而不是崩溃
// （崩溃是 GPU 起不来，那时两种配置都会崩，这个开关救不了）。
// ⚠ 想改回无条件关闭之前，先想清楚上面那条实测：那个开关并不保护谁。
if (process.env.YUKINO_HWACCEL === '0') app.disableHardwareAcceleration();

// ---------- 窗口尺寸 ----------
// 为什么是 404（这是被素材逼出来的，不是拍脑袋）：
//   pet.css 用 height:100% 落位，所以**显示高度 = 角色区高度**，
//   显示宽度 = 素材宽 × (角色高 / 素材高)。最宽的一套是女仆装，
//   它要在 400 高的角色区里完整显示需要的宽度就是 404 的来源。
//   上一版窗口只有 360 宽，于是女仆装被宽度限制压到 367 高，而水手服能到 400 高 ——
//   换装时角色会**肉眼可见地变大变小**，且 360 宽里塞一个窄的水手服
//   会留下大片空白接住鼠标。404 让四套全部按 400 高显示，高度一致、空白也更少。
//
// ── 窗口比角色高（v3.2.3 起）──
// 窗口**不再等于**角色高度：顶部多留一条 TOP_PAD 专门放气泡。
// 角色区 = 窗口底部那一条（pet.css 的 #petArea），于是：
//     窗口高 BASE_H = 489 = 角色高 PET_H(400) + 留白 89
//     留白 = 窗口宽 × 22%，五档等比（极小 51px / 小 64px / 中 89px / 大 114px / 特大 140px）
// 效果：气泡从"压在她头发上"变成"悬在她头顶上方"，而角色显示大小一点没变。
// ★ 凡是"按高度撑满"的换算（显示宽 / padX）一律用 PET_H；
//   用 BASE_H 会把角色算宽 —— 贴边时留缝。
//
// ── 22% 这个数是怎么来的（v3.6，从 17% 提上来）──
// 17% 是当初"三档缩放"时拍的，那时小档字号 9.7px、气泡两行也塞得下。
// 加到五档之后这条比例就不成立了：气泡的字号与内距都有一个**可读性下限**
// （字号 ≥ 10.5px、内距 ≥ 5px/6px），下限是绝对像素、不跟着窗口缩，
// 于是"小档需要的比例"远大于"大档需要的比例"：
//     极小档需要 3+48 = 51px = 窗口宽的 21.8%，而特大档只需要 10.8%。
// 按大档拍比例，小档必然压头发 —— 这不是猜的，tools/measure_bubble.py
// 扩到五档后当场量出来（极小档气泡底边 48px > 留白 39.8px）。
// 取 22% 覆盖五档里最苛刻的那一档；因为窗口位置是**以底边为锚**的
// （applyScale / enforceSize / groundYOf 三处都是），加高的部分全部向上生长，
// 角色的屏幕位置与显示大小都不动。
const BASE_W = 404;
const PET_H = 400;                    // 角色显示高度（基准档）
const TOP_PAD_RATIO = 0.22;           // 顶部留白 / 窗口宽。与 pet.css 的 #petArea 同源，selftest 比对
const BASE_H = PET_H + Math.round(BASE_W * TOP_PAD_RATIO);      // = 489，窗口高

// ── 素材约束：卡**宽高比**，不卡绝对宽高（v3.4 起）──
// 原来这里是 `PET_MAX_SPRITE_W = BASE_W * RENDER_H / PET_H`（带一个写死的 RENDER_H=560）。
// 那个式子的本意是"显示宽不能超出窗口"，但它把结论写成了**绝对像素**，
// 于是隐含了一个前提：所有素材都恰好 560 高。v3.4 的素材重制打破了这个前提 ——
// 规则改成「用满源、不放大」，输出高 = min(800, 源可用高)，四套分别是
// 800 / 800 / 762 / 790（各套源分辨率本来就差得远）。
// 绝对宽度上限立刻失效：再按 565 去卡，冬大衣和冬装会被误判成超限。
//
// 而约束的本意从来跟高矮无关：
//     显示宽 = 素材宽 × (PET_H / 素材高) ≤ BASE_W
//   ⇒ 素材宽 / 素材高 ≤ BASE_W / PET_H
// 所以改成判**比值** —— 它同时更严格（任何高度下都成立）也更不脆（换素材不用改这个数）。
const PET_MAX_ASPECT = BASE_W / PET_H;                          // ≈1.01，超出就会被窗口裁掉发梢

// 三档大小。缩放只改窗口尺寸，sink / 地面线 / 位置约束都跟着 winSize() 走，
// 所以放大缩小以后落点依然正确（不会因为换了尺寸就沉进任务栏或悬空）。
// v3.6：三档 → 五档。**既有的三档数值一个都没动**（small/medium/large 的
// 0.72 / 1 / 1.28 原样保留），只在两头各加一档。
// 为什么不顺手把三档调均匀：用户存的是**档位名**，改数值等于在用户不知情时
// 挪了她的大小。加档只用新名字，既有人的画面一像素都不会变。
//   tiny 0.58 —— "挂着但不占地方"（窗口 234×272）
//   huge 1.58 —— "想看清表情"（窗口 638×741）
// 加档带出来的真问题不在窗口尺寸，而在**顶部的字**：气泡字号是 3.35cqw
// （窗口宽度的百分比），缩到 0.58 时只有 7.8px（读不了），放到 1.58 时有 21px（过大）。
// 所以 pet.css 那边同步给字号加了 clamp 上下限，两处必须成对改。
const SIZES = { tiny: 0.58, small: 0.72, medium: 1, large: 1.28, huge: 1.58 };
let petScale = SIZES.medium;

const DATA_DIR = () => app.getPath('userData');

// 每个服装的"入地"像素：素材以底边对齐（窗口底边 == 图像底边）。
//
// 四套**全都是半身像** —— 参考图本身就在大腿处切断，原画没画脚
// （冬装那张看着像全身，其实原图底部就是"裙摆 + 大腿 + 长袜"的切面）。
// 所以四套统一 sink = 40：把这刀切面沉到任务栏后面去。
// 少了它，切面会明晃晃地横在任务栏上沿，像立在桌面上的一截纸片。
//
// 真·全身像（脚底是自然收尾）才该用 0 —— 那时脚正好踩在工作区底边。
// 表留着就是为了记住这个区分，别再把半身像填成 0。
//
// 注意 sink 是**屏幕物理量**（任务栏高度），不随缩放变 —— 角色放大后
// 切口仍在窗口底边，遮挡关系和原来一样。
const OUTFIT_SINK = { maid: 40, sailor: 40, coat: 40, winter: 40 };
const sinkOf = (k) => OUTFIT_SINK[k] || 0;

// ---------- 素材尺寸表 ----------
// 主进程必须知道每套素材的宽高比。原因：横向约束夹的是**角色外轮廓**而不是
// 窗口矩形（见 clamp.js 的 padX），而角色在窗口里是水平居中的，
// 所以要算出两侧各有多少透明边。
// 只读 PNG 头就够了 —— IHDR 里宽高各占 4 字节，偏移 16 / 20。
// ★ 用 openSync + 读 24 字节，而不是 readFileSync：四套素材加起来约 2MB，
//   为了读 24 个字节把它们整个读进内存是纯浪费（而且是在启动路径上）。
function pngSize(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(24);
    if (fs.readSync(fd, b, 0, 24, 0) < 24) return null;
    if (b.readUInt32BE(0) !== 0x89504e47) return null;
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  } catch (e) {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* 忽略 */ } }
  }
}
const SPRITE = {};
for (const k of Object.keys(OUTFIT_SINK)) {
  const s = pngSize(path.join(__dirname, 'assets', 'sprites', k + '.png'));
  if (s) SPRITE[k] = s;
}
// 角色显示高度（基准档 × 缩放）。窗口比它高 TOP_PAD —— 那一条里没有角色，
// 所以凡"按高度撑满"的换算都用这个，别用 winSize().h。
const petDisplayH = () => Math.round(PET_H * petScale);

// 角色显示宽（素材按 height:100% 落位在 #petArea 里，故显示宽 = 素材宽 × 角色高 / 素材高）
// 参数是**角色显示高度**，不是窗口高度 —— 窗口顶部那一截留白里没有角色。
function spriteDisplayW(outfit, displayH) {
  const s = SPRITE[outfit];
  if (!s || !s.h) return 0;
  return s.w * (displayH / s.h);
}
// 两侧的透明边。夹取时把它放到屏幕外，角色才能真正贴住屏幕边缘。
// ⚠ 它按 winSize().w 算，而那个数比窗口真实内容宽小 0~4px（见上面 winSize 的注释），
//   所以贴边时她可能停在离屏幕边 4px 处 —— 已知、已知原因、暂不修。
function padXOf(outfit) {
  const sw = spriteDisplayW(outfit, petDisplayH());
  if (!sw) return 0;
  return Math.max(0, Math.round((winSize().w - sw) / 2));
}

let petWin = null, statsWin = null, tray = null;
let pinned = true;
let currentOutfit = 'maid';
let blockMode = false, blockUntil = 0;   // 拖拽 / 重载期间暂停巡检，避免打架
// 点击穿透的运行时状态。声明在这里（而不是使用它们的那一节）是为了让
// createPet 里"建窗时就先穿透"那两行读起来不需要往回翻。
let hitArea = null;        // 渲染层上报的可交互矩形（窗口本地 CSS px，{l,t,r,b}）
let passthrough = null;    // 当前已设置的穿透态；null = 还没设过
let menuOpen = false;      // 原生右键菜单弹出期间：挂起穿透判定

// 窗口尺寸 —— ★ 这是"我们**请求**的尺寸"，不等于"窗口**实际**的尺寸"。
//
// 实测（Windows / 150% 缩放，v3.10 用 tools/probe_v38.js 量的）：请求 404×489，
// 实际内容宽更大，而且**每调一次 petWin.setPosition 就涨 1px**：
//   408 → 409 → 410 → 411 → 412，到 412 停住（物理像素取整所致，1 DIP = 1.5 px）。
// 两个后果，都已实测、都不是"看起来在动"那么严重：
//   ① padXOf() 按这里的 404 算出来的 padX，比真实的两侧透明边少 0~4px。
//      表现：贴边站立时她停在离屏幕边最多 4px 处。收边时那 178px 的推出量把这 4px
//      完全盖住，只有"取消收边"之后才看得出来 —— 也正因如此，它躲了很多轮验收。
//   ② enforceSize() 里的 `b.width !== w` 因此**永远成立**：每 20 秒都会白跑一次
//      setSize + setPosition。而 setPosition 又会把宽度再推 1px —— 这是个自持的小环，
//      但已实测它有界：位置不漂移（x 稳定），宽度停在 412 不再涨。
//
// 本轮（v3.10）**刻意不改口径**：夹取 / 贴边 / 投掷三条路径全部建立在这个数上，
// 改成"读真实内容尺寸"要连 selftest、验收图、README 的几何章节一起动，
// 而收益是 4px（视觉上看不出来）。写在这里是为了让下一个人知道 404 不是精确值，
// 而不是让他自己再量一遍。要改的话先从 padXOf() 和 clampInto 的调用点入手。
const winSize = () => ({
  w: Math.round(BASE_W * petScale),
  h: Math.round(BASE_H * petScale)
});

// ---------- 位置约束 ----------
// 桌宠绝不允许离开屏幕。一旦离开，用户除了手改配置文件没有任何办法叫回来
// （它不在任务栏、没有窗口列表入口）。所以**所有** setPosition 都必须先过这里。
//
// 用 workArea 而不是 workAreaSize：前者带 x/y，多显示器/任务栏在左侧时才算得对。
let waCache = null;
function workAreaFor(x, y) {
  // moveTo 每次 mousemove 都会被调用（~60/s），getDisplayNearestPoint 是原生调用，
  // 不缓存的话拖拽会明显发涩。落在上次结果范围内就直接复用。
  if (waCache &&
      x >= waCache.x - 64 && x <= waCache.x + waCache.width + 64 &&
      y >= waCache.y - 64 && y <= waCache.y + waCache.height + 64) return waCache;
  waCache = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }).workArea;
  return waCache;
}
function clampPos(x, y, outfit) {
  const { w, h } = winSize();
  const of = outfit || currentOutfit;
  return clampInto(x, y, workAreaFor(x, y), w, h, sinkOf(of), padXOf(of));
}
function moveToClamped(x, y) {
  if (!petWin || petWin.isDestroyed()) return null;
  const p = clampPos(x, y, currentOutfit);
  petWin.setPosition(p.x, p.y);
  return p;
}
function groundYOf(display, outfit) {
  const wa = display.workArea;
  return wa.y + wa.height - winSize().h + sinkOf(outfit);
}
// 换装 / 缩放后地面线与窗口尺寸都会变，把窗口按新约束拉回合法位置
// ★ 迷你模式（贴边）下走 applyEdgePos：她的角色轮廓本来就该有一部分在屏幕外，
//   按常规约束"拉回屏幕内"等于每次换装/缩放都把她从边上拽出来一次。
function resnap() {
  if (!petWin || petWin.isDestroyed()) return;
  if (edgeMode) { applyEdgePos(); return; }
  // ★ 栖息中：位置归前台窗口管（perchAt）。这里**只重贴、不夹取** ——
  //   她正踩在窗口上沿，按桌面约束夹取会把她从窗口上拽下来。
  //   换装 / 缩放会改她的宽度，所以要立刻重贴（不能等下一拍，那会先错位再跳回来）。
  if (perchOn) {
    if (fgTarget) perchAt(fgTarget.win, fgTarget.work);
    else fgKey = '';
    return;
  }
  const b = petWin.getBounds();
  moveToClamped(b.x, b.y);
}

// 改窗口尺寸，**以底边 + 水平中心为锚**。
// 以顶边为锚会让人物在放大时往上蹿、缩小时沉进任务栏；
// 以底边为锚则"脚一直踩在原地"，符合直觉。
function applyScale(next) {
  petScale = SIZES[next] ? SIZES[next] : SIZES.medium;
  if (!petWin || petWin.isDestroyed()) return;
  const b = petWin.getBounds();
  const cx = b.x + b.width / 2;
  const bottom = b.y + b.height;
  const { w, h } = winSize();
  if (b.width === w && b.height === h) return;
  petWin.setMinimumSize(1, 1);        // 窗口是 resizable:false，先松绑再改尺寸
  petWin.setSize(w, h);
  petWin.setPosition(Math.round(cx - w / 2), Math.round(bottom - h));
  resnap();
}

// ---------- 几何自愈 ----------
function enforceSize() {
  if (!petWin || petWin.isDestroyed()) return;
  if (blockMode && Date.now() < blockUntil) return;
  const b = petWin.getBounds();
  const { w, h } = winSize();
  if (b.width !== w || b.height !== h) {
    // 以**底边**为锚还原：角色站在地面上，按顶边还原会让她沉进任务栏或浮到半空。
    // （winSize() 已经把当前缩放档算进去了，所以这一条同时也自愈"缩放没生效"。）
    const bottomY = b.y + b.height;
    petWin.setMinimumSize(1, 1);
    petWin.setSize(w, h);
    petWin.setPosition(Math.round(b.x + (b.width - w) / 2), Math.round(bottomY - h));
  }
  // 位置也要自愈。只还原尺寸是不够的：窗口若是被拖到屏幕外（或被 DWM 挪出去），
  // 尺寸完全正常、巡检却看不出任何问题，用户就只能看到桌宠凭空消失了。
  // ★ 迷你模式例外：她本来就该有一部分在屏幕外。这里若照常夹取，
  //   20 秒一次的巡检会把她从边上拽出来 —— 表现为她在边缘来回抽动。
  //   所以贴边时位置交给 applyEdgePos 全权负责（它算的就是"该在屏幕外多少"）。
  if (edgeMode) { applyEdgePos(); return; }
  // ★ 栖息中：位置归前台窗口（perchAt），这一拍只负责尺寸那一半。
  //   照常夹取的话，20 秒一次的巡检会把她从窗口上拽下来一次 —— 表现是周期性抽动。
  if (perchOn) { resnap(); return; }
  const b2 = petWin.getBounds();
  const p = clampPos(b2.x, b2.y, currentOutfit);
  if (p.x !== b2.x || p.y !== b2.y) petWin.setPosition(p.x, p.y);
}

function createPet() {
  const d = screen.getPrimaryDisplay();
  const wa = d.workArea;
  const { w, h } = winSize();
  // 位置也持久化：不然每次重启都回到右上角，用户拖动过的位置白拖了。
  // 存档里同时有左上角 y 和**底边** bottom，这里优先按底边还原 —— 理由见 pet:savePos。
  // 老存档没有 bottom 字段，退回按 y 落位（v3.6 之前的行为）。
  const saved = loadJSON(setFile(), {}).pos;
  const start = saved
    ? clampPos(saved.x, Number.isFinite(saved.bottom) ? saved.bottom - h : saved.y, currentOutfit)
    : {
        x: Math.max(wa.x, wa.x + wa.width - w - 60),
        y: groundYOf(d, currentOutfit)      // 落地位置与"拖拽松手"用的是同一条地面线
      };
  // 启动时若还在勿扰时段（比如"到明天早上"之后被开机自启拉起来），直接不显示 ——
  // 先 show 再 hide 会闪一下，而这一下正好在最安静的时刻。
  const quietAtStart = quietUntil() > Date.now();
  petWin = new BrowserWindow({
    width: w, height: h,
    x: start.x,
    y: start.y,
    show: !quietAtStart,
    transparent: true, frame: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    focusable: true, fullscreenable: false, maximizable: false, minimizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // 被别的窗口遮挡时 rAF/timer 不被节流（Chromium 的遮蔽检测会把置顶窗口也判成被遮，
      // 不关掉它她会"卡住不动"）。⚠ 代价是实打实的：这个开关**也会影响 Page Visibility API**，
      // 所以 win.hide() 之后渲染层的 document.hidden 依然是 false ——
      // 她藏起来时渲染层不会自己停，得靠主进程的 quiet 显式冻住，见 renderer/pet.js 的 setFrozen。
      backgroundThrottling: false,
      contextIsolation: true, nodeIntegration: false
    }
  });
  quietAnnounced = quietAtStart;
  petWin.setAlwaysOnTop(true, 'screen-saver');
  // 建窗即穿透。渲染层还没上报可交互区（hitArea 为 null），此时整窗都不该接鼠标 ——
  // 否则"启动那一刻鼠标恰好压在窗口上"会白吞一次点击。
  // 之后由 120ms 的光标巡检按事实把它切回来，见"透明区点击穿透"一节。
  petWin.setIgnoreMouseEvents(true, { forward: true });
  passthrough = true;
  petWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  petWin.on('closed', () => { petWin = null; passthrough = null; hitArea = null; });

  setInterval(() => applyQuiet(), 15000);                // 15s 查一次勿扰是否到点
  setInterval(() => { enforceSize(); reassertPassthrough(); }, 20000);  // 20s 几何 + 穿透巡视
  setInterval(pollIdle, 5000);                           // 5s 查一次"你在不在"（原生调用，代价极低）
  setInterval(healthTick, 10000);                        // 10s 走一拍健康提醒的计时
  // 托盘悬停里的"下次提醒 X 分钟后"会随时间变，而**托盘菜单建好就定住了**
  // （Electron 没有"菜单将要弹出"这类事件，重建 setContextMenu 有可能把正开着的菜单顶掉），
  // 所以会随时间漂的信息只挂 tooltip 这一条路。
  setInterval(() => { if (tray && !tray.isDestroyed()) tray.setToolTip(trayTip()); }, 60000);
  startCursorFeed();                                     // 120ms 全局光标（内部自带去重与收敛条件）
  // 1s 前台窗口（全屏检测 / 窗口栖息 / 环境感知）。★ 它**故意不带可见性闸门**：
  // 带上就会死锁 —— 因全屏而藏 -> 不轮询 -> 检测不到"已退出全屏" -> 永远回不来。
  startFgFeed();
  setInterval(() => {                                     // 10min 重申置顶
    // ★ 必须带可见性闸门。**moveTop() 会把隐藏的窗口重新显示出来**
    //   （本机 Electron 33 实测：hide() 之后调 moveTop()，isVisible() 立刻变回 true；
    //     setAlwaysOnTop / setSize / setPosition / setEnabled / focus 都不会）。
    //   少了这一条，"到明天早上 8 点"这种长勿扰会被这里每 10 分钟拉出来一次 ——
    //   而那时穿透判定已经因为"她藏起来了"而停工，于是她看得见、点不到、也关不掉。
    if (petWin && !petWin.isDestroyed() && petWin.isVisible() && pinned) {
      petWin.setAlwaysOnTop(true, 'screen-saver');
      petWin.moveTop();
    }
  }, 10 * 60 * 1000);

  const revive = () => setTimeout(() => {                 // 系统事件自愈
    if (!petWin || petWin.isDestroyed()) return;
    petWin.setEnabled(true);
    enforceSize();                       // 几何自愈：藏起来期间也可能被 DWM 改过尺寸/位置
    // 同上：醒来 / 解锁时她可能正藏着（勿扰"到明天早上 8 点"必然跨过一夜的睡眠），
    // 这时绝不能动 z 序 —— 同一条实测结论。
    if (!petWin.isVisible()) return;
    if (pinned) petWin.setAlwaysOnTop(true, 'screen-saver');
    petWin.moveTop();
  }, 1500);
  powerMonitor.on('resume', revive);
  powerMonitor.on('unlock-screen', revive);
}

// ---------- 持久化 ----------
function loadJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { return def; }
}
function saveJSON(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  } catch (e) { /* 静默：写不进去不该让桌宠崩掉 */ }
}
const pomFile = () => path.join(DATA_DIR(), 'pomodoro_records.json');
const setFile = () => path.join(DATA_DIR(), 'settings.json');
const readSettings = () => loadJSON(setFile(), { outfit: 'maid', pinned: true, scale: 'medium' });
function patchSettings(patch) {
  const next = Object.assign(readSettings(), patch);
  saveJSON(setFile(), next);
  return next;
}

// ---------- 「上次她在」的时刻（久别重逢用）----------
// 存的是主进程最后一次确认"我还活着"的时间，**不是**"你离开"的时间 ——
// 桌宠无从知道用户什么时候离开键盘，能确定的只有自己跑到过哪一刻。
// 两个时刻相减 = "她独处了多久"，这个近似足够支撑问候分档（分档跨度是小时/天）。
//
// ⚠ 读取必须排在写入**之前**。启动时若先把此刻写进去，渲染层拿到的差值恒为 0，
//   久别重逢永远不触发 —— 而且这个 bug 完全静默：问候照常出现，只是永远走
//   "普通问候"那一支，看日志、看截图都发现不了。所以 prevSeenAt 在 whenReady
//   里先把旧值读出来存住，再 markSeen。
let prevSeenAt = 0;
const SEEN_KEY = 'lastSeenAt';
function markSeen() { patchSettings({ [SEEN_KEY]: Date.now() }); }

// ---------- 羁绊（互动累积）----------
// 注意这不是一份"数值面板"，而是**解锁内容**的进度条：升一级多几句台词，
// 而那些台词写的是"她越来越不设防"。所以这里只管记分，
// 展示全部交给菜单里那一行进度 + 升级时的演出。
//
// 计分表。`cd` 是**冷却毫秒**：同一个动作在冷却期内重复做不计分。
// 没有冷却的话"狂点"就是最优解，一天就能刷满 —— 等级随即失去意义。
// 权重按互动质量给：点一下最轻，坚持做完一个番茄钟最重（它才是真的陪你坐了 30 分钟）。
const BOND_GAIN = {
  click:      { gain: 1,  cd: 3000 },
  dblclick:   { gain: 3,  cd: 3000 },
  pat:        { gain: 4,  cd: 8000 },
  drop:       { gain: 2,  cd: 10000 },
  walk:       { gain: 1,  cd: 60000 },
  outfit:     { gain: 1,  cd: 30000 },
  pomDone:    { gain: 10, cd: 0 },
  pomAbandon: { gain: 1,  cd: 0 }
};

// 档位。阈值是**累计分**，严格递增（selftest 卡这条）。
// 数值按"每天用一会儿"估：随手点几下 + 一两个番茄钟 ≈ 15~25 分/天，
// 满级 650 大约一个多月 —— 再快就没有养成的意思，再慢就永远看不到反馈。
const BOND_LEVELS = [
  { lv: 1, name: '生疏',       at: 0 },
  { lv: 2, name: '认得',       at: 30 },
  { lv: 3, name: '认可',       at: 90 },
  { lv: 4, name: '信赖',       at: 200 },
  { lv: 5, name: '亲近',       at: 380 },
  { lv: 6, name: '唯一的例外', at: 650 }
];

const affFile = () => path.join(DATA_DIR(), 'affinity.json');
function levelOf(points) {
  let hit = BOND_LEVELS[0];
  for (const L of BOND_LEVELS) if (points >= L.at) hit = L;
  return hit;
}
function readAffinity() {
  const a = loadJSON(affFile(), {});
  return {
    points: (Number.isFinite(a.points) && a.points > 0) ? Math.floor(a.points) : 0,
    gains: (a.gains && typeof a.gains === 'object') ? a.gains : {}
  };
}
// 渲染层 / 菜单要的完整快照。
// 等级**永远从分数现算、不落盘** —— 同一个事实存两份，迟早会漂。
function bondSnapshot(a) {
  const cur = levelOf(a.points);
  const next = BOND_LEVELS.find((L) => L.at > cur.at);
  return {
    points: a.points,
    level: cur.lv, levelName: cur.name,
    nextAt: next ? next.at : null, nextName: next ? next.name : null
  };
}
// 记一次分。冷却中就返回 gain=0 —— 渲染层据此**不给任何反馈**。
// （给了反馈却不加分，等于骗人；玩家会觉得"点了没用"。）
function addBond(action) {
  const rule = BOND_GAIN[action];
  if (!rule) return Object.assign(bondSnapshot(readAffinity()), { gain: 0, leveledUp: false });
  const a = readAffinity();
  const now = Date.now();
  const last = Number(a.gains[action]) || 0;
  if (rule.cd && now - last < rule.cd) {
    return Object.assign(bondSnapshot(a), { gain: 0, leveledUp: false, cooling: true });
  }
  const before = levelOf(a.points).lv;
  a.gains[action] = now;
  a.points += rule.gain;
  saveJSON(affFile(), a);
  const snap = bondSnapshot(a);
  return Object.assign(snap, { gain: rule.gain, leveledUp: snap.level > before });
}
function bondLabel() {
  const s = bondSnapshot(readAffinity());
  return s.nextAt === null
    ? `羁绊 Lv.${s.level} · ${s.levelName}（已满）`
    : `羁绊 Lv.${s.level} · ${s.levelName}　${s.points} / ${s.nextAt}`;
}

// ---------- 勿扰（安静一会儿）----------
// 需求：看全屏视频 / 打游戏时别挡着。Electron **没有**"当前有没有全屏应用"的 API，
// 自动检测只能轮询前台窗口（得定期起子进程，周期性开销 + 各种边界情况）。
// 这里选了**手动开关**：零轮询、零不确定性，代价是要自己按一下。
// （取舍写在 README 里，将来想换自动检测时不用重新论证。）
//
// ── 这条不变量是整节的宪法：**勿扰 ⟺ 窗口不可见** ──
// 于是"她该不该藏着"永远由两件事现算出来：设置里的 quietUntil、以及
// petWin.isVisible()。**没有任何缓存布尔值参与判断**（架构原则 1）。
//
// v3.7 之前这里缓存了一个 quietHidden，而它正是那个 bug 的放大器：
//   ① 10 分钟一次的置顶巡检与"睡眠/解锁唤醒自愈"都无条件调 moveTop()，
//      而 moveTop() **会把隐藏的窗口重新显示出来**（实测）。于是长勿扰里
//      她每 10 分钟（或每次解锁）冒出来一次。
//   ② 缓存说"她藏着呢"，于是穿透判定与目光跟随双双提前 return，
//      鼠标策略再也没人按事实重算 —— 冻在隐藏前那一刻的值（从托盘进勿扰时
//      通常就是"穿透"）。两件事叠起来就是用户看到的那句：
//      **"勿扰时她还在，而且点不到、也关不掉。"**
// 所以现在：可见性一律问 isVisible()，缓存只留一个用途 —— 记住"上一次通知渲染层是什么"，
// 免得 15s 轮询每拍给她塞一次"我回来了"。
let quietAnnounced = false;                    // 上一次告诉渲染层的勿扰状态
// 进入勿扰时**先让她把"我出去了"说完再藏**（藏完再说等于没说）。
// 这个延迟与 pet.js 的 QUIET_BYE_MS 是**配对**的：必须大于那句台词的显示时长。
// 两处都在 selftest 里被读出来比对，改一个不改另一个会被拦住。
const QUIET_HIDE_DELAY = 1500;

function nextMorning8() {
  const d = new Date();
  d.setHours(8, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);   // 已经过 8 点了就顺延到明天
  return d.getTime();
}
const quietUntil = () => Number(readSettings().quietUntil) || 0;
// 「手动勿扰」= 用户在菜单里说"安静一会儿"。**只有它有时间戳**（到几点为止）。
const manualQuiet = () => quietUntil() > Date.now();
// 「全屏自动躲起来」的开关（默认开）。v3.12 之前这里只有手动一条路，
// 理由写在上面那段老注释里（Electron 没有全屏检测 API）。现在有能力了就补上。
const autoQuietOn = () => readSettings().autoQuiet !== false;
// 前台是不是真全屏 —— 由 1s 的前台窗口轮询维护。
// ⚠ 这是本文件里**唯一**允许存在的"缓存真值"，因为它没有第二个来源
//   （不像可见性可以随时问 petWin.isVisible()）。所以它的写点必须唯一：
//   只有 fgPoll 那一个地方能改它，改完立刻 applyQuiet()。
let fgFullscreen = false;
// 她此刻**该不该藏** —— 手动 or 自动。★ 所有判断都必须走这个词：
// 直接看 quietUntil() 的话，全屏自动躲起来这条路就绕过了
// "勿扰 ⟺ 窗口不可见"那条宪法（她会被藏起来，但穿透/巡检/菜单都以为她该在）。
// **每次现算**，不存副本 —— 存了就会漂（见上面那段）。
const quietActive = () => manualQuiet() || (autoQuietOn() && fgFullscreen);
// 音效开关。默认**开**（缺省值视为开）—— 它是这个功能的一部分，
// 默认关掉的话等于没做。音量本身已经压得很低，真嫌吵可以一键关。
const sfxOn = () => readSettings().sfx !== false;

function setQuiet(until) {
  patchSettings({ quietUntil: until || 0 });
  applyQuiet();
  refreshTray();
  return quietUntil();
}

// 把窗口对齐到"勿扰说了算"的那个状态。三处调用：改设置、15s 轮询、启动确认。
//
// 为什么不需要 sync 参数：**通知渲染层是按"上一次通知了什么"去重的**，
// 而不是按"这次调用是不是用户动作"。所以用户动作必然改变状态 -> 必然通知；
// 轮询到状态没变 -> 必然不通知。两件事一个式子就说清了。
function applyQuiet() {
  if (!petWin || petWin.isDestroyed()) return;
  const active = quietActive();
  const manual = manualQuiet();

  if (active) {
    // 已经在显示 -> 该藏；本来就藏着（启动时就没显示 / 上一拍已藏好）-> 不用动。
    // 1.5s 之后**再确认一次**：这期间她可能已经被叫回来了（或勿扰被取消）。
    if (petWin.isVisible()) {
      // ★ 手动勿扰：先让她把"我出去了"说完再藏（藏完再说等于没说），
      //   这个延迟与渲染层 pet.js 的 QUIET_BYE_MS 是**配对**的。
      // ★ 自动勿扰（全屏）：**不说告别、不延迟**。看全屏视频时她突然开口说话
      //   比直接消失更烦人，而"消失"正是用户此刻想要的。
      const hideNow = () => {
        if (quietActive() && petWin && !petWin.isDestroyed()) petWin.hide();
      };
      if (manual) setTimeout(hideNow, QUIET_HIDE_DELAY);
      else hideNow();
    }
  } else if (!petWin.isVisible()) {
    // 到点了（或用户取消勿扰 / 退出全屏）：回来。这一支按**事实**进 —— 无论她是被这一拍
    // 放出来的、还是被别的路径遗留在隐藏态，都会在这里被拉回可见。
    petWin.show();
    if (pinned) petWin.setAlwaysOnTop(true, 'screen-saver');
    petWin.moveTop();                    // 此时她确实要露面，动 z 序是对的
    markShown();
    // 她刚回来，穿透态按此刻的事实重新定一次（藏起来期间没人在维护它）。
    // 放到下一拍也不是不行，但"点托盘显示雪乃"之后的第一秒正是最容易点到她的
    // 时刻，这一秒不值得省。
    reassertPassthrough();
  }
  if (active !== quietAnnounced) {
    quietAnnounced = active;
    // ⚠ 从 v3.12 起 payload 是**对象**而不是"until 时间戳"（渲染层同时兼容数字，
    //   但主进程这边只发对象）。三个字段各有各的用途，别再合并回一个数：
    //     active —— 她该不该藏（手动 or 自动）
    //     until  —— 手动档的截止时刻；自动档恒为 0（它没有"到几点为止"）
    //     bye    —— **要不要说那句告别**。只有手动才说，理由见上面。
    send('quiet', { active, until: manual ? quietUntil() : 0, bye: manual });
    // 托盘菜单也得跟着变：否则"到明天早上 8 点"到点自动回来之后，
    // 托盘里还挂着那条「现在就回来」、三个新的勿扰档位还是灰的 —— 菜单在说假话。
    refreshTray();
  }
}

function quietSubmenu() {
  // ★ 这里判的是**手动档**（manualQuiet）而不是"她此刻藏没藏"：
  //   全屏自动躲起来的时候她也是藏着的，但那不该把这三个档位变灰 ——
  //   用户完全可以一边全屏一边再手动加一档。
  const q = manualQuiet();
  const items = [
    { label: '15 分钟', click: () => setQuiet(Date.now() + 15 * 60 * 1000), enabled: !q },
    { label: '1 小时', click: () => setQuiet(Date.now() + 60 * 60 * 1000), enabled: !q },
    { label: '到明天早上 8 点', click: () => setQuiet(nextMorning8()), enabled: !q }
  ];
  // 已经在手动勿扰里就补一条"现在就回来" —— 否则右键菜单点开只有三个灰掉的项，像坏了。
  // （自动档没有"现在就回来"：那不归手动管，退出全屏她自己就回来了。）
  if (q) items.push({ type: 'separator' }, { label: '现在就回来', click: () => setQuiet(0) });
  return items;
}

// ---------- 打扰等级（话痨程度）----------
// 三档，管的是**她主动开口**的频率，不是"她在不在"：
//   quiet   只在"你主动找她"时开口。生活流的自言自语、主动靠近、打字搭话全停；
//           但她照样会动、会看书、会看窗外 —— 关掉的是"她在说话"，不是"她还在"。
//   normal  默认。与 v3.7 的手感**完全一致**（这一档一个数都没改）。
//   lively  更爱冒泡：链间静默缩短、主动靠近更频繁。
//
// 为什么不复用"勿扰"：勿扰是让她**消失**（看全屏视频时不想被挡着），
// 而"我今天想安静点但还是想看见她"是另一件事，两者可以同时存在。
// 所以是两份状态，不是一份的两个值。
//
// ★ 判据只活在一个地方 —— 渲染层。她能做什么、什么时候开口，全是渲染层的事；
//   主进程只负责**存**（settings.json）和**透传**（值改了就 send 一条）。
//   主进程这边**不缓存**当前档位：多一份镜像就多一处会和事实漂开的地方，
//   而这三个字的所有作用都发生在渲染层，主进程拿到它没有任何用处。
const CHATTER_KEYS = [
  ['quiet', '安静'],
  ['normal', '适中'],
  ['lively', '活泼']
];
const CHATTER_NAMES = { quiet: '安静', normal: '适中', lively: '活泼' };
function chatterOf() {
  const v = readSettings().chatter;
  return CHATTER_KEYS.some(([k]) => k === v) ? v : 'normal';
}
function setChatter(k) {
  const v = CHATTER_KEYS.some(([x]) => x === k) ? k : 'normal';
  patchSettings({ chatter: v });
  send('chatter', v);
  refreshTray();
  return v;
}

// ---------- 健康提醒（久坐 / 喝水 / 护眼）----------
// 形态：**抬头说一句就走**。这是同类工具里最被认可的非侵入式做法 ——
// 不弹系统通知、不抢焦点、不动窗口位置。她停下手上的事、抬头说一句、放个表情，
// 然后回去做自己的事。
//
// 三类提醒共用一套计时，各自独立开关：
//   · **只在"你确实在"的时候累计**。你不在，提醒给谁看；你回来了，
//     说明你刚活动过 —— 久坐与喝水从头算（护眼同理，你眼睛也歇过了）。
//   · 到点提醒一次就**清零重来**，不做"每五分钟催一次"。被吐槽最多的
//     恰恰就是"关不掉 + 反复弹"。
//   · 累计用**实际时间差**，不是"每次加 10 秒"。定时器会被系统调度拖慢，
//     45 分钟下来能差出好几分钟，而"说好 45 分钟"就是它的全部信用。
//   · 单拍封顶 30 秒：系统休眠唤醒后 dt 可能是几小时，不封顶会一口气连发三条。
//
// 为什么计时在主进程而不是渲染层：① 系统空闲只有主进程问得到；
// ② 托盘悬停要显示"下次什么时候提醒"，而渲染层在被冻住（勿扰）时不工作，
// 那时托盘照样该说得准。
const HEALTH_RULES = {
  sit:   { ms: 45 * 60 * 1000, label: '久坐' },
  water: { ms: 60 * 60 * 1000, label: '喝水' },
  eye:   { ms: 20 * 60 * 1000, label: '护眼' }
};
let healthAccum = { sit: 0, water: 0, eye: 0 };
let healthTickAt = Date.now();
// 默认全开。缺省值视为开，与 sfx / typing 的读法一致 ——
// 默认关掉的"可选功能"等于没做，而每一项都能一键关。
function healthOn(k) {
  const h = readSettings().health;
  return !h || h[k] !== false;
}
function setHealth(k, on) {
  if (!HEALTH_RULES[k]) return false;
  const cur = Object.assign({}, readSettings().health);
  cur[k] = !!on;
  patchSettings({ health: cur });
  resetHealth();                 // 刚开/刚关：计时从零起，别让她"打开后一秒就催"
  refreshTray();
  return cur[k];
}
function resetHealth() {
  for (const k of Object.keys(healthAccum)) healthAccum[k] = 0;
  healthTickAt = Date.now();
}
function healthTick() {
  const now = Date.now();
  const dt = Math.min(now - healthTickAt, 30000);
  healthTickAt = now;
  if (!petWin || petWin.isDestroyed()) return;
  // ★ 整拍只读一次设置。healthOn() / quietActive() 各自都会去 loadJSON，
  //   而那是一次**同步读盘** —— 分开写就是每 10 秒读四次文件。
  //   文件很小、OS 也有缓存，所以这不是性能事故，是白给的开销：
  //   它唯一的来源只是"顺手用了现成的函数"。同一拍里的事实读一次就够。
  //   （healthOn 本身保留 —— 菜单和托盘那边按需调用，那里读得很少。）
  const s = readSettings();
  if (!userActive) return;                    // 你不在：不累计（提醒没有意义）
  if (Number(s.quietUntil) > now) return;     // 她藏着：隔着隐藏窗口说给谁听
  const h = s.health;
  for (const k of Object.keys(HEALTH_RULES)) {
    if (h && h[k] === false) continue;        // 这一项被关掉了
    healthAccum[k] += dt;
    if (healthAccum[k] >= HEALTH_RULES[k].ms) {
      healthAccum[k] = 0;        // 提醒过就重新计时（不是"再等 5 分钟"）
      send('health', k);
    }
  }
}
// 最快到点的那一类，给托盘悬停用。全关了就返回空串。
function nextHealthText() {
  let best = null;
  for (const k of Object.keys(HEALTH_RULES)) {
    if (!healthOn(k)) continue;
    const left = HEALTH_RULES[k].ms - healthAccum[k];
    if (!best || left < best.left) best = { k, left };
  }
  if (!best) return '';
  return `下次提醒 ${HEALTH_RULES[best.k].label} ${Math.max(1, Math.round(best.left / 60000))} 分钟后`;
}

// ---------- 空闲检测（你到底在不在）----------
// powerMonitor.getSystemIdleTime() 是 Electron 原生的，返回**系统层面**多少秒
// 没有输入（键盘 + 鼠标，不管焦点落在哪个窗口）。这是"你在不在"唯一可靠的来源。
//
// 在此之前，她说"你在不在"靠的是"你多久没点她"。混起来的后果在设计上说不通：
// 你在隔壁窗口连写两小时代码、一下没碰她 —— 按旧判据她早该睡了两小时，
// 而她其实一直在旁边陪着你。v3.8 把这两件事分开了（见 pet.js 的 sleepCheck）。
//
// 为什么阈值是 2 分钟：再短，"看一会儿视频 / 读一会儿文档"就会被误判成离开，
// 于是她会睡、健康提醒会暂停 —— 而那些恰恰是你**确实坐着**的时候。
// 再长，"去接杯水"就漏掉了，久坐计时不会被清零。
const IDLE_AWAY_SEC = 120;
let userActive = true;             // 你此刻坐在电脑前吗
let awaySince = 0;                 // 你开始离开的时刻（0 = 没离开）

function pollIdle() {
  let idle = 0;
  try { idle = powerMonitor.getSystemIdleTime(); } catch (e) { return; }
  const active = idle < IDLE_AWAY_SEC;
  if (active === userActive) return;
  userActive = active;
  if (active) {
    const awayMs = awaySince ? Date.now() - awaySince : 0;
    awaySince = 0;
    resetHealth();                 // 你刚活动过：久坐/喝水/护眼都从这一刻重新算
    send('activity', { active: true, awayMs });
  } else {
    awaySince = Date.now();
    send('activity', { active: false, awayMs: 0 });
  }
}

// ---------- 边缘收边（迷你模式）----------
// 拖到屏幕左/右边缘松手后，她缩到边上只露小半个身子；光标靠近她探出头；点一下恢复。
//
// ★ 实现是**纯位置**的：窗口尺寸一个像素都不改。
//   看起来"把窗口改窄"更直观，但渲染层整套尺寸都是窗口宽的百分比（cqw）——
//   气泡字号、角色区高度（= 窗口高 − 22cqw）、表情与粒子大小全挂在这上面。
//   窗口一改窄，气泡的字会变小、角色区会变高，她本人跟着抖一下。
//   把窗口往屏幕外推，推出去的部分**根本不会被合成**（透明窗口只画窗口内），
//   于是"只露半个身子"直接就有了，而渲染层一个数都不用动。
//
// 推出去多少按**角色轮廓**算，不按窗口矩形 —— 和 snapX / throwIt 同一条道理：
// 角色在窗口里水平居中，两侧是透明边，按窗口算会推多、看着像推了个寂寞。
let edgeMode = null;               // null | 'left' | 'right'
let edgePeek = false;              // 光标靠近中：探出头
const EDGE_PUSH = 0.46;            // 常态推出：角色显示宽的 46%（露出 54%）
const EDGE_PEEK = 0.22;            // 探头时往回收的比例
const EDGE_IN = 90;                // 光标离屏幕边缘多近算"靠近"
const EDGE_OUT = 150;              // 探头之后退到多远才缩回去（滞回）

function setEdge(mode) {
  const next = (mode === 'left' || mode === 'right') ? mode : null;
  const changed = next !== edgeMode;
  edgeMode = next;
  edgePeek = false;
  if (edgeMode) applyEdgePos();
  else resnap();                   // 取消收边：按常规约束把她拉回屏幕内
  if (changed) refreshTray();
  return edgeMode;
}

// 按当前 edgeMode / edgePeek 算 x 并落位。y 不动 ——
// 她贴的是左右两边，底边一直踩在地面线上（贴边不该改变她站的高度）。
function applyEdgePos() {
  if (!petWin || petWin.isDestroyed() || !edgeMode) return;
  const b = petWin.getBounds();
  const { w } = winSize();
  const sw = spriteDisplayW(currentOutfit, petDisplayH());
  if (!sw) return;
  const d = screen.getDisplayNearestPoint({
    x: Math.round(b.x + w / 2), y: Math.round(b.y + b.height / 2)
  });
  const wa = d.workArea;
  const padX = Math.max(0, Math.round((w - sw) / 2));
  const push = Math.round(sw * (EDGE_PUSH - (edgePeek ? EDGE_PEEK : 0)));
  const x = edgeMode === 'left'
    ? wa.x - padX - push                         // 角色左轮廓落在屏幕外 push 像素处
    : wa.x + wa.width - w + padX + push;         // 角色右轮廓落在屏幕外 push 像素处
  petWin.setPosition(Math.round(x), b.y);
}

// ---------- 开机自启 ----------
// 开发模式（未打包）下**不写注册表**：那时 process.execPath 是 electron.exe，
// 注册的结果是开机弹出一个空白的 Electron 窗口，而不是这个桌宠。
// 所以未打包时菜单项直接禁用并标注，比"看起来能用但没用"好。
function autostartOn() {
  if (!app.isPackaged) return false;
  try { return !!app.getLoginItemSettings().openAtLogin; } catch (e) { return false; }
}
function setAutostart(v) {
  if (!app.isPackaged) return false;
  try {
    app.setLoginItemSettings({ openAtLogin: !!v, path: process.execPath });
  } catch (e) { /* 组策略 / 权限写不进去不该让桌宠崩掉 */ }
  refreshTray();
  return autostartOn();
}
const AUTOSTART_LABEL = app.isPackaged ? '开机自启' : '开机自启（打包后可用）';

// ---------- IPC ----------
ipcMain.handle('pomodoro:getRecords', () => loadJSON(pomFile(), []));
ipcMain.handle('pomodoro:addRecord', (e, rec) => {
  const list = loadJSON(pomFile(), []);
  list.push(rec);
  saveJSON(pomFile(), list);
  return true;
});
ipcMain.handle('pomodoro:clearAll', () => { saveJSON(pomFile(), []); return true; });

ipcMain.handle('settings:get', () => readSettings());
// 久别重逢。**只回差值**，不回时间戳 —— 让渲染层不必懂"上次的时间戳意味着多久"，
// 分档规则（几小时 / 隔天 / 三天以上）就只存在于一个地方（pet.js 的 awayLine）。
// 首次运行或清过配置时 prevSeenAt 是 0：这时回 0，渲染层按"第一次见"走普通问候。
ipcMain.handle('pet:getAway', () => ({
  awayMs: prevSeenAt ? Math.max(0, Date.now() - prevSeenAt) : 0
}));
ipcMain.handle('settings:set', (e, s) => {
  const next = patchSettings(s);
  if (s.outfit !== undefined) { currentOutfit = s.outfit; resnap(); }
  if (s.pinned !== undefined) pinned = !!s.pinned;
  if (s.scale !== undefined) applyScale(s.scale);
  if (s.typing !== undefined) setTyping(s.typing);
  // 打扰等级：值上面已经落盘了，但**必须再广播给渲染层** —— 三个档的作用全在那边，
  // 不广播的话她在托盘里点了"安静"也要等到下次重启才换档（表现就是"点了没反应"）。
  if (s.chatter !== undefined) send('chatter', chatterOf());
  return next;
});

ipcMain.handle('pet:setPinned', (e, v) => {
  pinned = !!v;
  if (petWin && !petWin.isDestroyed()) petWin.setAlwaysOnTop(pinned, 'screen-saver');
  return pinned;
});
ipcMain.handle('pet:moveTo', (e, x, y) => moveToClamped(x, y));
// 拖拽松手 / 缩放之后落一次位置。存的是**夹紧后**的坐标，
// 不然被夹回边缘的窗口会把自己贴边的坐标覆盖掉，下次启动又跑到屏幕外。
ipcMain.handle('pet:savePos', (e, x, y) => {
  const p = clampPos(x, y, currentOutfit);
  // 除了左上角，**同时存底边**。窗口高会随版本变（v3.6 顶部留白 17%→22%，高 20px），
  // 只存左上角的话，下次启动照旧 y 落位，窗口一高她的脚就整体下沉 20px。
  // 底边才是这套几何里真正的不变量 —— applyScale / enforceSize / groundYOf
  // 三处全都以它为锚，存档跟着它走才对得上。
  // ★ 栖息中**不存档**：她现在的位置不是"她住的地方"，而是跟着前台窗口走的临时姿态。
  //   存了的话，退出栖息 / 下次启动她会落在那扇窗上沿的过期坐标上（那扇窗早没了）。
  //   仍返回合法坐标给渲染层当回执，只是不写进去。
  if (perchOn) return p;
  patchSettings({ pos: { x: p.x, y: p.y, bottom: p.y + winSize().h } });
  return p;
});
// 前台窗口快照 + 栖息开关。
// getForeground 只给**验收探针**用（tools/probe_v312.js）—— 渲染层要的东西一律走
// send 推送，不许来拉：拉一次就多一个"两个真相源"的机会。
ipcMain.handle('pet:getForeground', () => ({
  available: fgAvailable(),
  fullscreen: fgFullscreen,
  scene: fgScene,
  exe: fgExe,
  perch: perchOn,
  quiet: quietActive(),
  manualQuiet: manualQuiet()
}));
ipcMain.handle('pet:setPerch', (e, v) => setPerch(v));
ipcMain.handle('pet:getBounds', () => (petWin && !petWin.isDestroyed() ? petWin.getBounds() : null));
ipcMain.handle('pet:getWorkArea', () => {
  const b = petWin && !petWin.isDestroyed() ? petWin.getBounds() : null;
  const d = b ? screen.getDisplayNearestPoint({ x: b.x, y: b.y }) : screen.getPrimaryDisplay();
  const { w, h } = winSize();
  // 带上 sink 与当前窗口尺寸，渲染层才能算出和主进程**完全一致**的地面线，
  // 以及"角色在窗口里实际占多宽"（边缘吸附要用）。缩放以后 petH 变了，
  // 渲染层不去问主进程的话就会按旧的 400 算，落点会差一截。
  return Object.assign({}, d.workArea, { sink: sinkOf(currentOutfit), petW: w, petH: h });
});
ipcMain.handle('pet:setBlock', (e, v) => {
  blockMode = !!v;
  // 拖拽时若鼠标移出窗口，mouseup 可能收不到，blockMode 就会永久为真，
  // 于是自愈被永久关掉 —— 桌宠飞出去再也回不来。给个硬超时兜底。
  blockUntil = v ? Date.now() + 60 * 1000 : 0;
  if (blockMode) {
    // 一按下去就退出收边：你把她从边上拎起来，说明你想让她挪窝了。
    // 不退出的话，"你拖到哪"和"贴边逻辑算到哪"会各说各话，她会在手底下抽动。
    if (edgeMode) setEdge(null);
    // 同理退出窗口栖息 —— 但**不落地**：你正拎着她，她该跟着手走，
    // 而不是先掉到地上再被拖。不退出的话 perchAt 每拍都在把她拽回窗口上，会打起来。
    if (perchOn) { perchOn = false; fgTarget = null; send('perch', false); refreshTray(); }
    // 拖拽开始的这一刻就把穿透定死为"不穿透"，别等下一拍 ——
    // 拖拽是唯一必须逐帧跟手的交互，晚 120ms 才收回穿透会直接把它掐断。
    applyPassthrough(false);
  }
  return blockMode;
});

// 渲染层上报"我现在哪些地方是可交互的"（窗口本地 CSS px，含番茄钟面板）。
// 主进程只存不算 —— 它算不出这一套装扮显示多宽、面板有没有展开。
ipcMain.handle('pet:hitArea', (e, r) => {
  if (!r || ![r.l, r.t, r.r, r.b].every((v) => Number.isFinite(v))) hitArea = null;
  else hitArea = { l: r.l, t: r.t, r: r.r, b: r.b };
  return hitArea;
});
// 渲染层提示"光标此刻正压在我身上"。**只用于立刻取消穿透** ——
// 恢复穿透一律由主进程的光标巡检决定（它才是唯一权威），
// 所以渲染层算错了最多多接一会儿鼠标事件，不会把她变成点不到。
ipcMain.handle('pet:over', () => { applyPassthrough(false); return true; });

ipcMain.handle('pet:showStats', () => createStatsWin());

// 边缘收边（迷你模式）。渲染层松手吸附到屏幕边时拿它进迷你态，点她一下拿 null 退出来。
ipcMain.handle('pet:setEdge', (e, mode) => setEdge(mode));

// 你在不在、离开了多久。语义与 pet:getAway 一致：**只回差值**，
// 分档规则只写在渲染层一处（pet.js 的 awayDoingLine）。
// 为什么要有这个"主动问"的入口：主进程的 activity 广播是**状态变化才发**的，
// 而开机自启那一刻的状态本来就可能已经是"你不在"—— 只靠广播的话，
// 她会在你根本不在的时候先当成"你回来了"，说一句问候再睡。
ipcMain.handle('pet:getIdle', () => {
  let idle = 0;
  try { idle = powerMonitor.getSystemIdleTime(); } catch (e) { /* 拿不到就按"你在" */ }
  const active = idle < IDLE_AWAY_SEC;
  return {
    active: active,
    awayMs: (!active && awaySince) ? Math.max(0, Date.now() - awaySince) : 0
  };
});

// 羁绊
ipcMain.handle('bond:get', () => bondSnapshot(readAffinity()));
ipcMain.handle('bond:add', (e, action) => {
  const r = addBond(String(action || ''));
  if (r.leveledUp) refreshTray();     // 升级时把托盘上的进度/悬停提示同步过去
  return r;
});
// 勿扰。渲染层只在"自己也想要安静一下"时主动调用（目前没有入口，留给以后）。
ipcMain.handle('pet:setQuiet', (e, until) => setQuiet(Number(until) || 0));
ipcMain.handle('app:getAutostart', () => autostartOn());
ipcMain.handle('app:setAutostart', (e, v) => setAutostart(v));

// 心跳看门狗
let lastHeartbeat = Date.now();
let reloadCount = 0;
// 最近一次"变为可见"的时刻。渲染层是**窗口一可见才重新开始心跳**的
// （见 pet.js 的 syncHeartbeat），所以刚露面那几十秒里 lastHeartbeat 一定是旧的 ——
// 不设这个闸门的话，她每次从勿扰回来都会立刻被判成假死、重载一次。
let shownAt = Date.now();
function markShown() { shownAt = Date.now(); lastHeartbeat = Date.now(); }

// 把窗口显示出来并归位。"把她叫回来"的所有入口（托盘两项、托盘单击）都走这里 ——
// 走一处才能保证三件事不会被哪个入口漏掉：
//   · **叫回来就等于解除勿扰**。不然她在勿扰里被显示出来，15s 后又被藏回去，
//     中间闪一下 —— 而且"点了一下没反应"（保持隐藏）更糟，用户会以为坏了。
//   · markShown()（心跳基准）：漏了只是她回来头几十秒会被看门狗判成假死、重载一次。
//   · reassertPassthrough()（穿透态）：漏了只是回来后头几秒点不到。
function showPet() {
  if (!petWin || petWin.isDestroyed()) return;
  if (quietActive()) setQuiet(0);
  // 先确保可见，再重申 z 序 —— 顺序反过来就变成"对一个隐藏窗口调 moveTop()"，
  // 那会把一个本该藏着的她重新显示出来（实测，见 10min 置顶巡检那条注释）。
  if (!petWin.isVisible()) petWin.show();
  if (pinned) petWin.setAlwaysOnTop(true, 'screen-saver');
  petWin.moveTop();
  markShown();
  reassertPassthrough();
}

setInterval(() => {
  // 她藏起来的时候不判假死。勿扰期间渲染层本来就该是静的，
  // 拿"心跳停了"去重载一个看不见的窗口纯属白烧 ——
  // 而"到明天早上 8 点"这一档要持续一整夜，这个判断要命。
  if (!petWin || petWin.isDestroyed() || !petWin.isVisible()) return;
  if (Date.now() - shownAt < 40000) return;      // 刚露面：心跳还没轮到，别急着判
  if (Date.now() - lastHeartbeat > 35000 && reloadCount < 6) {
    reloadCount++;
    blockMode = false;
    if (petWin && !petWin.isDestroyed()) {
      enforceSize();                       // 重载前先校正几何，否则重载完还是扁的
      // 重载会把渲染层连同它上报过的可交互区一起清掉。不清这两个状态的话，
      // 从"发现问题"到"渲染层重新上报"之间会拿着旧矩形去撞光标 ——
      // 而这段窗口期她可能正好是一片白，点上去什么都发生不了。
      hitArea = null;
      applyPassthrough(true);
      petWin.webContents.reload();
    }
  }
}, 10000);
setInterval(() => { reloadCount = Math.max(0, reloadCount - 1); }, 10 * 60 * 1000);
ipcMain.handle('pet:heartbeat', () => { lastHeartbeat = Date.now(); return true; });

// ---------- 透明区点击穿透（v3.5）----------
// 窗口是 404×469 的矩形，而角色只占其中一块：水手服显示宽只有 188px，
// 窗口左右各剩约 108px 纯透明；顶部还有一条 69px 专门留给气泡的留白。
// **透明区照样接住鼠标**（本项目不靠 alpha 做命中测试，理由见 pet.js 的"部位识别"），
// 于是她周围一大片空气点不下去 —— 底下压着的桌面图标、别的窗口全被挡住。
//
// v3.1 曾把 setIgnoreMouseEvents 整个废掉，原因是它在锁屏/息屏/DWM 事件后
// 会静默失效、窗口永久卡在穿透态（用户表现为"挂机以后点不到"）。
// 但那时是**事件驱动地切**：切的那一刻算错了，就再没有任何机会纠正。
// 现在换成和几何巡检同一条思路 —— **每拍按当前事实重算一遍**：
//   · 主进程 120ms 的光标轮询是唯一权威。它每拍拿"光标在不在可交互区里"
//     重新算一次穿透态，依据是**事实**（光标位置）而不是历史，
//     所以漂移至多存活一拍就被纠回去。这正是上面那条架构原则 1。
//   · 渲染层用 forward 过来的 mousemove 补一个"立刻取消穿透"的提示，
//     把"鼠标压上她"的延迟从 120ms 压到一帧。它**只能取消穿透、不能恢复**，
//     恢复只有主进程做 —— 两个写入方因此永远不会互相打架。
//   · 拖拽（blockMode）与原生右键菜单期间强制取消穿透：那两种情况下鼠标
//     一定会离开角色轮廓，靠光标位置判断会把拖拽和菜单掐断。
//
// "可交互区"由**渲染层上报**而不是主进程猜：只有渲染层知道这一套装扮
// 实际显示多宽、番茄钟面板有没有展开。主进程只做一件事 —— 拿光标去撞那个矩形。
// （上报的是 DOM 量出来的外接矩形，仍包含角色自身轮廓内的透明处，
//   但相比"整窗"已经收掉了两侧的透明边和顶部留白这一大圈。）

// 该不该穿透。pt = 屏幕光标，b = 窗口矩形。
function wantPassthrough(pt, b) {
  if (blockMode || menuOpen) return false;   // 拖拽 / 原生菜单：绝不穿透
  if (!hitArea) return true;                 // 还没上报：整窗不接
  const x = pt.x - b.x, y = pt.y - b.y;      // 换算成窗口本地坐标
  const inside = x >= hitArea.l && x <= hitArea.r && y >= hitArea.t && y <= hitArea.b;
  return !inside;
}

// 只在状态**变化**时下发。反复设同一个值虽然无害，但会在 Windows 上产生
// 多余的鼠标消息重定向；需要"重申"时显式传 force。
// forward: true 是关键 —— 它让渲染层在**穿透态下仍然收得到 mousemove**，
// 摸头、以及上面那条"立刻取消穿透"的提示都靠它。
// （forward 只有 Windows / macOS 支持；本项目只发 Windows 包。）
function applyPassthrough(want, force) {
  if (!petWin || petWin.isDestroyed()) return;
  if (want === passthrough && !force) return;
  passthrough = want;
  petWin.setIgnoreMouseEvents(want, { forward: true });
}

// 穿透态同样要定期重申：DWM 事件后它可能悄悄漂掉（这正是上一版废掉它的原因）。
// ★ 重申的是**按当前事实重新算出来的值**，不是"上次设过的值" ——
//   重申一个已经算错的值得不到任何纠正，那是自欺欺人。
//
// ★ 闸门只认 `isVisible()`，**不认"勿扰中"那个缓存**。理由是被实测咬过的：
//   一旦有别的路径把她重新显示出来，缓存会说"她藏着呢"从而把这里整个挂起，
//   鼠标策略冻在隐藏前那一刻 —— 她看得见、点不到。而"她藏起来了就别忙"这件事，
//   isVisible() 本来就知道（勿扰 ⟺ 隐藏）。
function reassertPassthrough() {
  if (!petWin || petWin.isDestroyed() || !petWin.isVisible()) return;
  let pt;
  try { pt = screen.getCursorScreenPoint(); } catch (e) { return; }
  applyPassthrough(wantPassthrough(pt, petWin.getBounds()), true);
}

// ---------- 全屏光标（目光跟随 + 主动靠近的数据源）----------
// 渲染层只看得到**窗口内**的 mousemove，鼠标一离开窗口她就不再"看"你了 ——
// 而桌宠多数时候你根本没把鼠标放在她身上，于是在窗口里那个"转头看你"几乎看不到。
// 所以改成主进程用 screen.getCursorScreenPoint() 轮流**全局**光标坐标，
// 换算成方位推给渲染层。渲染层只负责把它变成一个 transform，不碰坐标。
//
// 为什么是 120ms 而不是 16ms：这个数据只驱动一个 .3s 缓动的微位移，
// 60Hz 轮询纯属浪费（getCursorScreenPoint 是原生调用，但每秒 60 次也没意义）。
// 120ms 足够跟手 —— 而且这是本项目**唯一**新增的常驻轮询，别再加第二个。
//
// 三个收敛条件，缺一个就是白烧 CPU 或白刷 IPC：
//   · 勿扰把窗口藏起来了 -> 不轮询（她看不见，看谁呢；穿透也不用维护）
//   · 窗口不可见 -> 不轮询
//   · petWin 为空 -> 不轮询
// 前两条其实是同一条（勿扰 ⟺ 隐藏），所以判断只看 isVisible()：
// 拿一个"她藏着"的缓存去当闸门，就会在缓存漂掉时把轮询连同鼠标策略一起冻住。
//
// 这一拍做两件事，顺序不能换：
//   ① 点击穿透判定 —— **与光标有没有动无关**，所以必须放在去重之前。
//      放到后面的话，鼠标一静止（也就是绝大多数时间）穿透态就没人维护了，
//      等于回到"设一次就不管"的老路上。
//   ② 目光跟随 —— 只在光标动过的时候发（去重能省掉绝大部分 IPC）。
let cursorTimer = null, lastCursor = { x: 0, y: 0 };
const CURSOR_MS = 120;          // 唯一需要它的两个用途都是"慢变量"：一个 .3s 缓动的微位移、
                                // 一个 120ms 内不可能变两次的命中判定。60Hz 纯属浪费。
function cursorPoll() {
  if (!petWin || petWin.isDestroyed()) return;
  if (!petWin.isVisible()) return;                     // 她藏起来了：不跟、不判、不维护
  let pt;
  try { pt = screen.getCursorScreenPoint(); } catch (e) { return; }
  const b = petWin.getBounds();

  // ① 穿透：每拍按事实重算（漂移至多存活一拍）
  applyPassthrough(wantPassthrough(pt, b));

  // ② 目光：光标没动就不发
  if (pt.x === lastCursor.x && pt.y === lastCursor.y) return;
  lastCursor = { x: pt.x, y: pt.y };

  // ③ 迷你模式：光标靠近屏幕边缘 -> 探出头，走远 -> 缩回去。
  //    两个阈值（进 90 / 出 150）是**滞回**：只用一个阈值的话，
  //    停在边界上的光标会让她来回抽动（探头→缩回→探头，每 120ms 一次）。
  //    放在光标去重之后是对的 —— 光标没动时 near 不可能变，不必每拍重算。
  if (edgeMode) {
    const wa = workAreaFor(pt.x, pt.y);
    const near = edgeMode === 'left'
      ? pt.x < wa.x + (edgePeek ? EDGE_OUT : EDGE_IN)
      : pt.x > wa.x + wa.width - (edgePeek ? EDGE_OUT : EDGE_IN);
    if (near !== edgePeek) { edgePeek = near; applyEdgePos(); }
  }

  const cx = b.x + b.width / 2;
  const headY = b.y + b.height * 0.30;         // 头大致在窗口上部三成处
  send('cursor', {
    x: pt.x, y: pt.y,
    nx: Math.max(-1, Math.min(1, (pt.x - cx) / (b.width * 0.9))),
    ny: Math.max(-1, Math.min(1, (pt.y - headY) / (b.height * 0.6))),
    dist: Math.round(Math.hypot(pt.x - cx, pt.y - headY)),
    inside: pt.x >= b.x && pt.x <= b.x + b.width &&
            pt.y >= b.y && pt.y <= b.y + b.height
  });
}
function startCursorFeed() {
  if (cursorTimer) return;
  cursorTimer = setInterval(cursorPoll, CURSOR_MS);
}

// ---------- 前台窗口感知（v3.12 · 可选能力）----------
// **一次轮询，三处收益**：
//   ① 全屏自动躲起来 —— 看全屏视频 / 打游戏时她自己消失（v3.7 起只有手动开关）
//   ② 窗口栖息       —— 她坐到你正在用的那扇窗的上沿，窗口动她就跟着动
//   ③ 环境感知       —— 按前台应用切反应（写代码时安静看书陪、浏览器里凑过来看）
// 底层是 wininfo.js（koffi + user32，optional 依赖）。装不上就整块降级。
//
// ⚠ 这是本项目**第二个**常驻轮询 —— 光标巡检那一节的注释写着"别再加第二个"，
//   此处是**有意推翻**它，三条理由：
//     · 前台窗口是**唯一**能回答"是不是全屏"的东西。Win32 没有可用的通知，
//       全屏检测只能轮询；又不能为了省这点开销就不做（用户不该为了看个视频
//       专门去点一下菜单）。
//     · 窗口栖息也必须跟着前台窗口动，同一份数据。
//     · 频率差 8 倍（这里 1s，光标 120ms），而且这一拍**只在原生模块可用时**才起。
//   ★ 但"别再加第三个"仍然有效：将来要加东西请**挂在这一拍上**，不要再开新表。
//
// ⚠ 还有一条它与光标巡检**必须不同**的地方：**不能带可见性闸门**。
//   光标巡检在她藏起来时会停（看不见就别跟了）。这一拍要是也停，就会死锁：
//   因全屏而藏 -> 不轮询 -> 检测不到"已退出全屏" -> 永远回不来。
//   所以它只在 petWin 不存在时停。见 tools/probe_v312.js 的对应断言。
const FG_MS = 1000;
// 场景 → 菜单里的中文名。渲染层台词分组与这里的键必须一一对应（selftest 会比对）。
const SCENE_LABELS = {
  code: '写代码', browser: '浏览器', video: '视频', chat: '聊天',
  desktop: '桌面', other: '其他'
};
let fgTimer = null;
let fgScene = 'other';
let fgExe = '';
let fgKey = '';              // "exe|x,y,w,h"：用来判断"目标窗口有没有动/换"
let fgTarget = null;         // 最近一次的 { win, work }（DIP）。缩放 / 换装之后要**立刻**
                             // 重贴，不能等下一拍 —— 否则她会先被 applyScale 挪开，
                             // 1 秒后再跳回窗口上，看起来像抽搐。
let perchOn = false;         // 窗口栖息。**会话级、不落盘** —— 重启后前台窗口未必还是那扇

const fgAvailable = () => wininfo.available();
function startFgFeed() {
  if (fgTimer || !fgAvailable()) return;
  fgTimer = setInterval(fgPoll, FG_MS);
}

// 把 Win32 的物理像素换算成 DIP 所需的 scaleFactor，用**该窗口所在显示器**的。
// 拿主屏的去换副屏的矩形，混合 DPI 双屏（一块 100% 一块 150%）上副屏会整体错位。
// 匹配办法：把每个 display 的 DIP 矩形乘回它自己的 scaleFactor，去和 Win32 的物理矩形比。
function scaleFor(monRaw) {
  let best = 1, bestErr = Infinity;
  try {
    for (const d of screen.getAllDisplays()) {
      const err = Math.abs(d.bounds.width * d.scaleFactor - monRaw.w) +
                  Math.abs(d.bounds.height * d.scaleFactor - monRaw.h);
      if (err < bestErr) { bestErr = err; best = d.scaleFactor; }
    }
  } catch (e) { /* 拿不到就用 1（等价于"两个坐标系相同"） */ }
  return best;
}

// 一拍。顺序即优先级：先定"藏不藏"，再报场景，最后才挪位置。
function fgPoll() {
  if (!petWin || petWin.isDestroyed()) return;
  const raw = wininfo.foreground();
  // 拿不到（没装模块 / 这一刻真的没有前台窗口 / 调用失败）就**什么都不改** ——
  // 当作"不知道"，而不是当作"不在全屏"。后者会让她在全屏视频里冒出来。
  if (!raw || !raw.monitor) return;

  const sf = scaleFor(raw.monitor);
  const winDip = wininfo.toDip(raw.rect, sf);
  const monDip = wininfo.toDip(raw.monitor, sf);
  const workDip = raw.work ? wininfo.toDip(raw.work, sf) : monDip;
  const self = raw.pid === process.pid;        // 前台是**她自己**（用户刚点了她）
  const fs = !self && !raw.minimized && !raw.maximized &&
             wininfo.isFullscreen(winDip, monDip);

  // ① 藏不藏。★ 必须走 applyQuiet，而不是自己 hide/show ——
  //   "勿扰 ⟺ 窗口不可见"那条宪法只有它一处实现，绕过它等于藏起来没人管
  //   （穿透、巡检、菜单会全都以为她还在）。
  if (fs !== fgFullscreen) {
    fgFullscreen = fs;
    applyQuiet();
  }

  // ② 环境感知：只在场景**变了**的时候推（去重，省 IPC）
  const scene = (self || raw.minimized) ? 'other' : wininfo.sceneOf(raw.exe);
  if (scene !== fgScene) {
    fgScene = scene;
    fgExe = self ? '' : raw.exe;
    send('scene', { scene, exe: fgExe });
    refreshTray();                             // 托盘里那行"当前前台"要跟着变
  }

  // ③ 窗口栖息
  if (!perchOn) return;
  if (self || raw.minimized) {                 // 那扇窗她已经没得坐了 -> 下来
    setPerch(false);
    return;
  }
  if (fs) return;                              // 全屏里她本来就藏着，不用算
  if (blockMode && Date.now() < blockUntil) return;   // 拖拽 / 重载期间让路
  const key = raw.exe + '|' + Math.round(winDip.x) + ',' + Math.round(winDip.y) +
              ',' + Math.round(winDip.w) + ',' + Math.round(winDip.h);
  if (key !== fgKey) {
    fgKey = key;
    fgTarget = { win: winDip, work: workDip };
    perchAt(winDip, workDip);
  }
}

// 把她放到前台窗口的上沿。口径：**她的脚踩在窗口上沿那条线**。
//   "脚" = 窗口底边 − sink。sink 是那 40px 的切口（四套都是半身像、原画没画脚，
//   靠它把切口藏在任务栏后面）；在窗口上沿这里同样要用，否则切口会露在窗口外面一格。
function perchAt(win, work) {
  if (!petWin || petWin.isDestroyed()) return null;
  const { w, h } = winSize();
  let x = Math.round(win.x + (win.w - w) / 2);        // 横向居中于那扇窗
  let y = Math.round(win.y + sinkOf(currentOutfit) - h);
  x = Math.max(work.x, Math.min(x, work.x + work.w - w));   // 夹进工作区：窗口贴屏幕边时
  y = Math.max(work.y, y);                                  // 她也得站得进去
  petWin.setPosition(x, y);
  return { x, y };
}

// 进 / 出窗口栖息。返回"实际生效的状态"（模块不可用时拒绝进入并返回 false）——
// 与 setTyping 同一约定，菜单据此不勾，免得出现"勾着但没生效"。
function setPerch(on) {
  if (on && !fgAvailable()) return false;
  const next = !!on;
  if (next === perchOn) return perchOn;
  // 先取消收边（此时 perchOn 还是 false，resnap 会走常规路径），
  // 再进栖息 —— 两者都在写她的位置，谁后算谁赢，所以必须先清场。
  if (next && edgeMode) setEdge(null);
  perchOn = next;
  if (perchOn) {
    fgKey = '';                                  // 逼下一拍（或下面这次）立刻贴上去
    const raw = wininfo.foreground();
    if (raw && raw.monitor && raw.pid !== process.pid && !raw.minimized) {
      const sf = scaleFor(raw.monitor);
      const win = wininfo.toDip(raw.rect, sf);
      const work = raw.work ? wininfo.toDip(raw.work, sf) : wininfo.toDip(raw.monitor, sf);
      fgTarget = { win, work };
      perchAt(win, work);
    }
  } else {
    fgTarget = null;
    // 下来要**落地**，不能停在半空 —— 她的位置本来就是"站在窗口底部"的，
    // 停在空中看着就是卡住了（渲染层的角色不会自己往下掉）。
    const b = petWin && !petWin.isDestroyed() ? petWin.getBounds() : null;
    if (b) {
      const d = screen.getDisplayNearestPoint({
        x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2)
      });
      moveToClamped(b.x, groundYOf(d, currentOutfit));
    } else {
      resnap();
    }
  }
  send('perch', perchOn);
  refreshTray();
  return perchOn;
}

// 菜单里那行只读状态：她现在"陪你干什么"。
// 与 healthSubmenu 的只读行一样，这是**建菜单那一刻的快照**，所以写"当前"。
function fgStatusText() {
  if (!fgAvailable()) return '不可用（原生模块未安装）';
  return `当前前台：${fgExe || '—'}（${SCENE_LABELS[fgScene] || '其他'}）`;
}

// ---------- 键盘反应（可选 · 默认关闭）----------
// ⚠ 这是整个项目里**唯一**一处全局输入监听，也是**唯一**一个运行时依赖。
// 两条都是刻意的，而且默认关闭、必须在菜单里显式打开 —— 理由不是技术性的：
//   · 全局键盘监听在杀软眼里天然可疑（这类 API 正是键盘记录器用的），
//     一个桌宠悄悄挂上它，用户有权先知道。
//   · 这个仓库其余部分零运行时依赖（只有 electron / electron-builder 两个 devDep）。
//     为一个锦上添花的功能引一个原生模块，值得，但必须说清楚。
//
// 隐私边界（写死在实现里，不是"我们保证"）：
//   · 只监听 'keydown' **这个事件本身**，事件对象里的 keycode 连读都不读；
//   · 不记录按了哪个键、不组合成文字、不落盘、不发送到任何地方；
//   · 数据只活在一个 1 秒的滑动窗口里，用来算"现在的敲击节奏"，然后被丢掉。
// 看代码就能确认：整个文件里没有出现 keycode / rawcode / key 这些字段名。
let typingHook = null, typingBuf = [], typingTimer = null, typingPrimed = false;
const TYPING_PUSH_MS = 120;      // 最多 8 次/秒 —— 再多就是噪音，不是"打字感"

function typingAvailable() {
  try { require.resolve('uiohook-napi'); return true; } catch (e) { return false; }
}

function startTypingFeed() {
  if (typingHook || !typingAvailable()) return false;
  let mod;
  try { mod = require('uiohook-napi'); } catch (e) { return false; }
  try {
    typingHook = mod.uIOhook;
    typingHook.on('keydown', () => { typingBuf.push(Date.now()); });
    typingHook.start();
  } catch (e) {
    // 挂不上（权限 / 已被别的程序占用）就当作没这个功能 —— 绝不能因此崩掉桌宠
    try { typingHook && typingHook.stop(); } catch (e2) { /* 忽略 */ }
    typingHook = null;
    return false;
  }
  typingPrimed = Date.now() + 1200;     // 起步 1.2s 内不推：避免把"打开开关"那一下也算进去
  typingTimer = setInterval(() => {
    const now = Date.now();
    typingBuf = typingBuf.filter((t) => now - t < 1000);     // 1 秒滑动窗口
    if (now < typingPrimed) return;
    if (!typingBuf.length) return;
    if (now - lastTypingPush < TYPING_PUSH_MS) return;       // 节流：最多 8 次/秒
    lastTypingPush = now;
    send('typing', { rate: typingBuf.length });              // rate = 这一秒敲了多少下
  }, TYPING_PUSH_MS);
  return true;
}
let lastTypingPush = 0;

function stopTypingFeed() {
  if (typingTimer) clearInterval(typingTimer);
  typingTimer = null;
  typingBuf = [];
  if (typingHook) {
    try { typingHook.stop(); } catch (e) { /* 停不掉也不该崩 */ }
    try { typingHook.removeAllListeners(); } catch (e) { /* 忽略 */ }
    typingHook = null;
  }
}
// 开关。返回值是"实际生效的状态" —— 模块装不上时返回 false，
// 菜单据此把勾去掉并标注"不可用"，比"看起来开着其实没生效"好。
function setTyping(on) {
  const want = !!on && typingAvailable();
  if (want) { if (!startTypingFeed()) return false; }
  else stopTypingFeed();
  patchSettings({ typing: want });
  refreshTray();
  return want;
}
const typingOn = () => readSettings().typing === true && typingAvailable();
const TYPING_LABEL = typingAvailable() ? '键盘反应' : '键盘反应（模块不可用）';

// ---------- 统计窗口 ----------
function createStatsWin() {
  if (statsWin && !statsWin.isDestroyed()) { statsWin.show(); statsWin.focus(); return; }
  statsWin = new BrowserWindow({
    width: 660, height: 640, autoHideMenuBar: true,
    title: '番茄统计 · 雪乃',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  statsWin.loadFile(path.join(__dirname, 'renderer', 'stats.html'));
  statsWin.on('closed', () => { statsWin = null; });
}

// ---------- 右键菜单 ----------
// 这一组子菜单在**右键菜单和托盘菜单里各出现一次**，所以抽成函数而不是各写一份 ——
// 菜单是"建好就定住"的对象（不会有第二次求值的机会），两边各写一份迟早漂成
// "托盘里显示安静、右键菜单里还勾着适中"这种自相矛盾的状态。
function chatterSubmenu() {
  return CHATTER_KEYS.map(([k, label]) => ({
    label, type: 'radio', checked: chatterOf() === k, click: () => setChatter(k)
  }));
}
function healthSubmenu() {
  const items = Object.keys(HEALTH_RULES).map((k) => ({
    label: `${HEALTH_RULES[k].label}　${Math.round(HEALTH_RULES[k].ms / 60000)} 分钟`,
    type: 'checkbox', checked: healthOn(k),
    click: (mi) => setHealth(k, mi.checked)
  }));
  items.push({ type: 'separator' });
  // 这一行是**只读**的。它只在菜单被构建的那一刻算一次（菜单弹出期间不会刷新），
  // 所以写"约"字，并且会随时间越来越不准 —— 精确值在托盘悬停里（每分钟刷一次）。
  items.push({ label: nextHealthText() || '（三项都已关闭）', enabled: false });
  return items;
}
// 前台感知的两项开关（右键菜单与托盘菜单共用一份，理由同上面那段）。
// 模块不可用时两项都置灰 —— 与"键盘反应（模块不可用）"同一约定：
// 宁可告诉用户"这个功能现在没有"，也不要给他一个点了没反应的勾。
function fgSubmenu() {
  return [
    {
      label: '全屏时自动躲起来', type: 'checkbox',
      checked: autoQuietOn(), enabled: fgAvailable(),
      click: (mi) => { patchSettings({ autoQuiet: !!mi.checked }); applyQuiet(); refreshTray(); }
    },
    {
      label: perchOn ? '从窗口上下来' : '坐到我窗口上', type: 'checkbox',
      checked: perchOn, enabled: fgAvailable(),
      click: () => setPerch(!perchOn)
    },
    { type: 'separator' },
    // 只读的一行：她现在"陪你干什么"。建菜单那一刻的快照，所以写"当前"。
    { label: fgStatusText(), enabled: false }
  ];
}

// 收到屏幕的哪一边：按她**此刻**更靠近哪侧来定。离哪边近就收哪边 ——
// 菜单点了以后她往反方向跑会很怪。
function toggleEdge() {
  if (edgeMode) { setEdge(null); return; }
  const d = screen.getPrimaryDisplay();
  let cx = d.workArea.x + d.workArea.width / 2;
  if (petWin && !petWin.isDestroyed()) { const b = petWin.getBounds(); cx = b.x + b.width / 2; }
  setEdge(cx < d.workArea.x + d.workArea.width / 2 ? 'left' : 'right');
}

const OUTFITS = [
  ['maid', '女仆装'],
  ['sailor', '水手服 + 贝雷帽'],
  ['coat', '冬大衣 + 围巾'],
  ['winter', '冬装（全身）']
];
// 档位顺序必须与 SIZES 的键顺序、以及渲染层 pet.js 的 SIZE_ORDER 完全一致
// （滚轮靠"当前档在数组里的下标 ±1"算下一档，顺序错了会跳档）。
// selftest 会比对这三处。
const SCALE_LABELS = [
  ['tiny', '极小'], ['small', '小'], ['medium', '中'], ['large', '大'], ['huge', '特大']
];
function currentScaleKey() {
  const hit = SCALE_LABELS.find(([k]) => SIZES[k] === petScale);
  return hit ? hit[0] : 'medium';
}
function setScale(key) {
  applyScale(key);
  patchSettings({ scale: key });
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('scale', key);
  refreshTray();                       // 托盘里的单选项要跟着走
}
function petMenu() {
  return Menu.buildFromTemplate([
    // 第一行就把羁绊进度摆出来 —— 它是这套养成的唯一"数值"，
    // 藏进二级菜单的话，用户永远不知道自己刷到哪了。
    { label: bondLabel(), enabled: false },
    { type: 'separator' },
    {
      label: '服装', submenu: OUTFITS.map(([k, label]) => ({
        label, type: 'radio', checked: k === currentOutfit,
        click: () => {
          currentOutfit = k;
          patchSettings({ outfit: k });
          resnap();
          if (petWin && !petWin.isDestroyed()) petWin.webContents.send('outfit', k);
        }
      }))
    },
    {
      label: '大小（滚轮 / Ctrl + 滚轮）', submenu: SCALE_LABELS.map(([k, label]) => ({
        label, type: 'radio', checked: k === currentScaleKey(),
        click: () => setScale(k)
      }))
    },
    { type: 'separator' },
    { label: '开始番茄钟', click: () => send('action', 'open-pomodoro') },
    { label: '番茄统计', click: () => createStatsWin() },
    { type: 'separator' },
    { label: '走两步', click: () => send('action', 'walk') },
    {
      label: pinned ? '取消置顶' : '置顶',
      click: () => {
        pinned = !pinned;
        if (petWin && !petWin.isDestroyed()) petWin.setAlwaysOnTop(pinned, 'screen-saver');
        patchSettings({ pinned });
      }
    },
    { type: 'separator' },
    { label: '安静一会儿', submenu: quietSubmenu() },
    { label: '打扰等级', submenu: chatterSubmenu() },
    { label: '健康提醒', submenu: healthSubmenu() },
    { label: '前台感知', submenu: fgSubmenu() },
    { label: '音效', type: 'checkbox', checked: sfxOn(), click: (mi) => {
        patchSettings({ sfx: !!mi.checked });
        if (mi.checked) send('sfx', 'click');    // 打开的那一刻试听一下
      } },
    // 键盘反应。**默认关**，而且这里要写清"它到底在听什么" ——
    // 全局键盘监听是个需要用户知情的功能，菜单是唯一说这句话的地方。
    { label: TYPING_LABEL, type: 'checkbox',
      checked: typingOn(), enabled: typingAvailable(),
      toolTip: '只统计敲击次数，不记录按了哪个键',
      click: (mi) => {
        const ok = setTyping(mi.checked);
        send('action', ok ? 'typing-on' : 'typing-off');
      } },
    {
      label: AUTOSTART_LABEL, type: 'checkbox',
      checked: autostartOn(), enabled: app.isPackaged,
      click: (mi) => setAutostart(mi.checked)
    },
    { type: 'separator' },
    { label: edgeMode ? '取消收边（恢复正常）' : '收到屏幕边缘', click: toggleEdge },
    { label: '回到屏幕右上角', click: () => {
        // 回右上角必须**先取消收边**：不然她带着"推到屏幕外"的位置去算右上角，
        // 结果一半身子在屏幕外，用户会以为菜单坏了。
        setEdge(null);
        const d = screen.getPrimaryDisplay();
        moveToClamped(d.workArea.x + d.workArea.width - winSize().w - 60, groundYOf(d, currentOutfit));
      } },
    { label: '打开数据目录', click: () => shell.openPath(DATA_DIR()) },
    { label: '退出', click: () => app.quit() }
  ]);
}
function send(channel, payload) {
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send(channel, payload);
}

// ---------- 托盘 ----------
// 托盘是"桌宠不见了"时唯一的找回入口（它不在任务栏、没有窗口列表），
// 所以「回到屏幕右上角」必须放在这里，而不只是右键菜单里。
//
// 菜单**每次状态变化都重建**（refreshTray），而不是建一次就不管：
// 放进来的单选项（大小）、复选项（音效 / 开机自启）、以及"安静一会儿"里
// 那条随状态出现的「现在就回来」，都需要实时的 checked / enabled。
// 尤其重要的一条：勿扰把窗口藏起来之后，**托盘就是唯一能把人叫回来的地方**。
function trayMenu() {
  return Menu.buildFromTemplate([
    { label: '显示雪乃', click: () => showPet() },
    { label: bondLabel(), enabled: false },
    { label: '回到屏幕右上角', click: () => {
        setEdge(null);                      // 同右键菜单：先取消收边再归位
        const d = screen.getPrimaryDisplay();
        applyScale(currentScaleKey());      // 顺带把尺寸也还原（万一被改过）
        moveToClamped(d.workArea.x + d.workArea.width - winSize().w - 60, groundYOf(d, currentOutfit));
        showPet();
      } },
    {
      label: '大小', submenu: SCALE_LABELS.map(([k, label]) => ({
        label, type: 'radio', checked: k === currentScaleKey(), click: () => setScale(k)
      }))
    },
    { label: '安静一会儿', submenu: quietSubmenu() },
    { label: '打扰等级', submenu: chatterSubmenu() },
    { label: '健康提醒', submenu: healthSubmenu() },
    { label: '前台感知', submenu: fgSubmenu() },
    { label: edgeMode ? '取消收边（恢复正常）' : '收到屏幕边缘', click: toggleEdge },
    { label: '音效', type: 'checkbox', checked: sfxOn(), click: (mi) => patchSettings({ sfx: !!mi.checked }) },
    { label: TYPING_LABEL, type: 'checkbox',
      checked: typingOn(), enabled: typingAvailable(),
      toolTip: '只统计敲击次数，不记录按了哪个键',
      click: (mi) => { setTyping(mi.checked); send('action', mi.checked ? 'typing-on' : 'typing-off'); } },
    {
      label: AUTOSTART_LABEL, type: 'checkbox',
      checked: autostartOn(), enabled: app.isPackaged,
      click: (mi) => setAutostart(mi.checked)
    },
    { label: '番茄统计', click: () => createStatsWin() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]);
}
// 托盘悬停文案。单独抽出来是因为它**会随时间漂**（"下次提醒 X 分钟后"），
// 所以除了状态变化时重建，还有一个每分钟的定时器在刷它（见 createPet）。
// 菜单做不到这一点 —— Electron 的菜单是建好就定住的，没有"即将弹出"事件。
function trayTip() {
  const s = bondSnapshot(readAffinity());
  const parts = [`雪乃桌宠 · 羁绊 Lv.${s.level} ${s.levelName}`];
  if (edgeMode) parts.push('已收到屏幕边缘 · 点一下她恢复');
  const h = nextHealthText();
  if (h) parts.push(h);
  return parts.join(' · ');
}
function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip(trayTip());
  tray.setContextMenu(trayMenu());
}

function createTray() {
  let img = nativeImage.createEmpty();
  try {
    const p = path.join(__dirname, 'assets', 'tray.png');
    if (fs.existsSync(p)) img = nativeImage.createFromPath(p);
  } catch (e) { /* 图标缺失不该影响启动 */ }
  tray = new Tray(img);
  refreshTray();
  tray.on('click', () => showPet());
}

app.whenReady().then(() => {
  const s = readSettings();
  currentOutfit = s.outfit || 'maid';
  pinned = s.pinned !== false;
  petScale = SIZES[s.scale] || SIZES.medium;   // 缩放要在 createPet 之前生效，否则窗口先按旧尺寸建出来
  // 久别重逢：先读旧值、再写新值。顺序反了这功能就是死的（见 prevSeenAt 的说明）。
  prevSeenAt = Number(s[SEEN_KEY]) || 0;
  markSeen();
  // 「陪你第 N 天」的起点：**只在第一次运行时写一次，此后永不覆盖**。
  // 覆盖它 = 每天都变成"第 1 天"，而且完全静默（问候照常出现，只是里程碑永远不来）。
  if (!Number(s.firstRunAt)) patchSettings({ firstRunAt: Date.now() });
  // 启动那一刻先取一次**真实的系统空闲**。开机自启时你可能压根不在电脑前，
  // 而 userActive 的初值是真 —— 不先纠正的话，她会在你不在的时候先问一句好，
  // 而且健康提醒会从那一刻开始白跑（累计一个"你根本不在场"的久坐计时）。
  try {
    const idle0 = powerMonitor.getSystemIdleTime();
    if (idle0 >= IDLE_AWAY_SEC) { userActive = false; awaySince = Date.now() - idle0 * 1000; }
  } catch (e) { /* 拿不到就按"你在" */ }
  // 定期落一次。崩溃 / 断电最多只丢这 5 分钟，而分档跨度是小时和天，误差无意义。
  setInterval(markSeen, 5 * 60 * 1000);
  createPet();
  createTray();
  // 键盘反应：只在你上次开着的时候才恢复。默认是关的（见 startTypingFeed 的说明）。
  if (readSettings().typing === true) setTyping(true);
  applyQuiet();              // 启动时若还在勿扰时段，确认一次隐藏状态（见 createPet 的说明）
  ipcMain.on('pet:menu', () => {
    if (!petWin || petWin.isDestroyed()) return;
    // 原生菜单弹出期间必须挂起穿透判定：菜单一展开，鼠标就离开角色轮廓了，
    // 靠光标位置判断会在菜单还开着的时候把她切成穿透态。
    const m = petMenu();
    menuOpen = true;
    applyPassthrough(false);
    m.once('menu-will-close', () => {
      menuOpen = false;
      // 菜单关掉时鼠标多半还在原地（角色外），下一拍就会自己恢复成穿透。
      // 这里不主动恢复 —— 那会多一次没有依据的写入。
    });
    m.popup({ window: petWin });
  });
});

// 托盘常驻，关掉窗口不退出
app.on('window-all-closed', () => {});

// 退出前把两个常驻资源收干净 —— 尤其是全局键盘钩子：不 stop 的话
// 钩子会活到进程真正结束那一刻，某些情况下会让系统输入短暂异常。
app.on('before-quit', () => {
  stopTypingFeed();
  if (cursorTimer) { clearInterval(cursorTimer); cursorTimer = null; }
  // 正常退出是拿到"精确离开时刻"的唯一机会 —— 不写的话下次启动算出来的
  // 差值会包含"关机之后到你下次开机"的间隔，也没错，但会带上这次运行尾巴上的
  // 那几分钟误差。写完这一下，下次启动的差值就是干净的。
  markSeen();
});
