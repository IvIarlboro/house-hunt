// Reads the REcolorado Matrix client portal with plain HTTP (no browser).
// One GET of the "All" page lists every listing; a form postback opens one listing's detail.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

const ent = (s) => s
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&amp;/g, '&');
const toLines = (html) => ent(html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, '\n'))
  .split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
const num = (s) => { if (s == null) return null; const n = parseFloat(String(s).replace(/[$,]/g, '')); return Number.isFinite(n) ? n : null; };
const BUCKETS = { 6: 'fav', 4: 'poss', 2: 'dislike' };

export class Portal {
  constructor(url) { this.url = url; this.jar = new Map(); this.form = null; }
  cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  keep(r) {
    for (const c of r.headers.getSetCookie?.() || []) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      this.jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
  }

  async list() {
    const r = await fetch(this.url, { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(`portal list HTTP ${r.status}`);
    this.keep(r);
    const html = await r.text();
    this.form = {};
    for (const m of html.matchAll(/<input[^>]+type="hidden"[^>]*>/gi)) {
      const n = m[0].match(/name="([^"]+)"/)?.[1];
      const v = m[0].match(/value="([^"]*)"/)?.[1] ?? '';
      if (n) this.form[n] = ent(v);
    }
    const parts = html.split(/<!--@Record:(\d+)@-->/);
    const listings = [];
    for (let i = 1; i < parts.length; i += 2) {
      const rec = parseListRecord(parts[i], parts[i + 1]);
      if (rec) listings.push(rec);
    }
    // Gather every photo link on the page by listing key (the carousel data sits outside each record block).
    const byKey = new Map();
    for (const m of html.matchAll(/GetMedia\.ashx\?Key=(\d+)&(?:amp;)?TableID=9&(?:amp;)?Type=1&(?:amp;)?Number=(\d+)&(?:amp;)?Size=(\d)&(?:amp;)?exk=([0-9a-f]+)/g)) {
      let med = byKey.get(m[1]); if (!med) byKey.set(m[1], (med = new Map()));
      const e = med.get(+m[2]) || {}; e['s' + m[3]] = m[4]; med.set(+m[2], e);
    }
    for (const l of listings) {
      const med = byKey.get(l.key);
      if (med) l.media = { key: l.key, p: [...med.entries()].sort((a, b) => a[0] - b[0]).filter(([, e]) => e.s2 || e.s4).map(([n, e]) => [n, e.s2 || '', e.s4 || '']) };
    }
    const unavailable =[...html.matchAll(/Listing ID (?:<b>)?([A-Z]{0,3}\d{5,9})(?:<\/b>)?\. This listing is currently in a Status that is not available/g)].map((m) => m[1]);
    if (!listings.length) throw new Error('portal list parsed 0 listings (page layout changed?)');
    return { listings, unavailable };
  }

  async detail(index) {
    if (!this.form) throw new Error('call list() first');
    const body = new URLSearchParams({ ...this.form, __EVENTTARGET: '_ctl0$m_DisplayCore', __EVENTARGUMENT: `Redisplay|69,,${index}` });
    const r = await fetch(this.url, {
      method: 'POST', body,
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: this.cookie(), Referer: this.url },
    });
    if (!r.ok) throw new Error(`portal detail HTTP ${r.status}`);
    this.keep(r);
    return parseDetail(await r.text());
  }
}

