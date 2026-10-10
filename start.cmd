@echo off
rem 英雄联盟 语音包/语言包 切换器 —— 图形控制台(内置网页界面)
title League Voice Tool
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [x] 未检测到 Node.js，请先安装 Node.js 20.11 或更高版本: https://nodejs.org/
  pause
  exit /b 1
)

echo [*] 正在启动后端服务...
start "" http://127.0.0.1:43110/
node "%~dp0src\index.ts" serve --port 43110
if errorlevel 1 pause
