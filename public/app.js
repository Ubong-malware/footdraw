import { BONUS, HANDS, rng, shuffle, scoreHand, bestHand, suitGroups, shareText } from '/shared/game.js';

const BRAND = 'FootDraw';
const $root = document.getElementById('root');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wikiUrl = (t) => `https://en.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g, '_'))}`;
// Display name: Wikipedia titles keep their disambiguation for links; cards show the plain name.
const cardName = (c) => (c.title ?? '').replace(/ \([^)]*\)$/, '');
const isLogo = (u) => /logo|crest|badge|\.svg/i.test(u ?? '');
const today = () => new Date().toLocaleDateString('en-CA');
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Browser identity (keeps your seat across reloads and reconnects).
let token = localStorage.getItem('fd_token');
if (!token) { token = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join(''); localStorage.setItem('fd_token', token); }

const MODES = [
  { mode: 'daily', name: 'Daily deck', blurb: "Today's 15 cards." },
  { mode: 'random', name: 'Random deck', blurb: '15 cards from the entire football pool.' },
  { mode: 'friends', name: 'Play with friends', blurb: '10-round match, up to 6 players.' },
];

const S = {
  view: 'home', menu: false, modal: null, // modal: {type:'help'} | {type:'card', card}
  solo: null, // solo game
  room: null, roomError: null, selected: [], busy: false, name: localStorage.getItem('fd_name') ?? '',
};

// ---------- Data ----------
// Decks come from the server: the browser only gets the 15 cards it plays with plus the trait labels/counts needed
// to score them (the full pool never leaves the server).
async function fetchDeck(mode, date) {
  const r = await fetch(mode === 'daily' ? `/api/deck?mode=daily&date=${encodeURIComponent(date)}` : '/api/deck?mode=random', { headers: { 'x-fd-token': token } });
  if (!r.ok) throw new Error('deck');
  return r.json();
}
const poolFrom = (d) => ({ meta: { traits: d.traits, size: d.size }, byId: new Map(d.cards.map((c) => [c.id, c])) });

