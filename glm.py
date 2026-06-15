#!/usr/bin/env python
# -*-coding:utf-8 -*-

"""
# File       : glm.py
# Description：bigmodel.cn/glm-coding 抢购 + 腾讯点选验证码自动识别
"""
import os
import re
import time
from datetime import datetime, timedelta
import requests
from playwright.sync_api import sync_playwright
from src import captcha

cap = captcha.TextSelectCaptcha()
URL = "https://www.bigmodel.cn/glm-coding?ic=FJGOX95A1A"
CAPTCHA_WRAPPER_ID = "tcaptcha_transform_dy"

# 抢购配置
CONFIG = {
    "target_plan": "Lite",      # Lite / Pro / Max
    "billing_cycle": "month",   # month / quarter / year
    "target_hour": 10,          # 每天早上 10:00 放库存
    "target_minute": 0,
    "target_second": 0,
}

CYCLE_LABELS = {"month": "连续包月", "quarter": "连续包季", "year": "连续包年"}

# 目标时刻后这么久内打开 → 仍抢「当天」；超过则滚到「明天」。与油猴版 WATCH_GRACE_MS 一致。
GRACE_MINUTES = 40

# 把售罄/限购态改写成可买。智谱 batch-preview 的真实字段是 soldOut / canPurchase / forbidden，
# 且 JSON 冒号后带空格（"soldOut": true），所以必须用容忍空白的正则——直接字符串替换匹配不到
# 带空格的真实响应，是之前改写一直没生效的根因。
_SOLD_OUT_TRUE = re.compile(r'("(?:isSoldOut|disabled|soldOut|isLimitBuy|isServerBusy|forbidden)"\s*:\s*)true')
_ZERO_STOCK = re.compile(r'("stock"\s*:\s*)0(?![.\d])')
_BLOCKED_PURCHASE = re.compile(r'("canPurchase"\s*:\s*)(?:null|false)')


def neutralize_sold_out(body):
    """把响应体里的售罄/限购字段改成可买，返回新字符串（没命中则原样返回）。"""
    new = _SOLD_OUT_TRUE.sub(r'\1false', body)
    new = _ZERO_STOCK.sub(r'\g<1>999', new)
    new = _BLOCKED_PURCHASE.sub(r'\1true', new)
    return new


def resolve_target_dt(now=None):
    """返回本次要抢的绝对时间点。今天的目标时刻若已过去超过 GRACE_MINUTES（默认 40min），
    就滚到明天同一时刻；否则锁当天（当天该时刻已过、但在宽限内则立即开抢）。"""
    now = now or datetime.now()
    target = now.replace(hour=CONFIG["target_hour"], minute=CONFIG["target_minute"],
                         second=CONFIG["target_second"], microsecond=0)
    if now > target + timedelta(minutes=GRACE_MINUTES):
        target += timedelta(days=1)
    return target


def log_console_message(msg):
    text = msg.text
    if text:
        print(f'Console: {text}')


def init(page):
    page.on('console', log_console_message)

    # 隐藏 webdriver 特征
    page.add_init_script('''() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
    }''')

    # 拦截所有 fetch/XHR 响应，按内容改写售罄数据（与油猴版一致）。油猴是劫持全局
    # fetch/XHR，所有请求都过它；之前 glm.py 只拦 **/api/**，会漏掉路径不带 /api/ 的
    # 接口（如 batch-preview），导致按钮一直是死的售罄态——这正是 py 灰、js 可点的原因。
    # 这里改成拦所有请求：只处理 xhr/fetch 的 JSON，静态资源（图片/脚本/样式）直接放行。
    def _handle_api(route):
        req = route.request
        # 限流检查：直接返回成功，放行抢购
        if 'rate-limit/check' in req.url:
            route.fulfill(status=200, content_type='application/json',
                          body='{"code":0,"msg":"success","data":null,"success":true}')
            return
        # 非接口请求（图片/脚本/样式等）不碰，避免 route.fetch 拖慢加载
        if req.resource_type not in ('xhr', 'fetch'):
            route.continue_()
            return
        resp = None
        try:
            resp = route.fetch()
            if 'json' in (resp.headers.get('content-type') or '').lower():
                route.fulfill(response=resp, body=neutralize_sold_out(resp.text()))
            else:
                route.fulfill(response=resp)
        except Exception as e:
            print(f"接口改写失败，放行原响应: {e}")
            # 已拿到响应就原样回，避免 continue_ 重发请求（防止重复下单）
            if resp is not None:
                try:
                    route.fulfill(response=resp)
                except Exception:
                    pass
            else:
                route.continue_()

    page.route('**/*', _handle_api)


