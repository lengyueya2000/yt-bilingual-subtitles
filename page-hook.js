// 注入到页面 MAIN world(document_start):在 YouTube 播放器自身的 fetch/XHR 之前挂钩,
// 截获 timedtext 字幕请求的响应(YouTube 原生英文字幕轨)。
// 字幕请求发生在页面自己的 JS 上下文里,隔离 world 拦不到,必须提前进 MAIN。
(() => {
  'use strict';
  if (window.__ytBsHooked) return;
  window.__ytBsHooked = true;

  const post = (type, payload) => {
    window.dispatchEvent(new CustomEvent('__yt_bs_bridge', { detail: JSON.stringify({ type, payload }) }));
  };

  const isTimedtext = (url) => {
    if (typeof url !== 'string') return false;
    try {
      const u = new URL(url, location.origin);
      return (
        u.pathname.startsWith('/api/timedtext') ||
        (u.pathname.includes('/timedtext') && u.searchParams.get('v'))
      );
    } catch {
      return false;
    }
  };

  // 把 json3 格式的响应体简化成 [{start, dur, text}] 再转发
  const parseJson3 = (data) => {
    try {
      const events = (data && Array.isArray(data.events)) ? data.events : [];
      const segs = [];
      for (const ev of events) {
        if (!ev || !Array.isArray(ev.segs)) continue;
        const text = ev.segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
        if (!text || text === '\n') continue;
        segs.push({ start: (ev.tStartMs || 0) / 1000, dur: (ev.dDurationMs || 2000) / 1000, text });
      }
      return segs;
    } catch {
      return null;
    }
  };

  // srv3/XML 解析兜底
  const parseXml = (body) => {
    try {
      const doc = new DOMParser().parseFromString(body, 'text/xml');
      const nodes = doc.querySelectorAll('text');
      const segs = [];
      for (const n of nodes) {
        const text = (n.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        segs.push({
          start: parseFloat(n.getAttribute('start') || '0'),
          dur: parseFloat(n.getAttribute('dur') || '2'),
          text,
        });
      }
      return segs;
    } catch {
      return null;
    }
  };

  const parseBody = (body) => {
    const t = body.trimStart()[0];
    if (t === '{') return parseJson3(JSON.parse(body));
    if (t === '<') return parseXml(body);
    return null;
  };

  // 缓存最近一次字幕响应:content.js 晚于播放器初始化,用回放补发
  // meta: 从请求 URL 提取 lang/kind/url,轨道语言纠偏和 YouTube 内置翻译(tlang)都要用原始 URL
  let lastPayload = null;
  let lastMeta = null;
  const metaFromUrl = (url) => {
    try {
      const u = new URL(url, location.origin);
      return {
        lang: u.searchParams.get('lang') || null,
        kind: u.searchParams.get('kind') || null,
        tlang: u.searchParams.get('tlang') || null,
        url,
      };
    } catch {
      return { lang: null, kind: null, tlang: null, url };
    }
  };
  const noteTimedtext = (body, url) => {
    try {
      const segs = parseBody(body);
      if (segs && segs.length) {
        lastPayload = segs;
        lastMeta = metaFromUrl(url);
        post('captions', { segs, meta: lastMeta });
      }
    } catch { /* 不影响原请求 */ }
  };

  // ---------- hook fetch ----------
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = async function (...args) {
      const resp = await origFetch.apply(this, args);
      try {
        const url = (typeof args[0] === 'string') ? args[0] : (args[0] && args[0].url) || '';
        if (isTimedtext(url)) {
          const clone = resp.clone();
          clone.text().then((b) => noteTimedtext(b, url)).catch(() => {});
        }
      } catch { /* 不影响原请求 */ }
      return resp;
    };
  }

  // ---------- hook XHR ----------
  const OrigOpen = XMLHttpRequest.prototype.open;
  const OrigSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ytBsUrl = url;
    return OrigOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      try {
        if (!isTimedtext(this.__ytBsUrl)) return;
        if (this.responseType && this.responseType !== 'text') return;
        if (this.responseText) noteTimedtext(this.responseText, this.__ytBsUrl);
      } catch { /* 不影响原请求 */ }
    });
    return OrigSend.apply(this, args);
  };

  // ---------- ISOLATED world 控制通道 ----------
  window.addEventListener('__yt_bs_ctrl', (ev) => {
    let msg = null;
    try { msg = JSON.parse(ev.detail); } catch { return; }
    if (!msg) return;
    let payload = null;
    if (msg.action === 'replayCaptions') {
      payload = lastPayload;
      if (payload && lastMeta) post('captions', { segs: payload, meta: lastMeta }); // 直接补发,不再等轮询
    } else if (msg.action === 'getPlayerResponse') {
      try {
        const pr = window.ytInitialPlayerResponse;
        const list = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer &&
          pr.captions.playerCaptionsTracklistRenderer.captionTracks;
        payload = list ? { captionTracks: list } : { captionTracks: [] };
      } catch { payload = { captionTracks: [] }; }
    } else if (msg.action === 'setCaptionTrack') {
      try {
        const mp = document.getElementById('movie_player');
        payload = { ok: !!mp && typeof mp.setOption === 'function' };
        if (payload.ok) mp.setOption('captions', 'track', msg.arg || {});
      } catch { payload = { ok: false }; }
    } else if (msg.action === 'seekTo') {
      // 跳广告用:直接设置 video 元素时间(广告期间播放器 API 的 seekTo 会被忽略/截断,
      // 而把广告 video 元素设越界会触发广告完成事件,播放器自动回到正片)
      try {
        // 执行时刻三重校验,防止 seek 落到正片上(类名消失晚于视频源切换,单看类名不够):
        // 1. ad-showing 仍在;2. video 时长是广告体量(<=600s,正片漏进来时拒绝);
        // 3. 目标不超过该条广告末尾 +10s
        const mpNow = document.getElementById('movie_player');
        const stillAd = mpNow && mpNow.classList && mpNow.classList.contains('ad-showing');
        const v = stillAd ? document.querySelector('video.html5-main-video') : null;
        if (v && isFinite(msg.arg)) {
          v.currentTime = msg.arg;
          payload = { ok: true };
        } else {
          payload = { ok: false, guarded: true };
        }
      } catch { payload = { ok: false }; }
    }
    window.dispatchEvent(new CustomEvent('__yt_bs_ctrl_resp', {
      detail: JSON.stringify({ seq: msg.seq, payload }),
    }));
  });
})();
