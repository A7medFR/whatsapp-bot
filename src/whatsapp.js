/**
 * whatsapp.js — v6 (clean)
 * Labels: passive event listener + manual LEADS_LABEL_ID override in .env
 * The manual ID is the only reliable method for Baileys linked devices.
 */

'use strict';

require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  Browsers,
} = require('@whiskeysockets/baileys');
const pino   = require('pino');
const qrcode = require('qrcode-terminal');
const fs     = require('fs');
const path   = require('path');
const { restoreSession } = require('./session');
const geminiService = require('./geminiService');
const db = require('./db');
const complaintsManager = require('./complaintsManager');

const store = makeInMemoryStore({ logger: pino({ level: 'silent' }) });
const STORE_FILE = path.resolve('./baileys_store.json');
// Persist store to disk so message history survives restarts
try { if (fs.existsSync(STORE_FILE)) store.readFromFile(STORE_FILE); } catch (_) { /* first run */ }

// ─── Config ───────────────────────────────────────────────────────────────────
function cleanAndNormalizePhone(phone) {
  return phone.replace(/\D/g, '');
}

function phoneNumbersMatch(phone1, phone2) {
  const p1 = formatJidNumber(phone1);
  const p2 = formatJidNumber(phone2);
  if (!p1 || !p2) return false;
  if (p1 === p2) return true;
  // Suffix comparison for international numbers (handles country-code variations).
  // We compare the last min(len1, len2, 9) digits to catch e.g. 201xxxxxxx vs 01xxxxxxx.
  if (p1.length >= 7 && p2.length >= 7) {
    const compareLen = Math.min(p1.length, p2.length, 10);
    return p1.slice(-compareLen) === p2.slice(-compareLen);
  }
  return false;
}

function formatJidNumber(phone) {
  let clean = (phone || '').replace(/\D/g, '');
  // Saudi local prefix '05XXXXXXXX' (10 digits) → '9665XXXXXXXX'
  if (clean.startsWith('05') && clean.length === 10) {
    clean = '966' + clean.slice(1);
  }
  // Saudi mobile without country code '5XXXXXXXX' (9 digits) → '9665XXXXXXXX'
  else if (clean.startsWith('5') && clean.length === 9) {
    clean = '966' + clean;
  }
  // Egyptian local '01XXXXXXXXX' (11 digits) → '2001XXXXXXXXX'
  else if (clean.startsWith('01') && clean.length === 11) {
    clean = '20' + clean;
  }
  return clean;
}

function resolveJid(phone) {
  if (!phone) return '';
  const clean = phone.replace(/\D/g, '');
  if (phone.includes('@')) {
    return phone;
  }
  
  // 1. Look in chatLabels cache keys
  for (const jid of Object.keys(chatLabels)) {
    const jidPhone = jid.split('@')[0].replace(/\D/g, '');
    if (jidPhone === clean) {
      return jid;
    }
  }

  // 2. Look in Baileys store messages keys
  if (store && store.messages) {
    for (const jid of Object.keys(store.messages)) {
      const jidPhone = jid.split('@')[0].replace(/\D/g, '');
      if (jidPhone === clean) {
        return jid;
      }
    }
  }

  // 3. Default fallback
  return `${clean}@s.whatsapp.net`;
}

async function getCleanPhoneAndJid(jid, msg = null, socket = null) {
  if (!jid) return { phone: '', jid: '' };
  
  let rawPhone = jid.split('@')[0].replace(/\D/g, '');
  let resolvedJid = jid;
  
  // Try to resolve LID JIDs (WhatsApp Multi-Device / LID Accounts)
  if (jid.endsWith('@lid')) {
    let resolved = null;
    
    // 1. Check message key alternatives if msg is provided
    if (msg && msg.key) {
      if (msg.key.senderPn && msg.key.senderPn.endsWith('@s.whatsapp.net')) {
        resolved = msg.key.senderPn;
      } else if (msg.key.remoteJidAlt && msg.key.remoteJidAlt.endsWith('@s.whatsapp.net')) {
        resolved = msg.key.remoteJidAlt;
      } else if (msg.key.participantAlt && msg.key.participantAlt.endsWith('@s.whatsapp.net')) {
        resolved = msg.key.participantAlt;
      }
    }
    
    // 2. Query Baileys LID mapping repository (socket) FIRST
    if (!resolved && socket) {
      try {
        const pn = await socket.signalRepository?.lidMapping?.getPNForLID?.(jid);
        if (pn) resolved = pn.includes('@') ? pn : `${pn}@s.whatsapp.net`;
      } catch (_) {}
    }
    
    if (resolved && resolved.endsWith('@s.whatsapp.net')) {
      resolvedJid = resolved;
      rawPhone = formatJidNumber(resolved.split('@')[0]);
    } else {
      // Keep original LID for JID but normalize rawPhone safely
      rawPhone = formatJidNumber(rawPhone);
    }
  } else {
    rawPhone = formatJidNumber(rawPhone);
  }
  
  return { phone: rawPhone, jid: resolvedJid };
}

const FORWARD_NUMBERS = (process.env.FORWARD_NUMBERS || '')
  .split(',').map(n => formatJidNumber(n)).filter(Boolean);

const LEADS_LABEL    = process.env.LEADS_LABEL_NAME || 'ليدز باتريكس 1';
const LEADS_LABEL_ID = (process.env.LEADS_LABEL_ID  || '').trim();
const MOH_LABEL      = process.env.MOH_LABEL_NAME   || 'وزارة الصحة';
const MOH_LABEL_ID   = (process.env.MOH_LABEL_ID    || '').trim();

// Phone numbers of وزارة الصحة contacts (digits only, with country code)
// The bot will notify admins whenever a message arrives from any of these numbers
let MOH_NUMBERS = (process.env.MOH_NUMBERS || '')
  .split(',').map(n => formatJidNumber(n)).filter(Boolean);

const LABELS_FILE    = path.resolve('./labels_cache.json');
const CHAT_LABELS_FILE = path.resolve('./chat_labels_cache.json');

