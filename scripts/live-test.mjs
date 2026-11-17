// Real-browser, real-pacing multiplayer check (use against the deployed site):
// 2 players, N rounds, a discard + stand each round, then IDLE at the results screen before readying up.
// Fails on: being kicked to the lobby, a reconnect that doesn't restore the match, kept cards changing,
// growing intervals/listeners, slow UI (click → update latency), or oversize state payloads.
// Usage: node scripts/live-test.mjs [url] [rounds=3] [idleSeconds=45]
import { chromium } from 'playwright';
const URL = process.argv[2] ?? 'https://footdraw-ubong.fly.dev';
const ROUNDS = +(process.argv[3] ?? 3);
const IDLE = +(process.argv[4] ?? 45) * 1000;
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const errors = [];
// Count live intervals and socket listeners from inside the page.
const init = () => {
  const live = new Set(); const si = window.setInterval, ci = window.clearInterval;
  window.setInterval = (...a) => { const id = si(...a); live.add(id); return id; };
  window.clearInterval = (id) => { live.delete(id); return ci(id); };
  window.__intervals = () => live.size;
};
async function newPlayer(name, viewport) {
  const ctx = await browser.newContext({ viewport }); await ctx.addInitScript(init);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/Failed to load resource|WebSocket/.test(m.text()) && errors.push(`${name}: ${m.text()}`));
  return p;
}
const a = await newPlayer('Alice', { width: 1100, height: 950 }), b = await newPlayer('Bob', { width: 420, height: 900 });
const t0 = Date.now(); const log = (...x) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...x);
await a.goto(URL); await a.click('text=Play with friends'); await a.fill('#nm', 'Alice'); await a.click('[data-act="create"]');
await a.waitForSelector('.roomhead .code', { timeout: 30000 });
const code = (await a.textContent('.roomhead .code')).trim(); log('room', code);
await b.goto(`${URL}/room/${code}`); await b.fill('#nm', 'Bob'); await b.click('[data-act="join"]');
await a.waitForSelector('text=Bob', { timeout: 30000 });
const stillInRoom = async (p, who) => { if (await p.$('[data-act="create"]')) throw new Error(`${who} was kicked back to the lobby`); };
const titles = (p) => p.$$eval('.grid .ttl', (els) => els.map((e) => e.textContent));
const latencies = []; let baseIntervals = null; const restarts = [];
for (const p of [a, b]) p.on('console', (m) => /reconnect/i.test(m.text()) && restarts.push(m.text()));
await a.click('[data-act="ready"]'); await b.click('[data-act="ready"]');
for (let round = 1; round <= ROUNDS; round++) {
  for (const [p, who] of [[a, 'Alice'], [b, 'Bob']]) {
    await p.waitForSelector('[data-act="mpstand"]', { timeout: 90000 });
    await stillInRoom(p, who);
    const before = await titles(p);
    await p.click('.slot:nth-child(1) .card'); await p.click('.slot:nth-child(5) .card');
    const tc = Date.now();
    await p.click('[data-act="mpdiscard"]');
    await p.waitForFunction((prev) => { const t = [...document.querySelectorAll('.grid .ttl')].map((e) => e.textContent); return t.length === 5 && (t[0] !== prev[0] || t[4] !== prev[4]); }, before, { timeout: 60000 });
    latencies.push(Date.now() - tc);
    const after = await titles(p);
    for (const i of [1, 2, 3]) if (after[i] !== before[i]) throw new Error(`round ${round} ${who}: kept card changed ${before[i]} → ${after[i]}`);
    await p.waitForTimeout(1500 + Math.random() * 2000); // think time
    await p.click('[data-act="mpstand"]');
  }
  await a.waitForSelector('table.league', { timeout: 90000 });
  await b.waitForSelector('table.league', { timeout: 90000 });
  log(`round ${round} done:`, (await a.$$eval('table.league tbody tr', (r) => r.map((x) => x.textContent.replace(/\s+/g, ' ').trim()))).join(' / '));
  if (round === 1) { await a.screenshot({ path: 'screenshots/9-live-league-table.png', fullPage: true }); }
  // Idle at the results screen like real players reading the table.
  const s0 = await a.evaluate(() => ({ ...window.__fd, intervals: window.__intervals() }));
  await a.waitForTimeout(IDLE);
  const s1 = await a.evaluate(() => ({ ...window.__fd, intervals: window.__intervals(), heap: performance.memory?.usedJSHeapSize }));
  baseIntervals ??= s0.intervals;
  log(`idle ${IDLE / 1000}s: +${s1.msgs - s0.msgs} state msgs, +${s1.renders - s0.renders} renders, intervals ${s1.intervals}, max state ${s1.maxBytes} B, heap ${(s1.heap / 1e6).toFixed(1)} MB, reconnects ${s1.reconnects}`);
  if (s1.intervals > baseIntervals) throw new Error(`interval leak: ${baseIntervals} → ${s1.intervals}`);
  if (s1.maxBytes > 64 * 1024) throw new Error(`state payload too big: ${s1.maxBytes}`);
  await stillInRoom(a, 'Alice'); await stillInRoom(b, 'Bob');
  if (round < ROUNDS) {
    // Ready may need a reconnect to finish first; the button reappears once state is back.
    for (const p of [a, b]) { await p.waitForSelector('[data-act="ready"][data-ready="1"]', { timeout: 90000 }); await p.click('[data-act="ready"]'); }
  }
}
const fa = await a.evaluate(() => window.__fd), fb = await b.evaluate(() => window.__fd);
log(`discard → update latency ms: ${latencies.join(', ')} (max ${Math.max(...latencies)})`);
log(`totals: Alice ${fa.msgs} msgs/${(fa.bytes / 1024).toFixed(0)} KB, ${fa.reconnects} reconnects · Bob ${fb.msgs} msgs/${(fb.bytes / 1024).toFixed(0)} KB, ${fb.reconnects} reconnects`);
await a.screenshot({ path: 'screenshots/10-live-after-rounds.png', fullPage: true });
await browser.close();
if (errors.length) { console.error('Browser errors:\n' + errors.join('\n')); process.exit(1); }
if (Math.max(...latencies) > 15000) { console.error('UI too slow'); process.exit(1); }
console.log(`LIVE PASS: ${ROUNDS} rounds with ${IDLE / 1000}s idle at each results screen, no kick-outs`);
