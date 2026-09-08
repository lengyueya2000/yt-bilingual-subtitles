// popup 设置页逻辑
'use strict';

const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  enabled: true, showOriginal: true, hideNativeCC: true, autoEnableCC: true, skipAds: true, fontSize: 24,
};

async function load() {
  const s = await new Promise((r) => chrome.storage.local.get(['settings'], (v) => r(v)));
  const settings = Object.assign({}, DEFAULTS, (s && s.settings) || {});
  $('enabled').checked = settings.enabled;
  $('showOriginal').checked = settings.showOriginal;
  $('hideNativeCC').checked = settings.hideNativeCC;
  $('autoEnableCC').checked = settings.autoEnableCC;
  $('skipAds').checked = settings.skipAds;
  $('fontSize').value = settings.fontSize;
}

function save() {
  const settings = {
    enabled: $('enabled').checked,
    showOriginal: $('showOriginal').checked,
    hideNativeCC: $('hideNativeCC').checked,
    autoEnableCC: $('autoEnableCC').checked,
    skipAds: $('skipAds').checked,
    fontSize: parseInt($('fontSize').value, 10) || 24,
  };
  chrome.storage.local.set({ settings });
}

for (const id of ['enabled', 'showOriginal', 'hideNativeCC', 'autoEnableCC', 'skipAds']) {
  $(id).addEventListener('change', save);
}
$('fontSize').addEventListener('input', save);

$('resetPosBtn').addEventListener('click', () => {
  chrome.storage.local.remove(['overlayPos'], () => {
    $('status').textContent = '字幕位置已重置,刷新视频页生效。';
  });
});

load();
