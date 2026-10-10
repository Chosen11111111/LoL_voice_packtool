@echo off
rem League Voice - incremental voice pack sync
chcp 65001 >nul
cd /d "%~dp0"
title League Voice Updater
node "%~dp0src\index.ts" update run
echo.
pause >nul
