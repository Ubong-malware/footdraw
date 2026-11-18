// Simulates 2–6 players playing a full 10-round FootDraw match against a running server and checks invariants.
// Usage: node scripts/sim.mjs [url] [players]      (start the server with READY_COUNTDOWN_MS=300 for speed)
import { io } from 'socket.io-client';
import { randomBytes } from 'node:crypto';
import { scoreHand } from '../public/shared/game.js';
const MODE = process.env.MODE ?? 'classic'; // game mode: classic | live
const URL = process.argv[2] ?? 'http://localhost:8080';
const N = +(process.argv[3] ?? 4);
const COUNTDOWN = +(process.env.READY_COUNTDOWN_MS ?? 3000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) { console.error('ASSERT FAILED:', m); process.exit(1); } };
const stats = { draws: 0, keptChecked: 0, rounds: 0, staleRejected: 0, liveChecked: 0 };

function client(name, token = randomBytes(16).toString('hex')) {
  const s = io(URL, { auth: { token }, transports: ['websocket'], forceNew: true });
  const c = { name, token, s, state: null, busy: false };
  s.on('state', (st) => {
    c.state = st;
    assert(st.roundMs === +(process.env.ROUND_MS ?? 90000), `round timer should be 90000 ms (1:30), got ${st.roundMs}`);
    assert(st.mode === MODE, `room mode ${st.mode}, expected ${MODE}`);
    if (st.match) assert(st.match.mode === MODE, `match mode ${st.match.mode}, expected ${MODE}`);
    const yu = st.match?.you;
    if (yu) {
      if (MODE === 'live') {
        // Live Lines: your own hand comes with traits + trait meta, and scoring it in the client gives exactly the
        // server's score once you're locked in.
        assert(yu.meta && yu.hand.every((x) => Array.isArray(x.traits)), 'live mode: hand traits/meta missing');
        const live = scoreHand(yu.hand, yu.meta);
        if (yu.done) { assert(live.points === yu.result.points && live.hand === yu.result.hand, `live score ${live.points} ≠ server ${yu.result.points}`); stats.liveChecked++; }
      } else assert(!yu.meta && yu.hand.every((x) => !('traits' in x)), 'classic mode must not send traits');
      const want = N >= 5 ? 25 : 15;
      assert(yu.deckSize === want, `deck size ${yu.deckSize}, expected ${want} for ${N} players`);
      assert(new Set(yu.hand.map((x) => x.id)).size === 5, 'hand has duplicate cards');
      if (st.match.phase === 'playing') for (const seat of st.seats) assert(typeof seat.lockedIn === 'boolean' || seat.status === 'Spectating', 'seat lock-in flag');
    }
    const y = st.match?.you;
    if (y) {
      const ids = y.hand.map((x) => x.id);
      assert(new Set(ids).size === 5, `${name}: duplicate card in hand`);
      const key = `${st.match.no}:${st.match.round}`;
      if (c.key === key && c.hand) {
        // Kept-card integrity: a position may only change if we discarded it in our last request.
        ids.forEach((id, i) => { if (id !== c.hand[i]) assert(c.allowed?.has(i), `${name}: KEPT card at ${i} changed ${c.hand[i]} → ${id}`); });
        if (ids.some((id, i) => id !== c.hand[i])) { assert([...c.allowed].sort().join() === [...y.lastNew].sort().join(), `${name}: lastNew mismatch`); c.allowed = null; stats.keptChecked++; }
      }
      c.key = key; c.hand = ids;
      if (y.done) c.final = { key, ids, points: y.result.points };
    }
  });
  c.emit = (ev, data) => new Promise((res) => s.emit(ev, data, res));
  return c;
}

const players = Array.from({ length: N }, (_, i) => client(`Bot${i + 1}`));
await Promise.all(players.map((p) => new Promise((r) => p.s.on('connect', r))));
const created = await players[0].emit('create', { name: players[0].name, mode: MODE });
assert(created.ok && created.mode === MODE, 'create room');
const info = await (await fetch(`${URL}/api/room/${created.code}`)).json();
assert(info.mode === MODE, 'invite info shows the room mode'); const code = created.code; console.log('room', code);
for (const p of players.slice(1)) assert((await p.emit('join', { code, name: p.name })).ok, `join ${p.name}`);
if (N === 6) {
  const extra = client('Extra'); await new Promise((r) => extra.s.on('connect', r));
  const r = await extra.emit('join', { code, name: 'Extra' }); assert(r.error?.includes('full'), '7th rejected'); extra.s.close();
  console.log('  7th player rejected ✓');
}
await sleep(150);
const noMatch = () => !players[0].state.match;
const ready = (p, v = true) => p.emit('ready', { ready: v });
assert(!JSON.stringify(players[0].state).match(/chip|balance|"pot"/i), 'no chip/pot fields in state');

// --- Ready-up: one ready player must NOT start the match ---
await ready(players[0]); await sleep(COUNTDOWN + 400);
assert(noMatch(), 'one ready player started the match');
console.log(`  1/${N} ready → no start ✓`);
for (const p of players.slice(1, -1)) await ready(p);
await sleep(COUNTDOWN + 400);
assert(noMatch(), 'all-but-one ready started the match');
await ready(players.at(-1)); await sleep(80);
assert(players[0].state.nextAt, 'countdown when all ready');
await ready(players.at(-1), false); await sleep(COUNTDOWN + 400);
assert(noMatch(), 'un-ready did not cancel');
console.log('  un-ready cancels countdown ✓');
await ready(players.at(-1));
const t0 = Date.now(); while (noMatch() && Date.now() - t0 < COUNTDOWN + 3000) await sleep(30);
assert(!noMatch(), 'match did not start when all ready');
console.log(`  all ${N} ready → match starts ✓`);

