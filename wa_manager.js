const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, downloadContentFromMessage } = require("@whiskeysockets/baileys")
const pino = require("pino")
const NodeCache = require("node-cache")
const fs = require("fs-extra")
const path = require("path")
const QRCode = require("qrcode")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MEDIA_CACHE_DIR = path.join(__dirname, "media_cache")
fs.ensureDirSync(MEDIA_CACHE_DIR)

const SESSIONS_DIR = path.join(__dirname, "sessions")
const SESSION_DATA_FILE = path.join(SESSIONS_DIR, "sessions.json")

fs.ensureDirSync(SESSIONS_DIR)

let sessionsData = {}
try {
  if (fs.existsSync(SESSION_DATA_FILE)) {
    sessionsData = JSON.parse(fs.readFileSync(SESSION_DATA_FILE, "utf-8"))
  }
} catch (e) {
  sessionsData = {}
}

function saveSessionsData() {
  fs.writeFileSync(SESSION_DATA_FILE, JSON.stringify(sessionsData, null, 2))
}

// Store status updates for web viewing
function storeStatus(phone, statusMsg) {
  try {
    const filePath = path.join(SESSIONS_DIR, phone, "status.json")
    let data = {}
    try {
      if (fs.existsSync(filePath)) data = JSON.parse(fs.readFileSync(filePath, "utf-8"))
    } catch (e) {}
    
    if (!data.statuses) data.statuses = []
    
    const msg = statusMsg.message
    let type = "text"
    let content = ""
    let mediaUrl = ""
    
    if (msg?.imageMessage) {
      type = "image"
      content = msg.imageMessage.caption || ""
      mediaUrl = msg.imageMessage.url || ""
    } else if (msg?.videoMessage) {
      type = "video"
      content = msg.videoMessage.caption || ""
      mediaUrl = msg.videoMessage.url || ""
    } else if (msg?.audioMessage) {
      type = "audio"
      mediaUrl = msg.audioMessage.url || ""
    } else if (msg?.conversation) {
      type = "text"
      content = msg.conversation
    } else if (msg?.extendedTextMessage) {
      type = "text"
      content = msg.extendedTextMessage.text || ""
    }
    
    // Determine which message sub-object to store for media downloads
    let msgObj = null
    if (msg?.imageMessage) msgObj = msg.imageMessage
    else if (msg?.videoMessage) msgObj = msg.videoMessage
    else if (msg?.audioMessage) msgObj = msg.audioMessage
    else if (msg?.stickerMessage) msgObj = msg.stickerMessage
    else if (msg?.documentMessage) msgObj = msg.documentMessage
    
    console.log('[Status] Stored status from', statusMsg.key.participant || 'unknown', 'type:', type)
    
    data.statuses.push({
      id: statusMsg.key.id,
      from: statusMsg.key.participant || '',
      type: type,
      content: content,
      mediaUrl: mediaUrl,
      mediaType: type,  // actual media type for downloadContentFromMessage
      msgObj: msgObj,   // store full message sub-object for media download
      time: statusMsg.messageTimestamp ? statusMsg.messageTimestamp * 1000 : Date.now(),
      pushName: statusMsg.pushName || ""
    })
    
    // Keep last 200 statuses
    if (data.statuses.length > 200) data.statuses = data.statuses.slice(-200)
    
    fs.writeFileSync(filePath, JSON.stringify(data))
  } catch (e) {
    console.error("store status err:", e.message)
  }
}

// Get stored statuses
function getStoredStatuses(phone) {
  try {
    const filePath = path.join(SESSIONS_DIR, phone, "status.json")
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"))
    }
  } catch (e) {}
  return { statuses: [] }
}

// Normalize JID for deduplication
function normalizeJid(jid) {
  if (!jid) return 'unknown'
  jid = jid.replace(/:\d+@/, '@')
  return jid.split('@')[0].replace(/[^0-9]/g, '')
}

