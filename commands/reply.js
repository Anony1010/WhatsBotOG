const fs = require("fs");
const path = require("path");
const axios = require("axios");
const ytdlExec = require('youtube-dl-exec');
const { igdl, ttdl } = require("ruhend-scraper");

const DATA_FILE = path.join(__dirname, "..", "data", "reply.json");
const TEMP_DIR = path.join(__dirname, "..", "temp");
fs.mkdirSync(TEMP_DIR, { recursive: true });

// YouTube URL patterns - all formats
const YT_PATTERNS = [
  /https?:\/\/(?:www\.)?youtube\.com\/watch\?v=[\w-]+/i,
  /https?:\/\/youtu\.be\/[\w-]+/i,
  /https?:\/\/(?:www\.)?youtube\.com\/shorts\/[\w-]+/i,
  /https?:\/\/(?:m\.|music\.)?youtube\.com\/watch\?v=[\w-]+/i,
  /https?:\/\/(?:m\.|music\.)?youtube\.com\/shorts\/[\w-]+/i,
  /https?:\/\/(?:www\.)?youtube\.com\/embed\/[\w-]+/i,
  /https?:\/\/(?:www\.)?youtube\.com\/v\/[\w-]+/i,
];

const IG_PATTERNS = [
  /https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|tv)\/[\w-]+\/?/i,
  /https?:\/\/(?:www\.)?instagram\.com\/stories\/[\w.-]+\/[\d]+\/?/i,
];
const TT_PATTERNS = [
  /https?:\/\/(?:www\.)?tiktok\.com\/@[\w.-]+\/video\/\d+/i,
  /https?:\/\/(?:www\.)?tiktok\.com\/t\/[\w-]+\/?/i,
  /https?:\/\/(?:vm|vt)\.tiktok\.com\/[\w-]+\/?/i,
];

function readState() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch (e) {}
  return { enabled: false };
}

function writeState(state) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(state)); } catch (e) {}
}

function isReplyEnabled() {
  return readState().enabled === true;
}

function extractUrl(text) {
  const m = text.match(/https?:\/\/[^\s]+/i);
  return m ? m[0] : null;
}

function detectPlatform(url) {
  for (const pat of YT_PATTERNS) if (pat.test(url)) return "youtube";
  for (const pat of IG_PATTERNS) if (pat.test(url)) return "instagram";
  for (const pat of TT_PATTERNS) if (pat.test(url)) return "tiktok";
  return null;
}

