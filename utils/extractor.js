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
  let decipherError = null;
  if (cipherFormats.length > 0) {
    try {
      const ctx = await getDecipherContext();
      for (const f of cipherFormats) {
        try {
          decipheredFormats.push({ f, url: applyDecipherToFormat(f, ctx) });
        } catch (err) {
          console.warn('[social-downloader] format decipher skipped:', err.message);
        }
      }
    } catch (err) {
      decipherError = err.message;
      console.error('[social-downloader] decipher failed:', err);
    }
  }

  const allResolved = [
    ...plainFormats.map((f) => ({ f, url: f.url })),
    ...decipheredFormats,
  ];

  if (!allResolved.length) {
    const reason = decipherError ? ` (${decipherError})` : '';
    throw new Error(`No downloadable streams found. YouTube may have changed their encryption${reason}. Try reloading the page.`);
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

function applyDecipherToFormat(f, ctx) {
  const cipherStr = f.signatureCipher || f.cipher;
  const params = new URLSearchParams(cipherStr);
  let url = params.get('url');
  const s = params.get('s');
  const sp = params.get('sp') || 'signature';
  if (!url || !s) throw new Error('Invalid cipher params');
  const sig = runDecipherOps(s, ctx.ops);
  url = `${url}&${sp}=${encodeURIComponent(sig)}`;

  // YouTube requires the 'n' parameter to be transformed to avoid 403 errors.
  if (ctx.nsigFn) {
    try {
      const u = new URL(url);
      const n = u.searchParams.get('n');
      if (n) {
        const nt = ctx.nsigFn(n);
        if (nt && nt !== n) { u.searchParams.set('n', nt); url = u.toString(); }
      }
    } catch { /* n-transform failed — use URL as-is */ }
  }

  return url;
}

async function getDecipherContext() {
  const playerUrl = resolvePlayerJsUrl();
  if (!playerUrl) throw new Error('Could not locate YouTube player JS');

  if (_decipherCache && _decipherCache.playerUrl === playerUrl) {
    return _decipherCache;
  }

  const jsText = await fetch(playerUrl).then((r) => {
    if (!r.ok) throw new Error(`Failed to fetch player JS: ${r.status}`);
    return r.text();
  });

  const ops = parseDecipherOps(jsText);
  const nsigFn = tryExtractNsigFn(jsText);
  if (!nsigFn) console.warn('[social-downloader] nsig fn not found — downloads may get 403');
  _decipherCache = { playerUrl, ops, nsigFn };
  return _decipherCache;
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
// nsig (n-parameter) transform — required since ~2022 to avoid 403 errors.
// YouTube embeds an 'n' parameter in streaming URLs that must be transformed
// by a function in the player JS before the URL can be used for download.
// The function is self-contained (no closures), so new Function() works here.
// ---------------------------------------------------------------------------

function tryExtractNsigFn(jsText) {
  try {
    const ref = findNsigRef(jsText);
    if (!ref) return null;
    const fnStr = ref.index !== null
      ? extractIndexedArrayFn(jsText, ref.name, ref.index)
      : extractNamedFn(jsText, ref.name);
    if (!fnStr) return null;
    // eslint-disable-next-line no-new-func
    return new Function(`return (${fnStr})`)();
  } catch (err) {
    console.warn('[social-downloader] nsig extract error:', err.message);
    return null;
  }
}

function findNsigRef(jsText) {
  // Array-indexed call site: &&(b=NAME[idx](b)
  let m = jsText.match(/&&\([a-z]=([a-zA-Z0-9$]{1,4})\[(\d+)\]\([a-z]\)/);
  if (m) return { name: m[1], index: parseInt(m[2]) };
  // Direct call site: &&(b=NAME(b),c.set("n"
  m = jsText.match(/&&\([a-z]=([a-zA-Z0-9$]{2,})\([a-z]\),[a-z]\.set\("n"/);
  if (m) return { name: m[1], index: null };
  // Alternate array pattern: .get("n"))&&(b=NAME[0](b)
  m = jsText.match(/\.get\("n"\)\)&&\(b=([a-zA-Z0-9$]{1,4})\[(\d+)\]\(b\)/);
  if (m) return { name: m[1], index: parseInt(m[2]) };
  // Alternate direct pattern
  m = jsText.match(/\.get\("n"\)\)&&\(b=([a-zA-Z0-9$]{2,})\(b\)/);
  if (m) return { name: m[1], index: null };
  return null;
}

// Extract a named function (assignment or declaration style) using brace counting.
function extractNamedFn(jsText, name) {
  const esc = escapeRegex(name);
  const m = jsText.match(new RegExp(`(?:function\\s+${esc}|${esc}\\s*=\\s*function)\\s*\\(`));
  if (!m) return null;
  const braceIdx = jsText.indexOf('{', m.index + m[0].length - 1);
  if (braceIdx === -1) return null;
  return extractByBraceCount(jsText, m.index, braceIdx);
}

// Extract the idx-th function literal from an array variable.
function extractIndexedArrayFn(jsText, arrayName, idx) {
  const esc = escapeRegex(arrayName);
  const m = jsText.match(new RegExp(`${esc}\\s*=\\s*\\[`));
  if (!m) return null;
  const arrStart = jsText.indexOf('[', m.index + m[0].length - 1);
  let fnCount = 0, i = arrStart + 1;
  while (i < jsText.length) {
    const fi = jsText.indexOf('function', i);
    if (fi === -1 || jsText[fi - 1] === ']') break; // past array end
    const bi = jsText.indexOf('{', fi);
    if (bi === -1) break;
    const fnStr = extractByBraceCount(jsText, fi, bi);
    if (!fnStr) break;
    if (fnCount === idx) return fnStr;
    fnCount++;
    i = fi + fnStr.length;
  }
  return null;
}

// Walk from braceIdx counting '{'/'}', return substring from defStart to closing '}'.
// Handles string literals so brace characters inside strings are ignored.
function extractByBraceCount(jsText, defStart, braceIdx) {
  let depth = 0, inStr = false, strCh = '';
  for (let i = braceIdx; i < jsText.length; i++) {
    const ch = jsText[i];
    if (inStr) {
      if (ch === strCh && jsText[i - 1] !== '\\') inStr = false;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      inStr = true; strCh = ch;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return jsText.substring(defStart, i + 1);
    }
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
  if (!fnName) throw new Error('Could not identify decipher function name');

  const esc = escapeRegex(fnName);
  // Support both: fnName=function(param){body}  and  function fnName(param){body}
  const bodyMatch =
    jsText.match(new RegExp(`${esc}=function\\((\\w+)\\)\\{([^}]+)\\}`)) ||
    jsText.match(new RegExp(`function\\s+${esc}\\s*\\((\\w+)\\)\\s*\\{([^}]+)\\}`));
  if (!bodyMatch) throw new Error(`Could not extract body of decipher function "${fnName}"`);
  const paramName = bodyMatch[1];
  const fnBody = bodyMatch[2];

  const helperMatch = fnBody.match(new RegExp(`;?(\\w+)\\.\\w+\\(${escapeRegex(paramName)}`));
  if (!helperMatch) throw new Error('Could not identify helper object in decipher body');
  const helperName = helperMatch[1];

  const methodMap = extractHelperMethodMap(jsText, helperName);
  if (!methodMap.size) throw new Error(`Could not parse helper methods from object "${helperName}"`);

  return buildOpSequence(fnBody, helperName, paramName, methodMap);
}

function findDecipherFnName(jsText) {
  const patterns = [
    // yt-dlp-style: general encodeURIComponent pattern around signature setting
    /\b[a-zA-Z0-9$]+\s*&&\s*[a-zA-Z0-9$]+\.set\([^,]+,\s*encodeURIComponent\s*\(\s*(\w+)\s*\(/,
    /\b[cs]\s*&&\s*[adf]\.set\([^,]+,\s*encodeURIComponent\s*\(\s*(\w+)\s*\(/,
    // Classic pattern
    /\bc&&d\.set\([^,]+,\s*(?:encodeURIComponent\s*\()?\s*(\w+)\s*\(/,
    /\.sig\s*\|\|\s*(\w+)\s*\(/,
    // Split("") function definition — flexible variable name
    /(?:\b|[^a-zA-Z0-9$])(\w{2,})\s*=\s*function\s*\(\s*\w\s*\)\s*\{\s*\w\s*=\s*\w\s*\.split\s*\(\s*""\s*\)/,
    /(?:^|[;,{(])(\w+)=function\(\w\)\{\w=\w\.split\(""\)/m,
    // signatureCipher nearby
    /\bsignatureCipher\b[\s\S]{0,300}?(\w+)\s*\(\s*decodeURIComponent/,
    // "signature" string literal near the call
    /\.set\(["']signature["']\s*,\s*(\w+)\s*\(/,
    /["']signature["']\s*,\s*(\w+)\s*\(\s*decodeURIComponent/,
    // Ternary/conditional pattern
    /\(\w+\)\s*\?\s*\w+\.set\([^,]+,\s*(\w+)\s*\(\s*\w+\s*\)\s*\)/,
    // Fallback: any 2+ char fn immediately before decodeURIComponent
    /[;,]\s*(\w{2,})\s*\(\s*decodeURIComponent\s*\(\s*\w+\.get\s*\(\s*["']s["']/,
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
    // Without semicolon terminator (some minifiers omit it)
    new RegExp(`var\\s+${escaped}\\s*=\\s*\\{([\\s\\S]+?)\\}(?=\\s*(?:var|let|const|function|\\())`),
    new RegExp(`${escaped}\\s*=\\s*\\{([\\s\\S]+?)\\}(?=\\s*(?:var|let|const|function|\\())`),
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