// Anti-Ban & Queue configurations
const MIN_QUEUE_DELAY = parseInt(process.env.MIN_QUEUE_DELAY_MS || '1500', 10);
const MAX_QUEUE_DELAY = parseInt(process.env.MAX_QUEUE_DELAY_MS || '3000', 10);
const SAME_CHAT_DELAY = parseInt(process.env.SAME_CHAT_DELAY_MS || '1500', 10);
const BATCH_SIZE_LIMIT = parseInt(process.env.BATCH_SIZE_LIMIT || '20', 10);
const BATCH_COOLDOWN = parseInt(process.env.BATCH_COOLDOWN_MS || '5000', 10);
const SIMULATE_TYPING = process.env.SIMULATE_TYPING !== 'false';
const SIMULATE_READ_RECEIPTS = process.env.SIMULATE_READ_RECEIPTS !== 'false';

// ─── State ────────────────────────────────────────────────────────────────────
let sock     = null;
let isReady  = false;
let qrString = null;
let currentPairingCode = null;

const labelsStore = {};   // labelId → { id, name, color }
const chatLabels  = {};   // jid     → Set<labelId>
const systemLogs  = [];   // memory ring buffer of system logs
const dynamicMOHNumbers = new Set();

function logEvent(message, level = 'info') {
  const time = new Date().toLocaleTimeString('ar-SA');
  const levelIcon = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : 'ℹ️';
  const formatted = `${levelIcon} ${message}`;
  console.log(`[${time}] ${formatted}`);
  systemLogs.push({ time, message: formatted, level });
  if (systemLogs.length > 50) systemLogs.shift();
  if (global.broadcastLog) {
    global.broadcastLog({ time, message: formatted, level });
  }
}
global.logEvent = logEvent;

// Dynamically load MOH numbers from extracted_moh_numbers.txt if it exists
try {
  const EXTRACTED_MOH_FILE = path.resolve('./extracted_moh_numbers.txt');
  if (fs.existsSync(EXTRACTED_MOH_FILE)) {
    const fileContent = fs.readFileSync(EXTRACTED_MOH_FILE, 'utf8');
    const fileNumbers = fileContent.split(',')
      .map(n => formatJidNumber(n.trim()))
      .filter(Boolean);
    if (fileNumbers.length > 0) {
      MOH_NUMBERS = Array.from(new Set([...MOH_NUMBERS, ...fileNumbers]));
      logEvent(`📋 Loaded ${fileNumbers.length} MOH numbers from extracted_moh_numbers.txt`, 'info');
    }
  }
} catch (err) {
  console.error(`⚠️ Failed to load extracted MOH numbers: ${err.message}`);
}

// ─── Number Pairing Code Authentication ───────────────────────────────────────
const AUTH_DIR = path.resolve(__dirname, '../auth_info_baileys');

/**
 * Normalize a phone number for Baileys requestPairingCode.
 * Baileys expects a plain digit string in international format (no + or spaces).
 * e.g. '+966 533 267 493' → '966533267493'
 */
function normalizePairingPhone(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (!digits || digits.length < 7 || digits.length > 15) {
    throw new Error(
      `Invalid phone number "${raw}". Please enter the full number with country code and no + sign (e.g. 966533267493).`
    );
  }
  return digits;
}

/**
 * Request a pairing code for phone-number-based WhatsApp linking.
 *
 * CRITICAL: Baileys' requestPairingCode() only works on a FRESH, UNREGISTERED
 * socket. If the socket already has credentials (creds.me is set or registered
 * is true), WhatsApp will reject the pairing and show "Couldn't link device –
 * Check the phone number is correct on your device."
 *
 * To fix this, we:
 * 1. Clear the auth_info_baileys directory (remove all old credentials)
 * 2. Close the current socket
 * 3. Create a brand-new socket with fresh auth state
 * 4. Wait for the fresh socket to connect to WhatsApp servers
 * 5. Call sock.requestPairingCode(phoneNumber) on the fresh socket
 */
