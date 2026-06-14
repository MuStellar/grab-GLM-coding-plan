# GLM Coding 自动抢购助手

基于 [Text_select_captcha](https://github.com/MgArcher/Text_select_captcha) 验证码识别系统，通过油猴脚本实现 GLM Coding 套餐准点自动抢购，支持点选验证码自动识别。

[拼好模打9.5折](https://www.bigmodel.cn/glm-coding?ic=CCQHLMSXTP)

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

## 使用方式

### 方式一：油猴脚本（推荐）

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展

2. 启动本地验证码识别服务：

```bash
pip install -r requirements.txt
python service.py
```

服务默认运行在 `http://127.0.0.1:8123`

3. 将 [glm.js](glm.js) 添加为油猴脚本

4. 打开 [GLM Coding 页面](https://bigmodel.cn/glm-coding)，页面左下角会出现控制面板

5. 在面板中配置套餐、周期和目标时间，点击「开启自动重试购买」

### 方式二：Python (Playwright，全自动)

无需油猴、无需单独启动 `service.py`——验证码识别在脚本进程内直接完成。

```bash
pip install -r requirements.txt
```

> 需本机已安装 Google Chrome（脚本用 `channel="chrome"` 调用系统 Chrome，不依赖 `playwright install`）。

编辑 [glm.py](glm.py) 中的 `CONFIG` 设置套餐、周期与目标时分秒，然后：

```bash
python glm.py
```

运行流程：

1. 自动打开一个**专用配置的 Chrome 窗口**（项目目录下的 `.chrome-profile`，与你日常 Chrome 互不干扰，**无需关闭日常 Chrome**），并跳转到 glm-coding 抢购页
2. 未登录时网站会自动弹出登录框 → 在该窗口内用手机号+验证码登录（**无需回到终端按键**，脚本自动检测登录完成后继续；登录态会保存在 `.chrome-profile`，下次免登录）
3. 进入倒计时 → 到点自动选周期、点购买 → 遇腾讯点选验证码自动识别并点选提交
4. 流程结束后浏览器保持打开（方便扫码支付）；关闭浏览器窗口或在终端按 `Ctrl+C` 即退出

> 注意：抢购时只认 `CONFIG` 里的**时分秒**、抢的是**当天**那个时刻；当天该时刻已过会立即开抢。

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
- 定时倒计时 + 自动选周期 + JS 点击购买 + 腾讯验证码自动识别点选

### 识别服务 API 增强

- 新增 `clickText` 参数：接收验证码提示文字（如「豹 雹 澄」），辅助排序匹配
- 新增 `dataType=2`：支持直接传入图片 base64 编码，无需公网 URL
- `aiohttp` 异步下载：服务端通过异步 HTTP 获取远程图片，降低响应延迟

## 验证码识别服务

油猴脚本依赖本地验证码识别 API（`http://127.0.0.1:8123/api/v1/identify`），需先启动 `service.py`。识别系统基于 YOLO + 孪生网络，详细技术架构、训练方案与部署配置请参阅：

[README_TEXT_SELECT.md](README_TEXT_SELECT.md)

## 致谢

- 验证码识别核心：[MgArcher/Text_select_captcha](https://github.com/MgArcher/Text_select_captcha)
- 核心油猴脚本：linux.do社区 @ballen开源的脚本

## 免责声明

本项目仅供学习交流使用，请遵守相关法律法规，不得用于任何非法用途。使用者需自行承担所有风险和责任。
