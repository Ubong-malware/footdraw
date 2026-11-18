// FootDraw core rules, shared by the browser (solo modes) and the server (multiplayer).
export const BONUS = {
  Flush: 150, 'Four of a Kind': 100, 'Full House': 75, 'Three of a Kind': 30,
  'Two Pair': 25, Pair: 5, 'High Card': 0,
};
export const HANDS = Object.keys(BONUS);

export function hashString(s) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return (h ^ (h >>> 16)) >>> 0;
}
export function rng(seed) {
  let a = typeof seed === 'number' ? seed : hashString(String(seed));
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle(arr, rand = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Points for k cards sharing a trait that `count` of `poolSize` cards have. Rarer + bigger = more.
export function traitPoints(k, count, poolSize) {
  const rarity = Math.log2(poolSize / count);
  return Math.max(0, Math.round((rarity - 2) * k * k * 1.2));
}

// Pick the best two disjoint groups (same logic as the original game's suit marks).
export function suitGroups(matches) {
  const size = (m) => m?.cards.length ?? 0, pts = (m) => m?.points ?? 0;
  const [best] = matches.map((first) => {
    const [second] = matches.filter((m) => !m.cards.some((c) => first.cards.includes(c)))
      .sort((a, b) => size(b) - size(a) || pts(b) - pts(a));
    return { first, second };
  }).sort((a, b) => size(b.first) - size(a.first) || size(b.second) - size(a.second)
    || pts(b.first) + pts(b.second) - pts(a.first) - pts(a.second));
  return best ?? {};
}

// Very common traits (held by more than 1/SHAPE_SHARE of the pool, e.g. "Forward") still score their
// (tiny) points but don't count toward the hand shape, so Flush/Four of a Kind stay meaningful.
export const SHAPE_SHARE = 8;
export function classify(matches) {
  const { first, second } = suitGroups(matches.filter((m) => m.shape !== false));
  const a = first?.cards.length ?? 0, b = second?.cards.length ?? 0;
  if (a >= 5) return 'Flush';
  if (a === 4) return 'Four of a Kind';
  if (a === 3 && b >= 2) return 'Full House';
  if (a === 3) return 'Three of a Kind';
  if (a === 2 && b === 2) return 'Two Pair';
  if (a === 2) return 'Pair';
  return 'High Card';
}

// cards: [{traits:[...]}], meta: {traits:{key:{label,count}}, size}
export function scoreHand(cards, meta) {
  const groups = new Map();
  cards.forEach((c, i) => c.traits.forEach((t) => {
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(i);
  }));
  const matches = [];
  for (const [id, idx] of groups) {
    if (idx.length < 2) continue;
    const info = meta.traits[id] ?? { label: id, count: meta.size };
    matches.push({ id, label: info.label, cards: idx, points: traitPoints(idx.length, info.count, meta.size), shape: info.count <= meta.size / SHAPE_SHARE });
  }
  matches.sort((a, b) => b.cards.length - a.cards.length || b.points - a.points || a.label.localeCompare(b.label));
  const hand = classify(matches);
  const points = matches.reduce((s, m) => s + m.points, 0) + BONUS[hand];
  return { hand, points, matches };
}

export function compareResults(a, b) {
  return b.points - a.points || HANDS.indexOf(a.hand) - HANDS.indexOf(b.hand);
}

// Best 5-card hand that could be built from a deck (used for the solo "best hand in your deck").
export function bestHand(deck, meta) {
  let best = null;
  const n = deck.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++)
    for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
      const cards = [deck[a], deck[b], deck[c], deck[d], deck[e]];
      const r = scoreHand(cards, meta);
      if (!best || r.points > best.points) best = { ...r, cards };
    }
  return best;
}

// Build a deck that has things in common: a few themes (traits shared by several cards), then random fill.
// Deck builder. A deck has a balanced mix of card types (mostly players, plus clubs, national teams and
// competitions), 2–3 hidden "themes" (traits several cards share, so hands can actually form pairs and trips), and
// the rest drawn at random. `exclude` (a Set of ids) keeps recently seen cards out when the pool allows it.
export const DECK_MIX = { player: 8, club: 3, nation: 2, event: 2 };
export function makeDeck(pool, meta, size, rand, { exclude = null } = {}) {
  const fresh = exclude?.size ? pool.filter((c) => !exclude.has(c.id)) : pool;
  const src = fresh.length >= size * 20 ? fresh : pool;
  // Type quota for this deck: the base mix, nudged at random so decks don't all look alike.
  const scale = size / 15;
  const quota = Object.fromEntries(Object.entries(DECK_MIX).map(([k, v]) => [k, Math.max(1, Math.round(v * scale))]));
  const kinds = Object.keys(quota);
  for (let n = 0; n < 2; n++) { const from = kinds[Math.floor(rand() * kinds.length)], to = kinds[Math.floor(rand() * kinds.length)]; if (quota[from] > 1) { quota[from]--; quota[to]++; } }
  const total = Object.values(quota).reduce((a, b) => a + b, 0);
  quota.player += size - total;
  const left = { ...quota }, chosen = new Map();
  const take = (c) => { if (chosen.size >= size || chosen.has(c.id) || !(left[c.kind] > 0)) return false; chosen.set(c.id, c); left[c.kind]--; return true; };
  const themes = shuffle(Object.entries(meta.traits).filter(([, t]) => t.count >= 5 && t.count <= meta.size / 8), rand);
  const nThemes = 2 + (rand() < 0.5 ? 1 : 0);
  let used = 0;
  for (const [key] of themes) {
    if (used >= nThemes) break;
    const holders = shuffle(src.filter((c) => c.traits.includes(key) && !chosen.has(c.id) && left[c.kind] > 0), rand);
    if (holders.length < 2) continue;
    const want = 2 + Math.floor(rand() * 3);
    let got = 0; for (const c of holders) { if (got >= want) break; if (take(c)) got++; }
    if (got >= 2) used++;
  }
  for (const c of shuffle(src, rand)) { if (chosen.size >= size) break; take(c); }
  for (const c of shuffle(pool, rand)) { if (chosen.size >= size) break; if (!chosen.has(c.id)) chosen.set(c.id, c); } // tiny pools
  return shuffle([...chosen.values()], rand);
}

export function shareText(brand, title, hand, points, stages) {
  const rows = stages.map((s) => {
    const { first, second } = suitGroups(s.matches.filter((m) => m.shape !== false));
    return Array.from({ length: 5 }, (_, i) => first?.cards.includes(i) ? '♥️' : second?.cards.includes(i) ? '♣️' : '⬜').join('');
  });
  return `${brand} ${title}\n${hand} 🃏\n${rows.join('\n')}\n${points} pts`;
}
