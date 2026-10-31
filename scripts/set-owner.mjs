// Sets the owner (who alone can change the rating weights) and the owner PIN hash inside shared.enc.json.
// The PIN itself is kept only in %USERPROFILE%\.house-hunt\secret.json as "ownerPin".
// Usage: node scripts/set-owner.mjs [Name]   (default Jeremy; reuses an existing ownerPin)
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto as wc, randomInt } from 'node:crypto';
import { deriveKey, encryptJson, decryptJson } from './crypto.mjs';
import { WORDS } from './words.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = join(process.env.USERPROFILE, '.house-hunt', 'secret.json');
const SHARED = join(REPO, 'docs', 'data', 'shared.enc.json');
const name = process.argv[2] || 'Jeremy';

const secret = JSON.parse(readFileSync(SECRET, 'utf8'));
if (!secret.ownerPin) {
  const pick = () => WORDS[randomInt(WORDS.length)];
  secret.ownerPin = `${pick()}-${pick()}-${randomInt(10, 100)}`;
  writeFileSync(SECRET, JSON.stringify(secret, null, 1) + '\n');
}
const meta = JSON.parse(readFileSync(join(REPO, 'docs', 'data', 'meta.json'), 'utf8'));
const key = await deriveKey(secret.passphrase, meta);
const shared = await decryptJson(key, JSON.parse(readFileSync(SHARED, 'utf8')));

const owner = { name, iter: 200000, salt: Buffer.from(wc.getRandomValues(new Uint8Array(16))).toString('base64') };
const base = await wc.subtle.importKey('raw', new TextEncoder().encode(secret.ownerPin.trim().toLowerCase()), 'PBKDF2', false, ['deriveBits']);
const bits = await wc.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: Buffer.from(owner.salt, 'base64'), iterations: owner.iter }, base, 256);
owner.hash = Buffer.from(bits).toString('base64');

shared.owner = owner;
shared.users ||= [];
if (!shared.users.includes(name)) shared.users.unshift(name);
writeFileSync(SHARED, JSON.stringify(await encryptJson(key, shared), null, 1) + '\n');
console.log(`owner set to ${name}; PIN stored in ${SECRET} (ownerPin)`);
