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
} = require('@whiskeysockets/baileys');
const pino   = require('pino');
const qrcode = require('qrcode-terminal');
const fs     = require('fs');
const path   = require('path');
const { restoreSession } = require('./session');
const geminiService = require('./geminiService');
const db = require('./db');

const store = makeInMemoryStore({ logger: pino({ level: 'silent' }) });
const STORE_FILE = path.resolve('./baileys_store.json');
// Persist store to disk so message history survives restarts
try { if (fs.existsSync(STORE_FILE)) store.readFromFile(STORE_FILE); } catch (_) { /* first run */ }

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

async function initComplaintsStore() {
  try {
    const dbComplaints = await db.getComplaints();
    if (dbComplaints && dbComplaints.length > 0) {
      complaintsStore = dbComplaints;
      console.log(`📋 Loaded ${complaintsStore.length} complaints from Database.`);
      // Keep local JSON backup in sync
      try {
        fs.writeFileSync(COMPLAINTS_FILE, JSON.stringify(complaintsStore, null, 2), 'utf8');
      } catch (_) {}
      return;
    }
  } catch (err) {
    console.error(`Failed to load complaints from database, falling back to local file: ${err.message}`);
  }

  // Fallback to local file
  try {
    if (fs.existsSync(COMPLAINTS_FILE)) {
      complaintsStore = JSON.parse(fs.readFileSync(COMPLAINTS_FILE, 'utf8')) || [];
      console.log(`📋 Loaded ${complaintsStore.length} complaints from local cache file.`);
    }
  } catch (err) {
    console.error(`Failed to load complaints cache from local file: ${err.message}`);
  }
}

function loadComplaintsCache() {
  // Synchronous read of the in-memory array to maintain compatibility
  return complaintsStore;
}

function saveComplaintsCache(list) {
  if (list) complaintsStore = list;
  try {
    fs.writeFileSync(COMPLAINTS_FILE, JSON.stringify(complaintsStore, null, 2), 'utf8');
  } catch (err) {
    console.error(`Failed to save complaints cache to local file: ${err.message}`);
  }
  // Sync to remote database asynchronously in the background
  db.saveComplaints(complaintsStore).catch(err => {
    console.error(`Failed to sync complaints to persistent database: ${err.message}`);
  });
}

function getComplaintsStore() {
  return complaintsStore;
}

function closeComplaint(complaintId) {
  const complaints = loadComplaintsCache();
  const complaint = complaints.find(c => c.complaintId === complaintId || c.ticketId === complaintId);
  if (complaint) {
    complaint.status = 'CLOSED';
    complaint.closeDate = new Date().toISOString();
    saveComplaintsCache(complaints);
    logEvent(`✅ Complaint ${complaintId} resolved via Web UI Dashboard.`, 'info');
    return true;
  }
  return false;
}



function promoteTemporaryComplaint(complaintId, officialId) {
  const complaints = loadComplaintsCache();
  
  // Check if officialId is already in use by another ticket
  const isDuplicate = complaints.some(c => (c.complaintId === officialId || c.ticketId === officialId) && c.complaintId !== complaintId);
  if (isDuplicate) {
    throw new Error(`The ticket ID ${officialId} is already in use by another complaint.`);
  }

  const complaint = complaints.find(c => c.complaintId === complaintId || c.ticketId === complaintId);
  if (complaint) {
    const oldId = complaint.complaintId || complaint.ticketId;
    complaint.complaintId = officialId;
    complaint.ticketId = officialId;
    complaint.isTemporary = false;
    saveComplaintsCache(complaints);
    logEvent(`⚡ Temporary complaint ${oldId} promoted to official ID: ${officialId}`, 'info');
    return complaint;
  }
  return null;
}

