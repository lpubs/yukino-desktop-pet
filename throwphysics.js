// 雪乃桌宠 · 投掷物理（纯函数）
//
// 抽成独立文件，理由和 clamp.js 完全一样：**为了能被真正验证**。
//   投掷落地这套积分原来长在 pet.js 的 rAF 回调里，而 rAF 只在真机上推进 ——
//   本项目的无头验收跑不了它（实测：`--virtual-time-budget=5000` 下
//   setInterval 走了 10 拍，rAF 一次都没触发，加了 --screenshot 也只多 1 帧）。
//   于是"她会不会永远弹下去"这种要命的问题只能靠读代码确认，而它恰恰
//   是最不该靠读代码确认的那类 —— 它坏了不报错，只是待机池、走动、睡觉全静默失效。
//   抽出来之后 selftest 可以在 Node 里把初始速度扫一遍，断言**必然收敛**。
//
// 不变量（每一条都对应一次真实的踩坑，见 README 的"三个必须守住的东西"）：
//   · 左右边界按**角色外轮廓**算（padX 由调用方给），不按窗口矩形
//   · 速度上限 V_MAX：鼠标甩出去的瞬时速度可以到几万 px/帧，不夹住会一帧穿出屏幕
//   · 落地必须结束：弹跳能量衰减到 REST 就停
//   · REST **必须大于** GRAVITY，否则会永远微弹（落地清零 -> 下一帧 vy 又等于 GRAVITY
//     -> 若阈值更小则又满足弹跳条件 -> 无限循环）
//   · 帧数硬上限 MAX_FRAMES：与物理无关的兜底。收敛依赖 rAF 持续被调用；
//     渲染层被降频、窗口被最小化、或哪天真出了个数值异常时 rAF 可能不再推进，
//     于是 mode 永久停在 'throw'。跑满就强制落地。
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetThrow = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const GRAVITY = 1.9;      // px/帧²
  const V_MAX = 46;         // px/帧，速度分量上限
  const REST = 4.0;         // 落地弹跳停止阈值，必须 > GRAVITY
  const SPIN_MAX = 14;      // 翻滚角速度上限（度/帧）
  const MAX_FRAMES = 600;   // ≈10 秒，兜底上限

  /** 由松手速度建初态。vx/vy 先夹到 ±V_MAX —— throwIt 里也要用夹后的值算旋转。 */
  function makeState(v0, x, y) {
    const vx = Math.max(-V_MAX, Math.min(V_MAX, v0.vx));
    const vy = Math.max(-V_MAX, Math.min(V_MAX, v0.vy));
    return {
      x: x, y: y, vx: vx, vy: vy, rot: 0,
      // 翻滚跟着水平速度走：往上直抛不转，横向甩出去才转
      spin: Math.max(-SPIN_MAX, Math.min(SPIN_MAX, vx * 1.6)),
      frames: 0
    };
  }

  /**
   * 推进一步。
   * @param {object} s 状态（原地修改）
   * @param {{left:number,right:number,ground:number}} lim 边界
   *        left/right 是**窗口**能到的左右极限，ground 是窗口 y 的下限
   * @returns {{done:boolean,reason?:string,wall:boolean,ground:boolean}}
   *        done=true 表示这一帧已经停稳（或触到帧数上限），调用方该收尾了
   */
  function step(s, lim) {
    s.frames++;
    // 兜底放在物理之前：它要能救**任何**数值异常，包括"下一步就会算出 NaN"那种
    if (s.frames > MAX_FRAMES) return { done: true, reason: 'cap', wall: false, ground: false };

    s.vy += GRAVITY;
    s.x += s.vx;
    s.y += s.vy;

    let wall = false;
    if (s.x < lim.left || s.x > lim.right) {
      s.x = s.x < lim.left ? lim.left : lim.right;
      s.vx = -s.vx * 0.55;
      s.spin = -s.spin * 0.55;
      wall = true;
    }

    let ground = false;
    if (s.y >= lim.ground) {
      s.y = lim.ground;
      if (s.vy > REST) {
        s.vy = -s.vy * 0.42;          // 弹一下
        s.vx *= 0.72;
        ground = true;
      } else {
        s.vy = 0;
        s.vx *= 0.55;                 // 落地摩擦
        if (Math.abs(s.vx) < 0.6) s.vx = 0;
      }
    }

    s.rot += s.spin;
    s.spin *= 0.995;

    const resting = (s.y >= lim.ground - 0.5) && s.vy === 0 && s.vx === 0;
    return { done: resting, wall: wall, ground: ground };
  }

  return {
    GRAVITY: GRAVITY, V_MAX: V_MAX, REST: REST,
    SPIN_MAX: SPIN_MAX, MAX_FRAMES: MAX_FRAMES,
    makeState: makeState, step: step
  };
});
