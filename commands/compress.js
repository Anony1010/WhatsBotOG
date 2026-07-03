const fs = require('fs-extra');
const path = require('path');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');

const TMP = path.join(__dirname, '..', 'temp');
fs.ensureDirSync(TMP);

// Store user state per chat for target size selection
const compressStates = {};

async function compressCommand(sock, chatId, message) {
    try {
        const quoted = message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (!quoted) {
            await sock.sendMessage(chatId, { text: '📦 Reply to a file (image, video, PDF, DOCX) with `.compress` to compress it.' }, { quoted: message });
            return;
        }

        await sock.sendMessage(chatId, { react: { text: '📦', key: message.key } });

        const msg = message.message?.extendedTextMessage?.contextInfo;
        const participant = msg?.participant || msg?.remoteJid;
        const quotedMsg = quoted;

        let buffer, ext, fileSize;
        if (quotedMsg?.imageMessage) {
            buffer = await downloadMedia(sock, quotedMsg.imageMessage, participant);
            ext = 'image';
            fileSize = quotedMsg.imageMessage.fileLength || buffer.length;
        } else if (quotedMsg?.videoMessage) {
            buffer = await downloadMedia(sock, quotedMsg.videoMessage, participant);
            ext = 'video';
            fileSize = quotedMsg.videoMessage.fileLength || buffer.length;
        } else if (quotedMsg?.documentMessage) {
            buffer = await downloadMedia(sock, quotedMsg.documentMessage, participant);
            ext = (quotedMsg.documentMessage.fileName || '').split('.').pop().toLowerCase() || 'bin';
            fileSize = quotedMsg.documentMessage.fileLength || buffer.length;
        } else {
            await sock.sendMessage(chatId, { text: '❌ Reply to a image, video, or document with `.compress`.' }, { quoted: message });
            return;
        }

        if (!buffer) {
            await sock.sendMessage(chatId, { text: '❌ Could not download the file.' }, { quoted: message });
            return;
        }

        const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(1);
        const extDisplay = ext;

        await sock.sendMessage(chatId, { react: { text: '✅', key: message.key } });

        // Ask user for target size
        await sock.sendMessage(chatId, {
            text: `📦 *File Information*\n\n• Original Size: ${fileSizeMB} MB\n\nNeçə MB-a qədər sıxışdırmaq istəyirsiniz?\n\nMəsələn: 5, 10, 15`
        }, { quoted: message });

        // Store state for this user
        compressStates[chatId] = {
            buffer,
            ext,
            originalSize: fileSize,
            fileName: `file.${ext === 'image' ? 'jpg' : ext === 'video' ? 'mp4' : ext}`,
            active: true
        };

    } catch (error) {
        console.error('[Compress] Error:', error.message);
        await sock.sendMessage(chatId, { react: { text: '✅', key: message.key } });
        delete compressStates[chatId];
        try { await sock.sendMessage(chatId, { text: '❌ Compression failed. Please try again.' }, { quoted: message }); } catch {}
    }
}

async function handleCompressSelection(sock, chatId, message, text) {
    const state = compressStates[chatId];
    if (!state || !state.active) return false;

    const targetMB = parseFloat(text.trim());
    if (isNaN(targetMB) || targetMB <= 0) {
        await sock.sendMessage(chatId, { text: '❌ Zəhmət olmasa düzgün bir rəqəm göndərin (məsələn: 5, 10, 15).' }, { quoted: message });
        return true;
    }

    delete compressStates[chatId];

    const targetBytes = targetMB * 1024 * 1024;
    const originalMB = (state.originalSize / (1024 * 1024)).toFixed(1);

    if (targetBytes >= state.originalSize) {
        await sock.sendMessage(chatId, {
            text: `⚠️ Seçdiyiniz ölçü (${targetMB} MB) orijinal ölçüdən (${originalMB} MB) böyükdür. Orijinal fayl göndərilir.`
        }, { quoted: message });
        // Send original file
        await sendOriginalFile(sock, chatId, state);
        return true;
    }

    await sock.sendMessage(chatId, { text: `📦 Sıxışdırılır... ${targetMB} MB hədəflənir` }, { quoted: message });
    await sock.sendMessage(chatId, { react: { text: '📦', key: message.key } });

    try {
        const result = await compressFile(state.buffer, state.ext, targetBytes);
        if (!result || result.length >= state.originalSize) {
            await sock.sendMessage(chatId, { react: { text: '✅', key: message.key } });
            await sock.sendMessage(chatId, { text: '⚠️ Hədəf ölçüyə çatmaq mümkün olmadı. Ən yaxın nəticə göndərilir.' }, { quoted: message });
            await sendOriginalFile(sock, chatId, state);
        } else {
            const compressedMB = (result.length / (1024 * 1024)).toFixed(1);
            await sock.sendMessage(chatId, { react: { text: '✅', key: message.key } });
            await sock.sendMessage(chatId, { text: `✅ Sıxışdırıldı: ${originalMB} MB → ${compressedMB} MB` }, { quoted: message });
            await sendCompressedFile(sock, chatId, result, state.ext);
        }
    } catch (e) {
        console.error('[Compress] Error:', e.message);
        await sock.sendMessage(chatId, { react: { text: '✅', key: message.key } });
        await sock.sendMessage(chatId, { text: '❌ Sıxışdırma uğursuz oldu: ' + e.message }, { quoted: message });
    }

    return true;
}

