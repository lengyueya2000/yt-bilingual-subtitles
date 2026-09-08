// 公共工具:设置读写、事件桥常量(ISOLATED world 与 background 共用)
'use strict';

const BS_SETTINGS_DEFAULTS = {
  enabled: true,
  showOriginal: true,     // 显示英文原文行
  hideNativeCC: true,     // 隐藏 YouTube 原生 CC 字幕
  autoEnableCC: true,     // 自动帮用户点亮 CC 按钮
  skipAds: true,          // 自动快进跳过广告
  fontSize: 24,           // 中文字号 px
};

const BS_EVENT_BRIDGE = '__yt_bs_bridge';   // MAIN -> ISOLATED
const BS_EVENT_CTRL = '__yt_bs_ctrl';       // ISOLATED -> MAIN

// 合并默认设置(chrome.storage 里没有的字段用默认值补齐)
async function bsLoadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['settings'], (r) => {
      resolve(Object.assign({}, BS_SETTINGS_DEFAULTS, (r && r.settings) || {}));
    });
  });
}

function bsSaveSettings(settings) {
  return new Promise((resolve) => chrome.storage.local.set({ settings }, resolve));
}

// 监听设置变化(任意上下文都能用)
function bsOnSettingsChanged(cb) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) cb(changes.settings.newValue || {});
  });
}

// 解析当前页面是否是视频页,返回 videoId 或 null(支持 watch 和 shorts)
function bsGetVideoId() {
  try {
    const u = new URL(location.href);
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = u.pathname.match(/^\/shorts\/([^/?#]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
