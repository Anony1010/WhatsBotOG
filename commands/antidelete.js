const fs = require('fs');
const path = require('path');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

const CONFIG_PATH = path.join(__dirname, '../data/antidelete.json');
const STORE_PATH = path.join(__dirname, '../data/antidelete_store.json');
const TEMP_MEDIA_DIR = path.join(__dirname, '../tmp/antidelete');
const MAX_STORED_MSGS = 500;

fs.mkdirSync(TEMP_MEDIA_DIR, { recursive: true });

// ====== CONFIG MANAGEMENT ======
function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { enabled: false };
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch { return { enabled: false }; }
}
function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch (e) {}
}

// ====== PERSISTENT MESSAGE STORE ======
let messageStore = {};
try {
  if (fs.existsSync(STORE_PATH)) messageStore = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
} catch (e) { messageStore = {}; }

function saveStore() {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(messageStore, null, 2));
  } catch (e) { console.error('antidelete store save error:', e.message); }
}

function storeMessageData(msgId, data) {
  // Limit store size
  const keys = Object.keys(messageStore);
  if (keys.length >= MAX_STORED_MSGS) {
    // Remove oldest 100
    const sorted = keys.sort((a, b) => (messageStore[a]?.timestamp || 0) - (messageStore[b]?.timestamp || 0));
    const toRemove = sorted.slice(0, 100);
    for (const k of toRemove) {
      // Clean up media files
      if (messageStore[k]?.mediaPath && fs.existsSync(messageStore[k].mediaPath)) {
        try { fs.unlinkSync(messageStore[k].mediaPath); } catch (e) {}
      }
      delete messageStore[k];
    }
  }
  messageStore[msgId] = data;
  saveStore();
}

function getStoredMessage(msgId) {
  return messageStore[msgId] || null;
}

function deleteStoredMessage(msgId) {
  if (messageStore[msgId]) {
    if (messageStore[msgId].mediaPath && fs.existsSync(messageStore[msgId].mediaPath)) {
      try { fs.unlinkSync(messageStore[msgId].mediaPath); } catch (e) {}
    }
    delete messageStore[msgId];
    saveStore();
  }
}

// ====== TEMP CLEANUP ======
function cleanTempFolder() {
  try {
    const files = fs.readdirSync(TEMP_MEDIA_DIR);
    let totalSize = 0;
    for (const file of files) {
      const fp = path.join(TEMP_MEDIA_DIR, file);
      try { totalSize += fs.statSync(fp).size; } catch (e) {}
    }
    if (totalSize > 200 * 1024 * 1024) { // > 200MB
      for (const file of files) {
        try { fs.unlinkSync(path.join(TEMP_MEDIA_DIR, file)); } catch (e) {}
      }
      console.log('🧹 Antidelete temp cleaned (>200MB)');
    }
  } catch (e) {}
}
setInterval(cleanTempFolder, 5 * 60 * 1000);

// ====== OWNER CHECK ======
const isOwnerOrSudo = require('../lib/isOwner');

// ====== COMMAND HANDLER ======
async function handleAntideleteCommand(sock, chatId, message, match) {
  const senderId = message.key.participant || message.key.remoteJid;
  const isOwner = await isOwnerOrSudo(senderId, sock, chatId);

  if (!message.key.fromMe && !isOwner) {
    return sock.sendMessage(chatId, { text: '*Only the bot owner can use this command.*' }, { quoted: message });
  }

  const config = loadConfig();

  if (!match) {
    return sock.sendMessage(chatId, {
      text: `*ANTIDELETE*\n\nStatus: ${config.enabled ? '✅ Enabled' : '❌ Disabled'}\nStored: ${Object.keys(messageStore).length} messages\n\n*.antidelete on* - Enable\n*.antidelete off* - Disable`
    }, { quoted: message });
  }

  if (match === 'on') {
    config.enabled = true;
    saveConfig(config);
    return sock.sendMessage(chatId, { text: '*Antidelete enabled* ✅' }, { quoted: message });
  } else if (match === 'off') {
    config.enabled = false;
    saveConfig(config);
    return sock.sendMessage(chatId, { text: '*Antidelete disabled* ❌' }, { quoted: message });
  } else {
    return sock.sendMessage(chatId, { text: 'Usage: .antidelete on / .antidelete off' }, { quoted: message });
  }
}

