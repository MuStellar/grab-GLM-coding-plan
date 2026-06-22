// ==UserScript==
// @name         GLM Coding Plan 全自动抢购助手 (增强版) v1.7.1
// @namespace    http://tampermonkey.net/
// @version      1.7.1
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
// @connect      *
// @run-at       document-start
// ==/UserScript==
//
// ============================================================
// 使用说明：
// 如遇弹窗（购买人数多/无价格）会自动重发。
// ============================================================

(function () {
  'use strict';

  if (window.__autoGlmSimple16Initialized) return;
  window.__autoGlmSimple16Initialized = true;

  // 抢购目标路径（限流回跳等内部导航统一使用）
  const GLM_PATH = '/glm-coding?ic=FJGOX95A1A';

  // ==========================================
  // 网络拦截层
  // ==========================================

  // 把售罄/限购态改写成可买。智谱的 JSON 冒号后带空格（如 "soldOut": true），
  // 正则必须容忍空白——之前用 /"soldOut":true/ 匹配不到带空格的真实响应，是改写一直没生效的根因。
  // 实测 batch-preview 的真实字段是 soldOut / canPurchase / forbidden，不是 isSoldOut/stock 那些。
  // 返回改写后的文本；没有可改的内容则返回 null。
  // rewriteHitCount：累计改写命中次数，供诊断日志判断“卡灰”时改写到底有没有在生效。
  let rewriteHitCount = 0;
  let rateLimitBypassCount = 0;   // 限流接口被拦截放行的次数
  let lastSniffAt = 0;            // 嗅探日志节流时间戳

  // 嗅探：把“抢购人数过多/请刷新/限流”相关响应的原文打到面板，定位这状态的真实来源。
  // 我们手上的接口文档没覆盖“限流态”，必须抓一次真身才能精确改写。url 已去掉 query。
  function sniffBusyResponse(url, status, bodyText) {
    const text = String(bodyText || '');
    const looksBusy = /人数过多|请刷新|限流|忙|busy|rateLimit|429/i.test(text) || status === 429;
    const isKeyApi = /batch-preview|rate-limit|ratelimit|pay\/preview/i.test(url);
    if (!looksBusy && !isKeyApi) return;
    const now = Date.now();
    if (now - lastSniffAt < 700) return;   // 节流，避免刷屏
    lastSniffAt = now;
    const shortUrl = url.split('?')[0].split('/').slice(-3).join('/');
    const snip = text.length > 260 ? text.slice(0, 260) + '…' : text;
    log(`嗅探｜${shortUrl} status=${status}｜${snip}`);
  }

  function neutralizeSoldOut(text) {
    const hasSoldOut = /"(?:isSoldOut|disabled|soldOut|isLimitBuy|isServerBusy|forbidden)"\s*:\s*true/.test(text);
    const hasZeroStock = /"stock"\s*:\s*0(?![.\d])/.test(text);
    const hasBlockedPurchase = /"canPurchase"\s*:\s*(?:null|false)/.test(text);
    if (!hasSoldOut && !hasZeroStock && !hasBlockedPurchase) return null;
    return text
      .replace(/("(?:isSoldOut|disabled|soldOut|isLimitBuy|isServerBusy|forbidden)"\s*:\s*)true/g, '$1false')
      .replace(/("stock"\s*:\s*)0(?![.\d])/g, '$1999')
      .replace(/("canPurchase"\s*:\s*)(?:null|false)/g, '$1true');
  }

  // batch-preview 限流自动重试参数：服务器忙时回 {code:555,success:false,data:null}，
  // 页面据此把按钮渲染成“抢购人数过多，请刷新再试”。我们替页面把同一请求快速重试，
  // 拿到 success 的响应再回给页面，抓住服务器恢复/放量的瞬间。
  const BATCH_PREVIEW_BUSY_RETRY = 6;        // 单次请求最多额外重试几次
  const BATCH_PREVIEW_RETRY_DELAY_MS = 180;  // 每次重试间隔
  function looksBusyBody(t) {
    return /"success"\s*:\s*false/.test(t) || /"code"\s*:\s*5\d\d/.test(t) ||
           /系统繁忙|人数过多|请稍后|请刷新/.test(t);
  }

  // 1. 绕过限流接口
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const [input] = args;
    const requestUrl = typeof input === 'string' ? input : input?.url || String(input || '');
    // 放宽限流接口匹配：之前只认死路径 /api/biz/rate-limit/check，万一真实路径有出入就漏拦。
    if (/rate-?limit/i.test(requestUrl) && /check|verify|pass/i.test(requestUrl)) {
      rateLimitBypassCount++;
      log(`拦截限流检查并强制放行（累计 ${rateLimitBypassCount} 次）: ${requestUrl.split('?')[0].split('/').slice(-2).join('/')}`);
      return new Response(JSON.stringify({
        code: 0, msg: 'success', data: null, success: true
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    let response = await originalFetch.apply(this, args);

    // batch-preview 限流自动重试：忙就用同一请求重发，拿到 success 的真实响应再回给页面。
    // （若整段时间服务器都繁忙，谁也买不到——官网对所有人也是这个提示。）
    if (/batch-preview/i.test(requestUrl)) {
      for (let i = 0; i <= BATCH_PREVIEW_BUSY_RETRY; i++) {
        let body = '';
        try { body = await response.clone().text(); } catch (e) {}
        sniffBusyResponse(requestUrl, response.status, body);
        if (!looksBusyBody(body)) break;
        if (i === BATCH_PREVIEW_BUSY_RETRY) break;
        if (i === 0) {
          const codeM = body.match(/"code"\s*:\s*(\d+)/);
          log(`batch-preview 限流(code=${codeM ? codeM[1] : '?'})，替页面自动重试抢窗口…`);
        }
        await sleep(BATCH_PREVIEW_RETRY_DELAY_MS);
        response = await originalFetch.apply(this, args);
      }
    } else if (/rate-?limit|pay\/preview/i.test(requestUrl) || response.status === 429) {
      // 其它关键接口/疑似限流响应做嗅探取证（含非 json、非 200，如 429），不改写只记录。
      try { sniffBusyResponse(requestUrl, response.status, await response.clone().text()); } catch (e) {}
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try {
        const text = await response.clone().text();
        const rewritten = neutralizeSoldOut(text);
        if (rewritten !== null) {
          rewriteHitCount++;
          console.log('[Auto-GLM-1.7] 改写售罄/限购数据:', requestUrl);
          return new Response(rewritten, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
          });
        }
      } catch (e) {
        console.log('[Auto-GLM-1.7] Fetch拦截异常:', e.message);
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
      if (this.readyState !== 4) return;
      // 先嗅探取证：覆盖非 200（如 429）和非 json，定位“抢购人数过多”真身。
      try {
        const rt0 = this.responseType;
        let raw0 = null;
        if (rt0 === '' || rt0 === 'text') raw0 = this.responseText;
        else if (rt0 === 'json' && this.response != null) raw0 = JSON.stringify(this.response);
        if (raw0 != null) sniffBusyResponse(this._reqUrl || '', this.status, raw0);
      } catch (e) {}
      if (this.status === 200) {
        const contentType = this.getResponseHeader('content-type') || '';
        if (contentType.includes('application/json')) {
          try {
            // responseType 为 'json'/'blob' 等时访问 responseText 会抛 InvalidStateError，
            // 旧代码被 catch 吞掉 → 这类响应静默漏改写（间歇卡灰的可能原因）。
            // 这里按 responseType 取原文：text/'' 用 responseText，json 用 response 序列化。
            const rt = this.responseType;
            let raw = null;
            if (rt === '' || rt === 'text') raw = this.responseText;
            else if (rt === 'json' && this.response != null) raw = JSON.stringify(this.response);
            const rewritten = raw == null ? null : neutralizeSoldOut(raw);
            if (rewritten !== null) {
              rewriteHitCount++;
              console.log('[Auto-GLM-1.7] 改写XHR售罄/限购数据:', this._reqUrl, '(responseType=' + (rt || 'text') + ')');
              const parsed = JSON.parse(rewritten);
              if (rt === '' || rt === 'text') {
                Object.defineProperty(this, 'responseText', { get: () => rewritten });
                Object.defineProperty(this, 'response', { get: () => rewritten });
              } else {
                Object.defineProperty(this, 'response', { get: () => parsed });
              }
            }
          } catch (e) {
            console.log('[Auto-GLM-1.7] XHR拦截异常:', e.message);
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
      console.log('[Auto-GLM-1.7] 拦截 pushState 跳转至限流页，强制跳转回目标页');
      setTimeout(() => { history.pushState(null, '', GLM_PATH); }, Math.floor(Math.random() * 701) + 500);
      return;
    }
    return originalPushState.apply(this, args);
  };
  history.replaceState = function (...args) {
    const url = args[2] || '';
    if (url && url.includes('rate-limit')) {
      console.log('[Auto-GLM-1.7] 拦截 replaceState 跳转至限流页，强制跳转回目标页');
      setTimeout(() => { history.replaceState(null, '', GLM_PATH); }, Math.floor(Math.random() * 701) + 500);
      return;
    }
    return originalReplaceState.apply(this, args);
  };

  console.log('[Auto-GLM-1.7] 网络拦截器已注册');

  // ==========================================
  // 验证码图片拦截层
  // ==========================================

  // 拦截腾讯验证码图片：通过拦截网络响应捕获图片 base64
  let capturedCaptchaImage = null; // { src, base64, width, height }

  // 拦截 PerformanceObserver 捕获验证码图片请求
  const po = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name && (entry.name.includes('captcha') || entry.name.includes('tencent') || entry.name.includes('verify'))) {
        console.log('[Auto-GLM-1.7] 检测到验证码图片请求:', entry.name.substring(0, 80));
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
          console.log('[Auto-GLM-1.7] 捕获验证码图片 URL:', val.substring(0, 80));
          img.addEventListener('load', () => {
            try {
              const canvas = document.createElement('canvas');
              canvas.width = img.naturalWidth;
              canvas.height = img.naturalHeight;
              canvas.getContext('2d').drawImage(img, 0, 0);
              const base64 = canvas.toDataURL('image/jpeg', 0.95);
              capturedCaptchaImage = { src: val, base64: base64, width: img.naturalWidth, height: img.naturalHeight };
              console.log(`[Auto-GLM-1.7] 验证码图片已缓存: ${img.naturalWidth}x${img.naturalHeight}`);
            } catch (e) {
              console.log('[Auto-GLM-1.7] 缓存验证码图片失败(跨域):', e.message);
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
            console.log('[Auto-GLM-1.7] createElement 捕获验证码图片 URL:', val.substring(0, 80));
            el.addEventListener('load', () => {
              try {
                const canvas = document.createElement('canvas');
                canvas.width = el.naturalWidth;
                canvas.height = el.naturalHeight;
                canvas.getContext('2d').drawImage(el, 0, 0);
                const base64 = canvas.toDataURL('image/jpeg', 0.95);
                capturedCaptchaImage = { src: val, base64: base64, width: el.naturalWidth, height: el.naturalHeight };
                console.log(`[Auto-GLM-1.7] 验证码图片已缓存: ${el.naturalWidth}x${el.naturalHeight}`);
              } catch (e) {
                console.log('[Auto-GLM-1.7] 缓存验证码图片失败(跨域):', e.message);
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

  console.log('[Auto-GLM-1.7] 验证码图片拦截器已注册');

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
  const SERVICE_HEALTH_URL = 'http://127.0.0.1:8123/';

  // 用 GM_xmlhttpRequest 发起请求（绕过 CORS）
  function gmFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
      const cfg = {
        method: options.method || 'GET',
        url: url,
        headers: options.headers || {},
        data: options.body,
        responseType: options.responseType || 'text',
        onload(resp) { resolve(resp); },
        onerror(err) {
          const e = new Error('网络请求失败（连不上 ' + url + '）' + (err && err.error ? ' - ' + err.error : ''));
          e.isNetworkError = true;
          reject(e);
        },
        ontimeout() {
          const e = new Error('请求超时（' + url + '）');
          e.isNetworkError = true;
          reject(e);
        },
      };
      // 只在传入正数时才设 timeout：GM_xmlhttpRequest 会把 timeout:0 当成"0 毫秒=立即超时"，
      // 而非"无超时"，会导致识别 POST 刚发出就被判超时。
      if (options.timeout && options.timeout > 0) cfg.timeout = options.timeout;
      GM_xmlhttpRequest(cfg);
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

      setServiceWarning(false); // 成功拿到识别结果，说明服务在线
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
      if (e && e.isNetworkError) {
        setServiceWarning(true);
        log('❌ 识别请求失败: ' + (e.message || '未知网络错误'));
        log('   提示: 若上方含 "not part of @connect" 请在油猴重新授权脚本；否则确认 service.py 在 8123 运行');
      } else {
        log('验证码识别异常: ' + (e && e.message ? e.message : String(e)));
      }
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

  // 元素是否真正可见：DOM 里存在但隐藏/零尺寸的残留节点会造成误判
  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }

  // 统一弹窗检测
  function detectDialogState() {
    const dialogWrappers = document.querySelectorAll('.el-dialog__wrapper');
    for (const wrapper of Array.from(dialogWrappers)) {
      if (!isVisible(wrapper)) continue;

      // 1. 检测 "购买人数较多"
      const emptyWrap = wrapper.querySelector('.empty-data-wrap');
      if (emptyWrap?.textContent?.includes('购买人数较多')) {
        return { type: 'busy', closeBtn: wrapper.querySelector('.el-dialog__headerbtn') };
      }

      // 2. 检测 支付相关弹窗
      const payEl = wrapper.querySelector('.pay-dialog') ||
                    wrapper.querySelector('.scan-code-box') ||
                    wrapper.querySelector('.confirm-pay-btn');

      if (isVisible(payEl)) {
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

        if (isVisible(wrapper.querySelector('.confirm-pay-btn'))) {
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
    if (!el) return;
    el.textContent = renderedText;
    let state = 'active';
    if (/完成|成功/.test(renderedText)) state = 'success';
    else if (/停止|过时间|超限|失败|异常|错误/.test(renderedText)) state = 'danger';
    else if (/验证码/.test(renderedText)) state = 'info';
    else if (/就绪|准备/.test(renderedText)) state = 'idle';
    el.dataset.state = state;
  }

  // 同步标题栏指示灯与切换按钮的运行状态
  function refreshControls() {
    const dot = document.getElementById('glm-simple-dot-v16');
    const btn = document.getElementById('glm-simple-toggle-v16');
    if (dot) dot.dataset.state = hasCompleted ? 'done' : (isWatching ? 'running' : 'idle');
    if (btn) {
      btn.textContent = isWatching ? '■ 停止监听' : '▶ 开始监听';
      btn.dataset.mode = isWatching ? 'stop' : 'start';
    }
  }

  // 显示/隐藏"识别服务未连接"红色警告条
  function setServiceWarning(show) {
    const warn = document.getElementById('glm-simple-warn-v16');
    if (warn) warn.style.display = show ? '' : 'none';
  }

  // 探测本地识别服务是否在线（开抢前预检，避免到验证码才发现没开）
  async function checkServiceHealth() {
    try {
      await gmFetch(SERVICE_HEALTH_URL, { method: 'GET', timeout: HEALTH_CHECK_TIMEOUT_MS });
      return true;
    } catch (e) {
      return false;
    }
  }

  // 轮询服务状态：更新红条 + lastHealthOk，仅在状态变化时记一条日志（不刷屏）
  async function pollServiceHealth() {
    const ok = await checkServiceHealth();
    setServiceWarning(!ok);
    if (ok !== lastHealthOk) {
      lastHealthOk = ok;
      log(ok ? '识别服务已连接 ✓' : '⚠️ 识别服务未连接，请确认 service.py 已在 8123 端口运行');
    }
    return ok;
  }

  // 自适应节奏：正常 6s 一次（开销可忽略），断开时 2s 一次（开了 python 能快速恢复）
  function scheduleHealthPoll() {
    if (healthTimer) { clearTimeout(healthTimer); healthTimer = null; }
    if (!isWatching) return;
    const delay = lastHealthOk === false ? HEALTH_POLL_DOWN_MS : HEALTH_POLL_OK_MS;
    healthTimer = setTimeout(() => { pollServiceHealth().then(scheduleHealthPoll); }, delay);
  }

  function updateStatus(text) {
    lastStatusText = text;
    refreshStatus();
  }

  function getIdleStatusText() {
    if (!isWatching) return '就绪';
    const now = Date.now();
    if (now >= targetTimestamp) return '已到点 · 重试抢购中';
    if (now >= targetTimestamp - START_LEAD_MS) return '提前抢购中 · 临近开售';
    return '监听中 · 等待到点';
  }

  function getRateLimitRedirectTarget() {
    if (!location.pathname.includes('/html/rate-limit.html')) return '';
    try {
      const redirect = new URLSearchParams(location.search).get('redirect');
      return redirect || GLM_PATH;
    } catch {
      return GLM_PATH;
    }
  }

  function redirectAwayFromRateLimitPage() {
    const redirectTarget = getRateLimitRedirectTarget();
    if (!redirectTarget) return false;
    console.warn('[Auto-GLM-1.7] 当前位于限流页，尝试跳回:', redirectTarget);
    location.replace(redirectTarget);
    return true;
  }

  if (redirectAwayFromRateLimitPage()) return;

  // ==========================================
  // 核心逻辑
  // ==========================================

  const STORAGE_KEY = 'glm-simple-config-v16';
  const WATCH_GRACE_MS = 60 * 60 * 1000;
  const START_LEAD_MS = 2 * 60 * 1000;  // 比目标时刻提前 2 分钟开火（开售前已是 555，提前热身、接住开售第一秒）
  const CYCLE_SETTLE_MS = 350;
  const BUSY_RELOAD_THROTTLE_MS = 1500;          // 系统繁忙时两次刷新的最小间隔（越小越激进）
  const WATCH_RESUME_KEY = 'glm-watch-resume-v16'; // 刷新后自动续监听的标记
  const LAST_RELOAD_KEY = 'glm-last-reload-v16';   // 上次刷新时间戳（跨刷新节流）
  const SECOND_CLICK_DELAY_MS = 120;
  const DIALOG_RETRY_BASE_DELAY_MS = 350; // 已缩短，加速重试
  const DIALOG_RETRY_RANDOM_MS = 300;     // 已缩短
  const HEALTH_CHECK_TIMEOUT_MS = 3000;   // 单次健康探测超时
  const HEALTH_POLL_OK_MS = 6000;         // 服务正常时的轮询间隔
  const HEALTH_POLL_DOWN_MS = 2000;       // 服务断开时的轮询间隔（更快恢复）
  const PRODUCT_MAP = {
    Lite: { month: 'product-02434c', quarter: 'product-b8ea38', year: 'product-70a804' },
    Pro: { month: 'product-1df3e1', quarter: 'product-fef82f', year: 'product-5643e6' },
    Max: { month: 'product-2fc421', quarter: 'product-5d3a03', year: 'product-d46f8b' }
  };
  const CYCLE_LABELS = { month: '连续包月', quarter: '连续包季', year: '连续包年' };

  const DEFAULT_CONFIG = {
    targetPlan: 'Lite',
    billingCycle: 'month',
    targetDate: '',        // 空 = 自动取"下一次"该时刻（今天没到则今天、过了则明天）
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
  let countdownTimer = null;
  let healthTimer = null;
  let lastHealthOk = null;
  let lastCycleSwitchAt = 0;
  let lastStatusText = '';
  let lastRenderedStatusText = '';
  let lastClockText = '';
  let lastSubText = '';
  let retryCount = 0;
  let lastDiagAt = 0;   // 诊断日志节流时间戳
  // 真正的"放弃"由 WATCH_GRACE_MS 时间窗口（isTargetWindowExpired）决定。
  // 这个计数只作兜底，防止极端情况下的紧致死循环——所以要足够大，别让它在该窗口内
  // 先于时间窗口触发（旧值 300，几分钟就用光，导致没撑到窗口结束就停了）。
  const MAX_RETRY_COUNT = 100000;

  function clampNumber(value, min, max, fallback) {
    const next = Number(value);
    if (!Number.isFinite(next)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(next)));
  }

  function sanitizeConfig(raw = {}) {
    return {
      targetPlan: PRODUCT_MAP[raw.targetPlan] ? raw.targetPlan : DEFAULT_CONFIG.targetPlan,
      billingCycle: CYCLE_LABELS[raw.billingCycle] ? raw.billingCycle : DEFAULT_CONFIG.billingCycle,
      targetDate: sanitizeDate(raw.targetDate),
      targetHour: clampNumber(raw.targetHour, 0, 23, DEFAULT_CONFIG.targetHour),
      targetMinute: clampNumber(raw.targetMinute, 0, 59, DEFAULT_CONFIG.targetMinute),
      targetSecond: clampNumber(raw.targetSecond, 0, 59, DEFAULT_CONFIG.targetSecond)
    };
  }

  // 校验 YYYY-MM-DD：格式不对或已是过去的日期则作废（返回 ''，回退到"下一次"逻辑）
  function sanitizeDate(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return '';
    const [y, mo, d] = v.split('-').map(Number);
    const dt = new Date(y, mo - 1, d);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return dt.getTime() >= today.getTime() ? v : '';
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
    console.log(`[Auto-GLM-1.7] ${msg}`);
    const logBox = document.getElementById('glm-simple-log-v16');
    if (logBox) {
      const time = new Date().toLocaleTimeString();
      logBox.innerHTML = `<div>[${time}] ${escapeHtml(msg)}</div>` + logBox.innerHTML;
      if (logBox.children.length > 50) logBox.lastElementChild.remove();
    }
  }

  // 卡灰诊断：到点后若迟迟没进展，每 ~1.5s 打一条按钮状态，便于下次抢购定位是
  // “没找到按钮”（售罄渲染成非按钮）还是“点了但 React 仍按售罄态拦截”。
  function diag(msg) {
    const now = Date.now();
    if (now - lastDiagAt < 1500) return;
    lastDiagAt = now;
    log(`诊断｜${msg}（累计改写命中 ${rewriteHitCount} 次）`);
  }

  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, '').trim();
  }

  function toDateStr(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  // 未显式指定日期时，取"下一次"该时刻所在日期：今天没到点用今天，已过(超宽限)用明天。
  function nextOccurrenceDateStr(now = new Date()) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), config.targetHour, config.targetMinute, config.targetSecond || 0, 0);
    if (now.getTime() > d.getTime() + WATCH_GRACE_MS) d.setDate(d.getDate() + 1);
    return toDateStr(d);
  }

  function getTargetDate(now = new Date()) {
    const dateStr = config.targetDate || nextOccurrenceDateStr(now);
    const [y, mo, d] = dateStr.split('-').map(Number);
    return new Date(y, mo - 1, d, config.targetHour, config.targetMinute, config.targetSecond || 0, 0);
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

  // batch-preview 返回 555 系统繁忙时 data 为 null，无字段可改写，页面也不会自己重拉，
  // 只能刷新整页拿一份新的售卖态（实战脚本 mumumi v9.3 同思路）。带节流防刷新风暴，
  // 并落一个续监听标记，刷新后自动续上（见 maybeAutoResume）。
  function reloadForFreshPreview() {
    let last = 0;
    try { last = Number(localStorage.getItem(LAST_RELOAD_KEY)) || 0; } catch (e) {}
    if (Date.now() - last < BUSY_RELOAD_THROTTLE_MS) return;
    try {
      localStorage.setItem(LAST_RELOAD_KEY, String(Date.now()));
      localStorage.setItem(WATCH_RESUME_KEY, String(Date.now()));
    } catch (e) {}
    log('系统繁忙(batch-preview 555)，刷新页面重拉售卖态…');
    location.reload();
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

  function pad2(n) { return String(n).padStart(2, '0'); }

  function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  // 独立的倒计时渲染：监听中锁定 targetTimestamp；未监听时实时预览下一次目标时间
  function renderCountdown() {
    const clock = document.getElementById('glm-simple-countdown-v16');
    const sub = document.getElementById('glm-simple-target-v16');
    if (!clock) return;
    const now = Date.now();
    const targetMs = isWatching ? targetTimestamp : getTargetDate().getTime();
    const diff = targetMs - now;
    let clockText;
    if (diff <= 0) {
      clockText = isWatching ? '抢购中…' : '00:00:00';
    } else {
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      clockText = `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
    }
    // 该函数每 500ms 跑一次，仅在文本变化时写 DOM（复用状态栏同款 diff-before-write）
    if (clockText !== lastClockText) { clock.textContent = clockText; lastClockText = clockText; }
    if (sub) {
      const t = new Date(targetMs);
      let dayLabel;
      if (isSameDay(t, new Date(now))) dayLabel = '今天';
      else {
        const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
        dayLabel = isSameDay(t, tomorrow) ? '明天' : `${t.getMonth() + 1}/${t.getDate()}`;
      }
      const subText = `目标 ${dayLabel} ${pad2(config.targetHour)}:${pad2(config.targetMinute)}:${pad2(config.targetSecond || 0)}`;
      if (subText !== lastSubText) { sub.textContent = subText; lastSubText = subText; }
    }
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
        // 服务未连接：保持验证码开着，等 python 起来再识别（不关闭，避免空耗）
        if (lastHealthOk === false) {
          updateStatus('⏸ 验证码已弹出，等待识别服务…');
          scheduleNextTick(800);
          return;
        }
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
    // 到「目标时刻 - 提前量」后才处理弹窗，避免误杀正常弹窗
    if (Date.now() >= targetTimestamp - START_LEAD_MS) {
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

    // 还没到「目标时刻 - 提前量」则继续等待；到了就提前开火（开售前已是 555，先热身刷）
    if (Date.now() < targetTimestamp - START_LEAD_MS) { scheduleNextTick(); return; }

    // 服务未连接：先不点购买（避免弹出无法识别的验证码、空耗重试次数），等服务就绪
    if (lastHealthOk === false) {
      updateStatus('⏸ 已到点，等待识别服务启动…');
      scheduleNextTick(500);
      return;
    }

    const card = findPlanCard(config.targetPlan);
    const button = findBuyButton(card);

    if (!button) {
       // 模式 A：售罄时页面可能把按钮渲染成非 <button> 元素，findBuyButton 找不到 → 一直不点。
       diag(`未找到购买按钮（卡片${card ? '存在' : '缺失'}，售罄可能渲染成非按钮元素）`);
       updateStatus('已到点，等待按钮渲染');
       scheduleNextTick();
       return;
    }

    // 模式 B：按钮找到但禁用。
    //  - 系统繁忙(batch-preview 555 → "抢购人数过多/请刷新")：data 为 null 无字段可改，
    //    页面加载后不会自己重拉，唯一出路是刷新整页再请求一次 batch-preview，反复刷新去
    //    抢服务器返回 200 的瞬间（实战成功脚本 mumumi 同打法）。刷新后自动续监听。
    //  - 真售罄：neutralize 钩子已把 soldOut 翻成可买，强制点击即可走验证码流程。
    const beforeState = getButtonState(button);
    if (beforeState.disabled) {
      if (/抢购人数过多|请刷新|系统繁忙|稍后/.test(beforeState.text)) {
        diag(`系统繁忙(batch-preview 555)，刷新整页抢 200 窗口 text="${beforeState.text}"`);
        reloadForFreshPreview();   // 节流窗口内则不刷新
        scheduleNextTick();        // 没刷新就继续轮询，等节流到点再刷
        return;
      }
      diag(`按钮存在但禁用 text="${beforeState.text}"，强制点击`);
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
    if (healthTimer) { clearTimeout(healthTimer); healthTimer = null; }
    lastHealthOk = null;
    setServiceWarning(false);
    isWatching = false;
    // 手动/到点停止后清掉续监听标记，避免刷新后又自动续上
    try { localStorage.removeItem(WATCH_RESUME_KEY); } catch (e) {}
    if (logMessage) log(logMessage);
    updateStatus(statusText);
    refreshControls();
    renderCountdown();
  }

  function getDialogRetryDelay() { return DIALOG_RETRY_BASE_DELAY_MS + Math.floor(Math.random() * DIALOG_RETRY_RANDOM_MS); }

  // 刷新后自动续上监听：reloadForFreshPreview 会落一个新鲜标记，页面重新加载后
  // 若标记仍新鲜且仍在目标时间窗口内，就自动重新开始监听，保持无人值守的自动化。
  function maybeAutoResume() {
    let at = 0;
    try { at = Number(localStorage.getItem(WATCH_RESUME_KEY)) || 0; } catch (e) {}
    if (!at) return;
    // 标记超过 3 分钟视为过期（防止很久以后再开页面被误自动启动）
    if (Date.now() - at > 3 * 60 * 1000) { try { localStorage.removeItem(WATCH_RESUME_KEY); } catch (e) {} return; }
    refreshTargetTimestamp();
    if (isTargetWindowExpired()) { try { localStorage.removeItem(WATCH_RESUME_KEY); } catch (e) {} return; }
    log('检测到刷新前正在监听，自动继续…');
    startWatching();
  }

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
    try { localStorage.setItem(WATCH_RESUME_KEY, String(Date.now())); } catch (e) {}

    const ts = `${config.targetHour}:${String(config.targetMinute).padStart(2, '0')}:${String(config.targetSecond || 0).padStart(2, '0')}`;
    log(`开始监听，目标时间: ${ts}`);
    updateStatus(getIdleStatusText());
    refreshControls();
    renderCountdown();
    scheduleNextTick(0);

    // 预检本地识别服务并持续轮询：中途开/关 python 都会自动更新红条与门控状态
    lastHealthOk = null;
    pollServiceHealth().then(scheduleHealthPoll);
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
      #glm-simple-panel-v16{position:fixed;left:20px;bottom:20px;width:288px;z-index:999999;border-radius:16px;overflow:hidden;background:#fff;border:1px solid #e6e8ef;box-shadow:0 18px 50px -20px rgba(30,41,59,.45);font-family:"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;color:#1e293b;font-size:13px}
      #glm-simple-panel-v16 *{box-sizing:border-box}
      #glm-simple-panel-v16 .glm-head{display:flex;align-items:center;justify-content:space-between;padding:11px 14px;background:linear-gradient(135deg,#4f46e5,#6366f1);color:#fff;cursor:move;user-select:none}
      #glm-simple-panel-v16 .glm-head-left{display:flex;align-items:center;gap:8px}
      #glm-simple-panel-v16 .glm-title{font-size:14px;font-weight:700;letter-spacing:.3px}
      #glm-simple-panel-v16 .glm-badge{font-size:10px;font-weight:600;background:rgba(255,255,255,.22);padding:1px 6px;border-radius:8px}
      #glm-simple-panel-v16 .glm-dot{width:9px;height:9px;border-radius:50%;background:#cbd5e1;flex:none}
      #glm-simple-panel-v16 .glm-dot[data-state="running"]{background:#22c55e;animation:glmPulse 1.4s infinite}
      #glm-simple-panel-v16 .glm-dot[data-state="done"]{background:#fbbf24}
      @keyframes glmPulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.55)}70%{box-shadow:0 0 0 7px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
      #glm-simple-panel-v16 .glm-head-btns{display:flex;gap:6px}
      #glm-simple-panel-v16 .glm-iconbtn{border:none;background:rgba(255,255,255,.18);color:#fff;width:22px;height:22px;border-radius:7px;cursor:pointer;font-size:16px;line-height:1;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0}
      #glm-simple-panel-v16 .glm-iconbtn:hover{background:rgba(255,255,255,.34)}
      #glm-simple-panel-v16 .glm-iconbtn.glm-close:hover{background:#ef4444}
      #glm-simple-panel-v16 .glm-body{padding:14px}
      #glm-simple-panel-v16 .glm-clock-wrap{text-align:center;padding:12px 8px;margin-bottom:12px;background:#f1f5ff;border:1px solid #e0e7ff;border-radius:12px}
      #glm-simple-panel-v16 .glm-clock{font-size:30px;font-weight:800;letter-spacing:1px;color:#4338ca;font-variant-numeric:tabular-nums;font-family:"SF Mono",Consolas,"Courier New",monospace}
      #glm-simple-panel-v16 .glm-target{margin-top:4px;font-size:11px;color:#6b7280}
      #glm-simple-panel-v16 .glm-grid{display:flex;gap:8px;margin-bottom:10px}
      #glm-simple-panel-v16 .glm-fld{flex:1;display:block}
      #glm-simple-panel-v16 .glm-fld>span{display:block;font-size:11px;font-weight:600;color:#64748b;margin-bottom:4px}
      #glm-simple-panel-v16 .glm-fld select,#glm-simple-panel-v16 .glm-fld input{width:100%;padding:7px 9px;border:1px solid #d1d5db;border-radius:9px;font-size:13px;background:#fff;color:#1e293b;outline:none}
      #glm-simple-panel-v16 .glm-fld select:focus,#glm-simple-panel-v16 .glm-fld input:focus{border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,.15)}
      #glm-simple-panel-v16 .glm-fld-time{margin-bottom:12px}
      #glm-simple-panel-v16 .glm-fld-time input{font-variant-numeric:tabular-nums;letter-spacing:1px}
      #glm-simple-panel-v16 .glm-status{text-align:center;font-weight:700;font-size:12px;padding:8px;border-radius:9px;margin-bottom:10px;background:#f1f5f9;color:#64748b;transition:background .2s,color .2s}
      #glm-simple-panel-v16 .glm-status[data-state="active"]{background:#eef2ff;color:#4338ca}
      #glm-simple-panel-v16 .glm-status[data-state="info"]{background:#e0f2fe;color:#0369a1}
      #glm-simple-panel-v16 .glm-status[data-state="success"]{background:#dcfce7;color:#15803d}
      #glm-simple-panel-v16 .glm-status[data-state="danger"]{background:#fee2e2;color:#b91c1c}
      #glm-simple-panel-v16 .glm-warn{font-size:11px;font-weight:600;color:#b91c1c;background:#fee2e2;border:1px solid #fecaca;border-radius:9px;padding:7px 9px;margin-bottom:10px;line-height:1.4}
      #glm-simple-panel-v16 .glm-toggle{width:100%;padding:11px;border:none;border-radius:11px;font-size:14px;font-weight:700;cursor:pointer;color:#fff;background:linear-gradient(135deg,#4f46e5,#6366f1);transition:filter .15s,transform .15s}
      #glm-simple-panel-v16 .glm-toggle:hover{filter:brightness(1.06);transform:translateY(-1px)}
      #glm-simple-panel-v16 .glm-toggle:active{transform:translateY(0)}
      #glm-simple-panel-v16 .glm-toggle[data-mode="stop"]{background:linear-gradient(135deg,#ef4444,#f43f5e)}
      #glm-simple-panel-v16 .glm-log{margin-top:12px;max-height:96px;overflow:auto;font-size:11px;color:#475569;background:#f8fafc;border:1px solid #eef2f7;border-radius:9px;padding:7px 9px;line-height:1.5}
      #glm-simple-panel-v16 .glm-log div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #glm-simple-panel-v16 .glm-log::-webkit-scrollbar{width:6px}
      #glm-simple-panel-v16 .glm-log::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:3px}
    `;
    document.head.appendChild(s);
  }

  function buildPanel() {
    if (document.getElementById('glm-simple-panel-v16')) return;
    const panel = document.createElement('div');
    panel.id = 'glm-simple-panel-v16';
    panel.innerHTML = `
      <div class="glm-head" id="glm-simple-head-v16">
        <div class="glm-head-left">
          <span class="glm-dot" id="glm-simple-dot-v16" data-state="idle"></span>
          <span class="glm-title">GLM Coding Plan 抢购助手</span>
          <span class="glm-badge">v1.7.1</span>
        </div>
        <div class="glm-head-btns">
          <button class="glm-iconbtn" id="glm-simple-collapse-v16" type="button" title="收起 / 展开">–</button>
          <button class="glm-iconbtn glm-close" id="glm-simple-close-v16" type="button" title="关闭面板">×</button>
        </div>
      </div>
      <div class="glm-body" id="glm-simple-body-v16">
        <div class="glm-clock-wrap">
          <div class="glm-clock" id="glm-simple-countdown-v16">--:--:--</div>
          <div class="glm-target" id="glm-simple-target-v16">目标 —</div>
        </div>
        <div class="glm-grid">
          <label class="glm-fld"><span>套餐</span>
            <select id="glm-simple-plan-v16"><option value="Lite">Lite</option><option value="Pro">Pro</option><option value="Max">Max</option></select>
          </label>
          <label class="glm-fld"><span>周期</span>
            <select id="glm-simple-cycle-v16"><option value="month">连续包月</option><option value="quarter">连续包季</option><option value="year">连续包年</option></select>
          </label>
        </div>
        <label class="glm-fld glm-fld-time"><span>抢购时间（日期 时:分:秒）</span>
          <input id="glm-simple-datetime-v16" type="datetime-local" step="1">
        </label>
        <div class="glm-status" id="glm-simple-status-v16" data-state="idle">就绪</div>
        <div class="glm-warn" id="glm-simple-warn-v16" style="display:none">⚠️ 识别服务未连接，请先运行 service.py（端口 8123）</div>
        <button class="glm-toggle" id="glm-simple-toggle-v16" data-mode="start" type="button">▶ 开始监听</button>
        <div class="glm-log" id="glm-simple-log-v16"></div>
      </div>`;
    document.body.appendChild(panel);

    const planEl = document.getElementById('glm-simple-plan-v16');
    const cycleEl = document.getElementById('glm-simple-cycle-v16');
    const dtEl = document.getElementById('glm-simple-datetime-v16');

    const dtValue = () => `${config.targetDate || nextOccurrenceDateStr()}T${pad2(config.targetHour)}:${pad2(config.targetMinute)}:${pad2(config.targetSecond || 0)}`;

    planEl.value = config.targetPlan;
    cycleEl.value = config.billingCycle;
    dtEl.value = dtValue();

    planEl.addEventListener('change', () => { config.targetPlan = planEl.value; handleConfigChange(); renderCountdown(); });
    cycleEl.addEventListener('change', () => { config.billingCycle = cycleEl.value; handleConfigChange(); });
    dtEl.addEventListener('change', () => {
      const [datePart, timePart] = String(dtEl.value || '').split('T');
      config.targetDate = sanitizeDate(datePart);          // 过期/非法日期作废 → 回退"下一次"
      const tp = String(timePart || '').split(':').map(Number);
      config.targetHour = clampNumber(tp[0], 0, 23, config.targetHour);
      config.targetMinute = clampNumber(tp[1], 0, 59, config.targetMinute);
      config.targetSecond = clampNumber(tp[2], 0, 59, 0);
      dtEl.value = dtValue();                               // 回填规范化后的值
      handleConfigChange();
      renderCountdown();
    });

    document.getElementById('glm-simple-toggle-v16').addEventListener('click', () => {
      if (isWatching) stopWatching({ statusText: '已停止', logMessage: '已手动停止监听' });
      else startWatching();
    });
    document.getElementById('glm-simple-collapse-v16').addEventListener('click', () => {
      const body = document.getElementById('glm-simple-body-v16');
      const btn = document.getElementById('glm-simple-collapse-v16');
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? '' : 'none';
      btn.textContent = collapsed ? '–' : '+';
    });

    // 关闭面板（停止监听 + 移除 UI，刷新页面可恢复）
    document.getElementById('glm-simple-close-v16').addEventListener('click', () => {
      if (isWatching) stopWatching({ statusText: '已停止', logMessage: '面板关闭，已停止监听' });
      if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
      panel.remove();
    });

    // 标题栏拖动面板
    makePanelDraggable(panel, document.getElementById('glm-simple-head-v16'));

    refreshControls();
    renderCountdown();
  }

  // 拖动：按住标题栏移动面板（点按钮不触发），位置限制在视口内
  function makePanelDraggable(panel, handle) {
    if (!handle) return;
    let dragging = false, startX = 0, startY = 0, originX = 0, originY = 0;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
      panel.style.bottom = 'auto';
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      originX = rect.left; originY = rect.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const maxX = window.innerWidth - panel.offsetWidth;
      const maxY = window.innerHeight - 40;
      const nx = Math.max(0, Math.min(maxX, originX + (e.clientX - startX)));
      const ny = Math.max(0, Math.min(maxY, originY + (e.clientY - startY)));
      panel.style.left = nx + 'px';
      panel.style.top = ny + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  function bootstrap() {
    injectStyles();
    buildPanel();
    if (!countdownTimer) countdownTimer = setInterval(renderCountdown, 500);
    updateStatus('准备就绪');
    log('脚本已加载 v1.7.1（限流自动重试）');
    maybeAutoResume();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();