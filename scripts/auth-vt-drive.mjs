#!/usr/bin/env node
// One-shot: mint a Drive refresh token for a DIFFERENT Google account (your VT
// @vt.edu account) using the existing installed-app OAuth client, and write it
// to .env.local as GDRIVE_REFRESH_TOKEN — WITHOUT touching GOOGLE_OAUTH_*.
//
// Run:  node scripts/auth-vt-drive.mjs
// Then: a browser opens → pick hudsonmp@vt.edu → Allow. Restart the dev server.
//
// If Google shows "Access blocked / admin policy" on the consent screen, VT's
// Workspace blocks third-party OAuth apps and no token can be minted this way —
// that's the signal to use a VT-IT-allowlisted client or a Shared Drive route.

import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = path.join(ROOT, '.env.local');
const PORT = 53682;
const REDIRECT = `http://localhost:${PORT}`;
const SCOPE = 'https://www.googleapis.com/auth/drive openid email';

function readEnv() {
  const raw = readFileSync(ENV_PATH, 'utf8');
  const get = (k) => {
    const m = raw.match(new RegExp(`^${k}=(.*)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  };
  return { raw, get };
}

function upsertEnv(raw, key, value) {
  const line = `${key}=${value}`;
  if (new RegExp(`^${key}=.*$`, 'm').test(raw)) {
    return raw.replace(new RegExp(`^${key}=.*$`, 'm'), line);
  }
  return raw.replace(/\n*$/, '') + `\n${line}\n`;
}

const { raw, get } = readEnv();
const CLIENT_ID = get('GDRIVE_CLIENT_ID') || get('GOOGLE_OAUTH_CLIENT_ID');
const CLIENT_SECRET = get('GDRIVE_CLIENT_SECRET') || get('GOOGLE_OAUTH_CLIENT_SECRET');
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing GOOGLE_OAUTH_CLIENT_ID / _SECRET in .env.local'); process.exit(1);
}

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    login_hint: 'hudsonmp@vt.edu',
  }).toString();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  if (!url.searchParams.has('code') && !url.searchParams.has('error')) {
    res.writeHead(204).end(); return;
  }
  const err = url.searchParams.get('error');
  if (err) {
    res.writeHead(200, { 'content-type': 'text/html' }).end(
      `<h2>Authorization failed: ${err}</h2><p>If this says admin policy / blocked, VT's Workspace is blocking the app. You can close this tab.</p>`);
    console.error(`\nAuthorization error: ${err}`); server.close(); process.exit(1);
  }
  const code = url.searchParams.get('code');
  try {
    const tok = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT,
      }),
    }).then((r) => r.json());
    if (!tok.refresh_token) {
      throw new Error('No refresh_token returned: ' + JSON.stringify(tok));
    }
    // Confirm WHICH account authorized (so you don't accidentally re-auth personal).
    let email = '(unknown)';
    try {
      const info = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      }).then((r) => r.json());
      email = info.email || email;
    } catch {}

    const next = upsertEnv(raw, 'GDRIVE_REFRESH_TOKEN', tok.refresh_token);
    writeFileSync(ENV_PATH, next);

    res.writeHead(200, { 'content-type': 'text/html' }).end(
      `<h2>✓ Drive authorized as ${email}</h2><p>GDRIVE_REFRESH_TOKEN written to .env.local. Restart the dev server. You can close this tab.</p>`);
    console.log(`\n✓ Authorized as ${email}`);
    if (!/vt\.edu$/i.test(email)) {
      console.log(`⚠ That is NOT a @vt.edu account — re-run and pick hudsonmp@vt.edu if you meant VT.`);
    }
    console.log('✓ GDRIVE_REFRESH_TOKEN written to .env.local — restart the dev server (videos now upload to that account\'s Drive).');
    server.close(); process.exit(0);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/html' }).end(`<h2>Token exchange failed</h2><pre>${e}</pre>`);
    console.error('\nToken exchange failed:', e); server.close(); process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`\nOpening Google consent in your browser…`);
  console.log(`Sign in as hudsonmp@vt.edu and click Allow.`);
  console.log(`(If it doesn't open, visit:)\n${authUrl}\n`);
  spawn('open', [authUrl]); // macOS
});
