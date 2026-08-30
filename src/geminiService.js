/**
 * geminiService.js
 * Interfaces with Google Gemini API to analyze message intents,
 * classify complaint types (NEW_COMPLAINT, REMINDER, OTHER),
 * route follow-up messages, categorize complaints, and draft responses.
 *
 * Optimizations:
 *  - Local greeting pre-filter: bypasses Gemini for simple greetings (~50% API call reduction)
 *  - 5-minute TTL in-memory cache: prevents redundant API calls for identical messages
 *  - Rate-limiting queue: capped at 12 requests/minute (safely under Gemini 15 RPM limit)
 *  - Graceful 429 fallback: falls back to local heuristics on quota exhaustion
 */

'use strict';

const { GoogleGenAI } = require('@google/genai');

// Initialize GenAI using the official SDK
const apiKey = process.env.GEMINI_API_KEY || '';
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

// Notify if the API Key is missing on startup
if (!ai) {
  setTimeout(() => {
    if (global.logEvent) {
      global.logEvent('⚠️ GEMINI_API_KEY is not configured in environment variables. Gemini AI is offline and running in fallback mode.', 'warn');
    } else {
      console.warn('⚠️ GEMINI_API_KEY is not configured.');
    }
  }, 2000);
} else {
  setTimeout(() => {
    if (global.logEvent) {
      global.logEvent('✨ Gemini AI connection initialized successfully.', 'info');
    }
  }, 2000);
}

// ─── Local Pre-filter: Simple greeting patterns ───────────────────────────────
// Messages matching these patterns are classified locally as OTHER without
// invoking the Gemini API at all — saves significant quota.
const GREETING_PATTERNS = [
  /^(السلام عليكم|وعليكم السلام|مرحبا|أهلا|هلا|شكراً|شكرا|تمام|حسناً|حسنا|ماشي|طيب|صباح الخير|مساء الخير|صباح النور|مساء النور|يسلمو|يسلموا|موقع|hello|hi|ok|okay|thanks|thank you)[.!؟?\s]*$/i,
];

function isSimpleGreeting(text) {
  if (!text || text.trim().length === 0) return false;
  const trimmed = text.trim();
  return GREETING_PATTERNS.some(re => re.test(trimmed));
}

// ─── 5-Minute TTL In-Memory Response Cache ───────────────────────────────────
// Caches Gemini classification results by a hash of phone+messageText.
// Prevents duplicate API calls when MOH sends identical follow-up messages.
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const responseCache = new Map(); // key → { result, expiresAt }

function getCacheKey(phone, messageText) {
  return `${phone}::${(messageText || '').trim().slice(0, 120)}`;
}

function getCachedResponse(phone, messageText) {
  const key = getCacheKey(phone, messageText);
  const entry = responseCache.get(key);
  if (entry && Date.now() < entry.expiresAt) {
    return entry.result;
  }
  responseCache.delete(key);
  return null;
}

function setCachedResponse(phone, messageText, result) {
  const key = getCacheKey(phone, messageText);
  responseCache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  // Limit cache size to 200 entries to avoid memory leaks
  if (responseCache.size > 200) {
    const firstKey = responseCache.keys().next().value;
    responseCache.delete(firstKey);
  }
}

// ─── Rate-Limiting Queue (max 12 requests/min = 1 per 5 seconds) ─────────────
// Spaces out requests to stay safely under Gemini's 15 RPM free tier limit.
// All Gemini API calls must go through this queue.
const RATE_LIMIT_INTERVAL_MS = 5000; // 5 seconds between requests = 12 RPM max
let lastRequestTime = 0;
const requestQueue = [];
let isProcessingQueue = false;

async function enqueueGeminiRequest(fn) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ fn, resolve, reject });
    if (!isProcessingQueue) {
      processQueue();
    }
  });
}

async function processQueue() {
  isProcessingQueue = true;
  while (requestQueue.length > 0) {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < RATE_LIMIT_INTERVAL_MS) {
      await new Promise(res => setTimeout(res, RATE_LIMIT_INTERVAL_MS - elapsed));
    }
    const item = requestQueue.shift();
    if (!item) break;
    lastRequestTime = Date.now();
    try {
      const result = await item.fn();
      item.resolve(result);
    } catch (err) {
      item.reject(err);
    }
  }
  isProcessingQueue = false;
}