function addManualComplaint(data) {
  const complaints = loadComplaintsCache();
  const ticketId = (data.ticketId || '').trim() || `complaint_${data.phone}_${Math.floor(Date.now() / 1000)}`;
  
  // Check if ticketId already exists
  const isDuplicate = complaints.some(c => c.ticketId === ticketId || c.complaintId === ticketId);
  if (isDuplicate) {
    throw new Error(`A complaint with ticket ID ${ticketId} already exists.`);
  }

  const cleanPhone = (data.phone || '').replace(/\D/g, '');
  const newComplaint = {
    complaintId: ticketId,
    ticketId: ticketId,
    phone: cleanPhone,
    name: data.name || 'وزارة الصحة',
    senderPhone: cleanPhone,
    senderName: data.name || 'وزارة الصحة',
    status: data.status || 'OPEN',
    summary: data.summary || 'شكوى مدخلة يدوياً',
    category: data.category || 'أخرى',
    draftReply: data.draftReply || '',
    openDate: data.openDate || new Date().toISOString(),
    closeDate: data.status === 'CLOSED' ? (data.closeDate || new Date().toISOString()) : null,
    messageCount: parseInt(data.messageCount, 10) || 0,
    reminderCount: parseInt(data.reminderCount, 10) || 0,
    messages: data.messages || [],
    isTemporary: !!data.isTemporary
  };

  complaints.push(newComplaint);
  saveComplaintsCache(complaints);
  logEvent(`➕ Manually added complaint ${ticketId} for +${newComplaint.phone}`, 'info');
  return newComplaint;
}

function updateManualComplaint(ticketId, data) {
  const complaints = loadComplaintsCache();
  const index = complaints.findIndex(c => c.ticketId === ticketId || c.complaintId === ticketId);
  if (index === -1) {
    return null;
  }

  const c = complaints[index];
  
  if (data.phone) {
    const clean = data.phone.replace(/\D/g, '');
    c.phone = clean;
    c.senderPhone = clean;
  }
  if (data.name) {
    c.name = data.name;
    c.senderName = data.name;
  }
  if (data.status) {
    c.status = data.status;
    if (data.status === 'CLOSED' && !c.closeDate) {
      c.closeDate = new Date().toISOString();
    } else if (data.status === 'OPEN') {
      c.closeDate = null;
    }
  }
  if (data.summary !== undefined) c.summary = data.summary;
  if (data.category !== undefined) c.category = data.category;
  if (data.draftReply !== undefined) c.draftReply = data.draftReply;
  if (data.messageCount !== undefined) c.messageCount = parseInt(data.messageCount, 10) || 0;
  if (data.reminderCount !== undefined) c.reminderCount = parseInt(data.reminderCount, 10) || 0;
  
  // If reminders count was increased manually, let's make sure the messages array has at least that many reminders
  // we can append mock reminder messages if they want, but let's keep it simple.
  
  saveComplaintsCache(complaints);
  logEvent(`✏️ Manually updated complaint ${ticketId}`, 'info');
  return c;
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

async function triggerAdminAlert(sock, text) {
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
    try {
      await sock.sendMessage(`${num}@s.whatsapp.net`, { text });
      logEvent(`   ✅ Alert forwarded successfully to +${num}`, 'info');
    } catch (err) {
      logEvent(`   ❌ Alert forwarding failed to +${num}: ${err.message}`, 'error');
    }
  }
}

async function sendAdminAlertWithCounter(sock, phone, name, counter, text, shouldIncludeCounter = true) {
  let alertText = `🚨 رسالة جديدة واردة من وزارة الصحة\n` +
                  `📱 الرقم: +${phone}\n` +
                  `👤 الاسم: ${name}\n`;
  if (shouldIncludeCounter && counter !== null) {
    alertText += `📊 عدد الرسائل: ${counter}\n`;
  }
  alertText += `💬 الرسالة: ${text || '[ملف مرفق]'}`;
  
  await triggerAdminAlert(sock, alertText);
}