async function requestPairingCode(phone) {
  const normalizedPhone = normalizePairingPhone(phone);

  logEvent(`📱 Pairing code requested for +${normalizedPhone}. Preparing fresh connection...`, 'info');

  // ── Step 1: Clear old auth credentials ──────────────────────────────────────
  try {
    if (fs.existsSync(AUTH_DIR)) {
      const files = fs.readdirSync(AUTH_DIR);
      for (const file of files) {
        fs.unlinkSync(path.join(AUTH_DIR, file));
      }
      logEvent(`🗑️  Cleared ${files.length} old auth files for fresh pairing.`, 'info');
    }
  } catch (err) {
    logEvent(`⚠️  Could not clear auth directory: ${err.message}`, 'warn');
  }

  // ── Step 2: Close the existing socket ───────────────────────────────────────
  if (sock) {
    try {
      sock.ev.removeAllListeners('connection.update');
      sock.end(undefined);
    } catch (_) { /* ignore close errors */ }
    sock = null;
    isReady = false;
    qrString = null;
  }

  // ── Step 3: Create a fresh socket with clean auth state ─────────────────────
  const { state: freshState, saveCreds: freshSaveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const freshSock = makeWASocket({
    version,
    auth: freshState,
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Desktop'),
    connectTimeoutMs:      30000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs:   25000,
    markOnlineOnConnect:   false,
    syncFullHistory:       false,
    generateHighQualityLinkPreview: false,
  });

  freshSock.ev.on('creds.update', freshSaveCreds);

  // ── Step 4: Wait for the socket to connect ──────────────────────────────────
  // We need to wait until Baileys establishes the WebSocket connection to
  // WhatsApp's servers. The socket will emit a QR code — that's our signal
  // that the connection is ready and we can request a pairing code instead.
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for WhatsApp connection. Please try again.'));
    }, 20000);

    freshSock.ev.on('connection.update', (update) => {
      const { qr: gotQR, connection } = update;
      if (gotQR) {
        // QR generated means the socket is connected and waiting for auth — perfect
        clearTimeout(timeout);
        resolve();
      }
      if (connection === 'close') {
        clearTimeout(timeout);
        reject(new Error('Connection closed before pairing could be initiated.'));
      }
    });
  });

  // ── Step 5: Request the pairing code on the fresh, unregistered socket ──────
  console.log(`[Pairing] Socket ready. Requesting pairing code for: ${normalizedPhone}`);
  console.log(`[Pairing] creds.registered = ${freshState.creds.registered}, creds.me = ${JSON.stringify(freshState.creds.me)}`);

  const rawCode = await freshSock.requestPairingCode(normalizedPhone);
  const formattedCode = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;

  // Store the pairing state
  currentPairingCode = {
    code: rawCode,
    formattedCode: formattedCode,
    phone: normalizedPhone,
    timestamp: Date.now()
  };

  // ── Replace the module-level sock with the fresh one ────────────────────────
  // When the user enters the code on their phone and it succeeds, the
  // connection.update event on freshSock will fire with connection='open'.
  // We need this socket to become the main bot socket.
  sock = freshSock;

  // Re-bind the connection lifecycle handler so the bot works after linking
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrString = qr;
      isReady = false;
    }

    if (connection === 'open') {
      isReady = true;
      qrString = null;
      currentPairingCode = null;
      logEvent('✅ WhatsApp connected via pairing code!', 'info');
      console.log('\n✅ WhatsApp connected via pairing code!');
    }

    if (connection === 'close') {
      isReady = false;
      qrString = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      const reason = Object.entries(DisconnectReason).find(([, v]) => v === code)?.[0] || code;
      console.log(`\n⚠️  Disconnected after pairing: ${reason} (${code})`);
      if (code === DisconnectReason.loggedOut) {
        console.log('❌ Logged out. Delete auth_info_baileys/ and restart.');
        return;
      }
      const isRestart = code === DisconnectReason.restartRequired || code === 515 || !code;
      const d = isRestart ? 500 : (code === 405 ? 10000 : 3000);
      console.log(`🔄 Reconnecting in ${d / 1000}s...\n`);
      setTimeout(() => connect(), d);
    }
  });

  // Bind store to new socket
  store.bind(sock.ev);

  logEvent(`🔢 Pairing Code generated: ${formattedCode} for +${normalizedPhone}`, 'info');
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  📱 WhatsApp Pairing Code: ${formattedCode.padEnd(14, ' ')}║`);
  console.log(`║  Phone: +${normalizedPhone.padEnd(30, ' ')}║`);
  console.log(`║  Go to Linked Devices → Link with        ║`);
  console.log(`║  phone number instead → enter this code   ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);

  return currentPairingCode;
}

const getStatus = () => ({ connected: isReady, hasQR: !!qrString, qr: qrString, pairingCode: currentPairingCode });
const getLabels = () => labelsStore;
const getLogs   = () => systemLogs;

// ─── Label cache ──────────────────────────────────────────────────────────────
function loadLabelCache() {
  try {
    if (fs.existsSync(LABELS_FILE)) {
      const data = JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8'));
      Object.assign(labelsStore, data || {});
      const names = Object.values(labelsStore).map(l => `"${l.name}" (ID:${l.id})`).join(', ');
      if (names) console.log(`📋 Labels from cache: ${names}`);
    }
  } catch (_) { /* ignore */ }
}

function saveLabelCache() {
  try { fs.writeFileSync(LABELS_FILE, JSON.stringify(labelsStore, null, 2), 'utf8'); }
  catch (_) { /* ignore */ }
}

function loadChatLabelsCache() {
  try {
    if (fs.existsSync(CHAT_LABELS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CHAT_LABELS_FILE, 'utf8'));
      for (const [jid, arr] of Object.entries(data)) {
        chatLabels[jid] = new Set(arr);
      }
      logEvent(`📋 Loaded ${Object.keys(chatLabels).length} chat-label mapping(s) from cache.`, 'info');
    }
  } catch (_) { /* ignore */ }
}

