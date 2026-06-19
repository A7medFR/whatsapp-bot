'use strict';

const fs = require('fs');
const path = require('path');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

// State configuration
const COMPLAINTS_FILE = path.resolve('./complaints_cache.json');
let complaintsStore = [];

// Injected dependencies / helper functions
let db = null;
let geminiService = null;
let getChatHistoryHelper = null;
let triggerAdminAlertHelper = null;
let sendAdminAlertWithCounterHelper = null;
let sendReminderAdminAlertHelper = null;
let isReadyCallback = () => false;

/**
 * Normalizes a phone number to digits only and handles Saudi phone number conversions.
 */
function formatJidNumber(phone) {
  if (!phone) return '';
  let clean = phone.replace(/\D/g, '');
  if (clean.startsWith('05') && clean.length === 10) {
    clean = '966' + clean.slice(1);
  } else if (clean.startsWith('5') && clean.length === 9) {
    clean = '966' + clean;
  }
  return clean;
}

/**
 * Checks if two phone numbers are equivalent.
 */
function phoneNumbersMatch(phone1, phone2) {
  const p1 = formatJidNumber(phone1);
  const p2 = formatJidNumber(phone2);
  if (!p1 || !p2) return false;
  if (p1 === p2) return true;
  if (p1.length >= 9 && p2.length >= 9) {
    return p1.endsWith(p2) || p2.endsWith(p1);
  }
  return false;
}

/**
 * Helper to log events via the global logger if configured.
 */
function logEvent(message, level = 'info') {
  if (global.logEvent) {
    global.logEvent(message, level);
  } else {
    console.log(`[${level.toUpperCase()}] ${message}`);
  }
}

/**
 * Initializes the complaints manager with database, service integrations, and helper functions.
 */
async function init(options) {
  db = options.db;
  geminiService = options.geminiService;
  getChatHistoryHelper = options.getChatHistory;
  triggerAdminAlertHelper = options.triggerAdminAlert;
  sendAdminAlertWithCounterHelper = options.sendAdminAlertWithCounter;
  sendReminderAdminAlertHelper = options.sendReminderAdminAlert;
  isReadyCallback = options.isReady || (() => false);

  // Load complaints from database, fallback to local cache
  try {
    const dbComplaints = await db.getComplaints();
    if (dbComplaints && dbComplaints.length > 0) {
      complaintsStore = dbComplaints;
      logEvent(`📋 Loaded ${complaintsStore.length} complaints from Database.`, 'info');
      try {
        fs.writeFileSync(COMPLAINTS_FILE, JSON.stringify(complaintsStore, null, 2), 'utf8');
      } catch (_) {}
      return;
    }
  } catch (err) {
    logEvent(`Failed to load complaints from DB, falling back to local file: ${err.message}`, 'warn');
  }

  // Fallback to local file
  try {
    if (fs.existsSync(COMPLAINTS_FILE)) {
      complaintsStore = JSON.parse(fs.readFileSync(COMPLAINTS_FILE, 'utf8')) || [];
      logEvent(`📋 Loaded ${complaintsStore.length} complaints from local cache file.`, 'info');
    }
  } catch (err) {
    logEvent(`Failed to load complaints cache from local file: ${err.message}`, 'error');
  }
}

function loadComplaintsCache() {
  return complaintsStore;
}

function saveComplaintsCache(list) {
  if (list) complaintsStore = list;
  try {
    fs.writeFileSync(COMPLAINTS_FILE, JSON.stringify(complaintsStore, null, 2), 'utf8');
  } catch (err) {
    logEvent(`Failed to save complaints cache to local file: ${err.message}`, 'error');
  }
  
  // Sync to database
  if (db) {
    db.saveComplaints(complaintsStore).catch(err => {
      logEvent(`Failed to sync complaints to persistent database: ${err.message}`, 'error');
    });
  }
}

function getComplaintsStore() {
  return complaintsStore;
}

/**
 * Closes an active complaint manually.
 */
function closeComplaint(complaintId) {
  const complaints = loadComplaintsCache();
  const complaint = complaints.find(c => c.complaintId === complaintId || c.ticketId === complaintId);
  if (complaint) {
    complaint.status = 'CLOSED';
    complaint.closeDate = new Date().toISOString();
    saveComplaintsCache(complaints);
    logEvent(`✅ Complaint ${complaintId} resolved manually.`, 'info');
    return true;
  }
  return false;
}