// Get stored statuses grouped by contact (deduplicated)
function getStoredStatusByContact(phone) {
  const data = getStoredStatuses(phone)
  const contacts = {}
  for (const st of data.statuses) {
    const key = normalizeJid(st.from)
    if (!contacts[key]) {
      contacts[key] = { jid: key, name: st.pushName || st.from.replace(/@.*$/, ''), statuses: [], seenIds: new Set() }
    }
    if (!contacts[key].seenIds.has(st.id)) {
      contacts[key].seenIds.add(st.id)
      contacts[key].statuses.push(st)
    }
  }
  for (const key in contacts) {
    contacts[key].statuses.sort((a, b) => a.time - b.time)
    delete contacts[key].seenIds
  }
  return Object.values(contacts)
}

// Store profile picture URL
function storeProfilePic(phone, jid, url) {
  try {
    const filePath = path.join(SESSIONS_DIR, phone, "profiles.json")
    let data = {}
    try {
      if (fs.existsSync(filePath)) data = JSON.parse(fs.readFileSync(filePath, "utf-8"))
    } catch (e) {}
    
    data[jid] = { url: url, time: Date.now() }
    fs.writeFileSync(filePath, JSON.stringify(data))
  } catch (e) {}
}

// Get profile picture URL
function getProfilePic(phone, jid) {
  try {
    const filePath = path.join(SESSIONS_DIR, phone, "profiles.json")
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"))
      return data[jid]?.url || null
    }
  } catch (e) {}
  return null
}

const activeConnections = {}
const callbacks = { onConnected: null, onDisconnected: null }

function setCallbacks(cbs) { Object.assign(callbacks, cbs) }
function fmtPhone(n) { return n.replace(/[^0-9]/g, "") }
function sessDir(p) { return path.join(SESSIONS_DIR, p) }

function getAllSessions() {
  return Object.keys(sessionsData).map((p) => ({
    phone: p,
    status: sessionsData[p].status || "disconnected",
    name: sessionsData[p].name || p,
    connectedAt: sessionsData[p].connectedAt || null,
  }))
}

function getSession(p) { return sessionsData[p] || null }

async function cacheMediaLocally(msg, mediaType, jid, msgId) {
  try {
    if (!msg) return null;
    if (mediaType !== 'image' && mediaType !== 'video' && mediaType !== 'audio' && mediaType !== 'sticker' && mediaType !== 'document') return null;
    const phoneDir = path.join(MEDIA_CACHE_DIR, jid.replace(/[^a-zA-Z0-9]/g, '_'))
    fs.ensureDirSync(phoneDir)
    const extMap = { image: 'jpg', video: 'mp4', audio: 'ogg', sticker: 'webp', document: 'bin' }
    const ext = extMap[mediaType] || 'bin'
    const cachePath = path.join(phoneDir, msgId + '.' + ext)
    if (fs.existsSync(cachePath)) return cachePath
    try {
      const stream = await downloadContentFromMessage(msg, mediaType)
      const chunks = []
      for await (const chunk of stream) {
        chunks.push(chunk)
        if (Buffer.concat(chunks).length > 100 * 1024 * 1024) { return null }
      }
      const buffer = Buffer.concat(chunks)
      if (buffer.length > 0) {
        fs.writeFileSync(cachePath, buffer)
        console.log('✅ Cached ' + mediaType + ' for ' + msgId.slice(0, 20))
        return cachePath
      }
    } catch (e) {
      console.log('Cache failed: ' + e.message.slice(0, 60))
    }
    return null
  } catch (e) { return null }
}

