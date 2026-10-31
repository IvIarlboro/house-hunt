// AES-GCM 256 with a PBKDF2-SHA256 key from the family passphrase.
// Same format is decrypted in the browser by docs/app.js.
import { webcrypto as wc } from 'node:crypto';

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

export function newMeta() {
  return { v: 1, kdf: 'PBKDF2-SHA256', iter: 600000, salt: b64(wc.getRandomValues(new Uint8Array(16))) };
}

export async function deriveKey(passphrase, meta) {
  const base = await wc.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return wc.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: unb64(meta.salt), iterations: meta.iter },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptJson(key, obj) {
  const iv = wc.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await wc.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  return { v: 1, iv: b64(iv), ct: b64(ct) };
}

export async function decryptJson(key, box) {
  const pt = await wc.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));
  return JSON.parse(dec.decode(pt));
}
