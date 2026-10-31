'use strict';
// House Hunt — static, passphrase-encrypted tracker. Data files live in docs/data/ of the GitHub repo:
//   meta.json (KDF salt, public), listings.enc.json (written by the refresh job),
//   shared.enc.json (people, weights, ratings, notes — written here), token.enc.json (shared write token).
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const LS = {
    get: (k, d = null) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { } },
    del: (k) => { try { localStorage.removeItem(k); } catch { } },
  };
  // Forgive copy/paste from the secret file: a whole line like  "passphrase": "maple-otter-42",
  // quotes, commas, spaces and capitals all get stripped (generated secrets are lowercase words, digits, dashes).
  const cleanSecret = (v, key) => String(v || '')
    .replace(new RegExp(`^\\s*"?${key}"?\\s*:\\s*`, 'i'), '')
    .replace(/^[\s"'“”‘’,]+|[\s"'“”‘’,]+$/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => n == null ? '—' : '$' + Math.round(n).toLocaleString();
  const ACTIVE = /^(Active|Coming Soon)$/i;

  // ---------- rating model ----------
  const DEFAULT_WEIGHTS = { rv: 27, kitchen: 17, layout: 9, primary: 6, size: 8, psf: 8, tax: 5, ac: 5, multigen: 7, pool: 3, outdoor: 3, upgrades: 2, age: 4 };
  const ITEMS = [
    { k: 'rv', label: 'RV parking', opts: { fits: 'Fits', likely: 'Listed, unverified', tight: 'Tight', unknown: 'Unknown', no: 'No' }, score: { fits: 1, likely: 0.6, tight: 0.35, unknown: 0.2, no: 0 } },
    { k: 'kitchen', label: 'Open kitchen', opts: { yes: 'Yes', likely: 'Likely', partial: 'Partly', unknown: 'Unknown', no: 'No' }, score: { yes: 1, likely: 0.7, partial: 0.5, unknown: 0.35, no: 0 } },
    { k: 'layout', label: 'Layout (levels)', opts: { good: 'Ranch / 2-story', split: 'Split / tri-level', bilevel: 'Bi-level' }, score: { good: 1, split: 0.6, bilevel: 0 } },
    { k: 'primary', label: 'Primary bedroom on main', opts: { main: 'Main floor', unknown: 'Unknown', other: 'Not main floor' }, score: { main: 1, unknown: 0.4, other: 0 } },
    { k: 'size', label: 'Finished size' },
    { k: 'psf', label: '$/sqft value' },
    { k: 'tax', label: 'Taxes' },
    { k: 'ac', label: 'A/C', opts: { yes: 'Central', partial: 'Partial / evap', no: 'None' }, score: { yes: 1, partial: 0.5, no: 0 } },
    // Jeremy's levels: rental 8, multigen 5, no 0 — scaled so a rental earns the item's full weight.
    { k: 'multigen', label: 'Multigen / rental unit', opts: { rental: 'Rental / ADU', multigen: 'Multigen', unknown: 'Unknown', no: 'No' }, score: { rental: 1, multigen: 5 / 8, unknown: 0.2, no: 0 } },
    { k: 'pool', label: 'Pool / hot tub', opts: { pool: 'In-ground pool', hottub: 'Hot tub', none: 'None' }, score: { pool: 1, hottub: 0.4, none: 0 } },
    { k: 'outdoor', label: 'Outdoor entertaining', opts: { great: 'Great', some: 'Some', none: 'Little' }, score: { great: 1, some: 0.5, none: 0 } },
    { k: 'upgrades', label: 'Recent upgrades', opts: { major: 'Major', some: 'Some', none: 'None' }, score: { major: 1, some: 0.5, none: 0 } },
    { k: 'age', label: 'Year built' },
  ];

  // Items ordered by their current weight, most points first (ties keep the list order above).
  const byWeight = () => {
    const w = S.shared?.weights || DEFAULT_WEIGHTS;
    return ITEMS.map((it, i) => ({ it, i })).sort((a, b) => (+w[b.it.k] || 0) - (+w[a.it.k] || 0) || a.i - b.i).map((x) => x.it);
  };

  // ---------- state ----------
  const S = {
    meta: null, key: null, token: null, repo: null,
    data: null, shared: null, sharedSha: null,
    user: LS.get('hh-user'), tab: LS.get('hh-tab', 'fav'), sort: LS.get('hh-sort', 'score'),
    showOff: LS.get('hh-hideOff') !== '1', showLow: LS.get('hh-showLow') === '1', q: '', prevVisit: LS.get('hh-lastVisit'), openRatings: new Set(),
  };
  const defaultShared = () => ({ v: 1, users: [], weights: { ...DEFAULT_WEIGHTS }, ratings: {}, notes: [] });
  // Payment estimate. Rates come from Freddie Mac's weekly survey (excellent credit, ~20% down), refreshed by
  // the home PC; the owner can add a lender quote that becomes the default. Insurance default sits toward the
  // high end of 2026 Colorado averages for this price range.
  const FALLBACK_RATES = { source: 'Freddie Mac weekly survey', date: '2026-10-29', r30: 7.24, r15: 6.6 };
  const DEFAULT_LOAN = { downPct: 20, insYear: 4000, customRate: null, customTerm: 30, customNote: '' };
  const loan = () => ({ ...DEFAULT_LOAN, ...(S.shared?.prefs?.loan || {}) });
  const ratesNow = () => S.data?.rates || FALLBACK_RATES;
  function loanOptions() {
    const R = ratesNow(), L = loan();
    const opts = [];
    if (L.customRate) opts.push({ k: 'quote', rate: +L.customRate, term: +L.customTerm || 30, label: `Your quote · ${L.customTerm || 30}-yr ${(+L.customRate).toFixed(3).replace(/0+$/, '')}%` });
    if (R.r30) opts.push({ k: 'r30', rate: R.r30, term: 30, label: `30-yr fixed · ${R.r30}% avg` });
    if (R.r30) opts.push({ k: 'r30pt', rate: +(R.r30 - 0.25).toFixed(2), term: 30, label: `30-yr, 1 point paid · ~${(R.r30 - 0.25).toFixed(2)}%`, note: '1 discount point costs 1% of the loan upfront and usually trims about 0.25%' });
    if (R.r15) opts.push({ k: 'r15', rate: R.r15, term: 15, label: `15-yr fixed · ${R.r15}% avg` });
    return opts;
  }
  function loanChoice() {
    const opts = loanOptions();
    return opts.find((o) => o.k === LS.get('hh-loanOpt')) || opts[0];
  }
  function payment(l) {
    const L = loan(), O = loanChoice(); if (!O) return null;
    const price = l.price; if (!price) return null;
    const down = price * L.downPct / 100, principal = price - down;
    const r = O.rate / 100 / 12, n = O.term * 12;
    const pi = r ? principal * r / (1 - Math.pow(1 + r, -n)) : principal / n;
    const tax = (taxOf(l) || 0) / 12, ins = L.insYear / 12;
    const hoaYr = parseFloat(String(l.detail?.fields?.['Total Annual HOA Fees'] || '').replace(/[$,]/g, '')) || 0;
    const hoa = hoaYr / 12;
    return { total: pi + tax + ins + hoa, pi, tax, ins, hoa, down, L, O };
  }
  // Owner check: the owner's name and the rating weights are guarded by an owner PIN.
  // The PIN's PBKDF2 hash lives inside the encrypted shared file; a verified device keeps the hash locally.
  const ownerName = () => S.shared?.owner?.name || null;
  const isOwner = () => !!S.shared?.owner && S.user === S.shared.owner.name && LS.get('hh-owner') === S.shared.owner.hash;
  async function pinHash(pin, owner) {
    const base = await crypto.subtle.importKey('raw', te.encode(pin.trim().toLowerCase()), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(owner.salt), iterations: owner.iter }, base, 256);
    return b64(new Uint8Array(bits));
  }

  // ---------- crypto (same format as scripts/crypto.mjs) ----------
  const te = new TextEncoder(), td = new TextDecoder();
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
  async function deriveKey(pass, meta) {
    const base = await crypto.subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(meta.salt), iterations: meta.iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function decryptBox(box) { return JSON.parse(td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, S.key, unb64(box.ct)))); }
  async function encryptObj(obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, S.key, te.encode(JSON.stringify(obj))));
    return { v: 1, iv: b64(iv), ct: b64(ct) };
  }

  // ---------- GitHub ----------
  function detectRepo() {
    const q = new URLSearchParams(location.search).get('repo') || LS.get('hh-repo');
    if (q && /^[\w.-]+\/[\w.-]+$/.test(q)) { const [owner, name] = q.split('/'); return { owner, name }; }
    if (location.hostname.endsWith('.github.io')) {
      const owner = location.hostname.split('.')[0];
      const first = location.pathname.split('/').filter(Boolean)[0];
      return { owner, name: first && !/\.html?$/.test(first) ? first : `${owner}.github.io` };
    }
    return null;
  }
  async function gh(path, opts = {}, token = S.token) {
    const r = await fetch('https://api.github.com' + path, {
      ...opts, cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
    });
    if (!r.ok) { const e = new Error(`GitHub ${r.status}`); e.status = r.status; try { e.body = await r.json(); } catch { } throw e; }
    return r.json();
  }
  const repoPath = (file) => `/repos/${S.repo.owner}/${S.repo.name}/contents/docs/data/${file}`;
  async function readFile(file) {
    // Fresh copy through the API when we can write; otherwise the Pages copy (may lag ~10 min).
    if (S.token && S.repo) {
      try {
        const j = await gh(repoPath(file) + `?ref=main`);
        return { box: JSON.parse(td.decode(unb64(j.content.replace(/\n/g, '')))), sha: j.sha };
      } catch (e) { if (e.status === 404) return { box: null, sha: null }; throw e; }
    }
    const r = await fetch(`data/${file}?t=${Date.now()}`, { cache: 'no-store' });
    if (r.status === 404) return { box: null, sha: null };
    if (!r.ok) throw new Error(`load ${file}: HTTP ${r.status}`);
    return { box: await r.json(), sha: null };
  }
  async function writeFile(file, box, sha, message, token = S.token) {
    const body = { message, branch: 'main', content: b64(te.encode(JSON.stringify(box, null, 1) + '\n')) };
    if (sha) body.sha = sha;
    return gh(repoPath(file), { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }, token);
  }
  async function updateShared(mutate, message) {
    if (!S.token) throw new Error('Saving is off. Add a write token in Settings.');
    for (let attempt = 0; attempt < 4; attempt++) {
      const { box, sha } = await readFile('shared.enc.json');
      const data = box ? await decryptBox(box) : defaultShared();
      mutate(data);
      try {
        const res = await writeFile('shared.enc.json', await encryptObj(data), sha, `${message} (by ${S.user || 'someone'})`);
        S.shared = data; S.sharedSha = res.content.sha; render(); return;
      } catch (e) { if (e.status === 409 || e.status === 422) continue; throw e; }
    }
    throw new Error('Someone else was saving at the same time. Try again.');
  }

  // ---------- loading ----------
  async function loadAll() {
    const lst = await readFile('listings.enc.json');
    if (!lst.box) throw new Error('No listings file yet.');
    S.data = await decryptBox(lst.box);
    const sh = await readFile('shared.enc.json');
    S.shared = sh.box ? await decryptBox(sh.box) : defaultShared();
    S.sharedSha = sh.sha;
    S.shared.weights = { ...DEFAULT_WEIGHTS, ...(S.shared.weights || {}) };
  }
  async function loadToken() {
    S.token = null;
    try {
      const r = await fetch(`data/token.enc.json?t=${Date.now()}`, { cache: 'no-store' });
      if (r.ok) S.token = (await decryptBox(await r.json())).token || null;
    } catch { S.token = null; }
  }
  async function unlock(pass) {
    S.meta ||= await (await fetch(`data/meta.json?t=${Date.now()}`, { cache: 'no-store' })).json();
    S.key = await deriveKey(pass, S.meta);
    const lst = await readFile('listings.enc.json'); // through Pages first: proves the passphrase
    try { S.data = await decryptBox(lst.box); } catch { throw new Error('That passphrase did not work.'); }
    LS.set('hh-pass', pass);
    await loadToken();
    await loadAll();
  }

  // ---------- scoring ----------
  const psfOf = (l) => { const f = parseFloat(l.detail?.fields?.['PSF Finished']); return Number.isFinite(f) && f > 0 ? f : (l.price && l.sqftFin ? l.price / l.sqftFin : null); };
  const yearOf = (l) => l.yearBuilt || parseInt(l.detail?.fields?.['Year Built'], 10) || null;
  const ageNewer = () => (S.shared?.prefs?.ageDir || 'newer') !== 'older';
  const sizeOf = (l) => l.sqftFin || parseFloat(String(l.detail?.fields?.['Living Area (SqFt Fin)'] || '').replace(/,/g, '')) || null;
  const taxOf = (l) => l.tax || parseFloat(String(l.detail?.fields?.['Tax Annual Amount'] || '').replace(/[$,]/g, '')) || null;
  function ranges(list) {
    const r = {};
    for (const [k, f] of [['psf', psfOf], ['size', sizeOf], ['tax', taxOf], ['year', yearOf]]) {
      const vals = list.map(f).filter((x) => x != null);
      r[k] = vals.length ? [Math.min(...vals), Math.max(...vals)] : [0, 0];
    }
    return r;
  }
  const rel = (x, [lo, hi], higherBetter) => x == null ? 0.5 : hi === lo ? 0.5 : Math.max(0, Math.min(1, higherBetter ? (x - lo) / (hi - lo) : (hi - x) / (hi - lo)));
  function evaluate(l, rg) {
    const man = S.shared?.ratings?.[l.id] || {};
    const h = l.detail?.hints || {};
    const rvRows = (l.detail?.parking || []).filter((p) => /Recreational/i.test(p.type));
    const cooling = l.detail?.fields?.Cooling || '';
    const out = {};
    const put = (k, autoV, ev) => {
      const it = ITEMS.find((i) => i.k === k);
      const m = man[k];
      let v = m?.v || autoV;
      if (k === 'multigen') v = { yes: 'multigen', maybe: 'multigen' }[v] || v; // older picks before rental/multigen split
      out[k] = { v, manual: !!m, by: m?.by, why: m?.why, ev, s: it.score[v] ?? 0, label: it.opts[v] || v };
    };
    put('rv', rvRows.length ? 'likely' : 'unknown', rvRows.length ? 'Listing: ' + rvRows.map((p) => p.desc || `${p.spaces} RV space`).join('; ') : (h.rv ? 'Description: ' + h.rv : 'No RV parking in the listing'));
    put('kitchen', h.openKitchen ? 'likely' : 'unknown', h.openKitchen ? 'Description: ' + h.openKitchen : 'Check the photos');
    const lv = l.levels || l.detail?.fields?.Levels || '';
    put('layout', /bi-?level/i.test(lv) ? 'bilevel' : /split|tri|multi|quad/i.test(lv) ? 'split' : 'good', lv ? `Listing: ${lv}` : 'Levels not listed');
    const pl = h.primaryLevel || '';
    put('primary', /^main/i.test(pl) || /^one$/i.test(lv) ? 'main' : pl ? 'other' : 'unknown',
      pl ? `Primary bedroom: ${pl}` : /^one$/i.test(lv) ? 'One-level home' : 'Not in the room list');
    put('ac', /central/i.test(cooling) ? 'yes' : /evap|swamp|window|ductless|mini/i.test(cooling) ? 'partial' : cooling && !/none/i.test(cooling) ? 'partial' : 'no', cooling ? 'Cooling: ' + cooling : 'No cooling listed');
    put('multigen', h.rental ? 'rental' : h.multigen ? 'multigen' : 'unknown',
      h.rental ? 'Description: ' + h.rental : h.multigen ? 'Description: ' + h.multigen : 'Nothing in the description');
    const pool = h.pool || [];
    put('pool', pool.some((p) => /pool/.test(p)) ? 'pool' : pool.length ? 'hottub' : 'none', pool.join(', '));
    const od = h.outdoor || [];
    put('outdoor', od.length >= 3 ? 'great' : od.length ? 'some' : 'none', od.join(', '));
    const up = h.upgrades || [];
    put('upgrades', up.length >= 3 ? 'major' : up.length ? 'some' : 'none', up.join(', '));
    const psf = psfOf(l), size = sizeOf(l), tax = taxOf(l);
    out.size = { s: rel(size, rg.size, true), label: size ? `${Math.round(size).toLocaleString()} sqft` : '—', ev: `Your list runs ${Math.round(rg.size[0]).toLocaleString()}–${Math.round(rg.size[1]).toLocaleString()} finished sqft` };
    out.psf = { s: rel(psf, rg.psf, false), label: psf ? `$${Math.round(psf)}/sqft` : '—', ev: `Your list runs $${Math.round(rg.psf[0])}–$${Math.round(rg.psf[1])} per finished sqft` };
    out.tax = { s: rel(tax, rg.tax, false), label: tax ? `${money(tax)}/yr` : '—', ev: `Your list runs ${money(rg.tax[0])}–${money(rg.tax[1])} a year` };
    const yr = yearOf(l);
    out.age = { s: rel(yr, rg.year, ageNewer()), label: yr ? `Built ${yr}` : '—', ev: `Your list runs ${rg.year[0]}–${rg.year[1]} · ${ageNewer() ? 'newer' : 'older'} scores higher` };
    const w = S.shared?.weights || DEFAULT_WEIGHTS;
    let tot = 0, wsum = 0;
    for (const it of ITEMS) { const wt = +w[it.k] || 0; tot += wt * out[it.k].s; wsum += wt; out[it.k].pts = wt * out[it.k].s; out[it.k].w = wt; }
    return { items: out, total: wsum ? Math.round((tot / wsum) * 100) : 0 };
  }

  // ---------- rendering ----------
  const inTab = (l) => S.tab === 'all' ? true : l.bucket === S.tab;
  const showable = (l) => l.bucket !== 'dislike' && (S.showOff || (ACTIVE.test(l.status || '') && !l.offPortal));
  function matches(l) {
    if (!S.q) return true;
    const notes = [...(l.portalNotes || []), ...((S.shared?.notes || []).filter((n) => n.lid === l.id))].map((n) => n.text).join(' ');
    return `${l.address} ${l.city} ${l.id} ${notes}`.toLowerCase().includes(S.q.toLowerCase());
  }
  const isNew = (l) => S.prevVisit && l.firstSeen > S.prevVisit;
  // ---------- pending / sold ----------
  const usDate = (s) => { const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/); if (!m) return null; const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return new Date(y, m[1] - 1, +m[2]); };
  const dayDiff = (a, b) => (a && b ? Math.round((b - a) / 864e5) : null);
  const num$ = (s) => { const n = parseFloat(String(s ?? '').replace(/[$,]/g, '')); return Number.isFinite(n) ? n : null; };
  function sale(l) {
    const f = l.detail?.fields || {};
    const st = l.status || '';
    const listed = usDate(f['Listing Contract Date:']) || usDate(l.listDate);
    const listPrice = num$(f['List Price:']);
    const orig = origOf(l);
    const conc = S.shared?.sales?.[l.id] || null;
    if (/closed|sold/i.test(st)) {
      const closed = usDate(l.closeDate || f['Close Date:']);
      const ref = listPrice || orig;
      return { kind: 'sold', sold: l.price, listPrice: ref, orig, closed, dom: dayDiff(listed, closed), pct: l.price && ref ? ((l.price - ref) / ref) * 100 : null, conc };
    }
    if (/pending|under contract/i.test(st)) {
      const contract = usDate(l.contractDate || f['Purchase Contract Date:']);
      return { kind: 'pending', listPrice: listPrice || l.price, orig, contract, dtc: dayDiff(listed, contract), conc };
    }
    return null;
  }
  function saleBlock(l, canEdit) {
    const s = sale(l); if (!s) return '';
    const d = (x) => (x ? x.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '?');
    const c = s.conc?.amount;
    const was = s.orig && s.listPrice && s.orig !== s.listPrice ? `, originally ${money(s.orig)}` : '';
    let main;
    if (s.kind === 'sold') {
      const pct = s.pct == null ? '' : ` (${s.pct >= 0 ? '+' : ''}${s.pct.toFixed(1)}% vs list)`;
      main = `<b>Sold ${money(s.sold)}</b> on ${d(s.closed)}${pct}<br>Listed ${money(s.listPrice)}${was}${s.dom != null ? ` · ${s.dom} days from listing to close` : ''}`;
      if (c != null) main += `<br><b>Net ${money(s.sold - c)}</b> after ${money(c)} seller concessions`;
    } else {
      main = `<b>Under contract</b> ${d(s.contract)}${s.dtc != null ? ` after ${s.dtc} days` : ''}<br>Listed ${money(s.listPrice)}${was} · the sold price appears here when it closes`;
      if (c != null) main += `<br>${money(c)} seller concessions`;
    }
    const by = s.conc ? ` <span class="muted small">Concessions entered by ${esc(s.conc.by)}.</span>` : '';
    return `<div class="sale ${s.kind}">${main}${by}
      <form class="conc" data-conc="${esc(l.id)}"><label>Concessions $<input inputmode="numeric" value="${c ?? ''}" placeholder="amount" ${canEdit ? '' : 'disabled'}></label><button class="btn" ${canEdit ? '' : 'disabled'}>Save</button></form></div>`;
  }

  // ---------- market check (from the houses on your own list) ----------
  const median = (a) => { const v = a.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
  // Price per TOTAL sqft: fairer across houses with unfinished basements than finished-only.
  const psfTotalOf = (l) => (l.price && l.sqftTotal ? l.price / l.sqftTotal : null);
  function origOf(l) { const f = l.detail?.fields || {}; return l.originalPrice || num$(f['Original List Price:']) || num$(f['Original List Price']) || null; }
  function listedOf(l) { const f = l.detail?.fields || {}; return usDate(f['Listing Contract Date:']) || usDate(l.listDate); }
  function cutOf(l) {
    const o = origOf(l), p = l.price;
    let from = o && p && o > p ? o : null;
    if (!from) { const d = (l.history || []).find((h) => h.what === 'price' && h.to < h.from); if (d && p < d.from) from = d.from; }
    return from ? { pct: (from - p) / from, from } : { pct: 0, from: null };
  }
  function market(all) {
    const sold = [], pend = [], act = [];
    for (const l of all) {
      const s = sale(l);
      if (s?.kind === 'sold') sold.push({ l, s });
      else if (s?.kind === 'pending') pend.push({ l, s });
      else if (ACTIVE.test(l.status || '') && !l.offPortal) act.push(l);
    }
    const ratio = median(sold.map(({ s }) => (s.listPrice ? (s.sold - (s.conc?.amount || 0)) / s.listPrice : null)));
    const dtc = median(pend.map(({ s }) => s.dtc));
    let lean = 'Balanced';
    if (ratio != null && dtc != null) {
      if (ratio >= 0.995 && dtc <= 21) lean = 'Leans to sellers';
      else if (ratio < 0.975 || dtc > 45) lean = 'Leans to buyers';
    }
    return {
      sold: sold.length, pend: pend.length, act: act.length, ratio, dtc, lean,
      withConc: sold.filter(({ s }) => s.conc?.amount != null).length,
      dToClose: median(sold.map(({ s }) => s.dom)),
      soldPsf: median(sold.map(({ l }) => psfTotalOf(l))),
      cuts: act.filter((l) => cutOf(l).pct > 0).length,
      enough: sold.length + pend.length >= 6,
    };
  }
  // How much room there may be to offer under list on an active house. Informational; not part of the rating.
  function room(l, mk) {
    if (!mk || !ACTIVE.test(l.status || '') || l.offPortal) return null;
    const listed = listedOf(l);
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const dom = listed ? Math.max(0, Math.round((t - listed) / 864e5)) : null;
    const why = []; let pts = 0, psfPts = 0;
    const dd =(n) => `${n} day${n === 1 ? '' : 's'}`;
    if (dom != null && mk.dtc) {
      const med = Math.round(mk.dtc);
      if (dom > 3 * mk.dtc) { pts += 2; why.push(`${dd(dom)} on market, about ${Math.round(dom / mk.dtc)}× the ${med}-day median`); }
      else if (dom > 1.5 * mk.dtc) { pts += 1; why.push(`${dd(dom)} on market vs a ${med}-day median`); }
      else why.push(`${dd(dom)} on market, still fresh (median ${med})`);
    }
    const cut = cutOf(l);
    if (cut.pct >= 0.05) { pts += 2; why.push(`cut ${(cut.pct * 100).toFixed(1)}% from ${money(cut.from)}`); }
    else if (cut.pct >= 0.01) { pts += 1; why.push(`cut ${(cut.pct * 100).toFixed(1)}% from ${money(cut.from)}`); }
    const psf = psfTotalOf(l);
    if (psf && mk.soldPsf) {
      const d = psf / mk.soldPsf - 1;
      if (d > 0.15) { pts += 1; psfPts = 1; why.push(`$/total sqft ${Math.round(d * 100)}% above recent sales`); }
      else if (d < -0.15) { pts -= 1; psfPts = -1; why.push(`$/total sqft ${Math.round(-d * 100)}% below recent sales`); }
    }
    // Time on market or a real price cut is needed for Medium; a high $/sqft alone on a fresh listing stays Low.
    const timePts = pts - psfPts;
    return { level: pts >= 3 ? 'High' : timePts >= 1 ? 'Medium' : 'Low', pts, why };
  }
  function marketPanel(mk) {
    const pct = (r) => (r == null ? '—' : `${r >= 1 ? '+' : ''}${((r - 1) * 100).toFixed(1)}%`);
    const tile = (label, val, sub) => `<div class="tile"><div class="tl">${esc(label)}</div><div class="tv">${esc(val)}</div>${sub ? `<div class="ts">${esc(sub)}</div>` : ''}</div>`;
    return `<details class="market" ${LS.get('hh-mkt') === '0' ? '' : 'open'}>
      <summary><b>Market check:</b> ${esc(mk.lean)} <span class="muted small">· from ${mk.sold} sold and ${mk.pend} pending on your list</span></summary>
      <div class="tiles">
        ${tile('Sold vs list (median)', pct(mk.ratio), mk.sold ? (mk.withConc ? `net of concessions on ${mk.withConc} of ${mk.sold}` : 'no concessions entered yet') : 'no sales yet')}
        ${tile('Days to contract (median)', mk.dtc == null ? '—' : String(Math.round(mk.dtc)), `${mk.pend} pending`)}
        ${tile('Listing to close (median)', mk.dToClose == null ? '—' : `${Math.round(mk.dToClose)} days`, `${mk.sold} sold`)}
        ${tile('Active with price cuts', `${mk.cuts} of ${mk.act}`, '')}
        ${tile('Sold $/sqft (median)', mk.soldPsf ? `$${Math.round(mk.soldPsf)}` : '—', 'per total sqft')}
        ${(() => { const R = ratesNow(); const ch = R.r30 != null && R.r30Prev != null ? R.r30 - R.r30Prev : null;
          return tile('30-yr rate (Freddie Mac)', R.r30 != null ? `${R.r30}%` : '—', `${ch == null ? '' : (ch > 0 ? '▲ ' : ch < 0 ? '▼ ' : '') + Math.abs(ch).toFixed(2) + ' this week · '}15-yr ${R.r15 ?? '—'}% · ${R.date}`); })()}
      </div>
      <p class="muted small">Only the houses Brooke sent you, not the whole MLS${mk.enough ? '' : ', so treat it as a rough read'}. Concessions entered on sold houses make "sold vs list" truer. "Leans to sellers" means the median sale was at list or above and contracts came within 3 weeks; "Leans to buyers" means 2.5%+ under list or 45+ days to contract.</p>
    </details>`;
  }

  function priceDrop(l) {
    if (/closed|sold/i.test(l.status || '')) return 0;
    const ev =(l.history || []).filter((h) => h.what === 'price' && h.to < h.from).pop();
    return ev && Date.now() - Date.parse(ev.at) < 21 * 864e5 ? ev.from - ev.to : 0;
  }
  const scoreColor = (n) => `hsl(${Math.round(Math.max(0, Math.min(100, n)) * 1.2)} 55% 38%)`;
  const ago = (iso) => {
    if (!iso) return '';
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (m < 1) return 'just now'; if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60); if (h < 36) return `${h} hr ago`;
    return new Date(iso).toLocaleDateString();
  };
  const when = (iso) => { const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + (Date.now() - d < 864e5 ? ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''); };

  function highlights(l) {
    const f = l.detail?.fields || {};
    const chips = [];
    const add = (t, cls = '') => t && chips.push(`<span class="chip ${cls}">${esc(t)}</span>`);
    add(l.levels ? `${l.levels} level` : f.Levels ? `${f.Levels} level` : '');
    add(l.yearBuilt ? `Built ${l.yearBuilt}` : '');
    add(l.lotAcres ? `${l.lotAcres} ac lot` : '');
    add(l.garageSpaces ? `${l.garageSpaces}-car garage` : '');
    add(f.Basement ? `Basement: ${f.Basement}` : '');
    add(/^no$/i.test(l.hoa || '') ? 'No HOA' : l.hoa ? `HOA ${l.hoa}` : '');
    for (const u of (l.detail?.hints?.upgrades || []).slice(0, 4)) add(u, 'good');
    for (const p of (l.detail?.hints?.pool || []).slice(0, 2)) add(p, 'good');
    for (const o of (l.detail?.hints?.outdoor || []).slice(0, 3)) add(o);
    add(f['High School'] ? `HS: ${f['High School']}` : '');
    return chips.join('');
  }

  function howScoring() {
    const w = S.shared?.weights || DEFAULT_WEIGHTS;
    const tot = ITEMS.reduce((a, it) => a + Math.max(0, +w[it.k] || 0), 0) || 1;
    const rows = byWeight().map((it) => `<tr><td>${esc(it.label)}</td><td>${+w[it.k] || 0}</td><td>${(((+w[it.k] || 0) / tot) * 100).toFixed(0)}%</td></tr>`).join('');
    return `<div class="how"><h4>How scoring works</h4>
      <ul>
        <li>Each item earns part of its points. The rating is the total, scaled to 100.</li>
        <li>"Auto" items are read from the listing. Picking a value in the menu overrides it for everyone, and shows who set it.</li>
        <li>Size, $/sqft, taxes and year built are scored against the rest of your list: the best house on the list gets full points.</li>
        <li>Houses under ${LOW_SCORE} are hidden unless they're Favorites. Only ${esc(ownerName() || 'the owner')} can change the weights.</li>
      </ul>
      <table class="how-w"><thead><tr><th>Item</th><th>Points</th><th>Share</th></tr></thead><tbody>${rows}</tbody></table>
    </div>`;
  }

  function rateRows(l, ev, canEdit) {
    return byWeight().map((it) => {
      const r = ev.items[it.k];
      const sel = it.opts ? `<select data-rate="${it.k}" data-lid="${esc(l.id)}" ${canEdit ? '' : 'disabled title="Saving is off"'}>
          <option value="">Auto (${esc(r.manual ? '' : r.label)})</option>
          ${Object.entries(it.opts).map(([v, t]) => `<option value="${v}" ${r.manual && r.v === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}
        </select>` : `<span class="small">${esc(r.label)}</span>`;
      const evid = [r.manual ? `Set by ${r.by || '?'}${r.why ? ': ' + r.why : ''}` : '', r.ev].filter(Boolean).join(' · ');
      return `<span class="lbl">${esc(it.label)}</span>${sel}<span class="pts">${r.pts.toFixed(1)}/${r.w}</span>${evid ? `<span class="ev">${esc(evid)}</span>` : ''}`;
    }).join('');
  }

  function card(l, rg) {
    const ev = evaluate(l, rg);
    const canEdit = !!S.token && !!S.user;
    const addr = `${l.address}, ${l.city || ''}`;
    const { waze, gmap } = mapLinks(l);
    const nPhotos = l.photos?.length || l.detail?.photoCount || 0;
    const bucket = { fav: ['Favorite', 'fav'], poss: ['Possibility', ''], none: ['New from agent', 'new'] }[l.bucket] || ['', ''];
    const drop = priceDrop(l);
    const off = !ACTIVE.test(l.status || '') || l.offPortal;
    const rv = ev.items.rv;
    const rvCls = { fits: 'good', likely: 'warn', tight: 'warn', no: 'bad' }[rv.v] || '';
    const sharedNotes = (S.shared?.notes || []).filter((n) => n.lid === l.id).sort((a, b) => a.at.localeCompare(b.at));
    const portalNotes = l.portalNotes || [];
    return `<article class="card ${off ? 'dim' : ''} ${ev.total < LOW_SCORE && l.bucket !== 'fav' ? 'low' : ''}" data-id="${esc(l.id)}">
      <div class="photo">
        ${l.photo || l.photoThumb ? `<button class="ph-open" type="button" data-gal="${esc(l.id)}" aria-label="See all ${nPhotos} photos"><img loading="lazy" referrerpolicy="no-referrer" src="${esc(l.photo || l.photoThumb)}" data-thumb="${esc(l.photoThumb || '')}" alt="">${nPhotos > 1 ? `<span class="ph-count">${nPhotos} photos</span>` : ''}</button>` : ''}
        <div class="badges">
          ${bucket[0] ? `<span class="badge ${bucket[1]}">${bucket[0]}</span>` : ''}
          ${isNew(l) ? '<span class="badge new">New since your last visit</span>' : ''}
          ${drop ? `<span class="badge drop">Price ↓ ${money(drop)}</span>` : ''}
          ${off ? `<span class="badge off">${esc(l.offPortal ? 'Off portal' : /closed/i.test(l.status || '') ? 'Sold' : l.status)}</span>` : ''}
        </div>
        <button class="score" type="button" data-open-rating="${esc(l.id)}" style="background:${scoreColor(ev.total)}" title="Rating out of 100. Tap for the breakdown.">${ev.total}<small>/100</small></button>
      </div>
      <div class="body">
        <div class="price-row"><span class="price">${money(l.price)}</span><span class="psf">${ev.items.psf.label} · ${ev.items.size.label} fin</span></div>
        ${(() => {
          if (/closed|sold/i.test(l.status || '')) return '';
          const p = payment(l); if (!p) return '';
          return `<div class="pay"><span>≈ <b>${money(p.total)}/mo</b> · <b>${money(p.down)}</b> down (${p.L.downPct}%)</span>
            <span class="muted">P&amp;I ${money(p.pi)} at ${p.O.rate}% ${p.O.term}-yr · tax ${money(p.tax)} · insurance ~${money(p.ins)}${p.hoa ? ` · HOA ${money(p.hoa)}` : ''}</span></div>`;
        })()}
        ${saleBlock(l, canEdit)}
        ${(() => { const r = room(l, S.mk); return r ? `<div class="room room-${r.level.toLowerCase()}" title="How much room there may be to offer under list. Not part of the rating."><b>Negotiating room: ${r.level}</b>${r.why.length ? ' · ' + esc(r.why.join(' · ')) : ''}</div>` : ''; })()}
        <div class="addr"><a href="${waze}" target="_blank" rel="noopener" title="Open in Waze">${esc(l.address)}</a><div class="facts">${esc(l.city || '')}</div></div>
        <div class="facts">${l.beds ?? '?'} bd · ${l.baths ?? '?'} ba · ${l.sqftTotal ? l.sqftTotal.toLocaleString() + ' total sqft' : ''} · Taxes ${money(taxOf(l))}${l.detail?.fields?.Cooling ? ' · ' + esc(l.detail.fields.Cooling) : ''}</div>
        <div class="chips"><span class="chip ${rvCls}">RV: ${esc(rv.label)}</span>${highlights(l)}</div>
        ${rv.why || rv.ev ? `<div class="facts">${esc(rv.why ? rv.why : rv.ev)}</div>` : ''}
        <details ${S.openRatings.has(l.id) ? 'open' : ''} data-rating="${esc(l.id)}"><summary>Rating breakdown</summary><div class="rate">${rateRows(l, ev, canEdit)}</div>${howScoring()}</details>
        <div class="notes">
          ${portalNotes.map((n) => `<div class="note portal"><div class="meta"><span>Portal note${n.date ? ' · ' + esc(n.date) : ''}</span></div>${esc(n.text)}</div>`).join('')}
          ${sharedNotes.map((n) => `<div class="note"><div class="meta"><span>${esc(n.by)} · ${esc(when(n.at))}</span>${n.by === S.user && canEdit ? `<button class="btn link" data-del-note="${esc(n.id)}">Delete</button>` : ''}</div>${esc(n.text)}</div>`).join('')}
          <form class="add-note" data-note="${esc(l.id)}">
            <textarea maxlength="1000" placeholder="${canEdit ? 'Add a note' : 'Saving is off'}" ${canEdit ? '' : 'disabled'}></textarea>
            <button class="btn" ${canEdit ? '' : 'disabled'}>Add</button>
          </form>
        </div>
        ${(l.tours || []).length ? `<div class="links tours">${tourLinks(l)}</div>` : ''}
        <div class="links">${nPhotos ? `<button class="btn link" type="button" data-gal="${esc(l.id)}">Photos (${nPhotos})</button>` : ''}<a href="${waze}" target="_blank" rel="noopener">Waze</a><a href="${gmap}" target="_blank" rel="noopener">Google Maps</a>${satLink(l)}${S.data.portalUrl ? `<a href="${esc(S.data.portalUrl)}" target="_blank" rel="noopener">Portal</a>` : ''}<span class="muted">#${esc(l.id)}</span></div>
      </div>
    </article>`;
  }

  // ---------- maps, tours, photos ----------
  function mapLinks(l) {
    const addr = `${l.address}, ${l.city || ''}`;
    const g = l.geo;
    return {
      waze: g ? `https://waze.com/ul?ll=${g.lat},${g.lng}&navigate=yes` : `https://waze.com/ul?q=${encodeURIComponent(addr)}&navigate=yes`,
      gmap: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`,
    };
  }
  const satLink = (l) => (l.geo ? `<a href="https://www.google.com/maps/@${l.geo.lat},${l.geo.lng},70m/data=!3m1!1e3" target="_blank" rel="noopener" title="Satellite view, handy for checking RV access">Satellite</a>` : '');
  const tourLinks = (l) => (l.tours || []).map((t) => `<a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.kind)}</a>`).join('');
  function openGallery(id) {
    const l = (S.data.listings || []).find((x) => x.id === id); if (!l) return;
    const ph = (l.photos?.length ? l.photos : [l.photo || l.photoThumb]).filter(Boolean);
    S.gal = { l, ph, i: 0 };
    drawGal(); $('#galDlg').showModal();
  }
  function drawGal(step = 0) {
    const g = S.gal; if (!g) return;
    g.i = (g.i + step + g.ph.length) % g.ph.length;
    $('#galImg').src = g.ph[g.i];
    $('#galCount').textContent = `${g.i + 1} / ${g.ph.length}`;
    $('#galTitle').textContent = `${g.l.address}, ${g.l.city || ''}`;
    $('#galLinks').innerHTML = tourLinks(g.l) + satLink(g.l);
    const nx = new Image(); nx.referrerPolicy = 'no-referrer'; nx.src = g.ph[(g.i + 1) % g.ph.length]; // preload next
  }

  const LOW_SCORE = 50;
  function render() {
    if (!S.data) return;
    const all = (S.data.listings || []).filter((l) => l.bucket !== 'dislike');
    const rg = ranges(all.filter((l) => !l.offPortal));
    S.mk = market(all);
    $('#market').innerHTML = marketPanel(S.mk);
    const scored = all.filter(showable).filter(matches).map((l) => ({ l, total: evaluate(l, rg).total }));
    // Favorites always show, whatever they score (Jeremy's rule).
    const isLow = (x) => x.total < LOW_SCORE && x.l.bucket !== 'fav';
    const lowHere = scored.filter((x) => isLow(x) && inTab(x.l)).length;
    const base = scored.filter((x) => S.showLow || !isLow(x)).map((x) => x.l);
    const lowNote = $('#lowNote');
    lowNote.hidden = !lowHere;
    lowNote.innerHTML = S.showLow
      ? `Showing ${lowHere} house${lowHere === 1 ? '' : 's'} rated under ${LOW_SCORE} (faded). <button class="btn link" type="button" id="lowToggle">Hide them</button>`
      : `${lowHere} house${lowHere === 1 ? '' : 's'} rated under ${LOW_SCORE} hidden. <button class="btn link" type="button" id="lowToggle">Show them</button>`;
    for (const t of $$('.tab')) {
      const tab = t.dataset.tab;
      t.setAttribute('aria-selected', String(tab === S.tab));
      $('.count', t).textContent = base.filter((l) => tab === 'all' || l.bucket === tab).length;
    }
    const list = base.filter(inTab).map((l) => ({ l, ev: null }));
    const key = {
      score: (x) => -evaluate(x.l, rg).total, price: (x) => x.l.price ?? 1e12, psf: (x) => psfOf(x.l) ?? 1e9,
      size: (x) => -(sizeOf(x.l) || 0), tax: (x) => taxOf(x.l) ?? 1e9, newest: (x) => -Date.parse(x.l.firstSeen || 0),
      payment: (x) => payment(x.l)?.total ?? 1e9,
      room: (x) => -(room(x.l, S.mk)?.pts ?? -99),
    }[S.sort] || ((x) => 0);
    list.sort((a, b) => key(a) - key(b));
    $('#cards').innerHTML = list.map((x) => card(x.l, rg)).join('');
    $('#empty').hidden = list.length > 0;
    $('#search').value = S.q;
    $('#showOff').checked = S.showOff;
    $('#sort').value = S.sort;
    const lo = loanOptions(), lc = loanChoice();
    $('#loanOpt').innerHTML = lo.map((o) => `<option value="${o.k}" ${o === lc ? 'selected' : ''} ${o.note ? `title="${esc(o.note)}"` : ''}>${esc(o.label)}</option>`).join('');
    $('#clearFilters').hidden = !(S.q || !S.showOff);
    $('#whoBtn').textContent = S.user || 'Pick your name';
    $('#updated').textContent = `Listings changed ${ago(S.data.updatedAt)} · checked every 10 min`;
    const banner = $('#banner');
    if (!S.token) { banner.hidden = false; banner.textContent = 'Read-only: ratings and notes can be saved once a write token is added in Settings.'; }
    else banner.hidden = true;
    for (const img of $$('#cards img')) img.addEventListener('error', () => { if (img.dataset.thumb && img.src !== img.dataset.thumb) img.src = img.dataset.thumb; else img.remove(); }, { once: true });
  }

  // ---------- dialogs ----------
  function showWho() {
    const users = S.shared?.users || [];
    $('#whoList').innerHTML = users.map((u) => `<button class="btn ${u === S.user ? 'primary' : ''}" value="${esc(u)}">${esc(u)}</button>`).join('')
      + (users.length ? '' : '<p class="muted small">No names yet. Add one in Settings.</p>');
    $('#whoDlg').showModal();
  }
  function settingsMsg(t, cls = '') { const m = $('#setMsg'); m.textContent = t; m.className = 'msg ' + cls; }
  function renderSettings() {
    const users = S.shared?.users || [];
    $('#userList').innerHTML = users.map((u) => u === ownerName()
      ? `<li>${esc(u)} <span class="muted small">(owner)</span>&nbsp;</li>`
      : `<li>${esc(u)} <button class="btn link" data-rm-user="${esc(u)}" ${S.token ? '' : 'disabled'} title="Remove">✕</button></li>`).join('');
    const w = S.shared?.weights || DEFAULT_WEIGHTS;
    const own = isOwner();
    $('#weights').innerHTML = byWeight().map((it) => `<label for="w-${it.k}">${esc(it.label)}</label><input id="w-${it.k}" type="number" min="0" max="100" step="1" value="${+w[it.k] || 0}" data-w="${it.k}" ${own ? '' : 'disabled'}><span class="pct" data-pct="${it.k}"></span>`).join('');
    $('#ageDir').value = ageNewer() ? 'newer' : 'older';
    $('#ageDir').disabled = !own;
    updateWTotal();
    $('#wOwner').textContent = own ? '' : `Only ${ownerName() || 'the owner'} can change the rating system.`;
    $('#tokenState').textContent = S.token ? 'Saving is on. A write token is stored (encrypted).' : 'Saving is off. Paste a write token to turn it on.';
    $('#saveWeights').disabled = !S.token || !own;
    $('#resetWeights').disabled = !own;
    const L = loan();
    for (const [id, v] of [['loanRate', L.customRate ?? ''], ['loanTerm', L.customTerm || 30], ['loanDown', L.downPct], ['loanIns', L.insYear]]) { $('#' + id).value = v; $('#' + id).disabled = !own; }
    const R = ratesNow();
    $('#loanNote').textContent = `Freddie Mac week of ${R.date}: 30-yr ${R.r30}%, 15-yr ${R.r15}% (updates on its own).${L.customRate ? ` Your quote ${L.customNote ? '(' + L.customNote + ')' : ''} is the default loan.` : ''}`;
    $('#saveLoan').disabled = !S.token || !own;
    $('#tokenForm').hidden = !!S.token && !own;
  }
  function updateWTotal() {
    const ins = $$('#weights input');
    const t = ins.reduce((a, i) => a + Math.max(0, +i.value || 0), 0);
    for (const i of ins) {
      const p = t ? (Math.max(0, +i.value || 0) / t) * 100 : 0;
      $(`[data-pct="${i.dataset.w}"]`).textContent = `${p >= 10 || p === 0 ? Math.round(p) : p.toFixed(1)}%`;
    }
    $('#wTotal').textContent = `Total ${t} points, shown as each item's share of the score`;
  }

  // ---------- events ----------
  function wire() {
    $('#lockForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('#lockMsg'); msg.className = 'msg'; msg.textContent = 'Unlocking…';
      try { await unlock(cleanSecret($('#pass').value, 'passphrase')); start(); }
      catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
    });
    for (const t of $$('.tab')) t.addEventListener('click', () => { S.tab = t.dataset.tab; LS.set('hh-tab', S.tab); render(); });
    let st; $('#search').addEventListener('input', (e) => { clearTimeout(st); st = setTimeout(() => { S.q = e.target.value.trim(); render(); }, 150); });
    $('#showOff').addEventListener('change', (e) => { S.showOff = e.target.checked; LS.set('hh-hideOff', S.showOff ? '0' : '1'); render(); });
    $('#sort').addEventListener('change', (e) => { S.sort = e.target.value; LS.set('hh-sort', S.sort); render(); });
    $('#lowNote').addEventListener('click', (e) => { if (e.target.id !== 'lowToggle') return; S.showLow = !S.showLow; LS.set('hh-showLow', S.showLow ? '1' : '0'); render(); });
    $('#cards').addEventListener('click', (e) => {
      const b = e.target.closest('[data-gal]'); if (b) { openGallery(b.dataset.gal); return; }
      const s = e.target.closest('[data-open-rating]');
      if (s) {
        const d = $(`details[data-rating="${CSS.escape(s.dataset.openRating)}"]`);
        if (d) { d.open = true; S.openRatings.add(s.dataset.openRating); d.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      }
    });
    $('#galPrev').addEventListener('click', () => drawGal(-1));
    $('#galNext').addEventListener('click', () => drawGal(1));
    $('#galClose').addEventListener('click', () => $('#galDlg').close());
    $('#galDlg').addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') drawGal(-1); if (e.key === 'ArrowRight') drawGal(1); });
    let tx = null;
    $('#galDlg').addEventListener('touchstart', (e) => { tx = e.touches[0].clientX; }, { passive: true });
    $('#galDlg').addEventListener('touchend', (e) => { if (tx == null) return; const dx = e.changedTouches[0].clientX - tx; tx = null; if (Math.abs(dx) > 40) drawGal(dx < 0 ? 1 : -1); });
    $('#galImg').addEventListener('click', (e) => { const r = e.target.getBoundingClientRect(); drawGal(e.clientX - r.left < r.width / 3 ? -1 : 1); });
    $('#market').addEventListener('toggle', (e) => { if (e.target.matches?.('details.market')) LS.set('hh-mkt', e.target.open ? '1' : '0'); }, true);
    $('#clearFilters').addEventListener('click', () => { S.q = ''; S.showOff = true; LS.set('hh-hideOff', '0'); render(); });
    $('#cards').addEventListener('submit', async (e) => {
      const f = e.target.closest('form[data-conc]'); if (!f) return;
      e.preventDefault();
      const raw = $('input', f).value.trim();
      const amount = raw === '' ? null : Math.round(parseFloat(raw.replace(/[$,\s]/g, '')));
      if (raw !== '' && !Number.isFinite(amount)) { alertMsg('Concessions must be a dollar amount, like 10000.'); return; }
      $$('button, input', f).forEach((x) => (x.disabled = true));
      try {
        await updateShared((d) => {
          d.sales ||= {};
          if (amount == null) delete d.sales[f.dataset.conc];
          else d.sales[f.dataset.conc] = { amount, by: S.user, at: new Date().toISOString() };
        }, `Concessions on ${f.dataset.conc}`);
      } catch (err) { alertMsg(err.message); $$('button, input', f).forEach((x) => (x.disabled = false)); }
    });
    $('#whoBtn').addEventListener('click', showWho);
    $('#whoForm').addEventListener('submit', async (e) => {
      const v = e.submitter?.value; if (!v) return;
      if (v === ownerName() && LS.get('hh-owner') !== S.shared.owner.hash) {
        e.preventDefault();
        const pin = cleanSecret(prompt(`Enter ${v}'s owner PIN`), 'ownerPin');
        if (!pin) return;
        if (await pinHash(pin, S.shared.owner) !== S.shared.owner.hash) { alert('That PIN is not right.'); return; }
        LS.set('hh-owner', S.shared.owner.hash);
        $('#whoDlg').close();
      }
      S.user = v; LS.set('hh-user', v); render();
    });
    $('#settingsBtn').addEventListener('click', () => { renderSettings(); settingsMsg(''); $('#setDlg').showModal(); });
    $('#setDlg').addEventListener('click', (e) => { if (e.target.matches('[data-close]')) $('#setDlg').close(); });

    const cards = $('#cards');
    cards.addEventListener('toggle', (e) => { const d = e.target; if (d.dataset?.rating) d.open ? S.openRatings.add(d.dataset.rating) : S.openRatings.delete(d.dataset.rating); }, true);
    cards.addEventListener('change', async (e) => {
      const sel = e.target.closest('select[data-rate]'); if (!sel) return;
      const { rate, lid } = sel.dataset; const v = sel.value;
      sel.disabled = true;
      try {
        await updateShared((d) => {
          d.ratings ||= {}; d.ratings[lid] ||= {};
          if (v) d.ratings[lid][rate] = { v, by: S.user, at: new Date().toISOString() }; else delete d.ratings[lid][rate];
        }, `Rate ${rate}=${v || 'auto'} on ${lid}`);
      } catch (err) { alertMsg(err.message); render(); }
    });
    cards.addEventListener('submit', async (e) => {
      const f = e.target.closest('form[data-note]'); if (!f) return;
      e.preventDefault();
      const ta = $('textarea', f); const text = ta.value.trim(); if (!text) return;
      $$('button, textarea', f).forEach((x) => (x.disabled = true));
      try {
        await updateShared((d) => { d.notes ||= []; d.notes.push({ id: crypto.randomUUID(), lid: f.dataset.note, by: S.user, at: new Date().toISOString(), text }); }, `Note on ${f.dataset.note}`);
      } catch (err) { alertMsg(err.message); $$('button, textarea', f).forEach((x) => (x.disabled = false)); }
    });
    cards.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-del-note]'); if (!b) return;
      if (!confirmDelete(b)) return;
      try { await updateShared((d) => { d.notes = (d.notes || []).filter((n) => !(n.id === b.dataset.delNote && n.by === S.user)); }, 'Delete note'); }
      catch (err) { alertMsg(err.message); }
    });

    $('#addUser').addEventListener('submit', async (e) => {
      e.preventDefault(); const name = $('#newUser').value.trim().slice(0, 30); if (!name) return;
      try { await updateShared((d) => { d.users ||= []; if (!d.users.includes(name)) d.users.push(name); }, `Add person ${name}`); $('#newUser').value = ''; renderSettings(); settingsMsg(`Added ${name}.`, 'ok'); }
      catch (err) { settingsMsg(err.message, 'err'); }
    });
    $('#userList').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-rm-user]'); if (!b) return;
      const name = b.dataset.rmUser;
      if (name === ownerName()) return;
      try { await updateShared((d) => { d.users = (d.users || []).filter((u) => u !== name); }, `Remove person ${name}`); renderSettings(); settingsMsg(`Removed ${name}. Their notes stay.`, 'ok'); }
      catch (err) { settingsMsg(err.message, 'err'); }
    });
    $('#weights').addEventListener('input', updateWTotal);
    $('#saveWeights').addEventListener('click', async () => {
      if (!isOwner()) { settingsMsg(`Only ${ownerName() || 'the owner'} can change the rating system.`, 'err'); return; }
      const w =Object.fromEntries($$('#weights input').map((i) => [i.dataset.w, Math.max(0, Math.min(100, Math.round(+i.value || 0)))]));
      const ageDir = $('#ageDir').value === 'older' ? 'older' : 'newer';
      try { await updateShared((d) => { d.weights = w; d.prefs = { ...(d.prefs || {}), ageDir }; }, 'Change rating weights'); settingsMsg('Weights saved.', 'ok'); }
      catch (err) { settingsMsg(err.message, 'err'); }
    });
    $('#loanOpt').addEventListener('change', (e) => { LS.set('hh-loanOpt', e.target.value); render(); });
    $('#saveLoan').addEventListener('click', async () => {
      if (!isOwner()) { settingsMsg(`Only ${ownerName() || 'the owner'} can change the payment assumptions.`, 'err'); return; }
      const v = (id, lo, hi) => { const raw = $('#' + id).value.trim(); if (raw === '') return null; const n = parseFloat(raw); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : NaN; };
      const next = { downPct: v('loanDown', 0, 100), insYear: v('loanIns', 0, 50000), customRate: v('loanRate', 0, 20), customTerm: v('loanTerm', 5, 40) || 30 };
      if (next.downPct == null || next.insYear == null || Object.values(next).some((x) => Number.isNaN(x))) { settingsMsg('Down % and insurance are required; the quoted rate can be left blank.', 'err'); return; }
      const changedRate = next.customRate !== (loan().customRate ?? null);
      next.customNote = next.customRate ? (changedRate ? `entered by ${S.user} on ${new Date().toLocaleDateString()}` : loan().customNote) : '';
      try {
        await updateShared((d) => { d.prefs = { ...(d.prefs || {}), loan: next }; }, 'Change payment assumptions');
        if (changedRate && next.customRate) LS.set('hh-loanOpt', 'quote');
        renderSettings(); render(); settingsMsg('Payment assumptions saved.', 'ok');
      } catch (err) { settingsMsg(err.message, 'err'); }
    });
    $('#resetWeights').addEventListener('click', () => { for (const i of $$('#weights input')) i.value = DEFAULT_WEIGHTS[i.dataset.w]; $('#ageDir').value = 'newer'; updateWTotal(); });
    $('#tokenForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const tok = $('#tokenIn').value.trim(); if (!tok) return;
      if (!S.repo) { settingsMsg('Saving only works on the published site.', 'err'); return; }
      settingsMsg('Checking token…');
      try {
        const repo = await gh(`/repos/${S.repo.owner}/${S.repo.name}`, {}, tok);
        if (!repo.permissions?.push) throw new Error('That token cannot write to this repository.');
        let sha = null; try { sha = (await gh(repoPath('token.enc.json') + '?ref=main', {}, tok)).sha; } catch { }
        await writeFile('token.enc.json', await encryptObj({ token: tok, savedBy: S.user, at: new Date().toISOString() }), sha, `Save write token (by ${S.user || 'someone'})`, tok);
        S.token = tok; $('#tokenIn').value = '';
        await loadAll(); renderSettings(); render(); settingsMsg('Saving is on for every family device.', 'ok');
      } catch (err) { settingsMsg(err.body?.message ? `${err.message}: ${err.body.message}` : err.message, 'err'); }
    });
    $('#forget').addEventListener('click', () => { LS.del('hh-pass'); location.reload(); });

    const markVisit = () => LS.set('hh-lastVisit', new Date().toISOString());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') markVisit();
      else if (S.key) refresh();
    });
    window.addEventListener('pagehide', markVisit);
  }
  const alertMsg = (t) => { const b = $('#banner'); b.hidden = false; b.textContent = t; };
  function confirmDelete(btn) {
    if (btn.dataset.armed) return true;
    btn.dataset.armed = '1'; btn.textContent = 'Tap again to delete';
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Delete'; }, 4000);
    return false;
  }

  let refreshing = false;
  async function refresh() {
    if (refreshing) return; refreshing = true;
    try { await loadToken(); await loadAll(); render(); } catch { } finally { refreshing = false; }
  }
  function start() {
    $('#lock').hidden = true; $('#main').hidden = false;
    render();
    if (!S.user || !(S.shared?.users || []).includes(S.user)) showWho();
    setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 5 * 60 * 1000);
  }

  async function boot() {
    S.repo = detectRepo();
    wire();
    const pass = LS.get('hh-pass');
    if (pass) {
      try { await unlock(pass); start(); return; } catch { LS.del('hh-pass'); }
    }
    $('#lock').hidden = false; $('#pass').focus();
  }
  boot();
})();
