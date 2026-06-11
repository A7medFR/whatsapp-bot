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
} = require('@whiskeysockets/baileys');
const pino   = require('pino');
const qrcode = require('qrcode-terminal');
const fs     = require('fs');
const path   = require('path');
const { restoreSession } = require('./session');

// ─── Config ───────────────────────────────────────────────────────────────────
function cleanAndNormalizePhone(phone) {
  return phone.replace(/\D/g, '');
}

function phoneNumbersMatch(phone1, phone2) {
  const p1 = phone1.replace(/\D/g, '');
  const p2 = phone2.replace(/\D/g, '');
  if (!p1 || !p2) return false;
  if (p1 === p2) return true;
  // If both numbers are international/long enough (e.g. 9 or more digits), compare suffixes
  if (p1.length >= 9 && p2.length >= 9) {
    return p1.endsWith(p2) || p2.endsWith(p1);
  }
  return false;
}

function formatJidNumber(phone) {
  let clean = phone.replace(/\D/g, '');
  // If it starts with local Saudi prefix '05' (10 digits total), convert to international '9665...'
  if (clean.startsWith('05') && clean.length === 10) {
    clean = '966' + clean.slice(1);
  }
  // If it's a mobile number without country code but has 9 digits (e.g. '5xxxxxxxx'), prepend '966'
  else if (clean.startsWith('5') && clean.length === 9) {
    clean = '966' + clean;
  }
  return clean;
}

const FORWARD_NUMBERS = (process.env.FORWARD_NUMBERS || '')
  .split(',').map(n => formatJidNumber(n)).filter(Boolean);

const LEADS_LABEL    = process.env.LEADS_LABEL_NAME || 'ليدز باتريكس 1';
const LEADS_LABEL_ID = (process.env.LEADS_LABEL_ID  || '').trim();
const MOH_LABEL      = process.env.MOH_LABEL_NAME   || 'وزارة الصحة';
const MOH_LABEL_ID   = (process.env.MOH_LABEL_ID    || '').trim();

// Phone numbers of وزارة الصحة contacts (digits only, with country code)
// The bot will notify admins whenever a message arrives from any of these numbers
const MOH_NUMBERS = (process.env.MOH_NUMBERS || '')
  .split(',').map(n => cleanAndNormalizePhone(n)).filter(Boolean);

const LABELS_FILE    = path.resolve('./labels_cache.json');
const CHAT_LABELS_FILE = path.resolve('./chat_labels_cache.json');

// Anti-Ban & Queue configurations
const MIN_QUEUE_DELAY = parseInt(process.env.MIN_QUEUE_DELAY_MS || '6000', 10);
const MAX_QUEUE_DELAY = parseInt(process.env.MAX_QUEUE_DELAY_MS || '12000', 10);
const BATCH_SIZE_LIMIT = parseInt(process.env.BATCH_SIZE_LIMIT || '10', 10);
const BATCH_COOLDOWN = parseInt(process.env.BATCH_COOLDOWN_MS || '25000', 10);
const SIMULATE_TYPING = process.env.SIMULATE_TYPING !== 'false';
const SIMULATE_READ_RECEIPTS = process.env.SIMULATE_READ_RECEIPTS !== 'false';

// ─── State ────────────────────────────────────────────────────────────────────
let sock     = null;
let isReady  = false;
let qrString = null;

const labelsStore = {};   // labelId → { id, name, color }
const chatLabels  = {};   // jid     → Set<labelId>
const systemLogs  = [];   // memory ring buffer of system logs

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

const getStatus = () => ({ connected: isReady, hasQR: !!qrString, qr: qrString });
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
const COMPLAINTS_FILE = path.resolve('./complaints_cache.json');
let complaintsStore = [];

function loadComplaintsCache() {
  try {
    if (fs.existsSync(COMPLAINTS_FILE)) {
      complaintsStore = JSON.parse(fs.readFileSync(COMPLAINTS_FILE, 'utf8')) || [];
      console.log(`📋 Loaded ${complaintsStore.length} complaints from cache.`);
    }
  } catch (err) {
    console.error(`Failed to load complaints cache: ${err.message}`);
  }
  return complaintsStore;
}

