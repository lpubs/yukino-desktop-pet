// tools/stage.js —— 打包前的暂存脚本
// 把真正要发布的文件复制到 release-src/，避免把 node_modules / dist / tools 一起打进包里
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STAGE = path.join(ROOT, 'release-src');

// 需要发布的文件 / 目录
const ITEMS = ['main.js', 'pomodoro.js', 'preload.js', 'renderer', 'assets'];
// 发布时附带的手写说明文件（放在项目根目录，没写就跳过）
const EXTRA_FILES = ['使用说明.txt'];

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
for (const item of ITEMS) {
  fs.cpSync(path.join(ROOT, item), path.join(STAGE, item), { recursive: true });
}
for (const f of EXTRA_FILES) {
  const src = path.join(ROOT, f);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(STAGE, f));
  else console.warn('（提示）没有找到 ' + f + '，这次的包里不会带它');
}
// 精简版 package.json（不含 devDependencies）
fs.writeFileSync(
  path.join(STAGE, 'package.json'),
  JSON.stringify({
    name: 'yukino-pet',
    version: require(path.join(ROOT, 'package.json')).version,
    description: '雪之下雪乃桌宠',
    main: 'main.js'
  }, null, 2)
);
console.log('已暂存到 release-src:', ITEMS.join(', '));
