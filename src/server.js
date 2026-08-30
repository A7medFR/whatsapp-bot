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

// ─── Health Check & Safety Handlers ─────────────────────────────────────────
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', uptime: process.uptime() }));

process.on('uncaughtException', (err) => {
  console.error('❌ [Uncaught Exception]:', err);
  if (global.logEvent) global.logEvent(`❌ [Uncaught Exception]: ${err.message}`, 'error');
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ [Unhandled Rejection]:', reason);
  if (global.logEvent) global.logEvent(`❌ [Unhandled Rejection]: ${reason}`, 'error');
});

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

    /* Mode Switcher Tabs */
    .link-mode-tabs {
      display: flex;
      background: rgba(0, 0, 0, 0.35);
      padding: 4px;
      border-radius: 12px;
      border: 1px solid var(--border-color);
      margin-bottom: 20px;
      gap: 4px;
    }

    .link-mode-tab {
      flex: 1;
      padding: 8px 12px;
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--text-muted);
      background: none;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .link-mode-tab.active {
      background: rgba(6, 182, 212, 0.15);
      color: var(--accent-cyan);
      border: 1px solid rgba(6, 182, 212, 0.3);
      box-shadow: 0 2px 8px rgba(6, 182, 212, 0.15);
    }

    .link-mode-tab:hover:not(.active) {
      color: var(--text-main);
      background: rgba(255, 255, 255, 0.04);
    }

    /* QR Code styles */
    .qr-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
      width: 100%;
    }

    #qr-img {
      border: 8px solid #ffffff;
      border-radius: 16px;
      width: 210px;
      height: 210px;
      display: block;
      box-shadow: 0 10px 25px rgba(0,0,0,0.3);
      transition: opacity 0.3s;
    }

    #qr-img.fading {
      opacity: 0.2;
    }

    /* Pairing Code Styles */
    .pairing-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      width: 100%;
      flex: 1;
    }

    .pairing-form {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .pairing-input-wrapper {
      display: flex;
      align-items: center;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid var(--border-color);
      border-radius: 10px;
      padding: 4px 12px;
      transition: border-color 0.2s, box-shadow 0.2s;
    }

    .pairing-input-wrapper:focus-within {
      border-color: var(--accent-cyan);
      box-shadow: 0 0 0 2px rgba(6, 182, 212, 0.2);
    }

    .pairing-prefix {
      color: var(--accent-cyan);
      font-weight: 700;
      font-size: 0.95rem;
      margin-right: 8px;
      user-select: none;
    }

    .pairing-input {
      background: transparent;
      border: none;
      color: #fff;
      font-size: 0.95rem;
      font-family: inherit;
      width: 100%;
      padding: 8px 0;
      outline: none;
    }

    .pairing-input::placeholder {
      color: #475569;
    }

    .btn-pairing {
      background: linear-gradient(135deg, #06b6d4, #0284c7);
      color: #ffffff;
      border: none;
      padding: 10px 18px;
      border-radius: 10px;
      font-weight: 600;
      font-size: 0.85rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      box-shadow: 0 4px 14px rgba(6, 182, 212, 0.3);
      transition: all 0.2s;
    }

    .btn-pairing:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(6, 182, 212, 0.4);
    }

    .btn-pairing:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }

    .pairing-code-display {
      width: 100%;
      background: rgba(6, 182, 212, 0.05);
      border: 1px solid rgba(6, 182, 212, 0.25);
      border-radius: 14px;
      padding: 18px;
      text-align: center;
      animation: fadeInModal 0.3s ease;
    }

    .pairing-code-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      font-family: 'Fira Code', 'Courier New', monospace;
      font-size: 1.6rem;
      font-weight: 800;
      letter-spacing: 4px;
      color: #38bdf8;
      background: rgba(0, 0, 0, 0.55);
      padding: 12px 20px;
      border-radius: 10px;
      border: 1px solid rgba(56, 189, 248, 0.35);
      box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.5), 0 0 15px rgba(56, 189, 248, 0.15);
      margin-bottom: 12px;
      user-select: all;
    }

    .pairing-code-actions {
      display: flex;
      justify-content: center;
      gap: 8px;
    }

    .link-alt-btn {
      background: none;
      border: none;
      color: var(--accent-cyan);
      font-size: 0.8rem;
      cursor: pointer;
      margin-top: 14px;
      text-decoration: underline;
      opacity: 0.85;
      transition: opacity 0.2s;
    }

    .link-alt-btn:hover {
      opacity: 1;
    }

    .instructions {
      font-size: 0.82rem;
      color: var(--text-muted);
      line-height: 1.5;
      margin-top: 16px;
      text-align: center;
      width: 100%;
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
  /* Session Export Modal */
  #session-export-modal {
    position: fixed;
    inset: 0;
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .session-modal-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    backdrop-filter: blur(6px);
  }
  .session-modal-box {
    position: relative;
    background: #12192b;
    border: 1px solid rgba(100, 180, 255, 0.2);
    border-radius: 14px;
    padding: 28px;
    width: min(560px, 92vw);
    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
    display: flex;
    flex-direction: column;
    gap: 16px;
    animation: fadeInModal 0.25s ease;
  }
  @keyframes fadeInModal {
    from { opacity: 0; transform: scale(0.95) translateY(8px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
  }
  .session-modal-header {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--accent-cyan);
    font-weight: 700;
    font-size: 1rem;
  }
  .session-modal-close {
    margin-left: auto;
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 1rem;
    padding: 4px 8px;
    border-radius: 6px;
    transition: color 0.2s;
  }
  .session-modal-close:hover { color: #fff; }
  .session-modal-hint {
    font-size: 0.82rem;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
  }
  .session-modal-hint code {
    background: rgba(100, 180, 255, 0.12);
    color: var(--accent-cyan);
    padding: 2px 6px;
    border-radius: 4px;
    font-family: monospace;
    font-size: 0.8rem;
  }
  .session-modal-label {
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.8px;
    text-transform: uppercase;
    color: var(--accent-cyan);
    opacity: 0.7;
  }
  .session-modal-value {
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(100, 180, 255, 0.15);
    border-radius: 8px;
    padding: 12px 14px;
    font-family: monospace;
    font-size: 0.7rem;
    color: #94a3b8;
    word-break: break-all;
    max-height: 120px;
    overflow-y: auto;
    line-height: 1.5;
    user-select: all;
  }
  .session-modal-actions {
    display: flex;
    align-items: center;
    gap: 8px;
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
        <button class="btn btn-export" onclick="exportSession()" id="sidebar-export-btn" style="width:100%; justify-content:center; padding:10px; margin-bottom:12px; font-size:0.8rem;">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Export Session
        </button>
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
        <!-- Link Device Card (QR Code & Phone Number Pairing Code) -->
        <div id="qr-card" class="card" style="display: none;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px;">
            <h3 class="card-title" style="margin-bottom: 0;">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--accent-cyan);"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
              Link Device
            </h3>
            <span style="font-size:0.75rem; font-weight:600; color:var(--accent-cyan); background:rgba(6,182,212,0.12); padding:3px 8px; border-radius:6px; border:1px solid rgba(6,182,212,0.25);">WhatsApp Web</span>
          </div>

          <!-- Mode Switcher Tabs -->
          <div class="link-mode-tabs">
            <button id="tab-qr" class="link-mode-tab active" onclick="switchLinkMode('qr')">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
              QR Code
            </button>
            <button id="tab-phone" class="link-mode-tab" onclick="switchLinkMode('phone')">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
              Link with Phone Number
            </button>
          </div>

          <!-- Tab 1: QR Code View -->
          <div id="view-qr" class="qr-container">
            <img id="qr-img" src="" alt="Scan QR" />
            <div class="instructions">
              <p>Scan with WhatsApp Business / Personal:</p>
              <ol>
                <li>Open WhatsApp on your phone</li>
                <li>Tap <b>Menu (⋮)</b> or <b>Settings</b></li>
                <li>Select <b>Linked Devices</b> → <b>Link a Device</b></li>
                <li>Point your phone to this screen</li>
              </ol>
              <button class="link-alt-btn" onclick="switchLinkMode('phone')">
                Or link with phone number instead →
              </button>
            </div>
          </div>

          <!-- Tab 2: Phone Number Pairing Code View -->
          <div id="view-phone" class="pairing-container" style="display: none;">
            <div class="pairing-form" id="pairing-input-section">
              <p style="font-size:0.85rem; color:var(--text-muted); margin:0 0 4px 0; line-height:1.4;">
                Enter the <strong>exact WhatsApp number of this account</strong> with country code — digits only, no + sign:
              </p>
              <p style="font-size:0.78rem; color:#f59e0b; margin:0 0 10px 0; line-height:1.4;">
                ⚠️ This must be the same number registered in WhatsApp on your phone (e.g. 966533267493 for Saudi +966 533 267 493)
              </p>
              <div class="pairing-input-wrapper">
                <span class="pairing-prefix">+</span>
                <input type="tel" id="pairing-phone-input" class="pairing-input" placeholder="e.g. 966533267493" autocomplete="tel" onkeydown="if(event.key==='Enter')handleRequestPairingCode()" />
              </div>
              <button class="btn-pairing" id="btn-request-pairing" onclick="handleRequestPairingCode()">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                <span id="btn-request-text">Get Pairing Code</span>
              </button>
            </div>

            <!-- Pairing Code Result Display -->
            <div id="pairing-result-section" class="pairing-code-display" style="display: none;">
              <p style="font-size:0.8rem; color:var(--text-muted); margin:0 0 8px 0; text-transform:uppercase; letter-spacing:0.5px; font-weight:600;">
                Your WhatsApp Connection Code
              </p>
              <div class="pairing-code-badge" id="pairing-code-val">
                ---- - ----
              </div>
              <div class="pairing-code-actions">
                <button class="btn btn-export" id="btn-copy-pairing" onclick="copyPairingCode()" style="padding:6px 14px; font-size:0.8rem;">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  <span id="copy-btn-text">Copy Code</span>
                </button>
                <button class="btn" onclick="resetPairingForm()" style="padding:6px 14px; font-size:0.8rem;">
                  Change Number
                </button>
              </div>

              <div class="instructions" style="margin-top:14px; text-align:left;">
                <p style="font-weight:600; color:var(--accent-cyan); margin-bottom:4px;">How to link on your phone:</p>
                <ol>
                  <li>Open WhatsApp on your phone (the same number you entered above)</li>
                  <li>Tap <b>Menu (⋮)</b> (Android) or <b>Settings</b> (iOS)</li>
                  <li>Select <b>Linked Devices</b> → <b>Link a Device</b></li>
                  <li>Tap <b>Link with phone number instead</b></li>
                  <li>WhatsApp will ask for your phone number — enter your own number to confirm</li>
                  <li>Enter the 8-character code shown above on the screen that appears</li>
                </ol>
              </div>
            </div>

            <button class="link-alt-btn" onclick="switchLinkMode('qr')">
              ← Or scan QR code instead
            </button>
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
          showToast('❌ Export failed. Make sure WhatsApp is connected first.');
          return;
        }
        const data = await res.json();
        const b64 = data.WA_SESSION_B64 || data.base64;
        if (!b64) {
          showToast('❌ No session found. Scan the QR first, then export.');
          return;
        }
        // Show modal overlay with the session key
        const existing = document.getElementById('session-export-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'session-export-modal';
        modal.dataset.b64 = b64;
        modal.innerHTML =
          '<div class="session-modal-backdrop" onclick="closeSessionModal()"></div>' +
          '<div class="session-modal-box">' +
            '<div class="session-modal-header">' +
              '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
              '<span>Export WhatsApp Session</span>' +
              '<button onclick="closeSessionModal()" class="session-modal-close">&#10005;</button>' +
            '</div>' +
            '<p class="session-modal-hint">Copy this value and set it as <code>WA_SESSION_B64</code> in your Railway / cloud environment variables to persist your session across restarts.</p>' +
            '<div class="session-modal-label">WA_SESSION_B64</div>' +
            '<div class="session-modal-value" id="session-b64-value">' + b64 + '</div>' +
            '<div class="session-modal-actions">' +
              '<button class="btn btn-export" id="session-copy-btn" onclick="copySessionToClipboard()">' +
                '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
                ' Copy to Clipboard' +
              '</button>' +
              '<button class="btn" onclick="closeSessionModal()" style="margin-left:8px;">Dismiss</button>' +
            '</div>' +
          '</div>';
        document.body.appendChild(modal);
      } catch (err) {
        showToast('❌ Connection error during export.');
      }
    }

    async function copySessionToClipboard() {
      try {
        const modal = document.getElementById('session-export-modal');
        const b64 = modal ? modal.dataset.b64 : '';
        if (!b64) { showToast('❌ No session data found.'); return; }
        await navigator.clipboard.writeText(b64);
        const btn = document.getElementById('session-copy-btn');
        if (btn) {
          btn.textContent = '✅ Copied!';
          btn.style.background = 'rgba(52, 211, 153, 0.2)';
          btn.style.borderColor = 'rgba(52, 211, 153, 0.4)';
          btn.style.color = '#a7f3d0';
          setTimeout(() => { document.getElementById('session-export-modal')?.remove(); }, 1500);
        }
      } catch (err) {
        showToast('❌ Could not copy. Please select the text manually.');
      }
    }

    function closeSessionModal() {
      var m = document.getElementById('session-export-modal');
      if (m) m.remove();
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

    let activePairingCode = null;

    function switchLinkMode(mode) {
      const tabQr = document.getElementById('tab-qr');
      const tabPhone = document.getElementById('tab-phone');
      const viewQr = document.getElementById('view-qr');
      const viewPhone = document.getElementById('view-phone');

      if (mode === 'phone') {
        if (tabQr) tabQr.classList.remove('active');
        if (tabPhone) tabPhone.classList.add('active');
        if (viewQr) viewQr.style.display = 'none';
        if (viewPhone) viewPhone.style.display = 'flex';
        const input = document.getElementById('pairing-phone-input');
        if (input) input.focus();
      } else {
        if (tabPhone) tabPhone.classList.remove('active');
        if (tabQr) tabQr.classList.add('active');
        if (viewPhone) viewPhone.style.display = 'none';
        if (viewQr) viewQr.style.display = 'flex';
      }
    }

    async function handleRequestPairingCode() {
      const input = document.getElementById('pairing-phone-input');
      const btn = document.getElementById('btn-request-pairing');
      const btnText = document.getElementById('btn-request-text');
      const rawPhone = input ? input.value.trim() : '';

      if (!rawPhone) {
        showToast('⚠️ Please enter your WhatsApp phone number.');
        if (input) input.focus();
        return;
      }

      if (btn) btn.disabled = true;
      if (btnText) btnText.textContent = 'Generating Code...';

      try {
        const res = await fetch('/pairing-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: rawPhone })
        });
        const data = await res.json();

        if (!res.ok || !data.success) {
          showToast('❌ ' + (data.error || 'Failed to request pairing code.'));
          if (btn) btn.disabled = false;
          if (btnText) btnText.textContent = 'Get Pairing Code';
          return;
        }

        activePairingCode = data.formattedCode || data.code;
        const codeVal = document.getElementById('pairing-code-val');
        if (codeVal) codeVal.textContent = activePairingCode;

        const inputSec = document.getElementById('pairing-input-section');
        const resultSec = document.getElementById('pairing-result-section');
        if (inputSec) inputSec.style.display = 'none';
        if (resultSec) resultSec.style.display = 'block';

        showToast('✅ Pairing code generated! Enter it in WhatsApp on your phone.');
        addSystemLog('Generated pairing code ' + activePairingCode + ' for +' + data.phone);
      } catch (err) {
        showToast('❌ Network error requesting pairing code.');
      } finally {
        if (btn) btn.disabled = false;
        if (btnText) btnText.textContent = 'Get Pairing Code';
      }
    }

    function resetPairingForm() {
      const inputSec = document.getElementById('pairing-input-section');
      const resultSec = document.getElementById('pairing-result-section');
      if (resultSec) resultSec.style.display = 'none';
      if (inputSec) inputSec.style.display = 'flex';
      activePairingCode = null;
      const input = document.getElementById('pairing-phone-input');
      if (input) input.focus();
    }

    async function copyPairingCode() {
      if (!activePairingCode) return;
      try {
        await navigator.clipboard.writeText(activePairingCode.replace(/-/g, ''));
        const btnText = document.getElementById('copy-btn-text');
        if (btnText) {
          btnText.textContent = 'Copied!';
          setTimeout(() => { btnText.textContent = 'Copy Code'; }, 2000);
        }
        showToast('📋 Copied pairing code to clipboard!');
      } catch (_) {
        showToast('❌ Failed to copy code.');
      }
    }

    // Poll status & handle grid state
    async function checkStatus() {
      try {
        const res = await fetch('/bot-status');
        const status = await res.json();
        updateUI(status.connected, status.hasQR, status.qr, status.pairingCode);
      } catch (err) {
        // ignore errors
      }
    }

    function updateUI(connected, hasQR, qr, pairingCode) {
      if (connected) {
        statusBadge.className = 'badge badge-connected';
        statusText.textContent = 'WhatsApp Connected';
        qrCard.style.display = 'none';
        infoCard.style.display = 'flex';
        mainGrid.className = 'main-grid main-grid-split';
        resetPairingForm();
      } else if (hasQR || qr || pairingCode) {
        statusBadge.className = 'badge badge-disconnected';
        statusText.textContent = 'Link Device Pending';
        infoCard.style.display = 'none';
        qrCard.style.display = 'flex';
        mainGrid.className = 'main-grid main-grid-split';
        
        if (qr && qrImg.getAttribute('data-qr') !== qr) {
          qrImg.setAttribute('data-qr', qr);
          qrImg.src = '/qr-image?qr=' + encodeURIComponent(qr) + '&t=' + Date.now();
          addSystemLog('New WhatsApp pairing QR generated.');
        }

        if (pairingCode && pairingCode.formattedCode && !activePairingCode) {
          activePairingCode = pairingCode.formattedCode;
          const codeVal = document.getElementById('pairing-code-val');
          if (codeVal) codeVal.textContent = activePairingCode;
          const inputSec = document.getElementById('pairing-input-section');
          const resultSec = document.getElementById('pairing-result-section');
          if (inputSec) inputSec.style.display = 'none';
          if (resultSec) resultSec.style.display = 'block';
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
  const { connected, hasQR, qr, pairingCode } = wa.getStatus();
  res.json({ connected, hasQR, qr, pairingCode });
});

/** Request WhatsApp Number Pairing Code (Link with phone number instead) */
app.post(['/pairing-code', '/request-pairing-code'], async (req, res) => {
  try {
    const phone = req.body?.phone || req.body?.phoneNumber;
    if (!phone) {
      return res.status(400).json({ success: false, error: 'Phone number is required.' });
    }
    const result = await wa.requestPairingCode(phone);
    res.json({
      success: true,
      code: result.code,
      formattedCode: result.formattedCode,
      phone: result.phone
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || 'Failed to generate pairing code.' });
  }
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