async function compressFile(buffer, ext, targetBytes) {
    if (['image', 'jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
        return await compressImage(buffer, targetBytes);
    } else if (['video', 'mp4', 'mov', 'avi', 'mkv'].includes(ext)) {
        return await compressVideo(buffer, targetBytes);
    } else if (ext === 'pdf') {
        // PDF compression - just return original for now (no free PDF compression lib)
        return buffer;
    }
    return buffer;
}

async function compressImage(buffer, targetBytes) {
    let quality = 85;
    let result = buffer;
    
    for (let attempt = 0; attempt < 10; attempt++) {
        result = await sharp(buffer)
            .jpeg({ quality, chromaSubsampling: '4:2:0' })
            .toBuffer();
        
        if (result.length <= targetBytes || quality <= 10) break;
        quality -= 10;
    }
    
    return result;
}

async function compressVideo(buffer, targetBytes) {
    return new Promise((resolve, reject) => {
        const inputPath = path.join(TMP, 'comp_in_' + Date.now() + '.mp4');
        const outputPath = path.join(TMP, 'comp_out_' + Date.now() + '.mp4');
        
        fs.writeFileSync(inputPath, buffer);
        
        // Get actual video duration via ffprobe for accurate bitrate calculation
        let durationSec = 10;
        try {
            const { spawnSync } = require('child_process');
            const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', inputPath], { timeout: 10000 });
            if (probe.status === 0 && probe.stdout.length > 0) {
                const parsed = parseFloat(probe.stdout.toString().trim());
                if (!isNaN(parsed) && parsed > 0) durationSec = parsed;
            }
        } catch (e) {}
        const targetBitrate = Math.floor((targetBytes * 8) / durationSec);
        const bitrateK = Math.max(Math.floor(targetBitrate / 1000), 100);
        
        ffmpeg(inputPath)
            .outputOptions([
                '-c:v', 'libx264',
                '-b:v', bitrateK + 'k',
                '-preset', 'fast',
                '-crf', '28',
                '-movflags', '+faststart'
            ])
            .output(outputPath)
            .on('end', () => {
                try {
                    const data = fs.readFileSync(outputPath);
                    fs.unlinkSync(inputPath);
                    fs.unlinkSync(outputPath);
                    resolve(data);
                } catch (e) { reject(e); }
            })
            .on('error', (err) => {
                try { fs.unlinkSync(inputPath); } catch {}
                try { fs.unlinkSync(outputPath); } catch {}
                reject(err);
            })
            .run();
    });
}

async function sendOriginalFile(sock, chatId, state) {
    if (state.ext === 'image') {
        await sock.sendMessage(chatId, { image: state.buffer });
    } else if (state.ext === 'video') {
        await sock.sendMessage(chatId, { video: state.buffer });
    } else {
        await sock.sendMessage(chatId, { document: state.buffer, mimetype: 'application/octet-stream', fileName: state.fileName });
    }
}

async function sendCompressedFile(sock, chatId, buffer, ext) {
    if (ext === 'image' || ext === 'jpg' || ext === 'jpeg' || ext === 'png' || ext === 'webp') {
        await sock.sendMessage(chatId, { image: buffer, caption: '📦 Compressed' });
    } else if (ext === 'video' || ext === 'mp4') {
        await sock.sendMessage(chatId, { video: buffer, caption: '📦 Compressed' });
    } else {
        await sock.sendMessage(chatId, { document: buffer, mimetype: 'application/octet-stream', fileName: 'compressed.' + ext });
    }
}

async function downloadMedia(sock, msg, participant) {
    try {
        const wa = require('../wa_manager');
        const mediaType = msg.mimetype?.startsWith('video') ? 'video' : 
                          msg.mimetype?.startsWith('image') ? 'image' : 'document';
        const stream = await wa.downloadContentFromMessage(msg, mediaType);
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        return Buffer.concat(chunks);
    } catch (e) {
        console.error('Download error:', e.message);
        return null;
    }
}

module.exports = { compressCommand, handleCompressSelection };
