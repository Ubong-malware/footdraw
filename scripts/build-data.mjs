// Builds public/data/pool.json: the FootDraw card pool.
// Sources: Wikidata SPARQL (traits) + Wikipedia Action API (titles, descriptions, thumbnails, extracts).
// Run: node scripts/build-data.mjs   (no API keys needed)
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
// Responses are cached on disk (BUILD_CACHE, default /tmp/footdraw-build-cache) so a network hiccup mid-build doesn't
// mean starting over.
const CACHE = process.env.BUILD_CACHE ?? '/tmp/footdraw-build-cache';
mkdirSync(CACHE, { recursive: true });
async function cached(key, fn) {
  const f = `${CACHE}/${createHash('sha1').update(key).digest('hex')}.json`;
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  const v = await fn(); writeFileSync(f, JSON.stringify(v)); return v;
}
async function getJSON(url, opts = {}, tries = 6) {
  for (let i = 0; ; i++) {
    try { const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(90000) }); if (r.ok) return await r.json(); if (i >= tries) throw new Error(`HTTP ${r.status}`); }
    catch (e) { if (i >= tries) throw e; }
    await new Promise((res) => setTimeout(res, 3000 * (i + 1)));
  }
}

const UA = 'FootDraw/1.0 (static card game build script; https://example.org/footdraw)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sparql(query) {
  return cached(query, async () => (await getJSON('https://query.wikidata.org/sparql', {
    method: 'POST',
    headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ query }),
  })).results.bindings);
}
const qid = (uri) => uri.split('/').pop();
const titleFromUrl = (u) => decodeURIComponent(u.split('/wiki/')[1]).replace(/_/g, ' ');

// Deterministic sampling so rebuilds are reproducible (mulberry32).
let seed = 20261117;
const srand = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const sample = (arr, n) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(srand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); };

// List candidates by Wikipedia sitelinks. `limit` = total wanted; `famous` of them are the best-known, the rest are a
// random sample from the next `depth` ranks, so the pool isn't only superstars (more eras, leagues and nations).
async function listCards(kind, where, limit, minSl = 20, { famous = limit, depth = 0 } = {}) {
  const rows = await sparql(`SELECT ?x ?sl WHERE { ${where} ?x wikibase:sitelinks ?sl. FILTER(?sl > ${minSl}) }`);
  const seen = new Set();
  const ranked = rows.filter((r) => !seen.has(r.x.value) && seen.add(r.x.value))
    .map((r) => ({ id: qid(r.x.value), kind, sitelinks: +r.sl.value }))
    .sort((a, b) => b.sitelinks - a.sitelinks);
  const want = Math.round(limit * 1.15), nTop = Math.min(want, Math.round(famous * 1.15));
  const top = [...ranked.slice(0, nTop), ...sample(ranked.slice(nTop, nTop + depth), want - nTop)];
  const titles = new Map();
  for (let i = 0; i < top.length; i += 150) {
    const values = top.slice(i, i + 150).map((c) => `wd:${c.id}`).join(' ');
    for (const r of await sparql(`SELECT ?x ?article WHERE { VALUES ?x { ${values} } ?article schema:about ?x; schema:isPartOf <https://en.wikipedia.org/>. }`))
      titles.set(qid(r.x.value), titleFromUrl(r.article.value));
  }
  return top.filter((c) => titles.has(c.id)).slice(0, limit).map((c) => ({ ...c, title: titles.get(c.id) }));
}