function saveChatLabelsCache() {
  try {
    const data = {};
    for (const [jid, set] of Object.entries(chatLabels)) {
      data[jid] = Array.from(set);
    }
    fs.writeFileSync(CHAT_LABELS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) { /* ignore */ }
}

// ─── Complaints Tracker State & Helpers ────────────────────────────────────────
function loadComplaintsCache() {
  return complaintsManager.loadComplaintsCache();
}

function saveComplaintsCache(list) {
  return complaintsManager.saveComplaintsCache(list);
}

function getComplaintsStore() {
  return complaintsManager.getComplaintsStore();
}

function closeComplaint(complaintId) {
  return complaintsManager.closeComplaint(complaintId);
}

function promoteTemporaryComplaint(complaintId, officialId) {
  return complaintsManager.promoteTemporaryComplaint(complaintId, officialId);
}

function addManualComplaint(data) {
  return complaintsManager.addManualComplaint(data);
}

function updateManualComplaint(ticketId, data) {
  return complaintsManager.updateManualComplaint(ticketId, data);
}

function deleteComplaint(complaintId) {
  return complaintsManager.deleteComplaint(complaintId);
}

function hasAttachment(msg) {
  const m = msg?.message;
  if (!m) return false;
  
  const checkMedia = (obj) => {
    if (!obj) return false;
    return !!(
      obj.documentMessage ||
      obj.imageMessage ||
      obj.videoMessage ||
      obj.audioMessage ||
      obj.documentWithCaptionMessage ||
      obj.stickerMessage
    );
  };

  if (checkMedia(m)) return true;

  const unwrapped = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message;
  if (unwrapped && checkMedia(unwrapped)) return true;

  return false;
}

function getMessageText(msg) {
  const c = msg?.message;
  if (!c) return '';
  
  let text = c.conversation || c.extendedTextMessage?.text || '';
  if (!text && c.imageMessage?.caption) text = c.imageMessage.caption;
  if (!text && c.videoMessage?.caption) text = c.videoMessage.caption;
  if (!text && c.documentMessage?.title) text = c.documentMessage.title;
  
  const wrapped = c.ephemeralMessage?.message || c.viewOnceMessage?.message || c.viewOnceMessageV2?.message;
  if (wrapped) {
    if (!text && wrapped.conversation) text = wrapped.conversation;
    if (!text && wrapped.extendedTextMessage?.text) text = wrapped.extendedTextMessage.text;
    if (!text && wrapped.imageMessage?.caption) text = wrapped.imageMessage.caption;
    if (!text && wrapped.videoMessage?.caption) text = wrapped.videoMessage.caption;
    if (!text && wrapped.documentMessage?.title) text = wrapped.documentMessage.title;
  }
  
  return text;
}

async function triggerAdminAlert(sock, text, originalMsg = null) {
  // Strict Guard: Outbound messages (sent by clinic staff) must NEVER be forwarded to admin numbers
  if (originalMsg && originalMsg.key && originalMsg.key.fromMe) {
    return;
  }

  if (FORWARD_NUMBERS.length === 0) {
    logEvent(`⚠️ Alert forwarding aborted: FORWARD_NUMBERS is empty in .env.`, 'warn');
    return;
  }
  logEvent(`📨 Forwarding emergency alert to admins: ${text}`, 'info');
  if (!sock || !isReady) {
    logEvent(`   ℹ️ [Offline/Simulation] Admin alert logged but not sent via WhatsApp (no active connection).`, 'info');
    return;
  }
  for (const num of FORWARD_NUMBERS) {
    const recipientJid = `${num}@s.whatsapp.net`;
    
    // 1. Send the text alert
    try {
      await sock.sendMessage(recipientJid, { text });
      logEvent(`   ✅ Alert forwarded successfully to +${num}`, 'info');
    } catch (err) {
      logEvent(`   ❌ Alert forwarding failed to +${num}: ${err.message}`, 'error');
    }

    // 2. Forward the original message if provided
    if (originalMsg) {
      try {
        await sock.sendMessage(recipientJid, { forward: originalMsg });
        logEvent(`   ✅ Original message forwarded successfully to +${num}`, 'info');
      } catch (err) {
        logEvent(`   ❌ Original message forwarding failed to +${num}: ${err.message}`, 'error');
      }
    }
  }
}

async function sendAdminAlertWithCounter(sock, phone, name, counter, text, shouldIncludeCounter = true, originalMsg = null, extraMeta = {}) {
  // Strict Guard: Outbound messages from clinic staff are never forwarded to admins
  if (originalMsg && originalMsg.key && originalMsg.key.fromMe) {
    return;
  }

  const urgency = extraMeta?.urgency || 'HIGH';
  const urgencyIcon = urgency === 'CRITICAL' ? '🔥' : urgency === 'HIGH' ? '🚨' : '⚠️';
  const category = extraMeta?.category || 'بلاغ جديد';
  const ticketId = extraMeta?.ticketId || 'MOH-قيد_المعالجة';
  const draftReply = extraMeta?.draftReply || '';

  let alertText = `${urgencyIcon} *تنبيه نظام متابعة الشكاوى — وزارة الصحة* ${urgencyIcon}\n\n` +
                  `📱 *المرسل:* +${phone}\n` +
                  `👤 *الاسم:* ${name || 'وزارة الصحة'}\n` +
                  `🎫 *رقم البلاغ:* \`${ticketId}\`\n` +
                  `📌 *التصنيف:* ${category}\n`;
  if (shouldIncludeCounter && counter !== null) {
    alertText += `📊 *إجمالي الرسائل:* ${counter}\n`;
  }
  alertText += `\n💬 *محتوى الرسالة:*\n"${text || '[ملف/مستند مرفق]'}"\n`;

  if (draftReply) {
    alertText += `\n💡 *مقترح الرد من الذكاء الاصطناعي:*\n_${draftReply}_\n`;
  }
  
  await triggerAdminAlert(sock, alertText.trimEnd(), originalMsg);
}

async function sendReminderAdminAlert(sock, phone, name, reminderCount, text, originalMsg = null, extraMeta = {}) {
  // Strict Guard: Outbound messages from clinic staff are never forwarded to admins
  if (originalMsg && originalMsg.key && originalMsg.key.fromMe) {
    return;
  }

  const ticketId = extraMeta?.ticketId || 'MOH-قيد_المعالجة';
  const draftReply = extraMeta?.draftReply || '';

  let alertText = `🚨 *تنبيه عاجل: تذكير شكوى متكرر من وزارة الصحة* 🚨\n\n` +
                  `👤 *الاسم:* ${name || 'وزارة الصحة'}\n` +
                  `📱 *الرقم:* +${phone}\n` +
                  `🎫 *رقم البلاغ:* \`${ticketId}\`\n` +
                  `⚠️ *عدد مرات التذكير الواردة:* ${reminderCount}\n\n` +
                  `💬 *رسالة التذكير:*\n"${text || '[ملف/مستند مرفق]'}"\n\n`;

  if (draftReply) {
    alertText += `💡 *الرد الموصى به لإفادة الشكوى:*\n_${draftReply}_\n\n`;
  }

  alertText += `‼️ *ملاحظة هامة:* يرجى الرد على الشكوى وإرفاق الإفادة رسمياً لتجنب تسجيل مخالفات تنظيمية.`;
  
  await triggerAdminAlert(sock, alertText, originalMsg);
}

async function processMOHMessagePipeline(msg, socket) {
  return await complaintsManager.processMOHMessagePipeline(msg, socket || sock);
}


// ─── Label helpers ────────────────────────────────────────────────────────────
function findLabelId(labelName) {
  // 1. Look up by name in store (populated by passive events if available)
  const entry = Object.entries(labelsStore).find(([, l]) => l.name === labelName);
  if (entry) return String(entry[0]);
  // 2. Manual overrides from .env
  if (labelName === LEADS_LABEL && LEADS_LABEL_ID) return String(LEADS_LABEL_ID);
  if (labelName === MOH_LABEL   && MOH_LABEL_ID)   return String(MOH_LABEL_ID);
  return null;
}

function getChatLabelIds(jid) {
  const bare = jid.replace('@s.whatsapp.net', '');
  return [
    ...(chatLabels[jid]  || new Set()),
    ...(chatLabels[bare] || new Set()),
  ];
}

// ─── Add label to chat ────────────────────────────────────────────────────────
async function addLabelToChat(phone, labelName) {
  if (!sock || !isReady) throw new Error('WhatsApp not connected.');

  const labelId = findLabelId(labelName);
  if (!labelId) {
    throw new Error(
      `Label ID for "${labelName}" is not set.\n` +
      `Add this to your .env file and restart the bot:\n` +
      `  LEADS_LABEL_ID=<number>\n\n` +
      `How to find the number:\n` +
      `  • Open WhatsApp Business on the clinic phone\n` +
      `  • Go to More options (⋮) → Labels\n` +
      `  • Count from top: first label = 1, second = 2, etc.\n` +
      `  • "ليدز باتريكس 1" is label number ____`
    );
  }

  const jid = resolveJid(phone);
  let targetJid = jid;
  try {
    const lid = await sock.signalRepository?.lidMapping?.getLIDForPN?.(jid);
    if (lid) targetJid = lid;
  } catch (_) { /* use plain JID */ }

  await sock.addChatLabel(targetJid, labelId);
  console.log(`🏷️  Labeled +${phone} → "${labelName}" (ID: ${labelId})`);
}

// ─── Connect ──────────────────────────────────────────────────────────────────
async function connect() {
  restoreSession();   // Restore session from WA_SESSION_B64 env var (Back4App / cloud)
  loadLabelCache();
  loadChatLabelsCache();
  
  // Initialize persistent database and load complaints
  try {
    await db.init();
  } catch (err) {
    console.error('⚠️ [DB] Database initialization failed. Using local JSON fallback:', err.message);
  }
  // Initialize complaints manager
  await complaintsManager.init({
    db,
    geminiService,
    logEvent,
    isReady: () => isReady,
    getChatHistory,
    triggerAdminAlert: (text, originalMsg) => triggerAdminAlert(sock, text, originalMsg),
    sendAdminAlertWithCounter: (phone, name, counter, text, shouldIncludeCounter, originalMsg) =>
      sendAdminAlertWithCounter(sock, phone, name, counter, text, shouldIncludeCounter, originalMsg),
    sendReminderAdminAlert: (phone, name, reminderCount, text, originalMsg) =>
      sendReminderAdminAlert(sock, phone, name, reminderCount, text, originalMsg)
  });

  // Pre-populate dynamic MOH numbers from cache
  try {
    const list = complaintsManager.loadComplaintsCache();
    for (const c of list) {
      const phone = c.phone || c.senderPhone;
      if (phone) {
        dynamicMOHNumbers.add(phone.replace(/\D/g, ''));
      }
    }
  } catch (_) {}

  // Close existing socket instance cleanly before creating a new one
  if (sock) {
    try {
      sock.ev.removeAllListeners('connection.update');
      sock.ev.removeAllListeners('creds.update');
      sock.ev.removeAllListeners('messages.upsert');
      sock.end(undefined);
    } catch (_) {}
    sock = null;
  }

  // AUTH_DIR is defined at module level (near requestPairingCode)
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  
  // In-memory bypass: if credentials (creds.me) exist but registered is false (common on abrupt shutdowns),
  // force it to true so Baileys attempts to reconnect instead of redundantly asking for a QR scan.
  if (state.creds && state.creds.me && !state.creds.registered) {
    console.log('💡 [Auth] Found active credentials in creds.json but registered was false. Restoring registered: true to bypass QR scan.');
    state.creds.registered = true;
  }

  const { version }          = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth:   state,
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Desktop'),
    connectTimeoutMs:      30000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs:   25000,
    markOnlineOnConnect:   false,
    syncFullHistory:       false,
    generateHighQualityLinkPreview: false,
    qrTimeout:             300000, // Wait up to 5 minutes for QR scan
  });

  sock.ev.on('creds.update', saveCreds);
  store.bind(sock.ev);

  // Persist store to disk on key events (message upsert, history sync, chats sync)
  const saveStore = () => { try { store.writeToFile(STORE_FILE); } catch (_) {} };
  sock.ev.on('messages.upsert', saveStore);
  sock.ev.on('messaging-history.set', saveStore);
  sock.ev.on('chats.set', saveStore);
  sock.ev.on('chats.upsert', saveStore);
  sock.ev.on('chats.update', saveStore);

  // ── Passive label events (fire if WA sends them — not guaranteed) ──────────
  sock.ev.on('labels.upsert', (labels) => {
    for (const l of (Array.isArray(labels) ? labels : [labels])) {
      if (l?.id) labelsStore[l.id] = l;
    }
    saveLabelCache();
    const names = Object.values(labelsStore).map(l => `"${l.name}" (ID:${l.id})`).join(', ');
    console.log(`🏷️  Labels received from WhatsApp: ${names}`);
  });

  sock.ev.on('labels.edit', (l) => {
    if (l?.id) { labelsStore[l.id] = l; saveLabelCache(); }
  });

  // ── Track label-chat associations via label events ─────────────────────────
  sock.ev.on('labels.association', (data) => {
    const updates = Array.isArray(data) ? data : [data];
    let changed = false;
    for (const u of updates) {
      const a = u?.association;
      const action = u?.type; // 'add' or 'remove'
      if (!a?.chatId || !a?.labelId) continue;
      
      const labelIdStr = String(a.labelId);
      const cleanPhone = a.chatId.split('@')[0].replace(/\D/g, '');

      if (action === 'add') {
        if (!chatLabels[a.chatId]) chatLabels[a.chatId] = new Set();
        chatLabels[a.chatId].add(labelIdStr);
        if (cleanPhone) {
          if (!chatLabels[cleanPhone]) chatLabels[cleanPhone] = new Set();
          chatLabels[cleanPhone].add(labelIdStr);
        }
        changed = true;
        console.log(`🏷️ Label associated: Chat ${a.chatId} -> Label ID ${labelIdStr}`);
      } else if (action === 'remove') {
        chatLabels[a.chatId]?.delete(labelIdStr);
        if (cleanPhone) {
          chatLabels[cleanPhone]?.delete(labelIdStr);
        }
        changed = true;
        console.log(`🏷️ Label disassociated: Chat ${a.chatId} -> Label ID ${labelIdStr}`);
      }
    }
    if (changed) {
      saveChatLabelsCache();
    }
  });

  // ── Also extract label data from chat sync (chats.upsert fires on connect) ─
  const extractChatLabels = (chats) => {
    let found = 0;
    for (const chat of (chats || [])) {
      const jid    = chat.id;
      const labels = chat.labels || chat.label || [];
      if (!jid || !labels.length) continue;
      if (!chatLabels[jid]) chatLabels[jid] = new Set();

      const cleanPhone = jid.split('@')[0].replace(/\D/g, '');
      if (cleanPhone && !chatLabels[cleanPhone]) chatLabels[cleanPhone] = new Set();

      for (const lId of labels) {
        let idVal = null;
        if (typeof lId === 'string' || typeof lId === 'number') {
          idVal = String(lId);
        } else if (lId && (lId.id || lId.labelId)) {
          idVal = String(lId.id || lId.labelId);
        }
        if (idVal) {
          chatLabels[jid].add(idVal);
          if (cleanPhone) chatLabels[cleanPhone].add(idVal);
          found++;
        }
      }
    }
    if (found > 0) {
      logEvent(`🏷️  Loaded ${found} label association(s) from chat sync.`, 'info');
      saveChatLabelsCache();
    }
  };

  sock.ev.on('chats.upsert',  (chats) => extractChatLabels(chats));
  sock.ev.on('chats.update',  (chats) => extractChatLabels(chats));
  sock.ev.on('chats.set',     ({ chats } = {}) => extractChatLabels(chats));
  sock.ev.on('messaging-history.set', ({ chats } = {}) => extractChatLabels(chats));

  // Deduplication cache for Baileys message events
  const processedMessageIds = new Set();

  // ── Notify admin when a وزارة الصحة labeled chat sends a message ──────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;

    for (const msg of messages) {
      if (!msg.message) continue;

      // Deduplicate by message ID
      if (msg.key.id) {
        if (processedMessageIds.has(msg.key.id)) {
          continue;
        }
        processedMessageIds.add(msg.key.id);
        if (processedMessageIds.size > 200) {
          const first = processedMessageIds.values().next().value;
          processedMessageIds.delete(first);
        }
      }

      const sender = msg.key.remoteJid;
      if (!sender || sender.endsWith('@g.us')) continue;

      const { phone: senderPhone, jid: resolvedJid } = await getCleanPhoneAndJid(sender, msg, sock);
      const pushName    = msg.pushName || '';

      const msgText     = getMessageText(msg) || '';
      const mohLabelId  = findLabelId(MOH_LABEL);
      const knownLabels = [
        ...(chatLabels[sender] || new Set()),
        ...(chatLabels[senderPhone] || new Set()),
        ...(resolvedJid ? (chatLabels[resolvedJid] || new Set()) : []),
      ].map(String);

      const isMOHLabel    = mohLabelId && knownLabels.includes(String(mohLabelId));
      const isMOHNumber   = MOH_NUMBERS.some(num => phoneNumbersMatch(senderPhone, num)) || dynamicMOHNumbers.has(senderPhone);
      
      const complaints = loadComplaintsCache();
      const hasActiveComplaint = complaints.some(c => phoneNumbersMatch(c.phone || c.senderPhone || '', senderPhone) && c.status === 'OPEN');
      
      // ── STRICT GATE: Only process messages from configured MOH numbers ──────
      // Gemini AI is NEVER invoked for any number not in MOH_NUMBERS or MOH label.
      // This is the primary defence against exceeding Gemini API rate limits.
      const isMOH = isMOHLabel || isMOHNumber || hasActiveComplaint;
      const detectionMethod = isMOH
        ? (isMOHNumber ? 'MOH_NUMBER' : isMOHLabel ? 'MOH_LABEL' : 'ACTIVE_COMPLAINT')
        : null;

      // ── Hard gate: skip all non-MOH messages silently ─────────────────────
      if (!isMOH) {
        continue;
      }

      // Add to dynamic MOH numbers for session continuity
      dynamicMOHNumbers.add(senderPhone);

      // Attempt to auto-label the chat in WhatsApp Business if not already labeled
      if (mohLabelId && !knownLabels.includes(String(mohLabelId))) {
        addLabelToChat(senderPhone, MOH_LABEL).catch(err => {
          logEvent(`⚠️ Failed to auto-label +${senderPhone} as MOH: ${err.message}`, 'warn');
        });
      }

      const isOutboundMsg = !!msg.key?.fromMe;
      if (isOutboundMsg) {
        logEvent(`📤 [Outbound Clinic Reply] to: +${senderPhone} | Checking attachment status to update complaint state (no AI call, no admin forward).`, 'info');
      } else {
        logEvent(`📨 [Inbound MOH Message] from: +${senderPhone} (Name: "${pushName}") | Method: ${detectionMethod} → AI pipeline & admin alerts running.`, 'info');
      }

      // Attach detection metadata to msg context for the complaints pipeline
      msg.aiDiscoveryResult = null;
      msg.detectionMethod = detectionMethod;

      // Run state machine complaints tracker pipeline
      await processMOHMessagePipeline(msg, sock);

      // Simulate reading the message (anti-ban read receipt simulation — MOH only)
      if (SIMULATE_READ_RECEIPTS && sock && !msg.key.fromMe) {
        try {
          await sock.readMessages([msg.key]);
          logEvent(`🔵 Marked MOH message read from +${senderPhone}`, 'info');
        } catch (readErr) {
          // Ignore read errors
        }
      }
    }
  });


  // ── Connection lifecycle ───────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrString = qr;
      isReady  = false;
      console.log('\n╔══════════════════════════════════════════╗');
      console.log('║  📱 Scan this QR code with WhatsApp      ║');
      console.log('║  Settings → Linked Devices → Link Device ║');
      console.log('╚══════════════════════════════════════════╝\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      isReady  = true;
      qrString = null;
      currentPairingCode = null;
      console.log('\n✅ WhatsApp connected!');

      if (LEADS_LABEL_ID) {
        console.log(`🏷️  Leads label:  "${LEADS_LABEL}" → ID: ${LEADS_LABEL_ID}`);
      } else {
        console.log(`⚠️  LEADS_LABEL_ID not set — leads labeling disabled.`);
      }

      if (MOH_LABEL_ID) {
        console.log(`🏷️  MOH label:    "${MOH_LABEL}" → ID: ${MOH_LABEL_ID}`);
      } else {
        console.log(`⚠️  MOH_LABEL_ID not set — auto-forward detection disabled.`);
        console.log(`   Open WhatsApp Business → ⋮ → Labels`);
        console.log(`   Count position of each label (first = 1, second = 2, etc.)`);
        console.log(`   Then add LEADS_LABEL_ID and MOH_LABEL_ID to .env and restart.\n`);
      }

      if (FORWARD_NUMBERS.length > 0) {
        console.log(`📨 Auto-forward "${MOH_LABEL}" → [+${FORWARD_NUMBERS.join(', +')}]`);
      }
      console.log('══════════════════════════════════════════\n');
    }

    if (connection === 'close') {
      isReady  = false;
      qrString = null;
      const code   = lastDisconnect?.error?.output?.statusCode;
      const reason = Object.entries(DisconnectReason).find(([, v]) => v === code)?.[0] || code;
      console.log(`\n⚠️  Disconnected: ${reason} (${code})`);
      if (code === DisconnectReason.loggedOut) {
        console.log('❌ Logged out. Delete auth_info_baileys/ and restart.');
        return;
      }
      // When QR scan completes or restart is required, reconnect immediately (500ms) to finalize authentication
      const isRestart = code === DisconnectReason.restartRequired || code === 515 || !code;
      const d = isRestart ? 500 : (code === 405 ? 10000 : 3000);
      console.log(`🔄 Reconnecting in ${d / 1000}s...\n`);
      setTimeout(() => connect(), d);
    }
  });
}

