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
GRACE_MINUTES = 60

# 比目标时刻提前这么多秒开火（开售前已是 555，提前热身、接住开售第一秒）。与油猴版 START_LEAD_MS 一致。
START_LEAD_SECONDS = 120

# 命中 555 系统繁忙（按钮灰显「抢购人数过多」或 data:null 连卡都不渲染）时整页刷新重拉的
# 间隔基准秒数。与油猴版 BUSY_RELOAD_THROTTLE_MS 一致。
BUSY_RELOAD_THROTTLE_SECONDS = 1.5
# 连续繁忙时按指数退避拉长刷新间隔(1.5→3→6→10s)，上限这么多秒。降低被服务器“按客户端单独
# 限流”的概率——猛刷反而会把自己钉死在 data:null（同日他人正常、自己空即此情形）。
BUSY_RELOAD_BACKOFF_MAX_SECONDS = 10
# 连续繁忙到这么多次 → 提示疑似被单独限流，别再手动狂刷。
BUSY_THROTTLED_HINT_AT = 4


def resolve_target_dt(now=None):
    """返回本次要抢的绝对时间点。今天的目标时刻若已过去超过 GRACE_MINUTES（默认 60min），
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

    # 售罄/限购改写：注入页内 fetch/XHR 钩子（与油猴 glm.js 完全同一套机制），在浏览器内部
    # 异步改写响应。不用 Playwright 的 page.route——它是同步服务端拦截，每个 route.fetch 串行
    # 往返；实测一旦用它拦 batch-preview 这个套餐接口，请求就超时（“网络请求超时”）。页内钩子
    # 异步、零额外往返，正是油猴版不超时、按钮能变可点的原因。
    page.add_init_script(r'''(() => {
      if (window.__glmNetHook) return;
      window.__glmNetHook = true;

      function neutralizeSoldOut(text) {
        const hasSoldOut = /"(?:isSoldOut|disabled|soldOut|isLimitBuy|isServerBusy|forbidden)"\s*:\s*true/.test(text);
        const hasZeroStock = /"stock"\s*:\s*0(?![.\d])/.test(text);
        const hasBlocked = /"canPurchase"\s*:\s*(?:null|false)/.test(text);
        if (!hasSoldOut && !hasZeroStock && !hasBlocked) return null;
        return text
          .replace(/("(?:isSoldOut|disabled|soldOut|isLimitBuy|isServerBusy|forbidden)"\s*:\s*)true/g, '$1false')
          .replace(/("stock"\s*:\s*)0(?![.\d])/g, '$1999')
          .replace(/("canPurchase"\s*:\s*)(?:null|false)/g, '$1true');
      }

      const origFetch = window.fetch;
      window.fetch = async function (...args) {
        const input = args[0];
        const url = typeof input === 'string' ? input : (input && input.url) || String(input || '');
        if (url.includes('/api/biz/rate-limit/check')) {
          return new Response(JSON.stringify({ code: 0, msg: 'success', data: null, success: true }),
            { status: 200, headers: { 'content-type': 'application/json' } });
        }
        const resp = await origFetch.apply(this, args);
        const ct = resp.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          try {
            const rewritten = neutralizeSoldOut(await resp.clone().text());
            if (rewritten !== null) {
              return new Response(rewritten, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
            }
          } catch (e) {}
        }
        return resp;
      };

      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, u, ...rest) { this.__glmUrl = u; return origOpen.call(this, m, u, ...rest); };
      XMLHttpRequest.prototype.send = function (...a) {
        this.addEventListener('readystatechange', function () {
          if (this.readyState === 4 && this.status === 200) {
            const ct = this.getResponseHeader('content-type') || '';
            if (ct.includes('application/json')) {
              try {
                const rewritten = neutralizeSoldOut(this.responseText);
                if (rewritten !== null) {
                  Object.defineProperty(this, 'responseText', { get: () => rewritten });
                  Object.defineProperty(this, 'response', { get: () => JSON.parse(rewritten) });
                }
              } catch (e) {}
            }
          }
        });
        return origSend.apply(this, a);
      };
    })();''')


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


def _refresh_captcha(page):
    """点验证码上的“换一张/刷新”按钮换一道新题。找到并点到返回 True，找不到返回 False。
    用页内合成事件点击，和点选验证码同一套坐标系。"""
    return page.evaluate('''() => {
        const wrapper = document.getElementById('tcaptcha_transform_dy');
        if (!wrapper) return false;
        // 刷新按钮是 <img alt="刷新验证" aria-label="刷新验证" role="button">，class 是通用的
        // unselectable（信息图标也用它），所以靠 aria-label/alt 精确定位，class 选择器只作兜底。
        const selectors = [
            'img[aria-label="刷新验证"]', '[aria-label="刷新验证"]',
            '[aria-label*="刷新"]', '[alt*="刷新"]', '[title*="刷新"]',
            '.tencent-captcha-dy__refresh', '[class*="refresh"]', '[class*="reload"]'
        ];
        let btn = null;
        for (const s of selectors) { const e = wrapper.querySelector(s); if (e) { btn = e; break; } }
        if (!btn) return false;
        const r = btn.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const tgt = document.elementFromPoint(x, y) || btn;
        const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y };
        ['mousedown', 'mouseup', 'click'].forEach(t => tgt.dispatchEvent(new MouseEvent(t, init)));
        return true;
    }''')


# 记住上一题的背景图 URL：换题/重试时必须等到背景图换成新图再提取，
# 否则会拿旧图坐标点在新图上（换题后第一次 100% 点错的根因）。
_last_captcha_img_url = None


def _get_captcha_img_url(page):
    """只取验证码背景图 URL（轻量，用于轮询是否已换成新图）。"""
    return page.evaluate(r'''() => {
        const wrapper = document.getElementById('tcaptcha_transform_dy');
        if (!wrapper) return null;
        const area = wrapper.querySelector('.tencent-captcha-dy__image-area') || wrapper;
        const bg = area.querySelector('.tencent-captcha-dy__verify-bg-img')
               || area.querySelector('div[style*="background"]');
        if (bg) {
            const m = (bg.getAttribute('style') || '').match(/url\(["']?(.+?)["']?\)/);
            if (m) return m[1];
        }
        const img = wrapper.querySelector('img');
        return (img && img.src && !img.src.startsWith('data:')) ? img.src : null;
    }''')


def _wait_fresh_captcha_image(page, prev_url, timeout=3.0):
    """等到背景图就绪、且与上一题不同再返回（换题后避免拿旧图坐标）；超时则用当前图兜底。"""
    deadline = time.time() + timeout
    cur = None
    while time.time() < deadline:
        cur = _get_captcha_img_url(page)
        if cur and (prev_url is None or cur != prev_url):
            time.sleep(0.2)  # 让新图的尺寸/DOM 再稳一拍
            return cur
        time.sleep(0.1)
    return cur


def handle_tencent_captcha(page, _refresh_left=4):
    """
    处理腾讯点选验证码（tcaptcha）。识别不全（检出字数 < 题面字数）时，点验证码上的
    “换一张”刷新按钮换一道新题再试，而不是拿残缺答案去提交、白白废一次。
    返回: True 处理成功，False 失败
    """
    global _last_captcha_img_url
    try:
        # 换题/重试后，先等背景图换成与上次处理过的不同的新图，避免拿旧图坐标点错。
        _wait_fresh_captcha_image(page, _last_captcha_img_url)
        info = _extract_captcha_info(page)
        if not info or not info.get("imgUrl"):
            print("未找到验证码背景图")
            return False
        _last_captcha_img_url = info["imgUrl"]   # 记录本次实际处理的图

        click_text = info.get("clickText")
        if click_text:
            print(f"题面文字: {click_text}")
        required = len([c for c in click_text.replace(' ', '') if c.strip()]) if click_text else 0

        # 服务端下载图片：无 CORS/反爬限制，requests 直取即可
        resp = requests.get(info["imgUrl"], timeout=10)
        # 关键：把题面文字传给识别器。否则现在的验证码（纯文本题面、背景图无题目条）
        # 会退化成"按从左到右返回"，点击顺序必错。
        plan = cap.run_dict(resp.content, click_text=click_text)

        points = plan.get("point") if plan else None

        # 识别不全：YOLO 漏检了题面里的字（检出数 < 需要数）。点“换一张”换新题重试，
        # 不提交残缺答案（提交必失败、还白耗一次重试）。换不动或重试用尽才放弃。
        got = len(points) if points else 0
        if required and got < required:
            if _refresh_left > 0 and _refresh_captcha(page):
                print(f"只识别到 {got}/{required} 个字，换一张重试（剩 {_refresh_left - 1} 次）")
                time.sleep(0.8)
                return handle_tencent_captcha(page, _refresh_left - 1)
            print(f"只识别到 {got}/{required} 个字，无法换题/重试用尽，放弃本次")
            return False

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


def buy_button_busy_text(card):
    """购买按钮处于 555 繁忙灰态（文字含「抢购人数过多/请刷新/系统繁忙/稍后」）时返回该文字，
    否则返回 None。繁忙文字与计费周期无关，三张卡都一样，直接读目标卡按钮即可。"""
    btn = find_buy_button(card)
    if not btn:
        return None
    try:
        text = re.sub(r'\s+', '', btn.inner_text())
    except Exception:
        return None
    return text if re.search(r'抢购人数过多|请刷新|系统繁忙|稍后', text) else None


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
        # 先用系统安装的 Google Chrome（channel=chrome，Windows/macOS 多数自带），
        # 找不到再回退到 Playwright 自带的 Chromium（Linux 上常见，免装系统 Chrome）。
        # no_viewport：不强制固定视口，用真实窗口大小当视口（默认会锁 1280x720，
        # 导致界面不占满窗口、最大化无效，且在带系统缩放的有头窗口下渲染与坐标错位、
        # 合成点击点不准）。配合 --start-maximized 开局即最大化，行为对齐正常 Chrome。
        common_args = ["--disable-blink-features=AutomationControlled", "--start-maximized"]
        attempts = [
            {"channel": "chrome", "args": common_args},
            # 回退到自带 Chromium。WSL/容器里常缺沙箱权限，加 --no-sandbox 更稳。
            {"args": common_args + ["--no-sandbox"]},
        ]
        context = None
        last_err = None
        for opt in attempts:
            try:
                context = p.chromium.launch_persistent_context(
                    user_data_dir=PROFILE_DIR, headless=False, no_viewport=True, **opt
                )
                break
            except Exception as e:
                last_err = e
        if context is None:
            # 两种常见失败：没有可用浏览器，或没有图形界面（headless=False 起不来）。
            # 给几句能照做的提示，别让用户对着一长串 Playwright traceback 发懵。
            print("\n[错误] 启动浏览器失败：", last_err)
            print("可能原因和解法：")
            print("  1. 没有可用浏览器 —— 装 Google Chrome，或装 Playwright 自带 Chromium：")
            print("       python -m playwright install chromium   # Linux/macOS 用 python3")
            print("     （用一键脚本 start.sh 选 1 会自动装好，无需手动敲）")
            print("  2. Linux 缺系统库 —— 运行：")
            print("       sudo python -m playwright install-deps chromium")
            print("  3. 没有图形界面 —— 本脚本要弹出浏览器窗口，需在带桌面的环境运行")
            print("     （WSL 需 WSLg；纯命令行服务器跑不了）。")
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
        last_reload_at = 0.0  # 上次因 555 繁忙整页重拉的时刻，用于退避节流
        busy_streak = 0       # 连续繁忙刷新次数，用于指数退避；拿到真实售卖态即清零
        # 真正的"放弃"由 GRACE_MINUTES 时间窗口（deadline）决定，和油猴版 WATCH_GRACE_MS 对齐。
        # max_retry 只作兜底防紧致死循环，要足够大，别在该窗口内先于时间窗口触发
        # （旧值 300，到点后几分钟就用光，导致没撑到窗口结束就停了）。
        max_retry = 100000
        deadline = target_dt + timedelta(minutes=GRACE_MINUTES)
        completed = False
        interrupted = False

        try:
            while not completed and retry_count < max_retry and datetime.now() < deadline:
                # 距「开抢时刻」(目标时刻提前 START_LEAD_SECONDS) 还有多少秒（负数=已开抢）
                diff = (target_dt - datetime.now()).total_seconds() - START_LEAD_SECONDS
                if diff > 60:
                    h, rem = divmod(int(diff), 3600)
                    m, s = divmod(rem, 60)
                    label = f"{h}时{m}分{s}秒" if h else f"{m}分{s}秒"
                    print(f"\r距开抢: {label}    ", end='', flush=True)
                    time.sleep(1)
                    continue
                if diff > 0:
                    print(f"\r距开抢: {diff:.1f}秒   ", end='', flush=True)
                    time.sleep(0.1)
                    continue

                print(f"\n已到开抢时刻（比目标提前 {START_LEAD_SECONDS // 60} 分钟），开始抢购...")

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

                # 555 系统繁忙：页面只在加载时拉一次 batch-preview，繁忙态不刷新就永远是旧的，
                # 强点死按钮没用——必须整页重拉去搏一个新结果（和油猴版 reloadForFreshPreview 一致）。
                # 两种繁忙形态都只刷不点：
                #   1) 按钮灰显「抢购人数过多/系统繁忙/请刷新/稍后」（data 有卡但售罄态）；
                #   2) data:null 连套餐卡都不渲染（find_plan_card 找不到卡）。
                # 按钮可买时不刷，免得把好的 200 也刷没；带节流，避免疯狂刷。
                card = find_plan_card(page, plan)
                busy_text = buy_button_busy_text(card) if card else None
                if card is None or busy_text:
                    # 指数退避：连续繁忙就拉长两次刷新的间隔，避免把自己刷成单独限流。
                    backoff = min(BUSY_RELOAD_THROTTLE_SECONDS * (2 ** busy_streak),
                                  BUSY_RELOAD_BACKOFF_MAX_SECONDS)
                    if time.time() - last_reload_at >= backoff:
                        retry_count += 1
                        busy_streak += 1
                        last_reload_at = time.time()
                        reason = busy_text or "套餐卡缺失(data:null)"
                        if busy_streak >= BUSY_THROTTLED_HINT_AT:
                            wait_s = min(BUSY_RELOAD_THROTTLE_SECONDS * (2 ** busy_streak),
                                         BUSY_RELOAD_BACKOFF_MAX_SECONDS)
                            print(f"[{retry_count}] 连续繁忙 {busy_streak} 次，疑似被单独限流，"
                                  f"退避中(约{wait_s:.0f}s/次)，请勿手动狂刷：{reason}")
                        else:
                            print(f"[{retry_count}] 系统繁忙（{reason}），整页刷新重拉...")
                        try:
                            page.reload(wait_until='domcontentloaded', timeout=60000)
                        except Exception as e:
                            print(f"[诊断] 刷新异常（稍后重试）: {e}")
                    time.sleep(0.3)
                    continue

                # 走到这说明卡片已渲染、按钮可处理（拿到真实售卖态）→ 清零退避计数。
                busy_streak = 0

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
