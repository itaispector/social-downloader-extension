/* global chrome */
'use strict';

// ---------------------------------------------------------------------------
// Shared utilities (inlined — no build step required)
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

function mimeToExt(mimeType) {
  if (!mimeType) return 'mp4';
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('opus')) return 'opus';
  if (mimeType.includes('mp4a') || mimeType.includes('m4a')) return 'm4a';
  return 'mp4';
}

// ---------------------------------------------------------------------------
// YouTube-specific logic
// ---------------------------------------------------------------------------

const BTN_ID = 'sdl-yt-download-btn';
let currentVideoId = null;

injectExtractorScript();

// YouTube SPA: yt-navigate-finish fires after each virtual navigation completes
document.addEventListener('yt-navigate-finish', handleNavigation);
window.addEventListener('popstate', handleNavigation);
handleNavigation();

function handleNavigation() {
  const params = new URLSearchParams(window.location.search);
  const videoId = params.get('v');
  if (!videoId || videoId === currentVideoId) return;
  currentVideoId = videoId;
  removeDownloadButton(BTN_ID);
  removeModal();

  waitForElement(
    ['#top-level-buttons-computed', '#actions-inner ytd-button-renderer', '#actions'],
    (container) => injectButton(container)
  );
}

function injectButton(container) {
  if (document.getElementById(BTN_ID)) return;

  const wrapper = document.createElement('div');
  wrapper.id = BTN_ID;
  wrapper.className = 'sdl-download-btn sdl-yt-btn';

  const btn = document.createElement('button');
  btn.className = 'sdl-btn-inner';
  btn.title = 'Download video or audio';
  btn.innerHTML = `${downloadIconSVG(16)}<span class="sdl-btn-label">Download</span>`;
  btn.addEventListener('click', onButtonClick);

  wrapper.appendChild(btn);
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
      requestExtraction('EXTRACT_YOUTUBE'),
      getSettings(),
    ]);
  } catch (err) {
    showError(err.message);
    setLoading(btn, false);
    return;
  }

  setLoading(btn, false);

  const modal = buildModal(data, settings.youtube || {});
  document.body.appendChild(modal);
  // Force a layout pass so offsetHeight is correct before positioning
  modal.getBoundingClientRect();
  positionModal(modal, document.getElementById(BTN_ID));
}

// ---------------------------------------------------------------------------
// Quality filtering
// ---------------------------------------------------------------------------

function filterVideoFormats(formats, qualityPref) {
  const muxed = formats.filter((f) => f.kind === 'muxed' && f.url);
  if (!muxed.length) return [];

  // Sort descending by height
  muxed.sort((a, b) => b.height - a.height);

  if (qualityPref === 'best') return muxed;

  const targetHeight = parseInt(qualityPref, 10); // e.g. "720p" → 720
  if (isNaN(targetHeight)) return muxed;

  // Return formats at or below the preferred height, prefer exact match first
  const atOrBelow = muxed.filter((f) => f.height <= targetHeight);
  return atOrBelow.length ? atOrBelow : muxed;
}

function filterAudioFormats(formats, qualityPref) {
  const audio = formats.filter((f) => f.kind === 'audio' && f.url);
  if (!audio.length) return [];

  audio.sort((a, b) => b.bitrate - a.bitrate);

  if (qualityPref === '256kbps') return audio; // return all, best first

  // 128kbps preference: prefer AUDIO_QUALITY_MEDIUM or lower bitrate streams
  const medium = audio.filter((f) => f.audioQuality === 'AUDIO_QUALITY_MEDIUM');
  return medium.length ? medium : audio;
}

// ---------------------------------------------------------------------------
// Modal builder
// ---------------------------------------------------------------------------

function buildModal(data, ytSettings) {
  const { videoQuality = 'best', audioQuality = '128kbps' } = ytSettings;
  const videoFormats = filterVideoFormats(data.formats, videoQuality);
  const audioFormats = filterAudioFormats(data.formats, audioQuality);

  const modal = document.createElement('div');
  modal.id = 'sdl-modal';

  // Header
  const header = document.createElement('div');
  header.className = 'sdl-modal-header';
  header.innerHTML = `
    <span class="sdl-modal-title" title="${escapeHtml(data.title)}">${escapeHtml(data.title.slice(0, 55))}${data.title.length > 55 ? '…' : ''}</span>
    <button class="sdl-modal-close" aria-label="Close">✕</button>
  `;
  header.querySelector('.sdl-modal-close').addEventListener('click', removeModal);

  const body = document.createElement('div');
  body.className = 'sdl-modal-body';

  // Video section
  const videoSection = document.createElement('div');
  videoSection.className = 'sdl-modal-section';
  const videoLabel = document.createElement('span');
  videoLabel.className = 'sdl-section-label';
  videoLabel.textContent = 'Video (audio + video)';
  videoSection.appendChild(videoLabel);

  if (videoFormats.length) {
    // Deduplicate by qualityLabel
    const seen = new Set();
    videoFormats.forEach((f) => {
      if (seen.has(f.qualityLabel)) return;
      seen.add(f.qualityLabel);

      const ext = mimeToExt(f.mimeType);
      const filename = `${data.title}.${ext}`;
      const btn = document.createElement('button');
      btn.className = 'sdl-download-option';
      btn.innerHTML = `
        <span class="sdl-option-label">${escapeHtml(f.qualityLabel || 'Video')} · ${ext.toUpperCase()}</span>
        <span class="sdl-quality-badge">${escapeHtml(f.qualityLabel || 'HD')}</span>
      `;
      btn.addEventListener('click', () => triggerDownload(f.url, filename, 'youtube'));
      videoSection.appendChild(btn);
    });
  } else {
    const msg = document.createElement('p');
    msg.className = 'sdl-no-formats';
    msg.textContent = 'No video streams available at this quality. Try changing the quality in settings.';
    videoSection.appendChild(msg);
  }

  // Audio section
  const audioSection = document.createElement('div');
  audioSection.className = 'sdl-modal-section';
  const audioLabel = document.createElement('span');
  audioLabel.className = 'sdl-section-label';
  audioLabel.textContent = 'Audio only';
  audioSection.appendChild(audioLabel);

  if (audioFormats.length) {
    const seen = new Set();
    audioFormats.forEach((f) => {
      const kbps = f.bitrate ? Math.round(f.bitrate / 1000) : '?';
      const key = `${kbps}kbps`;
      if (seen.has(key)) return;
      seen.add(key);

      const ext = mimeToExt(f.mimeType);
      const filename = `${data.title} (audio).${ext}`;
      const btn = document.createElement('button');
      btn.className = 'sdl-download-option';
      btn.innerHTML = `
        <span class="sdl-option-label">Audio · ${ext.toUpperCase()}</span>
        <span class="sdl-quality-badge">${kbps} kbps</span>
      `;
      btn.addEventListener('click', () => triggerDownload(f.url, filename, 'youtube'));
      audioSection.appendChild(btn);
    });
  } else {
    const msg = document.createElement('p');
    msg.className = 'sdl-no-formats';
    msg.textContent = 'No separate audio streams found.';
    audioSection.appendChild(msg);
  }

  body.appendChild(videoSection);
  body.appendChild(audioSection);
  modal.appendChild(header);
  modal.appendChild(body);
  return modal;
}

function triggerDownload(url, filename, platform) {
  removeModal();
  sendDownloadRequest(url, filename, platform).catch((err) => showError(err.message));
}
