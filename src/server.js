/**
 * server.js — v2
 * New:
 *  - GET /labels      → list all WhatsApp labels
 *  - POST /send-offers → now also labels the chat after sending
 */

'use strict';

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const QRCode  = require('qrcode');
const multer  = require('multer');
const wa      = require('./whatsapp');
const { buildGreeting, buildImageCaption, buildServicesText, buildCTA, buildAllOffersCTA } = require('./messageBuilder');

// ─── Express setup ────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '20mb' }));

// ─── Multer setup for file uploads ────────────────────────────────────────────
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 20 * 1024 * 1024 } // 20 MB limit
});

// ─── Static file server (serves offer images from the React app's public dir) ──
const STATIC_DIR = process.env.STATIC_FILES_DIR
  ? path.resolve(process.env.STATIC_FILES_DIR)
  : null;
if (STATIC_DIR && fs.existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR));
  console.log(`📁 Serving static images from: ${STATIC_DIR}`);
} else if (STATIC_DIR) {
  console.warn(`⚠️  STATIC_FILES_DIR not found: ${STATIC_DIR}`);
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
  .split(',').map(o => o.trim());

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-API-Key', 'bypass-tunnel-reminder'],
}));

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized — invalid or missing X-API-Key.' });
  }
  next();
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/** Status + QR page — visit this URL in the browser to scan QR on Render */
app.get('/', async (_req, res) => {
  const { connected, hasQR, qr } = wa.getStatus();

  if (connected) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Bot Online</title>
      <style>body{font-family:sans-serif;background:#0d1117;color:#fff;text-align:center;padding:60px}
      h1{font-size:2.5rem}p{color:#8b949e;font-size:1.1rem}</style></head>
      <body><h1>✅ WhatsApp Bot Online</h1><p>The bot is connected and running normally.</p>
      <p style="color:#34d399">Connected to WhatsApp ✓</p></body></html>`);
  }

  if (hasQR && qr) {
    const qrImage = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"
      http-equiv="refresh" content="8"><title>Scan QR</title>
      <style>body{font-family:sans-serif;background:#0d1117;color:#fff;text-align:center;padding:40px}
      h1{font-size:2rem}p{color:#8b949e}img{border:10px solid #fff;border-radius:16px;margin:20px 0}
      .hint{font-size:0.85rem;color:#6e7681}</style></head>
      <body><h1>📱 Scan QR to Connect WhatsApp</h1>
      <p>Open WhatsApp → Settings → Linked Devices → Link a Device</p>
      <img src="${qrImage}" />
      <p class="hint">Page refreshes automatically every 8 seconds</p></body></html>`);
  }

  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"
    http-equiv="refresh" content="4"><title>Connecting...</title>
    <style>body{font-family:sans-serif;background:#0d1117;color:#fff;text-align:center;padding:60px}</style>
    </head><body><h1>⏳ Connecting to WhatsApp...</h1><p>Please wait a few seconds...</p></body></html>`);
});


/** QR code (for first-time login UI) */
app.get('/qr', (_req, res) => {
  const { hasQR, qr } = wa.getStatus();
  if (!hasQR) return res.json({ hasQR: false, message: 'No QR available.' });
  res.json({ hasQR: true, qr });
});

/**
 * GET /labels
 * Returns all WhatsApp labels loaded from the clinic phone.
 * Useful for finding exact label names used in the config.
 */
app.get('/labels', requireApiKey, (_req, res) => {
  const labels = wa.getLabels();
  const list   = Object.entries(labels).map(([id, l]) => ({
    id,
    name:  l.name,
    color: l.color,
  }));
  res.json({ count: list.length, labels: list });
});

/**
 * POST /send-file
 * Body (multipart/form-data): phone, caption, file
 *
 * Sends a single arbitrary file (image, document, pdf) to the specified phone.
 */
app.post('/send-file', requireApiKey, upload.single('file'), async (req, res) => {
  console.log('--- [Railway Debug] Received /send-file request! ---');
  const { phone, caption } = req.body;
  const file = req.file;

  if (!phone || typeof phone !== 'string') {
    return res.status(400).json({ error: 'phone is required.' });
  }
  const cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.length < 10 || cleanPhone.length > 15) {
    return res.status(400).json({ error: `Invalid phone: "${cleanPhone}".` });
  }
  if (!file) {
    return res.status(400).json({ error: 'file is required.' });
  }
  if (!wa.getStatus().connected) {
    return res.status(503).json({ error: 'WhatsApp not connected. Check the terminal.' });
  }

  // Fix Arabic/non-ASCII filenames: browsers send UTF-8 but HTTP headers are parsed
  // as latin1 by Node's http module, so we re-encode back to the correct string.
  const fileName = Buffer.from(file.originalname, 'latin1').toString('utf8');

  try {
    await wa.sendMessage(cleanPhone, {
      document: file.buffer,
      mimetype: file.mimetype,
      fileName: fileName,
      caption: caption || ''
    });

    // Optionally apply leads label
    const leadsLabel = process.env.LEADS_LABEL_NAME || 'ليدز باتريكس 1';
    let labelStatus = null;
    try {
      await wa.addLabelToChat(cleanPhone, leadsLabel);
      labelStatus = { success: true, label: leadsLabel };
    } catch (err) {
      console.warn(`Could not apply label "${leadsLabel}": ${err.message}`);
      labelStatus = { success: false, label: leadsLabel, error: err.message };
    }

    return res.json({
      success: true,
      message: 'File sent successfully',
      fileName: fileName,
      labelStatus
    });
  } catch (err) {
    console.error('Fatal send-file error:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /send-offers
 * Body: { phone: "966501234567", offers: [...] }
 *
 * After a successful send, the customer's chat is automatically
 * labelled with the LEADS_LABEL_NAME defined in .env
 */
app.post('/send-offers', requireApiKey, async (req, res) => {
  const { phone, offers, isAllOffers } = req.body;

  // ── Validate ──────────────────────────────────────────────────────────────
  if (!phone || typeof phone !== 'string') {
    return res.status(400).json({ error: 'phone is required.' });
  }
  const cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.length < 10 || cleanPhone.length > 15) {
    return res.status(400).json({ error: `Invalid phone: "${cleanPhone}".` });
  }
  if (!Array.isArray(offers) || offers.length === 0) {
    return res.status(400).json({ error: 'offers must be a non-empty array.' });
  }
  if (!wa.getStatus().connected) {
    return res.status(503).json({ error: 'WhatsApp not connected. Check the terminal.' });
  }

  // ── Send messages ──────────────────────────────────────────────────────────
  const results = [];

  try {
    // 1. Greeting
    if (!isAllOffers) {
      await wa.sendMessage(cleanPhone, { text: buildGreeting() });
      await delay(1500);
    }

    // 2. Each offer
    for (const offer of offers) {
      try {
        if (offer.image_url) {
          await wa.sendMessage(cleanPhone, {
            image:   offer.image_url,
            caption: isAllOffers ? '' : buildImageCaption(offer),
          });
          await delay(1000);
        } else if (isAllOffers) {
          await wa.sendMessage(cleanPhone, { text: `✨ *${offer.title}*` });
          await delay(1000);
        }

        if (!isAllOffers) {
          await wa.sendMessage(cleanPhone, { text: buildServicesText(offer) });
          await delay(1200);
        }
        results.push({ offerId: offer.id, title: offer.title, status: 'sent' });
      } catch (err) {
        console.error(`Failed to send offer "${offer.title}":`, err.message);
        results.push({ offerId: offer.id, title: offer.title, status: 'failed', error: err.message });
      }
    }

    // 3. CTA
    if (isAllOffers) {
      await wa.sendMessage(cleanPhone, { text: buildAllOffersCTA() });
    } else {
      await wa.sendMessage(cleanPhone, { text: buildCTA() });
    }
  } catch (err) {
    console.error('Fatal send error:', err);
    return res.status(500).json({ error: err.message, results });
  }

  // ── Auto-label as lead ─────────────────────────────────────────────────────
  const anySucceeded = results.some(r => r.status === 'sent');
  let labelStatus = null;

  if (anySucceeded) {
    const leadsLabel = process.env.LEADS_LABEL_NAME || 'ليدز باتريكس 1';
    try {
      await wa.addLabelToChat(cleanPhone, leadsLabel);
      labelStatus = { success: true, label: leadsLabel };
    } catch (err) {
      console.warn(`Could not apply label "${leadsLabel}": ${err.message}`);
      labelStatus = { success: false, label: leadsLabel, error: err.message };
    }
  }

  const allFailed = results.every(r => r.status === 'failed');
  res.status(allFailed ? 500 : 200).json({
    success:     !allFailed,
    results,
    labelStatus,
  });
});

/**
 * GET /session/export
 * ONE-TIME USE after QR scan: exports the WhatsApp session as base64.
 * Copy the returned WA_SESSION_B64 value into Back4App env vars, then redeploy.
 */
app.get('/session/export', requireApiKey, (_req, res) => {
  const { encodeSession } = require('./session');
  const b64 = encodeSession();
  if (!b64) {
    return res.status(404).json({
      error: 'No session found. Make sure the bot is connected (scan QR first).',
    });
  }
  res.json({
    message: 'Copy WA_SESSION_B64 into your Back4App environment variables, then redeploy.',
    WA_SESSION_B64: b64,
  });
});

app.use((_req, res) => res.status(404).json({ error: 'Route not found.' }));


// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

app.listen(PORT, async () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   🏥 Clinic WhatsApp Offer Bot  v2       ║');
  console.log(`║   http://localhost:${PORT}                 ║`);
  console.log('║                                          ║');
  console.log('║   Features:                              ║');
  console.log('║   • Send offers & auto-label as lead     ║');
  console.log('║   • Auto-forward وزارة الصحة messages    ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  await wa.connect();
});

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
