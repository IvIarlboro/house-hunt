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
// On GitHub Actions the secrets come from repository secrets (HH_PASSPHRASE, HH_PORTAL_URL) and state
// lives in HH_STATE_DIR (kept between runs by the Actions cache). On a PC they come from ~/.house-hunt.
const IN_ACTIONS = !!process.env.GITHUB_ACTIONS;
const HOME = process.env.HH_STATE_DIR || join(process.env.USERPROFILE || process.env.HOME, '.house-hunt');
const SECRET = join(HOME, 'secret.json');
const STATE = join(HOME, 'state.json');
const LOG = join(HOME, 'refresh.log');
const STALE_PER_RUN = 6; // ~every listing's detail re-read about hourly (catches new open houses and notes)
const MAX_DETAILS_PER_RUN = 12;
const args = new Set(process.argv.slice(2));
const NO_PUSH = args.has('--no-push');
const ALL = args.has('--all');
// Disliked houses are read from the Dislikes tab about hourly (it is ~3 MB), and right away when a house
// newly drops off the list. --dislikes forces a sweep and reads every disliked house's detail page.
const SWEEP_DISLIKES = args.has('--dislikes');
const DISLIKE_SWEEP_MS = 55 * 60e3;
const DISLIKE_DETAILS_PER_RUN = 20;

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
const J = (x) => JSON.stringify(x);

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

// Rates, checked about twice a day:
//  - Freddie Mac's weekly survey (30-yr and 15-yr fixed, published Thursdays)
//  - Mortgage News Daily's daily index for the 7/6 adjustable (Freddie Mac stopped ARMs in 2022)
async function fetchRates(prev) {
  if (prev?.fetchedAt && Date.now() - Date.parse(prev.fetchedAt) < 12 * 3600e3) return prev;
  const fixed = await fetchPmms(prev);
  const arm = await fetchMndArm(prev);
  return fixed ? { ...fixed, ...arm, fetchedAt: new Date().toISOString() } : prev || null;
}
async function fetchMndArm(prev) {
  try {
    const r = await fetch('https://www.mortgagenewsdaily.com/mortgage-rates', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const L = (await r.text()).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, '\n').split('\n').map((x) => x.trim()).filter(Boolean);
    // First "7/6 SOFR ARM" label followed closely by a percentage is MND's own daily index.
    for (let i = 0; i < L.length; i++) {
      if (/^7\/6 SOFR ARM$/i.test(L[i])) {
        const v = L.slice(i + 1, i + 3).find((x) => /^\d+\.\d+%$/.test(x));
        if (v) return { arm76: +v.replace('%', ''), armSource: 'Mortgage News Daily index', armDate: new Date().toISOString().slice(0, 10) };
      }
    }
    throw new Error('7/6 ARM rate not found');
  } catch (e) { log('ARM rate fetch failed: ' + e.message); return prev?.arm76 ? { arm76: prev.arm76, armSource: prev.armSource, armDate: prev.armDate } : {}; }
}
async function fetchPmms(prev) {
  try {
    const r = await fetch('https://www.freddiemac.com/pmms/docs/PMMS_history.csv', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const rows = (await r.text()).trim().split(/\r?\n/).slice(1).map((l) => l.split(',')).filter((c) => c[1]);
    const iso = (d) => { const [m, dd, y] = d.split('/'); return `${y}-${m.padStart(2, '0')}-${dd.padStart(2, '0')}`; };
    const last = rows.at(-1), before = rows.at(-2);
    const n = (x) => (x === undefined || x === '' ? null : +x);
    return {
      source: 'Freddie Mac weekly survey', date: iso(last[0]),
      r30: n(last[1]), r15: n(last[3]), r30Prev: before ? n(before[1]) : null, r15Prev: before ? n(before[3]) : null,
    };
  } catch (e) { log('Freddie Mac rates fetch failed: ' + e.message); if (!prev) return null; const { fetchedAt, arm76, armSource, armDate, ...p } = prev; return p; }
}

// "Sat Oct 31, 11:00AM-1:00PM" -> { date: '2026-10-31', text: 'Sat Oct 31, 11:00AM-1:00PM' } (year rolls over in Dec→Jan).
function openHouse(text, now = new Date()) {
  const m = text.match(/^\w{3}\s+(\w{3})\s+(\d{1,2})/);
  const mi = m ? ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[1].toLowerCase()) : -1;
  if (mi < 0) return { text };
  let y = now.getFullYear();
  if (mi < now.getMonth() - 6) y++;
  return { date: `${y}-${String(mi + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`, text };
}

