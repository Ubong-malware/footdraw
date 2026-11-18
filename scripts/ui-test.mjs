// End-to-end browser test: solo daily game + a 2-player online room. Saves screenshots.
// Usage: MODE=classic|live node scripts/ui-test.mjs [url]   (multiplayer game mode; default classic)
import { chromium } from 'playwright';
const URL = process.argv[2] ?? 'http://localhost:8080';
const MODE = process.env.MODE ?? 'classic', LIVE = MODE === 'live';
// Live-mode runs write their screenshots next to the classic ones with a "-live" suffix.
const shotPath = (n) => `screenshots/${LIVE ? n.replace(/\.png$/, '-live.png') : n}`;
// Live Lines check: what the board shows vs scoreHand() of the hand in the latest server state (same function the
// reveal and the server use).
const liveCheck = (p) => p.evaluate(async () => {
  const { scoreHand } = await import('/shared/game.js');
  const y = window.__lastState?.match?.you; const b = document.querySelector('.board.live'); const el = document.querySelector('.livetot');
  const r = y?.meta ? scoreHand(y.hand, y.meta) : null;
  return { want: r?.points ?? null, hand: r?.hand ?? null, segs: r ? r.matches.reduce((n, m) => n + m.cards.length - 1, 0) : 0, nMatches: r?.matches.length ?? 0,
    matchIdx: r ? [...new Set(r.matches.flatMap((m) => m.cards))] : [],
    shown: el ? +el.dataset.pts : null, shownHand: el?.dataset.hand ?? null, frozen: !!el?.classList.contains('frozen'), links: b?.dataset.links ?? null,
    lines: document.querySelectorAll('.board svg.links .ln.live').length, dim: document.querySelectorAll('.board svg.links .ln.live.dim').length,
    labels: document.querySelectorAll('.board svg.labels .lb.live').length, anyLines: document.querySelectorAll('.board svg.links .ln').length,
    pe: b ? [...b.querySelectorAll(':scope > svg.links')].map((v) => getComputedStyle(v).pointerEvents).join() : null, ids: y?.hand.map((c) => c.id).join() };
});
const liveStats = { checks: 0, changed: 0, dimSeen: 0, lockChecks: 0 };
async function assertLive(p, tag) {
  const L = await liveCheck(p);
  if (!LIVE) { if (L.links !== null || L.shown !== null || L.anyLines) throw new Error(`${tag}: classic mode shows live lines`); return L; }
  if (L.want == null) throw new Error(`${tag}: live mode but no traits/meta in state`);
  if (L.shown !== L.want || L.shownHand !== L.hand) throw new Error(`${tag}: live total ${L.shown} (${L.shownHand}) ≠ scoreHand ${L.want} (${L.hand})`);
  if (L.lines !== L.segs) throw new Error(`${tag}: ${L.lines} live line segments drawn, expected ${L.segs}`);
  if (L.nMatches && !L.labels) throw new Error(`${tag}: no +N labels`);
  if (L.pe !== 'none,none') throw new Error(`${tag}: line layers must not take taps (pointer-events ${L.pe})`);
  liveStats.checks++; return L;
}
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const errors = [];
const watch = (page, tag) => { page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`)); page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`${tag}: ${m.text()}`)); };

// ---- Solo ----
const solo = await browser.newPage({ viewport: { width: 1100, height: 900 } }); watch(solo, 'solo');
await solo.goto(URL);
if (!LIVE) await solo.screenshot({ path: 'screenshots/0-home.png' });
await solo.click('text=Daily deck');
await solo.waitForSelector('.card');
await solo.click('.slot:nth-child(1) .card'); await solo.click('.slot:nth-child(3) .card');
await solo.waitForTimeout(800);
if (!LIVE) await solo.screenshot({ path: shotPath('1-solo-select.png') });
await solo.click('[data-act="discard"]');
await solo.click('.slot:nth-child(2) .info');
await solo.waitForSelector('.dialog'); await solo.waitForTimeout(1500);
if (!LIVE) await solo.screenshot({ path: shotPath('2-card-info.png') });
await solo.keyboard.press('Escape');
await solo.click('[data-act="stand"]');
await solo.waitForSelector('pre.share', { timeout: 30000 });
await solo.waitForTimeout(500);
if (!LIVE) await solo.screenshot({ path: shotPath('3-solo-result.png'), fullPage: true });
console.log('solo share:\n' + await solo.textContent('pre.share'));

// ---- Multiplayer: 10-round match in two separate browser contexts ----
const a = await (await browser.newContext({ viewport: { width: 1100, height: 950 } })).newPage(); watch(a, 'alice');
const b = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage(); watch(b, 'bob');
await a.goto(URL); await a.click('text=Play with friends');
await a.fill('#nm', 'Alice');
if (LIVE) { await a.click('[data-act="newmode"][data-mode="live"]'); await a.waitForSelector('.modeopt.on[data-mode="live"]'); await a.screenshot({ path: 'screenshots/15a-mode-picker.png' }); }
await a.click('[data-act="create"]');
await a.waitForSelector('.roomhead .code');
const code = (await a.textContent('.roomhead .code')).trim();
console.log('room code', code);
if (!(await a.textContent('.roomhead')).includes(LIVE ? 'Live Lines' : 'Classic')) throw new Error('Room header should show the game mode');
await b.goto(`${URL}/room/${code}`);
// Invite link: shows the room's mode before joining (you join in the room's mode).
await b.waitForSelector('.invite [data-mode-chip]');
if ((await b.getAttribute('.invite [data-mode-chip]', 'data-mode-chip')) !== MODE) throw new Error('Invite shows the wrong mode');
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
await a.screenshot({ path: shotPath('7-ready-lobby.png') });
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
      const L0 = await assertLive(p, `R${round} ${who} dealt`);
      await p.click('.slot:nth-child(2) .card'); await p.click('.slot:nth-child(4) .card');
      // Cards marked Swap out still count until the swap happens (same total); their lines are dimmed.
      const Ls = await assertLive(p, `R${round} ${who} marked`);
      if (LIVE) {
        if (Ls.shown !== L0.shown) throw new Error('Marking cards for swap must not change the live total');
        const hit = L0.matchIdx.some((i) => i === 1 || i === 3);
        if (hit && !Ls.dim) throw new Error('Lines of cards marked Swap out should be dimmed');
        if (hit) liveStats.dimSeen++;
      }
      if (round === 1 && who === 'A') { const t = (await p.textContent('.topbar .secs')).trim(); const [mm, ss] = t.split(':').map(Number); const secs = mm * 60 + ss; if (!/^\d:\d\d$/.test(t) || !(secs > 60 && secs <= 90)) throw new Error(`Round timer should start at 1:30 (m:ss), shows ${t}`); if (!/Round 1 \/ 10/.test(await p.textContent('.topbar .tb-mid'))) throw new Error('Top bar should show Round 1 / 10'); }
      if (round === 1 && who === 'A') { await p.waitForTimeout(300); await p.screenshot({ path: shotPath('4-match-round.png'), fullPage: true }); }
      if (round === 1 && who === 'B') { await p.waitForTimeout(300); await p.screenshot({ path: shotPath('4d-match-round-mobile.png'), fullPage: true }); }
      await p.click('[data-act="mpdiscard"]');
      await p.waitForFunction((prev) => { const t = [...document.querySelectorAll('.grid .ttl')].map((e) => e.textContent); return t[1] !== prev[1] || t[3] !== prev[3]; }, before, { timeout: 10000 });
      const after = await titles(p);
      // Live lines redraw for the new hand as soon as the new cards arrive.
      const L1 = await assertLive(p, `R${round} ${who} after swap`);
      if (LIVE) { if (L1.ids === L0.ids) throw new Error('hand did not change'); if (L1.links !== L0.links || L1.shown !== L0.shown) liveStats.changed++; }
      if (LIVE && round === 1) { await p.waitForTimeout(600); await p.screenshot({ path: shotPath(who === 'A' ? '4e-after-swap.png' : '4f-after-swap-mobile.png'), fullPage: true }); }
      for (const i of [0, 2, 4]) if (after[i] !== before[i]) throw new Error(`Round ${round} ${who}: kept card ${i} changed: ${before[i]} → ${after[i]}`);
    }
    const Lpre = await assertLive(p, `R${round} ${who} before lock-in`);
    await p.click('[data-act="mpstand"]');
    if (LIVE) {
      // Locked in: lines freeze on the final hand and the frozen total equals the server's scored total.
      await p.waitForFunction(() => !!window.__lastState?.match?.you?.done || !window.__lastState?.match?.you || window.__lastState?.match?.phase !== 'playing', null, { timeout: 10000 });
      const st = await p.evaluate(() => { const m = window.__lastState.match; return m.phase === 'playing' ? { pts: m.you.result.points } : { pts: m.last.results[m.lastYou].points, ended: true }; });
      if (st.pts !== Lpre.shown) throw new Error(`R${round} ${who}: live total ${Lpre.shown} ≠ scored ${st.pts}`);
      if (!st.ended) { const F = await liveCheck(p); if (!F.frozen || F.shown !== st.pts) throw new Error(`R${round} ${who}: frozen total ${F.shown} ≠ ${st.pts}`); }
      liveStats.lockChecks++;
    }
    if (round === 1 && who === 'A') {
      // A is locked in: A sees who they wait for; both screens show A "Locked in ✓" and B "Playing…".
      await a.waitForSelector('.lockwait');
      const wait = (await a.textContent('.lockwait')).trim();
      if (wait !== 'Locked in, waiting for: Bob') throw new Error('Lock-in text: ' + wait);
      await b.waitForFunction(() => /Alice[\s\S]*Locked in ✓/.test(document.querySelector('.seats')?.textContent ?? ''));
      const seatsB = await b.$$eval('.seat', (els) => els.slice(0, 2).map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
      if (!/Locked in ✓/.test(seatsB[0]) || !/Playing…/.test(seatsB[1])) throw new Error('Seat badges: ' + seatsB.join(' | '));
      if (await a.$('[data-act="skipreveal"]')) throw new Error('Reveal started before everyone locked in');
      await a.screenshot({ path: shotPath('4a-locked-in.png'), fullPage: true });
      console.log('lock-in ok:', wait, '·', seatsB.join(' | '));
    }
  }
  // Everyone locked in → both reveals start together.
  if (round === 1) {
    const [ta, tb] = await Promise.all([a, b].map(async (p) => { await p.waitForSelector('[data-act="skipreveal"]', { timeout: 15000 }); return Date.now(); }));
    if (Math.abs(ta - tb) > 1500) throw new Error(`Reveals not simultaneous: ${Math.abs(ta - tb)} ms apart`);
  }
  // Round over: each player first sees their own hand's points tally up (client-side reveal), then the table.
  await a.waitForSelector('[data-act="skipreveal"]', { timeout: 15000 });
  if (round === 1) {
    // A watches the whole reveal: the number must count up and land on A's round score; no socket traffic meanwhile.
    const msgs0 = await a.evaluate(() => window.__fd.msgs);
    await b.click('[data-act="skipreveal"]').catch(() => {}); await b.waitForSelector('table.league', { timeout: 5000 });
    // Same component as solo: identical structure (score block with hand, counting points, line, note; 5-card grid).
    const shape = await a.$eval('.screen', (e) => [!!e.querySelector('.above .score h1'), !!e.querySelector('.score .pts span[data-to]'), !!e.querySelector('.score .line'), !!e.querySelector('.score .pb'), e.querySelectorAll('.grid .slot').length].join());
    if (shape !== 'true,true,true,true,5') throw new Error('Multiplayer reveal is not the solo reveal component: ' + shape);
    const seen = []; let lineShots = 0, sawLines = false;
    for (let i = 0; i < 100 && await a.$('[data-act="skipreveal"]'); i++) {
      const v = await a.$eval('.score .pts span', (e) => +e.textContent).catch(() => null); if (v != null && v !== seen.at(-1)) seen.push(v);
      // Match lines: thin lines between the matching cards with a "+N" label, drawn on the board as each match tallies.
      const on = await a.$$eval('.board svg.links .ln.on path', (e) => e.length).catch(() => 0);
      if (on) sawLines = true;
      if (on && !lineShots++) { await a.waitForFunction(() => [...document.querySelectorAll('.board .lb.on, .board .lb.done')].some((g) => getComputedStyle(g).opacity === '1'), null, { timeout: 3000 }).catch(() => {}); await a.waitForTimeout(150); await a.screenshot({ path: shotPath('4b-round-reveal.png'), fullPage: true }); }
      if (i === 14 && !lineShots) await a.screenshot({ path: shotPath('4b-round-reveal.png'), fullPage: true });
      await a.waitForTimeout(120);
    }
    const nMatches = await a.evaluate(() => { const m = window.__lastState?.match; return m?.last?.results[m.lastYou]?.matches.length ?? 0; });
    if (nMatches && !sawLines) throw new Error(`Reveal had ${nMatches} matches but no match lines were drawn`);
    console.log(`match lines: ${nMatches} match(es), lines drawn: ${sawLines}`);
    await a.waitForSelector('table.league', { timeout: 15000 });
    const mine = await a.evaluate(() => { const m = window.__lastState?.match; return m?.last?.results[m.lastYou]?.points; });
    if (seen.some((v, i) => i && v < seen[i - 1])) throw new Error(`Reveal tally went down: ${seen}`);
    if (mine == null || seen.at(-1) !== mine) throw new Error(`Reveal ended at ${seen.at(-1)} but round score is ${mine}`);
    const extra = await a.evaluate((m0) => window.__fd.msgs - m0, msgs0);
    if (extra > 2) throw new Error(`Reveal caused ${extra} socket messages`);
    console.log(`reveal tally (A): ${seen.join(' → ')} · ${extra} socket msgs during reveal (B's skip)`);
  } else {
    for (const p of [a, b]) await p.click('[data-act="skipreveal"]', { timeout: 3000 }).catch(() => {});
  }
  await a.waitForSelector('table.league', { timeout: 15000 });
  const totals = await a.$$eval('table.league tbody tr td:last-child', (els) => els.map((e) => +e.textContent));
  if (totals.some((t, i) => i && t > totals[i - 1])) throw new Error('League table not sorted');
  if (round === 1) { await a.waitForTimeout(400); await a.screenshot({ path: shotPath('5-league-table.png'), fullPage: true }); await b.screenshot({ path: shotPath('5b-league-table-mobile.png'), fullPage: true }); }
  if (round < 10) { await a.click('[data-act="ready"]'); await b.click('[data-act="ready"]'); }
}
await a.waitForSelector('text=is the champion', { timeout: 15000 });
await a.waitForTimeout(400);
await a.screenshot({ path: shotPath('6-final-results.png'), fullPage: true });
console.log('final:', (await a.textContent('.score h1')).trim(), '|', (await a.$$eval('table.league tbody tr', (r) => r.map((x) => x.textContent.replace(/\s+/g, ' ').trim()))).join(' / '));
const bodyText = await a.textContent('body');
if (/chip|poker|rebuy/i.test(bodyText)) throw new Error('Chip/poker text still visible');
// Saved results, multiplayer stats and trophy room (from SQLite), reached from the final screen.
await a.click('text=Permanent link to this table'); await a.waitForSelector('table.full');
const savedRows = await a.$$eval('table.full tbody tr', (r) => r.length); if (savedRows !== 2) throw new Error('Saved results missing rows');
if ((await a.getAttribute('.prose [data-mode-chip]', 'data-mode-chip')) !== MODE) throw new Error('Saved results should show the game mode');
await a.screenshot({ path: shotPath('11-saved-results.png'), fullPage: true });
for (const p of [a, b]) {
  await p.goto(`${URL}/stats`); await p.waitForSelector('table.infobox');
  const mp = await p.$eval('table.infobox', (t) => t.textContent);
  if (!/Matches played\s*1/.test(mp)) throw new Error('Stats: matches played should be 1: ' + mp);
}
// Mode column + filter on the stats page.
const histMode = await a.$eval('.mpstats .section:last-of-type tbody tr td:nth-child(2)', (e) => e.textContent.trim()).catch(() => null);
if (histMode !== (LIVE ? 'Live Lines' : 'Classic')) throw new Error('Stats history Mode column: ' + histMode);
const other = LIVE ? 'classic' : 'live';
await a.click(`[data-act="statsmode"][data-mode="${other}"]`); await a.waitForSelector(`.fbtn.on[data-mode="${other}"]`);
await a.waitForFunction(() => /No finished multiplayer matches/.test(document.body.textContent));
await a.click(`[data-act="statsmode"][data-mode="${MODE}"]`); await a.waitForSelector('table.infobox');
if (!/Matches played\s*1/.test(await a.$eval('table.infobox', (t) => t.textContent))) throw new Error('Stats filter by own mode should show the match');
await a.screenshot({ path: shotPath('12-mp-stats.png'), fullPage: true });
await a.click('[data-act="statsmode"][data-mode=""]');
const champIsA = /Alice is the champion/.test(bodyText);
const champPage = champIsA ? a : b;
await champPage.click('.mpnav >> text=Trophy room'); await champPage.waitForSelector('.trophy');
await champPage.screenshot({ path: shotPath('13-trophy-room.png'), fullPage: true });
const earned = await champPage.$$eval('ul.badges li.earned b', (els) => els.map((e) => e.textContent));
if (!earned.includes('First title')) throw new Error('First title badge missing');
console.log('stats/trophies ok · champion badges:', earned.join(', '));
await browser.close();
if (errors.length) { console.error('Browser errors:\n' + errors.join('\n')); process.exit(1); }
if (LIVE && (liveStats.changed < 1 || liveStats.lockChecks < 20)) throw new Error(`Live lines never changed after a swap (${JSON.stringify(liveStats)})`);
console.log(`live-lines (${MODE}):`, JSON.stringify(liveStats));
console.log(`UI PASS (${MODE})`);