async function storeMessage(phone, mek) {
  try {
    const filePath = path.join(SESSIONS_DIR, phone, "messages.json")
    let data = {}
    try {
      if (fs.existsSync(filePath)) data = JSON.parse(fs.readFileSync(filePath, "utf-8"))
    } catch (e) {}
    const jid = mek.key.remoteJid
    if (!jid) return;
    if (!data[jid]) data[jid] = { 
      name: mek.pushName || jid.split("@")[0], 
      type: jid.endsWith("@g.us") ? "group" : jid.endsWith("@broadcast") ? "broadcast" : "individual",
      messages: [] 
    }
    
    // Extract message content based on type
    let text = ""
    let mediaType = "text"
    let mediaUrl = ""
    let mediaCaption = ""
    let fileName = ""
    let fileSize = 0
    let mimeType = ""
    let thumbnailPath = ""
    let location = null
    let vcard = ""
    let isViewOnce = false
    let cachePath = null
    
    // Handle view-once messages
    const vvMsg = mek.message?.viewOnceMessageV2?.message || mek.message?.viewOnceMessage?.message
    const msg = vvMsg || mek.message
    
    if (msg?.conversation) {
      text = msg.conversation
      mediaType = "text"
    } else if (msg?.extendedTextMessage) {
      text = msg.extendedTextMessage.text || ""
      mediaType = "text"
      if (msg.extendedTextMessage.contextInfo?.mentionedJid) {
        data[jid].mentions = msg.extendedTextMessage.contextInfo.mentionedJid
      }
      if (msg.extendedTextMessage.contextInfo?.quotedMessage) {
        // Store reference to replied message
        data[jid].lastReply = { id: mek.key.id }
      }
    } else if (msg?.imageMessage) {
      text = msg.imageMessage.caption || "[Image]"
      mediaType = "image"
      mediaUrl = msg.imageMessage.url || ""
      mediaCaption = msg.imageMessage.caption || ""
      fileName = msg.imageMessage.fileName || ""
      fileSize = msg.imageMessage.fileLength || 0
      mimeType = msg.imageMessage.mimetype || "image/jpeg"
      if (vvMsg) isViewOnce = true
      // Cache locally for WP Track
      ;(async () => { try {
        const cp = await cacheMediaLocally(msg.imageMessage, 'image', jid, mek.key.id);
        if (cp) { cachePath = cp; try { const d = JSON.parse(fs.readFileSync(filePath, 'utf-8')); if (d[jid]) { const lm = d[jid].messages[d[jid].messages.length-1]; if (lm && lm.id === mek.key.id) { lm.cachedMedia = cp; fs.writeFileSync(filePath, JSON.stringify(d)) } } } catch(e){} }
      } catch(e){} })()
    } else if (msg?.videoMessage) {
      text = msg.videoMessage.caption || "[Video]"
      mediaType = "video"
      mediaUrl = msg.videoMessage.url || ""
      mediaCaption = msg.videoMessage.caption || ""
      fileName = msg.videoMessage.fileName || ""
      fileSize = msg.videoMessage.fileLength || 0
      mimeType = msg.videoMessage.mimetype || "video/mp4"
      if (vvMsg) isViewOnce = true
      // Cache locally for WP Track
      ;(async () => { try {
        const cp = await cacheMediaLocally(msg.videoMessage, 'video', jid, mek.key.id);
        if (cp) { cachePath = cp; try { const d = JSON.parse(fs.readFileSync(filePath, 'utf-8')); if (d[jid]) { const lm = d[jid].messages[d[jid].messages.length-1]; if (lm && lm.id === mek.key.id) { lm.cachedMedia = cp; fs.writeFileSync(filePath, JSON.stringify(d)) } } } catch(e){} }
      } catch(e){} })()
    } else if (msg?.audioMessage) {
      text = "[Audio]"
      mediaType = "audio"
      mediaUrl = msg.audioMessage.url || ""
      mimeType = msg.audioMessage.mimetype || "audio/mpeg"
      fileSize = msg.audioMessage.fileLength || 0
      fileName = msg.audioMessage.fileName || ""
      // Cache locally for WP Track
      ;(async () => { try {
        const cp = await cacheMediaLocally(msg.audioMessage, 'audio', jid, mek.key.id);
        if (cp) { cachePath = cp; try { const d = JSON.parse(fs.readFileSync(filePath, 'utf-8')); if (d[jid]) { const lm = d[jid].messages[d[jid].messages.length-1]; if (lm && lm.id === mek.key.id) { lm.cachedMedia = cp; fs.writeFileSync(filePath, JSON.stringify(d)) } } } catch(e){} }
      } catch(e){} })()
    } else if (msg?.stickerMessage) {
      text = "[Sticker]"
      mediaType = "sticker"
      mediaUrl = msg.stickerMessage.url || ""
      // Cache locally for WP Track
      ;(async () => { try {
        const cp = await cacheMediaLocally(msg.stickerMessage, 'sticker', jid, mek.key.id);
        if (cp) { cachePath = cp; try { const d = JSON.parse(fs.readFileSync(filePath, 'utf-8')); if (d[jid]) { const lm = d[jid].messages[d[jid].messages.length-1]; if (lm && lm.id === mek.key.id) { lm.cachedMedia = cp; fs.writeFileSync(filePath, JSON.stringify(d)) } } } catch(e){} }
      } catch(e){} })()
    } else if (msg?.documentMessage) {
      text = msg.documentMessage.caption || "[Document]"
      mediaType = "document"
      mediaUrl = msg.documentMessage.url || ""
      fileName = msg.documentMessage.fileName || ""
      fileSize = msg.documentMessage.fileLength || 0
      mimeType = msg.documentMessage.mimetype || "application/octet-stream"
      // Cache locally for WP Track
      ;(async () => { try {
        const cp = await cacheMediaLocally(msg.documentMessage, 'document', jid, mek.key.id);
        if (cp) { cachePath = cp; try { const d = JSON.parse(fs.readFileSync(filePath, 'utf-8')); if (d[jid]) { const lm = d[jid].messages[d[jid].messages.length-1]; if (lm && lm.id === mek.key.id) { lm.cachedMedia = cp; fs.writeFileSync(filePath, JSON.stringify(d)) } } } catch(e){} }
      } catch(e){} })()
    } else if (msg?.contactMessage) {
      text = "[Contact]"
      mediaType = "contact"
      vcard = msg.contactMessage.vcard || ""
      text = msg.contactMessage.displayName || "[Contact]"
    } else if (msg?.locationMessage) {
      text = "[Location]"
      mediaType = "location"
      location = {
        degreesLatitude: msg.locationMessage.degreesLatitude,
        degreesLongitude: msg.locationMessage.degreesLongitude
      }
    } else if (msg?.liveLocationMessage) {
      text = "[Live Location]"
      mediaType = "location"
      location = {
        degreesLatitude: msg.liveLocationMessage.degreesLatitude,
        degreesLongitude: msg.liveLocationMessage.degreesLongitude
      }
    } else if (msg?.buttonsResponseMessage) {
      text = msg.buttonsResponseMessage.selectedButtonId || "[Button Response]"
      mediaType = "text"
    } else if (msg?.listResponseMessage) {
      text = msg.listResponseMessage.singleSelectReply?.selectedRowId || "[List Response]"
      mediaType = "text"
    } else if (msg?.reactionMessage) {
      text = "[Reaction: " + (msg.reactionMessage.text || "") + "]"
      mediaType = "reaction"
    } else if (msg?.pollCreationMessage) {
      text = "[Poll: " + (msg.pollCreationMessage.name || "") + "]"
      mediaType = "poll"
    } else if (msg?.pollUpdateMessage) {
      text = "[Poll Vote]"
      mediaType = "poll"
    } else if (msg?.groupInviteMessage) {
      text = "[Group Invite]"
      mediaType = "text"
    } else if (msg?.protocolMessage) {
      // Skip protocol messages (deletions, etc.)
      return
    } else {
      text = "[Unknown]"
      mediaType = "text"
    }
    
    const msgObj = {
      id: mek.key.id,
      fromMe: !!mek.key.fromMe,
      text: text,
      time: (mek.messageTimestamp ? mek.messageTimestamp * 1000 : Date.now()),
      type: mediaType,
      pushName: mek.pushName || "",
      participant: mek.key.participant || ""
    }
    
    if (mediaUrl) msgObj.mediaUrl = mediaUrl
    if (mediaCaption) msgObj.caption = mediaCaption
    if (fileName) msgObj.fileName = fileName
    if (fileSize) msgObj.fileSize = fileSize
    if (mimeType) msgObj.mimeType = mimeType
    if (location) msgObj.location = location
    if (vcard) msgObj.vcard = vcard
    if (isViewOnce) msgObj.isViewOnce = true
    if (cachePath) msgObj.cachedMedia = cachePath
    
    data[jid].messages.push(msgObj)
    if (data[jid].messages.length > 500) data[jid].messages = data[jid].messages.slice(-500)
    data[jid].name = mek.pushName || data[jid].name
    data[jid].lastUpdate = Date.now()
    
    // Store contact info
    if (mek.pushName && !jid.endsWith("@g.us")) {
      if (!data._contacts) data._contacts = {}
      data._contacts[jid] = { name: mek.pushName, jid: jid }
    }
    
    fs.writeFileSync(filePath, JSON.stringify(data))
  } catch (e) {
    console.error("store msg err:", e.message)
  }
}

