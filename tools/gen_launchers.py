#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
雪乃桌宠 · 生成 Windows 双击启动脚本

为什么要用脚本生成、而不是直接手写 .bat：

  cmd.exe 读取 .bat 时用的是**控制台代码页**（中文 Windows 默认 936/GBK），
  不是 UTF-8。所以只要 .bat 里带中文，就必须以 GBK 落盘，
  否则用户双击后看到的是乱码提示。
  而本项目的编辑器/工具链默认写 UTF-8 —— 直接手写必然踩坑。
  这里统一用 GBK 写出，并在脚本开头 `chcp 936` 把代码页也钉死。

另外，脚本里**不出现任何中文路径字面量**：一律用 %~dp0 取自身所在目录，
这样即使项目被挪到别的目录（比如任意盘符下的「某个文件夹\v3」），也不会因为
路径编码问题而 cd 失败。

用法：
    python tools/gen_launchers.py
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

LAUNCH = r"""@echo off
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
"""

BUILD = r"""@echo off
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
"""

TARGETS = [("启动雪乃桌宠.bat", LAUNCH), ("打包成exe.bat", BUILD)]


def main():
    for name, body in TARGETS:
        p = ROOT / name
        # 用 CRLF，Windows 的 .bat 用 LF 虽然多数情况也能跑，但没必要冒这个险
        data = body.replace("\n", "\r\n").encode("gbk")
        p.write_bytes(data)
        print(f"{name}  ->  {p}  ({len(data)} bytes, GBK + CRLF)")


if __name__ == "__main__":
    main()