// ============ YOUTUBE DOWNLOAD (ytdl-core + ffmpeg) ============
// Inspired by Knightbot-MD ytdl2.js logic
async function downloadYouTube(sock, chatId, url) {
  let tempFilePath = null;
  try {
    const ytdl = require('ytdl-core');
    
    // Send thumbnail with video info
    try {
      const info = await ytdl.getInfo(url, { lang: 'en' });
      const details = info.videoDetails;
      const thumb = details.thumbnails?.slice(-1)?.[0]?.url || details.thumbnails?.[0]?.url;
      if (thumb) {
        await sock.sendMessage(chatId, {
          image: { url: thumb },
          caption: `${details.title}\n👤 ${details.author?.name || '?'}\n⏱ ${new Date(details.lengthSeconds * 1000).toISOString().substr(11, 8)}\n\nDOWNLOADED BY GASHAM`
        });
      }
    } catch (thumbErr) {
      console.log("YT thumb error:", thumbErr.message);
    }

    // Download audio via ytdl-core stream + ffmpeg MP3 conversion
    const tmpName = `yt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp3`;
    tempFilePath = path.join(TEMP_DIR, tmpName);

    // Method 1: ytdl-core audio stream + ffmpeg (primary, like Knightbot)
    try {
      const ffmpeg = require('fluent-ffmpeg');
      const stream = ytdl(url, {
        quality: 'highestaudio',
        filter: 'audioonly',
      });

      await new Promise((resolve, reject) => {
        ffmpeg(stream)
          .audioBitrate(128)
          .audioFrequency(44100)
          .audioChannels(2)
          .audioCodec('libmp3lame')
          .toFormat('mp3')
          .save(tempFilePath)
          .on('end', () => {
            if (fs.existsSync(tempFilePath) && fs.statSync(tempFilePath).size > 1000) resolve();
            else reject(new Error('File empty after conversion'));
          })
          .on('error', (err) => reject(err));
      });

      const fileSize = (fs.statSync(tempFilePath).size / 1024 / 1024).toFixed(2);
      console.log(`✅ YT audio: ${fileSize}MB`);

      await sock.sendMessage(chatId, {
        audio: { url: tempFilePath },
        mimetype: 'audio/mpeg',
        fileName: `youtube_audio_${Date.now()}.mp3`,
        caption: 'DOWNLOADED BY GASHAM'
      });

      try { fs.unlinkSync(tempFilePath); tempFilePath = null; } catch {}
      return true;
    } catch (e) {
      console.log("YT ytdl-core+ffmpeg failed:", e.message.slice(0, 60));
      if (tempFilePath) { try { fs.unlinkSync(tempFilePath); } catch {} }
    }

    // Method 2: yt-dlp direct download (fallback)
    try {
      const ytdlExec = require('youtube-dl-exec');
      const tmpName2 = `yt2_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.m4a`;
      tempFilePath = path.join(TEMP_DIR, tmpName2);

      await ytdlExec(url, {
        format: 'bestaudio[ext=m4a]/bestaudio',
        output: tempFilePath,
        noCheckCertificates: true,
        preferFreeFormats: true,
        noWarnings: true,
        geoBypass: true,
      });

      if (fs.existsSync(tempFilePath) && fs.statSync(tempFilePath).size > 1000) {
        const fileSize = (fs.statSync(tempFilePath).size / 1024 / 1024).toFixed(2);
        console.log(`✅ YT audio (yt-dlp): ${fileSize}MB`);
        await sock.sendMessage(chatId, {
          audio: { url: tempFilePath },
          mimetype: 'audio/mp4',
          fileName: `youtube_audio_${Date.now()}.m4a`,
          caption: 'DOWNLOADED BY GASHAM'
        });
        try { fs.unlinkSync(tempFilePath); tempFilePath = null; } catch {}
        return true;
      }
    } catch (e2) { console.log("YT yt-dlp fallback failed:", e2.message?.slice(0, 60)); }

    return false;
  } catch (e) {
    console.error("YT download failed:", e.message);
    if (tempFilePath) { try { fs.unlinkSync(tempFilePath); } catch {} }
    return false;
  }
}

// ============ INSTAGRAM DOWNLOAD (URL streaming primary) ============
async function downloadInstagram(sock, chatId, url) {
  try {
    const result = await igdl(url);
    if (result?.data?.length > 0) {
      for (const item of result.data) {
        const mediaUrl = item.url || item.downloadUrl || item;
        const isVideo = item.type === 'video' || /\.(mp4|mov|webm)$/i.test(mediaUrl) || /\/reel\/|\/tv\//.test(url);
        if (isVideo) {
          // Primary: URL streaming (fast)
          try {
            await sock.sendMessage(chatId, { video: { url: mediaUrl }, mimetype: 'video/mp4', caption: 'DOWNLOADED BY GASHAM' });
          } catch {
            // Fallback: buffer download
            const res = await axios.get(typeof mediaUrl === "string" ? mediaUrl : mediaUrl, { responseType: "arraybuffer", timeout: 30000 });
            await sock.sendMessage(chatId, { video: Buffer.from(res.data), mimetype: 'video/mp4', caption: 'DOWNLOADED BY GASHAM' });
          }
        } else {
          try {
            await sock.sendMessage(chatId, { image: { url: mediaUrl }, caption: 'DOWNLOADED BY GASHAM' });
          } catch {
            const res = await axios.get(typeof mediaUrl === "string" ? mediaUrl : mediaUrl, { responseType: "arraybuffer", timeout: 30000 });
            await sock.sendMessage(chatId, { image: Buffer.from(res.data), caption: 'DOWNLOADED BY GASHAM' });
          }
        }
      }
      return true;
    }
    return false;
  } catch (e) { console.log("IG download error:", e.message); return false; }
}

