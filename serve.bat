@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PORT=8765

netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul
if %errorlevel%==0 goto OPEN

echo Starting local server on port %PORT% ...
start "" http://127.0.0.1:%PORT%/spine_viewer/index.html
python -m http.server %PORT% --bind 127.0.0.1
goto END

:OPEN
echo Server already running on port %PORT%.
start "" http://127.0.0.1:%PORT%/spine_viewer/index.html
timeout /t 3 >nul

:END
