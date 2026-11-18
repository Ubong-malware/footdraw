// Fetches occupations + senior career size for every player card, writes scripts/player-audit.json.
import { readFileSync, writeFileSync } from 'node:fs';
const UA = 'FootDraw/1.0 (data audit)';
const d = JSON.parse(readFileSync('cards/pool.json', 'utf8'));
const ids = d.cards.filter((c) => c.kind === 'player').map((c) => c.id);
async function sparql(q) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch('https://query.wikidata.org/sparql', { method: 'POST', headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ query: q }) });
    if (r.ok) return (await r.json()).results.bindings;
    await new Promise((res) => setTimeout(res, 3000 * (i + 1)));
  }
  throw new Error('sparql failed');
}
const out = Object.fromEntries(ids.map((id) => [id, { occ: [], apps: 0, caps: 0, teams: 0 }]));
for (let i = 0; i < ids.length; i += 100) {
  const V = ids.slice(i, i + 100).map((x) => `wd:${x}`).join(' ');
  for (const r of await sparql(`SELECT ?p ?oLabel WHERE { VALUES ?p { ${V} } ?p wdt:P106 ?o. SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }`))
    out[r.p.value.split('/').pop()].occ.push(r.oLabel.value);
  // Matches played (P1350) per team statement; national teams counted as caps.
  for (const r of await sparql(`SELECT ?p ?team ?apps ?isNat WHERE { VALUES ?p { ${V} } ?p p:P54 ?st. ?st ps:P54 ?team.
      OPTIONAL { ?st pq:P1350 ?apps. } BIND(EXISTS { ?team wdt:P31/wdt:P279* wd:Q6979593 } AS ?isNat) }`)) {
    const o = out[r.p.value.split('/').pop()];
    o.teams++;
    const n = +(r.apps?.value ?? 0);
    if (r.isNat.value === 'true') o.caps += n; else o.apps += n;
  }
}
writeFileSync('scripts/player-audit.json', JSON.stringify(out, null, 1));
console.log('audited', ids.length);