// ====== DOWNLOAD HELPER ======
async function downloadMediaToFile(msg, mediaType, msgId) {
  try {
    const extMap = { image: 'jpg', video: 'mp4', audio: 'ogg', sticker: 'webp', document: 'bin' };
    const ext = extMap[mediaType] || 'bin';
    const filePath = path.join(TEMP_MEDIA_DIR, `${msgId}.${ext}`);

    const stream = await downloadContentFromMessage(msg, mediaType);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    if (buffer.length > 0 && buffer.length < 100 * 1024 * 1024) {
      fs.writeFileSync(filePath, buffer);
      return filePath;
    }
  } catch (e) {
    console.log(`antidelete download ${mediaType} error: ${e.message.slice(0, 60)}`);
  }
  return null;
}

// ====== STORE MESSAGES (called on every message) ======
async function storeMessage(sock, message) {
  try {
    const config = loadConfig();
    if (!config.enabled) return;
    if (!message.key?.id) return;

    const msgId = message.key.id;
    const sender = message.key.participant || message.key.remoteJid;
    const isGroup = message.key.remoteJid.endsWith('@g.us');
    const msg = message.message;
    if (!msg) return;

    // Extract reply context
    let replyTo = null;
    const extCtx = msg.extendedTextMessage?.contextInfo;
    if (extCtx) {
      replyTo = {
        id: extCtx.stanzaId || null,
        sender: extCtx.participant || null,
        text: extCtx.quotedMessage?.conversation ||
              extCtx.quotedMessage?.extendedTextMessage?.text ||
              (extCtx.quotedMessage?.imageMessage?.caption) ||
              (extCtx.quotedMessage?.videoMessage?.caption) || ''
      };
    }

    // Unwrap view-once
    const vvMsg = msg.viewOnceMessageV2?.message || msg.viewOnceMessage?.message;

    let content = '';
    let mediaType = '';
    let mediaPath = '';
    let fileName = '';
    let mimeType = '';

    // Check all message types
    if (vvMsg) {
      // View-once message
      if (vvMsg.imageMessage) {
        mediaType = 'image'; content = vvMsg.imageMessage.caption || '';
        mediaPath = await downloadMediaToFile(vvMsg.imageMessage, 'image', msgId) || '';
      } else if (vvMsg.videoMessage) {
        mediaType = 'video'; content = vvMsg.videoMessage.caption || '';
        mediaPath = await downloadMediaToFile(vvMsg.videoMessage, 'video', msgId) || '';
      } else if (vvMsg.audioMessage) {
        mediaType = 'audio';
        mediaPath = await downloadMediaToFile(vvMsg.audioMessage, 'audio', msgId) || '';
        fileName = vvMsg.audioMessage.ptt ? 'voice_message' : 'audio';
      } else if (vvMsg.documentMessage) {
        mediaType = 'document'; content = vvMsg.documentMessage.caption || '';
        fileName = vvMsg.documentMessage.fileName || 'document';
        mediaPath = await downloadMediaToFile(vvMsg.documentMessage, 'document', msgId) || '';
      } else if (vvMsg.stickerMessage) {
        mediaType = 'sticker';
        mediaPath = await downloadMediaToFile(vvMsg.stickerMessage, 'sticker', msgId) || '';
      }
    } else if (msg.conversation) {
      content = msg.conversation;
    } else if (msg.extendedTextMessage?.text) {
      content = msg.extendedTextMessage.text;
    } else if (msg.imageMessage) {
      mediaType = 'image'; content = msg.imageMessage.caption || '';
      mediaPath = await downloadMediaToFile(msg.imageMessage, 'image', msgId) || '';
    } else if (msg.videoMessage) {
      mediaType = 'video'; content = msg.videoMessage.caption || '';
      mediaPath = await downloadMediaToFile(msg.videoMessage, 'video', msgId) || '';
    } else if (msg.audioMessage) {
      mediaType = 'audio';
      mediaPath = await downloadMediaToFile(msg.audioMessage, 'audio', msgId) || '';
      fileName = msg.audioMessage.ptt ? 'voice_message' : 'audio';
    } else if (msg.stickerMessage) {
      mediaType = 'sticker';
      mediaPath = await downloadMediaToFile(msg.stickerMessage, 'sticker', msgId) || '';
    } else if (msg.documentMessage) {
      mediaType = 'document'; content = msg.documentMessage.caption || '';
      fileName = msg.documentMessage.fileName || 'document';
      mimeType = msg.documentMessage.mimetype || '';
      mediaPath = await downloadMediaToFile(msg.documentMessage, 'document', msgId) || '';
    } else if (msg.contactMessage) {
      content = `👤 ${msg.contactMessage.displayName || 'Contact'}\n${msg.contactMessage.vcard || ''}`;
      mediaType = 'contact';
    } else if (msg.locationMessage) {
      content = `📍 Location: ${msg.locationMessage.degreesLatitude || ''}, ${msg.locationMessage.degreesLongitude || ''}`;
      if (msg.locationMessage.name) content += `\n🏷 ${msg.locationMessage.name}`;
      mediaType = 'location';
    } else if (msg.groupInviteMessage) {
      content = `🔗 Group Invite: ${msg.groupInviteMessage.groupName || ''}`;
    } else if (msg.liveLocationMessage) {
      content = '📍 Live Location';
    } else if (msg.pollCreationMessage) {
      content = `📊 Poll: ${msg.pollCreationMessage.name || ''}`;
      mediaType = 'poll';
    } else if (msg.buttonsResponseMessage) {
      content = `🔘 ${msg.buttonsResponseMessage.selectedButtonId || ''}`;
    } else if (msg.listResponseMessage) {
      content = `📋 ${msg.listResponseMessage.singleSelectReply?.selectedRowId || ''}`;
    } else if (msg.reactionMessage) {
      // Don't store reactions as deletable messages
      return;
    } else if (msg.protocolMessage) {
      // Don't store protocol messages
      return;
    }

    // Don't store empty
    if (!content && !mediaType) return;

    storeMessageData(msgId, {
      sender,
      group: isGroup ? message.key.remoteJid : null,
      content,
      mediaType,
      mediaPath,
      fileName,
      mimeType,
      replyTo,
      timestamp: Date.now(),
      chatName: message.pushName || ''
    });

    // Anti-ViewOnce: forward view-once media to owner immediately
    if (vvMsg && mediaPath && fs.existsSync(mediaPath)) {
      try {
        const ownerJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
        const senderName = sender.split('@')[0];
        const cap = `🔓 *Anti-ViewOnce ${mediaType}*\nFrom: @${senderName}`;
        const opts = { caption: cap, mentions: [sender] };

        if (mediaType === 'image') await sock.sendMessage(ownerJid, { image: { url: mediaPath }, ...opts });
        else if (mediaType === 'video') await sock.sendMessage(ownerJid, { video: { url: mediaPath }, ...opts });
        else if (mediaType === 'audio') await sock.sendMessage(ownerJid, { audio: { url: mediaPath }, mimetype: 'audio/ogg', ...opts });
        else if (mediaType === 'document') await sock.sendMessage(ownerJid, { document: { url: mediaPath }, fileName: fileName || 'document', ...opts });

        // Clean up view-once media after forwarding
        setTimeout(() => {
          try { if (fs.existsSync(mediaPath)) fs.unlinkSync(mediaPath); } catch (e) {}
          if (messageStore[msgId]) { messageStore[msgId].mediaPath = ''; saveStore(); }
        }, 5000);
      } catch (e) { console.error('antidelete vv forward error:', e.message); }
    }
  } catch (err) {
    console.error('antidelete storeMessage error:', err.message);
  }
}