// ─── Queue Manager (Anti-Spam / Anti-Ban) ────────────────────────────────────
const messageQueue = [];
let isQueueProcessing = false;
let messagesSentInCurrentBatch = 0;
let lastSentTime = 0;
let lastSentPhone = null;

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function processMessageQueue() {
  if (isQueueProcessing || messageQueue.length === 0) return;
  isQueueProcessing = true;

  while (messageQueue.length > 0) {
    // Check batch limit
    if (messagesSentInCurrentBatch >= BATCH_SIZE_LIMIT) {
      logEvent(`⏳ Batch size limit reached (${BATCH_SIZE_LIMIT}). Cooling down for ${BATCH_COOLDOWN / 1000}s to mimic human break...`, 'warn');
      await delay(BATCH_COOLDOWN);
      messagesSentInCurrentBatch = 0;
    }

    const task = messageQueue.shift();
    try {
      // Determine the spacing delay required
      let requiredDelay = 0;
      const now = Date.now();

      if (lastSentTime > 0) {
        if (lastSentPhone === task.phone) {
          // Same chat spacing is shorter (natural flow)
          requiredDelay = SAME_CHAT_DELAY;
        } else {
          // Different chat spacing uses standard queue anti-ban delays
          const jitterRange = MAX_QUEUE_DELAY - MIN_QUEUE_DELAY;
          requiredDelay = Math.floor(Math.random() * (jitterRange > 0 ? jitterRange : 1000)) + MIN_QUEUE_DELAY;
        }
      }

      const timeSinceLastMessage = now - lastSentTime;
      if (lastSentTime > 0 && timeSinceLastMessage < requiredDelay) {
        const waitTime = requiredDelay - timeSinceLastMessage;
        logEvent(`⏳ Spacing out message to +${task.phone}... waiting ${waitTime / 1000}s`, 'info');
        await delay(waitTime);
      }

      logEvent(`🚀 Sending queued block to +${task.phone}...`, 'info');
      const res = await sendMessageDirect(task.phone, task.payload, (lastSentPhone === task.phone));
      
      lastSentTime = Date.now();
      lastSentPhone = task.phone;
      messagesSentInCurrentBatch++;
      logEvent(`✅ Message block sent to +${task.phone} successfully. (Batch progress: ${messagesSentInCurrentBatch}/${BATCH_SIZE_LIMIT})`, 'info');
      if (task.resolve) task.resolve(res);
    } catch (err) {
      logEvent(`❌ Failed to send queued message to +${task.phone}: ${err.message}`, 'error');
      if (task.reject) task.reject(err);
    }
  }
  isQueueProcessing = false;
}