console.log('Listing cards…');
// Players: 900 best-known + a random sample from the next 9,000 (sitelinks > 22), across eras and nations.
const players = await listCards('player', '?x wdt:P106 wd:Q937857.', 3300, 22, { famous: 900, depth: 9000 });
// Clubs: 140 best-known + a random sample from the next 900 (many countries and leagues).
const clubs = await listCards('club', '?x wdt:P31 wd:Q476028.', 360, 25, { famous: 140, depth: 900 });
const nations = await listCards('nation', '?x wdt:P31 wd:Q135408445.', 125, 25);
// Tournaments & competitions: historical editions (with winners/hosts) plus the competitions and leagues themselves.
const SERIES = { Q19317: 23, Q260858: 17, Q178750: 18, Q83145: 16, Q157894: 10, Q189327: 8, Q171789: 6, Q18756: 22, Q18760: 8, Q184795: 10, Q223366: 6, Q40241: 4 };
const editions = [];
for (const [sid, n] of Object.entries(SERIES)) { editions.push(...await listCards('event', `?x wdt:P3450 wd:${sid}.`, n, 8)); await sleep(500); }
const COMPS = ['Q19317', 'Q260858', 'Q178750', 'Q83145', 'Q157894', 'Q189327', 'Q171789', 'Q18756', 'Q18760', 'Q184795', 'Q223366', 'Q40241', 'Q15980635', 'Q213070', 'Q60585', 'Q219261', 'Q193041'];
const comps = await listCards('event', `VALUES ?x { ${COMPS.map((q) => `wd:${q}`).join(' ')} }`, COMPS.length, 5);
const leagues = await listCards('event', '?x wdt:P31 wd:Q15991303.', 45, 25);
const cups = await listCards('event', '?x wdt:P31 wd:Q8463186.', 18, 15);
let cards = [...players, ...clubs, ...nations, ...editions, ...comps, ...leagues, ...cups];
{ const seenIds = new Set(); cards = cards.filter((c) => !seenIds.has(c.id) && seenIds.add(c.id)); }
const byId = new Map(cards.map((c) => [c.id, c]));
cards.forEach((c) => (c.traits = new Map()));
const leagueIds = new Set(leagues.map((c) => c.id)), compIds = new Set(comps.map((c) => c.id));
console.log({ players: players.length, clubs: clubs.length, nations: nations.length, editions: editions.length, comps: comps.length, leagues: leagues.length, cups: cups.length });

// English Wikipedia titles for any entity, used as trait labels when we have one.
const enTitle = new Map(cards.map((c) => [c.id, c.title]));

function add(card, key, label) {
  if (!card || !label || /^Q\d+$/.test(label)) return;
  card.traits.set(key, label);
}

// Fetch property values for a set of items in batches.
async function props(ids, pattern, extra = '') {
  const out = [];
  for (let i = 0; i < ids.length; i += 120) {
    const values = ids.slice(i, i + 120).map((x) => `wd:${x}`).join(' ');
    const rows = await sparql(`SELECT ?item ?v ?vLabel ?enTitle ${extra ? '?w' : ''} WHERE { VALUES ?item { ${values} } ${pattern}
      OPTIONAL { ?enArticle schema:about ?v; schema:isPartOf <https://en.wikipedia.org/>; schema:name ?enTitle. }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }`);
    out.push(...rows);
    await sleep(300);
  }
  return out.map((r) => ({ item: qid(r.item.value), v: r.v.type === 'uri' ? qid(r.v.value) : r.v.value,
    label: r.enTitle?.value ?? r.vLabel?.value, w: r.w?.value }));
}

const ofKind = (k) => cards.filter((c) => c.kind === k).map((c) => c.id);
const P = ofKind('player'), C = ofKind('club'), N = ofKind('nation'), E = ofKind('event');
const clean = (s) => s?.replace(/ \((?:footballer|association football|soccer|sport)\)$/i, '');