// Track per-phone handler loading state to prevent duplicates
const handlersLoaded = new Set()

async function loadBotHandlers(sock, phone) {
  // Prevent duplicate handlers
  if (handlersLoaded.has(phone)) {
    console.log(`Handlers already loaded for +${phone}, skipping`)
    return
  }
  try {
    const { handleMessages, handleGroupParticipantUpdate, handleStatus } = require("./main")
    sock.ev.on("messages.upsert", async (cu) => {
      try {
        const mek = cu.messages[0]
        if (!mek?.message) return
        storeMessage(phone, mek).catch(() => {}).catch(() => {}); try { require("./wp_track").notifyUpdate(phone) } catch(e) {}
        mek.message = Object.keys(mek.message)[0] === "ephemeralMessage" ? mek.message.ephemeralMessage.message : mek.message
        if (mek.key?.remoteJid === "status@broadcast") { 
          storeStatus(phone, mek)
          await handleStatus(sock, cu)
          return 
        }
        if (mek.key?.id?.startsWith("BAE5") && mek.key.id.length === 16) return
        if (sock?.msgRetryCounterCache) sock.msgRetryCounterCache.clear()
        await handleMessages(sock, cu, true)
      } catch (e) { console.error(`msg err [${phone}]:`, e.message) }
    })
    sock.ev.on("group-participants.update", async (u) => {
      try { await handleGroupParticipantUpdate(sock, u) } catch (e) {}
    })
console.log(`Bot handlers loaded for +${phone}`)
    // Mark handlers as loaded
    handlersLoaded.add(phone)
    // No welcome message sent - user can use .menu to see commands
  } catch (err) {
    console.error(`Could not load bot handlers for ${phone}:`, err.message)
  }
}