function saveComplaintsCache(list) {
  if (list) complaintsStore = list;
  try {
    fs.writeFileSync(COMPLAINTS_FILE, JSON.stringify(complaintsStore, null, 2), 'utf8');
  } catch (err) {
    console.error(`Failed to save complaints cache: ${err.message}`);
  }
}

function getComplaintsStore() {
  return complaintsStore;
}

function closeComplaint(ticketId) {
  const complaints = loadComplaintsCache();
  const ticket = complaints.find(t => t.ticketId === ticketId);
  if (ticket) {
    ticket.status = 'CLOSED';
    ticket.closeDate = new Date().toISOString();
    saveComplaintsCache(complaints);
    logEvent(`✅ Complaint ${ticketId} resolved via Web UI Dashboard.`, 'info');
    return true;
  }
  return false;
}

function promoteTempTicket(tempId, officialId) {
  const complaints = loadComplaintsCache();
  const ticket = complaints.find(t => t.ticketId === tempId);
  if (ticket) {
    const formattedId = officialId.startsWith('MOH-') ? officialId : `MOH-${officialId}`;
    const exists = complaints.some(t => t.ticketId === formattedId);
    if (exists) {
      throw new Error(`Ticket ID ${formattedId} is already in use.`);
    }
    ticket.ticketId = formattedId;
    ticket.isTemporary = false;
    ticket.requiresManualBinding = false;
    saveComplaintsCache(complaints);
    logEvent(`🔄 Promoted temporary ticket ${tempId} to official ID ${formattedId}`, 'info');
    return ticket;
  }
  return null;
}

function approveAttachment(ticketId) {
  const complaints = loadComplaintsCache();
  const ticket = complaints.find(t => t.ticketId === ticketId);
  if (ticket && ticket.status === 'PENDING_REVIEW') {
    ticket.status = 'CLOSED';
    ticket.closeDate = new Date().toISOString();
    saveComplaintsCache(complaints);
    logEvent(`✅ Approved closure attachment for ticket ${ticketId}. Ticket is now CLOSED.`, 'info');
    return true;
  }
  return false;
}

function rejectAttachment(ticketId) {
  const complaints = loadComplaintsCache();
  const ticket = complaints.find(t => t.ticketId === ticketId);
  if (ticket && ticket.status === 'PENDING_REVIEW') {
    ticket.status = 'OPEN';
    ticket.messages.push({
      timestamp: new Date().toISOString(),
      text: "[Admin Warning: Outbound Attachment Validation Rejected - Marked as General File Share]",
      fromMe: true,
      hasAttachment: false
    });
    saveComplaintsCache(complaints);
    logEvent(`❌ Rejected closure attachment for ticket ${ticketId}. Ticket returned to OPEN state.`, 'warn');
    return true;
  }
  return false;
}

