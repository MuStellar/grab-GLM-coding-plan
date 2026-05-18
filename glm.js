// ==UserScript==
// @name         GLM Coding 全自动抢购助手 (增强版) v1.0
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  准点自动点击指定套餐，绕过限流，支持验证码等待与异常弹窗检测自动重试。
// @author       Codex
// @match        *://bigmodel.cn/glm-coding*
// @match        https://www.bigmodel.cn/glm-coding
// @match        https://www.bigmodel.cn/glm-coding?ic*
// @match        *://bigmodel.cn/usercenter/glm-coding*
// @match        *://bigmodel.cn/html/rate-limit.html*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==
//
// ============================================================
// 使用说明：
// 如遇弹窗（购买人数多/无价格）会自动重发。如遇腾讯验证码，脚本会暂停并等待人工完成后继续。
// ============================================================

(function () {
  'use strict';

  if (window.__autoGlmSimple16Initialized) return;
  window.__autoGlmSimple16Initialized = true;

  // ==========================================
  // 网络拦截层
  // ==========================================

  // 1. 绕过限流接口
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const [input] = args;
    const requestUrl = typeof input === 'string' ? input : input?.url || String(input || '');
    if (requestUrl.includes('/api/biz/rate-limit/check')) {
      console.log('[Auto-GLM-1.6] 拦截限流检查，强制放行');
      return new Response(JSON.stringify({
        code: 0, msg: 'success', data: null, success: true
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    const response = await originalFetch.apply(this, args);
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const clone = response.clone();
      try {
        let text = await clone.text();
        if (text.includes('"isSoldOut":true') || text.includes('"disabled":true') || text.includes('"soldOut":true')) {
          console.log('[Auto-GLM-1.6] 拦截售罄数据:', requestUrl);
          text = text.replace(/"isSoldOut":true/g, '"isSoldOut":false')
            .replace(/"disabled":true/g, '"disabled":false')
            .replace(/"soldOut":true/g, '"soldOut":false')
            .replace(/"stock":0/g, '"stock":999');
          return new Response(text, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
          });
        }
      } catch (e) {
        console.log('[Auto-GLM-1.6] Fetch拦截异常:', e.message);
      }
    }
    return response;
  };

  // 2. 绕过 XHR 售罄数据
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._reqUrl = url;
    return originalXHROpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('readystatechange', function () {
      if (this.readyState === 4 && this.status === 200) {
        const contentType = this.getResponseHeader('content-type') || '';
        if (contentType.includes('application/json')) {
          try {
            let text = this.responseText;
            if (text.includes('"isSoldOut":true') || text.includes('"disabled":true') || text.includes('"soldOut":true')) {
              console.log('[Auto-GLM-1.6] 拦截XHR售罄数据:', this._reqUrl);
              text = text.replace(/"isSoldOut":true/g, '"isSoldOut":false')
                .replace(/"disabled":true/g, '"disabled":false')
                .replace(/"soldOut":true/g, '"soldOut":false')
                .replace(/"stock":0/g, '"stock":999');
              Object.defineProperty(this, 'responseText', { get: function () { return text; } });
              Object.defineProperty(this, 'response', { get: function () { return JSON.parse(text); } });
            }
          } catch (e) {
            console.log('[Auto-GLM-1.6] XHR拦截异常:', e.message);
          }
        }
      }
    });
    originalXHRSend.apply(this, args);
  };

  // 3. 绕过 rate-limit 页面跳转
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  history.pushState = function (...args) {
    const url = args[2] || '';
    if (url && url.includes('rate-limit')) {
      console.log('[Auto-GLM-1.6] 拦截 pushState 跳转至限流页，强制跳转回目标页');
      setTimeout(() => { history.pushState(null, '', '/glm-coding'); }, Math.floor(Math.random() * 701) + 500);
      return;
    }
    return originalPushState.apply(this, args);
  };
  history.replaceState = function (...args) {
    const url = args[2] || '';
    if (url && url.includes('rate-limit')) {
      console.log('[Auto-GLM-1.6] 拦截 replaceState 跳转至限流页，强制跳转回目标页');
      setTimeout(() => { history.replaceState(null, '', '/glm-coding'); }, Math.floor(Math.random() * 701) + 500);
      return;
    }
    return originalReplaceState.apply(this, args);
  };

  console.log('[Auto-GLM-1.6] 网络拦截器已注册');

  // ==========================================
  // 验证码图片拦截层
  // ==========================================

  // 拦截腾讯验证码图片：通过拦截网络响应捕获图片 base64
  let capturedCaptchaImage = null; // { src, base64, width, height }

  // 拦截 PerformanceObserver 捕获验证码图片请求
  const po = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name && (entry.name.includes('captcha') || entry.name.includes('tencent') || entry.name.includes('verify'))) {
        console.log('[Auto-GLM-1.6] 检测到验证码图片请求:', entry.name.substring(0, 80));
      }
    }
  });
  try { po.observe({ type: 'resource', buffered: false }); } catch (e) {}

  // 重写 Image 构造函数，捕获验证码图片加载
  const OriginalImage = window.Image;
  window.Image = function (...args) {
    const img = new OriginalImage(...args);
    const origSrcSetter = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src').set;
    let _src = '';
    Object.defineProperty(img, 'src', {
      get() { return _src; },
      set(val) {
        _src = val;
        if (val && (val.includes('captcha') || val.includes('tencent') || val.includes('verify'))) {
          console.log('[Auto-GLM-1.6] 捕获验证码图片 URL:', val.substring(0, 80));
          img.addEventListener('load', () => {
            try {
              const canvas = document.createElement('canvas');
              canvas.width = img.naturalWidth;
              canvas.height = img.naturalHeight;
              canvas.getContext('2d').drawImage(img, 0, 0);
              const base64 = canvas.toDataURL('image/jpeg', 0.95);
              capturedCaptchaImage = { src: val, base64: base64, width: img.naturalWidth, height: img.naturalHeight };
              console.log(`[Auto-GLM-1.6] 验证码图片已缓存: ${img.naturalWidth}x${img.naturalHeight}`);
            } catch (e) {
              console.log('[Auto-GLM-1.6] 缓存验证码图片失败(跨域):', e.message);
              // 跨域时只保存 src，用 dataType=1 由后端下载
              capturedCaptchaImage = { src: val, base64: null, width: img.naturalWidth, height: img.naturalHeight };
            }
          }, { once: true });
        }
        return origSrcSetter.call(img, val);
      },
      configurable: true
    });
    return img;
  };
  window.Image.prototype = OriginalImage.prototype;

  // 也拦截 createElement('img') 和直接设置 src 的情况
  const origCreateElement = document.createElement.bind(document);
  document.createElement = function (tagName, ...args) {
    const el = origCreateElement(tagName, ...args);
    if (tagName.toLowerCase() === 'img') {
      const origSrcSetter = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src').set;
      let _src = '';
      Object.defineProperty(el, 'src', {
        get() { return _src; },
        set(val) {
          _src = val;
          if (val && (val.includes('captcha') || val.includes('tencent') || val.includes('verify'))) {
            console.log('[Auto-GLM-1.6] createElement 捕获验证码图片 URL:', val.substring(0, 80));
            el.addEventListener('load', () => {
              try {
                const canvas = document.createElement('canvas');
                canvas.width = el.naturalWidth;
                canvas.height = el.naturalHeight;
                canvas.getContext('2d').drawImage(el, 0, 0);
                const base64 = canvas.toDataURL('image/jpeg', 0.95);
                capturedCaptchaImage = { src: val, base64: base64, width: el.naturalWidth, height: el.naturalHeight };
                console.log(`[Auto-GLM-1.6] 验证码图片已缓存: ${el.naturalWidth}x${el.naturalHeight}`);
              } catch (e) {
                console.log('[Auto-GLM-1.6] 缓存验证码图片失败(跨域):', e.message);
                capturedCaptchaImage = { src: val, base64: null, width: el.naturalWidth, height: el.naturalHeight };
              }
            }, { once: true });
          }
          return origSrcSetter.call(el, val);
        },
        configurable: true
      });
    }
    return el;
  };

  console.log('[Auto-GLM-1.6] 验证码图片拦截器已注册');

  // ==========================================
  // 页面状态层
  // ==========================================

  const CAPTCHA_WRAPPER_ID = 'tcaptcha_transform_dy';

  // 多维度验证码状态检测
  function isCaptchaVisible() {
    const wrapper = document.getElementById(CAPTCHA_WRAPPER_ID);
    if (!wrapper) return false;

    // 检查计算样式
    const style = window.getComputedStyle(wrapper);

    // 未激活时处于绝对定位隐藏态，激活时为 fixed
    if (style.position !== 'fixed') return false;
    if (parseFloat(style.opacity) < 0.5) return false;
    if (style.display === 'none') return false;

    const popupType = document.querySelector('.tencent-captcha-dy__popup-type');
    if (!popupType) return false;

    return true;
  }

  // 调用本地 Python 识别服务自动解决验证码
  const CAPTCHA_API = 'http://127.0.0.1:8123/api/v1/identify';

  // 用 GM_xmlhttpRequest 发起请求（绕过 CORS）
  function gmFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: options.method || 'GET',
        url: url,
        headers: options.headers || {},
        data: options.body,
        responseType: options.responseType || 'text',
        onload(resp) { resolve(resp); },
        onerror(err) { reject(err); },
        ontimeout(err) { reject(err); },
      });
    });
  }

  // 下载图片并转为 base64（绕过跨域）
  async function downloadImageAsBase64(imgUrl) {
    try {
      const resp = await gmFetch(imgUrl, { responseType: 'blob' });
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = reader.result.replace(/^data:image\/\w+;base64,/, '');
          resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(resp.response);
      });
    } catch (e) {
      log('GM下载图片失败: ' + e.message);
      return null;
    }
  }

  // 多策略查找验证码确认按钮
  function findCaptchaConfirmBtn(wrapper) {
    // 策略1: 常见 class 选择器（包含 div 确认按钮）
    const byClass = wrapper.querySelector(
      '#tcaptcha-verify-btn, ' +
      'a.tcaptcha-verify-btn, button.tcaptcha-verify-btn, .tcaptcha-verify-btn, ' +
      '.tcaptcha-operation-btn, .tencent-captcha-dy__verify-btn, ' +
      '.tencent-captcha-dy__verify-confirm-btn, ' +
      'a[class*="verify-btn"], button[class*="verify-btn"], ' +
      'div[class*="confirm-btn"], a[class*="confirm"], button[class*="confirm"]'
    );
    if (byClass) return byClass;

    // 策略2: 包含"确认/确定"文本的可点击元素（含 div）
    const clickables = wrapper.querySelectorAll('a, button, div, [role="button"]');
    for (const el of clickables) {
      const t = (el.textContent || '').trim();
      if (t === '确认' || t === '确定' || t === '提交' || t === '验证') {
        return el;
      }
    }

    // 策略3: 底部区域的可点击元素（验证码确认按钮总在底部）
    const rect = wrapper.getBoundingClientRect();
    const bottomThreshold = rect.top + rect.height * 0.7;
    const allEls = wrapper.querySelectorAll('*');
    for (const el of allEls) {
      if (el.tagName !== 'A' && el.tagName !== 'BUTTON' && el.getAttribute('role') !== 'button') continue;
      const elRect = el.getBoundingClientRect();
      if (elRect.top > bottomThreshold && elRect.width > 30 && elRect.height > 15) {
        return el;
      }
    }

    return null;
  }

  // 关闭验证码弹窗（点击关闭按钮）
  function closeCaptcha() {
    const wrapper = document.getElementById(CAPTCHA_WRAPPER_ID);
    if (!wrapper) return false;
    const closeBtn = wrapper.querySelector('.tcaptcha-close-btn, a.tcaptcha-operation-btn, .tcaptcha-action-close, [class*="close"]') ||
                     wrapper.querySelector('[aria-label="关闭"]');
    if (closeBtn) {
      dispatchRealClick(closeBtn);
      log('已关闭验证码弹窗');
      return true;
    }
    return false;
  }

  async function solveCaptchaViaOCR() {
    try {
      const wrapper = document.getElementById(CAPTCHA_WRAPPER_ID);
      if (!wrapper) { log('验证码容器不存在'); return false; }

      // 提取提示文字（如"请依次点击：豹 雹 澄"）
      let clickText = null;
      const headerText = wrapper.querySelector('.tencent-captcha-dy__header-text');
      if (headerText) {
        const m = headerText.textContent.match(/[：:]\s*(.+)$/);
        if (m) { clickText = m[1].trim(); }
      }
      if (clickText) { log('提取提示文字: ' + clickText); }

      // 诊断
      const allImgs = wrapper.querySelectorAll('img');
      log(`诊断: ${allImgs.length} 个 img, 拦截: ${capturedCaptchaImage ? '有' : '无'}`);

      let imgSrc = null;
      let base64Data = null;
      let clickTarget = wrapper;

      // 定位图片区域容器（点击目标的坐标基准）
      const imageArea = wrapper.querySelector('.tencent-captcha-dy__image-area');

      // 策略1: 从背景图 div 提取 URL（腾讯验证码的主图是 div 背景图）
      const bgDiv = (imageArea || wrapper).querySelector('.tencent-captcha-dy__verify-bg-img') ||
                    (imageArea || wrapper).querySelector('div[style*="background"]');
      if (bgDiv) {
        const style = bgDiv.getAttribute('style') || '';
        const m = style.match(/url\(["']?(.+?)["']?\)/);
        if (m) { imgSrc = m[1]; clickTarget = bgDiv; }
      }

      // 策略2: 使用拦截捕获的图片
      if (!imgSrc && capturedCaptchaImage && capturedCaptchaImage.src) {
        imgSrc = capturedCaptchaImage.src;
        if (imageArea) clickTarget = imageArea;
      }

      // 策略3: 在容器中查找 img 元素
      if (!imgSrc) {
        for (const img of allImgs) {
          if (img.src && !img.src.startsWith('data:') && (img.src.includes('captcha') || img.src.includes('tencent') || img.src.includes('verify') || img.naturalWidth > 100)) {
            imgSrc = img.src;
            clickTarget = img;
            break;
          }
        }
      }

      if (!imgSrc) {
        log('未找到验证码图片');
        return false;
      }

      log('验证码图片 URL: ' + imgSrc.substring(0, 80) + '...');

      // 用 GM_xmlhttpRequest 下载图片转 base64（绕过跨域和反爬）
      updateStatus('下载验证码图片...');
      base64Data = await downloadImageAsBase64(imgSrc);

      if (!base64Data) {
        log('图片下载失败，尝试 URL 方式');
      }

      // 调用本地识别 API（用 GM_xmlhttpRequest 绕过 CORS）
      updateStatus('正在识别验证码...');
      const payload = base64Data
        ? { dataType: 2, imageSource: base64Data, clickText }
        : { dataType: 1, imageSource: imgSrc, clickText };

      log(`调用识别API: dataType=${payload.dataType}`);
      const apiResp = await gmFetch(CAPTCHA_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      let json;
      try { json = JSON.parse(apiResp.responseText); } catch (e) {
        log('API 响应解析失败: ' + apiResp.responseText?.substring(0, 200));
        return false;
      }

      if (json.code !== 200 || !json.data || !json.data.res) {
        log('识别 API 返回异常: ' + JSON.stringify(json));
        return false;
      }

      const res = json.data.res;
      const points = res.point;
      const origW = res.imgW;
      const origH = res.imgH;

      if (!points || points.length === 0) {
        log('模型未识别到点击目标');
        return false;
      }

      log(`识别到 ${points.length} 个目标，原图尺寸: ${origW}x${origH}`);

      // 计算缩放比例
      const bgRect = clickTarget.getBoundingClientRect();
      const scaleX = bgRect.width / origW;
      const scaleY = bgRect.height / origH;

      // 依次点击每个目标
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const clickX = bgRect.left + p.x_rel * scaleX;
        const clickY = bgRect.top + p.y_rel * scaleY;
        log(`点击第 ${i + 1} 个目标: (${Math.round(clickX)}, ${Math.round(clickY)})`);
        dispatchRealClickAtPoint(clickX, clickY);
        await sleep(300);
      }

      // 识别成功，直接点确认按钮（用坐标点击，确认按钮是 div 不响应 .click()）
      const confirmBtn = findCaptchaConfirmBtn(wrapper);
      if (confirmBtn) {
        const btnRect = confirmBtn.getBoundingClientRect();
        const btnX = btnRect.left + btnRect.width / 2;
        const btnY = btnRect.top + btnRect.height / 2;
        log('点击确认按钮: ' + confirmBtn.className.substring(0, 60) + ` (${Math.round(btnX)}, ${Math.round(btnY)})`);
        dispatchRealClickAtPoint(btnX, btnY);
      } else {
        log('未找到确认按钮，点击 image-area 下方区域');
        const areaRect = (imageArea || wrapper).getBoundingClientRect();
        dispatchRealClickAtPoint(areaRect.left + areaRect.width / 2, areaRect.bottom + 25);
      }

      capturedCaptchaImage = null;
      log('验证码自动识别完成');
      return true;
    } catch (e) {
      log('验证码识别异常: ' + e.message);
      return false;
    }
  }

  // 在页面指定绝对坐标处模拟真实鼠标点击
  function dispatchRealClickAtPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return;
    const eventInit = { bubbles: true, cancelable: true, composed: true, view: realWindow, clientX: x, clientY: y };
    ['mousedown', 'mouseup', 'click'].forEach(type => {
      el.dispatchEvent(new MouseEvent(type, eventInit));
    });
  }

  // 统一弹窗检测
  function detectDialogState() {
    const dialogWrappers = document.querySelectorAll('.el-dialog__wrapper');
    for (const wrapper of Array.from(dialogWrappers)) {
      if (wrapper.style.display === 'none') continue;

      // 1. 检测 "购买人数较多"
      const emptyWrap = wrapper.querySelector('.empty-data-wrap');
      if (emptyWrap?.textContent?.includes('购买人数较多')) {
        return { type: 'busy', closeBtn: wrapper.querySelector('.el-dialog__headerbtn') };
      }

      // 2. 检测 支付相关弹窗
      const isPayDialog = wrapper.querySelector('.pay-dialog') ||
                          wrapper.querySelector('.scan-code-box') ||
                          wrapper.querySelector('.confirm-pay-btn');

      if (isPayDialog) {
        let hasRealPrice = false;

        // 策略A：检测 .price-item 包含数字
        const priceItems = wrapper.querySelectorAll('.price-item');
        for (const el of Array.from(priceItems)) {
            const text = el.textContent.replace(/[￥\s]/g, '').trim();
            if (text.length > 0 && /\d/.test(text)) {
                hasRealPrice = true;
                break;
            }
        }

        // 策略B：检测 .info-price 中的 span（除了￥符号那个）包含数字
        if (!hasRealPrice) {
            const infoPriceSpans = wrapper.querySelectorAll('.info-price > span:not(.price-icon)');
            for (const el of Array.from(infoPriceSpans)) {
                const text = el.textContent.replace(/[￥\s]/g, '').trim();
                if (text.length > 0 && /\d/.test(text)) {
                    hasRealPrice = true;
                    break;
                }
            }
        }

        if (hasRealPrice) {
            return { type: 'success-pay', closeBtn: wrapper.querySelector('.el-dialog__headerbtn') };
        }

        if (wrapper.querySelector('.confirm-pay-btn')) {
            return { type: 'confirm-pay', closeBtn: wrapper.querySelector('.el-dialog__headerbtn') };
        }

        // 走到这一步说明弹出了购买框，但是金额里没内容
        return { type: 'empty-price', closeBtn: wrapper.querySelector('.el-dialog__headerbtn') };
      }
    }
    return null;
  }

  function refreshStatus() {
    const el = document.getElementById('glm-simple-status-v16');
    const renderedText = lastStatusText || '就绪';
    if (renderedText === lastRenderedStatusText) return;
    lastRenderedStatusText = renderedText;
    if (el) el.textContent = renderedText;
  }

  function updateStatus(text) {
    lastStatusText = text;
    refreshStatus();
  }

  function getIdleStatusText() {
    const countdown = getCountdown();
    return countdown ? `倒计时 ${countdown}` : '已到点，等待重试闭环';
  }

  function getRateLimitRedirectTarget() {
    if (!location.pathname.includes('/html/rate-limit.html')) return '';
    try {
      const redirect = new URLSearchParams(location.search).get('redirect');
      return redirect || '/glm-coding';
    } catch {
      return '/glm-coding';
    }
  }

  function redirectAwayFromRateLimitPage() {
    const redirectTarget = getRateLimitRedirectTarget();
    if (!redirectTarget) return false;
    console.warn('[Auto-GLM-1.6] 当前位于限流页，尝试跳回:', redirectTarget);
    location.replace(redirectTarget);
    return true;
  }

  if (redirectAwayFromRateLimitPage()) return;

  // ==========================================
  // 核心逻辑
  // ==========================================

  const STORAGE_KEY = 'glm-simple-config-v16';
  const WATCH_GRACE_MS = 40 * 60 * 1000;
  const CYCLE_SETTLE_MS = 350;
  const SECOND_CLICK_DELAY_MS = 120;
  const DIALOG_RETRY_BASE_DELAY_MS = 350; // 已缩短，加速重试
  const DIALOG_RETRY_RANDOM_MS = 300;     // 已缩短
  const PRODUCT_MAP = {
    Lite: { month: 'product-02434c', quarter: 'product-b8ea38', year: 'product-70a804' },
    Pro: { month: 'product-1df3e1', quarter: 'product-fef82f', year: 'product-5643e6' },
    Max: { month: 'product-2fc421', quarter: 'product-5d3a03', year: 'product-d46f8b' }
  };
  const CYCLE_LABELS = { month: '连续包月', quarter: '连续包季', year: '连续包年' };

  const DEFAULT_CONFIG = {
    targetPlan: 'Pro',
    billingCycle: 'quarter',
    targetHour: 10,
    targetMinute: 0,
    targetSecond: 0
  };

  let config = loadConfig();
  let tickTimer = null;
  let isWatching = false;
  let isWaitingCaptcha = false;
  let isClicking = false;
  let hasCompleted = false; // 取代 hasClicked，只有出现真实支付框才设为true
  let targetTimestamp = 0;
  let lastCycleSwitchAt = 0;
  let lastStatusText = '';
  let lastRenderedStatusText = '';
  let retryCount = 0;
  const MAX_RETRY_COUNT = 300; // 安全阈值，避免死循环

  function clampNumber(value, min, max, fallback) {
    const next = Number(value);
    if (!Number.isFinite(next)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(next)));
  }

  function sanitizeConfig(raw = {}) {
    return {
      targetPlan: PRODUCT_MAP[raw.targetPlan] ? raw.targetPlan : DEFAULT_CONFIG.targetPlan,
      billingCycle: CYCLE_LABELS[raw.billingCycle] ? raw.billingCycle : DEFAULT_CONFIG.billingCycle,
      targetHour: clampNumber(raw.targetHour, 0, 23, DEFAULT_CONFIG.targetHour),
      targetMinute: clampNumber(raw.targetMinute, 0, 59, DEFAULT_CONFIG.targetMinute),
      targetSecond: clampNumber(raw.targetSecond, 0, 59, DEFAULT_CONFIG.targetSecond)
    };
  }

  function loadConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_CONFIG };
      return { ...DEFAULT_CONFIG, ...sanitizeConfig(JSON.parse(raw)) };
    } catch { return { ...DEFAULT_CONFIG }; }
  }

  function saveConfig() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch (e) {}
  }

  function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function log(msg) {
    console.log(`[Auto-GLM-1.6] ${msg}`);
    const logBox = document.getElementById('glm-simple-log');
    if (logBox) {
      const time = new Date().toLocaleTimeString();
      logBox.innerHTML = `<div>[${time}] ${escapeHtml(msg)}</div>` + logBox.innerHTML;
      if (logBox.children.length > 50) logBox.lastElementChild.remove();
    }
  }

  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, '').trim();
  }

  function getTargetDate(now = new Date()) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), config.targetHour, config.targetMinute, config.targetSecond || 0, 0);
  }

  function refreshTargetTimestamp() { targetTimestamp = getTargetDate().getTime(); }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function isVisibleElement(node) {
    if (!node || !node.isConnected) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findCycleTab(cycle) {
    const label = CYCLE_LABELS[cycle];
    if (!label) return null;
    return Array.from(document.querySelectorAll('.switch-tab-item')).find(
      node => normalizeText(node.textContent).includes(normalizeText(label))
    ) || null;
  }

  function ensureBillingCycleSelected() {
    const tab = findCycleTab(config.billingCycle);
    if (!tab) return false;
    if (tab.classList.contains('active')) return true;
    if (Date.now() - lastCycleSwitchAt < CYCLE_SETTLE_MS) return false;
    lastCycleSwitchAt = Date.now();
    dispatchRealClick(tab.querySelector('.switch-tab-item-content') || tab);
    return false;
  }

  function findPlanCard(planName) {
    return Array.from(document.querySelectorAll('.package-card-box .package-card'))
      .filter(isVisibleElement)
      .find(card => {
        const title = card.querySelector('.package-card-title .font-prompt');
        return title && normalizeText(title.textContent) === normalizeText(planName);
      }) || null;
  }

  function findBuyButton(card) {
    if (!card) return null;
    return Array.from(card.querySelectorAll('button.buy-btn, .package-card-btn-box button'))
      .find(isVisibleElement) || null;
  }

  function getButtonState(button) {
    if (!button) return { text: '', disabled: true };
    return {
      text: normalizeText(button.textContent),
      disabled: button.disabled || button.getAttribute('aria-disabled') === 'true'
        || button.classList.contains('is-disabled') || button.classList.contains('disabled')
    };
  }

  function temporarilyEnableButton(button) {
    if (!button) return () => {};
    const prev = { disabled: button.disabled, disabledAttr: button.getAttribute('disabled'),
      ariaDisabled: button.getAttribute('aria-disabled'), className: button.className };
    button.disabled = false; button.removeAttribute('disabled');
    button.setAttribute('aria-disabled', 'false');
    button.classList.remove('is-disabled', 'disabled');
    return () => {
      if (button && button.isConnected) {
        button.disabled = prev.disabled;
        if (prev.disabledAttr == null) button.removeAttribute('disabled');
        else button.setAttribute('disabled', prev.disabledAttr);
        if (prev.ariaDisabled == null) button.removeAttribute('aria-disabled');
        else button.setAttribute('aria-disabled', prev.ariaDisabled);
        button.className = prev.className;
      }
    };
  }

  function dispatchMouseLikeEvent(target, type, init) {
    target.dispatchEvent(new MouseEvent(type, init));
  }

  // 获取真实 window（Tampermonkey @grant 沙盒下 window 是 Proxy）
  const realWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  function dispatchRealClick(target) {
    if (!target || !target.isConnected) return false;
    try { target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' }); } catch {}
    try { target.focus({ preventScroll: true }); } catch {}
    const rect = target.getBoundingClientRect();
    const eventInit = { bubbles: true, cancelable: true, composed: true, view: realWindow,
      clientX: rect.left + Math.max(1, rect.width / 2),
      clientY: rect.top + Math.max(1, rect.height / 2) };
    ['mousedown', 'mouseup', 'click'].forEach(type => dispatchMouseLikeEvent(target, type, eventInit));
    target.click();
    return true;
  }

  function getNextTickDelay(now = Date.now()) {
    const diff = targetTimestamp - now;
    if (diff > 60_000) return 1000;
    if (diff > 10_000) return 400;
    if (diff > 3_000) return 120;
    if (diff > 0) return 30; // 较精确轮询
    if (diff > -WATCH_GRACE_MS) return 50; // 到点后的重试节奏
    return 250;
  }

  function scheduleNextTick(delay = getNextTickDelay()) {
    if (!isWatching) return;
    if (tickTimer) clearTimeout(tickTimer);
    tickTimer = setTimeout(() => { tickTimer = null; void tick(); }, delay);
  }

  function isTargetWindowExpired(now = Date.now()) { return now > targetTimestamp + WATCH_GRACE_MS; }

  function getCountdown() {
    const diff = targetTimestamp - Date.now();
    if (diff <= 0) return null;
    const h = Math.floor(diff / (1000 * 60 * 60));
    const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const s = Math.floor((diff % (1000 * 60)) / 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  async function triggerBuyButton(button) {
    if (!button || isClicking) return false;
    isClicking = true;
    let restoreButton = null;
    try {
      const { disabled } = getButtonState(button);
      if (disabled) { restoreButton = temporarilyEnableButton(button); }
      dispatchRealClick(button);
      await sleep(SECOND_CLICK_DELAY_MS);
      return true;
    } finally {
      if (restoreButton) setTimeout(() => { restoreButton(); }, 1200);
      isClicking = false;
    }
  }

  // ============== 核心轮询 =================

  async function tick() {
    if (!isWatching || hasCompleted) return;

    if (retryCount > MAX_RETRY_COUNT) {
      stopWatching({ statusText: '已停止(超限)', logMessage: '重试次数达到上限，为防止死循环自动停止' });
      return;
    }

    if (isTargetWindowExpired()) {
      stopWatching({ statusText: '已过时间', logMessage: '已超过目标时间窗口，自动停止' });
      return;
    }

    // ---------- 1. 处理验证码等待期 ----------
    if (isWaitingCaptcha) {
      if (isCaptchaVisible()) {
        updateStatus('正在自动识别验证码...');
        const solved = await solveCaptchaViaOCR();
        if (solved) {
          log('验证码已自动识别，等待结果...');
          await sleep(2000);
          if (!isCaptchaVisible()) {
            log('验证码界面消失，识别成功');
            isWaitingCaptcha = false;
          } else {
            log('验证码仍在，识别可能失败，关闭验证码重新触发');
            closeCaptcha();
            isWaitingCaptcha = false;
            capturedCaptchaImage = null;
            await sleep(500);
          }
        } else {
          log('自动识别失败，关闭验证码重新触发购买流程');
          closeCaptcha();
          isWaitingCaptcha = false;
          capturedCaptchaImage = null;
          await sleep(500);
        }
        scheduleNextTick(100);
        return;
      } else {
        log('验证码界面消失，准备继续流程');
        isWaitingCaptcha = false;
        await sleep(600);
      }
    }

    // ---------- 2. 处理弹窗检测 ----------
    // 到点后才处理弹窗，避免误杀正常弹窗
    if (Date.now() >= targetTimestamp - 1000) {
      const dialogState = detectDialogState();

      if (dialogState) {
        if (dialogState.type === 'success-pay' || dialogState.type === 'confirm-pay') {
          log(`🎉 检测到真实的支付弹窗(${dialogState.type})，停止重试流程！`);
          updateStatus('抢购完成(弹出支付)');
          hasCompleted = true;
          stopWatching({ statusText: '抢购完成', logMessage: '流程结束，需手动扫码支付' });
          return;
        }

        if (dialogState.type === 'busy' || dialogState.type === 'empty-price') {
          retryCount++;
          log(`[${retryCount}]检测到无效弹窗(${dialogState.type})，关闭重试...`);
          if (dialogState.closeBtn) {
            dispatchRealClick(dialogState.closeBtn);
            await sleep(getDialogRetryDelay());
          }
          // 关闭后直接重新触发下一个Tick寻找购买按钮
          scheduleNextTick(0);
          return;
        }
      }
    }

    // ---------- 3. 及时锁定验证码并自动识别 ----------
    if (isCaptchaVisible()) {
      isWaitingCaptcha = true;
      log('触发腾讯验证码，开始自动识别...');
      updateStatus('自动识别验证码');
      scheduleNextTick(200);
      return;
    }

    // ---------- 4. 正常点击流程 ----------
    updateStatus(getIdleStatusText());

    const cycleReady = ensureBillingCycleSelected();
    if (!cycleReady) { scheduleNextTick(); return; }
    if (Date.now() - lastCycleSwitchAt < CYCLE_SETTLE_MS) { scheduleNextTick(); return; }

    // 如果还没到设定的抢购绝对时间，则继续等待
    if (Date.now() < targetTimestamp) { scheduleNextTick(); return; }

    const card = findPlanCard(config.targetPlan);
    const button = findBuyButton(card);

    if (!button) {
       updateStatus('已到点，等待按钮渲染');
       scheduleNextTick();
       return;
    }

    // 触发点击购买按钮
    const clicked = await triggerBuyButton(button);
    if (clicked) {
       retryCount++;
       // 点击后，给予少量时间让接口返回 / 渲染弹窗
       // 这里不作阻塞式大延时，在后续的 tick 中由于是重连环，会自动捕获弹窗
       await sleep(150);
    }

    scheduleNextTick(100);
  }

  function stopWatching(options = {}) {
    const { statusText = '已停止', logMessage = '已停止' } = options;
    if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
    isWatching = false;
    if (logMessage) log(logMessage);
    updateStatus(statusText);
  }

  function getDialogRetryDelay() { return DIALOG_RETRY_BASE_DELAY_MS + Math.floor(Math.random() * DIALOG_RETRY_RANDOM_MS); }

  function startWatching() {
    if (isWatching) return;
    refreshTargetTimestamp();
    if (isTargetWindowExpired()) { log('已超过目标时间'); updateStatus('已过时间'); return; }

    isWatching = true;
    hasCompleted = false;
    isClicking = false;
    isWaitingCaptcha = false;
    lastCycleSwitchAt = 0;
    retryCount = 0;

    const ts = `${config.targetHour}:${String(config.targetMinute).padStart(2, '0')}:${String(config.targetSecond || 0).padStart(2, '0')}`;
    log(`开始闭环监听，目标时间: ${ts}`);
    updateStatus(getIdleStatusText());
    scheduleNextTick(0);
  }

  function resetClicked() {
    hasCompleted = false;
    isClicking = false;
    isWaitingCaptcha = false;
    retryCount = 0;
    log('已重置状态记录');
    updateStatus(getIdleStatusText());
    if (isWatching) scheduleNextTick(0);
  }

  function handleConfigChange() {
    saveConfig();
    if (!isWatching) return;
    refreshTargetTimestamp();
    hasCompleted = false;
    isWaitingCaptcha = false;
    isClicking = false;
    lastCycleSwitchAt = 0;
    retryCount = 0;
    log('配置已更新，重新开始...');
    updateStatus(getIdleStatusText());
    scheduleNextTick(0);
  }

  // ==========================================
  // UI
  // ==========================================

  function injectStyles() {
    if (document.getElementById('glm-simple-style-v16')) return;
    const s = document.createElement('style');
    s.id = 'glm-simple-style-v16';
    s.textContent = `
      #glm-simple-panel-v16{position:fixed;left:20px;bottom:20px;width:300px;z-index:999999;border-radius:16px;overflow:hidden;background:linear-gradient(135deg,#133054 0%,#182a74 64%,#1d4ed8 100%);box-shadow:0 24px 64px -28px rgba(16,35,63,.45);font-family:"SF Pro Display","PingFang SC","Segoe UI",sans-serif;color:#eff6ff}
      #glm-simple-panel-v16 *{box-sizing:border-box}
      .glm-simple-head-v16{padding:14px 16px; display:flex; justify-content:space-between; align-items:center;}
      .glm-simple-title-v16{font-size:14px;font-weight:700}
      .glm-simple-body-v16{padding:12px 14px;background:rgba(255,255,255,.95);color:#1e293b}
      .glm-simple-row-v16{display:flex;gap:8px;margin-bottom:10px}
      .glm-simple-field-v16{flex:1}
      .glm-simple-field-v16 label{display:block;font-size:11px;font-weight:600;color:#475569;margin-bottom:4px}
      .glm-simple-field-v16 select,.glm-simple-field-v16 input{width:100%;padding:6px 8px;border:1px solid #cbd5e1;border-radius:8px;font-size:13px;background:#f8fafc}
      .glm-simple-time-v16{display:flex;align-items:center;gap:4px}
      .glm-simple-time-v16 input{width:50px;text-align:center}
      .glm-simple-time-v16 span{font-size:12px;color:#64748b}
      .glm-simple-status-v16{font-size:13px;margin-bottom:10px;padding:8px;background:#f1f5f9;border-radius:8px;text-align:center;font-weight:bold;color:#1e40af;}
      .glm-simple-actions-v16{display:flex;gap:8px}
      .glm-simple-btn-v16{flex:1;padding:8px 12px;border:none;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;color:#fff;background:linear-gradient(135deg,#1d4ed8,#0ea5e9);transition:all .2s;}
      .glm-simple-btn-v16:hover{opacity:0.9; transform:translateY(-1px);}
      .glm-simple-btn-v16.secondary{color:#475569;background:#e2e8f0}
      .glm-simple-log-v16{margin-top:10px;max-height:100px;overflow:auto;font-size:11px;color:#334155;background:#f8fafc;border-radius:8px;padding:6px 8px;line-height:1.4;}
      .glm-simple-badge-v16{font-size:10px; background:#ef4444; color:white; padding:2px 6px; border-radius:10px;}
    `;
    document.head.appendChild(s);
  }

  function buildPanel() {
    if (document.getElementById('glm-simple-panel-v16')) return;
    const panel = document.createElement('div');
    panel.id = 'glm-simple-panel-v16';
    panel.innerHTML = `
      <div class="glm-simple-head-v16">
         <div class="glm-simple-title-v16">GLM 抢购助手 <span class="glm-simple-badge-v16">v1.6 闭环版</span></div>
      </div>
      <div class="glm-simple-body-v16">
        <div class="glm-simple-row-v16">
          <div class="glm-simple-field-v16">
            <label>套餐设置</label>
            <select id="glm-simple-plan-v16"><option value="Lite">Lite</option><option value="Pro">Pro</option><option value="Max">Max</option></select>
          </div>
          <div class="glm-simple-field-v16">
            <label>购买周期</label>
            <select id="glm-simple-cycle-v16"><option value="month">连续包月</option><option value="quarter">连续包季</option><option value="year">连续包年</option></select>
          </div>
        </div>
        <div class="glm-simple-row-v16 glm-simple-time-v16">
          <div class="glm-simple-field-v16"><label>目标时</label><input id="glm-simple-hour-v16" type="number" min="0" max="23"></div><span>:</span>
          <div class="glm-simple-field-v16"><label>目标分</label><input id="glm-simple-minute-v16" type="number" min="0" max="59"></div><span>:</span>
          <div class="glm-simple-field-v16"><label>目标秒</label><input id="glm-simple-second-v16" type="number" min="0" max="59"></div>
        </div>
        <div class="glm-simple-status-v16" id="glm-simple-status-v16">就绪</div>
        <div class="glm-simple-actions-v16">
          <button class="glm-simple-btn-v16" id="glm-simple-start-v16" type="button">开启自动重试购买</button>
          <button class="glm-simple-btn-v16 secondary" id="glm-simple-stop-v16" style="flex:0.6" type="button">停止</button>
        </div>
        <div class="glm-simple-log-v16" id="glm-simple-log-v16"></div>
      </div>`;
    document.body.appendChild(panel);

    const planEl = document.getElementById('glm-simple-plan-v16');
    const cycleEl = document.getElementById('glm-simple-cycle-v16');
    const hourEl = document.getElementById('glm-simple-hour-v16');
    const minEl = document.getElementById('glm-simple-minute-v16');
    const secEl = document.getElementById('glm-simple-second-v16');

    planEl.value = config.targetPlan;
    cycleEl.value = config.billingCycle;
    hourEl.value = config.targetHour;
    minEl.value = config.targetMinute;
    secEl.value = config.targetSecond || 0;

    planEl.addEventListener('change', () => { config.targetPlan = planEl.value; handleConfigChange(); });
    cycleEl.addEventListener('change', () => { config.billingCycle = cycleEl.value; handleConfigChange(); });
    hourEl.addEventListener('change', () => { config.targetHour = Math.max(0, Math.min(23, Number(hourEl.value) || 0)); hourEl.value = config.targetHour; handleConfigChange(); });
    minEl.addEventListener('change', () => { config.targetMinute = Math.max(0, Math.min(59, Number(minEl.value) || 0)); minEl.value = config.targetMinute; handleConfigChange(); });
    secEl.addEventListener('change', () => { config.targetSecond = Math.max(0, Math.min(59, Number(secEl.value) || 0)); secEl.value = config.targetSecond; handleConfigChange(); });

    document.getElementById('glm-simple-start-v16').addEventListener('click', startWatching);
    document.getElementById('glm-simple-stop-v16').addEventListener('click', () => { stopWatching(); });
  }

  function bootstrap() {
    injectStyles();
    buildPanel();
    updateStatus('准备就绪');
    log('脚本引擎加载完毕 v1.6 (闭环重组)');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();