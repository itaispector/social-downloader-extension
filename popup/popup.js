/* global chrome */
'use strict';

document.getElementById('open-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

const PLATFORM_MAP = [
  { pattern: /youtube\.com\/watch/,            name: 'YouTube',   active: true },
  { pattern: /facebook\.com\/(watch|video|reel|.*\/videos\/)/, name: 'Facebook',  active: true },
  { pattern: /instagram\.com\/(p|reel|tv)\//,  name: 'Instagram', active: true },
  { pattern: /tiktok\.com\/@[^/]+\/video\//,   name: 'TikTok',    active: true },
];

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  const url = tab?.url || '';
  const match = PLATFORM_MAP.find((p) => p.pattern.test(url));

  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  const card = document.getElementById('status-card');

  if (match) {
    dot.className  = 'status-dot active';
    text.textContent = `Active on ${match.name} — look for the Download button on the page.`;
    card.className = 'status-card active';
  } else {
    dot.className  = 'status-dot inactive';
    text.textContent = 'Navigate to a YouTube, Facebook, Instagram, or TikTok video page to use the downloader.';
    card.className = 'status-card inactive';
  }
});
