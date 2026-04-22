/* global chrome */
'use strict';

// Maps element ID → [platform, settingKey]
const CONTROLS = {
  'cobalt-api-key':    ['cobalt',    'apiKey'],
  'cobalt-instance-url': ['cobalt', 'instanceUrl'],
  'yt-video-quality':  ['youtube',   'videoQuality'],
  'yt-audio-quality':  ['youtube',   'audioQuality'],
  'fb-video-quality':  ['facebook',  'videoQuality'],
  'tt-watermark':      ['tiktok',    'watermark'],
};

async function loadSettings() {
  const settings = await chrome.storage.sync.get(null);
  for (const [id, [platform, key]] of Object.entries(CONTROLS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const value = settings?.[platform]?.[key];
    if (value === undefined) continue;
    if (el.type === 'checkbox') el.checked = Boolean(value);
    else el.value = String(value);
  }
}

async function saveSettings() {
  const current = await chrome.storage.sync.get(null);

  for (const [id, [platform, key]] of Object.entries(CONTROLS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (!current[platform]) current[platform] = {};
    current[platform][key] = el.type === 'checkbox' ? el.checked : el.value;
  }

  await chrome.storage.sync.set(current);
  showSaved();
}

function showSaved() {
  const el = document.getElementById('save-feedback');
  el.textContent = 'Settings saved.';
  el.classList.add('visible');
  setTimeout(() => {
    el.textContent = '';
    el.classList.remove('visible');
  }, 2000);
}

// Auto-save on every change
document.querySelectorAll('select, input[type="checkbox"]').forEach((el) => {
  el.addEventListener('change', saveSettings);
});
document.querySelectorAll('input[type="text"]').forEach((el) => {
  el.addEventListener('blur', saveSettings);
});

loadSettings();