function enqueueMessage(phone, payload) {
  return new Promise((resolve, reject) => {
    messageQueue.push({ phone, payload, resolve, reject });
    processMessageQueue();
  });
}

// ─── Send ─────────────────────────────────────────────────────────────────────
async function sendMessage(phone, payload) {
  return enqueueMessage(phone, payload);
}

async function sendMessageDirect(phone, payload, isConsecutive = false) {
  if (!sock || !isReady) throw new Error('WhatsApp is not connected yet.');
  const jid = resolveJid(phone);

  // Simulating typing/composing presence update before sending to mimic human behavior
  if (SIMULATE_TYPING && !isConsecutive) {
    try {
      await sock.sendPresenceUpdate('composing', jid);
      // Simulate realistic typing time (e.g. 0.5 to 1.5 seconds)
      const typingTime = Math.floor(Math.random() * 1000) + 500;
      logEvent(`💬 Simulating typing to +${phone} for ${typingTime / 1000}s...`, 'info');
      await delay(typingTime);
      await sock.sendPresenceUpdate('paused', jid);
    } catch (presenceErr) {
      // Ignore errors when sending presence status
    }
  }

  if (payload.image) {
    const img = payload.image;
    let imageContent;

    if (img.startsWith('data:')) {
      // Base64 data URI — convert to Buffer
      const base64Data = img.replace(/^data:image\/\w+;base64,/, '');
      imageContent = { url: undefined, data: Buffer.from(base64Data, 'base64') };
      await sock.sendMessage(jid, { image: imageContent.data, caption: payload.caption || '' });
    } else if (img.startsWith('http://') || img.startsWith('https://')) {
      // Full HTTP URL — let Baileys fetch it
      await sock.sendMessage(jid, { image: { url: img }, caption: payload.caption || '' });
    } else {
      // Unknown format — skip image, just send caption as text
      logEvent(`⚠️ Unrecognized image format, skipping image for: ${payload.caption}`, 'warn');
      if (payload.caption) {
        await sock.sendMessage(jid, { text: payload.caption });
      }
    }
  } else if (payload.document) {
    // File / document upload (Buffer from multer)
    await sock.sendMessage(jid, {
      document: payload.document,
      mimetype: payload.mimetype || 'application/octet-stream',
      fileName: payload.fileName || 'file',
      caption:  payload.caption  || '',
    });
  } else if (payload.location) {
    // Native WhatsApp location pin
    const { lat, lng, name, address } = payload.location;
    await sock.sendMessage(jid, {
      location: {
        degreesLatitude:  lat,
        degreesLongitude: lng,
        name:    name    || '',
        address: address || '',
      },
    });
  } else if (payload.text) {
    await sock.sendMessage(jid, { text: payload.text });
  }
}

