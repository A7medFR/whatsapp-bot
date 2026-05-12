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
const FORWARD_NUMBERS = (process.env.FORWARD_NUMBERS || '')
  .split(',').map(n => n.replace(/\D/g, '')).filter(Boolean);

const LEADS_LABEL    = process.env.LEADS_LABEL_NAME || 'ليدز باتريكس 1';
const LEADS_LABEL_ID = (process.env.LEADS_LABEL_ID  || '').trim();
const MOH_LABEL      = process.env.MOH_LABEL_NAME   || 'وزارة الصحة';
const MOH_LABEL_ID   = (process.env.MOH_LABEL_ID    || '').trim();

// Phone numbers of وزارة الصحة contacts (digits only, with country code)
// The bot will notify admins whenever a message arrives from any of these numbers
const MOH_NUMBERS = (process.env.MOH_NUMBERS || '')
  .split(',').map(n => n.replace(/\D/g, '')).filter(Boolean);

const LABELS_FILE    = path.resolve('./labels_cache.json');


// ─── State ────────────────────────────────────────────────────────────────────
let sock     = null;
let isReady  = false;
let qrString = null;

const labelsStore = {};   // labelId → { id, name, color }
const chatLabels  = {};   // jid     → Set<labelId>

const getStatus = () => ({ connected: isReady, hasQR: !!qrString, qr: qrString });
const getLabels = () => labelsStore;

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

// ─── Label helpers ────────────────────────────────────────────────────────────
function findLabelId(labelName) {
  // 1. Look up by name in store (populated by passive events if available)
  const entry = Object.entries(labelsStore).find(([, l]) => l.name === labelName);
  if (entry) return entry[0];
  // 2. Manual overrides from .env
  if (labelName === LEADS_LABEL && LEADS_LABEL_ID) return LEADS_LABEL_ID;
  if (labelName === MOH_LABEL   && MOH_LABEL_ID)   return MOH_LABEL_ID;
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

  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
  const { version }          = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth:   state,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    connectTimeoutMs:      30000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs:   25000,
    markOnlineOnConnect:   false,
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
  sock.ev.on('label-association.upsert', (data) => {
    console.log('🔍 [DEBUG] label-association.upsert:', JSON.stringify(data));
    const list = Array.isArray(data) ? data : (data?.associations || []);
    for (const a of list) {
      if (!a?.chatId || !a?.labelId) continue;
      if (!chatLabels[a.chatId]) chatLabels[a.chatId] = new Set();
      chatLabels[a.chatId].add(a.labelId);
    }
  });

  sock.ev.on('label-association.delete', (data) => {
    const list = Array.isArray(data) ? data : (data?.associations || []);
    for (const a of list) chatLabels[a?.chatId]?.delete(a?.labelId);
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
        chatLabels[jid].add(typeof lId === 'string' ? lId : lId?.id || lId?.labelId);
        found++;
      }
    }
    if (found > 0) console.log(`🏷️  Loaded ${found} label association(s) from chat sync.`);
  };

  sock.ev.on('chats.upsert',  (chats) => extractChatLabels(chats));
  sock.ev.on('chats.update',  (chats) => extractChatLabels(chats));
  sock.ev.on('chats.set',     ({ chats } = {}) => extractChatLabels(chats));

  // ── Notify admin when a وزارة الصحة labeled chat sends a message ──────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message) continue;
      const sender = msg.key.remoteJid;
      if (!sender || sender.endsWith('@g.us')) continue;

      const mohLabelId = findLabelId(MOH_LABEL);

      // Debug: always log what labels we know for this sender
      const knownLabels = [
        ...(chatLabels[sender] || new Set()),
        ...(chatLabels[sender.replace('@s.whatsapp.net', '')] || new Set()),
      ];
      if (knownLabels.length > 0) {
        console.log(`📩 Message from ${sender} — labels: [${knownLabels.join(', ')}] — MOH ID: ${mohLabelId}`);
      }

      const isMOH = mohLabelId && knownLabels.includes(mohLabelId);

      if (isMOH && FORWARD_NUMBERS.length > 0) {
        console.log(`\n📨 وزارة الصحة message from ${sender} — notifying admins...`);

        const c = msg.message;
        const preview =
          c?.conversation ||
          c?.extendedTextMessage?.text ||
          c?.imageMessage?.caption ||
          c?.videoMessage?.caption ||
          c?.documentMessage?.title ||
          (c?.audioMessage    ? '(رسالة صوتية)' :
           c?.imageMessage    ? '(صورة)'         :
           c?.videoMessage    ? '(فيديو)'         :
           c?.documentMessage ? '(ملف)'           : '(رسالة جديدة)');

        const senderPhone = sender.replace('@s.whatsapp.net', '');
        const notification =
          `🔔 *تنبيه — رسالة جديدة من وزارة الصحة*\n\n` +
          `📱 المرسل: +${senderPhone}\n` +
          `💬 الرسالة: ${preview}\n\n` +
          `يرجى فتح واتساب والرد على الرسالة.`;

        for (const num of FORWARD_NUMBERS) {
          try {
            await sock.sendMessage(`${num}@s.whatsapp.net`, { text: notification });
            console.log(`   ✅ Notified +${num}`);
          } catch (err) {
            console.error(`   ❌ Failed → +${num}: ${err.message}`);
          }
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

// ─── Send ─────────────────────────────────────────────────────────────────────
async function sendMessage(phone, payload) {
  if (!sock || !isReady) throw new Error('WhatsApp is not connected yet.');
  const jid = `${phone}@s.whatsapp.net`;

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
      console.warn(`⚠️  Unrecognised image format, skipping image for: ${payload.caption}`);
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
  } else if (payload.text) {
    await sock.sendMessage(jid, { text: payload.text });
  }
}

module.exports = { connect, sendMessage, getStatus, getLabels, addLabelToChat };
