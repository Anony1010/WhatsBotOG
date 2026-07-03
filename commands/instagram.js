const { igdl } = require("ruhend-scraper");
const axios = require("axios");

const processedMessages = new Map();
const CAPTION = "DOWNLOADED BY GASHAM";

// Instagram URL patterns (supports all public link types)
const IG_URL_PATTERNS = [
  /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:p|reel|tv)\/[a-zA-Z0-9_\-]+/i,
  /(?:https?:\/\/)?(?:www\.)?instagram\.com\/stories\/[a-zA-Z0-9_.\-]+\/[0-9]+/i,
  /(?:https?:\/\/)?(?:www\.)?instagram\.com\/[a-zA-Z0-9_.\-]+\/(?:p|reel|tv)\/[a-zA-Z0-9_\-]+/i,
  /(?:https?:\/\/)?(?:www\.)?instagr\.am\/(?:p|reel|tv)\/[a-zA-Z0-9_\-]+/i,
  /(?:https?:\/\/)?(?:www\.)?instagram\.com\/[a-zA-Z0-9_.\-]+\/[a-zA-Z0-9_\-?=]+/i,
];

function extractUrl(text) {
  for (const pattern of IG_URL_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[0].startsWith("http") ? match[0] : "https://" + match[0];
  }
  return null;
}

function deduplicateMedia(mediaItems) {
  const seen = new Set();
  return mediaItems.filter(m => {
    if (!m.url || seen.has(m.url)) return false;
    seen.add(m.url);
    return true;
  });
}

async function downloadMediaBuffer(url) {
  const res = await axios.get(url, { responseType: "arraybuffer", timeout: 60000 });
  return Buffer.from(res.data);
}

/**
 * Instagram command - downloads media from Instagram links
 * Priority: URL streaming (fast) → Buffer download (reliable)
 * Inspired by Knightbot-MD download logic
 */
async function instagramCommand(sock, chatId, message) {
  try {
    // Deduplicate message processing
    if (processedMessages.has(message.key.id)) return;
    processedMessages.set(message.key.id, Date.now());
    setTimeout(() => processedMessages.delete(message.key.id), 5 * 60 * 1000);

    const text = (
      message.message?.conversation ||
      message.message?.extendedTextMessage?.text ||
      message.message?.imageMessage?.caption ||
      ""
    ).trim();
    if (!text) return;

    const url = extractUrl(text);
    if (!url) return;

    await sock.sendMessage(chatId, { react: { text: "🔄", key: message.key } });

    // Fetch media metadata via igdl (ruhend-scraper)
    let mediaItems = null;
    try {
      const result = await igdl(url);
      if (result?.data?.length > 0) {
        mediaItems = result.data;
      }
    } catch (e) {
      console.log("📸 IG: ruhend-scraper fail:", e.message.slice(0, 60));
    }

    if (!mediaItems || mediaItems.length === 0) {
      return await sock.sendMessage(chatId, {
        text: "❌ Could not download this content. The post might be private or the link is invalid."
      });
    }

    // Deduplicate by URL
    const uniqueItems = deduplicateMedia(mediaItems);

    // Process up to 10 items
    const maxItems = Math.min(uniqueItems.length, 10);
    let sentCount = 0;

    for (let i = 0; i < maxItems; i++) {
      try {
        const item = uniqueItems[i];
        const mediaUrl = item.url;
        const isVideo =
          item.type === "video" ||
          /\.(mp4|mov|avi|mkv|webm)$/i.test(mediaUrl) ||
          /\/reel\//.test(url) ||
          /\/tv\//.test(url);

        if (isVideo) {
          // Primary: URL streaming (fast, from Knightbot logic)
          try {
            await sock.sendMessage(chatId, {
              video: { url: mediaUrl },
              mimetype: "video/mp4",
              caption: CAPTION
            });
          } catch (urlErr) {
            // Fallback: buffer download + send
            try {
              const buf = await downloadMediaBuffer(mediaUrl);
              await sock.sendMessage(chatId, {
                video: buf,
                mimetype: "video/mp4",
                caption: CAPTION
              });
            } catch (bufErr) {
              console.log("📸 IG: buffer fallback also failed:", bufErr.message.slice(0, 40));
              throw bufErr;
            }
          }
        } else {
          // Image - URL streaming primary
          try {
            await sock.sendMessage(chatId, {
              image: { url: mediaUrl },
              caption: CAPTION
            });
          } catch {
            const buf = await downloadMediaBuffer(mediaUrl);
            await sock.sendMessage(chatId, {
              image: buf,
              caption: CAPTION
            });
          }
        }

        sentCount++;
        if (i < maxItems - 1) {
          await new Promise(r => setTimeout(r, 1000));
        }
      } catch (itemErr) {
        console.error("📸 IG item", i + 1, "error:", itemErr.message);
      }
    }

    if (sentCount === 0) {
      await sock.sendMessage(chatId, {
        text: "❌ Failed to download media. Try again later."
      });
    }

  } catch (error) {
    console.error("📸 IG error:", error.message);
    try {
      await sock.sendMessage(chatId, { text: "❌ Error processing request. Try again later." });
    } catch {}
  }
}

module.exports = instagramCommand;