// The same house can be on the portal twice: once on REcolorado and once on the northern Colorado MLS
// (IRES, "IR…" listing numbers). The address is the house, not the listing number.
const addrKey = (l) => `${l.address}|${l.city}`.toLowerCase().replace(/[^a-z0-9|]+/g, ' ').replace(/ ?\| ?/g, '|').trim();
const decidedAt = (l) => (l.history || []).filter((h) => h.what === 'bucket').map((h) => h.at).sort().pop() || l.firstSeen || '';
// One card per address. It keeps the earliest-seen listing id (where the family's ratings and notes
// live), takes its list from whichever copy was moved most recently (so disliking either copy sticks),
// and shows a live copy's details if the oldest one has left the portal.
function mergeByAddress(ls) {
  const groups = new Map();
  for (const l of ls) { const k = addrKey(l); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(l); }
  return [...groups.values()].map((g) => {
    if (g.length === 1) return g[0];
    const base = g.reduce((a, b) => ((a.firstSeen || '') <= (b.firstSeen || '') ? a : b));
    const decided = g.reduce((a, b) => (decidedAt(a) >= decidedAt(b) ? a : b));
    const src = !base.offPortal ? base : g.find((l) => !l.offPortal) || base;
    return { ...src, id: base.id, firstSeen: base.firstSeen, bucket: decided.bucket, aliases: g.filter((l) => l !== base).map((l) => l.id).sort() };
  });
}

