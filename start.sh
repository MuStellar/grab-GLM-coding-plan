#!/usr/bin/env bash
# GLM Coding Plan 自动抢购助手 - 一键启动 (Linux / macOS)
# 用法：chmod +x start.sh && ./start.sh
set -e
cd "$(dirname "$0")"

echo "===================================================="
echo "  GLM Coding Plan 自动抢购助手 - 一键启动 (Linux/macOS)"
echo "===================================================="
echo

# ---- 1. 找 Python ----
if command -v python3 >/dev/null 2>&1; then
    PY=python3
elif command -v python >/dev/null 2>&1; then
    PY=python
else
    echo "[错误] 没找到 Python，请先安装 Python 3.8+。"
    exit 1
fi

# ---- 2. 建虚拟环境（首次） ----
# 既判断 venv 在不在，也判断里面的 pip 可不可用：上次中断或缺 venv 包会留下
# 没装 pip 的半成品 .venv，得删掉重建，否则后面 pip install 会报 No module named pip。
create_venv() {
    echo "[1/3] 正在创建虚拟环境 .venv ..."
    if "$PY" -m venv .venv; then
        return
    fi
    # Debian/Ubuntu 默认不带 venv 包，建虚拟环境会失败。能用 apt 就自动补装再重试。
    if command -v apt >/dev/null 2>&1; then
        echo "创建失败，疑似缺少 venv 包，尝试自动安装（需要 sudo 密码）..."
        if sudo apt install -y python3-venv && "$PY" -m venv .venv; then
            return
        fi
    fi
    echo
    echo "[错误] 创建虚拟环境失败。请手动安装 venv 包后重试："
    echo "        sudo apt install python3-venv      # Debian/Ubuntu"
    echo "       装好后重新运行 ./start.sh"
    exit 1
}

if [ ! -x ".venv/bin/python" ]; then
    create_venv
elif ! .venv/bin/python -m pip --version >/dev/null 2>&1; then
    echo "检测到 .venv 不完整（缺少 pip），删除后重建 ..."
    rm -rf .venv
    create_venv
fi
VPY=".venv/bin/python"

# ---- 3. 装依赖 ----
echo "[2/3] 正在安装/检查依赖（首次较慢，请耐心等待）..."
"$VPY" -m pip install --upgrade pip >/dev/null
"$VPY" -m pip install -r requirements.txt

# ---- 4. 选模式 ----
echo
echo "[3/3] 选择运行模式："
echo "   1) Playwright 全自动抢购（推荐：免油猴、免单独起服务）"
echo "   2) 启动验证码识别服务（配合油猴脚本 glm.js 使用）"
echo
read -r -p "请输入 1 或 2 后回车: " MODE

case "$MODE" in
    1)
        echo
        echo "启动 Playwright 抢购脚本 glm.py ..."
        "$VPY" glm.py
        ;;
    2)
        echo
        echo "启动验证码识别服务 http://127.0.0.1:8123"
        echo "保持本窗口开着，再去浏览器里用油猴脚本抢购。"
        "$VPY" service.py
        ;;
    *)
        echo "未识别的选项，已退出。"
        ;;
esac