def _extract_captcha_info(page):
    """在页面里一次性提取识别所需信息：题面文字、背景图 URL、点击坐标基准框。
    与油猴版 solveCaptchaViaOCR 的 DOM 逻辑一致：现在腾讯点选的主图是
    div 背景图（.tencent-captcha-dy__verify-bg-img），不是 <img>，题面是纯文本。"""
    return page.evaluate('''() => {
        const wrapper = document.getElementById('tcaptcha_transform_dy');
        if (!wrapper) return null;

        // 题面文字：请依次点击：X Y Z  ->  取冒号后的部分
        let clickText = null;
        const headerText = wrapper.querySelector('.tencent-captcha-dy__header-text');
        if (headerText) {
            const m = headerText.textContent.match(/[：:]\\s*(.+)$/);
            if (m) clickText = m[1].trim();
        }

        const imageArea = wrapper.querySelector('.tencent-captcha-dy__image-area');

        // 背景大图：优先 div 背景图，其次兜底真正的 <img>
        let imgUrl = null, target = null;
        const bgDiv = (imageArea || wrapper).querySelector('.tencent-captcha-dy__verify-bg-img')
                   || (imageArea || wrapper).querySelector('div[style*="background"]');
        if (bgDiv) {
            const m = (bgDiv.getAttribute('style') || '').match(/url\\(["']?(.+?)["']?\\)/);
            if (m) { imgUrl = m[1]; target = bgDiv; }
        }
        if (!imgUrl) {
            for (const img of wrapper.querySelectorAll('img')) {
                if (img.src && !img.src.startsWith('data:') &&
                    (img.src.includes('captcha') || img.naturalWidth > 100)) {
                    imgUrl = img.src; target = img; break;
                }
            }
        }
        if (!imgUrl || !target) return { clickText: clickText, imgUrl: null };

        const r = target.getBoundingClientRect();
        return { clickText: clickText, imgUrl: imgUrl,
                 box: { x: r.left, y: r.top, width: r.width, height: r.height } };
    }''')


def handle_tencent_captcha(page):
    """
    处理腾讯点选验证码（tcaptcha）
    返回: True 处理成功，False 失败
    """
    try:
        info = _extract_captcha_info(page)
        if not info or not info.get("imgUrl"):
            print("未找到验证码背景图")
            return False

        click_text = info.get("clickText")
        if click_text:
            print(f"题面文字: {click_text}")

        # 服务端下载图片：无 CORS/反爬限制，requests 直取即可
        resp = requests.get(info["imgUrl"], timeout=10)
        # 关键：把题面文字传给识别器。否则现在的验证码（纯文本题面、背景图无题目条）
        # 会退化成"按从左到右返回"，点击顺序必错。
        plan = cap.run_dict(resp.content, click_text=click_text)

        points = plan.get("point") if plan else None
        if not points:
            print("模型未识别到点击目标")
            return False

        orig_w, orig_h = plan["imgW"], plan["imgH"]
        box = info["box"]
        scale_x = box["width"] / orig_w
        scale_y = box["height"] / orig_h
        print(f"原图 {orig_w}x{orig_h} → 显示 {box['width']:.0f}x{box['height']:.0f}，"
              f"识别到 {len(points)} 个目标")

        time.sleep(0.5)

        # 仅用于日志：Python 侧按同一公式算一遍点位
        for i, p in enumerate(points):
            print(f"  点击第 {i+1} 个目标: "
                  f"({box['x'] + p['x_rel'] * scale_x:.0f}, {box['y'] + p['y_rel'] * scale_y:.0f})")

        # 实际点击在页面内用合成事件派发，和能成功的油猴版(glm.js dispatchRealClickAtPoint)完全一致。
        # 之前用 page.mouse.click（CDP 真实鼠标）：在带系统缩放的有头 Chrome 上，CDP 视口坐标和
        # 页面 getBoundingClientRect 的 CSS 像素会对不齐，点位整体偏移 → 腾讯判定点错而换题。
        # 全程留在页面 DOM 坐标系里算坐标 + 派发事件，绕开这个换算问题。
        result = page.evaluate('''async (data) => {
            const { points, origW, origH } = data;
            const wrapper = document.getElementById('tcaptcha_transform_dy');
            if (!wrapper) return 'no-wrapper';
            const imageArea = wrapper.querySelector('.tencent-captcha-dy__image-area');
            const bg = (imageArea || wrapper).querySelector('.tencent-captcha-dy__verify-bg-img')
                    || (imageArea || wrapper).querySelector('div[style*="background"]')
                    || wrapper.querySelector('img');
            if (!bg) return 'no-bg';
            const sleep = ms => new Promise(r => setTimeout(r, ms));
            const dispatchAt = (x, y) => {
                const el = document.elementFromPoint(x, y);
                if (!el) return;
                const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y };
                ['mousedown', 'mouseup', 'click'].forEach(t => el.dispatchEvent(new MouseEvent(t, init)));
            };
            const r = bg.getBoundingClientRect();
            const sx = r.width / origW, sy = r.height / origH;
            for (const p of points) {
                await sleep(300);
                dispatchAt(r.left + p.x_rel * sx, r.top + p.y_rel * sy);
            }
            await sleep(200);
            const btn = wrapper.querySelector(
                '.tencent-captcha-dy__verify-confirm-btn, .tencent-captcha-dy__verify-btn, ' +
                '.tcaptcha-verify-btn, a[class*="verify-btn"], button[class*="verify-btn"], div[class*="confirm-btn"]');
            if (btn) {
                const b = btn.getBoundingClientRect();
                dispatchAt(b.left + b.width / 2, b.top + b.height / 2);
                return 'confirmed';
            }
            return 'no-confirm';
        }''', {"points": points, "origW": orig_w, "origH": orig_h})
        print("已点击确认按钮" if result == 'confirmed' else f"未点确认按钮({result})，可能已自动提交")

        print("验证码点击完成，已提交")
        return True

    except Exception as e:
        print(f"验证码处理异常: {e}")
        return False