/**
 * Checks if an error is a Gemini rate-limit / quota-exhaustion error (HTTP 429).
 */
function isRateLimitError(err) {
  const msg = (err.message || '').toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('resource_exhausted') ||
    msg.includes('rate limit') ||
    msg.includes('quota') ||
    (err.status === 429)
  );
}

/**
 * Process a message event and determine the correct system action.
 *
 * @param {object} params
 * @param {string} params.phone - The MOH contact phone number.
 * @param {string} params.messageText - The text content of the message.
 * @param {boolean} params.hasAttachment - Whether the message has an attachment (file or image from MOH).
 * @param {object} params.attachment - Optional object containing { buffer, mimetype }
 * @param {boolean} params.isOutbound - True if sent by the clinic, false if sent by MOH.
 * @param {Array} params.existingComplaints - The historical complaints list for this phone number.
 * @returns {Promise<object>} The structured JSON action decision.
 */
async function processMessageEvent({ phone, messageText, hasAttachment, attachment, isOutbound, existingComplaints }) {
  if (!ai) {
    if (global.logEvent) {
      global.logEvent('⚠️ GEMINI_API_KEY is missing. Using fallback rule engine.', 'warn');
    }
    return getFallbackDecision({ phone, messageText, hasAttachment, isOutbound, existingComplaints });
  }

  // ── Local Pre-filter: skip Gemini for simple greetings ─────────────────────
  if (!hasAttachment && isSimpleGreeting(messageText)) {
    if (global.logEvent) {
      global.logEvent(`🤖 [Gemini Skip] Simple greeting detected — classified locally as OTHER (saved 1 API call).`, 'info');
    }
    return {
      messageType: 'OTHER',
      isReminder: false,
      extractedReminderNumber: null,
      extractedTicketId: null,
      summary: 'تحية عامة',
      category: 'أخرى',
      draftReply: '',
      reasoning: 'Local pre-filter: simple greeting — Gemini API not invoked.'
    };
  }

  // ── Cache check: return cached result if available ───────────────────────────
  if (!hasAttachment) {
    const cached = getCachedResponse(phone, messageText);
    if (cached) {
      if (global.logEvent) {
        global.logEvent(`🤖 [Gemini Cache Hit] Returning cached classification for +${phone} (saved 1 API call).`, 'info');
      }
      return cached;
    }
  }

  try {
    const activeTickets = existingComplaints.filter(c => c.status === 'OPEN' || c.status === 'PENDING_REVIEW');

    const prompt = `
You are the AI supervisor for a medical clinic's WhatsApp bot that tracks Ministry of Health (MOH) regulatory complaints.
Your job is to analyze a new message event (inbound from MOH) and extract semantic metadata to help the system process it.
Note: Outbound messages from clinic staff are filtered by the system and never sent here.

### Ledger Records (Active Open Complaints for this Sender):
${JSON.stringify(activeTickets.map(t => ({ ticketId: t.ticketId || t.complaintId, status: t.status, summary: t.summary, messageCount: t.messageCount, reminderCount: t.reminderCount || 0 })), null, 2)}

### Message Telemetry:
- Phone: ${phone}
- Message Text: "${messageText || '[No text — media/attachment only]'}"
- Has Attachment (File or Image sent by MOH): ${hasAttachment}

### Classification & Extraction Rules:

1. **MESSAGE TYPE** (CRITICAL — must be exactly one of three values):
   - "NEW_COMPLAINT": The MOH is opening a brand new case. Use when:
     * The message mentions an explicit ticket number not in the Ledger above (e.g., "بلاغ رقم 123456")
     * The message describes a new patient complaint and there is NO open ticket in the Ledger
     * The MOH sends an attachment/file/image and there is NO open ticket in the Ledger — always treat an incoming MOH attachment with no active ticket as a new complaint
   - "REMINDER": The MOH is following up on an EXISTING case. Use when:
     * Words like "تذكير", "أين الرد", "عاجل", "يرجى الرد", "بانتظار الإفادة", "reminder", "urgent"
     * The message references a ticket that IS already in the Ledger above (open ticket exists)
     * The MOH sends an attachment/file/image and an open ticket already EXISTS in the Ledger — treat as evidence for the existing case
   - "OTHER": The message is clearly not a regulatory complaint or reminder. Examples:
     * Pure greetings: "السلام عليكم", "مرحبا", "شكراً"
     * Administrative pleasantries unrelated to any complaint
     * IMPORTANT: If the message has an attachment (File/Image) and contains ANY text indicating follow-up (like "الرجاء الافادة", "للإفادة", "مرفق"), do NOT classify as OTHER. It must be REMINDER or NEW_COMPLAINT.

2. **TICKET ID EXTRACTION**: If the message explicitly mentions a ticket ID (e.g. "بلاغ رقم 123456", "شكوى رقم 987654"), extract the numeric ID and prefix it as "MOH-XXXX". Otherwise, return null.

3. **IS REMINDER**: Set to true if messageType is "REMINDER", else false.

4. **REMINDER SEQUENCE NUMBER**: If isReminder is true and the message specifies a sequence number (e.g., "تذكير رقم 3", "التذكير الثالث", "تذكير ثاني"), extract it as an integer. Otherwise return null.

5. **COMPLAINT SUMMARY**: Concise 1-sentence Arabic summary of what the complaint is about. Note: "inspection" in clinic context means medical examination/checkup ("فحص"), not "تفتيش".

6. **CATEGORY**: One of: "أوقات الانتظار" | "سلوك الموظفين" | "الفواتير والأسعار" | "جودة العلاج" | "الفحص والكشف الطبي" | "أخرى"

7. **DRAFT REPLY**: Professional Arabic reply for clinic staff. Scale urgency by reminder count in Ledger:
   - 0 reminders: Standard polite acknowledgment.
   - 1 reminder: Urgently requesting internal department details to expedite.
   - 2+ reminders: Formal apology for repeated follow-ups, escalation to senior management.

Return ONLY a raw JSON object (no markdown, no explanation):
{
  "messageType": "NEW_COMPLAINT" | "REMINDER" | "OTHER",
  "isReminder": true | false,
  "extractedReminderNumber": number | null,
  "extractedTicketId": "MOH-XXXX" | null,
  "summary": "Arabic 1-sentence summary",
  "category": "Arabic category",
  "draftReply": "Arabic professional reply draft",
  "reasoning": "Brief justification for the messageType decision"
}
`;

    let parts = [{ text: prompt }];

    if (attachment && attachment.buffer && attachment.mimetype) {
      if (attachment.mimetype.startsWith('image/') || attachment.mimetype === 'application/pdf') {
        parts.push({
          inlineData: {
            data: attachment.buffer.toString("base64"),
            mimeType: attachment.mimetype
          }
        });
        if (global.logEvent) {
          global.logEvent(`🤖 Attached media to Gemini prompt (${attachment.mimetype})`, 'info');
        }
      }
    }

    const response = await enqueueGeminiRequest(() =>
      ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: parts,
        config: {
          responseMimeType: 'application/json'
        }
      })
    );

    const responseText = response.text;
    const metadata = JSON.parse(responseText);

    // Enforce consistency: isReminder must match messageType
    if (metadata.messageType === 'REMINDER') {
      metadata.isReminder = true;
    } else {
      metadata.isReminder = false;
    }

    const logMsg = `🤖 [Gemini]: Type=${metadata.messageType}, IsReminder=${metadata.isReminder}, Ticket=${metadata.extractedTicketId}, HasAttachment=${hasAttachment} | ${metadata.reasoning}`;
    if (global.logEvent) {
      global.logEvent(logMsg, 'info');
    } else {
      console.log(logMsg);
    }

    // Cache the result (only for text-only messages, not attachments)
    if (!hasAttachment) {
      setCachedResponse(phone, messageText, metadata);
    }

    return metadata;
  } catch (err) {
    if (isRateLimitError(err)) {
      const warnMsg = `⚠️ [Gemini Rate Limit] API quota reached. Using fallback heuristic for +${phone}. Details: ${err.message}`;
      if (global.logEvent) {
        global.logEvent(warnMsg, 'warn');
      } else {
        console.warn(warnMsg);
      }
    } else {
      const errorMsg = `❌ [Gemini Error]: ${err.message}`;
      if (global.logEvent) {
        global.logEvent(errorMsg, 'error');
      } else {
        console.error(errorMsg);
      }
    }
    return getFallbackDecision({ phone, messageText, hasAttachment, isOutbound, existingComplaints });
  }
}

