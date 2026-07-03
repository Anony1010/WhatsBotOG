// 🧹 Fix for ENOSPC / temp overflow in hosted panels
const fs = require('fs');
const path = require('path');

// Redirect temp storage away from system /tmp
const customTemp = path.join(process.cwd(), 'temp');
if (!fs.existsSync(customTemp)) fs.mkdirSync(customTemp, { recursive: true });
process.env.TMPDIR = customTemp;
process.env.TEMP = customTemp;
process.env.TMP = customTemp;

// Auto-cleaner every 3 hours
setInterval(() => {
    fs.readdir(customTemp, (err, files) => {
        if (err) return;
        for (const file of files) {
            const filePath = path.join(customTemp, file);
            fs.stat(filePath, (err, stats) => {
                if (!err && Date.now() - stats.mtimeMs > 3 * 60 * 60 * 1000) {
                    fs.unlink(filePath, () => { });
                }
            });
        }
    });
    console.log('🧹 Temp folder auto-cleaned');
}, 3 * 60 * 60 * 1000);

const settings = require('./settings');
require('./config.js');
const { isBanned } = require('./lib/isBanned');
const yts = require('yt-search');
const { fetchBuffer } = require('./lib/myfunc');
const fetch = require('node-fetch');
const ytdl = require('ytdl-core');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const { isSudo } = require('./lib/index');
const isOwnerOrSudo = require('./lib/isOwner');
const { autoreadCommand, isAutoreadEnabled, handleAutoread } = require('./commands/autoread');

// Command imports
// help removed - using inline require
const ttsCommand = require('./commands/tts');
const instagramCommand = require('./commands/instagram');
const spotifyCommand = require('./commands/spotify');
const tiktokCommand = require('./commands/tiktok');
const { replyCommand, handleAutoDownload, isReplyEnabled } = require('./commands/reply');
// removed
// removed
// removed
const pingCommand = require('./commands/ping');
// removed
const staffCommand = require('./commands/staff');
const viewOnceCommand = require('./commands/viewonce');
const { incrementMessageCount, topMembers } = require('./commands/topmembers');
const setProfilePicture = require('./commands/setpp');
const { anticallCommand, readState: readAnticallState } = require('./commands/anticall');
const { handleAntideleteCommand, handleMessageRevocation, storeMessage } = require('./commands/antidelete');
const { handleTranslateCommand } = require('./commands/translate');
const aiCommand = require('./commands/ai');
const openCommand = require('./commands/open');
const { statusCommand, handleStatusSelection } = require('./commands/status');
const pdfCommand = require('./commands/pdf');
const docxCommand = require('./commands/docx');
const { compressCommand, handleCompressSelection } = require('./commands/compress');
const urlCommand = require('./commands/url');
const { addCommandReaction, handleAreactCommand } = require('./lib/reactions');
const imagineCommand = require('./commands/imagine');
const sudoCommand = require('./commands/sudo');
const { piesCommand, piesAlias } = require('./commands/pies');

const imageCommand = require('./commands/image');
// Global settings
global.packname = settings.packname;
global.author = settings.author;
global.channelLink = "";
global.ytch = "GASHAM";

// Add this near the top of main.js with other global configurations
const channelInfo = {
    contextInfo: {
        forwardingScore: 1,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
            newsletterJid: 'n@newsletter',
            newsletterName: 'GASHAM',
            serverMessageId: -1
        }
    }
};