async function sendReminderAdminAlert(sock, phone, name, reminderCount, text) {
  let alertText = `🚨 *تنبيه: تذكير شكوى من وزارة الصحة* 🚨\n\n` +
                  `👤 *الاسم:* ${name}\n` +
                  `📱 *الرقم:* +${phone}\n` +
                  `💬 *رسالة التذكير:* "${text || '[ملف مرفق]'}"\n\n` +
                  `⚠️ *عدد التذكيرات المسجلة:* ${reminderCount} ⚠️\n` +
                  `💡 يرجى الرد على الشكوى وإغلاقها في أقرب وقت لتفادي المخالفات.`;
  
  await triggerAdminAlert(sock, alertText);
}

async function processMOHMessagePipeline(msg, sock) {
  if (!msg.message) return;

  const remoteJid = msg.key.remoteJid;
  const phone = remoteJid.split('@')[0];
  const fromMe = msg.key.fromMe;
  
  const text = getMessageText(msg);
  const hasAtt = hasAttachment(msg);

  let complaints = loadComplaintsCache();
  const existingForPhone = complaints.filter(c => phoneNumbersMatch(c.phone || c.senderPhone || '', phone));

  // Hardcoded Instant Close Rule:
  // If we send an attachment file, it instantly changes the status to CLOSED, locking the counter.
  if (fromMe && hasAtt) {
    const active = existingForPhone.find(c => c.status === 'OPEN');
    if (active) {
      const target = complaints.find(c => c.complaintId === active.complaintId || c.ticketId === active.ticketId);
      if (target) {
        target.status = 'CLOSED';
        target.closeDate = new Date().toISOString();
        target.messages.push({
          timestamp: new Date().toISOString(),
          text: text || '[ملف مرفق مرسل من العيادة - تم إغلاق الشكوى]',
          fromMe: true,
          hasAttachment: true,
          isReminder: false
        });
        saveComplaintsCache(complaints);
        logEvent(`✅ Outbound attachment sent. Instantly CLOSED complaint ${target.complaintId || target.ticketId}.`, 'info');
      }
    }
    return; // Done
  }

  // Invoke Gemini service to make the decision
  const decision = await geminiService.processMessageEvent({
    phone,
    messageText: text,
    hasAttachment: hasAtt,
    isOutbound: fromMe,
    existingComplaints: existingForPhone
  });

  const action = decision.action;
  let targetId = decision.targetTicketId || decision.matchedComplaintId;

  // Local State Safeguard: Force single active complaint check
  const active = existingForPhone.find(c => c.status === 'OPEN');
  let finalAction = action;

  if ((action === 'CREATE' || action === 'OPEN_COMPLAINT') && active) {
    logEvent(`⚠️ Gemini suggested opening a new complaint, but overridden locally because complaint ${active.complaintId || active.ticketId} is already OPEN for +${phone}. Routing instead.`, 'warn');
    finalAction = 'INCREMENT';
    targetId = active.complaintId || active.ticketId;
  }

  if (finalAction === 'CREATE' || finalAction === 'OPEN_COMPLAINT') {
    const finalTicketId = decision.extractedTicketId || `complaint_${phone}_${Math.floor(Date.now() / 1000)}`;
    const newComplaint = {
      complaintId: finalTicketId,
      ticketId: finalTicketId,
      phone,
      name: msg.pushName || 'وزارة الصحة',
      senderPhone: phone,
      senderName: msg.pushName || 'وزارة الصحة',
      status: 'OPEN',
      summary: decision.summary || 'شكوى جديدة',
      category: decision.category || 'أخرى',
      draftReply: decision.draftReply || '',
      openDate: new Date().toISOString(),
      closeDate: null,
      messageCount: 1,
      reminderCount: decision.isReminder ? 1 : 0,
      lastReminderDate: decision.isReminder ? new Date().toISOString() : null,
      messages: [{
        timestamp: new Date().toISOString(),
        text: text || '[ملف مرفق]',
        fromMe: false,
        hasAttachment: hasAtt,
        isReminder: !!decision.isReminder
      }]
    };
    complaints.push(newComplaint);
    saveComplaintsCache(complaints);
    logEvent(`🚨 Gemini opened new complaint ${finalTicketId} for +${phone} (IsReminder: ${!!decision.isReminder})`, 'info');

    if (!fromMe) {
      if (decision.isReminder) {
        await sendReminderAdminAlert(sock, phone, newComplaint.name, newComplaint.reminderCount, text);
      } else {
        await sendAdminAlertWithCounter(sock, phone, newComplaint.name, 1, text, true);
      }
    }
  } 
  else if ((finalAction === 'INCREMENT' || finalAction === 'ROUTE_TO_COMPLAINT') && targetId) {
    const target = complaints.find(c => c.complaintId === targetId || c.ticketId === targetId);
    if (target) {
      if (decision.isReminder && !fromMe) {
        target.reminderCount = (target.reminderCount || 0) + 1;
        target.lastReminderDate = new Date().toISOString();
      }
      target.messages.push({
        timestamp: new Date().toISOString(),
        text: text || '[ملف مرفق]',
        fromMe,
        hasAttachment: hasAtt,
        isReminder: !fromMe && !!decision.isReminder
      });

      if (!fromMe) {
        target.messageCount += 1;
      }
      
      if (decision.summary) target.summary = decision.summary;
      if (decision.category) target.category = decision.category;
      if (decision.draftReply) target.draftReply = decision.draftReply;

      saveComplaintsCache(complaints);
      logEvent(`📥 Gemini routed message to complaint ${target.complaintId || target.ticketId} (Count: ${target.messageCount}, Reminders: ${target.reminderCount || 0})`, 'info');

      if (!fromMe) {
        if (decision.isReminder) {
          await sendReminderAdminAlert(sock, phone, target.name, target.reminderCount || 1, text);
        } else {
          await sendAdminAlertWithCounter(sock, phone, target.name, target.messageCount, text, true);
        }
      }
    }
  } 
  else if ((action === 'CLOSE' || action === 'CLOSE_COMPLAINT') && targetId) {
    const target = complaints.find(c => c.complaintId === targetId || c.ticketId === targetId);
    if (target) {
      target.status = 'CLOSED';
      target.closeDate = new Date().toISOString();
      target.messages.push({
        timestamp: new Date().toISOString(),
        text: text || (fromMe ? '[ملف مرفق مرسل من العيادة - تم إغلاق الشكوى]' : '[تم إغلاق الشكوى من قبل وزارة الصحة]'),
        fromMe,
        hasAttachment: hasAtt,
        isReminder: false
      });
      saveComplaintsCache(complaints);
      logEvent(`✅ Gemini closed complaint ${target.complaintId || target.ticketId} based on message interaction.`, 'info');
    }
  } 
  else {
    // IGNORE / NO_ACTION
    if (!fromMe) {
      // Forward general message to admin WITHOUT counter
      if (decision.isReminder) {
        // If somehow classified as reminder but action is IGNORE, still treat as reminder alert with count 1
        await sendReminderAdminAlert(sock, phone, msg.pushName || 'وزارة الصحة', 1, text);
      } else {
        await sendAdminAlertWithCounter(sock, phone, msg.pushName || 'وزارة الصحة', null, text, false);
      }
    }
  }
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
  await initComplaintsStore();

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
  store.bind(sock.ev);

  // Persist store to disk every 5 minutes and on key events (message upsert, history sync, chats sync)
  const saveStore = () => { try { store.writeToFile(STORE_FILE); } catch (_) {} };
  setInterval(saveStore, 5 * 60 * 1000);
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
      if (action === 'add') {
        if (!chatLabels[a.chatId]) chatLabels[a.chatId] = new Set();
        chatLabels[a.chatId].add(labelIdStr);
        changed = true;
        console.log(`🏷️ Label associated: Chat ${a.chatId} -> Label ID ${labelIdStr}`);
      } else if (action === 'remove') {
        chatLabels[a.chatId]?.delete(labelIdStr);
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
    if (type !== 'notify') return;

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
      
      const complaints = loadComplaintsCache();
      const hasActiveComplaint = complaints.some(c => phoneNumbersMatch(c.phone || c.senderPhone || '', senderPhone) && c.status === 'OPEN');
      const isMOH         = isMOHLabel || isMOHNumber || isMOHPushName || hasActiveComplaint;

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
      let phone = jid.replace('@s.whatsapp.net', '').replace('@lid', '');
      
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
      if (cleanPhone) {
        phoneNumbers.add(cleanPhone);
      }
    }
  }
  
  return Array.from(phoneNumbers);
}

