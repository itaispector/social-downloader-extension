/* global chrome */
'use strict';

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

function injectExtractorScript() {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('utils/extractor.js');
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
}

function requestExtraction(command) {
  return new Promise((resolve, reject) => {
    const requestId = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('Extraction timed out. Reload the page and try again.'));
    }, 8000);

    function handler(event) {
      if (event.source !== window) return;
      if (!event.data || event.data.direction !== 'from-page-script') return;
      if (event.data.requestId !== requestId) return;
      clearTimeout(timer);
      window.removeEventListener('message', handler);
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data.result);
    }

    window.addEventListener('message', handler);
    window.postMessage({ direction: 'from-content-script', command, requestId }, '*');
  });
}

function getSettings() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(response?.settings || {});
    });
  });
}

function sendDownloadRequest(url, filename, platform) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: 'DOWNLOAD_REQUEST', payload: { url, filename, platform } },
      (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (response?.success) resolve(response.downloadId);
        else reject(new Error(response?.error || 'Download failed'));
      }
    );
  });
}

function waitForElement(selectors, callback, maxWait = 12000) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  const existing = list.map((s) => document.querySelector(s)).find(Boolean);
  if (existing) { callback(existing); return; }

  const start = Date.now();
  const observer = new MutationObserver(() => {
    const el = list.map((s) => document.querySelector(s)).find(Boolean);
    if (el) { observer.disconnect(); callback(el); }
    else if (Date.now() - start > maxWait) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function removeModal() {
  document.getElementById('sdl-modal')?.remove();
}

function removeDownloadButton(id) {
  document.getElementById(id)?.remove();
}

function showError(msg) {
  document.getElementById('sdl-error-toast')?.remove();
  const toast = document.createElement('div');
  toast.id = 'sdl-error-toast';
  toast.className = 'sdl-error-toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 6000);
}

function setLoading(btn, loading) {
  btn.classList.toggle('sdl-loading', loading);
}

function positionModal(modal, anchor) {
  const rect = anchor.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const mw = modal.offsetWidth || 320;
  const mh = modal.offsetHeight || 200;

  let top = rect.bottom + 8;
  let left = rect.left;

  if (top + mh > vh - 16) top = rect.top - mh - 8;
  if (left + mw > vw - 16) left = vw - mw - 16;

  modal.style.top = `${Math.max(8, top)}px`;
  modal.style.left = `${Math.max(8, left)}px`;

  const dismiss = (e) => {
    if (!modal.contains(e.target) && !anchor.contains(e.target)) {
      removeModal();
      document.removeEventListener('click', dismiss, true);
    }
  };
  setTimeout(() => document.addEventListener('click', dismiss, true), 50);
}

function downloadIconSVG(size = 18) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2a1 1 0 0 1 1 1v10.586l3.293-3.293a1 1 0 1 1 1.414 1.414l-5 5a1 1 0 0 1-1.414 0l-5-5a1 1 0 1 1 1.414-1.414L11 13.586V3a1 1 0 0 1 1-1z"/>
    <path d="M4 20a1 1 0 0 1 1-1h14a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1z"/>
  </svg>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// TikTok-specific logic
// ---------------------------------------------------------------------------

const BTN_ID = 'sdl-tt-download-btn';
let lastUrl = location.href;

injectExtractorScript();
init();

// TikTok uses Next.js client-side routing; observe URL changes
const navObserver = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    removeDownloadButton(BTN_ID);
    removeModal();
    if (isVideoPage()) init();
  }
});
navObserver.observe(document.body, { childList: true, subtree: true });

function isVideoPage() {
  return /\/@[^/]+\/video\/\d+/.test(location.pathname);
}

function init() {
  // TikTok's action sidebar contains share, like, comment, etc.
  waitForElement(
    [
      '[data-e2e="share-icon"]',
      '[data-e2e="video-share"]',
      '.video-action-container',
      '.action-item-container',
    ],
    (el) => {
      const container = el.closest('[class*="action"]') || el.parentElement;
      if (container) injectButton(container);
    }
  );
}

function injectButton(container) {
  if (document.getElementById(BTN_ID)) return;

  const wrapper = document.createElement('div');
  wrapper.id = BTN_ID;
  wrapper.className = 'sdl-download-btn sdl-tt-btn';

  const btn = document.createElement('button');
  btn.className = 'sdl-btn-inner';
  btn.title = 'Download video';
  btn.setAttribute('aria-label', 'Download');
  btn.innerHTML = `${downloadIconSVG(24)}`;
  btn.addEventListener('click', onButtonClick);

  const label = document.createElement('span');
  label.className = 'sdl-btn-label';
  label.textContent = 'Save';

  wrapper.appendChild(btn);
  wrapper.appendChild(label);
  container.appendChild(wrapper);
}

async function onButtonClick(e) {
  e.stopPropagation();
  removeModal();

  const btn = e.currentTarget;
  setLoading(btn, true);

  let data, settings;
  try {
    [data, settings] = await Promise.all([
      requestExtraction('EXTRACT_TIKTOK'),
      getSettings(),
    ]);
  } catch (err) {
    showError(err.message);
    setLoading(btn, false);
    return;
  }

  setLoading(btn, false);

  const modal = buildModal(data, settings.tiktok || {});
  document.body.appendChild(modal);
  modal.getBoundingClientRect();
  positionModal(modal, document.getElementById(BTN_ID));
}

function buildModal(data, ttSettings) {
  const preferWatermark = ttSettings.watermark === true;

  // Prefer the version matching the user's setting; fallback to whatever exists
  let formats = data.formats;
  const preferred = formats.filter((f) => f.watermark === preferWatermark);
  const fallback = formats.filter((f) => f.watermark !== preferWatermark);

  const modal = document.createElement('div');
  modal.id = 'sdl-modal';

  const header = document.createElement('div');
  header.className = 'sdl-modal-header';
  header.innerHTML = `
    <span class="sdl-modal-title" title="${escapeHtml(data.title)}">${escapeHtml(data.title.slice(0, 55))}${data.title.length > 55 ? '…' : ''}</span>
    <button class="sdl-modal-close" aria-label="Close">✕</button>
  `;
  header.querySelector('.sdl-modal-close').addEventListener('click', removeModal);

  const body = document.createElement('div');
  body.className = 'sdl-modal-body';
  const section = document.createElement('div');
  section.className = 'sdl-modal-section';
  const sectionLabel = document.createElement('span');
  sectionLabel.className = 'sdl-section-label';
  sectionLabel.textContent = 'Download Video';
  section.appendChild(sectionLabel);

  const allOptions = [...preferred, ...fallback];
  if (allOptions.length) {
    allOptions.forEach((f) => {
      const wmLabel = f.watermark ? 'With watermark' : 'No watermark';
      const btn = document.createElement('button');
      btn.className = 'sdl-download-option';
      btn.innerHTML = `
        <span class="sdl-option-label">${escapeHtml(wmLabel)}</span>
        <span class="sdl-quality-badge">MP4</span>
      `;
      btn.addEventListener('click', () => {
        removeModal();
        sendDownloadRequest(f.url, `${data.title}.mp4`, 'tiktok').catch((err) => showError(err.message));
      });
      section.appendChild(btn);
    });
  } else {
    const msg = document.createElement('p');
    msg.className = 'sdl-no-formats';
    msg.textContent = 'No downloadable video found on this page.';
    section.appendChild(msg);
  }

  body.appendChild(section);
  modal.appendChild(header);
  modal.appendChild(body);
  return modal;
}