async function connectWithPhone(phone, method, tgBot, chatId) {
  phone = fmtPhone(phone)
  if (!phone || phone.length < 7 || phone.length > 15) {
    return chatId ? tgBot.sendMessage(chatId, "Invalid number. Format: 994501234567", { parse_mode: "Markdown" }) : null
  }
  if (sessionsData[phone]?.status === "connected" && activeConnections[phone]) {
    return chatId ? tgBot.sendMessage(chatId, `Already connected to +${phone}`) : null
  }

  const methodName = method === "qr" ? "QR Code" : "Pair Code"
  if (chatId) await tgBot.sendMessage(chatId, `Connecting +${phone} via ${methodName}...`, { parse_mode: "Markdown" })

  try {
    const dir = sessDir(phone)
    fs.ensureDirSync(dir)
    const { state, saveCreds } = await useMultiFileAuthState(dir)
    const { version } = await fetchLatestBaileysVersion()
    const msgCache = new NodeCache()

    const sock = makeWASocket({
      version,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: ["Android", "Chrome", "20.0.04"],
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
      },
      markOnlineOnConnect: true,
      msgRetryCounterCache: msgCache,
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      syncFullHistory: true,
    })

    let qrSent = false
    let connOpen = false

    sock.ev.on("connection.update", async (s) => {
      const { connection, lastDisconnect, qr } = s

      if (qr && !qrSent) {
        qrSent = true
        if (method === "qr") {
          try {
            const buf = await QRCode.toBuffer(qr, { type: "png", margin: 2, scale: 8 })
            await tgBot.sendPhoto(chatId, buf, {
              caption:
                "\u{1F4F7} *QR Code* for +" + phone + "\n\n" +
                "\u{1F449} *Steps:*\n" +
                "1. Open WhatsApp \u2192 Menu \u2192 Linked Devices\n" +
                "2. Tap *Link a Device*\n" +
                "3. *Scan* this QR code with your phone"
              ,
              parse_mode: "Markdown",
            })
          } catch (err) {
            console.error("QR gen error:", err)
            if (chatId) await tgBot.sendMessage(chatId, "QR failed: " + err.message)
            qrSent = false
          }
        } else if (method === "pair") {
          console.log("Socket ready, requesting pairing code for", phone)
          requestPairingCodeWithRetry(sock, phone, tgBot, chatId)
        }
      }

      if (connection === "connecting") {
        console.log("Connecting", phone, "...")
      }

      if (connection === "open") {
        connOpen = true
        console.log("Connected", phone)
        sessionsData[phone] = { phone, status: "connected", connectedAt: new Date().toISOString(), name: sock.user?.name || phone, jid: sock.user?.id || "", method: method }
        saveSessionsData()
        activeConnections[phone] = sock
if (chatId) await tgBot.sendMessage(chatId, "Connected!\n+" + phone + "\n" + (sock.user?.name || ""), { parse_mode: "Markdown" })
        await loadBotHandlers(sock, phone)
        if (callbacks.onConnected) callbacks.onConnected(phone, sock)
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode
        const errMsg = lastDisconnect?.error?.message || ""
        console.log("Connection closed for", phone, "code:", code, "msg:", errMsg)
        if (code === DisconnectReason.loggedOut || code === 401) {
          handlersLoaded.delete(phone); delete sessionsData[phone]; saveSessionsData(); delete activeConnections[phone]
          try { fs.removeSync(dir) } catch (e) {}
          if (chatId) await tgBot.sendMessage(chatId, "+" + phone + ": Logged out.")
        } else if (code === 515 || code === DisconnectReason.restartRequired) {
          handlersLoaded.delete(phone); sessionsData[phone] = { phone, status: "reconnecting", method: method }; saveSessionsData(); delete activeConnections[phone]
          await sleep(5000)
          connectWithPhone(phone, method, tgBot, chatId).catch((e) => console.error("Reconnect err", phone, ":", e.message))
        } else {
          const isFailure = errMsg.includes("Connection Failure") || code === 503
          if (isFailure) { handlersLoaded.delete(phone);
            if (sessionsData[phone]) sessionsData[phone].status = "disconnected";
            else sessionsData[phone] = { phone, status: "disconnected", method: method };
            saveSessionsData(); delete activeConnections[phone]
            if (chatId) await tgBot.sendMessage(chatId, "Failed to connect +" + phone + ". Check if number is registered on WhatsApp. Try QR method.")
          } else {
            handlersLoaded.delete(phone);
            if (sessionsData[phone]) sessionsData[phone].status = "disconnected";
            else sessionsData[phone] = { phone, status: "disconnected", method: method };
            saveSessionsData(); delete activeConnections[phone]
          }
        }
        if (callbacks.onDisconnected) callbacks.onDisconnected(phone, lastDisconnect?.error)
      }
    })

    sock.ev.on("creds.update", saveCreds)
    activeConnections[phone] = sock

    if (method === "qr") {
      setTimeout(() => {
        if (!connOpen && !qrSent) {
          if (chatId) tgBot.sendMessage(chatId, "Timeout for +" + phone + ": QR not generated.")
          if (activeConnections[phone]) { activeConnections[phone].end(new Error("qr timeout")); delete activeConnections[phone] }
          handlersLoaded.delete(phone);
          if (sessionsData[phone]) sessionsData[phone].status = "disconnected";
          saveSessionsData()
        }
      }, 30000)
      setTimeout(() => {
        if (!connOpen) {
          if (chatId) tgBot.sendMessage(chatId, "QR scan timeout for +" + phone + ".")
          if (activeConnections[phone]) { activeConnections[phone].end(new Error("qr scan timeout")); delete activeConnections[phone] }
          if (sessionsData[phone]?.status !== "logged_out") { sessionsData[phone].status = "disconnected"; saveSessionsData() }
        }
      }, 120000)
    }

  } catch (err) {
    console.error("Connection error", phone, err)
    if (chatId) await tgBot.sendMessage(chatId, "Error: " + err.message)
  }
}