/**
 * Fallback rules engine if Gemini is not available or errors out.
 * Mirrors the same classification logic (NEW_COMPLAINT / REMINDER / OTHER).
 */
function getFallbackDecision({ phone, messageText, hasAttachment, isOutbound, existingComplaints }) {
  const activeComplaint = existingComplaints.find(c => c.status === 'OPEN' || c.status === 'PENDING_REVIEW');
  const textLower = (messageText || '').toLowerCase();

  const reminderKeywords = [
    'تذكير', 'أين الرد', 'متبقي الرد', 'الرجاء الرد', 'عاجل', 'عجلو بالرد', 'بانتظار الرد',
    'reminder', 'urgent', 'please reply', 'reply needed', 'awaiting reply'
  ];

  const hasReminderKeyword = !isOutbound && reminderKeywords.some(keyword => textLower.includes(keyword));

  // Fallback messageType classification
  let messageType;
  if (hasAttachment) {
    // MOH sending a file/image: REMINDER if open ticket exists, NEW_COMPLAINT otherwise
    messageType = activeComplaint ? 'REMINDER' : 'NEW_COMPLAINT';
  } else if (hasReminderKeyword && activeComplaint) {
    messageType = 'REMINDER';
  } else if (hasReminderKeyword && !activeComplaint) {
    // Reminder keyword but no open ticket — treat as a new complaint (can't remind about nothing)
    messageType = 'NEW_COMPLAINT';
  } else if (messageText && messageText.trim().length > 10) {
    // Substantive text, no reminder keywords → new complaint or increment existing
    messageType = activeComplaint ? 'REMINDER' : 'NEW_COMPLAINT';
  } else {
    // Short text, no attachment, no specific keywords → OTHER (still gets logged)
    messageType = 'OTHER';
  }

  const isReminder = messageType === 'REMINDER';

  let extractedReminderNumber = null;
  if (isReminder) {
    const numMatch = (messageText || '').match(/\u062a\u0630\u0643\u064a\u0631\s*(?:\u0631\u0642\u0645)?\s*(\d+)/i)
      || (messageText || '').match(/\u062a\u0630\u0643\u064a\u0631\s*([\u0661-\u0669\u06f1-\u06f9]+)/);
    if (numMatch) {
      const arabicToWestern = (s) => s.replace(/[\u0660-\u0669\u06f0-\u06f9]/g, d => d.charCodeAt(0) & 0xf);
      const parsed = parseInt(arabicToWestern(numMatch[1]), 10);
      if (!isNaN(parsed)) extractedReminderNumber = parsed;
    } else if (/\u062b\u0627\u0646\u064a|\u062b\u0627\u0646\u064d/i.test(messageText || '')) {
      extractedReminderNumber = 2;
    } else if (/\u062b\u0627\u0644\u062b/i.test(messageText || '')) {
      extractedReminderNumber = 3;
    } else if (/\u0631\u0627\u0628\u0639/i.test(messageText || '')) {
      extractedReminderNumber = 4;
    } else if (/\u062e\u0627\u0645\u0633/i.test(messageText || '')) {
      extractedReminderNumber = 5;
    }
  }

  let draftReply = 'تم استلام رسالتكم وجاري متابعتها مع القسم المختص.';
  const reminderCount = activeComplaint ? (activeComplaint.reminderCount || 0) : 0;
  if (reminderCount >= 2) {
    draftReply = 'نعتذر بشدة عن التأخير في الرد على تذكيراتكم المتكررة، وقد تم تصعيد الموضوع للإدارة العليا بالعيادة لإنهاء المتطلبات فوراً.';
  } else if (reminderCount === 1) {
    draftReply = 'نقر باستلام تذكيركم، ونود إفادتكم بأن الشكوى جاري العمل عليها بشكل عاجل حالياً.';
  }

  const ticketRegex = /(?:\u0628\u0644\u0627\u063a\s*\u0631\u0642\u0645\s*|\u0634\u0643\u0648\u0649\s*\u0631\u0642\u0645\s*|\u0631\u0642\u0645\s*\u0627\u0644\u0628\u0644\u0627\u063a\s*)(\d+)/i;
  const match = (messageText || '').match(ticketRegex);
  const extractedTicketId = match ? `MOH-${match[1]}` : null;

  return {
    messageType,
    isReminder,
    extractedReminderNumber,
    extractedTicketId,
    summary: activeComplaint ? activeComplaint.summary : 'شكوى جديدة',
    category: activeComplaint ? activeComplaint.category : 'أخرى',
    draftReply: isOutbound ? '' : draftReply,
    reasoning: `Fallback: Local heuristics. MessageType=${messageType}, HasAttachment=${hasAttachment}, HasReminderKeyword=${hasReminderKeyword}, ActiveTicket=${!!activeComplaint}.`
  };
}

