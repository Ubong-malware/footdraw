// Leave handling: a leaver never blocks the round / ready-up, and the match ends if only one player remains.
// Usage: node scripts/sim-leave.mjs [url]
import { io } from 'socket.io-client';
const URL = process.argv[2] ?? 'http://localhost:8080';
const assert = (c, m) => { if (!c) { console.error('ASSERT FAILED:', m); process.exit(1); } }; import { randomBytes } from 'node:crypto';
const mk = (n) => { const s = io(URL, { auth: { token: randomBytes(16).toString('hex') }, transports: ['websocket'], forceNew: true }); const c = { s, n }; s.on('state', (st) => c.st = st); c.e = (ev, d) => new Promise((r) => s.emit(ev, d, r)); return c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [a, b, c] = ['A', 'B', 'C'].map(mk); await sleep(300);
const { code } = await a.e('create', { name: 'A' }); await b.e('join', { code, name: 'B' }); await c.e('join', { code, name: 'C' });
for (const x of [a, b, c]) await x.e('ready', { ready: true }); await sleep(+(process.env.READY_COUNTDOWN_MS ?? 3000) + 500);
await a.e('stand'); await b.e('stand'); await sleep(100);
console.log('before C leaves:', a.st.match.phase, 'waiting', a.st.match.waitingFor);
await c.e('leave'); await sleep(200);
assert(a.st.match.phase === 'roundEnd' && a.st.readyCheck.total === 2, 'C leaving ends round 1 and stops blocking');
console.log('after C leaves:', a.st.match.phase, 'round', a.st.match.last?.round, 'table', a.st.match.table.map((r) => `${r.name}${r.left ? '(left)' : ''}=${r.total}`).join(' '), 'ready needed', a.st.readyCheck?.total);
await a.e('ready', { ready: true }); await b.e('ready', { ready: true }); await sleep(+(process.env.READY_COUNTDOWN_MS ?? 3000) + 500);
assert(a.st.match.phase === 'playing' && a.st.match.round === 2, 'round 2 starts with A+B');
console.log('round 2 started without C:', a.st.match.phase, a.st.match.round);
await b.e('leave'); await sleep(300);
console.log('after B leaves too:', a.st.match.phase, 'champion', a.st.match.champion, a.st.match.championWhy);
assert(a.st.match.phase === 'final' && a.st.match.champion, 'match ends when only one player remains');
console.log('PASS: leave handling');
process.exit(0);