// ====== HANDLE MESSAGE REVOCATION (deletion) ======
async function handleMessageRevocation(sock, revocationMessage) {
  try {
    const config = loadConfig();
    if (!config.enabled) return;

    const deletedMsgId = revocationMessage.message?.protocolMessage?.key?.id;
    if (!deletedMsgId) return;

    const deletedBy = revocationMessage.participant || revocationMessage.key.participant || revocationMessage.key.remoteJid;
    const ownerJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';

    // Don't report self-deletions
    if (deletedBy === ownerJid) return;

    const original = getStoredMessage(deletedMsgId);
    if (!original) return;

    const sender = original.sender;
    const senderName = sender.split('@')[0];
    const deletedByName = deletedBy.split('@')[0];

    // Get group name if applicable
    let groupName = '';
    if (original.group) {
      try {
        const meta = await sock.groupMetadata(original.group);
        groupName = meta.subject || '';
      } catch (e) {}
    }

    const time = new Date().toLocaleString('en-US', {
      timeZone: 'Asia/Kolkata', hour12: true,
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      day: '2-digit', month: '2-digit', year: 'numeric'
    });

    const mediaEmoji = {
      image: '🖼', video: '🎥', audio: '🎵', sticker: '🏷',
      document: '📄', contact: '👤', location: '📍', poll: '📊'
    };

    let text = `*🔰 ANTIDELETE* 🔰\n\n` +
      `*🗑 Deleted By:* @${deletedByName}\n` +
      `*👤 Sender:* @${senderName}\n` +
      `*📱 Number:* ${sender}\n` +
      `*🕒 Time:* ${time}\n`;

    if (groupName) text += `*👥 Group:* ${groupName}\n`;
    if (original.mediaType) text += `*📎 Type:* ${mediaEmoji[original.mediaType] || '📎'} ${original.mediaType}\n`;

    // Reply context
    if (original.replyTo?.text) {
      text += `\n*💬 Replied to:* ${original.replyTo.text.slice(0, 100)}`;
    }

    if (original.content) {
      text += `\n\n*💬 Deleted Message:*\n${original.content}`;
    }

    await sock.sendMessage(ownerJid, { text, mentions: [deletedBy, sender] });

    // Send media if available
    if (original.mediaType && original.mediaPath && fs.existsSync(original.mediaPath)) {
      const cap = `*Deleted ${original.mediaType}*\nFrom: @${senderName}`;
      const opts = { caption: cap, mentions: [sender] };

      try {
        switch (original.mediaType) {
          case 'image':
            await sock.sendMessage(ownerJid, { image: { url: original.mediaPath }, ...opts });
            break;
          case 'video':
            await sock.sendMessage(ownerJid, { video: { url: original.mediaPath }, ...opts });
            break;
          case 'audio':
            await sock.sendMessage(ownerJid, {
              audio: { url: original.mediaPath },
              mimetype: 'audio/ogg',
              ptt: original.fileName === 'voice_message' || false,
              ...opts
            });
            break;
          case 'sticker':
            await sock.sendMessage(ownerJid, { sticker: { url: original.mediaPath } });
            break;
          case 'document':
            await sock.sendMessage(ownerJid, {
              document: { url: original.mediaPath },
              fileName: original.fileName || 'document',
              mimetype: original.mimeType || 'application/octet-stream',
              ...opts
            });
            break;
        }
      } catch (e) {
        console.error('antidelete media send error:', e.message);
      }

      // Clean up media file
      try { if (fs.existsSync(original.mediaPath)) fs.unlinkSync(original.mediaPath); } catch (e) {}
    }

    deleteStoredMessage(deletedMsgId);
  } catch (err) {
    console.error('antidelete handleMessageRevocation error:', err.message);
  }
}

module.exports = {
  handleAntideleteCommand,
  handleMessageRevocation,
  storeMessage
};