function git(...a) {
  // On Actions, checkout's own credentials push; on the PC, use Windows Credential Manager.
  const helper = IN_ACTIONS ? [] : ['-c', 'credential.helper=', '-c', 'credential.helper=manager'];
  return execFileSync('git', ['-C', REPO, ...helper, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function main() {
  // Secret passphrase (created once, kept outside the repo).
  let secret = process.env.HH_PASSPHRASE
    ? { passphrase: process.env.HH_PASSPHRASE.trim(), portalUrl: (process.env.HH_PORTAL_URL || '').trim() }
    : readJson(SECRET);
  if (!secret && IN_ACTIONS) throw new Error('HH_PASSPHRASE / HH_PORTAL_URL repository secrets are not set');
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
  const knownAddr = new Set(Object.values(state.listings).map(addrKey));
  for (const cur of listings) {
    const prev = state.listings[cur.id];
    const l = { ...(prev || {}), ...cur };
    l.firstSeen = prev?.firstSeen || nowIso;
    l.history = prev?.history ? [...prev.history] : [];
    if (!prev) changes.push(knownAddr.has(addrKey(cur)) ? `second listing ${cur.address}` : `new ${cur.address}`);
    else {
      if (prev.price !== cur.price) { l.history.push({ at: nowIso, what: 'price', from: prev.price, to: cur.price }); changes.push(`price ${cur.address}`); }
      if (prev.status !== cur.status) { l.history.push({ at: nowIso, what: 'status', from: prev.status, to: cur.status }); changes.push(`status ${cur.address}`); }
      if (prev.bucket !== cur.bucket) { l.history.push({ at: nowIso, what: 'bucket', from: prev.bucket, to: cur.bucket }); changes.push(`list ${cur.address}`); }
    }
    l.needsDetail = ALL || !prev || !prev.detailAt || prev.price !== cur.price || prev.status !== cur.status || prev.bucket !== cur.bucket;
    next[cur.id] = l;
  }
  // Keep listings that dropped off the portal page, marked as such. Disliked houses never show on the
  // list page; the Dislikes sweep below tracks them.
  for (const [id, prev] of Object.entries(state.listings)) {
    if (!next[id]) next[id] = prev.bucket === 'dislike' ? { ...prev, needsDetail: false } : { ...prev, offPortal: prev.offPortal || nowIso, needsDetail: false };
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
      // Photos come from the list page (l.media, stable links). Detail-page photo links expire within
      // about an hour, so they are not stored.
      delete l.photo; delete l.photos; delete l.photosAt;
      l.tours = d.tours || [];
      l.openHouses = (d.openHouses || []).map((t) => openHouse(t, now));
      if (d.geo) l.geo = d.geo;
      l.portalNotes = d.notes.map((n) => ({ date: absDate(n.when, now), text: n.text, by: n.by }));
      l.detailAt = nowIso;
      await sleep(400);
    } catch (e) { log(`detail failed ${l.id} ${l.address}: ${e.message}`); }
  }
  for (const l of Object.values(next)) { delete l.needsDetail; delete l.photo; delete l.photos; delete l.photosAt; }
  for (const l of Object.values(next)) if (!l.offPortal && l.bucket !== 'dislike') delete l.offReason;

  // A house that leaves the list page was disliked (the list page hides Dislikes), hidden by the portal
  // (it then shows only as an unavailable Listing ID), or removed by the agent. Check the Dislikes tab
  // only when a house has newly dropped off; it is a 2 MB page.
  const hiddenIds = new Set(unavailable.map((u) => u.id));
  const unexplained = Object.values(next).filter((l) => l.offPortal && !l.offReason && l.bucket !== 'dislike');
  for (const l of unexplained) if (hiddenIds.has(l.id)) { l.offReason = 'hidden'; changes.push(`hidden ${l.address}`); }
  const toCheck = unexplained.filter((l) => !l.offReason);
  if (toCheck.length) {
    try {
      const disliked = await portal.tabKeys('Dislikes');
      for (const l of toCheck) {
        if (disliked.has(l.key)) {
          l.history.push({ at: nowIso, what: 'bucket', from: l.bucket, to: 'dislike' });
          changes.push(`disliked ${l.address}`);
          l.bucket = 'dislike'; l.offReason = 'dislike'; delete l.offPortal; delete l.goneAt;
        } else { l.offReason = 'removed'; changes.push(`removed ${l.address}`); }
      }
    } catch (e) { log(`dislikes check failed: ${e.message}`); }
  }

  // Hidden listings: which list each is on. Ask the Favorites tab only about ones not seen before.
  const prevHidden = new Map((state.hidden || []).map((h) => [h.id, h]));
  const hidden = unavailable.map((u) => ({ ...u, bucket: prevHidden.get(u.id)?.bucket || null }));
  if (hidden.some((h) => !h.bucket)) {
    try {
      const fav = await portal.tabKeys('Favorites');
      for (const h of hidden) if (!h.bucket) h.bucket = fav.has(h.key) ? 'fav' : 'poss';
    } catch (e) { log(`favorites check failed: ${e.message}`); }
  }
  // Dislikes sweep: every house on the Dislikes tab gets a card (Disliked tab on the site) and the same
  // detail read as the rest. A disliked house leaves the site only when it is on no portal list at all.
  let dislikeSweepAt = state.dislikeSweepAt || null;
  let dislikeDetails = 0;
  if (SWEEP_DISLIKES || toCheck.length || !dislikeSweepAt || now - Date.parse(dislikeSweepAt) > DISLIKE_SWEEP_MS) {
    try {
      const d = await portal.dislikes();
      const onTab = new Set();
      let added = 0;
      for (const cur of d.listings) {
        onTab.add(cur.id);
        if (next[cur.id] && next[cur.id].bucket !== 'dislike') continue; // moved off Dislikes since the tab loaded
        const prev = next[cur.id];
        const l = { ...(prev || {}), ...cur, bucket: 'dislike', offReason: 'dislike' };
        delete l.offPortal; delete l.goneAt;
        l.firstSeen = prev?.firstSeen || nowIso;
        l.history = prev?.history ? [...prev.history] : [];
        if (!prev) added++;
        else {
          if (prev.price !== cur.price) { l.history.push({ at: nowIso, what: 'price', from: prev.price, to: cur.price }); changes.push(`price ${cur.address}`); }
          if (prev.status !== cur.status) { l.history.push({ at: nowIso, what: 'status', from: prev.status, to: cur.status }); changes.push(`status ${cur.address}`); }
        }
        l.needsDetail = SWEEP_DISLIKES || !prev?.detailAt || prev.price !== cur.price || prev.status !== cur.status;
        next[cur.id] = l;
      }
      if (added) changes.push(`added ${added} disliked`);
      for (const l of Object.values(next)) {
        if (l.bucket === 'dislike' && !onTab.has(l.id) && !l.goneAt) { l.goneAt = nowIso; changes.push(`gone ${l.address}`); }
      }
      const todoD = Object.values(next).filter((l) => l.needsDetail && l.bucket === 'dislike' && onTab.has(l.id) && Number.isInteger(l.index)).slice(0, SWEEP_DISLIKES ? 999 : DISLIKE_DETAILS_PER_RUN);
      for (const l of todoD) {
        try {
          const dd = await portal.detail(l.index);
          if (!Object.keys(dd.fields).length) throw new Error('detail page had no fields');
          delete l.needsDetail;
          l.detail ={ fields: dd.fields, parking: dd.parking, photoCount: dd.photoCount, hints: dd.hints };
          l.tours = dd.tours || [];
          l.openHouses = (dd.openHouses || []).map((t) => openHouse(t, now));
          if (dd.geo) l.geo = dd.geo;
          l.portalNotes = dd.notes.map((n) => ({ date: absDate(n.when, now), text: n.text, by: n.by }));
          l.detailAt = nowIso;
          dislikeDetails++;
          await sleep(400);
        } catch (e) { log(`dislike detail failed ${l.id} ${l.address}: ${e.message}`); }
      }
      // A house still waiting for its detail read is picked up next run.
      const behind = Object.values(next).some((l) => l.needsDetail && l.bucket === 'dislike');
      dislikeSweepAt = behind ? null : nowIso;
    } catch (e) { log(`dislikes sweep failed: ${e.message}`); }
    for (const l of Object.values(next)) { delete l.needsDetail; delete l.photo; delete l.photos; delete l.photosAt; }
  }

  // The site lists the ones it has no card for, so Jeremy knows to ask Brooke about them.
  const pubHidden = hidden.filter((h) => !next[h.id]).map(({ id, bucket }) => ({ id, bucket })).sort((a, b) => a.id.localeCompare(b.id));

  // Published payload: drop volatile fields so a quiet run doesn't create a commit.
  // Dislikes show on their own tab until they leave the portal's lists altogether; a house the agent
  // removed or the portal hid stays, badged. Until the Dislikes check has explained a drop-off, leave it out.
  const pubListings = mergeByAddress(Object.values(next)
    .filter((l) => (l.bucket === 'dislike' ? !l.goneAt : (!l.offPortal || l.offReason === 'removed' || l.offReason === 'hidden'))))
    .map(({ detailAt, index, photosAt, ...rest }) => rest)
    .sort((a, b) => a.id.localeCompare(b.id));
  // Which fields changed per listing (for the log), so churn is easy to spot.
  const strip = ({ detailAt, index, needsDetail, photosAt, ...r }) => r;
  const diffs = [];
  for (const l of pubListings) {
    const p = state.listings[l.id]; if (!p) continue;
    const a = strip(p);
    const ch = [...new Set([...Object.keys(a), ...Object.keys(l)])].filter((k) => J(a[k]) !== J(l[k])).flatMap((k) => {
      if (k !== 'detail') return [k];
      return [...new Set([...Object.keys(a.detail || {}), ...Object.keys(l.detail || {})])].filter((s) => J(a.detail?.[s]) !== J(l.detail?.[s]))
        .map((s) => 'detail.' + s + (s === 'fields' || s === 'hints'
          ? '(' + [...new Set([...Object.keys(a.detail?.[s] || {}), ...Object.keys(l.detail?.[s] || {})])].filter((f) => J(a.detail?.[s]?.[f]) !== J(l.detail?.[s]?.[f])).join('/') + ')' : ''));
    });
    if (ch.length) diffs.push(`${l.id}:${ch.join(',')}`);
  }
  const rates = await fetchRates(state.rates);
  const { fetchedAt, ...pubRates } = rates || {};
  const body = { portalUrl: PORTAL_URL, rates: rates ? pubRates : null, listings: pubListings, hidden: pubHidden };
  const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');

  const changed = hash !== state.hash || !existsSync(encPath);
  if (changed) {
    const payload = { v: 1, updatedAt: nowIso, source: 'REcolorado client portal', ...body };
    writeJson(encPath, await encryptJson(key, payload));
  }
  state = { hash, lastCheck: nowIso, dislikeSweepAt, rates, hidden, listings: next };
  writeJson(STATE, state);

  const summary = `checked ${listings.length} listings (+${unavailable.length} unavailable), details ${todo.length}${dislikeDetails ? ` + ${dislikeDetails} disliked` : ''}, ${changed ? 'CHANGED' : 'no change'}${changes.length ? ': ' + changes.slice(0, 8).join('; ') : ''}${diffs.length ? ' | fields: ' + diffs.slice(0, 8).join(' ') : ''}`;
  if (changed && !NO_PUSH) {
    try {
      git('add', 'docs/data/listings.enc.json', 'docs/data/meta.json');
      const staged = git('diff', '--cached', '--name-only');
      if (staged) git('commit', '-q', '-m', `Listings update: ${changes.length ? changes.slice(0, 3).join('; ') : 'details refreshed'}`);
      const hasRemote = git('remote').length > 0;
      if (hasRemote) { git('pull', '--rebase', '--autostash', '-q'); git('push', '-q'); }
      log(summary + (hasRemote ? ' - pushed' : ' - committed (no remote yet)'));
    } catch (e) { log(summary + ' - git failed: ' + (e.stderr || e.message).toString().trim().slice(0, 300)); process.exitCode = 1; }
  } else log(summary);
}

main().catch((e) => { log('ERROR ' + (e.stack || e.message)); process.exitCode = 1; });
