// Runs in PAGE context (not the isolated content-script world).
// Receives commands via window.postMessage and replies with extracted media data.

window.addEventListener('message', async (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.direction !== 'from-content-script') return;

  const { command, requestId } = event.data;

  try {
    let result;
    switch (command) {
      case 'EXTRACT_YOUTUBE':
        result = await extractYouTube();
        break;
      case 'EXTRACT_FACEBOOK':
        result = extractFacebook();
        break;
      case 'EXTRACT_INSTAGRAM':
        result = extractInstagram();
        break;
      case 'EXTRACT_TIKTOK':
        result = extractTikTok();
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
    window.postMessage({ direction: 'from-page-script', requestId, result }, '*');
  } catch (err) {
    window.postMessage({ direction: 'from-page-script', requestId, error: err.message }, '*');
  }
});

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

// Cache keyed by player URL so we only parse once per session.
let _decipherCache = null;

async function extractYouTube() {
  const data = window.ytInitialPlayerResponse;
  if (!data) throw new Error('ytInitialPlayerResponse not found. Try reloading the page.');

  const streaming = data.streamingData;
  if (!streaming) throw new Error('No streaming data available. The video may be private or age-restricted.');

  const title = sanitizeFilename(data.videoDetails?.title || 'youtube-video');

  const allFormats = [
    ...(streaming.formats || []),
    ...(streaming.adaptiveFormats || []),
  ];
  const muxedSet = new Set(streaming.formats || []);

  const plainFormats = allFormats.filter((f) => f.url);
  const cipherFormats = allFormats.filter((f) => !f.url && (f.signatureCipher || f.cipher));

  let decipheredFormats = [];
  if (cipherFormats.length > 0) {
    try {
      const ops = await getDecipherOps();
      for (const f of cipherFormats) {
        try {
          decipheredFormats.push({ f, url: applyDecipherToFormat(f, ops) });
        } catch {
          // skip formats that can't be deciphered
        }
      }
    } catch {
      // decipher unavailable — fall through to plain formats only
    }
  }

  const allResolved = [
    ...plainFormats.map((f) => ({ f, url: f.url })),
    ...decipheredFormats,
  ];

  if (!allResolved.length) {
    throw new Error('No downloadable streams found. YouTube may have changed their encryption. Try reloading the page.');
  }

  const formats = allResolved.map(({ f, url }) => {
    const isMuxed = muxedSet.has(f);
    const isAudio = (f.mimeType || '').startsWith('audio/');
    return {
      kind: isMuxed ? 'muxed' : (isAudio ? 'audio' : 'video'),
      url,
      qualityLabel: f.qualityLabel || '',
      mimeType: f.mimeType || '',
      bitrate: f.averageBitrate || f.bitrate || 0,
      height: f.height || 0,
      audioQuality: f.audioQuality || null,
      contentLength: f.contentLength || null,
    };
  });

  return { title, formats };
}

function applyDecipherToFormat(f, ops) {
  const cipherStr = f.signatureCipher || f.cipher;
  const params = new URLSearchParams(cipherStr);
  const url = params.get('url');
  const s = params.get('s');
  const sp = params.get('sp') || 'signature';
  if (!url || !s) throw new Error('Invalid cipher params');
  const sig = runDecipherOps(s, ops);
  return `${url}&${sp}=${encodeURIComponent(sig)}`;
}

async function getDecipherOps() {
  const playerUrl = resolvePlayerJsUrl();
  if (!playerUrl) throw new Error('Could not locate YouTube player JS');

  if (_decipherCache && _decipherCache.playerUrl === playerUrl) {
    return _decipherCache.ops;
  }

  const jsText = await fetch(playerUrl).then((r) => {
    if (!r.ok) throw new Error(`Failed to fetch player JS: ${r.status}`);
    return r.text();
  });

  const ops = parseDecipherOps(jsText);
  _decipherCache = { playerUrl, ops };
  return ops;
}

