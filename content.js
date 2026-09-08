// 内容脚本(ISOLATED world):字幕接收、渲染、拖动。
// 字幕来源:
//   1. page-hook 拦截 YouTube 播放器自己的 timedtext 响应(主路径,自带 cookie/POT,最可靠)
//   2. 直接 fetch 字幕轨 baseUrl + fmt=json3(兜底,部分视频可能被 POT 拦截)
// 翻译:YouTube 内置机器翻译 —— 用 hook 记下的原始字幕 URL 补 tlang=zh-Hans 再请求,
//      服务端返回整条译好的中文轨,零 GPU、无外部依赖。
'use strict';

let settings = null;
let state = null; // 当前视频的字幕状态

const POLL_INTERVAL = 100;   // 渲染循环间隔 ms
const SCRAPE_RETRY = 4;      // 主动抓取字幕轨重试次数
const DBG_ON = false;        // 排障开关:改 true 后日志进 window.__ybsLog(500 条环形),CDP/控制台可查
const DBG = (...a) => {
  if (!DBG_ON) return;
  try {
    (window.__ybsLog = window.__ybsLog || []).push(Date.now() % 100000 + ' ' + a.join(' '));
    if (window.__ybsLog.length > 500) window.__ybsLog.shift();
  } catch { /* 忽略 */ }
};

// ---------------- 字幕状态 ----------------

function newState(videoId) {
  return {
    videoId,
    segs: [],            // [{start, dur, text, zh, fbTried}] 按 start 升序
    keys: new Set(),     // 去重:round(start*1000)|text
    langName: null,      // 当前音轨语言(用于避免重复提交)
    langSwitched: false, // 是否已因非英文轨道切换过
    isAsr: false,        // 自动生成字幕轨(滚动碎片,渲染前重组整句)
    lines: [],           // 渲染用行:非 ASR 即 segs;ASR 为重组后的整句
    linesDirty: false,
    ytZhTried: false,    // 内置翻译是否已请求过(每视频一次)
    zhByKey: new Map(),  // 内置翻译:ms 时间点 -> 中文
    fallbackActive: false, // tlang 失败 → Google 免费端点兜底
    fbInflight: false,   // 兜底批次请求中
    scrapeTried: false,
    activeIdx: -1,
  };
}

function resetForVideo(videoId) {
  if (state && state.videoId === videoId) return;
  state = newState(videoId);
  // 跳广告状态跨视频复位(lastContentT 是上一个视频的进度,不能带到新视频)
  adSkip.lastContentT = 0;
  updateOverlayVisibility();
}

// ---------------- 字幕接收 ----------------

