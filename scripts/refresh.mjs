// Checks the REcolorado client portal and publishes an encrypted listings file for the house tracker.
// Run every 10 minutes by Task Scheduler. One page request per run; detail pages only for
// new or changed listings plus a few stale ones (so portal notes stay current).
// Commits and pushes only when the published content actually changes.
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, statSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomInt } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Portal } from './portal.mjs';
import { newMeta, deriveKey, encryptJson, decryptJson } from './crypto.mjs';
import { WORDS } from './words.mjs';

// The portal link is private (anyone with it sees your saved lists and notes), so it lives in
// %USERPROFILE%\.house-hunt\secret.json as "portalUrl", never in this public repo.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(REPO, 'docs', 'data');
const HOME = join(process.env.USERPROFILE || process.env.HOME, '.house-hunt');
const SECRET = join(HOME, 'secret.json');
const STATE = join(HOME, 'state.json');
const LOG = join(HOME, 'refresh.log');
const STALE_PER_RUN = 3;
const MAX_DETAILS_PER_RUN = 12;
const args = new Set(process.argv.slice(2));
const NO_PUSH = args.has('--no-push');
const ALL = args.has('--all');

mkdirSync(HOME, { recursive: true });
mkdirSync(DATA, { recursive: true });
const log = (msg) => {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try { if (existsSync(LOG) && statSync(LOG).size > 1_000_000) renameSync(LOG, LOG + '.1'); } catch { }
  appendFileSync(LOG, line); process.stdout.write(line);
};
const readJson = (p, d = null) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d);
const writeJson = (p, o) => writeFileSync(p, JSON.stringify(o, null, 1) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Portal shows recent note dates as "yesterday" or a weekday; pin them to real dates.
function absDate(label, now = new Date()) {
  const s = (label || '').trim().toLowerCase();
  const iso = (d) => d.toISOString().slice(0, 10);
  if (s === 'today') return iso(now);
  if (s === 'yesterday') return iso(new Date(now - 864e5));
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const wd = days.indexOf(s);
  if (wd >= 0) { const back = ((now.getDay() - wd + 7) % 7) || 7; return iso(new Date(now - back * 864e5)); }
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return label;
}

function git(...a) {
  return execFileSync('git', ['-C', REPO, '-c', 'credential.helper=', '-c', 'credential.helper=manager', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function main() {
  // Secret passphrase (created once, kept outside the repo).
  let secret = readJson(SECRET);
  if (!secret) {
    const pick = () => WORDS[randomInt(WORDS.length)];
    secret = { passphrase: `${pick()}-${pick()}-${pick()}-${pick()}-${pick()}-${randomInt(10, 100)}`, created: new Date().toISOString() };
    writeJson(SECRET, secret);
    log('created new passphrase in ' + SECRET);
  }
  const PORTAL_URL = secret.portalUrl;
  if (!PORTAL_URL) throw new Error(`Add "portalUrl" (your REcolorado portal link) to ${SECRET}`);
  const metaPath = join(DATA, 'meta.json');
  let meta = readJson(metaPath);
  if (!meta) { meta = newMeta(); writeJson(metaPath, meta); }
  const key = await deriveKey(secret.passphrase, meta);

  const encPath = join(DATA, 'listings.enc.json');
  let state = readJson(STATE);
  if (!state && existsSync(encPath)) {
    const pub = await decryptJson(key, readJson(encPath));
    state = { hash: null, listings: Object.fromEntries(pub.listings.map((l) => [l.id, l])) };
  }
  state ||= { hash: null, listings: {} };

  const now = new Date();
  const nowIso = now.toISOString();
  const portal = new Portal(PORTAL_URL);
  const { listings, unavailable } = await portal.list();

  const next = {};
  const changes = [];
  for (const cur of listings) {
    const prev = state.listings[cur.id];
    const l = { ...(prev || {}), ...cur };
    l.firstSeen = prev?.firstSeen || nowIso;
    l.history = prev?.history ? [...prev.history] : [];
    if (!prev) changes.push(`new ${cur.address}`);
    else {
      if (prev.price !== cur.price) { l.history.push({ at: nowIso, what: 'price', from: prev.price, to: cur.price }); changes.push(`price ${cur.address}`); }
      if (prev.status !== cur.status) { l.history.push({ at: nowIso, what: 'status', from: prev.status, to: cur.status }); changes.push(`status ${cur.address}`); }
      if (prev.bucket !== cur.bucket) { l.history.push({ at: nowIso, what: 'bucket', from: prev.bucket, to: cur.bucket }); changes.push(`list ${cur.address}`); }
    }
    l.needsDetail = ALL || !prev || !prev.detailAt || prev.price !== cur.price || prev.status !== cur.status || prev.bucket !== cur.bucket;
    next[cur.id] = l;
  }
  // Keep listings that dropped off the portal page, marked as such.
  for (const [id, prev] of Object.entries(state.listings)) {
    if (!next[id]) next[id] = { ...prev, offPortal: prev.offPortal || nowIso, needsDetail: false };
  }
  for (const l of Object.values(next)) if (!l.offPortal || listings.some((x) => x.id === l.id)) delete l.offPortal;

  // Detail pages: required ones first, then the stalest few (non-dislikes) so portal notes refresh.
  const live = Object.values(next).filter((l) => !l.offPortal && l.bucket !== 'dislike');
  const required = live.filter((l) => l.needsDetail);
  const stale = live.filter((l) => !l.needsDetail).sort((a, b) => (a.detailAt || '').localeCompare(b.detailAt || '')).slice(0, STALE_PER_RUN);
  const firstRun = !Object.keys(state.listings).length;
  const todo = [...required, ...stale].slice(0, firstRun || ALL ? 999 : MAX_DETAILS_PER_RUN);
  for (const l of todo) {
    try {
      const d = await portal.detail(l.index);
      l.detail = {
        fields: d.fields, parking: d.parking, photoCount: d.photoCount, hints: d.hints,
      };
      l.photo = d.photo || l.photo || l.photoThumb;
      l.portalNotes = d.notes.map((n) => ({ date: absDate(n.when, now), text: n.text, by: n.by }));
      l.detailAt = nowIso;
      await sleep(400);
    } catch (e) { log(`detail failed ${l.id} ${l.address}: ${e.message}`); }
  }
  for (const l of Object.values(next)) delete l.needsDetail;

  // Published payload: drop volatile fields so a quiet run doesn't create a commit.
  const pubListings = Object.values(next)
    .filter((l) => l.bucket !== 'dislike')
    .map(({ detailAt, index, ...rest }) => rest)
    .sort((a, b) => a.id.localeCompare(b.id));
  const body = { listings: pubListings, unavailable: [...unavailable].sort() };
  const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');

  const changed = hash !== state.hash || !existsSync(encPath);
  if (changed) {
    const payload = { v: 1, updatedAt: nowIso, source: 'REcolorado client portal', portalUrl: PORTAL_URL, ...body };
    writeJson(encPath, await encryptJson(key, payload));
  }
  state = { hash, lastCheck: nowIso, listings: next };
  writeJson(STATE, state);

  const summary = `checked ${listings.length} listings (+${unavailable.length} unavailable), details ${todo.length}, ${changed ? 'CHANGED' : 'no change'}${changes.length ? ': ' + changes.slice(0, 8).join('; ') : ''}`;
  if (changed && !NO_PUSH) {
    try {
      git('add', 'docs/data/listings.enc.json', 'docs/data/meta.json');
      const staged = git('diff', '--cached', '--name-only');
      if (staged) git('commit', '-q', '-m', `Listings update: ${changes.length ? changes.slice(0, 3).join('; ') : 'details refreshed'}`);
      const hasRemote = git('remote').length > 0;
      if (hasRemote) { git('pull', '--rebase', '-q'); git('push', '-q'); }
      log(summary + (hasRemote ? ' — pushed' : ' — committed (no remote yet)'));
    } catch (e) { log(summary + ' — git failed: ' + (e.stderr || e.message).toString().trim().slice(0, 300)); process.exitCode = 1; }
  } else log(summary);
}

main().catch((e) => { log('ERROR ' + (e.stack || e.message)); process.exitCode = 1; });
