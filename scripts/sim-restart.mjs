// Regression test for "kicked out after a round": the server is killed (SIGINT, like a Fly machine stop) in the
// middle of a match and restarted. The room, the scores and each player's exact hand must survive, clients must
// rejoin automatically, and the match must continue. Also checks state payload size and message rate.
// Usage: node scripts/sim-restart.mjs   (spawns its own server on PORT 8099)
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';
import { randomBytes } from 'node:crypto';
import { rmSync, mkdtempSync } from 'node:fs';
import os from 'node:os'; import path from 'node:path';
const PORT = 8099, URL = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'fd-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) { console.error('ASSERT FAILED:', m); srv?.kill('SIGKILL'); process.exit(1); } };
let srv;
async function startServer() {
  srv = spawn('node', ['server.js'], { env: { ...process.env, PORT, DATA_DIR, READY_COUNTDOWN_MS: '300' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => srv.stdout.on('data', (d) => { if (/FootDraw on/.test(d)) r(); if (/Restored/.test(d)) console.log('  server:', String(d).trim().split('\n')[0]); }));
}
const MAX_STATE = 64 * 1024;
function client(name) {
  const token = randomBytes(16).toString('hex');
  const s = io(URL, { auth: { token }, transports: ['websocket'], reconnectionDelay: 200, reconnectionDelayMax: 1000 });
  const c = { name, s, msgs: 0, maxBytes: 0, rejoins: 0 };
  s.on('state', (st) => { c.st = st; c.msgs++; const n = JSON.stringify(st).length; c.maxBytes = Math.max(c.maxBytes, n); assert(n < MAX_STATE, `state payload ${n} bytes > ${MAX_STATE}`); });
  s.on('connect', () => { if (c.code) { c.rejoins++; s.emit('join', { code: c.code, name }, (r) => assert(r.ok, `rejoin after restart: ${r.error}`)); } });
  c.e = (ev, d) => new Promise((r) => s.emit(ev, d, r));
  return c;
}
await startServer();
const a = client('A'), b = client('B');
await Promise.all([a, b].map((c) => new Promise((r) => c.s.once('connect', r))));
const { code } = await a.e('create', { name: 'A' }); a.code = code;
assert((await b.e('join', { code, name: 'B' })).ok, 'join'); b.code = code;
const waitFor = async (fn, ms, what) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) assert(false, `timeout: ${what}`); await sleep(30); } };
for (const c of [a, b]) await c.e('ready', { ready: true });
await waitFor(() => a.st?.match?.phase === 'playing', 3000, 'match start');
// Round 1: both stand.
await a.e('stand'); await b.e('stand');
await waitFor(() => a.st.match.phase === 'roundEnd', 3000, 'round 1 end');
const r1 = a.st.match.table.map((r) => `${r.name}=${r.total}`).join();
// Idle at the results screen (heartbeats only): no state spam.
const before = a.msgs; await sleep(3000);
assert(a.msgs - before === 0, `state messages while idle: ${a.msgs - before}`);
for (const c of [a, b]) await c.e('ready', { ready: true });
await waitFor(() => a.st.match.phase === 'playing' && a.st.match.round === 2, 3000, 'round 2 start');
await a.e('discard', { indices: [0, 1], expect: a.st.match.you.hand.map((x) => x.id), step: 0 });
await sleep(400);
const handA = a.st.match.you.hand.map((x) => x.id).join(), handB = b.st.match.you.hand.map((x) => x.id).join();
// --- Kill the server mid-round (like Fly stopping the machine) and bring it back ---
srv.kill('SIGINT'); await new Promise((r) => srv.once('exit', r));
console.log('  server killed mid round 2');
await sleep(1500);
await startServer();
await waitFor(() => a.rejoins >= 1 && b.rejoins >= 1 && a.st?.match?.you, 10000, 'clients rejoin');
await sleep(300);
assert(a.st.match.round === 2 && a.st.match.phase === 'playing', 'round 2 restored');
assert(a.st.match.you.hand.map((x) => x.id).join() === handA, 'A hand changed across restart');
assert(b.st.match.you.hand.map((x) => x.id).join() === handB, 'B hand changed across restart');
assert(a.st.match.you.step === 1, 'A discard step restored');
assert(a.st.match.table.map((r) => `${r.name}=${r.total}`).join() === r1, 'league table restored');
console.log('  restored: same round, same hands, same table, clients rejoined automatically ✓');
await a.e('stand'); await b.e('stand');
await waitFor(() => a.st.match.phase === 'roundEnd' && a.st.match.last.round === 2, 3000, 'round 2 end');
for (const c of [a, b]) await c.e('ready', { ready: true });
await waitFor(() => a.st.match.round === 3 && a.st.match.phase === 'playing', 3000, 'round 3 start');
// --- Round 3: hard crash (SIGKILL, no graceful save) after B has stood and A has discarded once. SQLite is written
// on every state change, so nothing may be lost. ---
await b.e('stand');
await a.e('discard', { indices: [2], expect: a.st.match.you.hand.map((x) => x.id), step: 0 });
await sleep(300);
const hA3 = a.st.match.you.hand.map((x) => x.id).join(), hB3 = b.st.match.you.hand.map((x) => x.id).join();
const bScore3 = b.st.match.you.result.points, t2 = a.st.match.table.map((r) => `${r.name}=${r.total}/${r.rounds.join('+')}`).join();
const rejoins = a.rejoins;
srv.kill('SIGKILL'); await new Promise((r) => srv.once('exit', r));
console.log('  server hard-killed (SIGKILL) mid round 3');
await sleep(1000);
await startServer();
await waitFor(() => a.rejoins > rejoins && b.rejoins > rejoins && a.st?.match?.round === 3 && b.st?.match?.you, 10000, 'clients rejoin after crash');
await sleep(300);
assert(a.st.match.you.hand.map((x) => x.id).join() === hA3 && a.st.match.you.step === 1 && !a.st.match.you.done, 'A round-3 state lost in crash');
assert(b.st.match.you.hand.map((x) => x.id).join() === hB3 && b.st.match.you.done && b.st.match.you.result.points === bScore3, 'B round-3 hand/score lost in crash');
assert(a.st.match.table.map((r) => `${r.name}=${r.total}/${r.rounds.join('+')}`).join() === t2, 'scores changed across crash');
console.log('  restored after crash: identical hands, discard step, B\'s locked score and league scores ✓');
await a.e('stand');
await waitFor(() => a.st.match.last?.round === 3, 3000, 'round 3 end');
const saved = await (await fetch(`${URL}/api/match/${code}/1`)).json();
assert(saved.rows.length === 2 && saved.rows.every((r) => r.rounds.length === 3), 'saved results in DB');
assert(saved.rows.map((r) => r.total).join() === a.st.match.table.map((r) => r.total).join(), 'DB totals = live table');
console.log(`  3 rounds done across a restart · max state ${Math.max(a.maxBytes, b.maxBytes)} bytes · ${a.msgs} msgs to A`);
console.log('PASS: restart resilience');
a.s.close(); b.s.close(); srv.kill('SIGINT'); await new Promise((r) => srv.once('exit', r));
rmSync(DATA_DIR, { recursive: true, force: true });
process.exit(0);
