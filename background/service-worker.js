const DEFAULT_SETTINGS = {
  youtube: {
    videoQuality: 'best',
    audioQuality: '128kbps',
    preferredType: 'video',
  },
  facebook: {
    videoQuality: 'hd',
    preferredType: 'video',
  },
  instagram: {
    preferredType: 'video',
  },
  tiktok: {
    watermark: false,
    preferredType: 'video',
  },
};

const CDN_ALLOWLIST = {
  youtube: ['.googlevideo.com'],
  facebook: ['.fbcdn.net', '.facebook.com'],
  instagram: ['.cdninstagram.com', '.fbcdn.net'],
  tiktok: ['.tiktokcdn.com', '.tiktok.com', '.musical.ly', '.tiktokcdn-us.com'],
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get(null);
  const merged = deepMerge(DEFAULT_SETTINGS, existing);
  await chrome.storage.sync.set(merged);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'DOWNLOAD_REQUEST') {
    handleDownload(message.payload)
      .then((downloadId) => sendResponse({ success: true, downloadId }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'GET_SETTINGS') {
    chrome.storage.sync
      .get(null)
      .then((settings) => sendResponse({ settings }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'COBALT_MP3_REQUEST') {
    handleCobaltMP3(message.payload)
      .then((downloadId) => sendResponse({ success: true, downloadId }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function handleDownload({ url, filename, platform }) {
  if (!isAllowedDownloadUrl(url, platform)) {
    throw new Error('Download URL did not pass validation — unexpected CDN host.');
  }

  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(downloadId);
      }
    });
  });
}

function isAllowedDownloadUrl(url, platform) {
  const allowed = CDN_ALLOWLIST[platform];
  if (!allowed) return false;
  try {
    const { hostname } = new URL(url);
    return allowed.some((h) => hostname.endsWith(h));
  } catch {
    return false;
  }
}

async function handleCobaltMP3({ videoId, filename }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let resp;
  try {
    resp = await fetch('https://api.cobalt.tools/', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        url: `https://www.youtube.com/watch?v=${videoId}`,
        downloadMode: 'audio',
        audioFormat: 'mp3',
        audioBitrate: '128',
      }),
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    throw new Error(`MP3 conversion service unavailable (${resp.status}). Try again later.`);
  }

  const cobalt = await resp.json();

  if (cobalt.status === 'error') {
    const code = cobalt.error?.code || 'unknown';
    throw new Error(`Conversion failed: ${code}. The video may be age-restricted or unavailable.`);
  }

  const url = cobalt.url;
  if (!url) throw new Error('No download URL returned from conversion service.');

  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(downloadId);
    });
  });
}

function deepMerge(defaults, overrides) {
  const result = { ...defaults };
  for (const key of Object.keys(overrides)) {
    if (
      overrides[key] !== null &&
      typeof overrides[key] === 'object' &&
      !Array.isArray(overrides[key]) &&
      typeof defaults[key] === 'object'
    ) {
      result[key] = deepMerge(defaults[key], overrides[key]);
    } else {
      result[key] = overrides[key];
    }
  }
  return result;
}
