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
${JSON.stringify(activeTickets.map(t => ({ ticketId: t.ticketId || t.complaintId, status: t.status, summary: t.summary, messageCount: t.messageCount })), null, 2)}

### History for this Sender:
${JSON.stringify(existingComplaints.map(t => ({ ticketId: t.ticketId || t.complaintId, status: t.status, summary: t.summary })))}

### Message Telemetry Layer:
- Phone: ${phone}
- New Message: "${messageText || '[Media/Attachment File]'}"
- Has Attachment: ${hasAttachment}
- Is Outbound (From Clinic): ${isOutbound}

### Critical Decision Matrix Mandates:
1. CREATE: Select if an MOH Officer (inbound) opens a brand new case, or sends a message describing a complaint completely unrelated to listed active complaints. If an explicit registration number is referenced (e.g. 'بلاغ رقم 99214'), parse it out. If MOH sends a document/image (hasAttachment = true) and no complaint is active, select CREATE.
2. INCREMENT: Select if an MOH Officer (inbound) follows up or provides data regarding one of the listed open tickets. You MUST specify the exact targetTicketId matching the history (this could be the ticketId or complaintId).
3. CLOSE: Select if Clinic Staff pushes an attachment file or explicitly indicates resolution. Specify the targetTicketId to lock down. If MOH (inbound) explicitly thanks the clinic and confirms closure, select CLOSE.
4. IGNORE: Select if the message contains non-actionable elements like greetings ('شكرا', 'السلام عليكم', 'مرحبا') or trivial validation checks without any active complaint, or if the message is general talk and shouldn't alter any ticket.

Return ONLY a raw JSON structure matching this signature:
{
  "action": "CREATE" | "INCREMENT" | "CLOSE" | "IGNORE",
  "targetTicketId": "The ticketId or complaintId to alter (String or null)",
  "extractedTicketId": "If a brand new ID is declared in the text, extract it natively as 'MOH-XXXX' (String or null)",
  "summary": "Concise 1-sentence Arabic description of the complaint (required for CREATE or INCREMENT)",
  "category": "Arabic classification (e.g., 'أوقات الانتظار', 'سلوك الموظفين', 'الفواتير والأسعار', 'جودة العلاج', 'أخرى')",
  "draftReply": "A polite, professional response draft in Arabic addressing the MOH agent (optional)",
  "reasoning": "Clear logical justification for the routing determination"
}
`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json'
      }
    });

    const responseText = response.text;
    const decision = JSON.parse(responseText);

    const logMsg = `🤖 [Gemini Decision]: Action=${decision.action}, Match=${decision.targetTicketId}, Reason=${decision.reasoning}`;
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

  if (isOutbound) {
    if (hasAttachment && activeComplaint) {
      return {
        action: 'CLOSE',
        targetTicketId: activeTicketId,
        summary: activeComplaint.summary,
        category: activeComplaint.category,
        draftReply: '',
        reasoning: 'Fallback: Outbound attachment detected, closing active complaint.'
      };
    }
    return { action: 'IGNORE', reasoning: 'Fallback: Outbound general text.' };
  } else {
    // Inbound
    if (activeComplaint) {
      return {
        action: 'INCREMENT',
        targetTicketId: activeTicketId,
        summary: activeComplaint.summary,
        category: activeComplaint.category,
        draftReply: 'تم استلام رسالتكم وجاري متابعتها مع القسم المختص.',
        reasoning: 'Fallback: Active complaint exists, routing follow-up.'
      };
    }

    if (hasAttachment) {
      return {
        action: 'CREATE',
        summary: 'شكوى جديدة تحتوي على مرفقات',
        category: 'أخرى',
        draftReply: 'أهلاً بك، تم استلام المرفق وجاري فتح بطاقة شكوى للمتابعة.',
        reasoning: 'Fallback: New inbound attachment, opening complaint.'
      };
    }

    return {
      action: 'IGNORE',
      reasoning: 'Fallback: General inbound text with no active complaint.'
    };
  }
}

module.exports = { processMessageEvent };