/**
 * Analyze chronological message history for a phone number and reconstruct the complaint status/details.
 *
 * @param {object} params
 * @param {string} params.phone - Phone number.
 * @param {Array} params.history - List of simplified messages: [ { timestamp, sender, text, hasAttachment } ]
 * @param {string} params.activeTicketId - Optional ID of the currently tracked active complaint.
 * @returns {Promise<object>} Reconstructed complaint analysis.
 */
async function analyzeChatHistory({ phone, history, activeTicketId }) {
  if (!ai) {
    if (global.logEvent) {
      global.logEvent('⚠️ GEMINI_API_KEY is missing. Reconstruct using fallback history engine.', 'warn');
    }
    return getFallbackHistoryDecision({ phone, history, activeTicketId });
  }

  try {
    const prompt = `
You are the AI auditor for a clinic's WhatsApp bot that tracks Ministry of Health (MOH) regulatory complaints.
Your job is to read a chronological log of recent messages between the MOH official ("MOH") and the Clinic ("Clinic") for the phone number (+${phone}), reconstruct the complaint status, and count the official reminders sent.

### Conversation Log (Sorted Oldest to Newest):
${JSON.stringify(history, null, 2)}

### Current State context:
- Active Tracked Ticket ID: ${activeTicketId || 'None'}

### Audit Instructions:
1. **Identify Complaint Existence**: Determine if the MOH official has raised a regulatory issue/complaint in the conversation.
2. **Determine Status**:
   - Set status to "OPEN" if there is an unresolved regulatory issue or if the MOH has requested a reply/action that hasn't been closed by clinic documentation.
   - Set status to "CLOSED" if the clinic has sent resolving documents (attachments) or if the MOH official explicitly confirms resolution.
3. **Count MOH Reminders**: Count how many times the MOH official sent a follow-up reminder asking for status, asking for the reply, or using urgent words (e.g., "تذكير", "أين الرد؟", "عاجل", "يرجى الرد", "reminder", "urgent reply status").
4. **Formulate Arabic Response Draft**: Draft a polite, formal reply in Arabic addressing the MOH agent. Scale the urgency of the response based on the reminder count:
   - If reminder count is 0: Standard polite acknowledgment.
   - If reminder count is 1: Requesting urgent details from the department.
   - If reminder count is >= 2: Apologize formally for the multiple reminders ("نعتذر بشدة عن التأخير..."), state senior management escalation, and promise immediate resolution.

Return ONLY a raw JSON structure matching this signature:
{
  "hasActiveComplaint": true | false,
  "complaintStatus": "OPEN" | "CLOSED",
  "reminderCount": number,
  "extractedTicketId": "If an official ticket code like 'MOH-XXXX' was declared by MOH in the text, extract it (String or null)",
  "summary": "Arabic summary of the complaint (required if hasActiveComplaint is true)",
  "category": "Arabic classification (e.g., 'أوقات الانتظار', 'سلوك الموظفين', 'الفواتير والأسعار', 'جودة العلاج', 'أخرى')",
  "draftReply": "Polite, formal response draft in Arabic addressing the MOH agent (optional)",
  "reasoning": "Audit reasoning explaining how status was determined and reminders were counted"
}
`;

    const response = await enqueueGeminiRequest(() =>
      ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json'
        }
      })
    );

    const responseText = response.text;
    const analysis = JSON.parse(responseText);

    const logMsg = `🤖 [Gemini History Scan]: HasComplaint=${analysis.hasActiveComplaint}, Status=${analysis.complaintStatus}, Reminders=${analysis.reminderCount}, Reason=${analysis.reasoning}`;
    if (global.logEvent) {
      global.logEvent(logMsg, 'info');
    } else {
      console.log(logMsg);
    }

    return analysis;
  } catch (err) {
    if (isRateLimitError(err)) {
      const warnMsg = `⚠️ [Gemini History Scan Rate Limit] API quota reached. Using fallback heuristic for +${phone}. Details: ${err.message}`;
      if (global.logEvent) {
        global.logEvent(warnMsg, 'warn');
      } else {
        console.warn(warnMsg);
      }
    } else {
      const errorMsg = `❌ [Gemini History Scan Error]: ${err.message}`;
      if (global.logEvent) {
        global.logEvent(errorMsg, 'error');
      } else {
        console.error(errorMsg);
      }
    }
    return getFallbackHistoryDecision({ phone, history, activeTicketId });
  }
}

