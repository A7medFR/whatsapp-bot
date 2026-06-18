/**
 * server.js — v2
 * New:
 *  - GET /labels      → list all WhatsApp labels
 *  - POST /send-offers → now also labels the chat after sending
 */

'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const multer = require('multer');
const wa = require('./whatsapp');
const session = require('./session');
const db = require('./db');
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

// ─── SSE Broadcast Setup ──────────────────────────────────────────────────────
if (!global.logListeners) global.logListeners = [];
global.broadcastLog = (log) => {
  global.logListeners.forEach(listener => {
    try {
      listener(log);
    } catch (_) { }
  });
};

// ─── Routes ──────────────────────────────────────────────────────────────────

/** Premium Diagnostics Dashboard & Live Console UI */
app.get('/', async (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Patrix Medical — WhatsApp Console</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;700&family=Lexend:wght@300;400;600;800&family=Source+Sans+3:wght@300;400;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-dark: #070a13;
      --panel-bg: rgba(13, 20, 38, 0.45);
      --accent-cyan: #0891b2;
      --accent-cyan-glow: rgba(8, 145, 178, 0.15);
      --accent-emerald: #10b981;
      --accent-emerald-glow: rgba(16, 185, 129, 0.15);
      --accent-amber: #f59e0b;
      --accent-amber-glow: rgba(245, 158, 11, 0.15);
      --accent-rose: #f43f5e;
      --accent-rose-glow: rgba(244, 63, 94, 0.15);
      --text-main: #f1f5f9;
      --text-muted: #8e9bb3;
      --border-color: rgba(255, 255, 255, 0.05);
      --terminal-bg: #03050a;
      --font-headings: 'Lexend', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --font-body: 'Source Sans 3', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      font-family: var(--font-body);
      background-color: var(--bg-dark);
      background-image: 
        radial-gradient(at 0% 0%, rgba(8, 145, 178, 0.12) 0px, transparent 50%),
        radial-gradient(at 100% 100%, rgba(16, 185, 129, 0.06) 0px, transparent 50%);
      background-attachment: fixed;
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
    }

    .app-layout {
      display: flex;
      width: 100%;
      min-height: 100vh;
    }

    .sidebar {
      width: 280px;
      background: rgba(8, 11, 22, 0.85);
      backdrop-filter: blur(20px);
      border-right: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      padding: 30px 20px;
      flex-shrink: 0;
    }

    .sidebar-brand {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 40px;
      padding: 0 10px;
    }

    .logo-icon {
      color: var(--accent-cyan);
      display: flex;
      align-items: center;
      animation: pulse-icon 3s infinite ease-in-out;
    }

    @keyframes pulse-icon {
      0%, 100% { transform: scale(1) rotate(0deg); }
      50% { transform: scale(1.05) rotate(3deg); }
    }

    .brand-text h1 {
      font-family: var(--font-headings);
      font-size: 1.35rem;
      font-weight: 800;
      letter-spacing: -0.5px;
      background: linear-gradient(135deg, #06b6d4, #10b981);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .brand-text p {
      font-size: 0.75rem;
      color: var(--text-muted);
      letter-spacing: 1.5px;
      text-transform: uppercase;
      font-weight: 600;
    }

    .sidebar-nav {
      display: flex;
      flex-direction: column;
      flex: 1;
    }

    .nav-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      border-radius: 12px;
      color: var(--text-muted);
      text-decoration: none;
      font-family: var(--font-headings);
      font-weight: 500;
      font-size: 0.92rem;
      transition: all 0.2s ease-in-out;
      margin-bottom: 8px;
      border: 1px solid transparent;
      cursor: pointer;
    }

    .nav-item:hover {
      color: var(--text-main);
      background: rgba(255, 255, 255, 0.02);
      border-color: rgba(255, 255, 255, 0.03);
    }

    .nav-item.active {
      color: #22d3ee;
      background: rgba(8, 145, 178, 0.08);
      border-color: rgba(8, 145, 178, 0.2);
    }

    .sidebar-footer {
      padding-top: 20px;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
    }

    .main-content {
      flex: 1;
      padding: 40px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 30px;
    }

    .main-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border-color);
      padding-bottom: 20px;
    }

    .main-header h2 {
      font-family: var(--font-headings);
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--text-main);
    }

    .date-display {
      font-size: 0.85rem;
      color: var(--text-muted);
      font-weight: 500;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      border-radius: 9999px;
      font-size: 0.85rem;
      font-weight: 600;
      backdrop-filter: blur(12px);
      border: 1px solid currentColor;
      transition: all 0.3s ease;
      width: 100%;
      justify-content: center;
    }

    .badge-connected {
      color: #34d399;
      background: rgba(52, 211, 153, 0.04);
      box-shadow: 0 0 15px rgba(52, 211, 153, 0.1);
    }

    .badge-disconnected {
      color: #f59e0b;
      background: rgba(245, 158, 11, 0.04);
      box-shadow: 0 0 15px rgba(245, 158, 11, 0.1);
    }

    .badge-connecting {
      color: #3b82f6;
      background: rgba(59, 130, 246, 0.04);
      box-shadow: 0 0 15px rgba(59, 130, 246, 0.1);
    }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background-color: currentColor;
      animation: pulse-dot 1.5s infinite;
    }

    @keyframes pulse-dot {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }

    .main-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 25px;
    }

    @media (min-width: 1200px) {
      .main-grid-split {
        grid-template-columns: 380px 1fr;
      }
    }

    .card {
      background: var(--panel-bg);
      backdrop-filter: blur(24px);
      border: 1px solid var(--border-color);
      border-radius: 20px;
      padding: 30px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
      display: flex;
      flex-direction: column;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    
    .card:hover {
      border-color: rgba(255, 255, 255, 0.1);
      box-shadow: 0 12px 36px rgba(0, 0, 0, 0.3);
    }

    .card-title {
      font-family: var(--font-headings);
      font-size: 1.1rem;
      font-weight: 600;
      margin-bottom: 25px;
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--text-main);
    }

    /* QR Code styles */
    .qr-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
    }

    #qr-img {
      border: 8px solid #ffffff;
      border-radius: 16px;
      width: 220px;
      height: 220px;
      display: block;
      box-shadow: 0 10px 25px rgba(0,0,0,0.3);
      transition: opacity 0.3s;
    }

    #qr-img.fading {
      opacity: 0.2;
    }

    .instructions {
      font-size: 0.85rem;
      color: var(--text-muted);
      line-height: 1.5;
      margin-top: 20px;
      text-align: center;
    }

    .instructions ol {
      text-align: left;
      margin-left: 20px;
      margin-top: 8px;
    }

    .instructions li {
      margin-bottom: 4px;
    }

    /* Console terminal */
    .console-card {
      display: flex;
      flex-direction: column;
      flex: 1;
      height: 100%;
      min-height: 480px;
    }

    .console-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
    }

    .console-actions {
      display: flex;
      gap: 10px;
    }

    .btn {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border-color);
      color: var(--text-main);
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 0.82rem;
      font-weight: 500;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s ease-in-out;
    }

    .btn:hover {
      background: rgba(255, 255, 255, 0.07);
      border-color: rgba(255,255,255,0.12);
    }

    .btn-export {
      background: rgba(8, 145, 178, 0.12);
      border-color: rgba(8, 145, 178, 0.25);
      color: #22d3ee;
      font-weight: 600;
    }

    .btn-export:hover {
      background: rgba(8, 145, 178, 0.22);
      border-color: rgba(8, 145, 178, 0.4);
    }

    .terminal {
      background-color: var(--terminal-bg);
      border: 1px solid rgba(255, 255, 255, 0.03);
      border-radius: 12px;
      font-family: 'Fira Code', 'JetBrains Mono', monospace;
      font-size: 0.85rem;
      padding: 18px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
      box-shadow: inset 0 2px 10px rgba(0, 0, 0, 0.4);
      flex: 1;
      max-height: 520px;
    }

    .log-line {
      display: flex;
      gap: 8px;
      line-height: 1.4;
      animation: log-fade-in 0.2s ease-out;
      word-break: break-all;
    }

    @keyframes log-fade-in {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .log-time {
      color: #525f7a;
      font-weight: 500;
      flex-shrink: 0;
      user-select: none;
    }

    .log-content {
      color: #cbd5e1;
    }

    .log-info { color: #f1f5f9; }
    .log-warn { color: #fbbf24; }
    .log-error { color: #f87171; }

    .system-log {
      color: #38bdf8;
      font-style: italic;
    }

    .terminal::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    
    .terminal::-webkit-scrollbar-track {
      background: rgba(0, 0, 0, 0.1);
      border-radius: 4px;
    }
    
    .terminal::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.08);
      border-radius: 4px;
    }
    
    .terminal::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.15);
    }

    .copy-toast {
      position: fixed;
      bottom: 25px;
      left: 50%;
      transform: translateX(-50%) translateY(100px);
      background: #10b981;
      color: white;
      padding: 12px 28px;
      border-radius: 12px;
      font-size: 0.9rem;
      font-weight: 600;
      box-shadow: 0 10px 25px rgba(16, 185, 129, 0.3);
      transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      z-index: 1000;
    }

    .copy-toast.show {
      transform: translateX(-50%) translateY(0);
    }

    @media (max-width: 1024px) {
      .app-layout {
        flex-direction: column;
      }
      .sidebar {
        width: 100%;
        border-right: none;
        border-bottom: 1px solid var(--border-color);
        padding: 20px;
      }
      .sidebar-brand {
        margin-bottom: 20px;
      }
      .sidebar-nav {
        flex-direction: row;
        gap: 10px;
        margin-bottom: 15px;
      }
      .nav-item {
        margin-bottom: 0;
        font-size: 0.85rem;
        padding: 8px 12px;
      }
      .main-content {
        padding: 20px;
      }
    }
  </style>
