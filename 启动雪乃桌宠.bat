@echo off
chcp 936 >nul
cd /d "%~dp0"
title 雪乃桌宠

echo ============================================
echo   雪乃桌宠  v3
echo ============================================
echo.

if not exist "node_modules\electron\dist\electron.exe" (
  echo [1/2] 首次运行，正在安装依赖...
  echo       走国内镜像，官方源在国内会卡很久。
  echo.
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  call npm install --registry=https://registry.npmmirror.com --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   [失败] 依赖没装成功。
    echo   请确认已经装了 Node.js，并且网络能访问 npmmirror.com。
    echo.
    pause
    exit /b 1
  )
  echo.
) else (
  echo [1/2] 依赖已就绪。
)

echo [2/2] 静态自检...
call node tools\selftest.js
if errorlevel 1 (
  echo.
  echo   [失败] 自检没通过，先按上面的提示修掉再启动。
  echo.
  pause
  exit /b 1
)

echo.
echo 启动中... 雪乃会出现在右下角。
echo 右键她可以换装 / 开番茄钟 / 看统计。
echo 托盘图标右键可以退出。
echo.

start "" "node_modules\electron\dist\electron.exe" .
exit /b 0