function bindMessageToTicket(ticketId, messageTimestamp, targetTicketId) {
  const complaints = loadComplaintsCache();
  const sourceTicket = complaints.find(t => t.ticketId === ticketId);
  const targetTicket = complaints.find(t => t.ticketId === targetTicketId);
  if (!sourceTicket || !targetTicket) return false;

  const msgIndex = sourceTicket.messages.findIndex(m => m.timestamp === messageTimestamp);
  if (msgIndex === -1) return false;

  const [msg] = sourceTicket.messages.splice(msgIndex, 1);
  msg.text = msg.text.replace('[⚠️ AMBIGUOUS CONTEXTUAL MATCH] ', '');
  
  targetTicket.messages.push(msg);
  targetTicket.messageCount = targetTicket.messages.filter(m => !m.fromMe).length;
  sourceTicket.messageCount = sourceTicket.messages.filter(m => !m.fromMe).length;

  const remainingAmbiguous = sourceTicket.messages.some(m => m.text.includes('AMBIGUOUS CONTEXTUAL MATCH'));
  if (!remainingAmbiguous) {
    sourceTicket.requiresManualBinding = false;
  }

  saveComplaintsCache(complaints);
  logEvent(`🔗 Message bound manually from ticket ${ticketId} to target ticket ${targetTicketId}.`, 'info');
  return true;
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

const ticketRegex = /(?:بلاغ\s*رقم\s*|شكوى\s*رقم\s*|رقم\s*البلاغ\s*|رقم\s*الشكوى\s*)(\d+)/i;

function extractTicketId(text) {
  if (!text) return null;
  const match = text.match(ticketRegex);
  return match ? `MOH-${match[1]}` : null;
}

function generateTempId(phone) {
  return `TEMP-${phone}-${Math.floor(Date.now() / 1000)}`;
}

function appendGeneralInteractionLog(phone, text) {
  console.log(`ℹ️ [General Chat] MOH Contact +${phone}: ${text}`);
}

async function triggerAdminAlert(sock, text) {
  if (FORWARD_NUMBERS.length === 0) {
    logEvent(`⚠️ Alert forwarding aborted: FORWARD_NUMBERS is empty in .env.`, 'warn');
    return;
  }
  logEvent(`📨 Forwarding emergency alert to admins: ${text}`, 'info');
  for (const num of FORWARD_NUMBERS) {
    try {
      await sock.sendMessage(`${num}@s.whatsapp.net`, { text });
      logEvent(`   ✅ Alert forwarded successfully to +${num}`, 'info');
    } catch (err) {
      logEvent(`   ❌ Alert forwarding failed to +${num}: ${err.message}`, 'error');
    }
  }
}

async function executeTicketClosure(complaints, commandTarget, phone, remoteJid, sock) {
  let closedTicket = null;
  if (commandTarget) {
    closedTicket = complaints.find(t => t.ticketId === commandTarget && t.status !== 'CLOSED');
    if (!closedTicket) {
      const clean = commandTarget.replace(/\D/g, '');
      if (clean) {
        closedTicket = complaints.find(t => 
          (t.ticketId.includes(clean) || t.senderPhone === clean) && t.status !== 'CLOSED'
        );
      }
    }
  } else {
    const active = complaints.filter(t => t.senderPhone === phone && t.status === 'OPEN');
    if (active.length === 1) {
      closedTicket = active[0];
    }
  }

  if (closedTicket) {
    closedTicket.status = 'CLOSED';
    closedTicket.closeDate = new Date().toISOString();
    saveComplaintsCache(complaints);
    logEvent(`✅ Closed complaint ${closedTicket.ticketId} via manual command.`, 'info');
    try {
      await sock.sendMessage(remoteJid, { text: `✅ [نظام] تم إغلاق بطاقة الشكوى ${closedTicket.ticketId} بنجاح.` });
    } catch (_) {}
  } else {
    try {
      await sock.sendMessage(remoteJid, { text: `❌ لم يتم العثور على شكوى نشطة بالرقم/الهاتف المحدد لإغلاقها.` });
    } catch (_) {}
  }
}

async function processMOHMessagePipeline(msg, sock) {
  if (!msg.message) return;

  const remoteJid = msg.key.remoteJid;
  const phone = remoteJid.split('@')[0];
  const fromMe = msg.key.fromMe;
  
  const text = getMessageText(msg);
  const hasAtt = hasAttachment(msg);

  let complaints = loadComplaintsCache();

  // ----------------------------------------------------
  // PIPELINE OUTBOUND: CLINIC RESPONDING TO CHAT
  // ----------------------------------------------------
  if (fromMe) {
    if (text.startsWith('/close') || text.startsWith('/اغلاق')) {
      const commandTarget = text.split(' ')[1];
      await executeTicketClosure(complaints, commandTarget, phone, remoteJid, sock);
      return;
    }

    if (hasAtt) {
      const openTickets = complaints.filter(t => t.senderPhone === phone && t.status === 'OPEN');
      if (openTickets.length === 1) {
        openTickets[0].status = "PENDING_REVIEW";
        openTickets[0].messages.push({
          timestamp: new Date().toISOString(),
          text: "[Clinic Outbound Attachment Pushed - Under Validation]",
          fromMe: true,
          hasAttachment: true
        });
        saveComplaintsCache(complaints);
        await sock.sendMessage(remoteJid, { 
          text: `⚠️ تم استلام الملف المرفق. تم تحويل بطاقة الشكوى ${openTickets[0].ticketId} إلى مرحلة المراجعة للتأكد من مطابقة شروط الإغلاق المعتمدة.` 
        });
      }
    }
    return;
  }

  // ----------------------------------------------------
  // PIPELINE INBOUND: MINISTERIAL AGENT RAW TRAFFIC
  // ----------------------------------------------------
  const explicitTicketId = extractTicketId(text);
  const activeTickets = complaints.filter(t => t.senderPhone === phone && t.status === 'OPEN');

  if (explicitTicketId) {
    let ticket = complaints.find(t => t.ticketId === explicitTicketId);

    if (!ticket || ticket.status === 'CLOSED') {
      ticket = {
        ticketId: explicitTicketId,
        senderPhone: phone,
        senderName: msg.pushName || "وزارة الصحة",
        status: "OPEN",
        isTemporary: false,
        requiresManualBinding: false,
        openDate: new Date().toISOString(),
        closeDate: null,
        messageCount: 1,
        messages: [{ timestamp: new Date().toISOString(), text, fromMe: false, hasAttachment: hasAtt }]
      };
      complaints.push(ticket);
      await triggerAdminAlert(sock, `🚨 بلاغ رسمي جديد وارد من وزارة الصحة رقم: ${explicitTicketId}`);
    } else {
      ticket.messageCount += 1;
      ticket.messages.push({ timestamp: new Date().toISOString(), text, fromMe: false, hasAttachment: hasAtt });
      await triggerAdminAlert(sock, `💬 الرسالة رقم ${ticket.messageCount} لبطاقة البلاغ النشطة رقم ${ticket.ticketId}`);
    }
  } else {
    if (activeTickets.length === 1) {
      activeTickets[0].messageCount += 1;
      activeTickets[0].messages.push({ timestamp: new Date().toISOString(), text, fromMe: false, hasAttachment: hasAtt });
      await triggerAdminAlert(sock, `💬 رسالة الحاقية: الرسالة رقم ${activeTickets[0].messageCount} لبطاقة البلاغ رقم ${activeTickets[0].ticketId}`);
    } else if (activeTickets.length > 1) {
      const chronologicalTarget = activeTickets.sort((a, b) => new Date(b.openDate) - new Date(a.openDate))[0];
      chronologicalTarget.messageCount += 1;
      chronologicalTarget.requiresManualBinding = true;
      chronologicalTarget.messages.push({
        timestamp: new Date().toISOString(),
        text: `[⚠️ AMBIGUOUS CONTEXTUAL MATCH] ${text}`,
        fromMe: false,
        hasAttachment: hasAtt
      });
      await triggerAdminAlert(sock, `⚠️ تنبيه: رسالة مبهمة واردة في محادثة تحتوي على أكثر من بلاغ نشط. تم تعليمها للمراجعة اليدوية.`);
    } else {
      if (hasAtt) {
        const tempId = generateTempId(phone);
        const newTempTicket = {
          ticketId: tempId,
          senderPhone: phone,
          senderName: msg.pushName || "وزارة الصحة",
          status: "OPEN",
          isTemporary: true,
          requiresManualBinding: false,
          openDate: new Date().toISOString(),
          closeDate: null,
          messageCount: 1,
          messages: [{ timestamp: new Date().toISOString(), text, fromMe: false, hasAttachment: hasAtt }]
        };
        complaints.push(newTempTicket);
        await triggerAdminAlert(sock, `⚠️ تم فتح ملف بلاغ مؤقت رقم ${tempId} نظراً لاستلام ملف مرفق مستقل بدون رقم مرجعي.`);
      } else {
        appendGeneralInteractionLog(phone, text);
      }
    }
  }

  saveComplaintsCache(complaints);
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

  const jid = `${phone}@s.whatsapp.net`;
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
  loadComplaintsCache();

  const AUTH_DIR = path.resolve(__dirname, '../auth_info_baileys');
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
    browser: ['Windows', 'Chrome', '122.0.0.0'],
    connectTimeoutMs:      30000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs:   25000,
    markOnlineOnConnect:   false,
    qrTimeout:             300000, // Wait up to 5 minutes for QR scan
  });

  sock.ev.on('creds.update', saveCreds);

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
    for (const u of updates) {
      const a = u?.association;
      const action = u?.type; // 'add' or 'remove'
      if (!a?.chatId || !a?.labelId) continue;
      
      const labelIdStr = String(a.labelId);
      if (action === 'add') {
        if (!chatLabels[a.chatId]) chatLabels[a.chatId] = new Set();
        chatLabels[a.chatId].add(labelIdStr);
        console.log(`🏷️ Label associated: Chat ${a.chatId} -> Label ID ${labelIdStr}`);
      } else if (action === 'remove') {
        chatLabels[a.chatId]?.delete(labelIdStr);
        console.log(`🏷️ Label disassociated: Chat ${a.chatId} -> Label ID ${labelIdStr}`);
      }
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
      for (const lId of labels) {
        let idVal = null;
        if (typeof lId === 'string' || typeof lId === 'number') {
          idVal = String(lId);
        } else if (lId && (lId.id || lId.labelId)) {
          idVal = String(lId.id || lId.labelId);
        }
        if (idVal) {
          chatLabels[jid].add(idVal);
          found++;
        }
      }
    }
    if (found > 0) logEvent(`🏷️  Loaded ${found} label association(s) from chat sync.`, 'info');
  };

  sock.ev.on('chats.upsert',  (chats) => extractChatLabels(chats));
  sock.ev.on('chats.update',  (chats) => extractChatLabels(chats));
  sock.ev.on('chats.set',     ({ chats } = {}) => extractChatLabels(chats));
  sock.ev.on('messaging-history.set', ({ chats } = {}) => extractChatLabels(chats));

  // ── Notify admin when a وزارة الصحة labeled chat sends a message ──────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;
      const sender = msg.key.remoteJid;
      if (!sender || sender.endsWith('@g.us')) continue;

      const senderPhone = sender.replace('@s.whatsapp.net', '');
      const pushName    = msg.pushName || '';

      // Resolve LID JIDs to Phone Numbers (PNs)
      let resolvedPhone = null;
      let resolvedJid = null;

      if (msg.key?.senderPn && msg.key.senderPn.endsWith('@s.whatsapp.net')) {
        resolvedJid = msg.key.senderPn;
        resolvedPhone = resolvedJid.replace('@s.whatsapp.net', '');
      } else if (msg.key?.remoteJidAlt && msg.key.remoteJidAlt.endsWith('@s.whatsapp.net')) {
        resolvedJid = msg.key.remoteJidAlt;
        resolvedPhone = resolvedJid.replace('@s.whatsapp.net', '');
      } else if (msg.key?.participantAlt && msg.key.participantAlt.endsWith('@s.whatsapp.net')) {
        resolvedJid = msg.key.participantAlt;
        resolvedPhone = resolvedJid.replace('@s.whatsapp.net', '');
      }

      if (!resolvedPhone && sender.endsWith('@lid') && !msg.key.fromMe) {
        try {
          const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(sender);
          if (pn) {
            resolvedJid = pn;
            resolvedPhone = pn.replace('@s.whatsapp.net', '');
          }
        } catch (lidErr) {
          // Ignore lookup errors
        }
      }

      const mohLabelId = findLabelId(MOH_LABEL);
      const knownLabels = [
        ...(chatLabels[sender] || new Set()),
        ...(chatLabels[senderPhone] || new Set()),
        ...(resolvedJid ? (chatLabels[resolvedJid] || new Set()) : []),
        ...(resolvedPhone ? (chatLabels[resolvedPhone] || new Set()) : []),
      ].map(String);

      const isMOHLabel    = mohLabelId && knownLabels.includes(String(mohLabelId));
      const isMOHNumber   = MOH_NUMBERS.some(num => 
        phoneNumbersMatch(senderPhone, num) || (resolvedPhone && phoneNumbersMatch(resolvedPhone, num))
      );
      
      const isMOHPushName = !msg.key.fromMe && (pushName.includes('وزارة الصحة') || pushName.toLowerCase().includes('ministry of health') || pushName.toLowerCase().includes('moh'));
      const isMOH         = isMOHLabel || isMOHNumber || isMOHPushName;

      if (isMOH) {
        // Run state machine complaints tracker pipeline
        await processMOHMessagePipeline(msg, sock);
      }

      // Simulate reading the message (anti-ban read receipt simulation)
      if (SIMULATE_READ_RECEIPTS && sock && !msg.key.fromMe) {
        try {
          await sock.readMessages([msg.key]);
          logEvent(`🔵 Marked message read from +${senderPhone}`, 'info');
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
      const d = code === 405 ? 10000 : 5000;
      console.log(`🔄 Reconnecting in ${d / 1000}s...\n`);
      setTimeout(() => connect(), d);
    }
  });
}

