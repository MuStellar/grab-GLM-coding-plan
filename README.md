# GLM Coding 自动抢购助手

基于 [Text_select_captcha](https://github.com/MgArcher/Text_select_captcha) 验证码识别系统，通过油猴脚本实现 GLM Coding 套餐准点自动抢购，支持点选验证码自动识别。

[拼好模打9.5折](https://www.bigmodel.cn/glm-coding?ic=FJGOX95A1A)

## 预备姿势
- 使用拼好模链接优惠
- 提前充值金额
- 提前10~20min进入网址


## 功能

- 准点自动点击指定套餐购买按钮
- 绕过限流拦截与售罄状态
- 腾讯点选验证码自动识别（调用本地识别服务）
- 弹窗自动检测与重试闭环
- 可视化控制面板（套餐/周期/时间配置）

## 准备工作（两种方式都要）

1. **安装 Python 3.8+**：到 [python.org](https://www.python.org/downloads/) 下载，安装时**务必勾选 “Add Python to PATH”**（这是新手最常漏的一步）。
2. **安装 Google Chrome**：Playwright 全自动方式会调用系统已装的 Chrome（`channel="chrome"`，无需 `playwright install`）。

依赖的安装与启动，下面**一键脚本**会自动帮你完成，无需手动敲命令。

## 一键启动（推荐）

下载/克隆本仓库后，按你的系统双击或运行对应脚本，它会自动**建虚拟环境 → 装依赖 → 让你选模式启动**：

- **Windows**：双击 [`start.cmd`](start.cmd)
- **Linux / macOS**：终端里运行 `chmod +x start.sh && ./start.sh`

运行后会让你二选一：

```
1) Playwright 全自动抢购（推荐：免油猴、免单独起服务）
2) 启动验证码识别服务（配合油猴脚本 glm.js 使用）
```

> 首次运行会创建 `.venv` 虚拟环境并联网装依赖，较慢；之后再启动就很快了。依赖只装在项目里的 `.venv`，不污染系统 Python。

抢购参数（套餐 / 周期 / 时间）：Playwright 方式改 [glm.py](glm.py) 顶部的 `CONFIG`；油猴方式在页面左下角控制面板里改。

## 手动方式（不想用一键脚本时）

> 以下命令二选一即可；推荐先建虚拟环境：`python -m venv .venv` 再激活
> （Windows：`.venv\Scripts\activate`；Linux/macOS：`source .venv/bin/activate`）。

### 方式一：油猴脚本

```bash
pip install -r requirements.txt
python service.py        # 验证码识别服务，默认 http://127.0.0.1:8123，保持开着
```

然后：安装 [Tampermonkey](https://www.tampermonkey.net/) → 把 [glm.js](glm.js) 添加为油猴脚本 → 打开 [GLM Coding 页面](https://www.bigmodel.cn/glm-coding?ic=FJGOX95A1A) → 左下角控制面板里配置套餐/周期/时间 → 点「开启自动重试购买」。

### 方式二：Python (Playwright，全自动)

无需油猴、无需单独启动 `service.py`——验证码识别在脚本进程内直接完成。

```bash
pip install -r requirements.txt
python glm.py
```

运行流程：

1. 自动打开一个**专用配置的 Chrome 窗口**（项目目录下的 `.chrome-profile`，与你日常 Chrome 互不干扰，**无需关闭日常 Chrome**），并跳转到 glm-coding 抢购页
2. 未登录时网站会自动弹出登录框 → 在该窗口内用手机号+验证码登录（**无需回到终端按键**，脚本自动检测登录完成后继续；登录态会保存在 `.chrome-profile`，下次免登录）
3. 进入倒计时 → 到点自动选周期、点购买 → 遇腾讯点选验证码自动识别并点选提交
4. 抢到后自动停止点击、保持浏览器停在支付弹窗，你可从容扫码支付（其间脚本不再点击，不会把支付窗口点没）
5. 想退出：关闭浏览器窗口，或在终端按 `Ctrl+C`——注意 `Ctrl+C` 会随手关掉脚本启动的这个浏览器（终端信号会一并发给 Chrome 子进程，无法避免），所以**扫完码再退**

> 注意：抢购时只认 `CONFIG` 里的**时分秒**、抢的是**当天**那个时刻；当天该时刻已过会立即开抢。

## 跨平台说明（Windows / Linux / macOS）

代码不写死任何单一系统：文件路径用 `os.path` 拼接、Chrome 用 Playwright 的 `channel="chrome"` 按系统自动定位、CJK 字体在 [src/captcha.py](src/captcha.py) 里准备了三大系统的候选路径（找不到会明确报错而非静默渲染失败）。

仓库带了一个 [跨平台冒烟测试](.github/workflows/smoke.yml)（GitHub Actions），在 Ubuntu / macOS / Windows × Python 3.10/3.12 上自动验证：依赖可安装、模块可导入、关键路径与中文字体在各系统都能解析。想本地自测某个系统，最省事的是用 Docker 跑 Linux：

```bash
docker run --rm -it -v "${PWD}:/app" -w /app python:3.12 bash -lc \
  "apt-get update && apt-get install -y fonts-noto-cjk && pip install -r requirements.txt && \
   python -m py_compile glm.py service.py && \
   python -c 'from src.captcha import _load_cjk_font; _load_cjk_font(40); print(\"ok\")'"
```

macOS 没有官方容器，需在真机或 CI（如上面的 Actions）上验证。

## 配置说明

| 配置项 | 说明 | 可选值 |
|--------|------|--------|
| targetPlan | 目标套餐 | Lite / Pro / Max |
| billingCycle | 计费周期 | month / quarter / year |
| targetHour | 目标时 | 0-23 |
| targetMinute | 目标分 | 0-59 |
| targetSecond | 目标秒 | 0-59 |

## 相比原项目新增功能

基于 [Text_select_captcha](https://github.com/MgArcher/Text_select_captcha) 原项目的验证码识别能力，本项目新增以下功能：

### 油猴脚本自动抢购 ([glm.js](glm.js))

- **网络拦截层**：绕过限流接口检查、篡改售罄/库存数据、拦截限流页面跳转
- **验证码图片拦截**：重写 Image 构造函数与 createElement，自动捕获腾讯验证码图片并缓存 base64
- **验证码自动识别**：通过 `GM_xmlhttpRequest` 调用本地识别 API，自动点击目标并提交
- **弹窗自动处理**：检测「购买人数较多」/无价格弹窗自动关闭重试，检测真实支付弹窗自动停止
- **闭环重试机制**：倒计时 → 自动点击购买 → 弹窗检测 → 验证码处理 → 重新点击，直到出现支付窗口
- **可视化控制面板**：页面左下角悬浮面板，可配置套餐、周期、目标时间，实时显示状态与日志

### Python 抢购脚本 ([glm.py](glm.py))

- 基于 Playwright 的浏览器自动化方案，全程无人值守
- 验证码识别在进程内完成，无需单独启动 `service.py`
- 专用 `.chrome-profile` 配置目录，免关闭日常 Chrome；登录态持久化，下次免登录
- 自动检测登录状态，登录完成后自动继续，无需终端交互
- 定点改写售罄数据（`/api/biz/pay/preview`）+ 绕过限流，与油猴版一致
- 支付弹窗按「可见性」判定，避免隐藏残留节点造成误报停机
- 定时倒计时 + 自动选周期 + JS 点击购买 + 腾讯验证码自动识别点选
- 抢到后自动停止点击并保持浏览器打开，方便从容扫码支付

### 识别服务 API 增强

- 新增 `clickText` 参数：接收验证码提示文字（如「豹 雹 澄」），辅助排序匹配
- 新增 `dataType=2`：支持直接传入图片 base64 编码，无需公网 URL
- `aiohttp` 异步下载：服务端通过异步 HTTP 获取远程图片，降低响应延迟

## 验证码识别服务

油猴脚本依赖本地验证码识别 API（`http://127.0.0.1:8123/api/v1/identify`），需先启动 `service.py`。识别系统基于 YOLO + 孪生网络，详细技术架构、训练方案与部署配置请参阅：

[README_TEXT_SELECT.md](README_TEXT_SELECT.md)

## 致谢

- 验证码识别核心：[MgArcher/Text_select_captcha](https://github.com/MgArcher/Text_select_captcha)
- 核心油猴脚本
    - linux.do社区 @ballen 开源的原始脚本 原帖 https://linux.do/t/topic/1954655
    - linux.do社区 @xcd-jjj111 的升级脚本 原帖 https://linux.do/t/topic/2191688 Github链接 https://github.com/lyingflatDDD/grab-GLM-coding-plan

## 免责声明

本项目仅供学习交流使用，请遵守相关法律法规，不得用于任何非法用途。使用者需自行承担所有风险和责任。
