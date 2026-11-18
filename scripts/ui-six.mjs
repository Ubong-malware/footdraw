// Playwright: a 6-player room (25-card decks). Checks the 6-seat layout on desktop and mobile, lock-in badges,
// the shared reveal, and results → league table order. Writes screenshots/14-*.png.
// Usage: node scripts/ui-six.mjs [url]   (server with READY_COUNTDOWN_MS=300 recommended)
import { chromium } from 'playwright';
const URL = process.argv[2] ?? 'http://localhost:8080';
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const names = ['Ana', 'Ben', 'Chi', 'Dev', 'Eli', 'Fay'];
const errors = [];
const pages = [];
for (const [i, n] of names.entries()) {
  const ctx = await browser.newContext({ viewport: i === 1 ? { width: 390, height: 860 } : { width: 1200, height: 950 } });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`)); pages.push(p);
}
const [a] = pages;
await a.goto(URL); await a.click('text=Play with friends'); await a.fill('#nm', names[0]); await a.click('[data-act="create"]');
await a.waitForSelector('.roomhead .code'); const code = (await a.textContent('.roomhead .code')).trim();
for (const [i, p] of pages.slice(1).entries()) { await p.goto(`${URL}/room/${code}`); await p.fill('#nm', names[i + 1]); await p.click('[data-act="join"]'); await p.waitForSelector('.roomhead .code'); }
await a.waitForFunction(() => document.querySelectorAll('.seat:not(.empty)').length === 6);
const seatCount = await a.$$eval('.seats .seat', (e) => e.length);
if (seatCount !== 6) throw new Error('expected 6 seats, got ' + seatCount);
for (const p of pages) await p.click('[data-act="ready"]');
for (const p of pages) await p.waitForSelector('[data-act="mpstand"]', { timeout: 15000 });
const pile = await a.textContent('.pile .top'); if (pile.trim() !== '20') throw new Error('25-card deck should leave 20 in the pile, shows ' + pile);
// Five lock in; check badges with one still playing.
for (const p of pages.slice(0, 5)) await p.click('[data-act="mpstand"]');
await pages[5].waitForFunction(() => (document.querySelector('.seats')?.textContent.match(/Locked in ✓/g) ?? []).length === 5);
await a.screenshot({ path: 'screenshots/14a-six-locked-in.png', fullPage: true });
await pages[1].screenshot({ path: 'screenshots/14b-six-locked-in-mobile.png', fullPage: true });
await pages[5].click('[data-act="mpstand"]');
await a.waitForSelector('[data-act="skipreveal"]'); await a.waitForTimeout(1200);
await a.screenshot({ path: 'screenshots/14c-six-reveal.png', fullPage: true });
for (const p of pages) await p.click('[data-act="skipreveal"]').catch(() => {});
await a.waitForSelector('table.league');
// Results come before the table.
const order = await a.$eval('.above', (el) => { const r = el.querySelector('.roundres'), t = el.querySelector('table.league'); return r && t && (r.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING) ? 'results-then-table' : 'wrong'; });
if (order !== 'results-then-table') throw new Error('Round results must come before the league table');
const rows = await a.$$eval('table.league tbody tr', (r) => r.length); if (rows !== 6) throw new Error('league table rows ' + rows);
await a.screenshot({ path: 'screenshots/14d-six-results-table.png', fullPage: true });
await pages[1].waitForSelector('table.league'); await pages[1].screenshot({ path: 'screenshots/14e-six-results-mobile.png', fullPage: true });
await browser.close();
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`SIX PASS: 6 seats, 25-card deck (pile 20), lock-in badges, reveal, results → table (${rows} rows)`);
