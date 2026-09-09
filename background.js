// 后台 Service Worker:仅一件事 —— tlang 整轨翻译被风控时,用 Google 翻译免费端点兜底。
// content script 页面上下文受 CORS 限制,必须由扩展上下文代发。
'use strict';

// 两个免费端点互为备份(不同服务,风控策略不同);dict-chrome-ex 是 Chrome 自带页面翻译用的,最宽松
async function gtFetch(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// 受信任点击:合成 DOM 事件对 YouTube 跳过按钮无效(isTrusted=false 被忽略),
// 唯一可靠方案是 chrome.debugger 派发真实输入事件(与用户手点同源)。
// attach → 点击 → detach 数百毫秒完成;需要 manifest 声明 "debugger" 权限。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'trusted-click' && Number.isFinite(msg.x) && Number.isFinite(msg.y)) {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) {
      sendResponse({ ok: false, error: 'no tab' });
      return;
    }
    (async () => {
      const target = { tabId };
      try {
        await chrome.debugger.attach(target, '1.3');
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x: msg.x, y: msg.y, button: 'left', clickCount: 1,
        });
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: msg.x, y: msg.y, button: 'left', clickCount: 1,
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      } finally {
        try { await chrome.debugger.detach(target); } catch { /* 已分离 */ }
      }
    })().then(sendResponse);
    return true;
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'google-translate' && Array.isArray(msg.texts)) {
    (async () => {
      const texts = msg.texts.map((t) => String(t || ''));
      const params = new URLSearchParams();
      for (const t of texts) params.append('q', t);
      params.set('sl', 'auto');
      params.set('tl', 'zh-CN');
      const qs = params.toString();
      let data = null;
      for (const base of [
        'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&',
        'https://translate.googleapis.com/translate_a/t?client=gtx&',
      ]) {
        try {
          data = await gtFetch(base + qs);
          if (data) break;
        } catch (e) { /* 换下一个端点 */ }
      }
      if (!data) return { ok: false, error: 'all endpoints failed' };
      // 响应格式(实测):单条 ["译文"] 或 [["译文","src"],...](与 q 一一对应)
      let out = [];
      if (typeof data === 'string') {
        out = [data];
      } else if (Array.isArray(data) && typeof data[0] === 'string') {
        out = data; // ["译1","译2",...](gtx 变体)
      } else if (Array.isArray(data)) {
        out = data.map((x) => (Array.isArray(x) ? x[0] : (x && x.trans) || null));
      }
      while (out.length < texts.length) out.push(null);
      const translations = texts.map((t, i) => out[i] || t); // 个别行失败显示原文
      return { ok: true, translations };
    })().then(sendResponse);
    return true; // async sendResponse
  }
});
