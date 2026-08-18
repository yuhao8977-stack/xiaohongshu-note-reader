@echo off
chcp 65001 >nul
title XHS Note Reader
cd /d "%~dp0"
echo Starting Xiaohongshu Note Reader...
node src\main.js
if errorlevel 1 (
  echo.
  echo Error occurred, please check messages above.
  pause
)
