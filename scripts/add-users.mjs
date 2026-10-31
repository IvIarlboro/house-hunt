// Add people to the shared list from the home PC (no site token needed): node scripts/add-users.mjs Brooke Leon
// Then commit and push docs/data/shared.enc.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveKey, encryptJson, decryptJson } from './crypto.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = join(REPO, 'docs', 'data', 'shared.enc.json');
const names = process.argv.slice(2).map((n) => n.trim()).filter(Boolean);
if (!names.length) { console.log('usage: node scripts/add-users.mjs Name [Name...]'); process.exit(1); }
const secret = JSON.parse(readFileSync(join(process.env.USERPROFILE, '.house-hunt', 'secret.json'), 'utf8'));
const key = await deriveKey(secret.passphrase, JSON.parse(readFileSync(join(REPO, 'docs', 'data', 'meta.json'), 'utf8')));
const shared = await decryptJson(key, JSON.parse(readFileSync(SHARED, 'utf8')));
shared.users ||= [];
const added = names.filter((n) => !shared.users.includes(n));
shared.users.push(...added);
writeFileSync(SHARED, JSON.stringify(await encryptJson(key, shared), null, 1) + '\n');
console.log('added:', added.join(', ') || '(none)', '| people now:', shared.users.join(', '));
