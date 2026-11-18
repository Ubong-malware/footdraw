// Post-processes cards/pool.json: tidy labels, cap noisy trait types per card, drop unshared traits.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const file = 'cards/pool.json';
const d = JSON.parse(readFileSync(file, 'utf8'));
const CAP = { award: 3, event: 4, team: 6, pos: 2, occ: 2, city: 1, venue: 1, league: 2, country: 2, comp: 2, founded: 1, decade: 1, born: 1 };
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
// --- Remove non-footballers ---
// 1) Manual denylist (titles or QIDs).
const deny = new Set(readFileSync('scripts/denylist.txt', 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean));
// 2) Senior career check from scripts/player-audit.json (built by scripts/audit-players.mjs): players need at least
//    MIN_APPS recorded senior club appearances + caps on Wikidata, which drops singers/actors/politicians whose only
//    football was a youth or amateur spell.
const MIN_APPS = 20;
// Many lesser-known players have no appearance counts on Wikidata at all; they stay if they had 2+ senior teams and
// aren't mainly famous for something else.
const OTHER_FAME = /singer|actor|actress|politician|writer|novelist|musician|rapper|comedian|presenter|philosopher|businessperson|model|poet|composer|monarch|priest|pope/i;
const audit = existsSync('scripts/player-audit.json') ? JSON.parse(readFileSync('scripts/player-audit.json', 'utf8')) : {};
const removed = [];
d.cards = d.cards.filter((c) => {
  const a = audit[c.id];
  const why = deny.has(c.title) || deny.has(c.id) ? 'denylist'
    : c.kind === 'player' && a && a.apps + a.caps < MIN_APPS && (OTHER_FAME.test(a.occ.join("|")) || a.teams < 2) ? `only ${a.apps + a.caps} senior apps/caps` : null;
  if (why) removed.push(`${c.title} (${why})`);
  return !why;
});
if (removed.length) console.log(`Removed ${removed.length} non-footballers: ${removed.join('; ')}`);
// Balance nations: no single country may supply more than ~8% of the player cards (keeps the best-known ones,
// which come first in the build order).
{
  const players = d.cards.filter((c) => c.kind === 'player');
  const cap = Math.max(120, Math.round(players.length * 0.08)), per = {}, cut = new Set();
  for (const c of players) { const k = c.traits.find((t) => t.startsWith('country:')) ?? 'none'; per[k] = (per[k] ?? 0) + 1; if (per[k] > cap) cut.add(c.id); }
  d.cards = d.cards.filter((c) => !cut.has(c.id));
  if (cut.size) console.log(`Country balance: dropped ${cut.size} players over the ${cap}-per-country cap`);
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
