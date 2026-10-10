@echo off
rem 查看当前语音/语言包状态(只读)
title League Voice Status
chcp 65001 >nul
cd /d "%~dp0"
node "%~dp0src\index.ts" status
pause
