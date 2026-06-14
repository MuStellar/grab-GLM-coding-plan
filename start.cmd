@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ====================================================
echo   GLM Coding 自动抢购助手 - 一键启动 (Windows)
echo ====================================================
echo.

REM ---- 1. 找 Python ----
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
    where python >nul 2>nul && set "PY=python"
)
if not defined PY (
    echo [错误] 没找到 Python。请先安装 Python 3.8+ 并在安装时勾选
    echo        "Add Python to PATH"，下载地址：
    echo        https://www.python.org/downloads/
    echo.
    pause
    exit /b 1
)

REM ---- 2. 建虚拟环境（首次） ----
if not exist ".venv\Scripts\python.exe" (
    echo [1/3] 首次运行：正在创建虚拟环境 .venv ...
    %PY% -m venv .venv
    if errorlevel 1 (
        echo [错误] 创建虚拟环境失败，请确认 Python 安装完整。
        pause
        exit /b 1
    )
)
set "VPY=.venv\Scripts\python.exe"

REM ---- 3. 装依赖 ----
echo [2/3] 正在安装/检查依赖（首次较慢，请耐心等待）...
"%VPY%" -m pip install --upgrade pip >nul 2>nul
"%VPY%" -m pip install -r requirements.txt
if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
)

REM ---- 4. 选模式 ----
echo.
echo [3/3] 选择运行模式：
echo    1) Playwright 全自动抢购（推荐：免油猴、免单独起服务）
echo    2) 启动验证码识别服务（配合油猴脚本 glm.js 使用）
echo.
set /p MODE="请输入 1 或 2 后回车: "

if "%MODE%"=="1" (
    echo.
    echo 启动 Playwright 抢购脚本 glm.py ...
    "%VPY%" glm.py
) else if "%MODE%"=="2" (
    echo.
    echo 启动验证码识别服务 http://127.0.0.1:8123
    echo 保持本窗口开着，再去浏览器里用油猴脚本抢购。
    "%VPY%" service.py
) else (
    echo 未识别的选项，已退出。
)

echo.
pause
