@echo off
rem League Voice - backend + app window
chcp 65001 >nul
cd /d "%~dp0"
title League Voice

set "NODE=node"
where node >nul 2>nul && goto run
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe" && goto run
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe" && goto run
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe" && goto run
echo [x] Node.js is required. Please install Node.js 20.11 or newer:
echo     https://nodejs.org/
echo.
pause
exit /b 1

:run
"%NODE%" "%~dp0src\app.ts" %*
if errorlevel 1 pause