function mergeSegs(list, meta) {
  if (!state || !Array.isArray(list)) return 0;
  let added = 0;
  for (const s of list) {
    if (!s || typeof s.start !== 'number') continue;
    const text = String(s.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const key = Math.round(s.start * 1000) + '|' + text;
    if (state.keys.has(key)) continue;
    state.keys.add(key);
    // 合并过近的重复行(不同起始时间的相同内容,某些音轨会出现)
    const prev = state.segs[state.segs.length - 1];
    if (prev && prev.text === text && Math.abs(prev.start - s.start) < 0.05) continue;
    state.segs.push({ start: s.start, dur: s.dur || 2.5, text, zh: null, fbTried: false });
    added++;
  }
  if (added) {
    state.segs.sort((a, b) => a.start - b.start);
    if (meta && meta.kind) state.isAsr = meta.kind === 'asr';
    state.linesDirty = true;
  }
  return added;
}

// ---------------- ASR 整句重组 ----------------

// ASR 轨的滚动机制:新碎片出现时,旧碎片行时长被截断。用这个恢复"完整句占位"的原时长。
const ASR_MIN_HOLD = 2.2;   // 每碎片在屏时间:滚动链上一行被截断后的真实占位
const ASR_MAX_HOLD = 6.0;   // 完整句兜底上限

// 把 ASR 滚动碎片重组为整句:检测"旧行是新行前缀"的滚动链,链尾即完整句。
// 返回 [{start, dur, text}],时间轴由碎片占位推导。
function rebuildAsrLines(segs) {
  if (!segs.length) return [];
  const out = [];
  let chain = [segs[0]]; // 当前滚动链
  const flush = () => {
    if (!chain.length) return;
    const last = chain[chain.length - 1];
    const first = chain[0];
    // 完整句文本 = 链尾;译文也取链尾(最完整一条)的,经 segRef 引用,译文后到自动生效
    out.push({ start: first.start, text: last.text, segRef: last });
    chain = [];
  };
  for (let i = 1; i < segs.length; i++) {
    const prev = chain[chain.length - 1];
    const cur = segs[i];
    const growing = cur.text.startsWith(prev.text) || prev.text.startsWith(cur.text);
    if (growing && cur.start - prev.start < 4) {
      if (!cur.text.startsWith(prev.text)) {
        // 罕见:新碎片反而变短(识别修正),把当前链定稿,重新开链
        flush();
        chain = [cur];
      } else {
        chain.push(cur);
      }
    } else {
      flush();
      chain = [cur];
    }
  }
  flush();
  // 时间轴:每句从它的起点显示到下一句起点(上限兜底),但至少 ASR_MIN_HOLD
  for (let i = 0; i < out.length; i++) {
    const nextStart = i + 1 < out.length ? out[i + 1].start : out[i].start + ASR_MAX_HOLD;
    out[i].dur = Math.min(ASR_MAX_HOLD, Math.max(ASR_MIN_HOLD, nextStart - out[i].start));
  }
  return out;
}

// 渲染行缓存:非 ASR 直接用 segs,ASR 用重组结果(每次 segs 变化后重建)
function getRenderLines() {
  if (!state.linesDirty) return state.lines;
  if (state.isAsr) {
    state.lines = rebuildAsrLines(state.segs);
  } else {
    state.lines = state.segs;
  }
  state.linesDirty = false;
  return state.lines;
}

// ---------------- YouTube 内置翻译(默认引擎,零 GPU) ----------------

// 内置翻译轨的时间点和原轨一致;允许 ±600ms 的模糊对齐,防止个别行时间戳漂移
function lookupYtZh(startSec) {
  const ms = Math.round(startSec * 1000);
  if (state.zhByKey.has(ms)) return state.zhByKey.get(ms);
  for (const delta of [100, -100, 200, -200, 300, -300, 400, -400, 500, -500, 600, -600]) {
    if (state.zhByKey.has(ms + delta)) return state.zhByKey.get(ms + delta);
  }
  return null;
}

function parseJson3InContent(data) {
  const segs = [];
  try {
    for (const ev of (data && data.events) || []) {
      if (!ev || !Array.isArray(ev.segs)) continue;
      const text = ev.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      if (!text || text === '\n') continue;
      segs.push({ startMs: ev.tStartMs || 0, text });
    }
  } catch { /* 忽略坏行 */ }
  return segs;
}

async function fetchYtTranslation(baseUrl, st) {
  try {
    const joiner = baseUrl.includes('?') ? '&' : '?';
    const resp = await fetch(baseUrl + joiner + 'tlang=zh-Hans', { credentials: 'include' });
    const body = await resp.text();
    if (resp.status !== 200 || !body.trim().startsWith('{')) throw new Error('tlang HTTP ' + resp.status);
    const rows = parseJson3InContent(JSON.parse(body));
    if (!rows.length) throw new Error('tlang empty');
    DBG('tlang ok,', rows.length, '行');
    for (const r of rows) st.zhByKey.set(r.startMs, r.text);
    // 回填已存在的行(ASR 重组行经 segRef 引用碎片,译文写入碎片即生效)
    for (const seg of st.segs) {
      if (!seg.zh) {
        const prevState = state;
        state = st; // lookupYtZh 读全局 state
        const zh = lookupYtZh(seg.start);
        state = prevState;
        if (zh) seg.zh = zh;
      }
    }
    updateOverlayVisibility();
  } catch (e) {
    // tlang 拿不到(PO Token 风控等)→ Google 免费端点兜底(经 background 代发)
    DBG('tlang 失败:', e && e.message, '→ 备用翻译');
    st.fallbackActive = true;
    setBadge(true, '内置翻译不可用,使用备用翻译');
  }
}

// ---------------- 备用翻译窗口(Google 免费端点,惰性按需) ----------------

const FB_LOOKAHEAD = 40;   // 播放位置前方保持多少行有译文
const FB_CHUNK = 20;       // 每次请求携带多少行(URL 长度与限速平衡)
const FB_TICK = 700;

setInterval(() => {
  try {
    if (!settings || !settings.enabled || !state || !state.fallbackActive) return;
    if (!state.segs.length || state.fbInflight) return;
    const video = getVideo();
    const t = video ? video.currentTime : 0;
    const lines = getRenderLines();
    const idx = findCurrentIdx(lines, t);
    const anchor = idx >= 0 ? idx : 0;
    const from = Math.max(0, anchor - 2);
    const to = Math.min(state.segs.length, anchor + FB_LOOKAHEAD);
    const batch = [];
    for (let i = from; i < to && batch.length < FB_CHUNK; i++) {
      const s = state.segs[i];
      if (!s.zh && !s.fbTried) { s.fbTried = true; batch.push(s); }
    }
    if (!batch.length) return;
    state.fbInflight = true;
    chrome.runtime.sendMessage({ type: 'google-translate', texts: batch.map((s) => s.text) }, (resp) => {
      state.fbInflight = false;
      if (!chrome.runtime.lastError && resp && resp.ok) {
        for (let k = 0; k < batch.length; k++) batch[k].zh = resp.translations[k];
        setBadge(false);
      } else {
        // 整批失败:解除标记,下一轮重试
        for (const s of batch) s.fbTried = false;
      }
    });
  } catch { /* 循环绝不抛错 */ }
}, FB_TICK);

// page-hook(MAIN world)通过 window CustomEvent 桥接消息
window.addEventListener('__yt_bs_bridge', (ev) => {
  let msg = null;
  try { msg = JSON.parse(ev.detail); } catch { return; }
  if (!msg) return;
  if (msg.type === 'captions') {
    // payload: { segs: [{start,dur,text}], meta: {lang, kind, tlang, url} }
    // 广告播放中:广告字幕与正片时间轴冲突,直接丢弃
    const mpNow = document.getElementById('movie_player');
    if (mpNow && mpNow.classList.contains('ad-showing')) return;
    const payload = msg.payload || {};
    const segs = Array.isArray(payload) ? payload : payload.segs;
    const meta = payload.meta || {};
    if (mergeSegs(segs, meta) > 0) {
      state.scrapeTried = true;
      DBG('captions +', state.segs.length, 'asr=' + state.isAsr, 'lang=' + (meta.lang || '?'), 'kind=' + (meta.kind || '?'));
      // 轨道语言检查:不是英文轨时切到英文轨(每视频只切一次,切后清空旧轨字幕防止串台)
      const lang = (meta.lang || '').toLowerCase();
      if (lang && !lang.startsWith('en') && !state.langSwitched) {
        state.langSwitched = true;
        state.segs = [];
        state.keys = new Set();
        state.zhByKey = new Map();
        state.lines = [];
        state.linesDirty = true;
        state.isAsr = false;
        mainWorldCall('setCaptionTrack', { languageCode: 'en' }).catch(() => {});
        return;
      }
      // 内置翻译:hook 记住原始 URL 后,请求 tlang=zh-Hans 的翻译轨(零 GPU,无外部依赖)
      if (!state.ytZhTried && !meta.tlang && meta.url) {
        state.ytZhTried = true;
        fetchYtTranslation(meta.url, state);
      }
    }
  }
});

// ---------------- 主动抓取(兜底) ----------------

async function scrapeCaptionTrack() {
  if (!state || state.scrapeTried || !state.videoId) return;
  state.scrapeTried = true;
  // MAIN world 读 window.ytInitialPlayerResponse 拿 captionTracks
  const tracks = await mainWorldCall('getPlayerResponse').catch(() => null);
  if (!tracks || !Array.isArray(tracks.captionTracks) || !tracks.captionTracks.length) return;
  // 选轨:英文字幕优先(手工 > 自动),其次任何非中文轨
  const scored = tracks.captionTracks
    .filter((t) => t && t.baseUrl)
    .map((t) => {
      const lang = (t.languageCode || '').toLowerCase();
      const asr = t.kind === 'asr';
      let score = 9;
      if (lang.startsWith('en') && !asr) score = 0;
      else if (lang.startsWith('en')) score = 1;
      else if (!lang.startsWith('zh') && !asr) score = 2;
      else if (!lang.startsWith('zh')) score = 3;
      return { t, score, lang };
    })
    .sort((a, b) => a.score - b.score);
  if (!scored.length) return;
  const pick = scored[0];
  state.langName = pick.lang;
  try {
    const url = pick.t.baseUrl + (pick.t.baseUrl.includes('fmt=') ? '' : '&fmt=json3');
    const resp = await fetch(url, { credentials: 'include' });
    const body = await resp.text();
    if (!body || resp.status !== 200) return;
    const data = JSON.parse(body);
    const segs = [];
    for (const ev of data.events || []) {
      if (!ev.segs) continue;
      const text = ev.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      if (!text || text === '\n') continue;
      segs.push({ start: (ev.tStartMs || 0) / 1000, dur: (ev.dDurationMs || 2000) / 1000, text });
    }
    mergeSegs(segs, { lang: pick.lang, kind: pick.t.kind || 'manual' });
  } catch { /* 静默:主路径 hook 还在 */ }
}

// ---------------- MAIN world 桥(ISOLATED -> MAIN) ----------------

const mainWorldPending = new Map();
let mainWorldSeq = 0;

window.addEventListener('__yt_bs_ctrl_resp', (ev) => {
  let msg = null;
  try { msg = JSON.parse(ev.detail); } catch { return; }
  if (msg && mainWorldPending.has(msg.seq)) {
    const { resolve } = mainWorldPending.get(msg.seq);
    mainWorldPending.delete(msg.seq);
    resolve(msg.payload);
  }
});

function mainWorldCall(action, arg) {
  return new Promise((resolve, reject) => {
    const seq = ++mainWorldSeq;
    mainWorldPending.set(seq, { resolve, reject });
    window.dispatchEvent(new CustomEvent('__yt_bs_ctrl', {
      detail: JSON.stringify({ seq, action, arg }),
    }));
    setTimeout(() => {
      if (mainWorldPending.has(seq)) {
        mainWorldPending.delete(seq);
        reject(new Error('main world timeout: ' + action));
      }
    }, 3000);
  });
}

// ---------------- 时间轴 ----------------

function findCurrentIdx(lines, t) {
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].start <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

// ---------------- 跳广告 ----------------

// 原理:广告开始时把广告 video 元素的播放时间设到越界,播放器视为广告放完,自动回到正片。
// 实测注意:广告期间播放器 getAdState() 仍返回 -1(不可靠),唯一权威信号是 player 的 ad-showing 类;
// 广告期间 video.currentTime 是广告自己的时间轴,正片进度在非广告期持续记录(lastContentT)。
const adSkip = {
  lastContentT: 0,     // 非广告期记录的正片播放位置
  clickedSkip: false,  // 本条广告已点过原生"跳过"按钮
  skipGoneAt: 0,       // 跳过按钮消失的时刻(套装广告 2/2 逐段点击用)
  seekMode: false,     // 本条广告 12s 没等到跳过按钮,被迫用 seek(强插广告兜底)
  windowStart: 0,      // 本条广告的开始时刻
};

// 广告窗口 12 秒;YouTube 的"跳过"按钮本身也要约 5 秒才出现,窗口必须盖住它
const AD_SEEK_WINDOW_MS = 12000;

// 有原生"跳过"按钮就直接点它(零延迟,等同用户手点,对 5 秒锁定的广告最有效)
function clickNativeSkipButton() {
  const btn = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern');
  if (btn && btn.offsetParent !== null) {
    btn.click();
    return true;
  }
  return false;
}

// 策略:出现过跳过按钮的广告只走按钮(YouTube 自己处理恢复,位置永远正确);
// seek 只留给 12 秒都没等到按钮的强插广告(此时别无选择,风险可接受)。
function handleAd(video) {
  if (!settings.skipAds) return;
  if (adSkip.windowStart === 0) {
    adSkip.windowStart = Date.now();
    adSkip.clickedSkip = false;
    adSkip.seekMode = false;
    adSkip.skipGoneAt = 0;
  }
  // 优先点原生跳过按钮(出现即点,不等待)
  if (clickNativeSkipButton()) {
    adSkip.clickedSkip = true;
    adSkip.skipGoneAt = 0;
    return;
  }
  if (adSkip.clickedSkip) {
    // 套装广告(2/2):点完按钮后按钮消失;超 1.5s 仍未出现下一条按钮且还在广告态,
    // 视为下一条开始,重置以准备再点
    const btn = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern');
    if (btn && btn.offsetParent !== null) {
      adSkip.skipGoneAt = 0;
    } else if (!adSkip.skipGoneAt) {
      adSkip.skipGoneAt = Date.now();
    } else if (Date.now() - adSkip.skipGoneAt > 1500) {
      adSkip.clickedSkip = false;
      adSkip.skipGoneAt = 0;
      adSkip.windowStart = Date.now(); // 下一条重新计时
    }
    return;
  }
  // 还没点到过按钮:先等 12s 窗口(按钮可能随时出现,期间绝不 seek ——
  // seek 会破坏 YouTube 自己的恢复逻辑,导致正片回到错误位置,实测)
  if (Date.now() - adSkip.windowStart < AD_SEEK_WINDOW_MS) return;
  // 12s 仍无按钮(强插广告,不可跳):seek 越界兜底。此时标记 seekMode,
  // 渲染循环在广告消失时不再做任何恢复(seek 模式下恢复由播放器自己完成)
  adSkip.seekMode = true;
  const dur = isFinite(video.duration) ? video.duration : 0;
  if (dur <= 0 || dur > 600) return; // 时长不像广告,宁可不跳
  mainWorldCall('seekTo', dur + 5).catch(() => {});
}

// ---------------- 渲染 ----------------

function getVideo() {
  return document.querySelector('#movie_player video.html5-main-video') ||
         document.querySelector('video.html5-main-video') ||
         document.querySelector('#movie_player video');
}

function getPlayer() {
  return document.getElementById('movie_player');
}

let overlay = null;

function ensureOverlay() {
  const player = getPlayer();
  if (!player) return null;
  if (overlay && overlay.isConnected && overlay.parentElement === player) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'yt-bs-overlay';
  // 初始隐藏:创建到首个字幕渲染之间不能露出空字幕框
  overlay.className = 'yt-bs-draggable yt-bs-hidden';
  overlay.innerHTML =
    '<span class="yt-bs-badge">翻译中</span>' +
    '<span class="yt-bs-en"></span>' +
    '<span class="yt-bs-zh"></span>';
  player.appendChild(overlay);
  setupDrag(overlay);
  applyOverlayPos(overlay);
  return overlay;
}

// 拖动保存的位置(百分比)应用到字幕条
function applyOverlayPos(o) {
  if (posCache) {
    o.style.left = posCache.x + '%';
    o.style.bottom = posCache.y + '%';
  }
}

function setBadge(show, text) {
  if (!overlay) return;
  overlay.classList.toggle('yt-bs-loading', !!show);
  const badge = overlay.querySelector('.yt-bs-badge');
  if (badge && text) badge.textContent = text;
}

function updateOverlayVisibility() {
  if (!overlay) return;
  const on = settings && settings.enabled && state && state.segs.length > 0;
  overlay.classList.toggle('yt-bs-hidden', !on);
}

let lastRenderKey = '';

function renderLoop() {
  try {
    if (!settings) return;
    const video = getVideo();
    if (!video) return;
    const player = getPlayer();
    if (!player || !state) return;
    const o = ensureOverlay();
    if (!o) return;
    // 隐藏原生字幕
    player.classList.toggle('ybs-hide-native', !!(settings.enabled && settings.hideNativeCC));

    // 广告:隐藏双语字幕 + 自动快进跳过
    if (player.classList.contains('ad-showing')) {
      o.classList.add('yt-bs-hidden');
      lastRenderKey = '';
      handleAd(video); // 同步,渲染循环自带 100ms 节奏
      return;
    }
    const t = video.currentTime;
    adSkip.lastContentT = t; // 非广告期持续记录正片进度
    if (adSkip.windowStart !== 0) {
      // 刚离开广告:复位全部状态。按钮模式(常见)下 YouTube 自己恢复位置,
      // 不做任何 seek/恢复干预;仅当之前是暂停态且非 seek 兜底时,补一次自动播放
      const wasSeekMode = adSkip.seekMode;
      adSkip.windowStart = 0;
      adSkip.clickedSkip = false;
      adSkip.seekMode = false;
      adSkip.skipGoneAt = 0;
      if (!wasSeekMode && video.paused) {
        const playPromise = video.play();
        if (playPromise && playPromise.catch) playPromise.catch(() => {});
      }
    }

    if (!settings.enabled || !state.segs.length) { updateOverlayVisibility(); return; }

    const lines = getRenderLines();
    const idx = findCurrentIdx(lines, t);
    state.activeIdx = idx;
    let show = null;
    if (idx >= 0) {
      const s = lines[idx];
      if (t <= s.start + s.dur + 0.7) show = s; // 字幕结束后多留 0.7s,观感更稳
    }
    o.style.fontSize = (settings.fontSize || 24) + 'px';
    if (!show) {
      if (lastRenderKey !== '') { DBG('hide: t=' + t.toFixed(1) + ' 无活动行(idx=' + idx + ')'); o.classList.add('yt-bs-hidden'); lastRenderKey = ''; }
      return;
    }
    const zhVal = show.segRef ? show.segRef.zh : show.zh;
    const key = Math.round(show.start * 1000) + '|' + (zhVal || '');
    if (key === lastRenderKey) return;
    lastRenderKey = key;
    DBG('show: t=' + t.toFixed(1) + ' "' + show.text.slice(0, 30) + '" zh=' + (zhVal ? 'Y' : 'N'));
    o.classList.remove('yt-bs-hidden');
    const en = o.querySelector('.yt-bs-en');
    const zh = o.querySelector('.yt-bs-zh');
    en.style.display = settings.showOriginal ? '' : 'none';
    en.textContent = show.text;
    if (zhVal) {
      zh.textContent = zhVal;
      zh.classList.remove('yt-bs-pending');
    } else {
      zh.textContent = show.text;
      zh.classList.add('yt-bs-pending');
    }
    // 位置(拖动保存的百分比)
    applyOverlayPos(o);
  } catch (e) {
    DBG('render 错误:', e && e.message);
  }
}

setInterval(renderLoop, POLL_INTERVAL);

// ---------------- 拖动 ----------------

let posCache = null;

function setupDrag(el) {
  let dragging = false, startX = 0, startY = 0, startPos = null;
  el.addEventListener('mousedown', (e) => {
    if (!settings || !settings.enabled) return;
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    startPos = posCache || { x: 50, y: 12 };
    el.classList.add('yt-bs-dragging');
    e.preventDefault(); // 防止选中文字
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const player = getPlayer();
    if (!player) return;
    const rect = player.getBoundingClientRect();
    const dx = ((e.clientX - startX) / rect.width) * 100;
    const dy = ((e.clientY - startY) / rect.height) * 100;
    posCache = {
      x: Math.min(88, Math.max(12, startPos.x + dx)),
      y: Math.min(80, Math.max(2, startPos.y - dy)),
    };
    el.style.left = posCache.x + '%';
    el.style.bottom = posCache.y + '%';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('yt-bs-dragging');
    if (posCache) chrome.storage.local.set({ overlayPos: posCache });
  });
}

chrome.storage.local.get(['overlayPos'], (r) => {
  posCache = (r && r.overlayPos) || null;
  if (overlay) applyOverlayPos(overlay); // storage 晚于首次渲染时补上位置
});

// ---------------- 自动开启 CC ----------------

async function autoEnableCC() {
  if (!settings || !settings.enabled || !settings.autoEnableCC) return;
  for (let i = 0; i < 10; i++) {
    const btn = document.querySelector('.ytp-subtitles-button');
    if (btn && btn.style.display !== 'none') {
      if (btn.getAttribute('aria-pressed') === 'false') btn.click();
      return;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
}

// ---------------- 视频切换 ----------------

function onNavigate() {
  const vid = bsGetVideoId();
  if (!vid) {
    if (state) { state = null; updateOverlayVisibility(); }
    return;
  }
  if (state && state.videoId === vid) return;
  resetForVideo(vid);
  // 重新抓取:先 hook(被动),2.5s 后还没数据就主动抓
  setTimeout(() => { if (state && state.segs.length === 0) scrapeCaptionTrack(); }, 2500);
  setTimeout(() => { if (state && state.segs.length === 0) scrapeCaptionTrack(); }, 6000);
  autoEnableCC();
  // 兜底重试主动抓取(POT 偶发失败)
  let retries = 0;
  const timer = setInterval(() => {
    retries++;
    if (!state || state.videoId !== vid) { clearInterval(timer); return; }
    if (state.segs.length > 0 || retries >= SCRAPE_RETRY) { clearInterval(timer); return; }
    state.scrapeTried = false;
    scrapeCaptionTrack();
  }, 5000);
}

// yt-navigate-finish 是 YouTube SPA 导航完成事件
document.addEventListener('yt-navigate-finish', () => setTimeout(onNavigate, 300));
// 首次加载
setTimeout(onNavigate, 1200);
setTimeout(onNavigate, 3000); // 播放器就绪慢时的兜底

// ---------------- 初始化 ----------------

(async () => {
  settings = await bsLoadSettings();
  bsOnSettingsChanged((s) => {
    settings = Object.assign({}, BS_SETTINGS_DEFAULTS, s);
    updateOverlayVisibility();
  });
  onNavigate();
})();

// html 级 class 控制原生字幕显隐(overlay.css 需要配合 content.js 动态注入?不用,直接写 style)
const nativeStyle = document.createElement('style');
nativeStyle.textContent = '.html5-video-player.ybs-hide-native .ytp-caption-window-container{display:none!important}';
document.documentElement.appendChild(nativeStyle);
