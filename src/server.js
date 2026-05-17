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
const session = require('./session');
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
    const qrImage = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
    return res.send(`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8">
  <title>Scan QR — WhatsApp Bot</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: sans-serif; background: #0d1117; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 40px 20px; }
    h1 { font-size: 1.8rem; margin-bottom: 8px; }
    .sub { color: #8b949e; font-size: 0.95rem; margin-bottom: 28px; text-align: center; }
    .qr-wrap { position: relative; }
    #qr-img { border: 10px solid #fff; border-radius: 16px; display: block; width: 300px; height: 300px; transition: opacity 0.3s; }
    #qr-img.fading { opacity: 0.3; }
    .badge { margin-top: 18px; font-size: 0.82rem; color: #6e7681; display: flex; align-items: center; gap: 6px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #34d399; animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
    .status { margin-top: 14px; font-size: 0.85rem; color: #f59e0b; min-height: 20px; }
  </style>
</head>
<body>
  <h1>📱 Scan QR to Connect WhatsApp</h1>
  <p class="sub">Open WhatsApp → Settings → Linked Devices → Link a Device</p>
  <div class="qr-wrap">
    <img id="qr-img" src="${qrImage}" alt="QR Code" />
  </div>
  <div class="badge"><div class="dot"></div> Synced — QR updates automatically when it changes</div>
  <div class="status" id="status"></div>

  <script>
    let lastQRString = '';
    const img = document.getElementById('qr-img');
    const statusEl = document.getElementById('status');
    let consecutiveErrors = 0;

    async function poll() {
      try {
        const res = await fetch('/qr');
        const data = await res.json();

        if (!data.hasQR) {
          // Bot connected — reload to show success page
          statusEl.textContent = '✅ Connected! Redirecting...';
          setTimeout(() => window.location.reload(), 800);
          return;
        }

        if (data.qr && data.qr !== lastQRString) {
          lastQRString = data.qr;
          img.classList.add('fading');
          await new Promise(r => setTimeout(r, 150));
          img.src = '/qr-image?qr=' + encodeURIComponent(data.qr) + '&t=' + Date.now();
          img.onload = () => img.classList.remove('fading');
          statusEl.textContent = 'QR updated at ' + new Date().toLocaleTimeString();
        }
        consecutiveErrors = 0;
      } catch (e) {
        consecutiveErrors++;
        if (consecutiveErrors > 5) statusEl.textContent = 'Connection issue — retrying...';
      }
    }

    setInterval(poll, 2000);
  </script>
</body></html>`);
  }

  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"
    http-equiv="refresh" content="4"><title>Connecting...</title>
    <style>body{font-family:sans-serif;background:#0d1117;color:#fff;text-align:center;padding:60px}</style>
    </head><body><h1>⏳ Connecting to WhatsApp...</h1><p>Please wait a few seconds...</p></body></html>`);
});


/** QR code JSON (for polling) */
app.get('/qr', (_req, res) => {
  const { hasQR, qr } = wa.getStatus();
  if (!hasQR) return res.json({ hasQR: false, message: 'No QR available.' });
  res.json({ hasQR: true, qr });
});

/** QR image (renders raw QR string → PNG, used by the live-polling page) */
app.get('/qr-image', async (req, res) => {
  const { qr: qrStr } = req.query;
  if (!qrStr) return res.status(400).send('Missing qr param');
  try {
    const buf = await QRCode.toBuffer(qrStr, { width: 300, margin: 2 });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) {
    res.status(500).send('QR render failed');
  }
});

/** Export Session (Base64) */
app.get('/session/export', (_req, res) => {
  const b64 = session.encodeSession();
  if (!b64) return res.status(404).json({ error: 'No active session found.' });
  res.json({
    message: "Copy the base64 string below and set it as WA_SESSION_B64 in your Railway environment variables.",
    base64Length: b64.length,
    base64: b64
  });
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
  const { phone, caption, customText, branchTexts: branchTextsRaw, locationInfo: locationInfoRaw } = req.body;
  const file         = req.file;
  const branchTexts  = (() => { try { return JSON.parse(branchTextsRaw  || '[]'); } catch { return []; } })();
  const locationInfo = (() => { try { return JSON.parse(locationInfoRaw || '[]'); } catch { return []; } })();
  const hasBranches    = Array.isArray(branchTexts)  && branchTexts.length  > 0;
  const hasLocations   = Array.isArray(locationInfo) && locationInfo.length > 0;
  const hasCaption     = typeof caption    === 'string' && caption.trim().length    > 0;
  const hasCustomText  = typeof customText === 'string' && customText.trim().length > 0;

  if (!phone || typeof phone !== 'string') {
    return res.status(400).json({ error: 'phone is required.' });
  }
  const cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.length < 10 || cleanPhone.length > 15) {
    return res.status(400).json({ error: `Invalid phone: "${cleanPhone}".` });
  }
  if (!file && !hasCaption && !hasCustomText && !hasBranches && !hasLocations) {
    return res.status(400).json({ error: 'يجب توفير ملف أو رسالة أو موقع فرع على الأقل.' });
  }
  if (!wa.getStatus().connected) {
    return res.status(503).json({ error: 'WhatsApp not connected. Check the terminal.' });
  }

  // ── Check if the number is registered on WhatsApp ─────────────────────────
  try {
    const onWA = await wa.isRegisteredNumber(cleanPhone);
    if (!onWA) {
      return res.status(400).json({ error: 'الرقم المدخل غير مسجل في واتساب. يرجى التأكد من صحة الرقم.' });
    }
  } catch (checkErr) {
    console.warn('WhatsApp number check failed, proceeding anyway:', checkErr.message);
  }

  // Fix Arabic/non-ASCII filenames (only when a file is present)
  const fileName = file
    ? Buffer.from(file.originalname, 'latin1').toString('utf8')
    : null;

  try {
    if (file) {
      await wa.sendMessage(cleanPhone, {
        document: file.buffer,
        mimetype: file.mimetype,
        fileName: fileName,
        caption: caption || ''
      });
    } else if (hasCaption) {
      await wa.sendMessage(cleanPhone, { text: caption.trim() });
    }

    // Custom text message after file
    if (hasCustomText) {
      await delay(800);
      await wa.sendMessage(cleanPhone, { text: customText.trim() });
    }

    // Native location pins (preferred)
    if (hasLocations) {
      for (const loc of locationInfo) {
        await delay(800);
        await wa.sendMessage(cleanPhone, { location: loc });
      }
    } else if (hasBranches) {
      // Fallback: text links
      for (const bt of branchTexts) {
        await wa.sendMessage(cleanPhone, { text: bt });
        await delay(800);
      }
    }

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
  const { phone, offers, isAllOffers, customText, branchTexts, locationInfo } = req.body;
  const offerList    = Array.isArray(offers)       ? offers       : [];
  const hasBranches  = Array.isArray(branchTexts)  && branchTexts.length  > 0;
  const hasLocations = Array.isArray(locationInfo) && locationInfo.length > 0;
  const hasCustomText = typeof customText === 'string' && customText.trim().length > 0;

  // ── Validate ──────────────────────────────────────────────────────────────
  if (!phone || typeof phone !== 'string') {
    return res.status(400).json({ error: 'phone is required.' });
  }
  const cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.length < 10 || cleanPhone.length > 15) {
    return res.status(400).json({ error: `Invalid phone: "${cleanPhone}".` });
  }
  if (offerList.length === 0 && !hasBranches && !hasCustomText) {
    return res.status(400).json({ error: 'يجب إرسال عرض أو رسالة أو موقع على الأقل.' });
  }
  if (!wa.getStatus().connected) {
    return res.status(503).json({ error: 'WhatsApp not connected. Check the terminal.' });
  }

  // ── Check if the number is registered on WhatsApp ─────────────────────────
  try {
    const onWA = await wa.isRegisteredNumber(cleanPhone);
    if (!onWA) {
      return res.status(400).json({ error: 'الرقم المدخل غير مسجل في واتساب. يرجى التأكد من صحة الرقم.' });
    }
  } catch (checkErr) {
    console.warn('WhatsApp number check failed, proceeding anyway:', checkErr.message);
  }

  // ── Send messages ──────────────────────────────────────────────────────────
  const results = [];

  try {
    // 1. Greeting
    if (offerList.length > 0 && !isAllOffers) {
      await wa.sendMessage(cleanPhone, { text: buildGreeting() });
      await delay(1500);
    }

    // 2. Each offer
    for (const offer of offerList) {
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

    // 3. CTA (only if offers were sent)
    if (offerList.length > 0) {
      if (isAllOffers) {
        await wa.sendMessage(cleanPhone, { text: buildAllOffersCTA() });
      } else {
        await wa.sendMessage(cleanPhone, { text: buildCTA() });
      }
      await delay(1000);
    }

    // 4. Custom text
    if (hasCustomText) {
      await wa.sendMessage(cleanPhone, { text: customText.trim() });
      await delay(800);
    }

    // 5. Branch locations — native pins preferred, text links as fallback
    if (hasLocations) {
      for (const loc of locationInfo) {
        await wa.sendMessage(cleanPhone, { location: loc });
        await delay(800);
      }
    } else if (hasBranches) {
      for (const bt of branchTexts) {
        await wa.sendMessage(cleanPhone, { text: bt });
        await delay(800);
      }
    }
  } catch (err) {
    console.error('Fatal send error:', err);
    return res.status(500).json({ error: err.message, results });
  }

  // ── Auto-label as lead ─────────────────────────────────────────────────────
  const anySucceeded = results.length === 0 || results.some(r => r.status === 'sent');
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

  const allFailed = results.length > 0 && results.every(r => r.status === 'failed');
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
