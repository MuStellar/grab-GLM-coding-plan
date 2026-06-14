@echo off
REM NOTE: This launcher uses English only on purpose.
REM cmd.exe cannot reliably parse non-ASCII (Chinese) batch files - it
REM desyncs and splits commands. Full Chinese guide is in README.md.
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ====================================================
echo   GLM Coding Plan grab helper - one-click launcher
echo ====================================================
echo.

REM ---- 1. Find Python ----
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
    where python >nul 2>nul && set "PY=python"
)
if not defined PY (
    echo [ERROR] Python not found.
    echo         Install Python 3.8+ and tick "Add Python to PATH":
    echo         https://www.python.org/downloads/
    echo.
    pause
    exit /b 1
)

REM ---- 2. Create virtual env (first run only) ----
if not exist ".venv\Scripts\python.exe" (
    echo [1/3] First run: creating virtual env .venv ...
    %PY% -m venv .venv
    if errorlevel 1 (
        echo [ERROR] Failed to create virtual env. Check your Python install.
        pause
        exit /b 1
    )
)
set "VPY=.venv\Scripts\python.exe"

REM ---- 3. Install dependencies ----
echo [2/3] Installing/checking dependencies (first run is slow, please wait)...
"%VPY%" -m pip install --upgrade pip >nul 2>nul
"%VPY%" -m pip install -r requirements.txt
if errorlevel 1 (
    echo [ERROR] Dependency install failed. Check your network and retry.
    pause
    exit /b 1
)

REM ---- 4. Choose mode ----
echo.
echo [3/3] Choose a mode:
echo    1) Playwright fully-automatic grab  (recommended: no Tampermonkey, no separate service)
echo    2) Start captcha recognition service (used together with the Tampermonkey script glm.js)
echo.
set /p MODE="Enter 1 or 2, then press Enter: "

if "%MODE%"=="1" (
    echo.
    echo Starting Playwright grab script glm.py ...
    "%VPY%" glm.py
) else if "%MODE%"=="2" (
    echo.
    echo Starting captcha recognition service at http://127.0.0.1:8123
    echo Keep this window open, then grab in the browser via the Tampermonkey script.
    "%VPY%" service.py
) else (
    echo Unrecognized choice, exiting.
)

echo.
pause