// ─── Get Chat History from Store ──────────────────────────────────────────────
function getChatHistory(phone) {
  const jid = resolveJid(phone);
  const rawMessages = store.messages[jid] ? Array.from(store.messages[jid]) : [];
  
  const storeHistory = rawMessages
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
  const history = getChatHistory(phone);
  if (history.length === 0) {
    throw new Error('No WhatsApp message history loaded for this phone number yet.');
  }

  const complaints = loadComplaintsCache();
  const existingForPhone = complaints.filter(c => phoneNumbersMatch(c.phone || c.senderPhone || '', phone));
  const activeComplaint = existingForPhone.find(c => c.status === 'OPEN');
  
  const analysis = await geminiService.analyzeChatHistory({
    phone,
    history,
    activeTicketId: activeComplaint ? (activeComplaint.ticketId || activeComplaint.complaintId) : null
  });

  if (analysis && analysis.hasActiveComplaint) {
    const finalTicketId = activeComplaint
      ? (activeComplaint.ticketId || activeComplaint.complaintId)
      : (analysis.extractedTicketId || `complaint_${phone}_${Math.floor(Date.now() / 1000)}`);
      
    const mappedMessages = history.map(h => {
      const isReminder = h.sender === 'MOH' && (
        /تذكير|أين الرد|متبقي الرد|الرجاء الرد|عاجل|عجلو بالرد|بانتظار الرد|reminder|urgent|please reply|reply needed/i.test(h.text || '')
      );
      return {
        timestamp: h.timestamp,
        text: h.text || '[ملف مرفق]',
        fromMe: h.sender === 'Clinic',
        hasAttachment: h.hasAttachment,
        isReminder
      };
    });

    const isClosed = analysis.complaintStatus === 'CLOSED';
    
    const reconstructed = {
      complaintId: finalTicketId,
      ticketId: finalTicketId,
      phone,
      name: activeComplaint?.name || 'وزارة الصحة',
      senderPhone: phone,
      senderName: activeComplaint?.senderName || 'وزارة الصحة',
      status: analysis.complaintStatus || 'OPEN',
      summary: analysis.summary || 'شكوى مستوردة',
      category: analysis.category || 'أخرى',
      draftReply: analysis.draftReply || '',
      openDate: history[0]?.timestamp || new Date().toISOString(),
      closeDate: isClosed ? (history[history.length - 1]?.timestamp || new Date().toISOString()) : null,
      messageCount: mappedMessages.filter(m => !m.fromMe).length,
      reminderCount: analysis.reminderCount || 0,
      lastReminderDate: mappedMessages.filter(m => m.isReminder).pop()?.timestamp || null,
      messages: mappedMessages
    };

    const cleanList = complaints.filter(c => !phoneNumbersMatch(c.phone || c.senderPhone || '', phone));
    cleanList.push(reconstructed);
    saveComplaintsCache(cleanList);

    logEvent(`🔄 Reconstructed complaint ${finalTicketId} from chat history (+${phone}). Reminders: ${reconstructed.reminderCount}`, 'info');
    return reconstructed;
  } else {
    if (activeComplaint) {
      activeComplaint.status = 'CLOSED';
      activeComplaint.closeDate = new Date().toISOString();
      saveComplaintsCache(complaints);
      logEvent(`🔄 Chat history scan determined no active complaint for +${phone}. Closed existing open ticket.`, 'info');
    } else {
      logEvent(`🔄 Chat history scan found no active complaint for +${phone}.`, 'info');
    }
    return null;
  }
}