/**
 * Fallback history analyzer using local regex rules.
 */
function getFallbackHistoryDecision({ phone, history, activeTicketId }) {
  const mohMessages = history.filter(h => h.sender === 'MOH');
  const clinicMessages = history.filter(h => h.sender === 'Clinic');

  if (mohMessages.length === 0) {
    return {
      hasActiveComplaint: false,
      complaintStatus: 'CLOSED',
      reminderCount: 0,
      extractedTicketId: null,
      summary: '',
      category: 'أخرى',
      draftReply: '',
      reasoning: 'Fallback: No messages from MOH found in history.'
    };
  }

  const reminderKeywords = [
    'تذكير', 'أين الرد', 'متبقي الرد', 'الرجاء الرد', 'عاجل', 'عجلو بالرد', 'بانتظار الرد',
    'reminder', 'urgent', 'please reply', 'reply needed', 'awaiting reply'
  ];

  const reminderCount = mohMessages.filter(m =>
    reminderKeywords.some(keyword => (m.text || '').toLowerCase().includes(keyword))
  ).length;

  const lastClinicMessage = clinicMessages[clinicMessages.length - 1];
  const hasOutboundAttachment = lastClinicMessage && lastClinicMessage.hasAttachment;

  const status = hasOutboundAttachment ? 'CLOSED' : 'OPEN';

  let draftReply = 'تم استلام رسالتكم وجاري متابعتها مع القسم المختص.';
  if (reminderCount >= 2) {
    draftReply = 'نعتذر بشدة عن التأخير في الرد على تذكيراتكم المتكررة، وقد تم تصعيد الموضوع للإدارة العليا بالعيادة لإنهاء المتطلبات فوراً.';
  } else if (reminderCount === 1) {
    draftReply = 'نقر باستلام تذكيركم، ونود إفادتكم بأن الشكوى جاري العمل عليها بشكل عاجل حالياً.';
  }

  return {
    hasActiveComplaint: true,
    complaintStatus: status,
    reminderCount: reminderCount,
    extractedTicketId: activeTicketId,
    summary: mohMessages[0]?.text?.substring(0, 60) || 'شكوى مستوردة',
    category: 'أخرى',
    draftReply: draftReply,
    reasoning: `Fallback: Reconstructed via local heuristics. Reminders=${reminderCount}, Status=${status}`
  };
}

