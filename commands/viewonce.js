const { downloadContentFromMessage } = require("@whiskeysockets/baileys");

async function downloadMedia(msg, type) {
    const stream = await downloadContentFromMessage(msg, type);
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
        if (Buffer.concat(chunks).length > 100 * 1024 * 1024) {
            throw new Error('Media too large (max 100MB)');
        }
    }
    return Buffer.concat(chunks);
}

async function viewonceCommand(sock, chatId, message) {
    try {
        const contextInfo = message.message?.extendedTextMessage?.contextInfo;
        if (!contextInfo?.quotedMessage) {
            return await sock.sendMessage(chatId, { text: 'Please reply to a view-once image/video/audio with .vv' }, { quoted: message });
        }
        
        const quoted = contextInfo.quotedMessage;
        
        // Find view-once media in all possible formats
        let foundMedia = null;
        let mediaType = null;
        let mimeType = null;
        
        // Check all possible view-once container formats
        const containers = [
            quoted.viewOnceMessageV2?.message,
            quoted.viewOnceMessageV2Extension?.message,
            quoted.viewOnceMessage,
            quoted.viewOnceMessageV2?.message?.viewOnceMessageV2Extension?.message,
            quoted,
        ];
        
        for (const container of containers) {
            if (!container) continue;
            for (const [type, content] of Object.entries(container)) {
                if (['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage'].includes(type)) {
                    foundMedia = content;
                    mediaType = type.replace('Message', '');
                    mimeType = content.mimetype || (
                        mediaType === 'image' ? 'image/jpeg' : 
                        mediaType === 'video' ? 'video/mp4' : 
                        mediaType === 'audio' ? 'audio/ogg' :
                        mediaType === 'document' ? 'application/octet-stream' :
                        'image/webp'
                    );
                    break;
                }
            }
            if (foundMedia) break;
        }

        if (!foundMedia) {
            return await sock.sendMessage(chatId, { 
                text: 'No view-once media found. Reply to a view-once image, video, audio, sticker, or document with .vv' 
            }, { quoted: message });
        }

        // Download media silently (no reactions, no messages)
        const buffer = await downloadMedia(foundMedia, mediaType);
        if (!buffer || buffer.length === 0) throw new Error('Empty buffer');

        // Build send options based on media type
        const sendOpts = {};

        if (mediaType === 'image') {
            sendOpts.image = buffer;
            sendOpts.caption = foundMedia.caption || '';
            sendOpts.mimetype = mimeType;
        } else if (mediaType === 'video') {
            sendOpts.video = buffer;
            sendOpts.caption = foundMedia.caption || '';
            sendOpts.mimetype = mimeType;
        } else if (mediaType === 'audio') {
            sendOpts.audio = buffer;
            sendOpts.ptt = foundMedia.ptt || false;
            sendOpts.mimetype = mimeType;
        } else if (mediaType === 'sticker') {
            sendOpts.sticker = buffer;
        } else if (mediaType === 'document') {
            sendOpts.document = buffer;
            sendOpts.caption = foundMedia.caption || '';
            sendOpts.fileName = foundMedia.fileName || 'document';
            sendOpts.mimetype = foundMedia.mimetype || 'application/octet-stream';
        }

        // Send as normal media (NOT view-once)
        await sock.sendMessage(chatId, sendOpts, { quoted: message });
        
    } catch (err) {
        console.error('❌ ViewOnce error:', err.message);
        // Only show error if we haven't sent anything
        try {
            await sock.sendMessage(chatId, { text: '❌ An error occurred. Please try again.' }, { quoted: message });
        } catch(e) {}
    }
}

module.exports = viewonceCommand;