console.log('Player traits…');
// Country they represent (falls back to citizenship).
for (const r of await props(P, '?item p:P1532/ps:P1532 ?v.')) add(byId.get(r.item), `country:${r.v}`, r.label);
for (const r of await props(P, '?item wdt:P27 ?v.')) {
  const c = byId.get(r.item);
  if (![...c.traits.keys()].some((k) => k.startsWith('country:'))) add(c, `country:${r.v}`, r.label);
}
// Teams (clubs + national teams), skipping youth/reserve sides.
for (const r of await props(P, '?item p:P54/ps:P54 ?v.')) {
  if (/\b(U-?\d\d|under-\d\d|youth|reserves?|B team|II|Juvenil|Primavera|Academy|Olympic)\b/i.test(r.label ?? '')) continue;
  add(byId.get(r.item), `team:${r.v}`, clean(r.label));
}
for (const r of await props(P, '?item p:P413/ps:P413 ?v.')) add(byId.get(r.item), `pos:${r.v}`, cap(clean(r.label)));
for (const r of await props(P, '?item p:P166/ps:P166 ?v.')) add(byId.get(r.item), `award:${r.v}`, r.label);
for (const r of await props(P, '?item p:P1344/ps:P1344 ?v.')) add(byId.get(r.item), `event:${r.v}`, r.label);
for (const r of await props(P, '?item wdt:P19 ?v.')) add(byId.get(r.item), `city:${r.v}`, r.label);
// Leagues they played in (through their clubs' league), e.g. "Serie A".
for (const r of await props(P, '?item p:P54/ps:P54 ?t. ?t wdt:P118 ?v.')) add(byId.get(r.item), `league:${r.v}`, r.label);
// Competitions they played at (through tournament editions), e.g. "FIFA World Cup".
for (const r of await props(P, '?item p:P1344/ps:P1344 ?e. ?e wdt:P3450 ?v.')) if (byId.get(r.v) || SERIES[r.v]) add(byId.get(r.item), `comp:${r.v}`, r.label);
for (const r of await props(P, '?item wdt:P569 ?v.')) {
  const y = parseInt(r.v, 10);
  if (y) add(byId.get(r.item), `born:${Math.floor(y / 10) * 10}s`, `Born in the ${Math.floor(y / 10) * 10}s`);
}
for (const r of await props(P, '?item wdt:P106 ?v. FILTER(?v != wd:Q937857)')) add(byId.get(r.item), `occ:${r.v}`, cap(r.label));

console.log('Club traits…');
for (const id of [...C, ...N, ...E]) add(byId.get(id), `team:${id}`, byId.get(id).kind === 'event' ? null : byId.get(id).title);
for (const id of E) {
  const c = byId.get(id);
  if (leagueIds.has(id)) add(c, `league:${id}`, c.title);          // a league card shares its clubs' league trait
  else if (compIds.has(id) || SERIES[id]) add(c, `comp:${id}`, c.title); // a competition card shares its editions' trait
  else add(c, `event:${id}`, c.title);
}
for (const r of await props(E, '?item wdt:P3450 ?v.')) add(byId.get(r.item), `comp:${r.v}`, r.label);
for (const r of await props(E, '?item wdt:P571 ?v.')) { const y = parseInt(r.v, 10); if (y) add(byId.get(r.item), `founded:${Math.floor(y / 10) * 10}s`, `Founded in the ${Math.floor(y / 10) * 10}s`); }
for (const r of await props(E, '?item wdt:P585 ?v.')) { const y = parseInt(r.v, 10); if (y) add(byId.get(r.item), `decade:${Math.floor(y / 10) * 10}s`, `The ${Math.floor(y / 10) * 10}s`); }
for (const r of await props([...C, ...N], '?item wdt:P17 ?v.')) add(byId.get(r.item), `country:${r.v}`, r.label);
for (const r of await props(C, '?item wdt:P118 ?v.')) add(byId.get(r.item), `league:${r.v}`, r.label);
for (const r of await props(C, '?item wdt:P159 ?v.')) add(byId.get(r.item), `city:${r.v}`, r.label);
for (const r of await props(C, '?item wdt:P115 ?v.')) add(byId.get(r.item), `venue:${r.v}`, r.label);
for (const r of await props(C, '?item wdt:P571 ?v.')) {
  const y = parseInt(r.v, 10);
  if (y) add(byId.get(r.item), `founded:${Math.floor(y / 10) * 10}s`, `Founded in the ${Math.floor(y / 10) * 10}s`);
}
for (const r of await props([...C, ...N], '?item p:P166/ps:P166 ?v.')) add(byId.get(r.item), `award:${r.v}`, r.label);
console.log('Event traits…');
for (const r of await props(E, '?item wdt:P17 ?v.')) add(byId.get(r.item), `country:${r.v}`, r.label);
for (const r of await props(E, '?item wdt:P1346 ?v.')) add(byId.get(r.item), `team:${r.v}`, clean(r.label));
// Clubs in a league card's top flight: the league's current/past participants are linked via the clubs' P118 above.
for (const r of await props(E, '?item wdt:P276 ?v.')) add(byId.get(r.item), `venue:${r.v}`, r.label);
// Nations that won a tournament share the tournament.
for (const r of await props([...N, ...C], '?v wdt:P1346 ?item.')) add(byId.get(r.item), `event:${r.v}`, r.label);

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

