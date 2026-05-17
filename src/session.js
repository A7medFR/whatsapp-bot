'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const AUTH_DIR = path.resolve('./auth_info_baileys');

/**
 * Restore WA session from WA_SESSION_B64 env var on boot.
 * This prevents needing to re-scan QR after every container restart.
 */
function restoreSession() {
  const b64 = process.env.WA_SESSION_B64;
  if (!b64) {
    console.log('ℹ️  WA_SESSION_B64 not set — will generate QR on first boot.');
    return;
  }
  try {
    const buffer = Buffer.from(b64, 'base64');
    let jsonStr;
    try {
      jsonStr = zlib.inflateSync(buffer).toString('utf8');
    } catch (err) {
      // Fallback for older uncompressed base64 strings
      jsonStr = buffer.toString('utf8');
    }
    
    const json = JSON.parse(jsonStr);
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    for (const [filename, content] of Object.entries(json)) {
      fs.writeFileSync(path.join(AUTH_DIR, filename), typeof content === 'string' ? content : JSON.stringify(content));
    }
    console.log('✅ WA session restored from WA_SESSION_B64 env var.');
  } catch (e) {
    console.warn('⚠️  Could not restore WA session:', e.message);
  }
}

/**
 * Read current auth_info_baileys/ and return as a compressed base64 string.
 */
function encodeSession() {
  try {
    if (!fs.existsSync(AUTH_DIR)) return null;
    const files = fs.readdirSync(AUTH_DIR);
    if (files.length === 0) return null;
    const data = {};
    for (const f of files) {
      try {
        data[f] = JSON.parse(fs.readFileSync(path.join(AUTH_DIR, f), 'utf8'));
      } catch {
        data[f] = fs.readFileSync(path.join(AUTH_DIR, f), 'utf8');
      }
    }
    const jsonStr = JSON.stringify(data);
    const compressed = zlib.deflateSync(jsonStr);
    return compressed.toString('base64');
  } catch (e) {
    console.error('encodeSession error:', e.message);
    return null;
  }
}

module.exports = { restoreSession, encodeSession };