// --- Play 10 rounds ---
const roundScores = Object.fromEntries(players.map((p) => [p.name, []]));
let reconnected = false; let lastRound = 0; const deadline = Date.now() + 240000;
while (Date.now() < deadline) {
  const m0 = players[0].state.match;
  if (m0?.phase === 'final') break;
  for (const p of players) {
    const st = p.state; const m = st.match; if (!m || p.busy) continue;
    if (m.phase === 'playing' && m.you && !m.you.done) {
      p.busy = true;
      if (!reconnected && m.round === 3 && p === players[1]) {
        // Drop + reconnect mid-round with the same token: the hand must be identical afterwards.
        const before = m.you.hand.map((x) => x.id).join();
        p.s.disconnect(); await sleep(200);
        const again = client(p.name, p.token); players[1] = again;
        await new Promise((r) => again.s.on('connect', r));
        assert((await again.emit('join', { code, name: p.name })).ok, 'rejoin'); await sleep(150);
        assert(again.state.match.you.hand.map((x) => x.id).join() === before, 'hand changed across reconnect');
        console.log('  reconnect mid-round: same seat, same hand ✓'); reconnected = true; continue;
      }
      const roll = Math.random();
      if (roll < 0.2) { assert((await p.emit('stand')).ok, 'stand'); }
      else {
        const n = 1 + Math.floor(Math.random() * 4);
        const indices = [0, 1, 2, 3, 4].sort(() => Math.random() - 0.5).slice(0, n);
        const expect = m.you.hand.map((x) => x.id);
        p.allowed = new Set(indices);
        const r = await p.emit('discard', { indices, expect, step: m.you.step });
        assert(r.ok, `discard failed: ${r.error}`); stats.draws++;
        // A duplicate (double-click) submit for the same step must be rejected and change nothing.
        if (Math.random() < 0.3) {
          const dup = await p.emit('discard', { indices, expect, step: m.you.step });
          assert(dup.error, 'duplicate discard was accepted'); stats.staleRejected++;
        }
      }
      p.busy = false;
    } else if (m.phase === 'roundEnd' && !st.seats.find((s) => s.isYou).readyUp) {
      p.busy = true; await ready(p); p.busy = false;
    }
  }
  // Round finished: check results against what each player held.
  const m = players[0].state.match;
  if (m && m.phase !== 'playing' && m.last && m.last.round !== lastRound) {
    lastRound = m.last.round; stats.rounds++;
    for (const p of players) {
      const res = m.last.results.find((r) => r.name === p.name);
      assert(res, `${p.name} missing from round results`);
      const shown = res.cards.map((x) => x.id);
      if (p.final?.key === `${m.no}:${m.last.round}`) {
        assert(shown.join() === p.final.ids.join(), `${p.name}: results show different cards than the final hand`);
        assert(res.points === p.final.points, `${p.name}: result points differ`);
      } else {
        // Our last discard ended the round, so we never saw the post-draw hand: only discarded slots may differ.
        assert(p.key === `${m.no}:${m.last.round}`, `${p.name}: no hand seen this round`);
        shown.forEach((id, i) => { if (id !== p.hand[i]) assert(p.allowed?.has(i), `${p.name}: KEPT card at ${i} changed in results`); });
        assert([...(p.allowed ?? [])].sort().join() === [...res.newIdx].sort().join() || shown.join() === p.hand.join(), `${p.name}: newIdx mismatch in results`);
        p.allowed = null; stats.keptChecked++;
      }
      roundScores[p.name].push(res.points);
    }
    // League table: totals = sum of round scores, sorted by total desc.
    for (const row of m.table) {
      assert(row.total === roundScores[row.name].reduce((a, b) => a + b, 0), `${row.name}: total ${row.total} ≠ sum of rounds`);
      assert(row.rounds.join() === roundScores[row.name].join(), `${row.name}: round history mismatch`);
    }
    for (let i = 1; i < m.table.length; i++) assert(m.table[i - 1].total >= m.table[i].total, 'table not sorted by total');
    assert(m.table.reduce((a, r) => a + r.roundsWon, 0) === m.last.round, 'exactly one round winner per round');
    console.log(`  round ${m.last.round}: ${m.table.map((r) => `${r.pos}. ${r.name} ${r.total}`).join(' | ')}`);
  }
  await sleep(25);
}
const fm = players[0].state.match;
assert(fm?.phase === 'final' && fm.round === 10 && stats.rounds === 10, `match should finish after 10 rounds (phase ${fm?.phase}, round ${fm?.round})`);
assert(fm.champion === fm.table[0].name && fm.championPts === fm.table[0].total, 'champion is top of the table');
console.log(`  🏆 champion: ${fm.champion}${fm.championWhy ? ` (${fm.championWhy})` : ''}`);
if (MODE === 'live') assert(stats.liveChecked >= N, 'live score checks ran');
const saved = await (await fetch(`${URL}/api/match/${code}/1`)).json();
assert(saved.mode === MODE, `saved results mode ${saved.mode}`);
console.log(`mode ${MODE}: ${stats.liveChecked} live-score = server-score checks`);
console.log(`kept-card checks: ${stats.keptChecked} draws verified, ${stats.staleRejected} duplicate submits rejected, ${stats.rounds} rounds verified`);
console.log(`PASS: ${N} players, full ${fm.round}-round match (${N >= 5 ? 25 : 15}-card decks)`);
players.forEach((p) => p.s.close());
process.exit(0);
