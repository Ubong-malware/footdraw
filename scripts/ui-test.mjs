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

// ---- Multiplayer (two separate browser contexts = two people) ----
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
// Ready-up: Alice readies alone → no deal, panel lists Bob as the one we're waiting for.
await a.click('[data-act="ready"]');
await a.waitForSelector('.seat.is-ready');
await a.hover('.readycheck');
await a.waitForTimeout(4000); // longer than the deal countdown
if (await a.$('.potline')) throw new Error('Hand started with only one player ready');
const panelText = (await a.textContent('.readycheck')).replace(/\s+/g, ' ').trim();
if (!/1\/2 ready/.test(panelText) || !/Waiting for: Bob/.test(panelText)) throw new Error('Ready panel wrong: ' + panelText);
console.log('ready panel:', panelText);
await a.screenshot({ path: 'screenshots/7-ready-lobby.png' });
await b.screenshot({ path: 'screenshots/8-ready-lobby-mobile.png' });
await b.click('[data-act="ready"]');
await a.waitForSelector('.potline', { timeout: 10000 });
console.log('both ready → hand dealt');
let shotMid = false;
for (let i = 0; i < 200; i++) {
  for (const [p, who] of [[a, 'A'], [b, 'B']]) {
    const btn = await p.$('[data-act="raise"]:not([disabled])');
    if (btn && !shotMid && who === 'A') {
      await p.waitForTimeout(800); await p.screenshot({ path: 'screenshots/4-room-betting.png', fullPage: true }); shotMid = true;
    }
    const call = await p.$('[data-act="call"]'); const check = await p.$('[data-act="check"]');
    if (btn && who === 'A' && Math.random() < 0.3) { await btn.click(); continue; }
    if (call) { await call.click(); continue; }
    if (check) { await check.click(); continue; }
    const card = await p.$('button.card:not(.discarded)');
    const draw = await p.$('[data-act="mpdraw"]');
    if (draw && card) { await card.click(); await p.click('[data-act="mpdraw"]'); if (who === 'B') await b.waitForTimeout(800), await b.screenshot({ path: 'screenshots/5-room-mobile-draw.png', fullPage: true }); continue; }
  }
  if (await a.$('.player-res')) break;
  await a.waitForTimeout(150);
}
await a.waitForSelector('.player-res', { timeout: 10000 });
await a.waitForTimeout(400);
await a.screenshot({ path: 'screenshots/6-room-showdown.png', fullPage: true });
console.log('showdown:', (await a.textContent('.score h1')).trim(), '|', (await a.textContent('.log')).slice(0, 200));
await browser.close();
if (errors.length) { console.error('Browser errors:\n' + errors.join('\n')); process.exit(1); }
console.log('UI PASS');