async function requestPairingCodeWithRetry(sock, phone, tgBot, chatId, maxRetries = 15) {
  for (let i = 0; i < maxRetries; i++) {
    if (sessionsData[phone]?.status === "connected") return
    if (!activeConnections[phone]) return
    try {
      console.log("Requesting pairing code for", phone, "(attempt", i + 1, "/", maxRetries, ")")
      let code = await sock.requestPairingCode(phone)
      code = code?.match(/.{1,4}/g)?.join("-") || code
      console.log("Pairing code for", phone, ":", code)

      if (chatId) await tgBot.sendMessage(chatId,
        "\u2705 *Pairing Code ready!*\n\n" +
        "\u{1F511} Code:\n`" + code + "`\n\n" +
        "\u{1F446} *Tap the code above to copy*\n\n" +
        "\u{1F4F2} WhatsApp \u2192 Linked Devices \u2192 Link with phone number \u2192 Enter code\n\n" +
        "\u23F1 Expires in 5 minutes",
        { parse_mode: "Markdown" }
      )
      return
    } catch (err) {
      const msg = err.message || ""
      console.log("Pairing attempt", i + 1, "failed:", msg.slice(0, 80))

      if (msg.includes("not authorized") || msg.includes("401") || msg.includes("conflict")) {
        if (chatId) await tgBot.sendMessage(chatId,
          "Pairing failed.\nReason: " + msg + "\n\nTry QR Code method.",
          { parse_mode: "Markdown" }
        )
        if (activeConnections[phone]) { activeConnections[phone].end(new Error("Pair failed")); delete activeConnections[phone] }
        // Keep session data if it existed (don't break existing sessions)
        if (sessionsData[phone]) sessionsData[phone].status = "disconnected";
        saveSessionsData()
        return
      }

      if (msg.includes("Connection Closed") || msg.includes("not open") || msg.includes("timedOut")) {
        await sleep(2000)
        continue
      }

      await sleep(3000)
    }
  }

  if (chatId) await tgBot.sendMessage(chatId,
    "Could not generate pairing code for +" + phone + ".\n\n" +
    "Possible reasons:\n" +
    "- Number not on WhatsApp\n" +
    "- WhatsApp blocking request\n" +
    "- Network issues\n\n" +
    "Try QR Code method",
    { parse_mode: "Markdown" }
  )
  if (activeConnections[phone]) { activeConnections[phone].end(new Error("Pair timeout")); delete activeConnections[phone] }
  if (sessionsData[phone]) sessionsData[phone].status = "disconnected"; saveSessionsData()
}

