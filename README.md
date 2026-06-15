# GLM Coding Plan 自动抢购助手

GLM Coding Plan 套餐准点自动抢购，自动点选验证码。验证码识别在本地完成，不上传第三方。支持 Windows、Linux、macOS。

[拼好模 9.5 折链接](https://www.bigmodel.cn/glm-coding?ic=FJGOX95A1A)

## 抢购前准备

- 用拼好模链接进入，享折扣
- 提前给在智谱账户后台充值好余额
- 提前 10~20 分钟打开页面

## 环境准备

两种用法都需要：

1. 安装 Python 3.8 以上。到 [python.org](https://www.python.org/downloads/) 下载，安装时勾选 “Add Python to PATH”。
2. 安装 Google Chrome。

已安装可以忽略。

Debian/Ubuntu 用户注意：系统默认不带 `python3-venv` 包，`start.sh` 会在建虚拟环境失败时自动用 apt 补装（需输入 sudo 密码）。验证码所需的中文字体已随项目内置，无需另装。

## 选哪种用法

- 方式一（Playwright）：一条命令启动，全程自动，不用装油猴。新手推荐。
- 方式二（油猴脚本）：浏览器里有可视化面板，比较直观，但要手动把脚本粘进油猴扩展，并单独开一个识别服务。

方式二选一即可。

### 方式一：Playwright

启动，下述方式二选一：

- 一键启动：Windows 双击 `start.cmd`；Linux、macOS 运行 `./start.sh`。然后输入 `1`。
- 命令行：先 `pip install -r requirements.txt`，再 `python glm.py`。

方式一要弹出浏览器窗口，需在带桌面的环境运行，并装好 Google Chrome（WSL 需 WSLg）。缺 Chrome 时按脚本提示运行 `playwright install chrome`。Linux 上若浏览器起不来，再补一句 `sudo playwright install-deps`。

启动后：

1. 弹出一个独立的 Chrome 窗口并打开抢购页（用项目里的 `.chrome-profile`，和你平时的 Chrome 不冲突，也不用关掉平时的 Chrome）。
2. 没登录时网页会自动弹登录框，在这个窗口里用手机号加验证码登录即可，脚本会自动检测登录完成。登录状态会记住，下次免登录。
3. 倒计时到点后自动选周期、点购买，遇到验证码自动识别并点选。
4. 抢到后停止点击，停在支付弹窗，你扫码付款即可。

默认抢的是 Lite 连续包月套餐，如需其它套餐，请自行修改 [glm.py](glm.py) 顶部的 `CONFIG`。

| 配置项 | 说明 | 可选值 |
|--------|------|--------|
| targetPlan | 目标套餐 | Lite / Pro / Max |
| billingCycle | 计费周期 | month / quarter / year |
| targetHour | 目标时 | 0-23 |
| targetMinute | 目标分 | 0-59 |
| targetSecond | 目标秒 | 0-59 |

时间规则：脚本只看 `CONFIG` 里的时分秒。当天目标时刻（默认10:00:00）内 40 分钟内打开，抢当天（已过点就立即开抢，正好赶回流）。10:40:00 后打开脚本将自动改抢明天同一目标时刻。

### 方式二：油猴脚本

油猴（Tampermonkey）是浏览器扩展，能在指定网页自动运行你装进去的脚本。本项目的 [glm.js](glm.js) 需要你手动粘进去，一键脚本不能帮你装。

第 1 步，开识别服务（**保持开着**），下述方式二选一：

- 一键启动：Windows 双击 `start.cmd`；Linux、macOS 运行 `./start.sh`。然后输入 `2`。
- 命令行：先 `pip install -r requirements.txt`，再 `python service.py`。

服务地址是 `http://127.0.0.1:8123`。抢购期间别关这个窗口，关了就识别不了验证码。

第 2 步，把脚本装进油猴：

1. 浏览器装 [Tampermonkey](https://www.tampermonkey.net/) 扩展。
2. 打开 `chrome://extensions`，找到 Tampermonkey，点「详情」，打开「允许用户脚本」。新版 Chrome 不开这个，脚本不会运行。
3. 点扩展图标，进管理面板，点顶部的「+」新建脚本。
4. 把编辑器里的模板全选删掉，打开 [glm.js](glm.js)，把全文复制粘贴进去。
5. 按 Ctrl+S 保存。
6. 以后脚本有更新，重复第 4、5 步覆盖粘贴即可。

第 3 步，开抢：

1. 打开 [GLM Coding 页面](https://www.bigmodel.cn/glm-coding?ic=FJGOX95A1A)，左下角会出现面板。
2. 在面板里自选套餐、周期、时间。
3. 点「开始监听」。到点自动抢，想停手点「停止监听」。

## 怎么退出

- 识别服务（service.py）：在它的终端窗口按 Ctrl+C，或直接关窗口。抢购没结束别关。
- 油猴脚本：点面板「停止监听」，或关掉、刷新页面。抢到、超过 40 分钟、点击太多次时也会自动停。
- Playwright（glm.py）：抢到后脚本会停在支付页、保持浏览器开着，扫完码再关窗口或按 Ctrl+C。注意按 Ctrl+C 会顺手把这个浏览器一起关掉，所以扫完码再退。没抢到时，超过目标时刻 40 分钟会自动停。

## 相比原项目新增功能

基于 [Text_select_captcha](https://github.com/MgArcher/Text_select_captcha) 的验证码识别能力，本项目新增：

油猴脚本 [glm.js](glm.js)：

- 绕过限流接口、改写售罄/库存数据、拦截限流页面跳转
- 自动捕获腾讯验证码图片并缓存
- 调用本地识别接口，自动点选并提交
- 自动处理「购买人数较多」、无价格等弹窗，检测到真实支付弹窗后停止
- 倒计时、点购买、弹窗检测、验证码处理的闭环重试
- 左下角可视化面板，配置套餐、周期、时间，实时显示状态

Python 脚本 [glm.py](glm.py)：

- 基于 Playwright，全程无人值守
- 验证码识别在进程内完成，不用单独开 service.py
- 验证码识别不全时自动「换一张」，换到能识全的新题再点选，不硬交残缺答案
- 专用 `.chrome-profile`，不影响平时的 Chrome，登录状态可复用
- 自动检测登录，登录后自动继续
- 改写售罄数据、绕过限流，与油猴版一致
- 支付弹窗按可见性判定，避免隐藏节点误报停机
- 到点后持续重试，直到抢到或超过目标时刻 40 分钟才停
- 抢到后停止点击并保持浏览器打开，方便扫码

识别服务 API：

- 新增 `clickText` 参数，接收验证码提示文字辅助排序
- 新增 `dataType=2`，支持直接传图片 base64
- 用 aiohttp 异步下载远程图片，降低延迟

识别系统的技术细节见 [README_TEXT_SELECT.md](README_TEXT_SELECT.md)。

## 致谢

- 验证码识别核心：[MgArcher/Text_select_captcha](https://github.com/MgArcher/Text_select_captcha)
- 核心油猴脚本：
    - linux.do 社区 @ballen 的原始脚本，原帖 https://linux.do/t/topic/1954655
    - linux.do 社区 @xcd-jjj111 的升级脚本，原帖 https://linux.do/t/topic/2191688 ，GitHub https://github.com/lyingflatDDD/grab-GLM-coding-plan

## 免责声明

本项目仅供学习交流使用，请遵守相关法律法规，不得用于任何非法用途。使用者需自行承担所有风险和责任。