async function handleMessages(sock, messageUpdate, printLog) {
    try {
        const { messages, type } = messageUpdate;
        if (type !== 'notify') return;

        const message = messages[0];
        if (!message?.message) return;

        // Handle autoread functionality
        await handleAutoread(sock, message);

        // Store message for antidelete feature
        if (message.message) {
            storeMessage(sock, message);
        }

        // Handle message revocation
        if (message.message?.protocolMessage?.type === 0) {
            await handleMessageRevocation(sock, message);
            return;
        }

        const chatId = message.key.remoteJid;
        const senderId = message.key.participant || message.key.remoteJid;
        const isGroup = chatId.endsWith('@g.us');
        const senderIsSudo = await isSudo(senderId);
        const senderIsOwnerOrSudo = await isOwnerOrSudo(senderId, sock, chatId);

        // Handle button responses
        if (message.message?.buttonsResponseMessage) {
            const buttonId = message.message.buttonsResponseMessage.selectedButtonId;
            const chatId = message.key.remoteJid;

            if (buttonId === 'channel') {
                await sock.sendMessage(chatId, {
                    text: '📢 *GASHAM Bot*\n\nPremium WhatsApp Bot\nVersion 1.0'
                }, { quoted: message });
                return;
            } else if (buttonId === 'support') {
                await sock.sendMessage(chatId, {
                    text: `🔗 *GASHAM Bot*\n\nWhatsApp Bot\nPowered by GASHAM`
                }, { quoted: message });
                return;
            }
        }

        const userMessage = (
            message.message?.conversation?.trim() ||
            message.message?.extendedTextMessage?.text?.trim() ||
            message.message?.imageMessage?.caption?.trim() ||
            message.message?.videoMessage?.caption?.trim() ||
            message.message?.buttonsResponseMessage?.selectedButtonId?.trim() ||
            ''
        ).toLowerCase().replace(/\.\s+/g, '.').trim();

        // Preserve raw message for commands like .tag that need original casing
        const rawText = message.message?.conversation?.trim() ||
            message.message?.extendedTextMessage?.text?.trim() ||
            message.message?.imageMessage?.caption?.trim() ||
            message.message?.videoMessage?.caption?.trim() ||
            '';

        // Only log command usage
        if (userMessage.startsWith('.')) {
            console.log(`📝 Command used in ${isGroup ? 'group' : 'private'}: ${userMessage}`);
        }
        // Read bot mode once; don't early-return so moderation can still run in private mode
        let isPublic = true;
        try {
            const data = JSON.parse(fs.readFileSync('./data/messageCount.json'));
            if (typeof data.isPublic === 'boolean') isPublic = data.isPublic;
        } catch (error) {
            console.error('Error checking access mode:', error);
            // default isPublic=true on error
        }
        const isOwnerOrSudoCheck = message.key.fromMe || senderIsOwnerOrSudo;
        // Check if user is banned (skip ban check for unban command)
        if (isBanned(senderId) && !userMessage.startsWith('.unban')) {
            // Only respond occasionally to avoid spam
            if (Math.random() < 0.1) {
                await sock.sendMessage(chatId, {
                    text: '❌ You are banned from using the bot. Contact an admin to get unbanned.',
                    ...channelInfo
                });
            }
            return;
        }

        // Game commands removed


        if (!message.key.fromMe) incrementMessageCount(chatId, senderId);

        // Check for bad words and antilink FIRST, before ANY other processing
        // Always run moderation in groups, regardless of mode
        if (isGroup) {
            // Group moderation removed
        }

        // PM blocker: block non-owner DMs when enabled (do not ban)
        if (!isGroup && !message.key.fromMe && !senderIsSudo) {
            try {
                const pmState = readPmBlockerState();
                if (pmState.enabled) {
                    // Inform user, delay, then block without banning globally
                    await sock.sendMessage(chatId, { text: pmState.message || 'Private messages are blocked. Please contact the owner in groups only.' });
                    await new Promise(r => setTimeout(r, 1500));
                    try { await sock.updateBlockStatus(chatId, 'block'); } catch (e) { }
                    return;
                }
            } catch (e) { }
        }

        // Check for compress target size selection (before command prefix check)
        if (!userMessage.startsWith('.')) {
            const rawNum = rawText || userMessage;
            if (/^\d+$/.test(rawNum.trim())) {
                const handledCompress = await handleCompressSelection(sock, chatId, message, rawNum.trim());
                if (handledCompress) return;
                const handledStatus = await handleStatusSelection(sock, chatId, message, rawNum.trim());
                if (handledStatus) return;
            }
        }

        // Then check for command prefix
        if (!userMessage.startsWith('.')) {

            const rawMsg = rawText || userMessage;
            const igPattern = /https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|tv|stories)\//i;
            const tkPattern = /https?:\/\/(?:www\.|vm\.|vt\.)?tiktok\.com\//i;

            // Auto-download when Reply Mode is OFF (.reply off)
            // YouTube → MP3, Instagram → Reel/Post, TikTok → Video
            if (!isReplyEnabled()) {
                const downloaded = await handleAutoDownload(sock, chatId, rawMsg, message);
                if (downloaded) return;
            }

            if (igPattern.test(rawMsg)) {
                const instagramCommand = require('./commands/instagram');
                await instagramCommand(sock, chatId, message);
                return;
            }

            if (tkPattern.test(rawMsg)) {
                const tiktokCommand = require('./commands/tiktok');
                await tiktokCommand(sock, chatId, message);
                return;
            }

            if (isGroup) {
                                
                if (isPublic || isOwnerOrSudoCheck) {
                    // Chatbot removed
                }
            }
            return;
        }
        if (!isPublic && !isOwnerOrSudoCheck) {
            return;
        }


        // List of owner commands
        const ownerCommands = ['.mode', '.antidelete', '.setpp', '.areact', '.autoread'];
        const isOwnerCommand = ownerCommands.some(cmd => userMessage.startsWith(cmd));

        
        // Check owner status for owner commands
        if (isOwnerCommand) {
            if (!message.key.fromMe && !senderIsOwnerOrSudo) {
                await sock.sendMessage(chatId, { text: '❌ This command is only available for the owner or sudo!' }, { quoted: message });
                return;
            }
        }

        // Command handlers - Execute commands immediately without waiting for typing indicator
        // We'll show typing indicator after command execution if needed
        let commandExecuted = false;

        switch (true) {
            case userMessage === '.menu' || userMessage === '.bot' || userMessage === '.list':
                const helpCmd = require('./commands/help'); await helpCmd(sock, chatId, message);
                commandExecuted = true;
                break;
            case userMessage.startsWith('.tts'):
                const text = userMessage.slice(4).trim();
                await ttsCommand(sock, chatId, text, message);
                break;
            case userMessage === '.reply' || userMessage.startsWith('.reply '):
                const replyArgs = userMessage.slice(7).trim().split(/\s+/);
                await replyCommand(sock, chatId, message, replyArgs);
                commandExecuted = true;
                break;

            case userMessage.startsWith('.mode'):
                // Check if sender is the owner
                if (!message.key.fromMe && !senderIsOwnerOrSudo) {
                    await sock.sendMessage(chatId, { text: 'Only bot owner can use this command!', ...channelInfo }, { quoted: message });
                    return;
                }
                // Read current data first
                let data;
                try {
                    data = JSON.parse(fs.readFileSync('./data/messageCount.json'));
                } catch (error) {
                    console.error('Error reading access mode:', error);
                    await sock.sendMessage(chatId, { text: 'Failed to read bot mode status', ...channelInfo });
                    return;
                }

                const action = userMessage.split(' ')[1]?.toLowerCase();
                // If no argument provided, show current status
                if (!action) {
                    const currentMode = data.isPublic ? 'public' : 'private';
                    await sock.sendMessage(chatId, {
                        text: `Current bot mode: *${currentMode}*\n\nUsage: .mode public/private\n\nExample:\n.mode public - Allow everyone to use bot\n.mode private - Restrict to owner only`,
                        ...channelInfo
                    }, { quoted: message });
                    return;
                }

                if (action !== 'public' && action !== 'private') {
                    await sock.sendMessage(chatId, {
                        text: 'Usage: .mode public/private\n\nExample:\n.mode public - Allow everyone to use bot\n.mode private - Restrict to owner only',
                        ...channelInfo
                    }, { quoted: message });
                    return;
                }

                try {
                    // Update access mode
                    data.isPublic = action === 'public';

                    // Save updated data
                    fs.writeFileSync('./data/messageCount.json', JSON.stringify(data, null, 2));

                    await sock.sendMessage(chatId, { text: `Bot is now in *${action}* mode`, ...channelInfo });
                } catch (error) {
                    console.error('Error updating access mode:', error);
                    await sock.sendMessage(chatId, { text: 'Failed to update bot access mode', ...channelInfo });
                }
                break;

            case userMessage === '.china':
                await piesAlias(sock, chatId, message, 'china');
                commandExecuted = true;
                break;
            case userMessage === '.indonesia':
                await piesAlias(sock, chatId, message, 'indonesia');
                commandExecuted = true;
                break;
            case userMessage === '.japan':
                await piesAlias(sock, chatId, message, 'japan');
                commandExecuted = true;
                break;
            case userMessage === '.korea':
                await piesAlias(sock, chatId, message, 'korea');
                commandExecuted = true;
                break;
            case userMessage === '.india':
                await piesAlias(sock, chatId, message, 'india');
                commandExecuted = true;
                break;
            case userMessage === '.malaysia':
                await piesAlias(sock, chatId, message, 'malaysia');
                commandExecuted = true;
                break;
            case userMessage === '.thailand':
                await piesAlias(sock, chatId, message, 'thailand');
                commandExecuted = true;
                break;
            case userMessage === '.ping':
                await pingCommand(sock, chatId, message);
                commandExecuted = true;
                break;

            case userMessage === '.staff':
                await staffCommand(sock, chatId, message);
                commandExecuted = true;
                break;
            case userMessage === '.status':
                await statusCommand(sock, chatId, message);
                commandExecuted = true;
                break;
            case userMessage === '.pdf':
                await pdfCommand(sock, chatId, message);
                commandExecuted = true;
                break;
            case userMessage === '.docx':
                await docxCommand(sock, chatId, message);
                commandExecuted = true;
                break;
            case userMessage === '.compress':
                await compressCommand(sock, chatId, message);
                commandExecuted = true;
                break;
            case userMessage === '.vv' || userMessage === '.viewonce':
                await viewOnceCommand(sock, chatId, message);
                commandExecuted = true;
                break;
            case userMessage.startsWith('.translate'):
                await handleTranslateCommand(sock, chatId, message);
                commandExecuted = true;
                break;
            case userMessage.startsWith('.url'):
                await urlCommand(sock, chatId, message);
                commandExecuted = true;
                break;
            case userMessage.startsWith('.gif'):
                const gifCmd = require('./commands/gif');
                await gifCmd(sock, chatId, message);
                commandExecuted = true;
                break;
            case userMessage.startsWith('.imagine'):
                await imagineCommand(sock, chatId, message);
                commandExecuted = true;
                break;
            case userMessage.startsWith('.spotify'):
                await spotifyCommand(sock, chatId, message);
                commandExecuted = true;
                break;
            case userMessage === '.anticall' || userMessage.startsWith('.anticall '):
                if (!message.key.fromMe && !senderIsOwnerOrSudo) {
                    await sock.sendMessage(chatId, { text: 'Only owner/sudo can use anticall.' }, { quoted: message });
                    break;
                }
                {
                    const args = userMessage.split(' ').slice(1).join(' ');
                    await anticallCommand(sock, chatId, message, args);
                }
                commandExecuted = true;
                break;
            // ===== AI COMMANDS =====
            case userMessage.startsWith('.gpt'):
                await aiCommand(sock, chatId, message);
                commandExecuted = true;
                break;
            case userMessage.startsWith('.open'):
                await openCommand(sock, chatId, message);
                commandExecuted = true;
                break;
            case userMessage.startsWith('.image'):
                await imageCommand(sock, chatId, message);
                commandExecuted = true;
                break;
            // ===== OWNER COMMANDS =====
            case userMessage.startsWith('.antidelete'):
                {
                    const args = userMessage.split(' ').slice(1).join(' ');
                    await handleAntideleteCommand(sock, chatId, message, args);
                }
                commandExecuted = true;
                break;
            case userMessage.startsWith('.setpp'):
                await setProfilePicture(sock, chatId, message);
                commandExecuted = true;
                break;
            case userMessage.startsWith('.autoread'):
                {
                    const args = userMessage.split(' ').slice(1).join(' ');
                    await autoreadCommand(sock, chatId, message, args);
                }
                commandExecuted = true;
                break;
            case userMessage.startsWith('.areact'):
                {
                    const args = userMessage.split(' ').slice(1).join(' ');
                    await handleAreactCommand(sock, chatId, message, args);
                }
                commandExecuted = true;
                break;
            default:
                if (isGroup) {
                    // Handle non-command group messages
                    if (userMessage) {  // Make sure there's a message
                        // chat removed
                    }
                                                        }
                commandExecuted = false;
                break;
        }


        if (userMessage.startsWith('.')) {
            // After command is processed successfully
            await addCommandReaction(sock, message);
        }
    } catch (error) {
        console.error('❌ Error in message handler:', error.message);
        // Only try to send error message if we have a valid chatId
        if (chatId) {
            await sock.sendMessage(chatId, {
                text: '❌ Failed to process command!',
                ...channelInfo
            });
        }
    }
}

async function handleGroupParticipantUpdate(sock, update) {
    try {
        const { id, participants, action, author } = update;

        // Check if it's a group
        if (!id.endsWith('@g.us')) return;

        // Respect bot mode: only announce promote/demote in public mode
        let isPublic = true;
        try {
            const modeData = JSON.parse(fs.readFileSync('./data/messageCount.json'));
            if (typeof modeData.isPublic === 'boolean') isPublic = modeData.isPublic;
        } catch (e) {
            // If reading fails, default to public behavior
        }

        // Handle promotion events
        if (action === 'promote') {
            if (!isPublic) return;
            // Promotion event removed
        }

        // Handle demotion events
        if (action === 'demote') {
            if (!isPublic) return;
            // Demotion event removed
        }

        // Handle join events
        if (action === 'add') {
            // handleJoinEvent removed
        }

        // Handle leave events
        if (action === 'remove') {
            // handleLeaveEvent removed
        }
    } catch (error) {
        console.error('Error in handleGroupParticipantUpdate:', error);
    }
}

// Instead, export the handlers along with handleMessages
module.exports = {
    handleMessages,
    handleGroupParticipantUpdate,
    handleStatus: async (sock, status) => {
        await handleStatusUpdate(sock, status);
    }
};