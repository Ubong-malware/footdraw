// End-to-end browser test: solo daily game + a 2-player online room. Saves screenshots.
// Usage: node scripts/ui-test.mjs [url]
import { chromium } from 'playwright';
const URL = process.argv[2] ?? 'http://localhost:8080';
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const errors = [];
const watch = (page, tag) => { page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`)); page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`${tag}: ${m.text()}`)); };

// ---- Solo ----
const solo = await browser.newPage({ viewport: { width: 1100, height: 900 } }); watch(solo, 'solo');
await solo.goto(URL);
await solo.screenshot({ path: 'screenshots/0-home.png' });
await solo.click('text=Daily deck');
await solo.waitForSelector('.card');
await solo.click('.slot:nth-child(1) .card'); await solo.click('.slot:nth-child(3) .card');
await solo.waitForTimeout(800);
await solo.screenshot({ path: 'screenshots/1-solo-select.png' });
await solo.click('[data-act="discard"]');
await solo.click('.slot:nth-child(2) .info');
await solo.waitForSelector('.dialog'); await solo.waitForTimeout(1500);
await solo.screenshot({ path: 'screenshots/2-card-info.png' });
await solo.keyboard.press('Escape');
await solo.click('[data-act="stand"]');
await solo.waitForSelector('pre.share', { timeout: 30000 });
await solo.waitForTimeout(500);
await solo.screenshot({ path: 'screenshots/3-solo-result.png', fullPage: true });
console.log('solo share:\n' + await solo.textContent('pre.share'));

// ---- Multiplayer: 10-round match in two separate browser contexts ----
const a = await (await browser.newContext({ viewport: { width: 1100, height: 950 } })).newPage(); watch(a, 'alice');
const b = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage(); watch(b, 'bob');
await a.goto(URL); await a.click('text=Play with friends');
await a.fill('#nm', 'Alice'); await a.click('[data-act="create"]');
await a.waitForSelector('.roomhead .code');
const code = (await a.textContent('.roomhead .code')).trim();
console.log('room code', code);
await b.goto(`${URL}/room/${code}`);
await b.fill('#nm', 'Bob'); await b.click('[data-act="join"]');
await a.waitForSelector('text=Bob');
// Ready-up: Alice alone must not start the match.
await a.click('[data-act="ready"]');
await a.waitForSelector('.seat.is-ready');
await a.hover('.readycheck');
await a.waitForTimeout(4000);
if (await a.$('[data-act="mpstand"]')) throw new Error('Match started with only one player ready');
const panelText = (await a.textContent('.readycheck')).replace(/\s+/g, ' ').trim();
if (!/1\/2 ready/.test(panelText) || !/Waiting for: Bob/.test(panelText)) throw new Error('Ready panel wrong: ' + panelText);
await a.screenshot({ path: 'screenshots/7-ready-lobby.png' });
await b.click('[data-act="ready"]');
await a.waitForSelector('[data-act="mpstand"]', { timeout: 10000 });
console.log('both ready → match started');
const titles = async (p) => p.$$eval('.grid .ttl', (els) => els.map((e) => e.textContent));
for (let round = 1; round <= 10; round++) {
  for (const [p, who] of [[a, 'A'], [b, 'B']]) {
    await p.waitForSelector('[data-act="mpstand"]', { timeout: 15000 });
    await p.waitForTimeout(150);
    if (round <= 3) {
      // Swap cards 2 and 4; the other three must be exactly the same afterwards.
      const before = await titles(p);
      await p.click('.slot:nth-child(2) .card'); await p.click('.slot:nth-child(4) .card');
      if (round === 1 && who === 'A') { await p.waitForTimeout(300); await p.screenshot({ path: 'screenshots/4-match-round.png', fullPage: true }); }
      await p.click('[data-act="mpdiscard"]');
      await p.waitForFunction((prev) => { const t = [...document.querySelectorAll('.grid .ttl')].map((e) => e.textContent); return t[1] !== prev[1] || t[3] !== prev[3]; }, before, { timeout: 10000 });
      const after = await titles(p);
      for (const i of [0, 2, 4]) if (after[i] !== before[i]) throw new Error(`Round ${round} ${who}: kept card ${i} changed: ${before[i]} → ${after[i]}`);
    }
    await p.click('[data-act="mpstand"]');
  }
  // Round over: league table shows; check order + ready for the next round.
  await a.waitForSelector('table.league', { timeout: 15000 });
  const totals = await a.$$eval('table.league tbody tr td:last-child', (els) => els.map((e) => +e.textContent));
  if (totals.some((t, i) => i && t > totals[i - 1])) throw new Error('League table not sorted');
  if (round === 1) { await a.waitForTimeout(400); await a.screenshot({ path: 'screenshots/5-league-table.png', fullPage: true }); await b.screenshot({ path: 'screenshots/5b-league-table-mobile.png', fullPage: true }); }
  if (round < 10) { await a.click('[data-act="ready"]'); await b.click('[data-act="ready"]'); }
}
await a.waitForSelector('text=is the champion', { timeout: 15000 });
await a.waitForTimeout(400);
await a.screenshot({ path: 'screenshots/6-final-results.png', fullPage: true });
console.log('final:', (await a.textContent('.score h1')).trim(), '|', (await a.$$eval('table.league tbody tr', (r) => r.map((x) => x.textContent.replace(/\s+/g, ' ').trim()))).join(' / '));
const bodyText = await a.textContent('body');
if (/chip|poker|rebuy/i.test(bodyText)) throw new Error('Chip/poker text still visible');
await browser.close();
if (errors.length) { console.error('Browser errors:\n' + errors.join('\n')); process.exit(1); }
console.log('UI PASS');
