// One-off local admin utility: set a Supabase auth user's password.
// Usage: node scripts/reset-password.mjs <email>   (prompts for the new password;
// nothing is echoed or logged). Uses SUPABASE_SERVICE_ROLE_KEY from .env.local.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');

const email = process.argv[2];
if (!email) throw new Error('Usage: node scripts/reset-password.mjs <email>');

// Hidden password prompt (no echo).
function promptHidden(q) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const orig = rl._writeToOutput.bind(rl);
    process.stdout.write(q);
    rl._writeToOutput = () => {};
    rl.question('', (ans) => {
      rl._writeToOutput = orig;
      process.stdout.write('\n');
      rl.close();
      resolve(ans);
    });
  });
}

const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

// Find the user by email (paged; the project has a handful of users).
let user = null;
for (let page = 1; page <= 10 && !user; page++) {
  const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 100 });
  if (error) throw error;
  user = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null;
  if (data.users.length < 100) break;
}
if (!user) throw new Error(`No auth user with email ${email}`);

const pw = await promptHidden(`New password for ${email} (min 6 chars, hidden): `);
if (pw.length < 6) throw new Error('Password too short.');
const confirm = await promptHidden('Confirm: ');
if (pw !== confirm) throw new Error('Passwords do not match.');

const { error } = await sb.auth.admin.updateUserById(user.id, { password: pw });
if (error) throw error;
console.log(`Password updated for ${email} (uid ${user.id}). Sign in at /create/login.`);