// ─── Queue Manager (Anti-Spam / Anti-Ban) ────────────────────────────────────
const messageQueue = [];
let isQueueProcessing = false;
let messagesSentInCurrentBatch = 0;

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
      // Dynamic jitter to space out queued messages
      const jitterRange = MAX_QUEUE_DELAY - MIN_QUEUE_DELAY;
      const jitter = Math.floor(Math.random() * (jitterRange > 0 ? jitterRange : 1000)) + MIN_QUEUE_DELAY;
      logEvent(`⏳ Spacing out message to +${task.phone}... waiting ${jitter / 1000}s`, 'info');
      await delay(jitter);

      logEvent(`🚀 Sending queued block to +${task.phone}...`, 'info');
      const res = await sendMessageDirect(task.phone, task.payload);
      
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

async function sendMessageDirect(phone, payload) {
  if (!sock || !isReady) throw new Error('WhatsApp is not connected yet.');
  const jid = `${phone}@s.whatsapp.net`;

  // Simulating typing/composing presence update before sending to mimic human behavior
  if (SIMULATE_TYPING) {
    try {
      await sock.sendPresenceUpdate('composing', jid);
      // Simulate realistic typing time (e.g. 1.5 to 3.5 seconds)
      const typingTime = Math.floor(Math.random() * 2000) + 1500;
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
      let phone = jid.replace('@s.whatsapp.net', '');
      
      // Try to resolve LID JIDs
      if (jid.endsWith('@lid')) {
        try {
          const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(jid);
          if (pn) {
            phone = pn.replace('@s.whatsapp.net', '');
          }
        } catch (_) {}
      }
      
      const cleanPhone = phone.replace(/\D/g, '');
      if (cleanPhone && !phone.includes('@lid')) {
        phoneNumbers.add(cleanPhone);
      }
    }
  }
  
  return Array.from(phoneNumbers);
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
async function disconnectGracefully() {
  if (sock) {
    logEvent('🔌 Closing WhatsApp socket connection gracefully...', 'info');
    try {
      // Remove all connection update listeners to prevent auto-reconnect loops on exit
      sock.ev.removeAllListeners('connection.update');
      sock.end(undefined);
      // Wait a moment for pending writes to flush
      await new Promise(r => setTimeout(r, 600));
    } catch (err) {
      console.error('Error closing WhatsApp socket:', err.message);
    }
  }
}

module.exports = { connect, sendMessage, getStatus, getLabels, addLabelToChat, isRegisteredNumber, getLogs, logEvent, disconnectGracefully, getMOHNumbersFromLabels, getComplaintsStore, closeComplaint, promoteTempTicket, approveAttachment, rejectAttachment, bindMessageToTicket };