// ─── Scan All MOH Chats in Chat History ───────────────────────────────────────
async function scanAllMOHComplaints() {
  // ── Phase 1: Direct cache refresh (no Gemini needed) ──────────────────────
  // For all contacts that ALREADY exist in complaints_cache.json, we update
  // their reminder counts and message counts directly from the stored messages.
  // This is the primary fix: cache-known contacts don't need the Baileys store.
  const existingComplaints = loadComplaintsCache();
  const updatedComplaints = [];
  const cachePhones = new Set();

  for (const c of existingComplaints) {
    const phone = (c.phone || c.senderPhone || '').replace(/\D/g, '');
    if (!phone) continue;
    cachePhones.add(phone);

    // Re-compute reminders and counts from stored messages array
    const msgs = Array.isArray(c.messages) ? c.messages : [];
    const inboundMsgs = msgs.filter(m => !m.fromMe);
    const reminderMsgs = msgs.filter(m => !m.fromMe && m.isReminder);
    const lastReminder = reminderMsgs.length > 0 ? reminderMsgs[reminderMsgs.length - 1].timestamp : null;

    let changed = false;
    if (c.messageCount !== inboundMsgs.length) { c.messageCount = inboundMsgs.length; changed = true; }
    if (c.reminderCount !== reminderMsgs.length) { c.reminderCount = reminderMsgs.length; changed = true; }
    if (c.lastReminderDate !== lastReminder) { c.lastReminderDate = lastReminder; changed = true; }

    if (changed) {
      logEvent(`🔄 [Scanner] Refreshed counts for ${c.complaintId || c.ticketId}: msgs=${c.messageCount}, reminders=${c.reminderCount}`, 'info');
    }
    updatedComplaints.push(c);
  }

  // Save refreshed cache
  if (updatedComplaints.length > 0) {
    saveComplaintsCache(updatedComplaints);
  }

  const scannedCount = { success: updatedComplaints.length, failed: 0, noComplaint: 0, geminiCalled: 0 };

  // ── Phase 2: Discover new contacts via Baileys store + env + labels ────────
  // Only call Gemini for phone numbers NOT already in the cache.
  const newPhones = new Set();

  // From env vars
  if (Array.isArray(MOH_NUMBERS)) {
    for (const p of MOH_NUMBERS) {
      const clean = (p || '').replace(/\D/g, '');
      if (clean && !cachePhones.has(clean)) newPhones.add(clean);
    }
  }

  // From MOH label in chatLabels
  try {
    const labeledPhones = await getMOHNumbersFromLabels();
    for (const p of labeledPhones) {
      const clean = (p || '').replace(/\D/g, '');
      if (clean && !cachePhones.has(clean)) newPhones.add(clean);
    }
  } catch (err) {
    logEvent(`⚠️ Failed to retrieve labeled MOH numbers during scan: ${err.message}`, 'warn');
  }

  // From live Baileys store (messages received since last restart)
  if (store && store.messages) {
    for (const jid of Object.keys(store.messages)) {
      if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')) {
        const clean = jid.split('@')[0].replace(/\D/g, '');
        if (clean && !cachePhones.has(clean)) newPhones.add(clean);
      }
    }
  }

  logEvent(`🔍 [Scanner] Phase 1 refreshed ${scannedCount.success} cached complaints. Phase 2 found ${newPhones.size} new candidate(s) to check via Gemini.`, 'info');

  for (const phone of newPhones) {
    try {
      const history = getChatHistory(phone);
      if (history.length === 0) {
        scannedCount.noComplaint++;
        continue;
      }
      scannedCount.geminiCalled++;
      const reconstructed = await reconstructComplaintFromHistory(phone);
      if (reconstructed) {
        scannedCount.success++;
        updatedComplaints.push(reconstructed);
      } else {
        scannedCount.noComplaint++;
      }
      // Delay to avoid Gemini API rate limits
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (err) {
      scannedCount.failed++;
      logEvent(`⚠️ Scanning error for +${phone}: ${err.message}`, 'error');
    }
  }

  logEvent(`🏁 Completed history scan. Refreshed: ${scannedCount.success}, Gemini calls: ${scannedCount.geminiCalled}, No Complaint: ${scannedCount.noComplaint}, Failed: ${scannedCount.failed}`, 'info');
  return {
    scannedCandidateCount: existingComplaints.length + newPhones.size,
    successCount: scannedCount.success,
    failedCount: scannedCount.failed,
    noComplaintCount: scannedCount.noComplaint,
    complaints: updatedComplaints
  };
}