function resolvePlayerJsUrl() {
  try {
    const url = window.ytcfg?.get('PLAYER_JS_URL');
    if (url) return url.startsWith('http') ? url : `https://www.youtube.com${url}`;
  } catch {}

  for (const s of document.querySelectorAll('script[src]')) {
    if (s.src.includes('/base.js')) return s.src;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Decipher algorithm parser — no eval/new Function needed.
// YouTube's signature decipher is always a sequence of three possible ops:
//   reverse(a), splice(a, n), swap(a, n)
// We parse which ops are applied and replay them directly.
// ---------------------------------------------------------------------------

function parseDecipherOps(jsText) {
  const fnName = findDecipherFnName(jsText);
  if (!fnName) throw new Error('Could not identify decipher function');

  // Capture the actual parameter name — YouTube may use any identifier, not just 'a'
  const bodyMatch = jsText.match(
    new RegExp(`${escapeRegex(fnName)}=function\\((\\w+)\\)\\{([^}]+)\\}`)
  );
  if (!bodyMatch) throw new Error('Could not extract decipher function body');
  const paramName = bodyMatch[1];
  const fnBody = bodyMatch[2];

  const helperMatch = fnBody.match(new RegExp(`;?(\\w+)\\.\\w+\\(${escapeRegex(paramName)}`));
  if (!helperMatch) throw new Error('Could not identify helper object');
  const helperName = helperMatch[1];

  const methodMap = extractHelperMethodMap(jsText, helperName);
  if (!methodMap.size) throw new Error('Could not parse helper methods');

  return buildOpSequence(fnBody, helperName, paramName, methodMap);
}

function findDecipherFnName(jsText) {
  const patterns = [
    /\bc&&d\.set\([^,]+,\s*(?:encodeURIComponent\s*\()?\s*(\w+)\s*\(/,
    /\.sig\s*\|\|\s*(\w+)\s*\(/,
    /(?:^|[;,{(])(\w+)=function\(\w\)\{\w=\w\.split\(""\)/m,
    /\bsignatureCipher\b[\s\S]{0,300}?(\w+)\s*\(\s*decodeURIComponent/,
    /\.set\(["']signature["']\s*,\s*(\w+)\s*\(/,
    /["']signature["']\s*,\s*(\w+)\s*\(\s*decodeURIComponent/,
    /\(\w+\)\s*\?\s*\w+\.set\([^,]+,\s*(\w+)\s*\(\s*\w+\s*\)\s*\)/,
  ];
  for (const p of patterns) {
    const m = jsText.match(p);
    if (m?.[1] && m[1].length > 1) return m[1];
  }
  return null;
}

function extractHelperMethodMap(jsText, helperName) {
  const escaped = escapeRegex(helperName);
  const declarationPatterns = [
    new RegExp(`var\\s+${escaped}\\s*=\\s*\\{([\\s\\S]+?)\\}\\s*;`),
    new RegExp(`(?:let|const)\\s+${escaped}\\s*=\\s*\\{([\\s\\S]+?)\\}\\s*;`),
    new RegExp(`${escaped}\\s*=\\s*\\{([\\s\\S]+?)\\}\\s*;`),
  ];

  let bodyContent = null;
  for (const pat of declarationPatterns) {
    const m = jsText.match(pat);
    if (m) { bodyContent = m[1]; break; }
  }
  if (!bodyContent) throw new Error(`Helper object "${helperName}" not found`);

  const map = new Map();
  const re = /(\w+)\s*:\s*function\s*\([^)]*\)\s*\{([^}]+)\}/g;
  let match;
  while ((match = re.exec(bodyContent)) !== null) {
    const type = classifyOp(match[2]);
    if (type) map.set(match[1], type);
  }
  return map;
}

function classifyOp(fnBody) {
  if (/\.reverse\(\)/.test(fnBody)) return 'reverse';
  if (/\.splice\s*\(\s*0/.test(fnBody)) return 'splice';
  // Use \w instead of hardcoded 'a' since the parameter name can vary
  if (/\w\[0\]/.test(fnBody) && /\w\.length/.test(fnBody)) return 'swap';
  return null;
}

function buildOpSequence(fnBody, helperName, paramName, methodMap) {
  const ops = [];
  const escapedHelper = escapeRegex(helperName);
  const escapedParam = escapeRegex(paramName);
  const re = new RegExp(`${escapedHelper}\\.(\\w+)\\(${escapedParam}\\s*,?\\s*(\\d+)?\\s*\\)`, 'g');
  let m;
  while ((m = re.exec(fnBody)) !== null) {
    const type = methodMap.get(m[1]);
    if (type) ops.push({ type, arg: m[2] ? parseInt(m[2], 10) : undefined });
  }
  return ops;
}

function runDecipherOps(sig, ops) {
  const a = sig.split('');
  for (const { type, arg } of ops) {
    if (type === 'reverse') {
      a.reverse();
    } else if (type === 'splice') {
      a.splice(0, arg);
    } else if (type === 'swap') {
      const idx = arg % a.length;
      const c = a[0];
      a[0] = a[idx];
      a[idx] = c;
    }
  }
  return a.join('');
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Facebook
// ---------------------------------------------------------------------------
function extractFacebook() {
  // Strategy 1: __NEXT_DATA__ JSON blob
  const nextDataEl = document.getElementById('__NEXT_DATA__');
  if (nextDataEl) {
    try {
      const json = JSON.parse(nextDataEl.textContent);
      const video = json?.props?.pageProps?.video;
      if (video) {
        const formats = [];
        if (video.playable_url_quality_hd) {
          formats.push({ kind: 'video', quality: 'hd', url: video.playable_url_quality_hd });
        }
        if (video.playable_url) {
          formats.push({ kind: 'video', quality: 'sd', url: video.playable_url });
        }
        if (formats.length) {
          return { title: sanitizeFilename(video.title || 'facebook-video'), formats };
        }
      }
    } catch {}
  }

  // Strategy 2: OG meta tags (public pages)
  const ogVideo =
    document.querySelector('meta[property="og:video:secure_url"]') ||
    document.querySelector('meta[property="og:video:url"]') ||
    document.querySelector('meta[property="og:video"]');
  if (ogVideo?.content) {
    return {
      title: sanitizeFilename(document.title || 'facebook-video'),
      formats: [{ kind: 'video', quality: 'sd', url: ogVideo.content }],
    };
  }

  // Strategy 3: HD/SD data attributes on video element
  const videoEl = document.querySelector('video[src]');
  if (videoEl?.src) {
    return {
      title: sanitizeFilename(document.title || 'facebook-video'),
      formats: [{ kind: 'video', quality: 'sd', url: videoEl.src }],
    };
  }

  throw new Error('No video URL found. Make sure you are on a public Facebook video page.');
}

// ---------------------------------------------------------------------------
// Instagram
// ---------------------------------------------------------------------------
function extractInstagram() {
  // Strategy 1: application/ld+json schema.org VideoObject
  const ldJsonEls = document.querySelectorAll('script[type="application/ld+json"]');
  for (const el of ldJsonEls) {
    try {
      const json = JSON.parse(el.textContent);
      const items = Array.isArray(json) ? json : [json];
      for (const item of items) {
        const videoUrl = item?.video?.contentUrl || item?.contentUrl;
        if (videoUrl) {
          return {
            title: sanitizeFilename(item.name || item.headline || 'instagram-video'),
            formats: [{ kind: 'video', url: videoUrl }],
          };
        }
      }
    } catch {}
  }

  // Strategy 2: window.__additionalDataLoaded cache
  const additionalData = window.__additionalDataLoaded;
  if (additionalData) {
    for (const key of Object.keys(additionalData)) {
      const media =
        additionalData[key]?.graphql?.shortcode_media ||
        additionalData[key]?.items?.[0];
      if (media?.video_url) {
        const caption = media.edge_media_to_caption?.edges?.[0]?.node?.text || '';
        return {
          title: sanitizeFilename(caption.slice(0, 60) || 'instagram-video'),
          formats: [{ kind: 'video', url: media.video_url }],
        };
      }
    }
  }

  // Strategy 3: DOM <video> element
  const videoEl = document.querySelector('video[src]');
  if (videoEl?.src && !videoEl.src.startsWith('blob:')) {
    return {
      title: 'instagram-video',
      formats: [{ kind: 'video', url: videoEl.src }],
    };
  }

  throw new Error('No video URL found. Make sure you are on a public Instagram post or reel.');
}

// ---------------------------------------------------------------------------
// TikTok
// ---------------------------------------------------------------------------
function extractTikTok() {
  // Strategy 1: __NEXT_DATA__ (most reliable)
  const nextDataEl = document.getElementById('__NEXT_DATA__');
  if (nextDataEl) {
    try {
      const json = JSON.parse(nextDataEl.textContent);
      const itemStruct =
        json?.props?.pageProps?.itemInfo?.itemStruct ||
        json?.props?.pageProps?.videoData?.itemInfos;
      if (itemStruct) {
        const videoMeta = itemStruct.video;
        const title = sanitizeFilename(itemStruct.desc || 'tiktok-video');
        const formats = [];
        if (videoMeta?.downloadAddr) {
          formats.push({ kind: 'video', watermark: true, url: videoMeta.downloadAddr });
        }
        if (videoMeta?.playAddr) {
          formats.push({ kind: 'video', watermark: false, url: videoMeta.playAddr });
        }
        if (formats.length) return { title, formats };
      }
    } catch {}
  }

  // Strategy 2: SIGI_STATE (newer TikTok layout)
  const sigiStateEl = document.getElementById('SIGI_STATE');
  if (sigiStateEl) {
    try {
      const json = JSON.parse(sigiStateEl.textContent);
      const itemModule = json?.ItemModule;
      if (itemModule) {
        const firstItem = Object.values(itemModule)[0];
        const videoMeta = firstItem?.video;
        if (videoMeta) {
          const formats = [];
          if (videoMeta.downloadAddr) formats.push({ kind: 'video', watermark: true, url: videoMeta.downloadAddr });
          if (videoMeta.playAddr) formats.push({ kind: 'video', watermark: false, url: videoMeta.playAddr });
          if (formats.length) {
            return { title: sanitizeFilename(firstItem.desc || 'tiktok-video'), formats };
          }
        }
      }
    } catch {}
  }

  // Strategy 3: DOM <video>
  const videoEl = document.querySelector('video[src]');
  if (videoEl?.src && !videoEl.src.startsWith('blob:')) {
    return {
      title: 'tiktok-video',
      formats: [{ kind: 'video', watermark: true, url: videoEl.src }],
    };
  }

  throw new Error('No video URL found on this TikTok page.');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim().slice(0, 100) || 'download';
}
