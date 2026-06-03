@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo 正在啟動字幕產生程式...
node scripts\generate_subtitles.js %*

echo.
echo 執行完畢！按任意鍵關閉視窗...
pause >nul