console.log('Wikipedia summaries…');
const titles = cards.map((c) => c.title);
const info = new Map();
for (let i = 0; i < titles.length; i += 20) {
  const batch = titles.slice(i, i + 20);
  const url = 'https://en.wikipedia.org/w/api.php?' + new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', redirects: '1',
    prop: 'pageimages|description|extracts', piprop: 'thumbnail', pithumbsize: '400',
    exintro: '1', explaintext: '1', exsentences: '4', titles: batch.join('|'),
  });
  const j = await cached(url, () => getJSON(url, { headers: { 'User-Agent': UA } }));
  const norm = new Map();
  for (const n of [...(j.query.normalized ?? []), ...(j.query.redirects ?? [])]) norm.set(n.to, n.from);
  for (const p of j.query.pages) {
    let t = p.title; while (norm.has(t)) t = norm.get(t);
    info.set(t, p); info.set(p.title, p);
  }
  await sleep(150);
}

// Missing images: Wikidata image (P18) for people, logo (P154) or image for clubs, teams and competitions.
console.log('Wikidata images for cards without a Wikipedia thumbnail…');
const noPic = cards.filter((c) => { const p = info.get(c.title); return p && !p.missing && !p.thumbnail; }).map((c) => c.id);
const pic = new Map();
for (const r of await props(noPic, '{ ?item wdt:P154 ?v. } UNION { ?item wdt:P18 ?v. }')) if (!pic.has(r.item) || /logo|crest|badge|emblem/i.test(r.v)) pic.set(r.item, r.v);
const filePath = (url) => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(decodeURIComponent(url.split('/').pop()))}?width=400`;
console.log(`  ${noPic.length} without a thumbnail, ${pic.size} found on Wikidata`);

// Keep traits that at least two cards share; record pool frequency.
const freq = new Map();
for (const c of cards) for (const k of c.traits.keys()) freq.set(k, (freq.get(k) ?? 0) + 1);
const labels = {};
const out = [];
for (const c of cards) {
  const p = info.get(c.title);
  if (!p || p.missing) continue;
  const traits = [...c.traits.entries()].filter(([k]) => freq.get(k) >= 2);
  if (traits.length < 2) continue;
  for (const [k, l] of traits) labels[k] = labels[k] ?? l;
  out.push({
    id: c.id, kind: c.kind, title: p.title,
    description: p.description ? cap(p.description) : '',
    thumbnail: p.thumbnail?.source ?? (pic.has(c.id) ? filePath(pic.get(c.id)) : null),
    extract: p.extract ?? '',
    traits: traits.map(([k]) => k),
  });
}
// Recount on the final pool.
const counts = {};
for (const c of out) for (const k of c.traits) counts[k] = (counts[k] ?? 0) + 1;
for (const c of out) c.traits = c.traits.filter((k) => counts[k] >= 2);
const traits = Object.fromEntries(Object.entries(counts).filter(([, n]) => n >= 2).map(([k, n]) => [k, { label: labels[k], count: n }]));

mkdirSync('cards', { recursive: true });
writeFileSync('cards/pool.json', JSON.stringify({ built: new Date().toISOString(), cards: out, traits }));
console.log(`Wrote ${out.length} cards, ${Object.keys(traits).length} traits`);