def ensure_billing_cycle(page, cycle):
    """确保选中的计费周期正确"""
    label = CYCLE_LABELS.get(cycle)
    if not label:
        return False
    try:
        tabs = page.query_selector_all('.switch-tab-item')
        for tab in tabs:
            text = re.sub(r'\s+', '', tab.inner_text()).strip()
            if label in text:
                if 'active' in (tab.get_attribute('class') or ''):
                    return True
                tab.click()
                time.sleep(0.3)
                return True
    except Exception as e:
        print(f"切换计费周期异常: {e}")
    return False


def find_plan_card(page, plan_name):
    """查找指定套餐卡片"""
    try:
        cards = page.query_selector_all('.package-card-box .package-card')
        for card in cards:
            title = card.query_selector('.package-card-title .font-prompt')
            if title and title.inner_text().strip() == plan_name:
                return card
    except Exception:
        pass
    return None


def find_buy_button(card):
    """查找购买按钮"""
    if not card:
        return None
    try:
        btns = card.query_selector_all('button.buy-btn, .package-card-btn-box button')
        for btn in btns:
            if btn.is_visible():
                return btn
    except Exception:
        pass
    return None


def click_buy(page, plan_name="Pro", cycle="quarter"):
    """执行购买点击"""
    if not ensure_billing_cycle(page, cycle):
        print("计费周期切换失败")
        return False

    card = find_plan_card(page, plan_name)
    if not card:
        print(f"未找到 {plan_name} 套餐卡片")
        return False

    btn = find_buy_button(card)
    if not btn:
        print("未找到购买按钮")
        return False

    # 用 JS 直接点击：强制启用并触发 .click()。
    # 不用 Playwright 的 btn.click()——它会等元素"可点击"最长 30 秒、每次重试都
    # scrolling into view，一旦被登录框/验证码遮挡就会阻塞整个循环并和用户抢滚动条。
    page.evaluate('''(btn) => {
        btn.disabled = false;
        btn.removeAttribute("disabled");
        btn.click();
    }''', btn)
    print(f"已点击 {plan_name} 购买按钮")
    return True


