// Builds public/data/pool.json: the FootDraw card pool.
// Sources: Wikidata SPARQL (traits) + Wikipedia Action API (titles, descriptions, thumbnails, extracts).
// Run: node scripts/build-data.mjs   (no API keys needed)
import { writeFileSync, mkdirSync } from 'node:fs';

const UA = 'FootDraw/1.0 (static card game build script; https://example.org/footdraw)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sparql(query, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch('https://query.wikidata.org/sparql', {
      method: 'POST',
      headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ query }),
    });
    if (res.ok) return (await res.json()).results.bindings;
    console.warn('sparql', res.status, 'retrying');
    await sleep(3000 * (i + 1));
  }
  throw new Error('SPARQL failed');
}
const qid = (uri) => uri.split('/').pop();
const titleFromUrl = (u) => decodeURIComponent(u.split('/wiki/')[1]).replace(/_/g, ' ');

async function listCards(kind, where, limit, minSl = 20) {
  const rows = await sparql(`SELECT ?x ?sl WHERE { ${where} ?x wikibase:sitelinks ?sl. FILTER(?sl > ${minSl}) }`);
  const seen = new Set();
  const top = rows.filter((r) => !seen.has(r.x.value) && seen.add(r.x.value))
    .map((r) => ({ id: qid(r.x.value), kind, sitelinks: +r.sl.value }))
    .sort((a, b) => b.sitelinks - a.sitelinks).slice(0, Math.round(limit * 1.15));
  const titles = new Map();
  for (let i = 0; i < top.length; i += 150) {
    const values = top.slice(i, i + 150).map((c) => `wd:${c.id}`).join(' ');
    for (const r of await sparql(`SELECT ?x ?article WHERE { VALUES ?x { ${values} } ?article schema:about ?x; schema:isPartOf <https://en.wikipedia.org/>. }`))
      titles.set(qid(r.x.value), titleFromUrl(r.article.value));
  }
  return top.filter((c) => titles.has(c.id)).slice(0, limit).map((c) => ({ ...c, title: titles.get(c.id) }));
}

console.log('Listing cards…');
const players = await listCards('player', '?x wdt:P106 wd:Q937857.', 520, 40);
const clubs = await listCards('club', '?x wdt:P31 wd:Q476028.', 90, 60);
const nations = await listCards('nation', '?x wdt:P31 wd:Q135408445.', 40, 60);
const wc = await listCards('event', '?x wdt:P3450 wd:Q19317.', 22);
const euro = await listCards('event', '?x wdt:P3450 wd:Q260858.', 12);
const ucl = await listCards('event', '?x wdt:P3450 wd:Q18756.', 10);
let cards = [...players, ...clubs, ...nations, ...wc, ...euro, ...ucl];
const byId = new Map(cards.map((c) => [c.id, c]));
cards.forEach((c) => (c.traits = new Map()));
console.log({ players: players.length, clubs: clubs.length, nations: nations.length, events: wc.length + euro.length + ucl.length });

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
for (const r of await props(P, '?item wdt:P569 ?v.')) {
  const y = parseInt(r.v, 10);
  if (y) add(byId.get(r.item), `born:${Math.floor(y / 10) * 10}s`, `Born in the ${Math.floor(y / 10) * 10}s`);
}
for (const r of await props(P, '?item wdt:P106 ?v. FILTER(?v != wd:Q937857)')) add(byId.get(r.item), `occ:${r.v}`, cap(r.label));

console.log('Club traits…');
for (const id of [...C, ...N, ...E]) add(byId.get(id), `team:${id}`, byId.get(id).kind === 'event' ? null : byId.get(id).title);
for (const id of E) add(byId.get(id), `event:${id}`, byId.get(id).title);
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
for (const r of await props(E, '?item wdt:P276 ?v.')) add(byId.get(r.item), `venue:${r.v}`, r.label);
// Nations that won a tournament share the tournament.
for (const r of await props(N, '?v wdt:P1346 ?item.')) add(byId.get(r.item), `event:${r.v}`, r.label);

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
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  const j = await res.json();
  const norm = new Map();
  for (const n of [...(j.query.normalized ?? []), ...(j.query.redirects ?? [])]) norm.set(n.to, n.from);
  for (const p of j.query.pages) {
    let t = p.title; while (norm.has(t)) t = norm.get(t);
    info.set(t, p); info.set(p.title, p);
  }
  await sleep(150);
}

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
    thumbnail: p.thumbnail?.source ?? null,
    extract: p.extract ?? '',
    traits: traits.map(([k]) => k),
  });
}
// Recount on the final pool.
const counts = {};
for (const c of out) for (const k of c.traits) counts[k] = (counts[k] ?? 0) + 1;
for (const c of out) c.traits = c.traits.filter((k) => counts[k] >= 2);
const traits = Object.fromEntries(Object.entries(counts).filter(([, n]) => n >= 2).map(([k, n]) => [k, { label: labels[k], count: n }]));

mkdirSync('public/data', { recursive: true });
writeFileSync('public/data/pool.json', JSON.stringify({ built: new Date().toISOString(), cards: out, traits }));
console.log(`Wrote ${out.length} cards, ${Object.keys(traits).length} traits`);
