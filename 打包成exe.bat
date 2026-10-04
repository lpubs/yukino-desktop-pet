@echo off
chcp 936 >nul
cd /d "%~dp0"
title 打包雪乃桌宠

echo ============================================
echo   雪乃桌宠 · 打包 Windows 安装包
echo ============================================
echo.

if not exist "node_modules\electron\dist\electron.exe" (
  echo 依赖还没装，先装依赖...
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  call npm install --registry=https://registry.npmmirror.com --no-audit --no-fund
  if errorlevel 1 ( echo [失败] 依赖安装失败。 & pause & exit /b 1 )
)

echo 静态自检...
call node tools\selftest.js
if errorlevel 1 ( echo [失败] 自检未通过，先修掉再打包。 & pause & exit /b 1 )

echo.
echo 预处理打包缓存（修 winCodeSign 符号链接解压失败）...
call node tools\prep-build-cache.js

echo.
echo 开始打包（第一次会下载 electron-builder 的 nsis 资源，比较慢）...
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
call npx electron-builder --win --x64
if errorlevel 1 ( echo. & echo [失败] 打包失败，看上面的报错。 & pause & exit /b 1 )

echo.
echo 打包完成，产物在 dist\ 目录：
echo   - 雪乃桌宠 Setup x.y.z.exe   安装包
echo   - win-unpacked\              免安装版，可以直接双击里面的 exe
echo.
pause
