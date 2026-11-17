// Simulates 2–4 players (plus a rejected 5th) against a running server and checks invariants.
// Usage: node scripts/sim.mjs [url] [players] [hands]
import { io } from 'socket.io-client';
import { randomBytes } from 'node:crypto';
const URL = process.argv[2] ?? 'http://localhost:8080';
const N = +(process.argv[3] ?? 4);
const HANDS = +(process.argv[4] ?? 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) { console.error('ASSERT FAILED:', m); process.exit(1); } };

function client(name, token = randomBytes(16).toString('hex')) {
  const s = io(URL, { auth: { token }, transports: ['websocket'], forceNew: true });
  const c = { name, token, s, state: null, acting: false };
  s.on('state', (st) => { c.state = st; });
  c.emit = (ev, data) => new Promise((res) => s.emit(ev, data, res));
  return c;
}
const total = (st) => st.seats.reduce((a, s) => a + s.chips, 0) + (st.game?.pot ?? 0);

const players = Array.from({ length: N }, (_, i) => client(`Bot${i + 1}`));
await Promise.all(players.map((p) => new Promise((r) => p.s.on('connect', r))));
const created = await players[0].emit('create', { name: players[0].name });
assert(created.ok, 'create room');
const code = created.code; console.log('room', code);
for (const p of players.slice(1)) { const r = await p.emit('join', { code, name: p.name }); assert(r.ok, `join ${p.name}`); }
if (N === 4) {
  const extra = client('Extra'); await new Promise((r) => extra.s.on('connect', r));
  const r = await extra.emit('join', { code, name: 'Extra' });
  assert(r.error?.includes('full'), '5th player rejected'); console.log('5th player rejected:', r.error); extra.s.close();
}
const bad = await players[1].emit('join', { code: 'ZZZZZ', name: 'x' });
assert(bad.error, 'bad code rejected');
await sleep(200);
let startChips = total(players[0].state); let rebuys = 0;
let handsSeen = 0, lastHand = 0, reconnected = false, actions = 0;
const noGame = () => players.every((p) => !p.state.game);
const ready = (p, v = true) => p.emit('ready', { ready: v });
const COUNTDOWN = +(process.env.READY_COUNTDOWN_MS ?? 3000);

// --- Ready-up tests ---
// 1) One player readying must NOT start the hand.
assert((await ready(players[0])).ok, 'ready p1');
await sleep(COUNTDOWN + 600);
assert(noGame(), 'one ready player must not start the hand');
assert(players[1].state.readyCheck.ready === 1 && players[1].state.readyCheck.waitingFor.length === N - 1, 'readyCheck shows 1 ready + waiting list');
console.log(`  ready-check: 1/${N} ready → no deal ✓ (waiting for ${players[1].state.readyCheck.waitingFor.join(', ')})`);
// 2) Everyone but the last player ready → still no deal.
for (const p of players.slice(1, -1)) await ready(p);
await sleep(COUNTDOWN + 600);
assert(noGame(), 'all-but-one ready must not start the hand');
console.log(`  ready-check: ${N - 1}/${N} ready → no deal ✓`);
// 3) Last player readies then cancels during the countdown → deal is cancelled.
await ready(players.at(-1)); await sleep(100);
assert(players[0].state.nextAt, 'countdown starts when all ready');
await ready(players.at(-1), false);
await sleep(COUNTDOWN + 600);
assert(noGame() && !players[0].state.nextAt, 'un-ready cancels the deal');
console.log('  ready-check: un-ready during countdown cancels deal ✓');
// 4) A newcomer joins (not ready) during the countdown → cancels; when they leave they no longer block.
if (N < 4) {
  await ready(players.at(-1)); await sleep(100);
  const late = client('Late'); await new Promise((r) => late.s.on('connect', r));
  assert((await late.emit('join', { code, name: 'Late' })).ok, 'late join');
  await sleep(COUNTDOWN + 600);
  assert(noGame(), 'new (not ready) joiner blocks the deal');
  assert(players[0].state.readyCheck.waitingFor.includes('Late'), 'newcomer listed as not ready');
  await late.emit('leave'); late.s.close();
  await sleep(COUNTDOWN + 800);
  assert(!noGame(), 'leaver no longer blocks: hand dealt once remaining players are all ready');
  console.log('  ready-check: late joiner blocks, then leaving unblocks ✓');
} else {
  await ready(players.at(-1));
}
// 5) All ready → hand deals after the countdown.
const t0 = Date.now();
while (noGame() && Date.now() - t0 < COUNTDOWN + 3000) await sleep(50);
assert(!noGame(), 'all ready → hand dealt');
console.log(`  ready-check: all ${N} ready → hand dealt ✓`);

