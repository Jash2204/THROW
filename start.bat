@echo off
REM ============================================================
REM  THROW - start here.
REM  Serves the app locally and opens the editor tab.
REM  In the editor, click Display to open the projector tab,
REM  drag it onto the projector, fullscreen it, then calibrate
REM  live from the editor - everything syncs instantly.
REM ============================================================
cd /d "%~dp0app"

REM Pick a runtime that can actually serve this folder.
REM `where python` is NOT a valid test on Windows 10/11: it resolves the
REM Microsoft Store alias stub in %LOCALAPPDATA%\Microsoft\WindowsApps even
REM when Python is not installed, and running that stub opens the Store
REM instead of a server. So RUN each candidate and check its exit code
REM (the stub exits 9009 quietly). Note the redirects are >nul, not the
REM POSIX /dev/null - a bad redirect target makes the test always pass.
python -c "import sys" >nul 2>nul
if not errorlevel 1 goto usepython

py -c "import sys" >nul 2>nul
if not errorlevel 1 goto usepy

node -e "process.exit(0)" >nul 2>nul
if not errorlevel 1 goto usenode

goto noruntime

:usepython
set PYCMD=python
goto runpy

:usepy
set PYCMD=py
goto runpy

:runpy
echo Starting THROW at http://localhost:8420/THROW.html  (via %PYCMD%)
start "THROW server" /min %PYCMD% -m http.server 8420 --bind 127.0.0.1
goto opened

:usenode
echo Starting THROW at http://localhost:8420/THROW.html  (via node)
start "THROW server" /min node "%~dp0serve.js" 8420
goto opened

:opened
timeout /t 1 /nobreak >nul
start "" "http://localhost:8420/THROW.html"
echo.
echo THROW is open in your browser.
echo If the page says it can't connect, the server window (minimized,
echo titled "THROW server") will say why - check it before retrying.
echo To stop the server later, close that minimized window.
echo You can close THIS window now.
pause
exit /b 0

:noruntime
echo.
echo THROW needs Python or Node to serve its two tabs from one origin.
echo Neither was found on this PC.
echo.
echo   Python: https://www.python.org/downloads/
echo           Tick "Add python.exe to PATH" in the installer.
echo   Node:   https://nodejs.org/  (either works - install just one)
echo.
echo Then run this file again.
echo.
echo Note: if typing "python" opens the Microsoft Store, that is the
echo placeholder stub, not a real install - use the link above.
echo.
pause
exit /b 1
