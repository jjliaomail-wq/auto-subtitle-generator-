@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [Speaker Diarization] Starting...
node scripts\generate_subtitles_diarize.js %*
echo.
echo Done. Press any key to close...
pause >nul
