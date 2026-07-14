@echo off
REM ============================================================
REM  THROW - start here.
REM  Serves the app locally and opens the editor tab.
REM  In the editor, click Display to open the projector tab,
REM  drag it onto the projector, fullscreen it, then calibrate
REM  live from the editor - everything syncs instantly.
REM ============================================================
cd /d "%~dp0app"

set PYCMD=python
where python >/dev/null 2>nul
if not errorlevel 1 goto run
set PYCMD=py
where py >/dev/null 2>nul
if not errorlevel 1 goto run
goto nopython

:run
echo Starting THROW at http://localhost:8420/THROW.html
start "THROW server" /min %PYCMD% -m http.server 8420 --bind 127.0.0.1
timeout /t 1 /nobreak >nul
start "" "http://localhost:8420/THROW.html"
echo.
echo THROW is open in your browser.
echo To stop the server later, close the minimized THROW-server window.
echo You can close THIS window now.
pause
exit /b 0

:nopython
echo Python was not found on this PC.
echo Install it from https://www.python.org/downloads/ and tick the
echo "Add python.exe to PATH" box in the installer, then run this file again.
pause
exit /b 1