// ─── AI Deep Scan: Read Conversations & Detect Open Complaints ──────────────────
/**
 * Collects ALL known MOH phone numbers, reads their full conversation history
 * (from the Baileys store or fallback to complaints cache), then sends every
 * conversation to Gemini AI to determine whether an open complaint exists,
 * how many reminders were sent, and the current status.
 *
 * Unlike scanAllMOHComplaints() which only refreshes counts from stored data,
 * this function makes Gemini re-read the raw messages and detect complaints
 * autonomously — even for phones not yet tracked in the cache.
 *
 * @returns {Promise<object>} Scan summary with detected complaints.
 */
async function aiDeepScanMOHConversations() {
  const allPhones = new Set();

  // 1. MOH phones from environment variable
  if (Array.isArray(MOH_NUMBERS)) {
    for (const p of MOH_NUMBERS) {
      const clean = (p || '').replace(/\D/g, '');
      if (clean) allPhones.add(clean);
    }
  }

  // 2. Phones from the MOH WhatsApp label (chatLabels map)
  try {
    const labeled = await getMOHNumbersFromLabels();
    for (const p of labeled) {
      const clean = (p || '').replace(/\D/g, '');
      if (clean) allPhones.add(clean);
    }
  } catch (_) {}

  // 3. Phones already in the complaints cache
  const cachedComplaints = loadComplaintsCache();
  for (const c of cachedComplaints) {
    const p = (c.phone || c.senderPhone || '').replace(/\D/g, '');
    if (p) allPhones.add(p);
  }

  // 4. Every phone that has messages in the live Baileys store
  if (store && store.messages) {
    for (const jid of Object.keys(store.messages)) {
      if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')) {
        const clean = jid.split('@')[0].replace(/\D/g, '');
        if (clean) allPhones.add(clean);
      }
    }
  }

  const phoneList = Array.from(allPhones);
  logEvent(`🧠 [AI Deep Scan] Starting Gemini conversation analysis for ${phoneList.length} MOH contact(s)...`, 'info');

  const results = { found: 0, open: 0, closed: 0, noData: 0, failed: 0 };
  const detectedComplaints = [];

  for (const phone of phoneList) {
    try {
      // Get conversation history — from live store or fallback to cache messages
      const history = getChatHistory(phone);

      if (history.length === 0) {
        logEvent(`🔍 [AI Deep Scan] No message history found for +${phone} — skipping.`, 'info');
        results.noData++;
        continue;
      }

      logEvent(`💬 [AI Deep Scan] Sending ${history.length} messages for +${phone} to Gemini...`, 'info');

      // Find existing tracked complaint for this phone
      const existingForPhone = cachedComplaints.find(c =>
        phoneNumbersMatch(c.phone || c.senderPhone || '', phone)
      );
      const activeTicketId = existingForPhone
        ? (existingForPhone.ticketId || existingForPhone.complaintId)
        : null;

      // Ask Gemini to analyze the full conversation
      const analysis = await geminiService.analyzeChatHistory({
        phone,
        history,
        activeTicketId
      });

      results.found++;

      if (analysis && analysis.hasActiveComplaint) {
        results.open++;

        const finalTicketId = existingForPhone
          ? (existingForPhone.ticketId || existingForPhone.complaintId)
          : (analysis.extractedTicketId || `complaint_${phone}_${Math.floor(Date.now() / 1000)}`);

        // Map raw history into stored message format
        const mappedMessages = history.map(h => {
          const isReminder = h.sender === 'MOH' && (
            /تذكير|أين الرد|متبقي الرد|الرجاء الرد|عاجل|عجلو بالرد|بانتظار الرد|reminder|urgent|please reply|reply needed/i.test(h.text || '')
          );
          return {
            timestamp: h.timestamp,
            text: h.text || '[ملف مرفق]',
            fromMe: h.sender === 'Clinic',
            hasAttachment: h.hasAttachment,
            isReminder
          };
        });

        const isClosed = analysis.complaintStatus === 'CLOSED';
        const upsertedComplaint = {
          complaintId: finalTicketId,
          ticketId: finalTicketId,
          phone,
          name: existingForPhone?.name || 'وزارة الصحة',
          senderPhone: phone,
          senderName: existingForPhone?.senderName || 'وزارة الصحة',
          status: analysis.complaintStatus || 'OPEN',
          summary: analysis.summary || 'شكوى مكتشفة بواسطة الذكاء الاصطناعي',
          category: analysis.category || 'أخرى',
          draftReply: analysis.draftReply || '',
          openDate: existingForPhone?.openDate || history[0]?.timestamp || new Date().toISOString(),
          closeDate: isClosed ? (history[history.length - 1]?.timestamp || new Date().toISOString()) : null,
          messageCount: mappedMessages.filter(m => !m.fromMe).length,
          reminderCount: analysis.reminderCount || 0,
          lastReminderDate: mappedMessages.filter(m => m.isReminder).pop()?.timestamp || null,
          messages: mappedMessages,
          lastAiScan: new Date().toISOString()
        };

        // Upsert into complaints cache
        const allComplaints = loadComplaintsCache();
        const filteredList = allComplaints.filter(c =>
          !phoneNumbersMatch(c.phone || c.senderPhone || '', phone)
        );
        filteredList.push(upsertedComplaint);
        saveComplaintsCache(filteredList);

        detectedComplaints.push(upsertedComplaint);
        logEvent(`✅ [AI Deep Scan] +${phone}: ${analysis.complaintStatus} complaint detected. Reminders: ${analysis.reminderCount}. ID: ${finalTicketId}`, 'info');

      } else {
        results.closed++;
        // If AI says no active complaint but we have an open one, close it
        if (existingForPhone && existingForPhone.status === 'OPEN') {
          const allComplaints = loadComplaintsCache();
          const target = allComplaints.find(c =>
            phoneNumbersMatch(c.phone || c.senderPhone || '', phone) && c.status === 'OPEN'
          );
          if (target) {
            target.status = 'CLOSED';
            target.closeDate = new Date().toISOString();
            target.lastAiScan = new Date().toISOString();
            saveComplaintsCache(allComplaints);
          }
          logEvent(`🔄 [AI Deep Scan] +${phone}: AI determined complaint is CLOSED. Updated cache.`, 'info');
        } else {
          logEvent(`🔍 [AI Deep Scan] +${phone}: No active complaint detected by AI.`, 'info');
        }
      }

      // Throttle Gemini calls to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 600));
    } catch (err) {
      results.failed++;
      logEvent(`⚠️ [AI Deep Scan] Failed for +${phone}: ${err.message}`, 'error');
    }
  }

  logEvent(`🏁 [AI Deep Scan] Complete. Total: ${phoneList.length}, Has Data: ${results.found}, Open Complaints: ${results.open}, Closed/None: ${results.closed}, No History: ${results.noData}, Errors: ${results.failed}`, 'info');

  return {
    totalScanned: phoneList.length,
    withHistory: results.found,
    openComplaints: results.open,
    closedOrNone: results.closed,
    noHistoryData: results.noData,
    failedCount: results.failed,
    detectedComplaints
  };
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

module.exports = { connect, sendMessage, getStatus, getLabels, addLabelToChat, isRegisteredNumber, getLogs, logEvent, disconnectGracefully, getMOHNumbersFromLabels, getComplaintsStore, closeComplaint, promoteTemporaryComplaint, processMOHMessagePipeline, getChatHistory, reconstructComplaintFromHistory, scanAllMOHComplaints, aiDeepScanMOHConversations, store, chatLabels, addManualComplaint, updateManualComplaint };

