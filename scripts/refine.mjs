// Post-processes public/data/pool.json: tidy labels, cap noisy trait types per card, drop unshared traits.
import { readFileSync, writeFileSync } from 'node:fs';
const file = 'public/data/pool.json';
const d = JSON.parse(readFileSync(file, 'utf8'));
const CAP = { award: 3, event: 4, team: 6, pos: 2, occ: 2, city: 1, venue: 1, league: 2, country: 2 };
const tidy = (l) => l.replace(/^Manager \(association football\)$/, 'Football manager').replace(/ \((?:award|stadium|association football|football|soccer|sport)\)$/i, '');
for (const t of Object.values(d.traits)) t.label = tidy(t.label);
// Drop youth / reserve sides that slip through Wikidata (e.g. "FC Barcelona Atlètic", "Real Madrid Castilla").
const RESERVE = /(Atlètic|Castilla|Juvenil|Primavera|Academy|Reserves?|Youth|Under-?\d|U-?\d\d|Olympic| [BC]$| II$| Jong )/i;
for (const [k, t] of Object.entries(d.traits)) if (k.startsWith('team:') && RESERVE.test(t.label)) delete d.traits[k];
for (const c of d.cards) c.traits = c.traits.filter((k) => d.traits[k] || !k.startsWith('team:'));
for (const c of d.cards) {
  const byType = {};
  for (const k of c.traits) (byType[k.split(':')[0]] ??= []).push(k);
  c.traits = Object.entries(byType).flatMap(([type, keys]) => {
    // Self-trait (a club/nation/event card's own id) always stays.
    const self = keys.filter((k) => k.endsWith(`:${c.id}`));
    const rest = keys.filter((k) => !self.includes(k)).sort((a, b) => d.traits[b].count - d.traits[a].count);
    return [...self, ...rest.slice(0, Math.max(0, (CAP[type] ?? 9) - self.length))];
  });
}
const counts = {};
for (const c of d.cards) for (const k of c.traits) counts[k] = (counts[k] ?? 0) + 1;
for (const c of d.cards) c.traits = c.traits.filter((k) => counts[k] >= 2);
// Players must have played for at least one club/national team in the pool (drops odd Wikidata tags).
d.cards = d.cards.filter((c) => c.traits.length >= 2 && (c.kind !== 'player' || c.traits.some((k) => k.startsWith('team:'))));
const final = {};
for (const c of d.cards) for (const k of c.traits) final[k] = (final[k] ?? 0) + 1;
d.traits = Object.fromEntries(Object.entries(final).filter(([, n]) => n >= 2).map(([k, n]) => [k, { label: d.traits[k].label, count: n }]));
for (const c of d.cards) c.traits = c.traits.filter((k) => d.traits[k]);
writeFileSync(file, JSON.stringify(d));
console.log(`Refined: ${d.cards.length} cards, ${Object.keys(d.traits).length} traits`);