/**
 * AI Discovery Classifier: Analyzes an incoming message from an unknown contact
 * to determine with high confidence if it is from the Ministry of Health (MOH) or a regulatory body.
 *
 * @param {object} params
 * @param {string} params.phone - Sender phone number.
 * @param {string} params.pushName - Sender WhatsApp push name.
 * @param {string} params.messageText - Incoming message text.
 * @param {boolean} params.hasAttachment - Media attachment status.
 * @returns {Promise<object>} Structured AI discovery classification.
 */
async function classifyIncomingMOHMessage({ phone, pushName, messageText, hasAttachment }) {
  if (!ai) {
    return getFallbackDiscoveryDecision({ phone, pushName, messageText, hasAttachment });
  }

  try {
    const prompt = `
You are the AI Regulatory Officer for a Saudi medical clinic.
Your job is to analyze an incoming WhatsApp message from an unlisted contact (+${phone}, Name: "${pushName || 'Unknown'}") and determine whether this message is an official communication, complaint, audit, inspection, or referral from the Ministry of Health (MOH - وزارة الصحة), Health Affairs (الشؤون الصحية), Private Sector Compliance (القطاع الخاص), or 937 call center.

Message Telemetry:
- Phone: +${phone}
- Push Name: "${pushName || ''}"
- Message Text: "${messageText || '[No text — media/attachment only]'}"
- Has Attachment (File/Image): ${hasAttachment}

Classification Criteria for isMOH = true:
1. Mentions ticket/complaint keywords (e.g., "بلاغ رقم", "شكوى رقم", "إفادة", "تذكير", "وزارة الصحة", "الشؤون الصحية", "937", "القطاع الخاص", "المخالفات").
2. Contains official regulatory tone, compliance notices, or requests official clinic responses within 24-48 hours. (Note: "inspection" in patient/clinic records refers to "فحص" medical checkup, not "تفتيش").
3. Contains attachments sent alongside regulatory inquiry terms.

Return ONLY a JSON object with:
{
  "isMOH": boolean,
  "confidence": number (0.0 to 1.0),
  "messageCategory": "NEW_COMPLAINT" | "REMINDER" | "INSPECTION_NOTICE" | "GENERAL_INQUIRY" | "OTHER",
  "extractedTicketId": string or null (e.g. "MOH-874921"),
  "urgency": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  "summary": string (Concise Arabic summary),
  "suggestedAction": string (Action for clinic staff),
  "reasoning": string (Short explanation)
}
`;

    const response = await enqueueGeminiRequest(() =>
      ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json'
        }
      })
    );

    const result = JSON.parse(response.text);
    if (global.logEvent) {
      global.logEvent(`🤖 [AI Discovery Classifier]: isMOH=${result.isMOH}, Confidence=${result.confidence}, Urgency=${result.urgency}, Category=${result.messageCategory}`, 'info');
    }
    return result;
  } catch (err) {
    if (isRateLimitError(err)) {
      if (global.logEvent) {
        global.logEvent(`⚠️ [AI Discovery Rate Limit] API quota reached for +${phone}. Using heuristic fallback. Details: ${err.message}`, 'warn');
      }
    } else {
      if (global.logEvent) {
        global.logEvent(`⚠️ [AI Discovery Error]: ${err.message}. Using heuristic fallback.`, 'warn');
      }
    }
    return getFallbackDiscoveryDecision({ phone, pushName, messageText, hasAttachment });
  }
}

