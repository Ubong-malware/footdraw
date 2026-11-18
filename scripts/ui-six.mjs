// Playwright: a 6-player room (25-card decks). Checks the 6-seat layout on desktop and mobile, lock-in badges,
// the shared reveal, and results → league table order. Writes screenshots/14-*.png.
// Usage: node scripts/ui-six.mjs [url]   (server with READY_COUNTDOWN_MS=300 recommended)
import { chromium } from 'playwright';
const URL = process.argv[2] ?? 'http://localhost:8080';
const MODE = process.env.MODE ?? 'classic', LIVE = MODE === 'live';
const shotPath = (n) => `screenshots/${LIVE ? n.replace(/\.png$/, '-live.png') : n}`;
const liveCheck = (p) => p.evaluate(async () => {
  const { scoreHand } = await import('/shared/game.js');
  const y = window.__lastState?.match?.you; const el = document.querySelector('.livetot'); const b = document.querySelector('.board.live');
  const r = y?.meta ? scoreHand(y.hand, y.meta) : null;
  return { want: r?.points ?? null, segs: r ? r.matches.reduce((n, m) => n + m.cards.length - 1, 0) : 0, shown: el ? +el.dataset.pts : null, frozen: !!el?.classList.contains('frozen'),
    links: b?.dataset.links ?? null, lines: document.querySelectorAll('.board svg.links .ln.live').length, anyLines: document.querySelectorAll('.board svg.links .ln').length,
    pe: b ? [...b.querySelectorAll(':scope > svg.links')].map((v) => getComputedStyle(v).pointerEvents).join() : null, done: !!y?.done, result: y?.result?.points ?? null };
});
async function assertLive(p, tag) {
  const L = await liveCheck(p);
  if (!LIVE) { if (L.links !== null || L.shown !== null || L.anyLines) throw new Error(`${tag}: classic mode shows live lines`); return L; }
  if (L.want == null || L.shown !== L.want) throw new Error(`${tag}: live total ${L.shown} ≠ scoreHand ${L.want}`);
  if (L.lines !== L.segs) throw new Error(`${tag}: ${L.lines} segments, expected ${L.segs}`);
  if (L.pe !== 'none,none') throw new Error(`${tag}: pointer-events ${L.pe}`);
  return L;
}
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const names = ['Ana', 'Ben', 'Chi', 'Dev', 'Eli', 'Fay'];
const errors = [];
const pages = [];
for (const [i, n] of names.entries()) {
  const ctx = await browser.newContext({ viewport: i === 1 ? { width: 390, height: 860 } : { width: 1200, height: 950 } });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`)); pages.push(p);
}
const [a] = pages;
await pages[1].goto(URL); await pages[1].waitForTimeout(400); if (!LIVE) await pages[1].screenshot({ path: 'screenshots/0b-home-mobile.png' });
await a.goto(URL); await a.click('text=Play with friends'); await a.fill('#nm', names[0]);
if (LIVE) await a.click('[data-act="newmode"][data-mode="live"]');
await a.click('[data-act="create"]');
await a.waitForSelector('.roomhead .code'); const code = (await a.textContent('.roomhead .code')).trim();
for (const [i, p] of pages.slice(1).entries()) { await p.goto(`${URL}/room/${code}`); await p.fill('#nm', names[i + 1]); await p.click('[data-act="join"]'); await p.waitForSelector('.roomhead .code'); }
await a.waitForFunction(() => document.querySelectorAll('.seat:not(.empty)').length === 6);
const seatCount = await a.$$eval('.seats .seat', (e) => e.length);
if (seatCount !== 6) throw new Error('expected 6 seats, got ' + seatCount);
for (const p of pages) await p.click('[data-act="ready"]');
for (const p of pages) await p.waitForSelector('[data-act="mpstand"]', { timeout: 15000 });
// Every player's board: live lines + total agree with scoreHand (live) / no lines during play (classic).
const live0 = [];
for (const [i, p] of pages.entries()) live0.push(await assertLive(p, `${names[i]} dealt`));
// Ana swaps two cards: the board redraws for the new hand straight away.
{
  const before = await a.$$eval('.grid .ttl', (e) => e.map((x) => x.textContent));
  await a.click('.slot:nth-child(1) .card'); await a.click('.slot:nth-child(5) .card'); await a.click('[data-act="mpdiscard"]');
  await a.waitForFunction((prev) => { const t = [...document.querySelectorAll('.grid .ttl')].map((e) => e.textContent); return t[0] !== prev[0] || t[4] !== prev[4]; }, before, { timeout: 10000 });
  const L = await assertLive(a, 'Ana after swap');
  if (LIVE) console.log(`  live lines: Ana ${live0[0].shown} → ${L.shown} pts after a swap (${L.lines} segments)`);
  if (LIVE) { await a.waitForTimeout(600); await a.screenshot({ path: 'screenshots/14g-six-live-round.png', fullPage: true }); }
}
const pile = await a.textContent('.pile .top'); if (pile.trim() !== '18') throw new Error('25-card deck should leave 18 in the pile after Ana swapped 2, shows ' + pile);
await pages[1].click('.slot:nth-child(3) .card'); await pages[1].waitForTimeout(300); await assertLive(pages[1], 'Ben marked'); await pages[1].screenshot({ path: shotPath('4c-match-round-mobile.png') }); await pages[1].click('.slot:nth-child(3) .card');
const tb = (await pages[1].textContent('.topbar')).replace(/\s+/g, ' '); if (!/Round 1 \/ 10/.test(tb) || !/1:[23]\d/.test(tb)) throw new Error('Mobile top bar should show Round 1 / 10 and the 1:30 clock: ' + tb);
// Five lock in; check badges with one still playing.
const pre = [];
for (const p of pages) pre.push((await liveCheck(p)).shown);
for (const p of pages.slice(0, 5)) await p.click('[data-act="mpstand"]');
if (LIVE) for (const [i, p] of pages.slice(0, 5).entries()) {
  await p.waitForSelector('.livetot.frozen');
  const F = await liveCheck(p);
  if (!F.done || F.result !== pre[i] || F.shown !== pre[i]) throw new Error(`${names[i]}: live ${pre[i]} vs scored ${F.result} vs frozen ${F.shown}`);
}
await pages[5].waitForFunction(() => (document.querySelector('.seats')?.textContent.match(/Locked in ✓/g) ?? []).length === 5);
await a.screenshot({ path: shotPath('14a-six-locked-in.png'), fullPage: true });
await pages[1].screenshot({ path: shotPath('14b-six-locked-in-mobile.png'), fullPage: true });
await pages[5].click('[data-act="mpstand"]');
await a.waitForSelector('[data-act="skipreveal"]');
// Screenshot a desktop player whose hand has matches once the match lines (thin lines + "+N" labels) are drawn.
const nMatch = async (p) => p.evaluate(() => { const m = window.__lastState?.match; return m?.last?.results[m.lastYou]?.matches.length ?? 0; });
const scored = await Promise.all(pages.map(nMatch));
const best = scored.reduce((bi, v, i) => (i !== 1 && v > scored[bi] ? i : bi), 0), shot = pages[best];
await shot.waitForSelector('.board svg.links .ln.on', { timeout: 8000 }).then(() => shot.waitForFunction(() => [...document.querySelectorAll('.board .lb.on, .board .lb.done')].some((g) => getComputedStyle(g).opacity === '1'), null, { timeout: 3000 })).then(() => shot.waitForTimeout(150)).catch(() => {});
await shot.screenshot({ path: shotPath('14c-six-reveal.png'), fullPage: true });
if (await nMatch(shot) && !(await shot.$('.board svg.links .ln'))) throw new Error('reveal: no match lines drawn');
await pages[1].screenshot({ path: shotPath('14f-six-reveal-mobile.png') });
for (const p of pages) await p.click('[data-act="skipreveal"]').catch(() => {});
await a.waitForSelector('table.league');
if (LIVE) { const res = await Promise.all(pages.map((p) => p.evaluate(() => { const m = window.__lastState.match; return m.last.results[m.lastYou].points; }))); if (res.some((v, i) => v !== pre[i])) throw new Error(`round scores ${res} ≠ live totals ${pre}`); }
// Results come before the table.
const order = await a.$eval('.above', (el) => { const r = el.querySelector('.roundres'), t = el.querySelector('table.league'); return r && t && (r.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING) ? 'results-then-table' : 'wrong'; });
if (order !== 'results-then-table') throw new Error('Round results must come before the league table');
const rows = await a.$$eval('table.league tbody tr', (r) => r.length); if (rows !== 6) throw new Error('league table rows ' + rows);
await a.screenshot({ path: shotPath('14d-six-results-table.png'), fullPage: true });
await pages[1].waitForSelector('table.league'); await pages[1].screenshot({ path: shotPath('14e-six-results-mobile.png'), fullPage: true });
await browser.close();
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`SIX PASS (${MODE}): 6 seats, 25-card deck (pile 18 after a 2-card swap), lock-in badges, reveal, results → table (${rows} rows)`);