/**
 * Promotes a temporary complaint to a verified ticket ID.
 */
function promoteTemporaryComplaint(complaintId, officialId) {
  const complaints = loadComplaintsCache();
  
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

/**
 * Adds a new complaint manually from the dashboard.
 */
function addManualComplaint(data) {
  const complaints = loadComplaintsCache();
  const ticketId = (data.ticketId || '').trim() || `complaint_${data.phone}_${Math.floor(Date.now() / 1000)}`;
  
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

/**
 * Updates a complaint manually from the dashboard.
 */
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
  
  saveComplaintsCache(complaints);
  logEvent(`✏️ Manually updated complaint ${ticketId}`, 'info');
  return c;
}

/**
 * Deletes a complaint.
 */
function deleteComplaint(complaintId) {
  const complaints = loadComplaintsCache();
  const index = complaints.findIndex(c => c.complaintId === complaintId || c.ticketId === complaintId);
  if (index !== -1) {
    complaints.splice(index, 1);
    saveComplaintsCache(complaints);
    logEvent(`❌ Complaint ${complaintId} deleted manually.`, 'info');
    return true;
  }
  return false;
}

/**
 * Extracts ticket IDs using strict regex.
 */
function extractTicketId(text) {
  if (!text) return null;
  const ticketRegex = /(?:بلاغ\s*رقم\s*|شكوى\s*رقم\s*|رقم\s*البلاغ\s*)(\d+)/i;
  const match = text.match(ticketRegex);
  return match ? `MOH-${match[1]}` : null;
}

/**
 * Main AI-driven message pipeline.
 * Every message from MOH is classified by Gemini AI as:
 *   NEW_COMPLAINT → creates a new open ticket
 *   REMINDER      → increments counter on the matching ticket
 *   OTHER         → always logged; never silently discarded
 * MOH attachments (files/images) are always captured regardless of classification.
 */
async function processMOHMessagePipeline(msg, sock) {
  if (!msg || !msg.message) return;

  const remoteJid = msg.key.remoteJid;
  const phone = remoteJid.split('@')[0].replace(/\D/g, '');
  const fromMe = !!msg.key.fromMe;
  const pushName = msg.pushName || '';

  // Safe multi-media text extractor
  const unwrapped = msg.message?.ephemeralMessage?.message ||
                    msg.message?.viewOnceMessage?.message ||
                    msg.message?.viewOnceMessageV2?.message ||
                    msg.message;

  const text = unwrapped?.conversation ||
               unwrapped?.extendedTextMessage?.text ||
               unwrapped?.imageMessage?.caption ||
               unwrapped?.documentMessage?.caption ||
               unwrapped?.videoMessage?.caption || '';

  const hasAttachment = !!(msg.message.imageMessage ||
                           msg.message.documentMessage ||
                           msg.message.videoMessage ||
                           msg.message.audioMessage ||
                           msg.message.ephemeralMessage?.message?.imageMessage ||
                           msg.message.ephemeralMessage?.message?.documentMessage ||
                           msg.message.viewOnceMessage?.message?.imageMessage ||
                           msg.message.viewOnceMessage?.message?.documentMessage ||
                           msg.message.viewOnceMessageV2?.message?.imageMessage ||
                           msg.message.viewOnceMessageV2?.message?.documentMessage);

  let mediaBuffer = null;
  let mediaMimeType = null;

  if (hasAttachment && sock && !fromMe) {
    try {
      mediaBuffer = await downloadMediaMessage(
        msg,
        'buffer',
        { },
        { logger: console }
      );
      const unwrappedMsg = msg.message.ephemeralMessage?.message || 
                           msg.message.viewOnceMessage?.message || 
                           msg.message.viewOnceMessageV2?.message || 
                           msg.message;
      const imgMsg = unwrappedMsg.imageMessage;
      const docMsg = unwrappedMsg.documentMessage;
      
      if (imgMsg) mediaMimeType = imgMsg.mimetype;
      else if (docMsg) mediaMimeType = docMsg.mimetype;
      
      logEvent(`📎 Downloaded media attachment: ${mediaMimeType}`, 'info');
    } catch (err) {
      logEvent(`⚠️ Failed to download media attachment: ${err.message}`, 'warn');
    }
  }

  let complaints = loadComplaintsCache();
  const existingForPhone = complaints.filter(c => phoneNumbersMatch(c.phone || c.senderPhone || '', phone));
  const active = existingForPhone.find(c => c.status === 'OPEN' || c.status === 'PENDING_REVIEW');

  // ----------------------------------------------------
  // CASE A: OUTBOUND MESSAGE (from Clinic Staff)
  // ----------------------------------------------------
  if (fromMe) {
    if (!active) return;

    if (hasAttachment) {
      active.status = 'PENDING_REVIEW';
      active.messages.push({
        timestamp: new Date().toISOString(),
        text: text || '[ملف مرفق مرسل من العيادة - بانتظار المراجعة]',
        fromMe: true,
        hasAttachment: true,
        isReminder: false,
        messageType: 'OUTBOUND_ATTACHMENT'
      });
      saveComplaintsCache(complaints);
      logEvent(`⚠️ Outbound attachment sent. Mutated complaint ${active.ticketId} status to PENDING_REVIEW.`, 'info');

      if (sock && isReadyCallback()) {
        try {
          await sock.sendMessage(remoteJid, {
            text: `⚠️ تم استلام الملف المرفق. تم تحويل بطاقة الشكوى (${active.ticketId}) إلى مرحلة المراجعة للتأكد من مطابقة شروط الإغلاق المعتمدة.`
          });
        } catch (err) {
          logEvent(`Failed to send PENDING_REVIEW notice on WA: ${err.message}`, 'warn');
        }
      }
    } else {
      active.messages.push({
        timestamp: new Date().toISOString(),
        text: text || '',
        fromMe: true,
        hasAttachment: false,
        isReminder: false,
        messageType: 'OUTBOUND_TEXT'
      });
      saveComplaintsCache(complaints);
      logEvent(`💬 Outbound text added to complaint history for ${active.ticketId}.`, 'info');
    }
    return;
  }

  // ----------------------------------------------------
  // CASE B: INBOUND MESSAGE (from MOH Officer)
  // Gemini AI classifies every message. Nothing is ignored.
  // ----------------------------------------------------

  // Step 1: Ask Gemini AI to classify and extract metadata
  let geminiResult = {
    messageType: null,
    extractedTicketId: null,
    isReminder: false,
    extractedReminderNumber: null,
    summary: 'رسالة واردة',
    category: 'أخرى',
    draftReply: ''
  };

  try {
    if (geminiService) {
      const response = await geminiService.processMessageEvent({
        phone,
        messageText: text,
        hasAttachment,
        attachment: mediaBuffer ? { buffer: mediaBuffer, mimetype: mediaMimeType } : null,
        isOutbound: fromMe,
        existingComplaints: existingForPhone
      });
      if (response) {
        geminiResult = response;
      }
    }
  } catch (err) {
    logEvent(`Gemini classification failed: ${err.message}. Using fallback.`, 'warn');
  }

  // Step 2: Resolve messageType — use AI result or safe heuristic fallback
  let messageType = geminiResult.messageType;
  if (!messageType) {
    if (hasAttachment) {
      messageType = active ? 'REMINDER' : 'NEW_COMPLAINT';
    } else if (active) {
      messageType = 'REMINDER';
    } else if (text && text.trim().length > 5) {
      messageType = 'NEW_COMPLAINT';
    } else {
      messageType = 'OTHER';
    }
  }

  // Step 3: Resolve target ticket ID from regex or Gemini extraction
  let targetTicketId = extractTicketId(text) || geminiResult.extractedTicketId || null;

  // Step 4: Prevent duplicate creation — if AI says NEW_COMPLAINT but ticket already exists and is OPEN, treat as REMINDER
  if (messageType === 'NEW_COMPLAINT' && targetTicketId) {
    const existingTicket = complaints.find(c => c.ticketId === targetTicketId || c.complaintId === targetTicketId);
    if (existingTicket && existingTicket.status === 'OPEN') {
      logEvent(`ℹ️ NEW_COMPLAINT reclassified to REMINDER: ticket ${targetTicketId} already open.`, 'info');
      messageType = 'REMINDER';
    }
  }

  // ── Branch: NEW_COMPLAINT ────────────────────────────────────────────────────
  if (messageType === 'NEW_COMPLAINT') {
    if (!targetTicketId) {
      targetTicketId = `complaint_${phone}_${Math.floor(Date.now() / 1000)}`;
    }

    const isTemp = !targetTicketId.startsWith('MOH-');
    const newComplaint = {
      complaintId: targetTicketId,
      ticketId: targetTicketId,
      phone,
      name: pushName || 'وزارة الصحة',
      senderPhone: phone,
      senderName: pushName || 'وزارة الصحة',
      status: 'OPEN',
      summary: geminiResult.summary || 'شكوى جديدة',
      category: geminiResult.category || 'أخرى',
      draftReply: geminiResult.draftReply || '',
      openDate: new Date().toISOString(),
      closeDate: null,
      messageCount: 1,
      reminderCount: 0,
      lastReminderDate: null,
      messages: [{
        timestamp: new Date().toISOString(),
        text: text || '[ملف مرفق]',
        fromMe: false,
        hasAttachment,
        isReminder: false,
        messageType: 'NEW_COMPLAINT'
      }],
      isTemporary: isTemp
    };

    complaints.push(newComplaint);
    saveComplaintsCache(complaints);
    logEvent(`🚨 [AI: NEW_COMPLAINT] Opened ticket ${targetTicketId} for +${phone} (Attachment: ${hasAttachment}, Temp: ${isTemp})`, 'info');

    if (sendAdminAlertWithCounterHelper) {
      const attachmentNote = hasAttachment ? '📎 [مع ملف/صورة] ' : '';
      const alertText = `🆕 ${attachmentNote}شكوى جديدة من وزارة الصحة\n` +
                        `📱 الرقم: +${phone}\n` +
                        `👤 الاسم: ${pushName || 'وزارة الصحة'}\n` +
                        `🎫 رقم البطاقة: ${targetTicketId}\n` +
                        `📊 عدد الرسائل: 1\n` +
                        `💬 الرسالة: ${text || '[ملف مرفق]'}`;
      await sendAdminAlertWithCounterHelper(phone, pushName || 'وزارة الصحة', 1, alertText, false, msg);
    }
  }
  // ── Branch: REMINDER ─────────────────────────────────────────────────────────
  else if (messageType === 'REMINDER') {
    let matchedComplaint = null;
    if (targetTicketId) {
      matchedComplaint = complaints.find(c => c.ticketId === targetTicketId || c.complaintId === targetTicketId);
    }
    if (!matchedComplaint) {
      matchedComplaint = active;
    }

    if (!matchedComplaint) {
      targetTicketId = `complaint_${phone}_${Math.floor(Date.now() / 1000)}`;
      const autoTicket = {
        complaintId: targetTicketId,
        ticketId: targetTicketId,
        phone,
        name: pushName || 'وزارة الصحة',
        senderPhone: phone,
        senderName: pushName || 'وزارة الصحة',
        status: 'OPEN',
        summary: geminiResult.summary || 'تذكير شكوى (فُتح تلقائياً)',
        category: geminiResult.category || 'أخرى',
        draftReply: geminiResult.draftReply || '',
        openDate: new Date().toISOString(),
        closeDate: null,
        messageCount: 1,
        reminderCount: geminiResult.extractedReminderNumber || 1,
        lastReminderDate: new Date().toISOString(),
        messages: [{
          timestamp: new Date().toISOString(),
          text: text || '[ملف مرفق]',
          fromMe: false,
          hasAttachment,
          isReminder: true,
          messageType: 'REMINDER'
        }],
        isTemporary: true
      };
      complaints.push(autoTicket);
      saveComplaintsCache(complaints);
      logEvent(`🔔 [AI: REMINDER] No active ticket found — auto-created ${targetTicketId} for +${phone}`, 'info');
      if (sendReminderAdminAlertHelper) {
        await sendReminderAdminAlertHelper(phone, pushName || 'وزارة الصحة', autoTicket.reminderCount, text, msg);
      }
      return;
    }

    if (matchedComplaint.status !== 'OPEN') {
      matchedComplaint.status = 'OPEN';
      matchedComplaint.closeDate = null;
      logEvent(`🔄 Re-opened complaint ${matchedComplaint.ticketId} due to incoming MOH REMINDER.`, 'info');
    }

    if (typeof geminiResult.extractedReminderNumber === 'number') {
      matchedComplaint.reminderCount = geminiResult.extractedReminderNumber;
    } else {
      matchedComplaint.reminderCount = (matchedComplaint.reminderCount || 0) + 1;
    }
    matchedComplaint.lastReminderDate = new Date().toISOString();

    matchedComplaint.messages.push({
      timestamp: new Date().toISOString(),
      text: text || '[ملف مرفق]',
      fromMe: false,
      hasAttachment,
      isReminder: true,
      messageType: 'REMINDER'
    });
    matchedComplaint.messageCount += 1;

    if (geminiResult.summary && matchedComplaint.summary === 'شكوى جديدة') {
      matchedComplaint.summary = geminiResult.summary;
    }
    if (geminiResult.category && matchedComplaint.category === 'أخرى') {
      matchedComplaint.category = geminiResult.category;
    }
    if (geminiResult.draftReply) {
      matchedComplaint.draftReply = geminiResult.draftReply;
    }

    saveComplaintsCache(complaints);
    logEvent(`🔔 [AI: REMINDER] Ticket ${matchedComplaint.ticketId} | Msgs: ${matchedComplaint.messageCount} | Reminders: ${matchedComplaint.reminderCount}`, 'info');

    if (sendReminderAdminAlertHelper) {
      await sendReminderAdminAlertHelper(phone, matchedComplaint.name, matchedComplaint.reminderCount || 1, text, msg);
    }
  }
  // ── Branch: OTHER ─────────────────────────────────────────────────────────────
  else {
    logEvent(`ℹ️ [AI: OTHER] Message from +${phone} classified as OTHER — forwarding directly without registering as complaint.`, 'info');

    if (triggerAdminAlertHelper) {
      const alertText = `ℹ️ ممثل الوزارة ارسل رسالة مفادها:\n` +
                        `💬 ${text || '[ملف مرفق]'}\n\n` +
                        `📱 الرقم: +${phone}\n` +
                        `👤 الاسم: ${pushName || 'وزارة الصحة'}`;
      await triggerAdminAlertHelper(alertText, msg);
    }
  }
}

/**
 * Reconstruct history from database or cache fallback.
 */
function getChatHistory(phone) {
  if (getChatHistoryHelper) {
    return getChatHistoryHelper(phone);
  }
  return [];
}

/**
 * Reconstructs a complaint from full WhatsApp chat history.
 */
async function reconstructComplaintFromHistory(phone) {
  const history = getChatHistory(phone);
  if (history.length === 0) {
    throw new Error('No WhatsApp message history loaded for this phone number yet.');
  }

  const complaints = loadComplaintsCache();
  const existingForPhone = complaints.filter(c => phoneNumbersMatch(c.phone || c.senderPhone || '', phone));
  const activeComplaint = existingForPhone.find(c => c.status === 'OPEN');
  
  if (!geminiService) return null;
  
  const activeTicketId = activeComplaint ? (activeComplaint.ticketId || activeComplaint.complaintId) : null;
  const analysis = await geminiService.analyzeChatHistory({
    phone,
    history,
    activeTicketId
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
      messages: mappedMessages,
      isTemporary: !finalTicketId.startsWith('MOH-')
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

/**
 * Scans all known complaints and updates counts from raw message store history.
 */
async function scanAllMOHComplaints(MOH_NUMBERS, getMOHNumbersFromLabels) {
  const existingComplaints = loadComplaintsCache();
  const updatedComplaints = [];
  const cachePhones = new Set();

  for (const c of existingComplaints) {
    const phone = (c.phone || c.senderPhone || '').replace(/\D/g, '');
    if (!phone) continue;
    cachePhones.add(phone);

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

  if (updatedComplaints.length > 0) {
    saveComplaintsCache(updatedComplaints);
  }

  const scannedCount = { success: updatedComplaints.length, failed: 0, noComplaint: 0, geminiCalled: 0 };
  const newPhones = new Set();

  // Load from static numbers
  if (Array.isArray(MOH_NUMBERS)) {
    for (const p of MOH_NUMBERS) {
      const clean = (p || '').replace(/\D/g, '');
      if (clean && !cachePhones.has(clean)) newPhones.add(clean);
    }
  }

  // Load from labeled numbers
  if (getMOHNumbersFromLabels) {
    try {
      const labeledPhones = await getMOHNumbersFromLabels();
      for (const p of labeledPhones) {
        const clean = (p || '').replace(/\D/g, '');
        if (clean && !cachePhones.has(clean)) newPhones.add(clean);
      }
    } catch (err) {
      logEvent(`⚠️ Failed to retrieve labeled MOH numbers during scan: ${err.message}`, 'warn');
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

/**
 * Executes a deep AI scan on all conversations to detect missing complaints or resolve status.
 */
async function aiDeepScanMOHConversations(MOH_NUMBERS, getMOHNumbersFromLabels) {
  const allPhones = new Set();

  if (Array.isArray(MOH_NUMBERS)) {
    for (const p of MOH_NUMBERS) {
      const clean = (p || '').replace(/\D/g, '');
      if (clean) allPhones.add(clean);
    }
  }

  if (getMOHNumbersFromLabels) {
    try {
      const labeled = await getMOHNumbersFromLabels();
      for (const p of labeled) {
        const clean = (p || '').replace(/\D/g, '');
        if (clean) allPhones.add(clean);
      }
    } catch (_) {}
  }

  const cachedComplaints = loadComplaintsCache();
  for (const c of cachedComplaints) {
    const p = (c.phone || c.senderPhone || '').replace(/\D/g, '');
    if (p) allPhones.add(p);
  }

  const phoneList = Array.from(allPhones);
  logEvent(`🧠 [AI Deep Scan] Starting Gemini conversation analysis for ${phoneList.length} MOH contact(s)...`, 'info');

  const results = { found: 0, open: 0, closed: 0, noData: 0, failed: 0 };
  const detectedComplaints = [];

  for (const phone of phoneList) {
    try {
      const history = getChatHistory(phone);
      if (history.length === 0) {
        logEvent(`🔍 [AI Deep Scan] No message history found for +${phone} — skipping.`, 'info');
        results.noData++;
        continue;
      }

      logEvent(`💬 [AI Deep Scan] Sending ${history.length} messages for +${phone} to Gemini...`, 'info');

      const existingForPhone = cachedComplaints.find(c => phoneNumbersMatch(c.phone || c.senderPhone || '', phone));
      const activeTicketId = existingForPhone ? (existingForPhone.ticketId || existingForPhone.complaintId) : null;

      if (!geminiService) continue;

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
          lastAiScan: new Date().toISOString(),
          isTemporary: !finalTicketId.startsWith('MOH-')
        };

        const allComplaints = loadComplaintsCache();
        const filteredList = allComplaints.filter(c => !phoneNumbersMatch(c.phone || c.senderPhone || '', phone));
        filteredList.push(upsertedComplaint);
        saveComplaintsCache(filteredList);

        detectedComplaints.push(upsertedComplaint);
        logEvent(`✅ [AI Deep Scan] +${phone}: ${analysis.complaintStatus} complaint detected. Reminders: ${analysis.reminderCount}. ID: ${finalTicketId}`, 'info');
      } else {
        results.closed++;
        if (existingForPhone && existingForPhone.status === 'OPEN') {
          const allComplaints = loadComplaintsCache();
          const target = allComplaints.find(c => phoneNumbersMatch(c.phone || c.senderPhone || '', phone) && c.status === 'OPEN');
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

module.exports = {
  init,
  loadComplaintsCache,
  saveComplaintsCache,
  getComplaintsStore,
  closeComplaint,
  promoteTemporaryComplaint,
  addManualComplaint,
  updateManualComplaint,
  deleteComplaint,
  processMOHMessagePipeline,
  getChatHistory,
  reconstructComplaintFromHistory,
  scanAllMOHComplaints,
  aiDeepScanMOHConversations
};