// ---------- Rendering helpers ----------
const seen = new Set();
function cardHTML(c, { idx, discarded, toggle, info, suit, hl, link = true, badge } = {}) {
  const fresh = !seen.has(c.id); seen.add(c.id);
  const pic = c.thumbnail ? `<img src="${esc(c.thumbnail)}" alt="" decoding="async">` : `<div class="letter" aria-hidden="true">${esc(c.title[0])}</div>`;
  const inner = `<div class="pic ${isLogo(c.thumbnail) ? 'contain' : ''}">${pic}</div><div class="cap"><div class="ttl">${esc(cardName(c))}</div>${c.description ? `<div class="desc">${esc(c.description)}</div>` : ''}</div>`;
  const cls = `card ${discarded ? 'discarded' : ''} ${hl ? 'hl' : ''}`;
  const body = toggle
    ? `<button type="button" class="${cls}" data-act="toggle" data-i="${idx}" aria-pressed="${!!discarded}">${inner}</button>`
    : link ? `<a class="${cls}" href="${wikiUrl(c.title)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
      : `<button type="button" class="${cls}" data-act="cardinfo" data-id="${esc(c.id)}">${inner}</button>`;
  return `<div class="slot${fresh ? ' fresh' : ''}">${body}${discarded ? '<div class="tag" aria-hidden="true">Swap out</div>' : ''}${badge ? `<div class="newb">${esc(badge)}</div>` : ''}${suit ? `<div class="suit" aria-hidden="true">${suit}</div>` : ''}${info ? `<button type="button" class="info" data-act="info" data-id="${esc(c.id)}" aria-label="About ${esc(c.title)}">i</button>` : ''}</div>`;
}
const pileHTML = (n) => {
  const st = 2.5, k = Math.min(Math.max(n - 1, 0), 14);
  return `<div class="pile" role="img" aria-label="${n} cards left in the deck" style="padding-top:${k * st}px;padding-left:${k * st}px">${Array.from({ length: k }, (_, i) => `<div class="c s" style="top:${i * st}px;left:${i * st}px"></div>`).join('')}<div class="c top ${n === 0 ? 'empty' : ''}">${n}</div></div>`;
};
const discardsHTML = (left) => `<div class="discards" role="img" aria-label="${left} of 2 discards left"><span class="lbl">Remaining Discards:</span><span>${[0, 1].map((i) => `<span class="j ${i >= left ? 'used' : ''}">🃏</span>`).join('')}</span></div>`;
const matchTable = (r, cardsByIdx) => r.matches.length ? `<table class="wt"><thead><tr><th scope="col">In common</th><th scope="col">Cards</th><th scope="col">Points</th></tr></thead><tbody>
  ${r.matches.map((m) => `<tr><td><strong>${esc(m.label)}</strong></td><td>${m.cards.map((i) => esc(cardName(cardsByIdx[i]))).join(', ')}</td><td>+${m.points}</td></tr>`).join('')}
  ${BONUS[r.hand] > 0 ? `<tr><td colspan="2"><em>${r.hand} bonus</em></td><td>+${BONUS[r.hand]}</td></tr>` : ''}</tbody></table>` : '<p class="muted" style="margin-bottom:16px">Nothing in this hand had anything in common.</p>';

function topbar() {
  return `<div class="topbar">
    <button type="button" class="burger ${S.menu ? 'open' : ''}" data-act="menu" aria-label="Main menu" aria-expanded="${S.menu}"><span></span><span></span><span></span></button>
    <a class="logo" href="/" data-act="home"><b>${BRAND}</b><small>The free football card game</small></a>
    <button type="button" class="help" data-act="help" aria-label="How to play" aria-haspopup="dialog"><svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-2.9 3-2.9 3"/><path d="M12 17h.01"/></svg></button>
    ${S.menu ? `<nav class="menu"><h2>Main menu</h2><ul><li><button data-act="home">Main page</button></li><li><button data-act="page" data-page="stats">Stats</button></li><li><button data-act="mpage" data-page="mpstats">Multiplayer stats</button></li><li><button data-act="mpage" data-page="trophies">Trophy room</button></li><li><button data-act="page" data-page="about">About</button></li></ul>
      <p>Play</p><ul>${MODES.map((m) => `<li><button data-act="mode" data-mode="${m.mode}">${m.name}</button></li>`).join('')}</ul></nav>` : ''}
  </div>`;
}
const pageHead = (title) => `<header class="page-head"><h1>${esc(title)}</h1></header><p class="from">From Wikipedia, the free encyclopedia</p>`;

function modalHTML() {
  const m = S.modal; if (!m) return '';
  const shell = (title, body, note) => `<div class="overlay" data-act="close"><div class="dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}" data-stop><div class="dh"><h2>${esc(title)}</h2><button type="button" class="x" data-act="close" aria-label="Close"><svg viewBox="0 0 24 24" width="20" height="20"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>${body}${note ? `<p class="dnote">${note}</p>` : ''}</div></div>`;
  if (m.type === 'card') {
    const c = m.card;
    const live = m.live === undefined ? '<div class="live muted">Loading live data from TheSportsDB…</div>'
      : m.live ? `<div class="live"><b>Live data · TheSportsDB</b><dl>${Object.entries(m.live).filter(([k, v]) => v && !['image', 'badge', 'website'].includes(k)).map(([k, v]) => `<dt>${esc(k[0].toUpperCase() + k.slice(1))}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>` : '';
    return shell(cardName(c), `<div class="from" style="margin-bottom:0">From Wikipedia, the free encyclopedia</div><p class="body">${esc(c.extract)}</p>${['player', 'club'].includes(c.kind) ? live : ''}<p style="margin-top:10px;font-size:.9rem"><a class="link" href="${wikiUrl(c.title)}" target="_blank" rel="noopener">Read on Wikipedia</a></p>`, 'Text from Wikipedia, CC BY-SA. Live data from TheSportsDB.');
  }
  return shell('How to play', `<div class="body">
    <p>Five-card draw with Wikipedia football articles as cards: players, clubs, national teams and tournaments. Build a hand of cards that have something in common: the same nation, club, position, World Cup, decade of birth, award, etc.</p>
    <h3>Playing solo</h3><ul><li>You're dealt 5 cards from a 15-card deck.</li><li>Tap the cards you want to swap, then <strong>Discard</strong>. You'll draw the same number of cards from the deck.</li><li>You get two chances to discard and draw. <strong>Stand</strong> any time to keep your hand.</li><li>Tap <span class="ibadge">i</span> on a card to read about it. The pile in the bottom-right corner shows how many cards are left.</li></ul>
    <h3>Scoring</h3><ul><li>Every trait two or more cards share scores points.</li><li>Rarer traits score more: five players born in Rosario beat five forwards.</li><li>The most common traits, like Forward or Born in the 1980s, score little or nothing and don't count toward the hand shape.</li><li>Bigger groups score much more, plus a bonus for the shape of the hand.</li><li>What your cards share stays hidden until the end.</li></ul>
    <h3>Hands</h3><ol>${HANDS.map((h) => `<li><strong>${h} (+${BONUS[h]})</strong>: ${{ Flush: 'all five share a trait', 'Four of a Kind': 'four share a trait', 'Full House': 'three share one trait, two share another', 'Three of a Kind': 'three share a trait', 'Two Pair': 'two separate pairs', Pair: 'two share a trait', 'High Card': 'nothing shared' }[h]}</li>`).join('')}</ol>
    <h3>Play with friends: 10-round match</h3><ul>
      <li>2–6 players per room. Share the room link or 5-letter code. Each round's deck has 15 cards with 2–4 players and 25 cards with 5–6 players.</li>
      <li>Everyone presses <strong>Ready</strong>; the match starts only when all players are ready, and again before every round.</li>
      <li>Each round is a normal FootDraw game. All players get the <strong>same deck</strong> (15 cards, or 25 with 5–6 players; a new deck every round), each in their own shuffle, and play at the same time: tap cards to swap out, two discards, or Stand. Cards you keep never change.</li>
      <li>A round ends when everyone has finished (1 minute max: when the timer runs out, anyone still playing automatically stands with the hand they have).</li>
      <li>When you stand, use both discards or run out of time, you're <strong>locked in</strong>: every seat shows <em>Locked in ✓</em> or <em>Playing…</em>, and your screen lists who you're waiting for.</li>
      <li>Once everyone is locked in, all players see the reveal at the same moment: your hand's points tally up, then everyone's hands and the table appear (or tap <strong>Skip to results</strong>).</li>
      <li>Your round score is added to the <strong>league table</strong>. Highest score wins the round (ties: whoever finished first).</li>
      <li>After round 10 the top of the table is champion. Level on points? Then most rounds won, then best single round, then fastest total finishing time.</li></ul>
    <h3>Modes</h3><ul><li><strong>Daily deck</strong>: the day's 15 cards are the same for everyone, shuffled uniquely for each player.</li><li><strong>Random deck</strong>: 15 cards from the entire pool.</li><li><strong>Play with friends</strong>: a 10-round league match against up to 5 friends. Matches are saved, so a dropped connection or server restart doesn't end them. See <strong>Multiplayer stats</strong> and the <strong>Trophy room</strong> in the menu.</li></ul></div>`);
}

// ---------- Views ----------
function render() {
  let body = '', after = '';
  if (S.view === 'stats') body = pageHead('Stats') + statsHTML();
  else if (S.view === 'about') body = pageHead(`About ${BRAND}`) + `<div class="prose"><p>${BRAND} is five-card draw played with Wikipedia's football articles: famous players, clubs, national teams and tournaments. Card traits come from Wikidata, texts and images from Wikipedia, and live squad info from TheSportsDB.</p><p>Inspired by the format of Wikdraw. If you enjoy the game, consider <a href="https://donate.wikimedia.org/" target="_blank" rel="noopener">donating to Wikipedia</a>.</p></div>`;
  else if (S.view === 'solo') ({ body, after } = soloHTML());
  else if (S.view === 'lobby') body = lobbyHTML();
  else if (S.view === 'mpstats') body = pageHead('Multiplayer stats') + mpStatsHTML();
  else if (S.view === 'trophies') body = pageHead('Trophy room') + trophiesHTML();
  else if (S.view === 'results') body = pageHead('Match results') + savedResultsHTML();
  else if (S.view === 'room') ({ body, after } = roomHTML());
  else body = pageHead(`Welcome to ${BRAND}`) + `<div class="modes">${MODES.map((m) => `<button type="button" class="mode" data-act="mode" data-mode="${m.mode}"><strong>${m.name}</strong><span>${m.blurb}</span></button>`).join('')}</div>`;
  const active = document.activeElement?.id;
  const banner = S.view === 'room' && S.conn ? `<div class="connbar" role="status">${S.conn === 'restarting' ? 'The server is restarting. Your match is saved, reconnecting…' : 'Connection lost. Reconnecting…'}</div>` : '';
  window.__fd && window.__fd.renders++;
  $root.innerHTML = `${banner}<main class="main"><div class="screen">${topbar()}${body}</div>${after}</main>${modalHTML()}`;
  if (active && document.getElementById(active)) document.getElementById(active).focus();
  animateCount();
}

// ---------- Stats (local) ----------
const statsKey = 'fd_stats';
const getStats = () => JSON.parse(localStorage.getItem(statsKey) ?? '{}');
function recordStats(mode, result) {
  const all = getStats(); const s = (all[mode] ??= { games: 0, best: 0, hands: {} });
  const previous = s.games ? s.best : null;
  s.games++; s.hands[result.hand] = (s.hands[result.hand] ?? 0) + 1; s.best = Math.max(s.best, result.points);
  localStorage.setItem(statsKey, JSON.stringify(all));
  return { points: s.best, previous };
}
function statsHTML() {
  const all = getStats();
  return `<div class="stats">${MODES.slice(0, 2).map(({ mode, name }) => {
    const s = all[mode];
    return `<section><h2>${name}</h2>${!s?.games ? '<p class="note">No games yet.</p>' : `<dl><div><dt>High score</dt><dd>${s.best} pts</dd></div><div><dt>Games</dt><dd>${s.games.toLocaleString()}</dd></div></dl>
      <table class="wt"><thead><tr><th scope="col">Hand</th><th scope="col">Count</th></tr></thead><tbody>${HANDS.map((h) => `<tr><td>${h}</td><td>${(s.hands[h] ?? 0).toLocaleString()}</td></tr>`).join('')}</tbody></table>`}</section>`;
  }).join('')}<p class="note">Stats belong to this browser. Clearing its data or starting in a different browser won't carry the data over.</p></div>`;
}

// ---------- Multiplayer stats, trophy room, saved results (from the server's SQLite DB) ----------
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const resultsLink = (code, no, text) => `<a href="/results/${esc(code)}/${+no}" data-act="results" data-code="${esc(code)}" data-no="${+no}">${text}</a>`;
async function loadMpStats() {
  S.mp = { loading: true }; render();
  try { const r = await fetch('/api/stats', { headers: { 'x-fd-token': token } }); S.mp = r.ok ? { data: await r.json() } : { error: 'Could not load stats.' }; }
  catch { S.mp = { error: 'Could not load stats.' }; }
  if (S.view === 'mpstats' || S.view === 'trophies') render();
}
async function loadResults(code, no) {
  S.saved = { loading: true, code, no }; render();
  try { const r = await fetch(`/api/match/${encodeURIComponent(code)}/${+no}`); S.saved = r.ok ? { data: await r.json() } : { error: 'That match was not found.' }; }
  catch { S.saved = { error: 'Could not load the match.' }; }
  if (S.view === 'results') render();
}
function goPage(view, url) {
  S.view = view; S.menu = false; history.pushState(null, '', url);
  if (view === 'mpstats' || view === 'trophies') loadMpStats(); else render();
}
const mpNav = (here) => `<p class="note mpnav">${[['mpstats', '/stats', 'Multiplayer stats'], ['trophies', '/trophies', 'Trophy room']].map(([v, u, t]) => v === here ? `<strong>${t}</strong>` : `<a href="${u}" data-act="mpage" data-page="${v}">${t}</a>`).join(' · ')}</p>`;
function mpStatsHTML() {
  const mp = S.mp ?? {};
  if (mp.loading) return '<p class="note">Loading…</p>';
  if (mp.error) return `<p class="err">${esc(mp.error)}</p>`;
  const d = mp.data;
  if (!d?.matchesPlayed && !d?.roundsPlayed) return `${mpNav('mpstats')}<p class="prose">No finished multiplayer matches yet for this browser. Play a 10-round match with friends and your record will appear here.</p>`;
  const kv = (k, v) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`;
  const br = d.bestRound;
  return `${mpNav('mpstats')}<div class="mpstats">
    <table class="infobox"><caption>${esc(d.name ?? 'You')}</caption><tbody>
      ${kv('Matches played', d.matchesPlayed)}${kv('League titles', `${d.titles} 🏆`)}${kv('Win %', `${d.winPct}%`)}
      ${kv('Rounds played', d.roundsPlayed)}${kv('Rounds won', d.roundsWon)}${kv('Average round', `${d.avgRound} pts`)}
      ${kv('Best round', br ? `${br.points} pts<br><small>${esc(br.hand)}</small>` : '–')}
      ${kv('Highest match total', d.highestTotal ? `${d.highestTotal.total} pts` : '–')}${kv('Average finish', d.avgPos ? ord(Math.round(d.avgPos)) + ` <small>(${d.avgPos})</small>` : '–')}
    </tbody></table>
    <p class="prose"><b>${esc(d.name ?? 'You')}</b> has played <b>${d.matchesPlayed}</b> FootDraw league match${d.matchesPlayed === 1 ? '' : 'es'} and won <b>${d.titles}</b> title${d.titles === 1 ? '' : 's'}${d.perfect ? `, including ${d.perfect} perfect match${d.perfect === 1 ? '' : 'es'}` : ''}.${br ? ` Their best single round was a ${esc(br.hand)} worth ${br.points} points (${br.cards.map((t) => esc(cardName({ title: t }))).join(', ')}).` : ''}</p>
    <section class="section"><h2>Most-used cards</h2><table class="wt"><thead><tr><th scope="col">Card</th><th scope="col">Final hands</th></tr></thead><tbody>${d.topCards.map((c) => `<tr><td><a href="${wikiUrl(c.name)}" target="_blank" rel="noopener noreferrer">${esc(cardName({ title: c.name }))}</a></td><td>${c.count}</td></tr>`).join('')}</tbody></table></section>
    <section class="section"><h2>Most-scored traits</h2><table class="wt"><thead><tr><th scope="col">In common</th><th scope="col">Rounds</th></tr></thead><tbody>${d.topTraits.map((c) => `<tr><td>${esc(c.name)}</td><td>${c.count}</td></tr>`).join('')}</tbody></table></section>
    <section class="section"><h2>Hands</h2><table class="wt"><thead><tr><th scope="col">Hand</th><th scope="col">Count</th></tr></thead><tbody>${HANDS.map((h) => `<tr><td>${h}</td><td>${d.hands[h] ?? 0}</td></tr>`).join('')}</tbody></table></section>
    <section class="section"><h2>Recent matches</h2>${d.history.length ? `<table class="wt"><thead><tr><th scope="col">Date</th><th scope="col">Opponents</th><th scope="col">Finish</th><th scope="col">Points</th><th scope="col">Final table</th></tr></thead><tbody>${d.history.map((h) => `<tr><td>${fmtDate(h.at)}</td><td>${h.opponents.map(esc).join(', ')}</td><td>${h.won ? '🏆 ' : ''}${ord(h.pos)} of ${h.players}</td><td>${h.total}</td><td>${resultsLink(h.code, h.no, 'View')}</td></tr>`).join('')}</tbody></table>` : '<p class="note">No finished matches yet.</p>'}</section>
    <p class="note">Stats are tied to this browser (and the name you played under). Rounds count once a round has ended.</p></div>`;
}
function trophiesHTML() {
  const mp = S.mp ?? {};
  if (mp.loading) return '<p class="note">Loading…</p>';
  if (mp.error) return `<p class="err">${esc(mp.error)}</p>`;
  const d = mp.data ?? { trophies: [], badges: [] };
  return `${mpNav('trophies')}<p class="prose">Every league title ${esc(d.name ?? 'you')} won${d.trophies.length ? ` · <b>${d.trophies.length}</b> in the cabinet` : ''}.</p>
    <div class="trophies">${d.trophies.length ? d.trophies.map((t) => `<div class="trophy${t.perfect ? ' perfect' : ''}"><div class="cup" aria-hidden="true">🏆</div><div class="tt">League champion</div>
      <div class="td">${fmtDate(t.at)} · Room ${esc(t.code)}</div><div class="tp"><b>${t.total}</b> pts</div>
      <div class="td">${t.runnerUp ? `won by ${t.margin} pts over ${esc(t.runnerUp)}` : 'unopposed'}</div><div class="td">vs ${t.opponents.map(esc).join(', ') || '—'}</div>
      ${t.perfect ? '<div class="tag2">Perfect match</div>' : ''}<div class="td">${resultsLink(t.code, t.no, 'Final table')}</div></div>`).join('') : '<p class="note">No titles yet. Win a 10-round match to lift your first trophy.</p>'}</div>
    <section class="section"><h2>Milestones</h2><ul class="badges">${d.badges.map((b) => `<li class="${b.earned ? 'earned' : 'locked'}" title="${esc(b.desc)}"><span class="bi" aria-hidden="true">${b.earned ? '🏅' : '🔒'}</span><b>${esc(b.label)}</b><small>${esc(b.desc)}</small></li>`).join('')}</ul></section>`;
}
function savedResultsHTML() {
  const sv = S.saved ?? {};
  if (sv.loading) return '<p class="note">Loading…</p>';
  if (sv.error || !sv.data) return `<p class="err">${esc(sv.error ?? 'Not found')}</p>`;
  const d = sv.data; const n = Math.max(...d.rows.map((r) => r.rounds.length), 0);
  return `<p class="prose">Room <b>${esc(d.code)}</b>, match ${d.no} · ${fmtDate(d.updatedAt)} · ${d.phase === 'final' ? `<b>${esc(d.champion)}</b> won the title with ${d.championPts} pts${d.championWhy ? ` (${esc(d.championWhy)})` : ''}` : `in progress, round ${d.round}`}.</p>
    <div class="scroll"><table class="wt league full"><thead><tr><th scope="col">Pos</th><th scope="col">Player</th>${Array.from({ length: n }, (_, i) => `<th scope="col">R${i + 1}</th>`).join('')}<th scope="col">Won</th><th scope="col">Total</th></tr></thead><tbody>
    ${d.rows.map((r) => `<tr class="${r.pos === 1 ? 'lead' : ''}"><td>${d.phase === 'final' && r.pos === 1 ? '🏆' : ord(r.pos)}</td><td>${esc(r.name)}${r.left ? ' <span class="muted">(left)</span>' : ''}</td>${Array.from({ length: n }, (_, i) => `<td>${r.rounds[i] ?? ''}</td>`).join('')}<td>${r.roundsWon}</td><td><strong>${r.total}</strong></td></tr>`).join('')}</tbody></table></div>
    ${mpNav('')}`;
}

// ---------- Solo game ----------
async function startSolo(mode) {
  S.view = 'solo'; S.menu = false; S.solo = { loading: true, mode }; render();
  const date = new URLSearchParams(location.search).get('date') ?? today();
  const key = `fd_daily_${date}`;
  let g, data;
  const saved = mode === 'daily' && JSON.parse(localStorage.getItem(key) ?? 'null');
  try {
    if (saved?.data) { g = { ...saved }; data = saved.data; }
    else {
      data = await fetchDeck(mode, date);
      // Daily: everyone gets the same 15 cards, each browser in its own order. Random: a fresh server-built deck.
      const deck = mode === 'daily' ? shuffle(data.cards.map((c) => c.id), rng(`${token}:${date}`)) : data.cards.map((c) => c.id);
      g = { deck, hand: deck.slice(0, 5), pos: 5, keeps: [], stages: [deck.slice(0, 5)], done: false };
    }
  } catch { S.solo = null; S.view = 'home'; render(); return; }
  seen.clear();
  S.solo = { ...g, mode, date, key, data, selected: [], pool: poolFrom(data), step: Infinity, busy: false };
  if (g.done) finishSolo(true);
  render();
}
const saveSolo = () => { const g = S.solo; if (g.mode === 'daily') localStorage.setItem(g.key, JSON.stringify({ data: g.data, deck: g.deck, hand: g.hand, pos: g.pos, keeps: g.keeps, stages: g.stages, done: g.done, pb: g.pb })); };
function soloDiscard() {
  const g = S.solo; if (!g.selected.length) return;
  for (const i of g.selected) g.hand[i] = g.deck[g.pos++];
  g.keeps.push([0, 1, 2, 3, 4].filter((i) => !g.selected.includes(i)));
  g.stages.push(g.hand.slice()); g.selected = [];
  if (g.keeps.length === 2) return finishSolo();
  saveSolo(); render();
}
function finishSolo(restored = false) {
  const g = S.solo; const { pool } = g;
  const cards = g.hand.map((id) => pool.byId.get(id));
  const r = scoreHand(cards, pool.meta);
  const deckCards = g.deck.map((id) => pool.byId.get(id));
  g.result = { ...r, cards, stages: g.stages.map((h) => scoreHand(h.map((id) => pool.byId.get(id)), pool.meta)), best: bestHand(deckCards, pool.meta) };
  if (!restored) { g.pb = recordStats(g.mode, r); }
  g.done = true; saveSolo();
  g.rv = newReveal(r, cards, { instant: restored });
  playReveal(g.rv, { alive: () => S.solo === g && S.solo.rv === g.rv, rerender: () => S.view === 'solo' && render() });
  render();
}
// Reveal sequence (mirrors the original: suits pop in, hand name, each match tallies up, bonus, total).
// Used by solo games and by each player's own hand at the end of a multiplayer round. Purely client-side.
function buildReveal(r) {
  const { first, second } = suitGroups(r.matches.filter((m) => m.shape !== false));
  const suitAt = [0, 1, 2, 3, 4].map((i) => first?.cards.includes(i) ? '♥️' : second?.cards.includes(i) ? '♣️' : null);
  const order = ['♥️', '♣️'].flatMap((s) => suitAt.flatMap((x, i) => (x === s ? [i] : [])));
  const scenes = []; let sc = { suits: 0, name: false, matches: 0, bonus: false, points: 0, done: false };
  const push = (d, hold) => { sc = { ...sc, ...d }; scenes.push({ scene: sc, hold }); };
  push({}, 400);
  order.forEach((_, i) => push({ suits: i + 1 }, i === order.length - 1 ? 500 : 260));
  push({ name: true }, 700);
  r.matches.forEach((m, i) => push({ matches: i + 1, points: sc.points + m.points }, 800));
  if (BONUS[r.hand] > 0) push({ bonus: true, points: sc.points + BONUS[r.hand] }, 1000);
  push({ points: r.points, done: true }, 0);
  return { scenes, suitAt, order };
}
// The score number counts up between tally steps (animated in place, no re-render).
let countShown = 0, countRaf = 0;
function animateCount() {
  const el = document.querySelector('.score .pts span[data-to]'); if (!el) return;
  const to = +el.dataset.to, from = Math.min(countShown, to);
  cancelAnimationFrame(countRaf); countShown = to;
  if (from === to || reduced()) { el.textContent = to; return; }
  const t0 = performance.now(), dur = Math.min(650, 120 + (to - from) * 12);
  el.textContent = from;
  const step = (now) => { const k = Math.min(1, (now - t0) / dur); el.textContent = Math.round(from + (to - from) * (1 - (1 - k) ** 3)); if (k < 1) countRaf = requestAnimationFrame(step); };
  countRaf = requestAnimationFrame(step);
}
// ===== The reveal component (ONE implementation, used as-is by solo games and by multiplayer round ends) =====
// newReveal → state; playReveal → runs the scenes with the solo timings; revealStageHTML → score + cards markup.
function newReveal(r, cards, { instant = false } = {}) {
  const rv = { r, cards, ...buildReveal(r), step: 0 };
  if (instant || reduced()) rv.step = rv.scenes.length - 1;
  countShown = rv.step ? r.points : 0;
  return rv;
}
function playReveal(rv, { alive, rerender, onEnd = null, endHold = 0 }) {
  const tick = () => {
    if (!alive()) return;
    if (rv.step >= rv.scenes.length - 1) { if (onEnd) setTimeout(() => alive() && onEnd(), endHold); return; }
    setTimeout(() => { if (!alive()) return; rv.step++; rerender(); tick(); }, rv.scenes[rv.step].hold);
  };
  tick();
}
const revealScene = (rv) => rv.scenes[Math.min(rv.step, rv.scenes.length - 1)].scene;
function revealStageHTML(rv, { doneLine, note = '' }) {
  const { r, cards } = rv; const scene = revealScene(rv);
  const shown = new Set(rv.order.slice(0, scene.suits));
  const { cur, line } = revealLine(r, scene, doneLine);
  return `<div class="above"><div class="score" style="opacity:${scene.name ? 1 : 0}"><h1>${r.hand}</h1><p class="pts"><span data-to="${scene.points}">${Math.min(countShown, scene.points)}</span> pts</p><p class="line">${line}</p>
      <p class="pb">${scene.done ? note : ''}</p></div></div>
    <div class="grid">${cards.map((c, i) => cardHTML(c, { suit: shown.has(i) ? rv.suitAt[i] : null, hl: cur?.cards.includes(i) })).join('')}</div>`;
}
function revealLine(r, scene, doneText) {
  const cur = scene.done || scene.bonus ? null : r.matches[scene.matches - 1];
  return { cur, line: scene.done ? doneText : scene.bonus ? `${r.hand} bonus <strong>+${BONUS[r.hand]}</strong>` : cur ? `${esc(cur.label)} <strong>+${cur.points}</strong>` : '' };
}
function soloHTML() {
  const g = S.solo;
  if (!g || g.loading) return { body: '<p class="center-msg">Dealing…</p>', after: '' };
  const cards = g.hand.map((id) => g.pool.byId.get(id));
  const remaining = 10 - g.keeps.reduce((s, k) => s + 5 - k.length, 0);
  if (!g.done) {
    return { body: `<div class="above">${discardsHTML(2 - g.keeps.length)}</div>
      <div class="grid">${cards.map((c, i) => cardHTML(c, { idx: i, toggle: true, discarded: g.selected.includes(i), info: true })).join('')}</div>
      <div class="below"><div class="bar"><div class="pilewrap">${pileHTML(remaining)}</div><div class="buttons"><button class="btn" data-act="stand">Stand</button><button class="btn primary" data-act="discard" ${g.selected.length ? '' : 'disabled'}>${g.selected.length ? `Discard ${g.selected.length}` : 'Select cards'}</button></div></div></div>`, after: '' };
  }
  const r = g.result; const scene = revealScene(g.rv);
  const title = g.mode === 'daily' ? g.date : 'Random';
  const pb = g.pb; const share = shareText(BRAND, title, r.hand, r.points, r.stages) + `\n${location.origin}`;
  const body = `${revealStageHTML(g.rv, { doneLine: `${BRAND} ${title}`, note: pb ? (pb.previous !== null && r.points > pb.previous ? `<strong>New personal best! (was ${pb.previous} pts)</strong>` : `Personal best: ${pb.points} pts`) : '' })}
    <div class="below">${scene.done ? `<div class="after"><div class="row"><button class="btn" data-act="copy">Copy result</button><button class="btn primary" data-act="mode" data-mode="random">${g.mode === 'daily' ? 'Play a random deck' : 'Play again'}</button></div><pre class="share">${esc(share)}</pre></div>` : ''}</div>`;
  const best = r.best;
  const after = scene.done ? `<div style="padding-top:24px">${matchTable(r, r.cards)}<section class="section">${best.points <= r.points ? '<h2>That was the best hand possible in your deck!</h2>'
    : `<h2>The best hand in your deck: ${best.hand}, ${best.points} pts</h2><p class="links">${best.cards.map((c) => `<a href="${wikiUrl(c.title)}" target="_blank" rel="noopener noreferrer">${esc(cardName(c))}</a>`).join(' · ')}</p>${matchTable(best, best.cards)}`}</section><p class="foot">Text from Wikipedia, CC BY-SA. Traits from Wikidata, CC0.</p></div>` : '';
  return { body, after };
}

// ---------- Multiplayer: 10-round matches ----------
let socket = null;
function connect() {
  if (socket) return socket;
  if (!window.io) { S.roomError = 'Multiplayer server not reachable.'; return null; }
  // Reconnect quickly and forever; the server may restart (it restores rooms from disk).
  socket = io({ auth: { token }, transports: ['websocket', 'polling'], reconnectionDelay: 500, reconnectionDelayMax: 3000, timeout: 15000 });
  window.__fd = { msgs: 0, bytes: 0, maxBytes: 0, renders: 0, reconnects: 0 }; // lightweight diagnostics (used by tests)
  socket.on('server-restart', () => { S.conn = 'restarting'; if (S.view === 'room') render(); });
  socket.on('state', (st) => {
    const size = JSON.stringify(st).length; window.__fd.msgs++; window.__fd.bytes += size; window.__fd.maxBytes = Math.max(window.__fd.maxBytes, size);
    const prevKey = S.roomKey;
    const m = st.match;
    // Selection belongs to one exact hand state (round + discard step). Anything else clears it, so a
    // stale selection can never be applied to a different hand.
    S.roomKey = m?.you ? `${m.no}:${m.round}:${m.you.step}:${m.you.done}` : null;
    if (S.roomKey !== prevKey) S.selected = [];
    const roundKey = m ? `${m.no}:${m.round}` : null;
    if (roundKey !== S.lastRoundKey) { S.lastRoundKey = roundKey; seen.clear(); }
    S.room = st; S.busy = false; window.__lastState = st;
    maybeReveal(st);
    if (S.view === 'room' || S.view === 'lobby') { S.view = 'room'; render(); }
  });
  socket.on('connect', () => { // reconnect: rejoin the room we were in
    const code = S.room?.code ?? sessionStorage.getItem('fd_room');
    if (S.conn) { window.__fd.reconnects++; S.conn = null; S.roomError = null; }
    if (code && (S.view === 'room' || S.view === 'lobby')) socket.emit('join', { code, name: S.name }, (r) => { if (r?.error) { S.roomError = r.error; S.room = null; S.view = 'lobby'; render(); } else { S.roomError = null; render(); } });
  });
  socket.on('disconnect', () => { S.conn = S.conn ?? 'reconnecting'; S.busy = false; if (S.view === 'room') render(); });
  return socket;
}
// End-of-round reveal: your own hand tallies up (like solo) before the round results and league table.
// Runs once per round per browser; a reconnect or reload doesn't replay it. No socket traffic.
S.revealKey = sessionStorage.getItem('fd_reveal');
function maybeReveal(st) {
  const m = st.match, L = m?.last;
  if (!L || m.phase === 'playing' || !(m.lastYou >= 0) || !L.results[m.lastYou]) return;
  const key = `${st.code}:${m.no}:${L.round}`;
  if (key === S.revealKey) return;
  S.revealKey = key; sessionStorage.setItem('fd_reveal', key);
  if (reduced()) return;
  const r = L.results[m.lastYou];
  // Exactly the solo reveal (same component, same scenes and timings); then on to the results and league table.
  const rv = Object.assign(newReveal(r, r.cards), { key });
  S.reveal = rv;
  playReveal(rv, { alive: () => S.reveal === rv, rerender: () => S.view === 'room' && render(), endHold: 1800,
    onEnd: () => { S.reveal = null; if (S.view === 'room') render(); } });
}
function revealHTML(st) {
  const m = st.match;
  return `${revealStageHTML(S.reveal, { doneLine: `Your round ${m.last.round} score`, note: 'Results next…' })}
    <div class="below"><div class="bar"><p class="problem muted">Round ${m.last.round} of ${st.rounds} · results next</p><div class="pilewrap"></div><div class="buttons"><span></span><button class="btn" data-act="skipreveal">Skip to results</button></div></div></div>`;
}
function lobbyHTML() {
  return pageHead('Play with friends') + `<div class="form">
    <p class="prose">A 10-round FootDraw match for 2–6 players. Everyone plays the same deck each round; points add up in a league table and the top of the table after round 10 is champion. Create a room and send the link, or join with a code.</p>
    <label>Your name<input id="nm" maxlength="20" autocomplete="nickname" value="${esc(S.name)}" placeholder="e.g. Pelé"></label>
    <button class="btn primary" data-act="create">Create a room</button>
    <div class="row"><input id="code" maxlength="5" placeholder="Room code" style="text-transform:uppercase" value="${esc(S.joinCode ?? '')}"><button class="btn" data-act="join">Join room</button></div>
    ${S.roomError ? `<p class="err" role="alert">${esc(S.roomError)}</p>` : ''}</div>`;
}
const ord = (n) => n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] ?? 'th');
function leagueTableHTML(m, { final = false } = {}) {
  const rows = m.table;
  return `<table class="wt league"><thead><tr><th scope="col">Pos</th><th scope="col">Player</th><th scope="col">Round ${m.round}</th><th scope="col">Rounds won</th><th scope="col">Best</th><th scope="col">Total</th></tr></thead><tbody>
    ${rows.map((r) => `<tr class="${r.pos === 1 ? 'lead' : ''}"><td>${final && r.pos === 1 ? '🏆' : ord(r.pos)}</td><td>${esc(r.name)}${r.left ? ' <span class="muted">(left)</span>' : ''}</td><td>+${r.roundScore}</td><td>${r.roundsWon}</td><td>${r.best}</td><td><strong>${r.total}</strong></td></tr>`).join('')}
  </tbody></table>`;
}
// After the reveal: 1) round results (every player's final hand and score), 2) the league table, then the
// per-player trait breakdown further down.
function roundResultsHTML(m, { details = false } = {}) {
  const L = m.last; if (!L) return '';
  if (!details) return `<section class="roundres"><h2 class="tablehead">Round ${L.round} results</h2><table class="wt rr"><thead><tr><th scope="col"></th><th scope="col">Player</th><th scope="col">Hand</th><th scope="col">Final cards</th><th scope="col">Pts</th></tr></thead><tbody>
    ${L.results.map((p, i) => `<tr class="${i === 0 ? 'lead' : ''}"><td>${i === 0 ? '⭐' : ord(i + 1)}</td><td>${esc(p.name)}</td><td>${p.hand}</td><td class="fc">${p.cards.map((c, j) => `<span class="${p.newIdx.includes(j) ? 'isnew' : ''}">${esc(cardName(c))}</span>`).join(', ')}</td><td><strong>${p.points}</strong></td></tr>`).join('')}</tbody></table></section>`;
  return `<section class="section"><h2>Round ${L.round} details</h2>${L.results.map((p, i) => `<div class="player-res"><h3><span>${i === 0 ? '⭐ ' : ''}${esc(p.name)} · ${p.hand}</span><span class="${i === 0 ? 'win' : 'muted'}">${p.points} pts</span></h3>
    <div class="mini">${p.cards.map((c, j) => cardHTML(c, { badge: p.newIdx.includes(j) ? 'New' : null })).join('')}</div>${matchTable(p, p.cards)}</div>`).join('')}</section>`;
}
function readyPanelHTML(st) {
  const rc = st.readyCheck ?? { ready: 0, total: 0, waitingFor: [], allReady: false, next: 'Start match' };
  const waitText = rc.total < 2 ? 'Waiting for at least 2 players… Share the invite link.' : rc.allReady ? 'Everyone is ready!' : `Waiting for: ${rc.waitingFor.map(esc).join(', ')}`;
  const count = st.nextAt ? `<span data-next="${st.nextAt}" data-label="${esc(rc.next)} in">${esc(rc.next)} in ${Math.max(0, Math.ceil((st.nextAt - Date.now()) / 1000))}s</span>` : '';
  return { waitText, rc, panel: `<div class="readycheck" role="status" aria-live="polite" title="${esc(waitText)}">
      <div class="rc-count"><b>${rc.ready}/${rc.total}</b> ready</div><div class="rc-wait">${waitText}</div>
      <ul class="rc-list">${st.seats.map((s) => `<li class="${s.readyUp ? 'ok' : 'no'}">${s.readyUp ? '✓' : '…'} ${esc(s.name)}${s.isYou ? ' (you)' : ''}</li>`).join('')}</ul>
      ${count ? `<div class="rc-deal">${count}</div>` : ''}</div>` };
}
function roomHTML() {
  const st = S.room; if (!st) return { body: '<p class="center-msg">Joining…</p>', after: '' };
  const m = st.match; const playing = m?.phase === 'playing';
  const meSeat = st.seats.find((s) => s.isYou);
  const nSeats = st.maxPlayers ?? 6;
  const seatsHTML = Array.from({ length: nSeats }, (_, i) => {
    const s = st.seats[i];
    if (!s) return `<div class="seat empty">Open seat</div>`;
    // During a round every seat shows whether that player is locked in (stood / used both discards / timed out).
    const status = playing ? (s.status === 'Spectating' ? 'Spectating' : s.lockedIn ? '<span class="rdy lock">Locked in ✓</span>' : '<span class="nrdy">Playing…</span>') : (s.readyUp ? '<span class="rdy">✓ Ready</span>' : '<span class="nrdy">Not ready</span>');
    return `<div class="seat ${!playing && s.readyUp ? 'is-ready' : ''} ${playing && s.lockedIn ? 'is-ready' : ''}" title="${!playing ? (s.readyUp ? `${esc(s.name)} is ready` : `Waiting for ${esc(s.name)} to ready up`) : s.lockedIn ? `${esc(s.name)} is locked in` : s.status === 'Spectating' ? `${esc(s.name)} is spectating` : `${esc(s.name)} is still playing`}"><div class="nm">${esc(s.name)}${s.isYou ? ' (you)' : ''}${s.isHost ? ' ★' : ''}</div><div class="ch">${s.total != null && !S.reveal ? `${s.total} pts` : '&nbsp;'}</div><div class="st">${status}${s.connected ? '' : ' <span class="off">· offline</span>'}</div></div>`;
  }).join('');
  const invite = `${location.origin}/room/${st.code}`;
  let body = `<div class="roomhead"><span>Room</span><span class="code">${st.code}</span><button class="btn small" data-act="copylink" data-link="${esc(invite)}">${S.copied ? 'Link copied' : 'Copy invite link'}</button><button class="btn small" data-act="leave">Leave</button>${m ? `<span class="muted">${m.phase === 'final' ? 'Match finished' : `Round ${m.round} of ${st.rounds}`}</span>` : ''}${S.roomError ? `<span class="err">${esc(S.roomError)}</span>` : ''}</div>
    <div class="seats seats-${nSeats}">${seatsHTML}</div>`;
  let after = '';
  if (playing) {
    const you = m.you;
    const timer = m.deadline ? `<div class="timer"><i data-deadline="${m.deadline}" style="width:${Math.max(0, Math.min(100, (m.deadline - Date.now()) / st.roundMs * 100))}%"></i></div><span class="secs" data-left="${m.deadline}" title="Time left: you auto-stand at 0">${Math.max(0, Math.ceil((m.deadline - Date.now()) / 1000))}s</span>` : '';
    if (!you) {
      body += `<div class="above"><p class="center-msg">Round ${m.round} in progress. You'll play in the next match.</p></div>`;
    } else if (!you.done) {
      const sel = S.selected;
      body += `<div class="above">${discardsHTML(you.discardsLeft)}<p class="hint">Tap the cards you want to <strong>swap out</strong>. Cards you don't tap are kept and never change.</p></div>
        <div class="grid">${you.hand.map((c, i) => cardHTML(c, { idx: i, toggle: true, discarded: sel.includes(i), info: true, badge: !sel.includes(i) && you.lastNew.includes(i) ? 'New' : null })).join('')}</div>
        <div class="below"><div class="bar"><p class="problem">${sel.length ? `Swap ${sel.length}, keep ${5 - sel.length}` : `Round ${m.round} of ${st.rounds}`}</p>${timer}<div class="pilewrap">${pileHTML(you.deckLeft)}</div><div class="buttons"><button class="btn" data-act="mpstand" ${S.busy ? 'disabled' : ''}>Stand</button><button class="btn primary" data-act="mpdiscard" ${sel.length && !S.busy ? '' : 'disabled'}>${sel.length ? `Discard ${sel.length}` : 'Select cards'}</button></div></div></div>`;
    } else {
      body += `<div class="above"><div class="score"><h1>Locked in ✓</h1><p class="line lockwait" role="status">Locked in, waiting for: ${m.waitingFor.map(esc).join(', ')}</p><p class="pb">Scores are revealed for everyone at the same time when the last player locks in.</p></div></div>
        <div class="grid">${you.hand.map((c, i) => cardHTML(c, { badge: you.lastNew.includes(i) ? 'New' : null })).join('')}</div>
        <div class="below"><div class="bar"><p class="problem muted">Round ends when everyone is locked in.</p>${timer}<div class="pilewrap">${pileHTML(you.deckLeft)}</div><div class="buttons"></div></div></div>`;
    }
  } else if (S.reveal && m?.last && S.reveal.key === `${st.code}:${m.no}:${m.last.round}`) {
    body += revealHTML(st);
  } else {
    const { panel, rc, waitText } = readyPanelHTML(st);
    let head = '';
    if (m?.phase === 'final') head = `<div class="score"><h1>🏆 ${esc(m.champion)} is the champion</h1><p class="pts"><span>${m.championPts ?? m.table[0]?.total ?? 0}</span> pts</p><p class="line">Final table after ${m.round} rounds${m.championWhy ? ` · ${esc(m.championWhy)}` : ''}</p><p class="line finallinks">${resultsLink(st.code, m.no, 'Permanent link to this table')} · <a href="/stats" data-act="mpage" data-page="mpstats">Your stats</a> · <a href="/trophies" data-act="mpage" data-page="trophies">Trophy room</a></p></div>`;
    else if (m?.last) head = `<div class="score"><h1>Round ${m.last.round} of ${st.rounds}</h1><p class="line">${esc(m.last.winner)} wins the round with ${m.last.results[0]?.points ?? 0} pts</p></div>`;
    body += `<div class="above">${head}${m?.last ? roundResultsHTML(m) : ''}${m ? `<h2 class="tablehead">${m.phase === 'final' ? 'Final table' : 'League table'}</h2>${leagueTableHTML(m, { final: m.phase === 'final' })}` : ''}${panel}</div>
      <div class="below"><div class="bar"><p class="problem muted" title="${esc(waitText)}">${rc.ready}/${rc.total} ready${rc.waitingFor.length && !rc.allReady ? ` · waiting for ${rc.waitingFor.map(esc).join(', ')}` : ''}</p><div class="pilewrap"></div><div class="buttons"><span></span><button class="btn ${meSeat?.readyUp ? '' : 'primary'}" data-act="ready" data-ready="${meSeat?.readyUp ? 0 : 1}" aria-pressed="${!!meSeat?.readyUp}">${meSeat?.readyUp ? '✓ Ready (click to cancel)' : `Ready · ${esc(rc.next)}`}</button></div></div></div>`;
    if (m) after = roundResultsHTML(m, { details: true });
  }
  after += `<div class="log" aria-live="polite">${st.log.slice().reverse().map((l) => `<div>${esc(l.msg)}</div>`).join('')}</div><p class="foot">Text from Wikipedia, CC BY-SA. Traits from Wikidata.</p>`;
  return { body, after };
}
// ---------- Events ----------
function emit(ev, data) {
  return new Promise((res) => connect()?.emit(ev, data, (r) => { S.roomError = r?.error ?? null; res(r); if (r?.error) render(); }));
}
async function openCard(c) {
  S.modal = { type: 'card', card: c }; render();
  if (!['player', 'club'].includes(c.kind)) return;
  try {
    const r = await fetch(`/api/sportsdb/${c.kind === 'player' ? 'player' : 'team'}?q=${encodeURIComponent(c.title.replace(/ \(.*\)$/, '').replace(/ (F\.C\.|FC|CF|A\.F\.C\.)$/, ''))}`);
    const live = r.ok ? await r.json() : null;
    if (S.modal?.card === c) { S.modal.live = live; render(); }
  } catch { if (S.modal?.card === c) { S.modal.live = null; render(); } }
}
function findCard(id) {
  const g = S.solo; if (S.view === 'solo' && g?.pool) return g.pool.byId.get(id);
  const m = S.room?.match; return m?.you?.hand.find((c) => c.id === id) ?? m?.last?.results.flatMap((p) => p.cards).find((c) => c.id === id);
}
function goLobby(code) {
  S.view = 'lobby'; S.menu = false; S.joinCode = code ?? S.joinCode; connect(); render();
}
$root.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) { if (S.menu && !e.target.closest('.menu')) { S.menu = false; render(); } return; }
  if (el.dataset.act === 'close' && e.target.closest('[data-stop]') && !e.target.closest('.x')) return;
  const a = el.dataset.act;
  if (a !== 'menu' && a !== 'toggle') S.menu = false;
  switch (a) {
    case 'menu': S.menu = !S.menu; return render();
    case 'home': e.preventDefault(); if (S.view === 'room') await emit('leave'); S.view = 'home'; S.room = null; history.pushState(null, '', '/'); return render();
    case 'help': S.modal = { type: 'help' }; return render();
    case 'close': S.modal = null; return render();
    case 'page': S.view = el.dataset.page; return render();
    case 'mpage': e.preventDefault(); if (S.view === 'room' && S.room?.match?.phase !== 'final') return; return goPage(el.dataset.page, el.dataset.page === 'trophies' ? '/trophies' : '/stats');
    case 'results': e.preventDefault(); S.view = 'results'; S.menu = false; history.pushState(null, '', `/results/${el.dataset.code}/${el.dataset.no}`); return loadResults(el.dataset.code, el.dataset.no);
    case 'mode': S.modal = null; return el.dataset.mode === 'friends' ? (S.view === 'room' ? render() : goLobby()) : startSolo(el.dataset.mode);
    case 'toggle': {
      const i = +el.dataset.i; const arr = S.view === 'solo' ? S.solo.selected : S.selected;
      const j = arr.indexOf(i); j >= 0 ? arr.splice(j, 1) : arr.push(i);
      return render();
    }
    case 'info': case 'cardinfo': { const c = findCard(el.dataset.id); if (c) openCard(c); return; }
    case 'stand': return finishSolo();
    case 'discard': return soloDiscard();
    case 'copy': await navigator.clipboard?.writeText(document.querySelector('pre.share').textContent).catch(() => {}); el.textContent = 'Copied'; return;
    case 'create': case 'join': {
      S.name = document.getElementById('nm')?.value.trim() || S.name; localStorage.setItem('fd_name', S.name);
      if (!S.name) { S.roomError = 'Pick a name first.'; return render(); }
      const code = (document.getElementById('code')?.value ?? '').trim().toUpperCase();
      if (a === 'join' && !code) { S.roomError = 'Enter a room code.'; return render(); }
      const r = await emit(a, { name: S.name, code });
      if (r?.ok) { S.view = 'room'; S.roomError = null; sessionStorage.setItem('fd_room', r.code); history.pushState(null, '', `/room/${r.code}`); render(); }
      return;
    }
    case 'leave': await emit('leave'); S.room = null; sessionStorage.removeItem('fd_room'); history.pushState(null, '', '/'); S.view = 'lobby'; return render();
    case 'copylink': await navigator.clipboard?.writeText(el.dataset.link).catch(() => {}); S.copied = true; render(); setTimeout(() => { S.copied = false; render(); }, 1500); return;
    case 'ready': return emit('ready', { ready: el.dataset.ready === '1' });
    case 'skipreveal': S.reveal = null; render(); return;
    case 'mpstand': if (S.busy) return; S.busy = true; render(); return emit('stand').then(() => { S.busy = false; render(); });
    case 'mpdiscard': {
      // Send the exact hand we are looking at and the discard step, so the server rejects stale/double submits.
      const you = S.room?.match?.you; if (!you || S.busy || !S.selected.length) return;
      S.busy = true; render();
      const r = await emit('discard', { indices: [...S.selected], expect: you.hand.map((c) => c.id), step: you.step });
      S.busy = false; if (r?.error) render(); return;
    }
  }
});
$root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.target.id === 'code' || e.target.id === 'nm')) document.querySelector(`[data-act="${e.target.id === 'code' ? 'join' : 'create'}"]`)?.click(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && (S.modal || S.menu)) { S.modal = null; S.menu = false; render(); } });
// Countdown bars without full re-renders.
setInterval(() => {
  document.querySelectorAll('[data-deadline]').forEach((el) => { el.style.width = `${Math.max(0, Math.min(100, (+el.dataset.deadline - Date.now()) / (S.room?.roundMs ?? 60000) * 100))}%`; });
  document.querySelectorAll('[data-left]').forEach((el) => { el.textContent = `${Math.max(0, Math.ceil((+el.dataset.left - Date.now()) / 1000))}s`; });
  document.querySelectorAll('[data-next]').forEach((el) => { el.textContent = `${el.dataset.label ?? 'Next hand in'} ${Math.max(0, Math.ceil((+el.dataset.next - Date.now()) / 1000))}s`; });
}, 1000);
addEventListener('popstate', () => {
  const p = location.pathname;
  if (p.startsWith('/room/')) return;
  if (p === '/stats' || p === '/trophies') { S.view = p === '/stats' ? 'mpstats' : 'trophies'; return loadMpStats(); }
  const r = p.match(/^\/results\/([A-Za-z0-9]{5})\/(\d+)/); if (r) { S.view = 'results'; return loadResults(r[1].toUpperCase(), r[2]); }
  S.view = 'home'; render();
});

// ---------- Boot ----------
const m = location.pathname.match(/^\/room\/([A-Za-z0-9]{5})/);
const qp = new URLSearchParams(location.search).get('play');
if (m) {
  const code = m[1].toUpperCase();
  connect();
  if (S.name) { S.view = 'room'; render(); socket?.emit('join', { code, name: S.name }, (r) => { if (r?.error) { S.roomError = r.error; S.view = 'lobby'; S.joinCode = code; render(); } else sessionStorage.setItem('fd_room', r.code); }); }
  else goLobby(code);
} else if (location.pathname === '/stats' || location.pathname === '/trophies') { S.view = location.pathname === '/stats' ? 'mpstats' : 'trophies'; loadMpStats(); }
else if (/^\/results\/[A-Za-z0-9]{5}\/\d+/.test(location.pathname)) { const [, , c, n] = location.pathname.split('/'); S.view = 'results'; loadResults(c.toUpperCase(), n); }
else if (qp === 'daily' || qp === 'random') startSolo(qp);
else render();
