@echo off
rem 增量同步语言包(日/韩/美)
title League Voice Updater
chcp 65001 >nul
cd /d "%~dp0"
node "%~dp0src\index.ts" update run
pause
