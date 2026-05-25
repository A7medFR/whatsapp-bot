'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const AUTH_DIR = path.resolve(__dirname, '../auth_info_baileys');

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
    
    // Check if this is the new single creds.json format
    if (json.noiseKey && json.signedIdentityKey) {
      fs.writeFileSync(path.join(AUTH_DIR, 'creds.json'), JSON.stringify(json, null, 2));
      console.log('✅ WA session restored directly from single creds.json format.');
    } else {
      // Older multi-file format (for backwards compatibility)
      for (const [filename, content] of Object.entries(json)) {
        fs.writeFileSync(path.join(AUTH_DIR, filename), typeof content === 'string' ? content : JSON.stringify(content));
      }
      console.log('✅ WA session restored from multi-file bundle format.');
    }
  } catch (e) {
    console.warn('⚠️  Could not restore WA session:', e.message);
  }
}

/**
 * Read only creds.json and return as a highly compressed base64 string.
 */
function encodeSession() {
  try {
    const credsPath = path.join(AUTH_DIR, 'creds.json');
    if (!fs.existsSync(credsPath)) {
      console.warn('⚠️  creds.json not found in auth directory.');
      return null;
    }
    
    const credsContent = fs.readFileSync(credsPath, 'utf8');
    JSON.parse(credsContent); // Validate JSON
    
    const compressed = zlib.deflateSync(credsContent);
    return compressed.toString('base64');
  } catch (e) {
    console.error('encodeSession error:', e.message);
    return null;
  }
}

module.exports = { restoreSession, encodeSession };