function parseListRecord(key, chunk) {
  const id = chunk.match(/Listing ID:\s*(?:<[^>]+>\s*)*([A-Z]{0,3}\d{5,9})/)?.[1];
  if (!id) return null;
  const addrM = chunk.match(/Redisplay\|69,,(\d+)'\)">([^<]+)<\/a>/) || chunk.match(/Redisplay\|69,,(\d+)&#39;\)">([^<]+)<\/a>/);
  const cityLine = chunk.match(/<span class="formula J_formula">\s*([^<]*?,\s*CO\s*\d{5})\s*<\/span>/)?.[1];
  const photo = chunk.match(/https:\/\/matrixmedia\.recolorado\.com\/mediaserver\/GetMedia\.ashx\?[^"']+/)?.[0];
  // Every photo of this listing, from the list page's carousel. These links are stable (the detail page's
  // links expire within about an hour). Stored compactly as [number, exk for Size=2, exk for Size=4].
  const med = new Map();
  for (const m of chunk.matchAll(/GetMedia\.ashx\?Key=(\d+)&(?:amp;)?TableID=9&(?:amp;)?Type=1&(?:amp;)?Number=(\d+)&(?:amp;)?Size=(\d)&(?:amp;)?exk=([0-9a-f]+)/g)) {
    if (m[1] !== key) continue;
    const e = med.get(+m[2]) || {}; e['s' + m[3]] = m[4]; med.set(+m[2], e);
  }
  const media = { key, p: [...med.entries()].sort((a, b) => a[0] - b[0]).filter(([, e]) => e.s2 || e.s4).map(([n, e]) => [n, e.s2 || '', e.s4 || '']) };
  // (list() replaces this with the full set gathered from the whole page — most carousel links live outside the record block.)
  const L = toLines(chunk);
  const after = (label) => { const i = L.indexOf(label); return i >= 0 ? L[i + 1] : null; };
  const before = (label) => { const i = L.indexOf(label); return i > 0 ? L[i - 1] : null; };
  const status = chunk.match(/<span class='Status_[A-Z]+'>([^<]+)<\/span>/)?.[1] || null;
  const levelsTok = before('Levels');
  return {
    id,
    key,
    index: addrM ? +addrM[1] : null,
    address: addrM ? ent(addrM[2]).trim() : null,
    city: cityLine ? cityLine.trim() : null,
    price: num(chunk.match(/d-fontSize--largest">\s*(\$[\d,]+)/)?.[1]),
    status,
    bucket: BUCKETS[chunk.match(/data-currentbucket='(\d+)'/)?.[1]] || 'none',
    listDate: after('List Date:'),
    contractDate: after('Purchase Contract Date:'),
    closeDate: after('Close Date:'),
    originalPrice: num(after('Original List Price:')),
    type: L.find((s) => /Residence|House|Condo|Townhouse/.test(s)) || null,
    beds: num(before('Beds')),
    baths: num(before('Baths')),
    levels: levelsTok,
    sqftTotal: num(before('SqFt Total')),
    sqftFin: num(before('SqFt Fin')),
    yearBuilt: num(after('Built in')),
    lotAcres: num(before('Acres')),
    schoolDistrict: before('School District'),
    parkingTotal: num(before('Parking Total')),
    garageSpaces: num(before('Garage Spaces')),
    hoa: after('HOA'),
    tax: num(after('Annual Tax')),
    photoThumb: photo ? ent(photo) : null,
    media,
  };
}

const PARK_TYPES = /^(Garage|Carport|Recreational Vehicle|Off-Street|Covered|Driveway|Tandem|Other|Assigned|Unassigned|Attached|Detached|Heated|Oversized)/;
const LABELS = [
  'List Price:', 'Original List Price:', 'Close Date:', 'Purchase Contract Date:', 'Listing Contract Date:',
  'Original List Price', 'Listing Contract Date', 'Levels', 'Year Built', 'Living Area (SqFt Fin)', 'Area (SqFt) Total',
  'Above Grade Fin Area (SqFt)', 'Below Grade Finished Area', 'PSF Finished', 'PSF Total', 'PSF Above Grade', 'Basement', 'Appliances',
  'Flooring', 'Interior Features', 'Exterior Features', 'Patio And Porch Features', 'Fencing', 'Lot Features', 'Parking Features',
  'Heating', 'Cooling', 'Tax Annual Amount', 'Tax Year', 'Elementary School', 'Middle Or Junior School', 'High School',
  'Subdivision Name', 'Property Condition', 'Architectural Style', 'Direction Faces', 'Road Surface Type', 'Water Source', 'Sewer',
  'Construction Materials', 'Roof', 'Window Features', 'Laundry Features', 'Lot Size Acres', 'Lot Size Square Feet', 'Total Annual HOA Fees',
  'Pool Private YN', 'Pool Features', 'Spa Features', 'Fireplace Features', 'Community Features', 'Outbuildings',
];
// Amenity and upgrade cues, matched in the description and feature fields. Short phrases only, as evidence.
const CUES = {
  pool: /in-?ground pool|swimming pool|private pool|heated pool|\bpool\b(?! table)|hot tub|\bspa\b(?![- ]like| bath| tub| shower)/gi,
  outdoor: /covered (?:patio|deck|porch)|outdoor kitchen|built-?in (?:grill|bbq)|fire ?pit|fire ?place outdoors|outdoor fireplace|pergola|gazebo|paver patio|large (?:deck|patio)|composite deck|entertain(?:ing|er'?s)? (?:space|area|backyard|yard)|patio|deck|sunroom|screened porch/gi,
  upgrades: /new(?:er)? (?:roof|furnace|hvac|a\/?c|air conditioning|water heater|windows|siding|sewer line|electrical|panel|garage doors?|driveway|flooring|carpet|appliances)|(?:roof|furnace|windows|a\/?c|water heater|sewer line) (?:was |were )?(?:replaced|installed) (?:in )?(?:20[12]\d)|(?:fully |completely |recently )?(?:remodeled|renovated|updated) (?:kitchen|bath(?:room)?s?|primary bath)|(?:kitchen|bath(?:room)?s?) (?:was |were )?(?:fully |completely )?(?:remodeled|renovated)|tankless water heater|solar panels|owned solar|ev charger|whole[- ]house (?:fan|humidifier|water)|quartz counter|radon mitigation/gi,
};
function cues(text, re) {
  const out = new Set();
  for (const m of (text || '').matchAll(re)) { out.add(m[0].toLowerCase().replace(/\s+/g, ' ')); if (out.size >= 6) break; }
  return [...out];
}
const OPEN_KITCHEN = /\bopen[- ](?:concept|floor[- ]?plan|kitchen|layout|living)|kitchen (?:that )?opens|opens? (?:up )?(?:in)?to the (?:living|family|great)|great room/i;
// Rental = a unit they can rent out while living in the house: an ADU or a space with its own entrance
// (Jeremy, Oct 31 2026). Whole-house rental history / "rental income" wording does NOT count.
const RENTAL = /\bADU\b|accessory dwelling|separate (?:entrance|entry|apartment|unit|dwelling)|private (?:entrance|entry)|own (?:entrance|entry)|exterior entrance|walk-?out (?:apartment|unit)|lock[- ]?off|(?:basement|garden[- ]level|in[- ]law|mother[- ]in[- ]law) apartment|double apartments|\bduplex\b|second (?:unit|dwelling)|carriage house|guest house|casita/i;
const MULTIGEN = /multi[- ]?gen|mother[- ]?in[- ]?law|in[- ]?law (?:suite|quarters)|second (?:kitchen|primary|master)|dual (?:primary|master)|kitchenette|wet bar\/kitchen|basement kitchen|guest (?:suite|quarters)|separate living (?:quarters|area|space)/i;
const RV = /\bRV\b|camper|\bboat\b|trailer|toy hauler/i;

function sentenceWith(text, re) {
  if (!text) return null;
  const s = text.split(/(?<=[.!?])\s+/).find((x) => re.test(x));
  if (!s) return null;
  const m = s.match(re); const at = Math.max(0, m.index - 40);
  return (at > 0 ? '…' : '') + s.slice(at, m.index + m[0].length + 40).trim() + (m.index + m[0].length + 40 < s.length ? '…' : '');
}

export function parseDetail(html) {
  const L = toLines(html);
  const v = {};
  for (const lab of LABELS) {
    for (let i = L.indexOf(lab); i >= 0; i = L.indexOf(lab, i + 1)) {
      const nx = L[i + 1];
      if (nx && !LABELS.includes(nx) && !/^(Or|And|Type|Features|Dim|Level|Desc)$/.test(nx)) { v[lab] = nx; break; }
    }
  }
  // Parking table: "Parking Total" n "Type" "# Spcs" "Desc" then rows of type, count, optional description.
  const parking = [];
  const pi = L.indexOf('Parking Total');
  if (pi >= 0) {
    let j = L.indexOf('Desc', pi);
    if (j > 0 && j - pi < 6) {
      j++;
      while (j < L.length && !/^(Parking Features|Utilities|Heating|Associations)$/.test(L[j])) {
        if (PARK_TYPES.test(L[j]) && /^\d+$/.test(L[j + 1] || '')) {
          const row = { type: L[j], spaces: +L[j + 1], desc: '' }; j += 2;
          const desc = [];
          while (j < L.length && !(PARK_TYPES.test(L[j]) && /^\d+$/.test(L[j + 1] || '')) && !/^(Parking Features|Utilities|Heating|Associations)$/.test(L[j])) desc.push(L[j++]);
          row.desc = desc.join(' ');
          parking.push(row);
        } else j++;
      }
    }
  }
  // Portal notes: date line, "quoted text", author.
  const notes = [];
  for (const m of html.matchAll(/mtx-listingNotesWidget-noteRow[\s\S]*?mtx-subtextSoft">([\s\S]*?)<\/span>[\s\S]*?mtx-section">([\s\S]*?)<\/p>[\s\S]*?mtx-author[^>]*>([\s\S]*?)<\/div>/g)) {
    const text = ent(m[2]).replace(/\s+/g, ' ').trim().replace(/^"|"$/g, '').trim();
    const who = ent(m[3]).trim();
    if (text) notes.push({ when: ent(m[1]).trim(), text, by: who === 'Me' ? 'Portal (you)' : who });
  }
  // The listing description can span several paragraphs; read all of them (they sit before "General Description").
  const gd = L.indexOf('General Description');
  const remarks = (gd > 0 ? L.slice(0, gd) : L).filter((s) => s.length > 120 && !/^(SECTION|SUBDIVISION)/.test(s)).join(' ');
  // Room table rows read "Bedroom", "Primary", "<Level>" — find the primary bedroom's level.
  let primaryLevel = null;
  const ri = L.indexOf('Detailed Room Info');
  if (ri >= 0) {
    for (let j = ri; j < Math.min(L.length, ri + 400) && L[j] !== 'School Information'; j++) {
      if (/^(Bedroom|Primary Bedroom|Master Bedroom)$/i.test(L[j]) && /^(Primary|Master)/i.test(L[j + 1] || '') && /^(Main|Upper|Lower|Basement|Second|Third)$/i.test(L[j + 2] || '')) { primaryLevel = L[j + 2]; break; }
      if (/^(Primary Bedroom|Master Bedroom)$/i.test(L[j]) && /^(Main|Upper|Lower|Basement|Second|Third)$/i.test(L[j + 1] || '')) { primaryLevel = L[j + 1]; break; }
    }
  }
  if (!primaryLevel) {
    const m = remarks.match(/(main[- ](?:floor|level)) (?:primary|master)|(?:primary|master) (?:suite |bedroom )?(?:is )?on the main/i);
    if (m) primaryLevel = 'Main (description)';
  }
  // Laundry: every "Laundry" row in the room table and its level (a level line follows within a few lines),
  // then the Laundry Features field and the description as fallbacks.
  const LEVEL = /^(Main|Upper|Lower|Basement|Second|Third)$/i;
  const laundryLevels = [];
  if (ri >= 0) {
    for (let j = ri; j < Math.min(L.length, ri + 400) && L[j] !== 'School Information'; j++) {
      if (/^Laundry( Room)?$/i.test(L[j])) {
        const lv = L.slice(j + 1, j + 4).find((x) => LEVEL.test(x));
        if (lv && !laundryLevels.includes(lv)) laundryLevels.push(lv);
      }
    }
  }
  if (!laundryLevels.length) {
    const lf = `${v['Laundry Features'] || ''} ${remarks}`;
    if (/main[- ](?:floor|level) laundry|laundry (?:room )?(?:is )?on the main|main level/i.test(lf)) laundryLevels.push('Main (listing)');
    else if (/upper[- ]level laundry|laundry (?:room )?(?:is )?upstairs|second[- ]floor laundry/i.test(lf)) laundryLevels.push('Upper (listing)');
    else if (/basement laundry|laundry (?:room )?in (?:the )?basement|lower[- ]level laundry|in basement/i.test(lf)) laundryLevels.push('Basement (listing)');
  }
  const imgs = [...new Set([...html.matchAll(/https:\/\/matrixmedia\.recolorado\.com\/mediaserver\/GetMedia\.ashx\?[^"' ]+/g)].map((m) => ent(m[0])))];
  // Prefer the medium photo (Size=3); Size=4 is 1600px and too heavy for a phone list.
  const first = imgs.filter((u) => /Number=0&/.test(u));
  const firstBig = first.find((u) => /Size=3&/.test(u)) || first.sort((a, b) => num(b.match(/Size=(\d)/)?.[1]) - num(a.match(/Size=(\d)/)?.[1]))[0];
  // Every photo, one medium-size link per photo number, in listing order.
  const byNum = new Map();
  for (const u of imgs) {
    const n = +(u.match(/Number=(\d+)/)?.[1] ?? -1); const sz = +(u.match(/Size=(\d)/)?.[1] ?? 0);
    if (n < 0) continue;
    const cur = byNum.get(n);
    if (!cur || (sz === 3 && cur.sz !== 3) || (cur.sz !== 3 && sz > cur.sz)) byNum.set(n, { u, sz });
  }
  const photos = [...byNum.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v.u);
  // Tour / video / floor-plan links the agent attached (skip the portal's own neighborhood widgets).
  const ext = [...new Set([...html.matchAll(/https?:\/\/[^"'<>\s]+/g)].map((m) => ent(m[0])))];
  const tours = [];
  for (const u of ext) {
    if (/recolorado\.com|liveby\.com|walkscore|google|gstatic|jquery|bootstrap|cloudflare|w3\.org|schema\.org|facebook\.com\/(?:tr|plugins)|doubleclick|fonts\./i.test(u)) continue;
    let kind = null;
    if (/zillow\.com\/view-imx/i.test(u)) kind = '3D tour + floor plan';
    else if (/matterport\.com/i.test(u)) kind = '3D tour';
    else if (/floor ?plan|floorplan/i.test(u)) kind = 'Floor plan';
    else if (/youtube\.com|youtu\.be|vimeo\.com|\.mp4(\?|$)|dropbox\.com.*\.mp4/i.test(u)) kind = 'Video';
    else if (/tour|virtual|v1tours|hd\.pics|vht\.com|listing|propertypanorama|cloudpano|kuula/i.test(u)) kind = 'Virtual tour';
    if (kind && !tours.some((t) => t.url === u)) tours.push({ kind, url: u.replace(/\/embed\/([\w-]+)/, '/watch?v=$1') });
  }
  const llm = html.match(/[?&]lat=(-?\d+\.\d+)&(?:amp;)?lng=(-?\d+\.\d+)/);
  const geo = llm ? { lat: +llm[1], lng: +llm[2] } : null;
  return {
    fields: v,
    parking,
    notes,
    photo: firstBig || null,
    photos,
    tours,
    geo,
    photoCount: new Set(imgs.map((u) => u.match(/Number=(\d+)/)?.[1])).size,
    // Lines like "Open House:  Sat Oct 31, 11:00AM-1:00PM" near the top of the detail page.
    openHouses: [...new Set(L.map((x) => x.match(/^Open House:\s*(.+)$/i)?.[1]?.replace(/\s+/g, ' ').trim()).filter(Boolean))],
    hints: (() => {
      const feat = ['Exterior Features', 'Patio And Porch Features', 'Pool Features', 'Spa Features', 'Interior Features', 'Appliances', 'Roof', 'Property Condition', 'Outbuildings', 'Lot Features']
        .map((k) => v[k] || '').join('. ');
      const all = remarks + ' ' + feat;
      const pool = cues(all, CUES.pool);
      if (/^yes$/i.test(v['Pool Private YN'] || '')) pool.unshift('private pool (listing field)');
      return {
        primaryLevel,
        laundryLevels,
        fence: sentenceWith(remarks, /dog run|fenced|fencing|\bfence\b/i),
        openKitchen: sentenceWith(remarks, OPEN_KITCHEN),
        multigen: sentenceWith(remarks, MULTIGEN),
        rental: sentenceWith(remarks, RENTAL),
        rv: sentenceWith(remarks, RV),
        pool: [...new Set(pool)],
        outdoor: cues(all, CUES.outdoor),
        upgrades: cues(all, CUES.upgrades),
      };
    })(),
  };
}
