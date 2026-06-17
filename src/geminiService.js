/**
 * geminiService.js
 * Interfaces with Google Gemini API to analyze message intents,
 * route follow-up messages, categorize complaints, and draft responses.
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

/**
 * Process a message event and determine the correct system action.
 * 
 * @param {object} params
 * @param {string} params.phone - The MOH contact phone number.
 * @param {string} params.messageText - The text content of the message.
 * @param {boolean} params.hasAttachment - Whether the message has an attachment.
 * @param {boolean} params.isOutbound - True if sent by the clinic, false if sent by MOH.
 * @param {Array} params.existingComplaints - The historical complaints list for this phone number.
 * @returns {Promise<object>} The structured JSON action decision.
 */
async function processMessageEvent({ phone, messageText, hasAttachment, isOutbound, existingComplaints }) {
  if (!ai) {
    if (global.logEvent) {
      global.logEvent('⚠️ GEMINI_API_KEY is missing. Using fallback rule engine.', 'warn');
    }
    return getFallbackDecision({ phone, messageText, hasAttachment, isOutbound, existingComplaints });
  }

  try {
    const activeTickets = existingComplaints.filter(c => c.status === 'OPEN');

    const prompt = `
You are the AI supervisor for a medical clinic's WhatsApp bot that tracks Ministry of Health (MOH) regulatory complaints.
Your job is to analyze a new message event (inbound from MOH, or outbound from Clinic) and decide the system action, mapping it to the correct complaint/ticket.

### Ledger Records (Active Open Complaints for this Sender):
${JSON.stringify(activeTickets.map(t => ({ ticketId: t.ticketId || t.complaintId, status: t.status, summary: t.summary, messageCount: t.messageCount, reminderCount: t.reminderCount || 0 })), null, 2)}

### History for this Sender:
${JSON.stringify(existingComplaints.map(t => ({ ticketId: t.ticketId || t.complaintId, status: t.status, summary: t.summary })))}

### Message Telemetry Layer:
- Phone: ${phone}
- New Message: "${messageText || '[Media/Attachment File]'}"
- Has Attachment: ${hasAttachment}
- Is Outbound (From Clinic): ${isOutbound}

### Critical Decision Matrix Mandates:
1. CREATE: Select if an MOH Officer (inbound) opens a brand new case, or sends a message describing a complaint. IMPORTANT: You MUST ONLY select CREATE if there are NO active open complaints in the Ledger Records (Active Open Complaints list is empty). If there is already an OPEN complaint, you MUST NOT select CREATE.
2. INCREMENT: Select if an MOH Officer (inbound) follows up or provides data regarding one of the listed open tickets, OR if they send any message while a complaint is already active (since we only track one active complaint at a time). You MUST specify the exact targetTicketId matching the history (this could be the ticketId or complaintId).
3. CLOSE: Select if Clinic Staff pushes an attachment file or explicitly indicates resolution. Specify the targetTicketId to lock down. If MOH (inbound) explicitly thanks the clinic and confirms closure, select CLOSE.
4. IGNORE: Select if the message contains non-actionable elements like greetings ('شكرا', 'السلام عليكم', 'مرحبا') or trivial validation checks without any active complaint, or if the message is general talk and shouldn't alter any ticket.
5. REMINDER DETECTION: Analyze if the new inbound message from MOH is a reminder/follow-up query demanding action or a response for a complaint (e.g. asking for status, asking "تذكير", "أين الرد؟", "يرجى الرد عاجلاً", "متبقي الرد", "لم يتم حلها بعد", "عجلوا بالإجراء", "reminder", "urgent reply needed", "reply status"). Set "isReminder" to true if the message is a reminder, otherwise false. Note: Outbound messages from the clinic can never be classified as reminders.
6. DRAFT REPLY ESCALATION: Adjust your drafted professional response in Arabic based on the reminderCount of the active complaint:
   - If reminderCount is 0: Draft a standard, polite acknowledgment in Arabic.
   - If reminderCount is 1: Draft a polite acknowledgment requesting urgent response details from the department.
   - If reminderCount is >= 2: Draft a highly formal, urgent apology acknowledging their repeated reminders (e.g. "نعتذر بشدة عن التأخير في الرد على تذكيراتكم المتكررة..."), stating that the complaint has been escalated to senior clinic management, and outlining that resolution is being expedited.

Return ONLY a raw JSON structure matching this signature:
{
  "action": "CREATE" | "INCREMENT" | "CLOSE" | "IGNORE",
  "isReminder": true | false,
  "targetTicketId": "The ticketId or complaintId to alter (String or null)",
  "extractedTicketId": "If a brand new ID is declared in the text, extract it natively as 'MOH-XXXX' (String or null)",
  "summary": "Concise 1-sentence Arabic description of the complaint (required for CREATE or INCREMENT)",
  "category": "Arabic classification (e.g., 'أوقات الانتظار', 'سلوك الموظفين', 'الفواتير والأسعار', 'جودة العلاج', 'أخرى')",
  "draftReply": "A polite, professional response draft in Arabic addressing the MOH agent (optional)",
  "reasoning": "Clear logical justification for the routing and reminder determination"
}
`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.1-pro-preview',
      contents: prompt,
      config: {
        responseMimeType: 'application/json'
      }
    });

    const responseText = response.text;
    const decision = JSON.parse(responseText);

    const logMsg = `🤖 [Gemini Decision]: Action=${decision.action}, IsReminder=${decision.isReminder}, Match=${decision.targetTicketId}, Reason=${decision.reasoning}`;
    if (global.logEvent) {
      global.logEvent(logMsg, 'info');
    } else {
      console.log(logMsg);
    }
    
    return decision;
  } catch (err) {
    const errorMsg = `❌ [Gemini Error]: ${err.message}`;
    if (global.logEvent) {
      global.logEvent(errorMsg, 'error');
    } else {
      console.error(errorMsg);
    }
    return getFallbackDecision({ phone, messageText, hasAttachment, isOutbound, existingComplaints });
  }
}