async function connectQR(phone, tgBot, chatId) { return connectWithPhone(phone, "qr", tgBot, chatId) }
async function connectPair(phone, tgBot, chatId) { return connectWithPhone(phone, "pair", tgBot, chatId) }

async function disconnectSession(phone) {
  phone = fmtPhone(phone)
  if (activeConnections[phone]) { try { activeConnections[phone].end(new Error("User logout")) } catch (e) {}; delete activeConnections[phone] }
  try { fs.removeSync(sessDir(phone)) } catch (e) {}
  // Fully remove session data instead of just marking disconnected
  delete sessionsData[phone]
  saveSessionsData()
  return true
}

function getConnectedCount() { return Object.values(sessionsData).filter((s) => s.status === "connected").length }
function getActiveConnection(phone) { return activeConnections[fmtPhone(phone)] || null }
function getAllActiveConnections() { return { ...activeConnections } }

async function restartAllSessions(tgBot, adminChatId) {
  const connected = Object.entries(sessionsData).filter(([_, s]) => s.status === "connected")
  for (const [p] of connected) {
    handlersLoaded.delete(p)
    if (activeConnections[p]) { try { activeConnections[p].end(new Error("Restarting")) } catch (e) {}; delete activeConnections[p] }
  }
  await sleep(3000)
  for (const [p, s] of connected) {
    sessionsData[p] = { phone: p, status: "reconnecting" }; saveSessionsData()
    // Reconnect with stored method (default to QR if not set)
    const method = s.method || "qr"
    await connectWithPhone(p, method, tgBot, adminChatId)
    await sleep(2000)
  }
}