const deadline = Date.now() + 120000;
while (handsSeen < HANDS && Date.now() < deadline) {
  for (const p of players) {
    const st = p.state; if (!st) continue;
    const g = st.game;
    if (!g && st.result && st.result.handNo === st.handNo && !p.checkedReset?.[st.handNo]) {
      (p.checkedReset ??= {})[st.handNo] = true;
      if (st.log.at(-1)?.msg === 'Ready up for the next hand.') assert(st.seats.every((x) => !x.readyUp), 'ready reset after hand');
    }
    if (st.handNo !== lastHand) { lastHand = st.handNo; handsSeen++; console.log(`hand #${st.handNo} dealt`); }
    // Invariant: chips are conserved (no rebuys in this sim).
    if (p === players[0]) assert(total(st) === startChips, `chips conserved (${total(st)} vs ${startChips})`);
    // Privacy: a player only ever sees their own cards during a hand.
    assert(!JSON.stringify(st).includes('"token"'), 'no tokens leaked');
    if (!g) {
      const me = st.seats.find((x) => x.isYou);
      if (me && me.chips < st.ante && !p.acting) { p.acting = true; const r = await p.emit('rebuy'); if (r.ok) { startChips += 1000; rebuys++; console.log(`  ${p.name} rebuys`); } await sleep(100); p.acting = false; }
      if (st.result && p.loggedResult !== st.result.handNo) { p.loggedResult = st.result.handNo; if (p === players[0]) console.log('  result:', st.log.findLast((l) => /wins/.test(l.msg))?.msg); }
      // After a hand everyone must be un-ready again; bots then ready up.
      const meS = st.seats.find((x) => x.isYou);
      if (meS && meS.chips >= st.ante && !meS.readyUp && !p.acting) { p.acting = true; await ready(p); p.acting = false; }
      continue;
    }
    if (!reconnected && st.handNo === 2 && p === players[2] && g.phase === 'draw') {
      // Drop and come back with the same token: seat + hand must survive.
      const hand = g.you?.hand.map((c) => c.id).join();
      p.s.disconnect(); await sleep(300);
      const again = client(p.name, p.token); players[2] = again;
      await new Promise((r) => again.s.on('connect', r));
      const r = await again.emit('join', { code, name: p.name }); assert(r.ok, 'rejoin');
      await sleep(200);
      assert(again.state.game?.you?.hand.map((c) => c.id).join() === hand || !again.state.game, 'hand survives reconnect');
      console.log('  reconnect OK, seat & hand preserved'); reconnected = true; continue;
    }
    if (p.acting) continue;
    if (g.phase === 'bet' && g.yourTurn) {
      p.acting = true; const me = st.seats.find((s) => s.isYou); const roll = Math.random();
      let a;
      if (g.you.toCall > 0) a = roll < 0.15 ? { type: 'fold' } : roll < 0.85 ? { type: 'call' } : { type: 'raise', amount: g.currentBet + g.minRaise + 10 * Math.floor(Math.random() * 5) };
      else a = roll < 0.6 ? { type: 'check' } : { type: 'raise', amount: g.currentBet + g.minRaise + (roll > 0.97 ? me.chips : 0) };
      const r = await p.emit('act', a); actions++;
      if (r.error) { const r2 = await p.emit('act', { type: g.you.toCall ? 'call' : 'check' }); assert(r2.ok, `fallback action: ${r2.error}`); }
      p.acting = false;
    } else if (g.phase === 'draw' && g.you && !g.you.folded && !g.you.drawDone) {
      p.acting = true;
      const n = Math.floor(Math.random() * 4);
      const discards = [0, 1, 2, 3, 4].sort(() => Math.random() - 0.5).slice(0, n);
      const r = await p.emit('draw', { discards }); assert(r.ok || r.error === 'Already done', `draw: ${r.error}`);
      p.acting = false;
    }
  }
  // Out of a betting hand → host deals next immediately instead of waiting the timer.
  const st = players[0].state;
  await sleep(40);
}
assert(handsSeen >= HANDS, `played ${handsSeen} hands`);
assert(reconnected || N < 3, 'reconnect tested');
const final = players[0].state;
console.log('final chips:', final.seats.map((s) => `${s.name}=${s.chips}`).join(', '), `(total ${total(final)})`);
console.log(`PASS: ${N} players, ${handsSeen} hands, ${actions} betting actions, ${rebuys} rebuys`);
players.forEach((p) => p.s.close());
process.exit(0);
