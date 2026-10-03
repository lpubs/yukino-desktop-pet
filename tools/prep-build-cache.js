#!/usr/bin/env node
// 雪乃桌宠 · 打包前置：修 electron-builder 的 winCodeSign 缓存
//
// 要解决的问题：
//   electron-builder 为 Windows 目标会下载 `winCodeSign-2.6.0.7z`，
//   但这个包里含 **macOS / Linux 用的符号链接**（darwin/10.12/lib/libcrypto.dylib 之类）。
//   Windows 上创建符号链接需要"创建符号链接"特权（默认只有管理员或开了开发者模式才有），
//   于是 7za 解压报 `Cannot create symbolic link : 客户端没有所需的特权`，
//   退出码 2 → electron-builder 判定下载失败并重试 4 次，最后 `cannot execute`。
//
//   而那些 darwin/linux 文件在 Windows 上**根本用不到**（真正需要的只有
//   windows-10/、windows-6/、appxAssets/、rcedit-x64.exe）。
//
// 做法：
//   手工用 7za 解出来，**排除 darwin 和 linux**，放到 electron-builder 期望的缓存路径。
//   缓存命中后 electron-builder 会直接跳过下载+解压，问题消失。
//
// 零依赖（7za 来自 node_modules/7zip-bin）。用法：node tools/prep-build-cache.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NAME = 'winCodeSign-2.6.0';
const PKG = 'winCodeSign';
const VER = '2.6.0';
const MIRROR = process.env.ELECTRON_BUILDER_BINARIES_MIRROR
  || 'https://npmmirror.com/mirrors/electron-builder-binaries/';
const URL = `${MIRROR}${NAME}/${NAME}.7z`;

// 需要保留的目录（其余一律不要，尤其是带符号链接的 darwin / linux）
const KEEP_ONLY = ['windows-10', 'windows-6', 'appxAssets', 'openssl-ia32'];

function cacheRoot() {
  // app-builder-lib 把 ELECTRON_BUILDER_CACHE 设成"以路径分隔符结尾的前缀"
  if (process.env.ELECTRON_BUILDER_CACHE) return process.env.ELECTRON_BUILDER_CACHE;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'electron-builder', 'Cache') + path.sep;
}

function ok(dir) {
  return fs.existsSync(path.join(dir, 'rcedit-x64.exe'));
}

function find7za() {
  const p = path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
  if (!fs.existsSync(p)) throw new Error('找不到 7za.exe，先跑 npm install');
  return p;
}

function findArchive(cache) {
  const dir = path.join(cache, PKG);
  if (!fs.existsSync(dir)) return null;
  const hit = fs.readdirSync(dir).filter((f) => f.endsWith('.7z'));
  return hit.length ? path.join(dir, hit[0]) : null;
}

function download(url, out, depth = 0) {
  if (depth > 5) return Promise.reject(new Error('重定向太多次'));
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'node' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return download(next, out, depth + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const ws = fs.createWriteStream(out);
      res.pipe(ws);
      ws.on('finish', () => ws.close(() => resolve(out)));
      ws.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  const cache = cacheRoot();
  // electron-builder 实际认哪个路径取决于 app-builder 的内部实现，
  // 这里两个候选都准备好，哪个命中都行。
  const targets = [
    path.join(cache, PKG, NAME),
    path.join(cache, NAME),
  ];

  if (targets.some(ok)) {
    console.log('[缓存] winCodeSign 已就绪，跳过。');
    return;
  }

  let archive = findArchive(cache);
  if (!archive) {
    // 复用 app-builder 下坏之前留下的 .7z；找不到才自己下载
    console.log('[下载] ' + URL);
    archive = path.join(cache, PKG, NAME + '.7z');
    await download(URL, archive);
    console.log('[下载] 完成 -> ' + archive);
  } else {
    console.log('[复用] 已存在的压缩包 -> ' + archive);
  }

  const sz = find7za();
  for (const t of targets) {
    fs.rmSync(t, { recursive: true, force: true });
    fs.mkdirSync(t, { recursive: true });
    const args = ['x', '-bd', '-y'];
    // 排除所有不需要的顶层目录，避开符号链接
    args.push('-x!darwin', '-x!linux');
    args.push('-o' + t, archive);
    try {
      execFileSync(sz, args, { stdio: 'pipe' });
      const kept = KEEP_ONLY.filter((d) => fs.existsSync(path.join(t, d)));
      console.log(`[解压] ${t}  exit=0  保留 ${kept.join(', ')}`);
    } catch (e) {
      console.error(`[解压] ${t} 失败：`, (e.stdout || e.message || '').toString().slice(-400));
      process.exitCode = 1;
    }
  }

  if (!targets.some(ok)) {
    console.error('[失败] 解压后仍找不到 rcedit-x64.exe，打包可能会失败。');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('[错误]', e.message);
  process.exitCode = 1;
});
