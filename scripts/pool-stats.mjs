// Card pool health report: counts by type, trait distribution, deck type mix, and how often hands form pairs/trips.
// Usage: node scripts/pool-stats.mjs [cards/pool.json] [decks=1500]
import { readFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { scoreHand, bestHand, makeDeck, HANDS, shuffle } from '../public/shared/game.js';
const d = JSON.parse(readFileSync(process.argv[2] ?? 'cards/pool.json', 'utf8'));
const N = +(process.argv[3] ?? 1500);
const meta = { traits: d.traits, size: d.cards.length };
const rand = () => randomInt(2 ** 32) / 2 ** 32;
const pct = (n, t) => `${((n / t) * 100).toFixed(1)}%`;
const kinds = {}; for (const c of d.cards) kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
const types = {}; for (const k of Object.keys(d.traits)) { const t = k.split(':')[0]; types[t] = (types[t] ?? 0) + 1; }
const counts = Object.values(d.traits).map((t) => t.count).sort((a, b) => a - b);
const q = (p) => counts[Math.floor(p * (counts.length - 1))];
const withPic = d.cards.filter((c) => c.thumbnail).length;
console.log(`Cards: ${d.cards.length}`, kinds, `· with image: ${withPic} (${pct(withPic, d.cards.length)})`);
console.log(`Traits: ${counts.length}`, types);
console.log(`Trait sizes: median ${q(0.5)}, p75 ${q(0.75)}, p90 ${q(0.9)}, p99 ${q(0.99)}, max ${counts.at(-1)} · scoring-eligible (5..N/8): ${counts.filter((c) => c >= 5 && c <= meta.size / 8).length}`);
console.log(`Avg traits/card: ${(d.cards.reduce((s, c) => s + c.traits.length, 0) / d.cards.length).toFixed(1)}`);
const top = Object.entries(d.traits).sort((a, b) => b[1].count - a[1].count).slice(0, 12).map(([, t]) => `${t.label} (${t.count})`);
console.log('Most common traits:', top.join(', '));

// Simple player: keep the cards that share the best trait group, swap the rest, twice.
function play(deck) {
  let hand = deck.slice(0, 5), pos = 5;
  for (let k = 0; k < 2; k++) {
    const r = scoreHand(hand, meta);
    const keep = new Set((r.matches[0]?.cards ?? []).concat(r.matches[1]?.cards ?? []));
    const swap = [0, 1, 2, 3, 4].filter((i) => !keep.has(i));
    if (!swap.length) break;
    for (const i of swap) hand[i] = deck[pos++];
  }
  return scoreHand(hand, meta);
}
const dealt = {}, played = {}, best = {}, mix = {}; let pts = 0;
const seenAll = new Map(); let recent = new Set(), repeatsRecent = 0;
for (let i = 0; i < N; i++) {
  const deck = makeDeck(d.cards, meta, 15, rand, { exclude: recent });
  for (const c of deck) { if (recent.has(c.id)) repeatsRecent++; seenAll.set(c.id, (seenAll.get(c.id) ?? 0) + 1); }
  recent = new Set([...recent, ...deck.map((c) => c.id)].slice(-450));
  const k = {}; for (const c of deck) k[c.kind] = (k[c.kind] ?? 0) + 1;
  const key = ['player', 'club', 'nation', 'event'].map((x) => k[x] ?? 0).join('/'); mix[key] = (mix[key] ?? 0) + 1;
  const h = scoreHand(deck.slice(0, 5), meta).hand; dealt[h] = (dealt[h] ?? 0) + 1;
  const p = play(deck); played[p.hand] = (played[p.hand] ?? 0) + 1; pts += p.points;
  if (i < 300) { const b = bestHand(deck, meta).hand; best[b] = (best[b] ?? 0) + 1; }
}
const row = (o, t) => HANDS.map((h) => `${h} ${pct(o[h] ?? 0, t)}`).join(' · ');
console.log(`\n${N} decks`);
console.log('Dealt 5:      ', row(dealt, N));
console.log('After 2 draws:', row(played, N), `· avg ${Math.round(pts / N)} pts`);
console.log('Best in deck: ', row(best, Math.min(N, 300)));
console.log('Type mix (players/clubs/nations/events):', Object.entries(mix).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${pct(v, N)}`).join(', '));
console.log(`Distinct cards dealt: ${seenAll.size} of ${d.cards.length} · repeats within a player's last 30 decks: ${repeatsRecent}`);
if (process.argv.includes('--samples')) for (let i = 0; i < 3; i++) {
  const deck = makeDeck(d.cards, meta, 15, rand);
  console.log(`\nSample deck ${i + 1}:`, deck.map((c) => `${c.title} [${c.kind}]`).join(' · '));
  const b = bestHand(deck, meta); console.log(`  best hand: ${b.hand}, ${b.points} pts: ${b.cards.map((c) => c.title).join(', ')} — ${b.matches.slice(0, 3).map((m) => `${m.label} ×${m.cards.length}`).join(', ')}`);
}