// ============ TIKTOK DOWNLOAD ============
async function downloadTikTok(sock, chatId, url) {
  try {
    try {
      const result = await ttdl(url);
      if (result?.video) {
        const res = await axios.get(result.video, { responseType: "arraybuffer", timeout: 30000 });
        await sock.sendMessage(chatId, { video: Buffer.from(res.data), caption: 'DOWNLOADED BY GASHAM' });
        return true;
      }
      if (result?.data?.length > 0) {
        for (const item of result.data) {
          const mediaUrl = item.url || item;
          const res = await axios.get(typeof mediaUrl === "string" ? mediaUrl : mediaUrl, {
            responseType: "arraybuffer", timeout: 30000,
          });
          await sock.sendMessage(chatId, { video: Buffer.from(res.data), caption: 'DOWNLOADED BY GASHAM' });
        }
        return true;
      }
    } catch (e) { console.log("ttdl failed:", e.message); }

    try {
      const res = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`, { timeout: 15000 });
      if (res.data?.data?.play) {
        const mediaRes = await axios.get(res.data.data.play, { responseType: "arraybuffer", timeout: 30000 });
        await sock.sendMessage(chatId, { video: Buffer.from(mediaRes.data), caption: 'DOWNLOADED BY GASHAM' });
        return true;
      }
    } catch (e) { console.log("TikWM failed:", e.message); }
    return false;
  } catch (e) { console.log("TT download error:", e.message); return false; }
}

// ============ MAIN HANDLER ============
async function replyCommand(sock, chatId, message, args) {
  const text = args.join(" ").trim().toLowerCase();

  // Handle .reply on / .reply off
  if (text === "on") {
    writeState({ enabled: true });
    await sock.sendMessage(chatId, {
      text: "✅ *Reply Mode ON*\n\n"
        + "• Auto-download is now *disabled*.\n"
        + "• Reply to a media link with `.reply` to download manually."
    });
    return;
  }

  if (text === "off") {
    writeState({ enabled: false });
    await sock.sendMessage(chatId, {
      text: "❌ *Reply Mode OFF*\n\n"
        + "• Auto-download is now *enabled*.\n"
        + "• Simply send a media link → auto-download.\n"
        + "• Auto-download enabled for all supported media."
    });
    return;
  }

  // Handle .reply with link from replied message (manual download)
  if (message.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
    const quoted = message.message.extendedTextMessage.contextInfo.quotedMessage;
    const quotedText =
      quoted.conversation ||
      quoted.extendedTextMessage?.text ||
      quoted.imageMessage?.caption ||
      quoted.videoMessage?.caption ||
      "";

    const url = extractUrl(quotedText);
    if (!url) {
      await sock.sendMessage(chatId, {
        text: "❌ Reply to a valid media link with `.reply`.",
      });
      return;
    }

    const platform = detectPlatform(url);
    if (!platform) {
      await sock.sendMessage(chatId, {
        text: "❌ Unsupported link format.",
      });
      return;
    }

    await sock.sendMessage(chatId, { react: { text: "🔄", key: message.key } });

    let success = false;
    if (platform === "youtube") success = await downloadYouTube(sock, chatId, url);
    else if (platform === "instagram") success = await downloadInstagram(sock, chatId, url);
    else if (platform === "tiktok") success = await downloadTikTok(sock, chatId, url);

    if (!success) {
      await sock.sendMessage(chatId, {
        text: "❌ Download failed. The link may be invalid or service unavailable.",
      });
    }
    return;
  }

  // Show help
  await sock.sendMessage(chatId, {
    text: "📥 *Reply Download System*\n\n"
      + "Status: " + (isReplyEnabled() ? "✅ ON (Manual)" : "❌ OFF (Auto)") + "\n\n"
      + "• `.reply off` → Auto-download media links\n"
      + "• `.reply on` → Manual download via `.reply` to link\n\n"
      + "Supported: All media links"
  });
}

// ============ AUTO-DOWNLOAD HANDLER ============
async function handleAutoDownload(sock, chatId, text, message) {
  // When reply is OFF: auto-download YouTube/IG/TT links
  // When reply is ON: do nothing (user must .reply manually)
  if (isReplyEnabled()) return false;

  const url = extractUrl(text);
  if (!url) return false;

  const platform = detectPlatform(url);
  if (!platform) return false;

  await sock.sendMessage(chatId, { react: { text: "🔄", key: message.key } });

  let success = false;
  if (platform === "youtube") success = await downloadYouTube(sock, chatId, url);
  else if (platform === "instagram") success = await downloadInstagram(sock, chatId, url);
  else if (platform === "tiktok") success = await downloadTikTok(sock, chatId, url);

  return success;
}

module.exports = { replyCommand, handleAutoDownload, isReplyEnabled };
