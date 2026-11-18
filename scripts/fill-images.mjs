// Fills remaining missing images: competition/edition cards get their own logo or their competition's logo
// (Wikidata P154 / P18 via the series P3450); players get a Wikidata image (P18) if Wikipedia had none.
import { readFileSync, writeFileSync } from 'node:fs';
const UA = 'FootDraw/1.0 (image fill)';
const file = 'cards/pool.json';
const d = JSON.parse(readFileSync(file, 'utf8'));
async function sparql(q) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch('https://query.wikidata.org/sparql', { method: 'POST', signal: AbortSignal.timeout(90000), headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ query: q }) });
      if (r.ok) return (await r.json()).results.bindings;
    } catch {}
    await new Promise((res) => setTimeout(res, 3000 * (i + 1)));
  }
  return [];
}
const filePath = (u) => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(decodeURIComponent(u.split('/').pop()))}?width=400`;
const missing = d.cards.filter((c) => !c.thumbnail);
let n = 0;
for (let i = 0; i < missing.length; i += 100) {
  const V = missing.slice(i, i + 100).map((c) => `wd:${c.id}`).join(' ');
  const rows = await sparql(`SELECT ?x ?img WHERE { VALUES ?x { ${V} }
    { ?x wdt:P154 ?img } UNION { ?x wdt:P18 ?img } UNION { ?x wdt:P3450 ?s. ?s wdt:P154 ?img } UNION { ?x wdt:P41 ?img } }`);
  const best = new Map();
  for (const r of rows) { const id = r.x.value.split('/').pop(); if (!best.has(id) || /logo|crest|badge|emblem/i.test(r.img.value)) best.set(id, r.img.value); }
  for (const c of missing.slice(i, i + 100)) if (best.has(c.id)) { c.thumbnail = filePath(best.get(c.id)); n++; }
}
writeFileSync(file, JSON.stringify(d));
const left = {}; for (const c of d.cards) if (!c.thumbnail) left[c.kind] = (left[c.kind] ?? 0) + 1;
console.log(`Filled ${n} more images; still missing:`, left);
