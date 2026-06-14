# GLM Coding 自动抢购助手

基于 [Text_select_captcha](https://github.com/MgArcher/Text_select_captcha) 验证码识别系统，通过油猴脚本实现 GLM Coding 套餐准点自动抢购，支持点选验证码自动识别。支持Windows/Linux/MacOS等多系统。

[拼好模打9.5折](https://www.bigmodel.cn/glm-coding?ic=FJGOX95A1A)

## 预备姿势
- 使用拼好模链接优惠
- 提前充值金额
- 提前10~20min进入网址


## 功能

- 准点自动点击指定套餐购买按钮
- 绕过限流拦截与售罄状态
- 腾讯点选验证码自动识别（YOLO + 孪生网络，全程本地、不上传第三方；方式一进程内完成，方式二走 `service.py`）
- 弹窗自动检测与重试闭环
- 可视化控制面板（套餐/周期/时间配置，方式二油猴版）

## 两种用法，先选一种

| | 方式一 · Playwright 全自动（推荐） | 方式二 · 油猴脚本 |
|---|---|---|
| 体验 | 启动后**真·全自动**，无需油猴、无需粘贴脚本 | 有可视化面板，但**必须手动把 `glm.js` 粘进 Tampermonkey**，并另起识别服务 |
| 适合 | 怕麻烦、想一条命令搞定 | 喜欢浏览器面板、已习惯油猴 |
| 验证码识别 | 脚本进程内完成 | 需单独起 `service.py` |

> ⚠️ **关于「一键脚本」的常见误解**：`start.cmd` / `start.sh` 只负责帮你**装依赖、起 Python 进程**。选方式二（油猴）时，它仅仅是把**验证码识别服务**跑起来——`glm.js` 这个油猴脚本**仍然要你亲手粘进 Tampermonkey**，一键脚本不会替你做这步。

## 准备工作（两种方式都要）

1. **安装 Python 3.8+**：到 [python.org](https://www.python.org/downloads/) 下载，安装时**务必勾选 “Add Python to PATH”**（新手最常漏的一步）。
2. **安装 Google Chrome**：方式一会调用系统已装的 Chrome（`channel="chrome"`，无需 `playwright install`）。

> 依赖安装和进程启动都可交给**一键脚本**：Windows 双击 [`start.cmd`](start.cmd)，Linux/macOS 运行 `chmod +x start.sh && ./start.sh`。它会自动**建 `.venv` 虚拟环境 → 装依赖 → 让你选 `1`/`2` 启动**（`1`=方式一，`2`=方式二的识别服务）。首次较慢，之后很快；依赖只装在项目内的 `.venv`，不污染系统 Python。
>
> （`start.cmd` 菜单是英文：`cmd.exe` 无法可靠解析含中文的批处理文件，会乱码、切断命令，故 Windows 版只用英文；`start.sh` 不受此限，用的中文。）

---

## 方式一：Playwright 全自动（推荐）

**启动**（任选其一）：

- 一键：双击 [`start.cmd`](start.cmd)（Win）/ 运行 `./start.sh`（Linux/macOS）→ 选 **1**
- 手动：`pip install -r requirements.txt` 后 `python glm.py`

**配置**：抢购参数（套餐 / 周期 / 时间）改 [glm.py](glm.py) 顶部的 `CONFIG`。

**运行流程**：

1. 自动打开一个**专用配置的 Chrome 窗口**（项目目录下的 `.chrome-profile`，与你日常 Chrome 互不干扰，**无需关闭日常 Chrome**），并跳转到 glm-coding 抢购页
2. 未登录时网站会自动弹出登录框 → 在该窗口内用手机号+验证码登录（**无需回到终端按键**，脚本自动检测登录完成后继续；登录态保存在 `.chrome-profile`，下次免登录）
3. 进入倒计时 → 到点自动选周期、点购买 → 遇腾讯点选验证码自动识别并点选提交
4. 抢到后自动停止点击、保持浏览器停在支付弹窗，你可从容扫码支付（其间脚本不再点击，不会把支付窗口点没）
5. 退出见下方「[退出 / 停止](#退出--停止)」

> 时间规则：抢购只认 `CONFIG` 里的**时分秒**。当天目标时刻起 **40 分钟内**打开都抢**当天**（已过点则立即开抢，正好赶回流）；**超过 40 分钟**（如默认 10:00 → 10:40 之后）才打开则自动滚到**明天**同一时刻。油猴版同此规则。

---

## 方式二：油猴脚本

> 油猴（[Tampermonkey](https://www.tampermonkey.net/)）是个浏览器扩展，能在指定网页上自动运行你装进去的「用户脚本」。本项目的 [glm.js](glm.js) 就是这样一个脚本——**它不会被一键脚本自动安装，得你手动粘进油猴**。

### 第 1 步 · 起验证码识别服务（保持开着）

- 一键：双击 [`start.cmd`](start.cmd) / 运行 `./start.sh` → 选 **2**
- 手动：`pip install -r requirements.txt` 后 `python service.py`

服务跑在 `http://127.0.0.1:8123`，**抢购期间这个窗口别关**（关了就识别不了验证码）。

### 第 2 步 · 把 glm.js 装进油猴（必须手动）

1. 浏览器装 [Tampermonkey](https://www.tampermonkey.net/) 扩展。
2. 点扩展图标 →「**管理面板 / Dashboard**」→ 顶部「**＋**」新建脚本。
3. 把编辑器里的模板**全选删除**，打开本仓库的 [glm.js](glm.js)，**全文复制粘贴**进去。
4. 按 **Ctrl+S** 保存。脚本头部带 `@match`，会自动绑定到 glm-coding 页面。
5. 脚本有更新时（如版本号变了），重复 3–4 把新内容覆盖粘贴进同一个脚本即可。

### 第 3 步 · 开抢

1. 打开 [GLM Coding 页面](https://www.bigmodel.cn/glm-coding?ic=FJGOX95A1A)，左下角自动出现控制面板。
2. 面板里配置套餐 / 周期 / 时间。
3. 点「**▶ 开始监听**」。到点自动抢，想停手点「**■ 停止监听**」。

## 退出 / 停止

| 你在用 | 怎么停 |
|--------|--------|
| **验证码识别服务**（`start.cmd` 选 2 / `python service.py`） | 在那个终端窗口按 **Ctrl+C** 停服务（uvicorn 会提示 `Press CTRL+C to quit`）；一键脚本启动的会停在「按任意键继续」，再按一下关窗口。也可直接关窗口。**抢购没结束别关**——关了油猴就识别不了验证码。 |
| **油猴脚本**（glm.js） | 点面板「**■ 停止监听**」即停手；想彻底不用就关闭/刷新页面，或在 Tampermonkey 里禁用该脚本。脚本在「抢到（弹支付框）/ 超过 40 分钟窗口 / 点击超 300 次」时也会**自动停**。 |
| **Playwright**（`start.cmd` 选 1 / `python glm.py`） | 抢到或达上限后脚本会**挂起、保持浏览器开着**让你扫码：扫完后**关闭浏览器窗口**或按 **Ctrl+C** 退出。运行中想中止也按 **Ctrl+C**。⚠️ `Ctrl+C` 会连脚本启动的这个浏览器一起关掉（终端信号会发给 Chrome 子进程，无法避免），所以**务必扫完码再退**。 |

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