</head>
<body>

  <div class="app-layout">
    <!-- Left Sidebar Panel -->
    <aside class="sidebar">
      <div class="sidebar-brand">
        <div class="logo-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
        </div>
        <div class="brand-text">
          <h1>Patrix Medical</h1>
          <p>Core Platform</p>
        </div>
      </div>

      <nav class="sidebar-nav">
        <a href="/" class="nav-item active">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>
          System Console
        </a>
        <a href="/complaints" class="nav-item">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          MOH Complaints
        </a>
        <a href="/kpi" class="nav-item">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
          KPI Dashboard
        </a>
      </nav>

      <div class="sidebar-footer">
        <div id="connection-status" class="badge">
          <div class="dot"></div>
          <span id="status-text">Checking Status...</span>
        </div>
      </div>
    </aside>

    <!-- Main Dashboard Area -->
    <main class="main-content">
      <div class="main-header">
        <h2>WhatsApp Core Console</h2>
        <span class="date-display" id="header-date">Platform Diagnostics</span>
      </div>

      <div id="main-grid-element" class="main-grid">
        <!-- QR Card (Rendered dynamic) -->
        <div id="qr-card" class="card" style="display: none;">
          <h3 class="card-title">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--accent-cyan);"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
            Link Device
          </h3>
          <div class="qr-container">
            <img id="qr-img" src="" alt="Scan QR" />
            <div class="instructions">
              <p>Link this phone to WhatsApp Business:</p>
              <ol>
                <li>Open WhatsApp Business on clinic device</li>
                <li>Tap <b>Menu (⋮)</b> or <b>Settings</b></li>
                <li>Select <b>Linked Devices</b> → <b>Link a Device</b></li>
              </ol>
            </div>
          </div>
        </div>

        <!-- Active Connected Info Card (Rendered dynamic) -->
        <div id="info-card" class="card" style="display: none;">
          <h3 class="card-title">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--accent-cyan);"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            Core Controller
          </h3>
          <div style="display:flex; flex-direction:column; gap: 18px; flex:1; justify-content:center;">
            <div>
              <h4 style="font-size:0.85rem; color:var(--text-muted); margin-bottom:4px; font-weight:600; letter-spacing:0.5px; text-transform:uppercase;">ENVIRONMENT STATUS</h4>
              <p style="font-weight:700; color:#34d399; font-size:1.05rem;">Active & Connected ✓</p>
            </div>
            <div>
              <h4 style="font-size:0.85rem; color:var(--text-muted); margin-bottom:4px; font-weight:600; letter-spacing:0.5px; text-transform:uppercase;">ACTIVE SESSION BACKUP</h4>
              <p style="font-size:0.82rem; color:var(--text-muted); margin-bottom:12px; line-height:1.45;">
                Export your WhatsApp token session directly to keep it persistently authenticated in Railway / Back4App / cloud hosting.
              </p>
              <button class="btn btn-export" onclick="exportSession()" style="width:100%; justify-content:center; padding:10px; margin-bottom:12px;">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Export Session Base64
              </button>
            </div>
            <div>
              <h4 style="font-size:0.85rem; color:var(--text-muted); margin-bottom:4px; font-weight:600; letter-spacing:0.5px; text-transform:uppercase;">MOH NUMBERS EXTRACTION</h4>
              <p style="font-size:0.82rem; color:var(--text-muted); margin-bottom:12px; line-height:1.45;">
                Extract all phone numbers currently labeled as "وزارة الصحة" on your phone to add them to your Railway variables.
              </p>
              <button class="btn btn-export" onclick="exportMOHNumbers()" style="width:100%; justify-content:center; padding:10px; background: rgba(16, 185, 129, 0.15); border-color: rgba(16, 185, 129, 0.3); color: #a7f3d0;">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px;"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
                Extract MOH Numbers
              </button>
            </div>
          </div>
        </div>

        <!-- System Terminal Card -->
        <div class="card console-card">
          <div class="console-header">
            <h3 class="card-title" style="margin-bottom:0;">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--accent-cyan);"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
              Core Diagnostics Stream
            </h3>
            <div class="console-actions">
              <button class="btn" onclick="clearConsole()">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                Clear Screen
              </button>
              <button class="btn" onclick="downloadLogs()">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Download Logs
              </button>
            </div>
          </div>
          <div class="terminal" id="terminal-screen">
            <div class="log-line system-log">
              <span class="log-time">[SYSTEM]</span>
              <span class="log-content">Connecting to diagnostics log stream...</span>
            </div>
          </div>
        </div>
      </div>
    </main>
  </div>

  <div id="toast" class="copy-toast">Copied to clipboard!</div>

  <script>
    const term = document.getElementById('terminal-screen');
    const statusBadge = document.getElementById('connection-status');
    const statusText = document.getElementById('status-text');
    const qrCard = document.getElementById('qr-card');
    const infoCard = document.getElementById('info-card');
    const mainGrid = document.getElementById('main-grid-element');
    const qrImg = document.getElementById('qr-img');
    const toast = document.getElementById('toast');

    let currentStatus = null;
    let eventSource = null;

    // Set active date
    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    document.getElementById('header-date').textContent = new Date().toLocaleDateString('en-US', options);

    function addLogLine(time, message, level = 'info') {
      const line = document.createElement('div');
      line.className = 'log-line';
      
      const timeSpan = document.createElement('span');
      timeSpan.className = 'log-time';
      timeSpan.textContent = '[' + time + ']';
      
      const contentSpan = document.createElement('span');
      contentSpan.className = 'log-content log-' + level;
      contentSpan.textContent = message;
      
      line.appendChild(timeSpan);
      line.appendChild(contentSpan);
      
      term.appendChild(line);
      
      // Auto scroll
      term.scrollTop = term.scrollHeight;
    }

    function addSystemLog(message) {
      addLogLine(new Date().toLocaleTimeString(), message, 'system');
    }

    function clearConsole() {
      term.innerHTML = '';
      addSystemLog('Console cleared by administrator.');
    }

    function downloadLogs() {
      const logs = Array.from(term.querySelectorAll('.log-line')).map(el => el.textContent).join('\\n');
      const blob = new Blob([logs], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'whatsapp_bot_logs_' + Date.now() + '.txt';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    function showToast(text) {
      toast.textContent = text;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 3000);
    }

    async function exportSession() {
      try {
        const res = await fetch('/session/export');
        if (!res.ok) {
          showToast('❌ Export failed or session not loaded.');
          return;
        }
        const data = await res.json();
        const b64 = data.WA_SESSION_B64 || data.base64;
        if (b64) {
          await navigator.clipboard.writeText(b64);
          showToast('✅ Base64 Session token copied to clipboard!');
        } else {
          showToast('❌ Export failed - no token returned.');
        }
      } catch (err) {
        showToast('❌ Connection error during export.');
      }
    }

    async function exportMOHNumbers() {
      try {
        const res = await fetch('/export-moh-numbers');
        if (!res.ok) {
          showToast('❌ Extraction failed.');
          return;
        }
        const data = await res.json();
        const commaSeparated = data.commaSeparated;
        if (commaSeparated) {
          await navigator.clipboard.writeText(commaSeparated);
          showToast('✅ Copied ' + data.count + ' MOH number(s) to clipboard!');
        } else {
          showToast('ℹ️ No MOH labeled numbers found.');
        }
      } catch (err) {
        showToast('❌ Connection error during extraction.');
      }
    }

    // Poll status & handle grid state
    async function checkStatus() {
      try {
        const res = await fetch('/bot-status');
        const status = await res.json();
        updateUI(status.connected, status.hasQR, status.qr);
      } catch (err) {
        // ignore errors
      }
    }

    function updateUI(connected, hasQR, qr) {
      if (connected) {
        statusBadge.className = 'badge badge-connected';
        statusText.textContent = 'WhatsApp Connected';
        qrCard.style.display = 'none';
        infoCard.style.display = 'flex';
        mainGrid.className = 'main-grid main-grid-split';
      } else if (hasQR && qr) {
        statusBadge.className = 'badge badge-disconnected';
        statusText.textContent = 'Link Device Pending';
        infoCard.style.display = 'none';
        qrCard.style.display = 'flex';
        mainGrid.className = 'main-grid main-grid-split';
        
        if (qrImg.getAttribute('data-qr') !== qr) {
          qrImg.setAttribute('data-qr', qr);
          qrImg.src = '/qr-image?qr=' + encodeURIComponent(qr) + '&t=' + Date.now();
          addSystemLog('New WhatsApp pairing QR generated.');
        }
      } else {
        statusBadge.className = 'badge badge-connecting';
        statusText.textContent = 'Connecting WhatsApp Sockets...';
        qrCard.style.display = 'none';
        infoCard.style.display = 'none';
        mainGrid.className = 'main-grid';
      }
    }

    // Set up SSE EventSource stream
    function setupEventStream() {
      if (eventSource) eventSource.close();
      
      eventSource = new EventSource('/bot-logs');
      
      eventSource.onopen = () => {
        addSystemLog('Connected to core diagnostic stream.');
      };
      
      eventSource.onmessage = (event) => {
        try {
          const log = JSON.parse(event.data);
          addLogLine(log.time, log.message, log.level);
        } catch (err) {
          // ignore
        }
      };
      
      eventSource.onerror = () => {
        addLogLine(new Date().toLocaleTimeString(), 'Diagnostic stream connection lost. Retrying...', 'warn');
        eventSource.close();
        setTimeout(setupEventStream, 3000);
      };
    }

    setupEventStream();
    setInterval(checkStatus, 2500);
    checkStatus();
  </script>
</body>
</html>`);
});

app.get('/kpi', (_req, res) => {
  res.sendFile(path.join(__dirname, 'kpi.html'));
});

/** Real-time Connection Status JSON Endpoint */
app.get('/bot-status', (_req, res) => {
  const { connected, hasQR, qr } = wa.getStatus();
  res.json({ connected, hasQR, qr });
});

/** Server-Sent Events (SSE) Diagnostics Logs Stream */
app.get('/bot-logs', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Push historical logs immediately to catch up the terminal UI
  const history = wa.getLogs() || [];
  history.forEach(log => {
    res.write(`data: ${JSON.stringify(log)}\n\n`);
  });

  // Client listener hook
  const onLog = (log) => {
    res.write(`data: ${JSON.stringify(log)}\n\n`);
  };

  global.logListeners.push(onLog);

  req.on('close', () => {
    global.logListeners = global.logListeners.filter(l => l !== onLog);
  });
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

/** Export MOH Labeled Numbers */
app.get('/export-moh-numbers', async (_req, res) => {
  try {
    const list = await wa.getMOHNumbersFromLabels();
    const joined = list.join(',');

    // Save to a file in the workspace
    fs.writeFileSync(path.resolve('./extracted_moh_numbers.txt'), joined, 'utf8');

    res.json({
      success: true,
      count: list.length,
      numbers: list,
      commaSeparated: joined,
      message: "Comma-separated numbers list has been written to extracted_moh_numbers.txt and returned below."
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /labels
 * Returns all WhatsApp labels loaded from the clinic phone.
 * Useful for finding exact label names used in the config.
 */
app.get('/labels', requireApiKey, (_req, res) => {
  const labels = wa.getLabels();
  const list = Object.entries(labels).map(([id, l]) => ({
    id,
    name: l.name,
    color: l.color,
  }));
  res.json({ count: list.length, labels: list });
});

/**
 * GET /complaints
 * Serves the MOH Complaints Tracker HTML interface.
 */
app.get('/complaints', (_req, res) => {
  res.sendFile(path.join(__dirname, 'complaints.html'));
});

/**
 * GET /api/complaints
 * Returns JSON array of all tracked complaints.
 */
app.get('/api/complaints', (_req, res) => {
  const list = wa.getComplaintsStore() || [];
  res.json({ count: list.length, complaints: list });
});

/**
 * GET /api/test/db-status
 * Diagnostics endpoint to inspect database connection type and status.
 */
app.get('/api/test/db-status', (_req, res) => {
  res.json({
    activeDatabase: db.getActiveDbType() || "local_json_fallback",
    initError: db.getInitError()
  });
});

/**
 * POST /api/complaints/:id/close
 * Manually closes a specific complaint by ID.
 */
app.post('/api/complaints/:id/close', (req, res) => {
  const { id } = req.params;
  const success = wa.closeComplaint(id);
  if (success) {
    res.json({ success: true, message: `Complaint ${id} successfully marked as closed.` });
  } else {
    res.status(404).json({ error: `Complaint with ID ${id} not found or already closed.` });
  }
});



/**
 * POST /api/complaints/:id/promote
 * Promotes a temporary complaint ID to an official MOH ticket ID.
 */
app.post('/api/complaints/:id/promote', (req, res) => {
  const { id } = req.params;
  const { officialId } = req.body;
  if (!officialId) {
    return res.status(400).json({ error: 'officialId body parameter is required.' });
  }

  try {
    const updated = wa.promoteTemporaryComplaint(id, officialId);
    if (updated) {
      res.json({ success: true, message: `Complaint successfully promoted.`, complaint: updated });
    } else {
      res.status(404).json({ error: `Complaint with ID ${id} not found.` });
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/complaints
 * Manually adds a new complaint.
 */
app.post('/api/complaints', (req, res) => {
  try {
    const newComplaint = wa.addManualComplaint(req.body);
    res.json({ success: true, message: 'Complaint manually added successfully.', complaint: newComplaint });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * PUT /api/complaints/:id
 * Manually updates/edits an existing complaint.
 */
app.put('/api/complaints/:id', (req, res) => {
  const { id } = req.params;
  try {
    const updated = wa.updateManualComplaint(id, req.body);
    if (updated) {
      res.json({ success: true, message: 'Complaint manually updated successfully.', complaint: updated });
    } else {
      res.status(404).json({ error: `Complaint with ID ${id} not found.` });
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /api/complaints/:id
 * Manually deletes a specific complaint by ID.
 */
app.delete('/api/complaints/:id', (req, res) => {
  const { id } = req.params;
  const success = wa.deleteComplaint(id);
  if (success) {
    res.json({ success: true, message: `Complaint ${id} successfully deleted.` });
  } else {
    res.status(404).json({ error: `Complaint with ID ${id} not found.` });
  }
});

/**
 * POST /api/test/simulate-incoming
 * Simulates an incoming message from an MOH official for local/pipeline testing.
 */
app.post('/api/test/simulate-incoming', async (req, res) => {
  try {
    const { phone, senderName, messageText, fromMe, hasAttachment } = req.body;
    if (!phone) {
      return res.status(400).json({ error: "phone is required for simulation." });
    }

    const cleanPhone = phone.replace(/\D/g, '');
    
    const messageContent = {};
    if (hasAttachment) {
      messageContent.documentMessage = {
        title: 'resolution_proof.pdf',
        caption: messageText || ''
      };
    } else {
      messageContent.conversation = messageText || '';
    }

    const mockMsg = {
      key: {
        remoteJid: `${cleanPhone}@s.whatsapp.net`,
        fromMe: !!fromMe,
        id: `mock_sim_${Date.now()}`
      },
      pushName: senderName || (fromMe ? 'العيادة' : 'وزارة الصحة'),
      message: messageContent
    };

    // Trigger pipeline asynchronously or await it
    await wa.processMOHMessagePipeline(mockMsg, null);

    res.json({
      success: true,
      message: "Simulation processed successfully.",
      simulatedMessage: mockMsg
    });
  } catch (err) {
    console.error("Simulation error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/test/inspect-store
 * Diagnostics endpoint to inspect what is inside the Baileys message store.
 */
app.get('/api/test/inspect-store', (req, res) => {
  try {
    const keys = wa.store && wa.store.messages ? Object.keys(wa.store.messages) : [];
    const stats = keys.map(k => ({
      jid: k,
      messageCount: wa.store.messages[k] ? wa.store.messages[k].length : 0
    }));
    
    // Sort so active chats are on top
    stats.sort((a, b) => b.messageCount - a.messageCount);

    res.json({
      success: true,
      totalChats: keys.length,
      chatsWithMessages: stats.filter(c => c.messageCount > 0).length,
      chats: stats
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/complaints/reconstruct
 * Reconstructs a complaint ticket for a phone number by reading and analyzing the chat history.
 */
app.post('/api/complaints/reconstruct', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ error: 'phone parameter is required.' });
    }

    const cleanPhone = phone.replace(/\D/g, '');
    const reconstructed = await wa.reconstructComplaintFromHistory(cleanPhone);

    res.json({
      success: true,
      message: reconstructed 
        ? "Complaint reconstructed successfully from WhatsApp history." 
        : "No active complaint was found in the conversation history.",
      complaint: reconstructed
    });
  } catch (err) {
    console.error("Reconstruct error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/complaints/scan-all
 * Scans all candidate MOH contacts in the history and reconstructs active complaints.
 */
app.post('/api/complaints/scan-all', async (req, res) => {
  try {
    const result = await wa.scanAllMOHComplaints();
    res.json({
      success: true,
      message: `Successfully completed history scanning. Scanned ${result.scannedCandidateCount} candidate numbers.`,
      result
    });
  } catch (err) {
    console.error("Scan all error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/complaints/ai-deep-scan
 * Triggers Gemini AI to read ALL MOH conversations and autonomously detect
 * open complaints, reminder counts, and status from the raw message history.
 */
app.post('/api/complaints/ai-deep-scan', async (req, res) => {
  try {
    const result = await wa.aiDeepScanMOHConversations();
    res.json({
      success: true,
      message: `AI Deep Scan complete. Analyzed ${result.totalScanned} contacts, found ${result.openComplaints} active complaint(s).`,
      result
    });
  } catch (err) {
    console.error("AI deep scan error:", err);
    res.status(500).json({ error: err.message });
  }
});





/**
 * POST /send-file
 * Body (multipart/form-data): phone, caption, files / file
 *
 * Sends one or multiple arbitrary files (image, document, pdf) sequentially to the specified phone.
 */
app.post('/send-file', requireApiKey, upload.any(), async (req, res) => {
  console.log('--- [Railway Debug] Received /send-file request! ---');
  const { phone, caption, customText, branchTexts: branchTextsRaw, locationInfo: locationInfoRaw } = req.body;
  const files = req.files || [];
  const branchTexts = (() => { try { return JSON.parse(branchTextsRaw || '[]'); } catch { return []; } })();
  const locationInfo = (() => { try { return JSON.parse(locationInfoRaw || '[]'); } catch { return []; } })();
  const hasBranches = Array.isArray(branchTexts) && branchTexts.length > 0;
  const hasLocations = Array.isArray(locationInfo) && locationInfo.length > 0;
  const hasCaption = typeof caption === 'string' && caption.trim().length > 0;
  const hasCustomText = typeof customText === 'string' && customText.trim().length > 0;

  if (!phone || typeof phone !== 'string') {
    return res.status(400).json({ error: 'phone is required.' });
  }
  const cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.length < 10 || cleanPhone.length > 15) {
    return res.status(400).json({ error: `Invalid phone: "${cleanPhone}".` });
  }
  if (files.length === 0 && !hasCaption && !hasCustomText && !hasBranches && !hasLocations) {
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

  try {
    const sentFileNames = [];
    if (files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const fileName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const fileCaption = (i === 0) ? (caption || '') : '';

        wa.logEvent(`📎 Queuing file send [${i + 1}/${files.length}]: ${fileName}...`, 'info');
        await wa.sendMessage(cleanPhone, {
          document: file.buffer,
          mimetype: file.mimetype,
          fileName: fileName,
          caption: fileCaption
        });
        sentFileNames.push(fileName);
      }
    } else if (hasCaption) {
      await wa.sendMessage(cleanPhone, { text: caption.trim() });
    }

    // Custom text message after file
    if (hasCustomText) {
      await wa.sendMessage(cleanPhone, { text: customText.trim() });
    }

    // Native location pins
    if (hasLocations) {
      for (const loc of locationInfo) {
        await wa.sendMessage(cleanPhone, { location: loc });
      }
    } else if (hasBranches) {
      // Fallback: text links
      for (const bt of branchTexts) {
        await wa.sendMessage(cleanPhone, { text: bt });
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
      message: 'File(s) sent successfully',
      fileNames: sentFileNames,
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
  const offerList = Array.isArray(offers) ? offers : [];
  const hasBranches = Array.isArray(branchTexts) && branchTexts.length > 0;
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
    }

    // 2. Each offer
    for (const offer of offerList) {
      try {
        if (offer.image_url) {
          await wa.sendMessage(cleanPhone, {
            image: offer.image_url,
            caption: buildImageCaption(offer),
          });
        } else {
          await wa.sendMessage(cleanPhone, { text: `✨ *${offer.title}*` });
        }
        await wa.sendMessage(cleanPhone, { text: buildServicesText(offer) });
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
    }

    // 4. Custom text
    if (hasCustomText) {
      await wa.sendMessage(cleanPhone, { text: customText.trim() });
    }

    // 5. Branch locations — native pins preferred, text links as fallback
    if (hasLocations) {
      for (const loc of locationInfo) {
        await wa.sendMessage(cleanPhone, { location: loc });
      }
    } else if (hasBranches) {
      for (const bt of branchTexts) {
        await wa.sendMessage(cleanPhone, { text: bt });
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
    success: !allFailed,
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

const server = app.listen(PORT, async () => {
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

// ─── Graceful Shutdown Handlers ───────────────────────────────────────────────
let isShuttingDown = false;
const handleShutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n🔌 Received ${signal}. Starting graceful shutdown...`);

  // Close Express server first
  if (server) {
    server.close(() => {
      console.log('🚪 Express server stopped listening.');
    });
  }

  try {
    await wa.disconnectGracefully();
  } catch (err) {
    console.error('Error during WhatsApp disconnect:', err);
  }

  console.log('👋 Clean exit. Bye!');
  process.exit(0);
};

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