function getFallbackDiscoveryDecision({ phone, pushName, messageText, hasAttachment }) {
  const text = (messageText || '').toLowerCase();
  const name = (pushName || '').toLowerCase();

  const mohKeywords = [
    'وزارة الصحة', 'الشؤون الصحية', 'القطاع الخاص', 'بلاغ', 'شكوى', 'تذكير',
    '937', 'إفادة', 'موافاتنا', 'ministry of health', 'moh'
  ];

  const hasNameKeyword = mohKeywords.some(k => name.includes(k));
  const hasTextKeyword = mohKeywords.some(k => text.includes(k));

  const ticketMatch = (messageText || '').match(/(?:بلاغ\s*رقم\s*|شكوى\s*رقم\s*|رقم\s*البلاغ\s*)(\d+)/i);
  const ticketId = ticketMatch ? `MOH-${ticketMatch[1]}` : null;

  const isMOH = hasNameKeyword || hasTextKeyword || !!ticketId;

  return {
    isMOH,
    confidence: isMOH ? 0.85 : 0.10,
    messageCategory: ticketId ? 'NEW_COMPLAINT' : (isMOH ? 'GENERAL_INQUIRY' : 'OTHER'),
    extractedTicketId: ticketId,
    urgency: isMOH ? 'MEDIUM' : 'LOW',
    summary: text.substring(0, 60) || 'رسالة واردة',
    suggestedAction: isMOH ? 'مراجعة الرسالة والرد على وزارة الصحة' : 'لا يلزم إجابة',
    reasoning: 'Fallback heuristic classification'
  };
}

module.exports = { processMessageEvent, analyzeChatHistory, classifyIncomingMOHMessage };
