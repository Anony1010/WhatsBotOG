const axios = require('axios');
const { igdl } = require("ruhend-scraper");

const processedMessages = new Map();
const CAPTION = "🔹DOWNLOADED BY GASHAM🔹";

// Instagram URL patterns (supports all public link types)
const IG_URL_PATTERNS = [
  /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:p|reel|tv)\/[a-zA-Z0-9_\-]+/i,
  /(?:https?:\/\/)?(?:www\.)?instagram\.com\/stories\/[a-zA-Z0-9_.\-]+\/[0-9]+/i,
  /(?:https?:\/\/)?(?:www\.)?instagram\.com\/[a-zA-Z0-9_.\-]+\/(?:p|reel|tv)\/[a-zA-Z0-9_\-]+/i,
  /(?:https?:\/\/)?(?:www\.)?instagr\.am\/(?:p|reel|tv)\/[a-zA-Z0-9_\-]+/i,
  /(?:https?:\/\/)?(?:www\.)?instagram\.com\/[a-zA-Z0-9_.\-]+\/[a-zA-Z0-9_\-?=]+/i,
];

// --- Fallback API functions ---
async function fetchRuhend(url) {
  const d = await igdl(url);
  if (d?.data?.length) return d.data;
  throw new Error('no media');
}

async function fetchInstaDownloader(url) {
  const res = await axios.get('https://api.instasave.io/v1/media', {
    params: { url },
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    },
    timeout: 20000
  });
  if (res.data?.items?.length) return res.data.items.map(item => ({ url: item.url, type: item.type || 'image' }));
  throw new Error('no media');
}

async function fetchInstaSave(url) {
  const res = await axios.get('https://instasave.io/wp-json/instasave/v1/get-data', {
    params: { url },
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://instasave.io/'
    },
    timeout: 20000
  });
  if (res.data?.medias?.length) return res.data.medias.map(m => ({ url: m.url, type: m.type === 'video' ? 'video' : 'image' }));
  throw new Error('no media');
}

// --- Helpers ---
function detectMediaType(item, url) {
  if (item.type === 'video') return 'video';
  if (typeof item.type === 'string' && item.type.startsWith('video')) return 'video';
  if (/\.(mp4|mov|webm|avi)$/i.test(item.url)) return 'video';
  if (/(\/reel\/|\/tv\/)/i.test(url)) return 'video';
  return 'image';
}

async function downloadBuffer(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 45000 });
  return Buffer.from(res.data);
}

function extractUrl(text) {
  for (const pattern of IG_URL_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[0].startsWith('http') ? match[0] : 'https://' + match[0];
  }
  return null;
}

// --- Main command ---
async function instagramCommand(sock, chatId, message) {
  try {
    if (processedMessages.has(message.key.id)) return;
    processedMessages.set(message.key.id, Date.now());
    setTimeout(() => processedMessages.delete(message.key.id), 5 * 60 * 1000);

    const text = message.message?.conversation ||
                 message.message?.extendedTextMessage?.text ||
                 message.message?.imageMessage?.caption ||
                 '';
    if (!text) return;

    const url = extractUrl(text);
    if (!url) return;

    await sock.sendMessage(chatId, { react: { text: '🔄', key: message.key } });

    // Try APIs in order
    let mediaItems = null;
    const apis = [
      { name: 'ruhend-scraper', fn: () => fetchRuhend(url) },
      { name: 'InstaDownloader', fn: () => fetchInstaDownloader(url) },
      { name: 'InstaSave', fn: () => fetchInstaSave(url) },
    ];

    for (const { name, fn } of apis) {
      try {
        const result = await fn();
        if (result && result.length > 0) {
          mediaItems = result;
          console.log(`📸 Instagram: ${name} OK for ${url.slice(0, 60)}`);
          break;
        }
      } catch (e) {
        console.log(`📸 Instagram: ${name} fail - ${e.message.slice(0, 80)}`);
      }
    }

    if (!mediaItems || mediaItems.length === 0) {
      return await sock.sendMessage(chatId, {
        text: '❌ Could not download this Instagram content. The post might be private or the link is invalid.'
      });
    }

    // Deduplicate
    const seen = new Set();
    const uniqueItems = mediaItems.filter(m => {
      if (!m.url || seen.has(m.url)) return false;
      seen.add(m.url);
      for (const key of ['thumbnail', 'thumb', 'preview']) {
        if (m[key] && !seen.has(m[key])) seen.add(m[key]);
      }
      return true;
    });

    let sentCount = 0;

    for (let i = 0; i < Math.min(uniqueItems.length, 10); i++) {
      try {
        const item = uniqueItems[i];
        const isVideo = detectMediaType(item, url);

        if (isVideo) {
          // Video: try buffer first for reliability
          try {
            const buf = await downloadBuffer(item.url);
            await sock.sendMessage(chatId, {
              video: buf,
              mimetype: 'video/mp4',
              caption: CAPTION
            });
          } catch {
            // Fallback to URL send
            await sock.sendMessage(chatId, {
              video: { url: item.url },
              mimetype: 'video/mp4',
              caption: CAPTION
            });
          }
        } else {
          // Image: try buffer first
          try {
            const buf = await downloadBuffer(item.url);
            await sock.sendMessage(chatId, {
              image: buf,
              caption: CAPTION
            });
          } catch {
            await sock.sendMessage(chatId, {
              image: { url: item.url },
              caption: CAPTION
            });
          }
        }

        sentCount++;
        if (i < uniqueItems.length - 1 && i < 9) {
          await new Promise(r => setTimeout(r, 1200));
        }
      } catch (mediaError) {
        console.error(`📸 Instagram item ${i + 1} error:`, mediaError.message);
      }
    }

    if (sentCount === 0) {
      await sock.sendMessage(chatId, {
        text: '❌ Failed to download media from the Instagram link. Try again later.'
      });
    }

  } catch (error) {
    console.error('📸 Instagram error:', error.message);
    try {
      await sock.sendMessage(chatId, { text: '❌ Error processing Instagram request. Try again later.' });
    } catch {}
  }
}

module.exports = instagramCommand;
