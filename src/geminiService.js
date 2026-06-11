/**
 * geminiService.js
 * Interfaces with Google Gemini API to analyze message intents,
 * route follow-up messages, categorize complaints, and draft responses.
 */

'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize GenAI
const apiKey = process.env.GEMINI_API_KEY || '';
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

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
  if (!genAI) {
    // Fallback if no API key is configured
    console.warn('⚠️ GEMINI_API_KEY not configured. Using fallback rule engine.');
    return getFallbackDecision({ phone, messageText, hasAttachment, isOutbound, existingComplaints });
  }

  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      generationConfig: { responseMimeType: 'application/json' }
    });

    const activeComplaint = existingComplaints.find(c => c.status === 'OPEN');

    const prompt = `
You are the AI supervisor for a medical clinic's WhatsApp bot that tracks Ministry of Health (MOH) regulatory complaints.
Your job is to analyze a new message event (inbound from MOH, or outbound from Clinic) and decide the system action, mapping it to the correct complaint.

### System Rules:
1. **Opening Complaints**:
   - A complaint should be opened if the MOH contact (inbound) sends a message describing a problem, case, or filing a new complaint.
   - Text-only greetings ("مرحبا", "السلام عليكم") or queries without a specific complaint should NOT open a complaint.
   - If MOH sends a document/image (hasAttachment = true) and no complaint is active, it typically opens a new complaint.
2. **Routing / Counting**:
   - If there is an active OPEN complaint, subsequent follow-up text messages or documents from MOH should be routed to it (ROUTE_TO_COMPLAINT) so the message counter increments.
   - If the MOH contact mentions a totally different complaint topic while one is open, you can either route to the active one or open a new one if it is clearly distinct.
3. **Closing Complaints**:
   - Outbound attachments (isOutbound = true, hasAttachment = true) sent from the clinic to the MOH contact almost always represent official resolution documents (reports, invoices, statement letters). These should trigger CLOSE_COMPLAINT.
   - Clinic outbound text explicitly confirming closure/resolution (e.g. "تم حل الشكوى", "تم إغلاق البلاغ") should also trigger CLOSE_COMPLAINT.
   - If MOH (inbound) sends a text confirming the issue is resolved or thanking the clinic for resolving it, you may close it.

### Current Context:
- **MOH Contact Phone**: ${phone}
- **New Message**: "${messageText || '[Media/Attachment File]'}"
- **Has Attachment**: ${hasAttachment}
- **Is Outbound (From Clinic)**: ${isOutbound}
- **Active OPEN Complaint**: ${activeComplaint ? JSON.stringify({ complaintId: activeComplaint.complaintId, summary: activeComplaint.summary, messageCount: activeComplaint.messageCount }) : 'None'}
- **Existing Complaints History**: ${JSON.stringify(existingComplaints.map(c => ({ complaintId: c.complaintId, status: c.status, summary: c.summary })))}

### Output JSON Format:
You MUST return a JSON object with the following fields:
{
  "action": "OPEN_COMPLAINT" | "ROUTE_TO_COMPLAINT" | "CLOSE_COMPLAINT" | "NO_ACTION",
  "matchedComplaintId": "The ID of the complaint to route or close (if action is ROUTE_TO_COMPLAINT or CLOSE_COMPLAINT)",
  "summary": "A concise 1-sentence summary of the complaint in Arabic (if opening or updating)",
  "category": "A category name in Arabic (e.g., 'أوقات الانتظار', 'سلوك الموظفين', 'الفواتير والأسعار', 'جودة العلاج', 'أخرى')",
  "draftReply": "A polite, professional response draft in Arabic addressing the MOH agent (if action is OPEN_COMPLAINT or ROUTE_TO_COMPLAINT)",
  "reasoning": "Technical explanation for this action decision"
}
`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    const decision = JSON.parse(responseText);

    console.log(`🤖 [Gemini Decision]: Action=${decision.action}, Match=${decision.matchedComplaintId}, Reason=${decision.reasoning}`);
    return decision;
  } catch (err) {
    console.error('❌ [Gemini Error]:', err.message);
    return getFallbackDecision({ phone, messageText, hasAttachment, isOutbound, existingComplaints });
  }
}

/**
 * Fallback rules engine if Gemini is not available or errors out.
 */
function getFallbackDecision({ phone, messageText, hasAttachment, isOutbound, existingComplaints }) {
  const activeComplaint = existingComplaints.find(c => c.status === 'OPEN');

  if (isOutbound) {
    if (hasAttachment && activeComplaint) {
      return {
        action: 'CLOSE_COMPLAINT',
        matchedComplaintId: activeComplaint.complaintId,
        summary: activeComplaint.summary,
        category: activeComplaint.category,
        draftReply: '',
        reasoning: 'Fallback: Outbound attachment detected, closing active complaint.'
      };
    }
    return { action: 'NO_ACTION', reasoning: 'Fallback: Outbound general text.' };
  } else {
    // Inbound
    if (activeComplaint) {
      return {
        action: 'ROUTE_TO_COMPLAINT',
        matchedComplaintId: activeComplaint.complaintId,
        summary: activeComplaint.summary,
        category: activeComplaint.category,
        draftReply: 'تم استلام رسالتكم وجاري متابعتها مع القسم المختص.',
        reasoning: 'Fallback: Active complaint exists, routing follow-up.'
      };
    }

    if (hasAttachment) {
      return {
        action: 'OPEN_COMPLAINT',
        summary: 'شكوى جديدة تحتوي على مرفقات',
        category: 'أخرى',
        draftReply: 'أهلاً بك، تم استلام المرفق وجاري فتح بطاقة شكوى للمتابعة.',
        reasoning: 'Fallback: New inbound attachment, opening complaint.'
      };
    }

    return {
      action: 'NO_ACTION',
      reasoning: 'Fallback: General inbound text with no active complaint.'
    };
  }
}

module.exports = { processMessageEvent };
