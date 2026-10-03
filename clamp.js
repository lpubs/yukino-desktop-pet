// 雪乃桌宠 · 窗口位置约束
//
// 抽成独立文件是**为了能被真正验证**：
//   这段逻辑原来长在 main.js 里，而 main.js 只能在 Electron 里跑
//   （本机沙箱里 Electron 起不来），于是"拖出屏幕"这个 bug 只能靠读代码确认。
//   抽出来之后，renderer/preview.html 的替身也用同一份 —— 在浏览器里就能
//   把角色往屏幕外拖，肉眼确认它被拉回来。
//
// 为什么必须夹：桌宠不在任务栏、没有窗口列表入口。一旦被拖出屏幕，
// 用户除了手改配置文件之外**没有任何办法**把它叫回来。
//
// 用 workArea（带 x/y）而不是 workAreaSize：多显示器、或任务栏放在左侧/顶部时，
// 只有 workArea 才算得对。
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetClamp = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * 把桌宠夹进工作区。
   *
   * 注意夹的是**角色外轮廓**，不是窗口矩形 —— 这两个不一样，而且差别很大。
   * 窗口是透明的、无边框的，宽度按最宽的一套素材定（404），但角色本身在窗口里
   * 水平居中，所以窄的装扮（水手服显示宽只有 189px）左右各会剩 107px 透明边。
   * 如果夹窗口矩形，角色就永远离屏幕边缘 107px，"贴边"根本没贴上去。
   * 所以用 padX 把这段透明边**放到屏幕外**：
   *   窗口左边最多可以到 area.x - padX，此时角色左轮廓正好压在 area.x 上。
   * 安全性不受影响：padX ≤ petW/2，所以窗口始终有 ≥ petW/2 的宽度留在屏幕内，
   * 永远抓得住 —— 而角色整个都可见。
   *
   * @param {number} x 期望的 x
   * @param {number} y 期望的 y
   * @param {{x:number,y:number,width:number,height:number}} area 工作区矩形
   * @param {number} petW 窗口宽
   * @param {number} petH 窗口高
   * @param {number} sink 该套装扮要沉到工作区底边以下多少像素
   *                    （半身像的裁切边藏到任务栏后面用）
   * @param {number} padX 角色左右两侧的透明边宽（默认 0 = 夹窗口矩形）
   */
  function clampPos(x, y, area, petW, petH, sink, padX) {
    const p = padX > 0 ? padX : 0;
    // Math.max(..., area.x) 兜底：工作区比窗口还窄/矮时，
    // 下界会大于上界，Math.min/max 的顺序会让结果落在下界上，不会算出 NaN。
    const maxX = Math.max(area.x - p, area.x + area.width - petW + p);
    const maxY = Math.max(area.y, area.y + area.height - petH + (sink || 0));
    return {
      x: Math.min(Math.max(Math.round(x), area.x - p), maxX),
      y: Math.min(Math.max(Math.round(y), area.y), maxY)
    };
  }

  return { clampPos: clampPos };
});
