@echo off
rem League Voice - graphical console (built-in web UI)
chcp 65001 >nul
cd /d "%~dp0"
title League Voice Tool

set "NODE=node"
where node >nul 2>nul && goto run
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe" && goto run
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe" && goto run
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe" && goto run
echo [x] Node.js not found. Please install Node.js 20.11 or newer:
echo     https://nodejs.org/
echo.
pause
exit /b 1

:run
echo [*] Starting League Voice backend (port 43110) ...
echo [*] The console page will open automatically in your browser.
echo.
"%NODE%" "%~dp0src\index.ts" serve --port 43110 --open
echo.
echo [!] Server stopped. Press any key to close.
pause >nul