def detect_dialog(page):
    """检测弹窗状态，返回弹窗类型或 None"""
    return page.evaluate('''() => {
        const isVisible = (el) => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            const s = getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
        };
        const wrappers = document.querySelectorAll('.el-dialog__wrapper');
        for (const wrapper of wrappers) {
            if (!isVisible(wrapper)) continue;
            const emptyWrap = wrapper.querySelector('.empty-data-wrap');
            if (emptyWrap && emptyWrap.textContent.includes('购买人数较多')) {
                return { type: 'busy' };
            }
            const payDialog = wrapper.querySelector('.pay-dialog') ||
                              wrapper.querySelector('.scan-code-box') ||
                              wrapper.querySelector('.confirm-pay-btn');
            if (isVisible(payDialog)) {
                const priceItems = wrapper.querySelectorAll('.price-item');
                for (const el of priceItems) {
                    const text = el.textContent.replace(/[￥\\\\s]/g, '').trim();
                    if (text.length > 0 && /\\\\d/.test(text)) {
                        return { type: 'success-pay' };
                    }
                }
                if (isVisible(wrapper.querySelector('.confirm-pay-btn'))) {
                    return { type: 'confirm-pay' };
                }
                return { type: 'empty-price' };
            }
        }
        return null;
    }''')


# 专用配置目录：不要用日常 Chrome 的默认 User Data，否则 Chrome 会因 SingletonLock
# 自行拉起新进程接管、甩开 Playwright 启动的进程，导致 launch_persistent_context 卡死。
# 这个目录是独立的，第一次运行需在弹出的窗口里手动登录一次 bigmodel.cn，之后会一直复用。
PROFILE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".chrome-profile")


def is_login_open(page):
    """登录弹窗（手机号+验证码那个框）是否正显示。未登录访问 glm-coding 时网站会自动弹它。"""
    try:
        return page.evaluate('''() => {
            const dlg = document.querySelector('.login-content, .login-new-form, .login-form');
            if (!dlg) return false;
            const r = dlg.getBoundingClientRect();
            return r.width > 5 && r.height > 5;
        }''')
    except Exception:
        return False


def wait_until_logged_in(page, appear_grace=2.0):
    """自动等待登录完成：不需要回终端按键。
    - 已登录：登录框不会出现，直接放行；
    - 未登录：网站自动弹登录框，你在浏览器里输手机号+验证码登录，框消失即自动继续。"""
    time.sleep(appear_grace)  # 给登录弹窗一点出现时间
    if not is_login_open(page):
        print("已是登录状态，无需登录。")
        return
    print("检测到登录弹窗：请在浏览器里输入手机号+验证码登录（无需回到终端按键，登录后自动继续）...")
    while is_login_open(page):
        time.sleep(1)
    print("登录完成，继续。")