// Auto-clean expired statuses (runs every hour)
function startStatusCleanup() {
  const STATUS_EXPIRY = 24 * 60 * 60 * 1000;
  setInterval(() => {
    for (const phone of Object.keys(sessionsData)) {
      try {
        const filePath = path.join(SESSIONS_DIR, phone, 'status.json');
        if (fs.existsSync(filePath)) {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          const now = Date.now();
          const before = data.statuses.length;
          data.statuses = data.statuses.filter(s => (now - (s.time || 0)) < STATUS_EXPIRY);
          if (data.statuses.length !== before) {
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
            console.log('[Status Cleanup] Removed', before - data.statuses.length, 'expired statuses for', phone);
          }
        }
      } catch (e) {
        console.error('[Status Cleanup] Error for', phone, ':', e.message);
      }
    }
  }, 60 * 60 * 1000); // every hour
  console.log('[Status Cleanup] Auto-cleanup started (hourly)');
}

// Get fresh statuses for a phone (combines stored + real-time check)
function getFreshStatuses(phone) {
  const STATUS_EXPIRY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  
  const stored = getStoredStatuses(phone);
  const active = [];
  const expired = [];
  
  for (const st of stored.statuses) {
    if ((now - (st.time || 0)) < STATUS_EXPIRY) {
      active.push(st);
    } else {
      expired.push(st.id);
    }
  }
  
  // Clean expired ones
  if (expired.length > 0) {
    stored.statuses = stored.statuses.filter(s => !expired.includes(s.id));
    try {
      const filePath = path.join(SESSIONS_DIR, phone, 'status.json');
      fs.writeFileSync(filePath, JSON.stringify(stored, null, 2));
    } catch (e) {}
  }
  
  return active;
}

module.exports = {
  connectQR, connectPair, connectWithPhone, disconnectSession, getAllSessions, getSession,
  getConnectedCount, getActiveConnection, getAllActiveConnections,
  restartAllSessions, setCallbacks, activeConnections, sessionsData, saveSessionsData,
  getStoredStatuses, getStoredStatusByContact, storeProfilePic, getProfilePic, downloadContentFromMessage,
  startStatusCleanup, getFreshStatuses
}
