@echo off
rem League Voice - show current status (read only)
chcp 65001 >nul
cd /d "%~dp0"
title League Voice Status
node "%~dp0src\index.ts" status
echo.
pause >nul