/**
 * Fallback rules engine if Gemini is not available or errors out.
 */
function getFallbackDecision({ phone, messageText, hasAttachment, isOutbound, existingComplaints }) {
  const activeComplaint = existingComplaints.find(c => c.status === 'OPEN');
  const activeTicketId = activeComplaint ? (activeComplaint.ticketId || activeComplaint.complaintId) : null;

  const textLower = (messageText || '').toLowerCase();
  const reminderKeywords = [
    'تذكير', 'أين الرد', 'متبقي الرد', 'الرجاء الرد', 'عاجل', 'عجلو بالرد', 'بانتظار الرد',
    'reminder', 'urgent', 'please reply', 'reply needed', 'awaiting reply'
  ];
  const isReminder = !isOutbound && reminderKeywords.some(keyword => textLower.includes(keyword));

  if (isOutbound) {
    if (hasAttachment && activeComplaint) {
      return {
        action: 'CLOSE',
        isReminder: false,
        targetTicketId: activeTicketId,
        summary: activeComplaint.summary,
        category: activeComplaint.category,
        draftReply: '',
        reasoning: 'Fallback: Outbound attachment detected, closing active complaint.'
      };
    }
    return { action: 'IGNORE', isReminder: false, reasoning: 'Fallback: Outbound general text.' };
  } else {
    // Inbound
    if (activeComplaint) {
      return {
        action: 'INCREMENT',
        isReminder: isReminder,
        targetTicketId: activeTicketId,
        summary: activeComplaint.summary,
        category: activeComplaint.category,
        draftReply: 'تم استلام رسالتكم وجاري متابعتها مع القسم المختص.',
        reasoning: `Fallback: Active complaint exists, routing follow-up. IsReminder=${isReminder}`
      };
    }

    if (hasAttachment || textLower.length > 5) {
      return {
        action: 'CREATE',
        isReminder: isReminder,
        summary: 'شكوى جديدة',
        category: 'أخرى',
        draftReply: 'أهلاً بك، تم استلام رسالتكم وجاري فتح بطاقة شكوى للمتابعة.',
        reasoning: `Fallback: New inbound message, opening complaint. IsReminder=${isReminder}`
      };
    }

    return {
      action: 'IGNORE',
      isReminder: isReminder,
      reasoning: `Fallback: General short inbound text with no active complaint. IsReminder=${isReminder}`
    };
  }
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

    const response = await ai.models.generateContent({
      model: 'gemini-3.1-pro-preview',
      contents: prompt,
      config: {
        responseMimeType: 'application/json'
      }
    });

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
    const errorMsg = `❌ [Gemini History Scan Error]: ${err.message}`;
    if (global.logEvent) {
      global.logEvent(errorMsg, 'error');
    } else {
      console.error(errorMsg);
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

  // Detect reminders using simple client-side keyword matches
  const reminderKeywords = [
    'تذكير', 'أين الرد', 'متبقي الرد', 'الرجاء الرد', 'عاجل', 'عجلو بالرد', 'بانتظار الرد',
    'reminder', 'urgent', 'please reply', 'reply needed', 'awaiting reply'
  ];
  
  const reminderCount = mohMessages.filter(m => 
    reminderKeywords.some(keyword => (m.text || '').toLowerCase().includes(keyword))
  ).length;

  // If the last clinic message was an attachment, or if there is no open ticket, assume closed
  // Otherwise, assume open
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

module.exports = { processMessageEvent, analyzeChatHistory };
