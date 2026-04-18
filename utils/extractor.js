// Runs in PAGE context (not the isolated content-script world).
// Receives commands via window.postMessage and replies with extracted media data.

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.direction !== 'from-content-script') return;

  const { command, requestId } = event.data;

  try {
    let result;
    switch (command) {
      case 'EXTRACT_YOUTUBE':
        result = extractYouTube();
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
function extractYouTube() {
  const data = window.ytInitialPlayerResponse;
  if (!data) throw new Error('ytInitialPlayerResponse not found. Try reloading the page.');

  const streaming = data.streamingData;
  if (!streaming) throw new Error('No streaming data available. The video may be private or age-restricted.');

  const title = sanitizeFilename(data.videoDetails?.title || 'youtube-video');

  // Only include formats that have a plain URL (skip signatureCipher / encrypted streams)
  const muxed = (streaming.formats || [])
    .filter((f) => f.url)
    .map((f) => ({
      kind: 'muxed',
      url: f.url,
      qualityLabel: f.qualityLabel || '',
      mimeType: f.mimeType || '',
      bitrate: f.bitrate || 0,
      height: f.height || 0,
      contentLength: f.contentLength || null,
    }));

  const adaptive = (streaming.adaptiveFormats || [])
    .filter((f) => f.url)
    .map((f) => {
      const isAudio = (f.mimeType || '').startsWith('audio/');
      return {
        kind: isAudio ? 'audio' : 'video',
        url: f.url,
        qualityLabel: f.qualityLabel || null,
        mimeType: f.mimeType || '',
        bitrate: f.averageBitrate || f.bitrate || 0,
        height: f.height || 0,
        audioQuality: f.audioQuality || null,
        contentLength: f.contentLength || null,
      };
    });

  const formats = [...muxed, ...adaptive];
  if (!formats.length) {
    throw new Error('No downloadable streams found. YouTube may have encrypted all formats for this video.');
  }

  return { title, formats };
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