def main():
    target_dt = resolve_target_dt()
    plan = CONFIG["target_plan"]
    cycle = CONFIG["billing_cycle"]

    with sync_playwright() as p:
        # 用项目专用配置目录（非日常主配置），避免 Chrome 进程接管导致卡死
        print(f"[诊断] 使用配置目录: {PROFILE_DIR}")
        try:
            context = p.chromium.launch_persistent_context(
                user_data_dir=PROFILE_DIR,
                headless=False,
                channel="chrome",      # 使用系统安装的 Chrome
                args=["--disable-blink-features=AutomationControlled"],
            )
        except Exception as e:
            # 最常见的两种失败：没装系统 Chrome（channel=chrome 找不到二进制），
            # 或没有图形界面（headless=False 在纯命令行环境起不来）。给一句能照做的提示，
            # 别让用户对着一长串 Playwright traceback 发懵。
            print("\n[错误] 启动 Chrome 失败：", e)
            print("可能原因和解法：")
            print("  1. 没装 Google Chrome —— 装好系统 Chrome，或运行：")
            print("       playwright install chrome")
            print("  2. 没有图形界面 —— 本脚本要弹出浏览器窗口，需在带桌面的环境运行")
            print("     （WSL 需 WSLg；纯命令行服务器跑不了）。")
            print("  3. Linux 缺系统库 —— 运行：sudo playwright install-deps")
            return
        # 用新标签页打开 glm-coding——未登录时网站会在新标签里自动弹出登录框，
        # 这正是想保留的体验。顺手关掉启动自带的空白初始页，避免多一个无用标签。
        page = context.new_page()
        for old in list(context.pages):
            if old is not page and old.url in ("about:blank", ""):
                try:
                    old.close()
                except Exception:
                    pass
        # init 必须在 goto 之前：add_init_script / page.route 只对其后的导航生效
        init(page)
        try:
            page.goto(URL, wait_until='domcontentloaded', timeout=60000)
        except Exception as e:
            print(f"[诊断] 导航异常（稍后会重试）: {e}")
        page.bring_to_front()

        # 自动等待登录：登录框在就等你登，登录框消失就继续，全程不用回终端按键
        wait_until_logged_in(page)

        day_label = "今天" if target_dt.date() == datetime.now().date() else "明天"
        print(f"页面已加载，目标套餐: {plan} ({CYCLE_LABELS[cycle]})")
        print(f"目标时间: {day_label} {target_dt:%Y-%m-%d %H:%M:%S}（超过目标时刻 {GRACE_MINUTES} 分钟才打开则抢明天）")

        retry_count = 0
        # 真正的"放弃"由 40 分钟时间窗口（deadline）决定，和油猴版 WATCH_GRACE_MS 对齐。
        # max_retry 只作兜底防紧致死循环，要足够大，别在 40 分钟内先于时间窗口触发
        # （旧值 300，到点后几分钟就用光，导致没撑到 40 分钟就停了）。
        max_retry = 100000
        deadline = target_dt + timedelta(minutes=GRACE_MINUTES)
        completed = False
        interrupted = False

        try:
            while not completed and retry_count < max_retry and datetime.now() < deadline:
                # 距目标时刻还有多少秒（负数=已到点）
                diff = (target_dt - datetime.now()).total_seconds()
                if diff > 60:
                    h, rem = divmod(int(diff), 3600)
                    m, s = divmod(rem, 60)
                    label = f"{h}时{m}分{s}秒" if h else f"{m}分{s}秒"
                    print(f"\r倒计时: {label}    ", end='', flush=True)
                    time.sleep(1)
                    continue
                if diff > 0:
                    print(f"\r倒计时: {diff:.1f}秒   ", end='', flush=True)
                    time.sleep(0.1)
                    continue

                print(f"\n已到目标时间，开始抢购...")

                # 处理弹窗
                dialog = detect_dialog(page)
                if dialog:
                    dtype = dialog.get('type')
                    if dtype in ('success-pay', 'confirm-pay'):
                        print("抢购成功！弹出支付窗口，请扫码支付")
                        completed = True
                        break
                    elif dtype in ('busy', 'empty-price'):
                        retry_count += 1
                        print(f"[{retry_count}] 无效弹窗({dtype})，关闭重试...")
                        close_btn = page.query_selector('.el-dialog__wrapper:not([style*="display: none"]) .el-dialog__headerbtn')
                        if close_btn:
                            close_btn.click()
                        time.sleep(0.4)
                        continue

                # 检测验证码
                captcha_visible = page.evaluate('''() => {
                    const w = document.getElementById('tcaptcha_transform_dy');
                    if (!w) return false;
                    const s = window.getComputedStyle(w);
                    return s.position === 'fixed' && parseFloat(s.opacity) >= 0.5;
                }''')

                if captcha_visible:
                    print("检测到验证码，自动识别中...")
                    if not handle_tencent_captcha(page):
                        print("验证码识别失败，等待手动处理...")
                        time.sleep(5)
                    time.sleep(1)
                    continue

                # 点击购买
                if click_buy(page, plan, cycle):
                    retry_count += 1
                    print(f"[{retry_count}] 已点击购买，等待响应...")
                    time.sleep(0.3)
                else:
                    time.sleep(0.2)

            if completed:
                print("\n抢购流程完成！")
            elif datetime.now() >= deadline:
                print(f"\n已超过目标时刻 {GRACE_MINUTES} 分钟窗口，停止抢购")
            elif retry_count >= max_retry:
                print(f"\n已达最大重试次数({max_retry})，停止")
        except KeyboardInterrupt:
            interrupted = True
            print("\n已手动中断。")
        except Exception as e:
            print(f"\n运行出错: {e}")
        finally:
            if interrupted:
                # 终端的 Ctrl+C 是发给整个进程组的，Chrome 子进程会同时收到并自行退出，
                # 浏览器在这一刻已经关了，脚本这里无法再挽留，直接结束。
                print("浏览器已随 Ctrl+C 一并关闭，脚本退出。")
            else:
                # 正常结束（抢到/达上限）：脚本继续挂着，浏览器保持打开，方便扫码支付/查看。
                # 注意：此时按 Ctrl+C 会把脚本和浏览器一起关掉（Playwright 机制，无法避免）。
                print("\n" + "=" * 56)
                print("流程结束。脚本继续运行以保持浏览器打开（方便扫码支付/查看）。")
                print("  · 想继续用浏览器：什么都别动，留着即可。")
                print("  · 想退出：关闭浏览器窗口，或按 Ctrl+C（会一并关闭浏览器）。")
                print("=" * 56)
                try:
                    while context.pages:
                        time.sleep(1)
                except KeyboardInterrupt:
                    pass


if __name__ == '__main__':
    main()