// ─── WhatsApp number check ────────────────────────────────────────────────────
/**
 * Returns true if the given phone number (digits only, with country code) is
 * registered on WhatsApp, false otherwise.
 */
async function isRegisteredNumber(phone) {
  if (!sock || !isReady) throw new Error('WhatsApp is not connected yet.');
  try {
    const jid = `${phone}@s.whatsapp.net`;
    const [result] = await sock.onWhatsApp(jid);
    return !!(result && result.exists);
  } catch (err) {
    logEvent(`⚠️ Could not verify WhatsApp registration for +${phone}: ${err.message}`, 'warn');
    // On unexpected errors, allow the send to proceed (fail-open)
    return true;
  }
}

// ─── Export Labeled Numbers Utility ───────────────────────────────────────────
async function getMOHNumbersFromLabels() {
  const mohLabelId = findLabelId(MOH_LABEL) || '14';
  const phoneNumbers = new Set();

  for (const [jid, labels] of Object.entries(chatLabels)) {
    if (labels && labels.has(mohLabelId)) {
      const { phone } = await getCleanPhoneAndJid(jid, null, sock);
      if (phone) {
        phoneNumbers.add(phone);
      }
    }
  }
  
  return Array.from(phoneNumbers);
}

// ─── Get Chat History from Store ──────────────────────────────────────────────
function getChatHistory(phone) {
  const clean = phone.replace(/\D/g, '');
  const rawMessages = [];
  
  if (store && store.messages) {
    for (const [jid, msgs] of Object.entries(store.messages)) {
      const jidPhone = jid.split('@')[0].replace(/\D/g, '');
      if (jidPhone === clean) {
        rawMessages.push(...Array.from(msgs));
      }
    }
  }

  // Deduplicate messages by their key.id to avoid duplicates from merged JIDs
  const seenIds = new Set();
  const uniqueMessages = [];
  for (const msg of rawMessages) {
    if (msg?.key?.id) {
      if (seenIds.has(msg.key.id)) continue;
      seenIds.add(msg.key.id);
    }
    uniqueMessages.push(msg);
  }
  
  const storeHistory = uniqueMessages
    .map(msg => {
      const text = getMessageText(msg);
      const fromMe = !!msg.key?.fromMe;
      const timestamp = msg.messageTimestamp 
        ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
        : new Date().toISOString();
      return {
        timestamp,
        sender: fromMe ? 'Clinic' : 'MOH',
        text: text,
        hasAttachment: hasAttachment(msg)
      };
    })
    .filter(m => m.text || m.hasAttachment);

  // Fallback: if the Baileys store is empty (e.g. after restart), reconstruct
  // history from the complaints cache messages we already persisted to disk.
  if (storeHistory.length === 0) {
    const cached = loadComplaintsCache();
    const match = cached.find(c => phoneNumbersMatch(c.phone || c.senderPhone || '', phone));
    if (match && Array.isArray(match.messages) && match.messages.length > 0) {
      return match.messages.map(m => ({
        timestamp: m.timestamp || new Date().toISOString(),
        sender: m.fromMe ? 'Clinic' : 'MOH',
        text: m.text || '',
        hasAttachment: !!m.hasAttachment
      })).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    }
  }

  return storeHistory.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

// ─── Reconstruct Complaint from History ───────────────────────────────────────
async function reconstructComplaintFromHistory(phone) {
  return await complaintsManager.reconstructComplaintFromHistory(phone);
}

// ─── Scan All MOH Chats in Chat History ───────────────────────────────────────
async function scanAllMOHComplaints() {
  return await complaintsManager.scanAllMOHComplaints(MOH_NUMBERS, getMOHNumbersFromLabels);
}

// ─── AI Deep Scan: Read Conversations & Detect Open Complaints ──────────────────
async function aiDeepScanMOHConversations() {
  return await complaintsManager.aiDeepScanMOHConversations(MOH_NUMBERS, getMOHNumbersFromLabels);
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
async function disconnectGracefully() {
  if (sock) {
    logEvent('🔌 Closing WhatsApp socket connection gracefully...', 'info');
    try {
      sock.ev.removeAllListeners('connection.update');
      sock.end(undefined);
      await new Promise(r => setTimeout(r, 600));
    } catch (err) {
      console.error('Error closing WhatsApp socket:', err.message);
    }
  }
}

module.exports = { connect, sendMessage, getStatus, requestPairingCode, getLabels, addLabelToChat, isRegisteredNumber, getLogs, logEvent, disconnectGracefully, getMOHNumbersFromLabels, getComplaintsStore, closeComplaint, promoteTemporaryComplaint, processMOHMessagePipeline, getChatHistory, reconstructComplaintFromHistory, scanAllMOHComplaints, aiDeepScanMOHConversations, store, chatLabels, addManualComplaint, updateManualComplaint, deleteComplaint };

