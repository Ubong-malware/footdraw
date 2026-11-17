import { BONUS, HANDS, rng, shuffle, scoreHand, bestHand, makeDeck, suitGroups, shareText } from '/shared/game.js';

const BRAND = 'FootDraw';
const $root = document.getElementById('root');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wikiUrl = (t) => `https://en.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g, '_'))}`;
const isLogo = (u) => /logo|crest|badge|\.svg/i.test(u ?? '');
const today = () => new Date().toLocaleDateString('en-CA');
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Browser identity (keeps your chips + seat across reloads).
let token = localStorage.getItem('fd_token');
if (!token) { token = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join(''); localStorage.setItem('fd_token', token); }

const MODES = [
  { mode: 'daily', name: 'Daily deck', blurb: "Today's 15 cards." },
  { mode: 'random', name: 'Random deck', blurb: '15 cards from the entire football pool.' },
  { mode: 'friends', name: 'Play with friends', blurb: 'Poker with chips, up to 4 players.' },
];

const S = {
  view: 'home', menu: false, modal: null, // modal: {type:'help'} | {type:'card', card}
  solo: null, // solo game
  room: null, me: null, roomError: null, selected: [], raise: null, name: localStorage.getItem('fd_name') ?? '',
};

// ---------- Data ----------
let poolPromise = null;
const loadPool = () => (poolPromise ??= fetch('/data/pool.json').then((r) => r.json()).then((d) => ({ ...d, meta: { traits: d.traits, size: d.cards.length }, byId: new Map(d.cards.map((c) => [c.id, c])) })));

// ---------- Rendering helpers ----------
const seen = new Set();
function cardHTML(c, { idx, discarded, toggle, info, suit, hl, link = true } = {}) {
  const fresh = !seen.has(c.id); seen.add(c.id);
  const pic = c.thumbnail ? `<img src="${esc(c.thumbnail)}" alt="" decoding="async">` : `<div class="letter" aria-hidden="true">${esc(c.title[0])}</div>`;
  const inner = `<div class="pic ${isLogo(c.thumbnail) ? 'contain' : ''}">${pic}</div><div class="cap"><div class="ttl">${esc(c.title)}</div>${c.description ? `<div class="desc">${esc(c.description)}</div>` : ''}</div>`;
  const cls = `card ${discarded ? 'discarded' : ''} ${hl ? 'hl' : ''}`;
  const body = toggle
    ? `<button type="button" class="${cls}" data-act="toggle" data-i="${idx}" aria-pressed="${!!discarded}">${inner}</button>`
    : link ? `<a class="${cls}" href="${wikiUrl(c.title)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
      : `<button type="button" class="${cls}" data-act="cardinfo" data-id="${esc(c.id)}">${inner}</button>`;
  return `<div class="slot${fresh ? ' fresh' : ''}">${body}${discarded ? '<div class="tag" aria-hidden="true">Discard</div>' : ''}${suit ? `<div class="suit" aria-hidden="true">${suit}</div>` : ''}${info ? `<button type="button" class="info" data-act="info" data-id="${esc(c.id)}" aria-label="About ${esc(c.title)}">i</button>` : ''}</div>`;
}
const pileHTML = (n) => {
  const st = 2.5, k = Math.max(n - 1, 0);
  return `<div class="pile" role="img" aria-label="${n} cards left in the deck" style="padding-top:${k * st}px;padding-left:${k * st}px">${Array.from({ length: k }, (_, i) => `<div class="c s" style="top:${i * st}px;left:${i * st}px"></div>`).join('')}<div class="c top ${n === 0 ? 'empty' : ''}">${n}</div></div>`;
};
const discardsHTML = (left) => `<div class="discards" role="img" aria-label="${left} of 2 discards left"><span class="lbl">Remaining Discards:</span><span>${[0, 1].map((i) => `<span class="j ${i >= left ? 'used' : ''}">🃏</span>`).join('')}</span></div>`;
const matchTable = (r, cardsByIdx) => r.matches.length ? `<table class="wt"><thead><tr><th scope="col">In common</th><th scope="col">Cards</th><th scope="col">Points</th></tr></thead><tbody>
  ${r.matches.map((m) => `<tr><td><strong>${esc(m.label)}</strong></td><td>${m.cards.map((i) => esc(cardsByIdx[i].title)).join(', ')}</td><td>+${m.points}</td></tr>`).join('')}
  ${BONUS[r.hand] > 0 ? `<tr><td colspan="2"><em>${r.hand} bonus</em></td><td>+${BONUS[r.hand]}</td></tr>` : ''}</tbody></table>` : '<p class="muted" style="margin-bottom:16px">Nothing in this hand had anything in common.</p>';

function topbar() {
  return `<div class="topbar">
    <button type="button" class="burger ${S.menu ? 'open' : ''}" data-act="menu" aria-label="Main menu" aria-expanded="${S.menu}"><span></span><span></span><span></span></button>
    <a class="logo" href="/" data-act="home"><b>${BRAND}</b><small>The free football card game</small></a>
    <button type="button" class="help" data-act="help" aria-label="How to play" aria-haspopup="dialog"><svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-2.9 3-2.9 3"/><path d="M12 17h.01"/></svg></button>
    ${S.menu ? `<nav class="menu"><h2>Main menu</h2><ul><li><button data-act="home">Main page</button></li><li><button data-act="page" data-page="stats">Stats</button></li><li><button data-act="page" data-page="about">About</button></li></ul>
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
    return shell(c.title, `<div class="from" style="margin-bottom:0">From Wikipedia, the free encyclopedia</div><p class="body">${esc(c.extract)}</p>${['player', 'club'].includes(c.kind) ? live : ''}<p style="margin-top:10px;font-size:.9rem"><a class="link" href="${wikiUrl(c.title)}" target="_blank" rel="noopener">Read on Wikipedia</a></p>`, 'Text from Wikipedia, CC BY-SA. Live data from TheSportsDB.');
  }
  return shell('How to play', `<div class="body">
    <p>Five-card draw with Wikipedia football articles as cards: players, clubs, national teams and tournaments. Build a hand of cards that have something in common: the same nation, club, position, World Cup, decade of birth, award, etc.</p>
    <h3>Playing solo</h3><ul><li>You're dealt 5 cards from a 15-card deck.</li><li>Tap the cards you want to swap, then <strong>Discard</strong>. You'll draw the same number of cards from the deck.</li><li>You get two chances to discard and draw. <strong>Stand</strong> any time to keep your hand.</li><li>Tap <span class="ibadge">i</span> on a card to read about it. The pile in the bottom-right corner shows how many cards are left.</li></ul>
    <h3>Scoring</h3><ul><li>Every trait two or more cards share scores points.</li><li>Rarer traits score more: five players born in Rosario beat five forwards.</li><li>The most common traits, like Forward or Born in the 1980s, score little or nothing and don't count toward the hand shape.</li><li>Bigger groups score much more, plus a bonus for the shape of the hand.</li><li>What your cards share stays hidden until the end.</li></ul>
    <h3>Hands</h3><ol>${HANDS.map((h) => `<li><strong>${h} (+${BONUS[h]})</strong>: ${{ Flush: 'all five share a trait', 'Four of a Kind': 'four share a trait', 'Full House': 'three share one trait, two share another', 'Three of a Kind': 'three share a trait', 'Two Pair': 'two separate pairs', Pair: 'two share a trait', 'High Card': 'nothing shared' }[h]}</li>`).join('')}</ol>
    <h3>Play with friends (poker)</h3><ul>
      <li>2–4 players per room. Share the room link or 5-letter code. Everyone starts with <strong>1,000 chips</strong>, kept in this browser.</li>
      <li>Each hand: everyone antes 10 and gets 5 private cards from a shared deck.</li>
      <li><strong>Betting round</strong> → <strong>Draw 1</strong> → betting → <strong>Draw 2</strong> → final betting → <strong>Showdown</strong>. Draws happen at the same time; betting goes clockwise from the dealer's left.</li>
      <li>Bet, check, call, raise (no-limit, minimum raise = last raise, at least 20) or fold. All-ins create side pots.</li>
      <li>At showdown the highest FootDraw score (trait points + hand bonus) wins the pot; ties split it. If everyone else folds, the last player wins without showing.</li>
      <li>45 seconds per turn: time out and you check (or fold if facing a bet). Out of chips? Rebuy between hands.</li></ul>
    <h3>Modes</h3><ul><li><strong>Daily deck</strong>: the day's 15 cards are the same for everyone, shuffled uniquely for each player.</li><li><strong>Random deck</strong>: 15 cards from the entire pool.</li><li><strong>Play with friends</strong>: online poker rooms.</li></ul></div>`);
}

// ---------- Views ----------
function render() {
  let body = '', after = '';
  if (S.view === 'stats') body = pageHead('Stats') + statsHTML();
  else if (S.view === 'about') body = pageHead(`About ${BRAND}`) + `<div class="prose"><p>${BRAND} is five-card draw played with Wikipedia's football articles: famous players, clubs, national teams and tournaments. Card traits come from Wikidata, texts and images from Wikipedia, and live squad info from TheSportsDB.</p><p>Inspired by the format of Wikdraw. If you enjoy the game, consider <a href="https://donate.wikimedia.org/" target="_blank" rel="noopener">donating to Wikipedia</a>.</p></div>`;
  else if (S.view === 'solo') ({ body, after } = soloHTML());
  else if (S.view === 'lobby') body = lobbyHTML();
  else if (S.view === 'room') ({ body, after } = roomHTML());
  else body = pageHead(`Welcome to ${BRAND}`) + `<div class="modes">${MODES.map((m) => `<button type="button" class="mode" data-act="mode" data-mode="${m.mode}"><strong>${m.name}</strong><span>${m.blurb}</span></button>`).join('')}</div>`;
  const active = document.activeElement?.id;
  $root.innerHTML = `<main class="main"><div class="screen">${topbar()}${body}</div>${after}</main>${modalHTML()}`;
  if (active && document.getElementById(active)) document.getElementById(active).focus();
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
  const mp = S.me ? `<section><h2>Play with friends</h2><dl><div><dt>Chip balance</dt><dd>${S.me.chips.toLocaleString()}</dd></div></dl></section>` : '';
  return `<div class="stats">${MODES.slice(0, 2).map(({ mode, name }) => {
    const s = all[mode];
    return `<section><h2>${name}</h2>${!s?.games ? '<p class="note">No games yet.</p>' : `<dl><div><dt>High score</dt><dd>${s.best} pts</dd></div><div><dt>Games</dt><dd>${s.games.toLocaleString()}</dd></div></dl>
      <table class="wt"><thead><tr><th scope="col">Hand</th><th scope="col">Count</th></tr></thead><tbody>${HANDS.map((h) => `<tr><td>${h}</td><td>${(s.hands[h] ?? 0).toLocaleString()}</td></tr>`).join('')}</tbody></table>`}</section>`;
  }).join('')}${mp}<p class="note">Stats belong to this browser. Clearing its data or starting in a different browser won't carry the data over.</p></div>`;
}

// ---------- Solo game ----------
async function startSolo(mode) {
  S.view = 'solo'; S.menu = false; S.solo = { loading: true, mode }; render();
  const pool = await loadPool();
  const date = new URLSearchParams(location.search).get('date') ?? today();
  const key = `fd_daily_${date}`;
  let g;
  const saved = mode === 'daily' && JSON.parse(localStorage.getItem(key) ?? 'null');
  if (saved) g = { ...saved };
  else {
    const deck = mode === 'daily'
      ? shuffle(makeDeck(pool.cards, pool.meta, 15, rng(`daily:${date}`)), rng(`${token}:${date}`)).map((c) => c.id)
      : makeDeck(pool.cards, pool.meta, 15, Math.random).map((c) => c.id);
    g = { deck, hand: deck.slice(0, 5), pos: 5, keeps: [], stages: [deck.slice(0, 5)], done: false };
  }
  seen.clear();
  S.solo = { ...g, mode, date, key, selected: [], pool, step: Infinity, busy: false };
  if (g.done) finishSolo(true);
  render();
}
const saveSolo = () => { const g = S.solo; if (g.mode === 'daily') localStorage.setItem(g.key, JSON.stringify({ deck: g.deck, hand: g.hand, pos: g.pos, keeps: g.keeps, stages: g.stages, done: g.done, pb: g.pb })); };
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
  // Reveal sequence (mirrors the original: suits pop in, hand name, each match, bonus, total).
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
  Object.assign(g, { scenes, suitAt, order, step: restored || reduced() ? scenes.length - 1 : 0 });
  const tick = () => { if (S.solo !== g || g.step >= scenes.length - 1) return; setTimeout(() => { if (S.solo !== g) return; g.step++; if (S.view === 'solo') render(); tick(); }, scenes[g.step].hold); };
  tick(); render();
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
  const r = g.result; const { scene } = g.scenes[Math.min(g.step, g.scenes.length - 1)];
  const shown = new Set(g.order.slice(0, scene.suits));
  const curMatch = scene.done || scene.bonus ? null : r.matches[scene.matches - 1];
  const title = g.mode === 'daily' ? g.date : 'Random';
  let line = '';
  if (scene.done) line = `${BRAND} ${title}`;
  else if (scene.bonus) line = `${r.hand} bonus <strong>+${BONUS[r.hand]}</strong>`;
  else if (curMatch) line = `${esc(curMatch.label)} <strong>+${curMatch.points}</strong>`;
  const pb = g.pb; const share = shareText(BRAND, title, r.hand, r.points, r.stages) + `\n${location.origin}`;
  const body = `<div class="above"><div class="score" style="opacity:${scene.name ? 1 : 0}"><h1>${r.hand}</h1><p class="pts"><span>${scene.points}</span> pts</p><p class="line">${line}</p>
      <p class="pb">${scene.done && pb ? (pb.previous !== null && r.points > pb.previous ? `<strong>New personal best! (was ${pb.previous} pts)</strong>` : `Personal best: ${pb.points} pts`) : ''}</p></div></div>
    <div class="grid">${cards.map((c, i) => cardHTML(c, { suit: shown.has(i) ? g.suitAt[i] : null, hl: curMatch?.cards.includes(i) })).join('')}</div>
    <div class="below">${scene.done ? `<div class="after"><div class="row"><button class="btn" data-act="copy">Copy result</button><button class="btn primary" data-act="mode" data-mode="random">${g.mode === 'daily' ? 'Play a random deck' : 'Play again'}</button></div><pre class="share">${esc(share)}</pre></div>` : ''}</div>`;
  const best = r.best;
  const after = scene.done ? `<div style="padding-top:24px">${matchTable(r, r.cards)}<section class="section">${best.points <= r.points ? '<h2>That was the best hand possible in your deck!</h2>'
    : `<h2>The best hand in your deck: ${best.hand}, ${best.points} pts</h2><p class="links">${best.cards.map((c) => `<a href="${wikiUrl(c.title)}" target="_blank" rel="noopener noreferrer">${esc(c.title)}</a>`).join(' · ')}</p>${matchTable(best, best.cards)}`}</section><p class="foot">Text from Wikipedia, CC BY-SA. Traits from Wikidata, CC0.</p></div>` : '';
  return { body, after };
}

// ---------- Multiplayer ----------
let socket = null;
function connect() {
  if (socket) return socket;
  if (!window.io) { S.roomError = 'Multiplayer server not reachable.'; return null; }
  socket = io({ auth: { token } });
  socket.on('me', (me) => { S.me = me; if (!S.name && me.name !== 'Player') S.name = me.name; });
  socket.on('state', (st) => {
    const prevPhase = S.room?.game?.phase + ':' + S.room?.game?.street;
    S.room = st; S.me = { ...(S.me ?? {}), chips: st.seats.find((s) => s.isYou)?.chips ?? S.me?.chips };
    const phase = st.game?.phase + ':' + st.game?.street;
    if (phase !== prevPhase || st.game?.you?.drawDone) S.selected = [];
    if (st.handNo !== S.lastHandNo) { S.lastHandNo = st.handNo; seen.clear(); }
    if (S.view === 'room' || S.view === 'lobby') { S.view = 'room'; render(); }
  });
  socket.on('connect', () => { // reconnect: rejoin the room we were in
    const code = S.room?.code ?? sessionStorage.getItem('fd_room');
    if (code && (S.view === 'room' || S.view === 'lobby')) socket.emit('join', { code, name: S.name }, (r) => { if (r?.error) { S.roomError = r.error; S.room = null; S.view = 'lobby'; render(); } });
  });
  socket.on('disconnect', () => { if (S.view === 'room') { S.roomError = 'Connection lost. Reconnecting…'; render(); } });
  return socket;
}
function lobbyHTML() {
  return pageHead('Play with friends') + `<div class="form">
    <p class="prose">Poker with football cards. Create a room and send the link to up to 3 friends, or join with a code. ${S.me ? `Your balance: <strong>${S.me.chips.toLocaleString()} chips</strong>.` : ''}</p>
    <label>Your name<input id="nm" maxlength="20" autocomplete="nickname" value="${esc(S.name)}" placeholder="e.g. Pelé"></label>
    <button class="btn primary" data-act="create">Create a room</button>
    <div class="row"><input id="code" maxlength="5" placeholder="Room code" style="text-transform:uppercase" value="${esc(S.joinCode ?? '')}"><button class="btn" data-act="join">Join room</button></div>
    ${S.roomError ? `<p class="err" role="alert">${esc(S.roomError)}</p>` : ''}</div>`;
}
const phaseLabel = (g) => g.phase === 'bet' ? `Betting round ${g.street} of 3` : g.phase === 'draw' ? `Draw ${g.street} of 2` : 'Showdown';
function roomHTML() {
  const st = S.room; if (!st) return { body: '<p class="center-msg">Joining…</p>', after: '' };
  const g = st.game; const you = g?.you; const meSeat = st.seats.find((s) => s.isYou);
  const seatsHTML = Array.from({ length: 4 }, (_, i) => {
    const s = st.seats[i];
    if (!s) return `<div class="seat empty">Open seat</div>`;
    const isTurn = g?.phase === 'bet' && g.turnSeat === i;
    let status = !s.inHand ? (g ? 'Waiting for next hand' : '') : s.folded ? 'Folded' : s.allIn ? 'All in' : g?.phase === 'draw' ? (s.ready ? `Drew ${s.drawn.at(-1) ?? 0}` : 'Choosing…') : s.bet ? `Bet ${s.bet}` : '';
    return `<div class="seat ${isTurn ? 'turn' : ''} ${s.folded ? 'folded' : ''}">${s.dealer ? '<span class="d" title="Dealer">D</span>' : ''}<div class="nm">${esc(s.name)}${s.isYou ? ' (you)' : ''}${s.isHost ? ' ★' : ''}</div><div class="ch">${s.chips.toLocaleString()} chips</div><div class="st">${status}${s.connected ? '' : ' <span class="off">· offline</span>'}</div></div>`;
  }).join('');
  const invite = `${location.origin}/room/${st.code}`;
  let body = `<div class="roomhead"><span>Room</span><span class="code">${st.code}</span><button class="btn small" data-act="copylink" data-link="${esc(invite)}">${S.copied ? 'Link copied' : 'Copy invite link'}</button><button class="btn small" data-act="leave">Leave</button>${S.roomError ? `<span class="err">${esc(S.roomError)}</span>` : ''}</div>
    <div class="seats">${seatsHTML}</div>`;
  let bar = '', after = '';
  if (g) {
    const turnName = g.turnSeat != null ? st.seats[g.turnSeat]?.name : null;
    body += `<div class="potline"><span>Pot <span class="pot">${g.pot}</span></span><span>${phaseLabel(g)}</span>${g.currentBet ? `<span>Bet ${g.currentBet}</span>` : ''}</div>`;
    if (you && !you.folded) {
      const drawing = g.phase === 'draw' && !you.drawDone;
      body += `<div class="above">${discardsHTML(you.drawsLeft)}</div><div class="grid">${you.hand.map((c, i) => cardHTML(c, { idx: i, toggle: drawing, link: !drawing, discarded: drawing && S.selected.includes(i), info: true })).join('')}</div>`;
    } else body += `<div class="above"><p class="center-msg">${you ? 'You folded. Waiting for the hand to finish…' : 'You joined mid-hand. You will be dealt in next hand.'}</p></div>`;
    const timer = g.deadline ? `<div class="timer"><i data-deadline="${g.deadline}" style="width:${Math.max(0, Math.min(100, (g.deadline - Date.now()) / st.turnMs * 100))}%"></i></div>` : '';
    let problem = '', buttons = '';
    if (you && !you.folded && g.phase === 'bet' && g.yourTurn) {
      const toCall = you.toCall; const max = meSeat.chips + (meSeat.bet ?? 0);
      const minTo = Math.min(max, g.currentBet + g.minRaise);
      if (S.raise === null || S.raise < minTo || S.raise > max) S.raise = minTo;
      problem = `Your turn${toCall ? ` · ${toCall} to call` : ''}`;
      buttons = `<div class="raise"><input type="range" id="rr" min="${minTo}" max="${max}" step="10" value="${S.raise}" aria-label="Raise amount"><input type="number" id="rn" min="${minTo}" max="${max}" value="${S.raise}" aria-label="Raise to"></div>
        <button class="btn" data-act="fold">Fold</button>${toCall ? `<button class="btn" data-act="call">${toCall >= meSeat.chips ? 'Call all in' : `Call ${toCall}`}</button>` : `<button class="btn" data-act="check">Check</button>`}
        <button class="btn primary" data-act="raise" ${max <= g.currentBet ? 'disabled' : ''}>${S.raise >= max ? 'All in' : g.currentBet ? `Raise to ${S.raise}` : `Bet ${S.raise}`}</button>`;
      bar = `<div class="bar"><p class="problem">${problem}</p>${timer}<div class="pilewrap">${pileHTML(g.deckLeft)}</div><div class="buttons three">${buttons}</div></div>`;
    } else if (you && !you.folded && g.phase === 'draw' && !you.drawDone) {
      bar = `<div class="bar"><p class="problem">Draw ${g.street} of 2: tap cards to swap</p>${timer}<div class="pilewrap">${pileHTML(g.deckLeft)}</div><div class="buttons"><button class="btn" data-act="pat">Stand pat</button><button class="btn primary" data-act="mpdraw" ${S.selected.length ? '' : 'disabled'}>${S.selected.length ? `Discard ${S.selected.length}` : 'Select cards'}</button></div></div>`;
    } else {
      const wait = g.phase === 'bet' ? `Waiting for ${esc(turnName ?? '…')}` : 'Waiting for other players to draw…';
      bar = `<div class="bar"><p class="problem muted">${wait}</p>${timer}<div class="pilewrap">${pileHTML(g.deckLeft)}</div><div class="buttons"></div></div>`;
    }
    body += `<div class="below">${bar}</div>`;
  } else {
    const can = st.seats.filter((s) => s.chips >= st.ante).length >= 2;
    const broke = meSeat && meSeat.chips < st.ante;
    const count = st.nextAt ? `<span data-next="${st.nextAt}">Next hand in ${Math.max(0, Math.ceil((st.nextAt - Date.now()) / 1000))}s</span>` : '';
    body += `<div class="above">${st.result ? resultHeadHTML(st) : `<p class="center-msg">${st.seats.length < 2 ? 'Waiting for friends to join… Share the invite link.' : 'Ready when you are.'}</p>`}</div>
      <div class="below"><div class="bar"><p class="problem muted">${count}</p><div class="pilewrap"></div><div class="buttons">${broke ? '<button class="btn" data-act="rebuy">Rebuy 1,000</button>' : '<span></span>'}<button class="btn primary" data-act="start" ${can ? '' : 'disabled'}>${st.handNo ? 'Deal next hand' : 'Deal first hand'}</button></div></div></div>`;
    if (st.result) after = resultDetailHTML(st);
  }
  after += `<div class="log" aria-live="polite">${st.log.slice().reverse().map((l) => `<div>${esc(l.msg)}</div>`).join('')}</div><p class="foot">Text from Wikipedia, CC BY-SA. Traits from Wikidata.</p>`;
  return { body, after };
}
function resultHeadHTML(st) {
  const r = st.result; const winners = r.players.filter((p) => p.won > 0);
  const top = winners[0];
  return `<div class="score"><h1>${r.uncontested ? `${esc(top?.name)} takes it` : `${winners.map((w) => esc(w.name)).join(' & ')} win${winners.length > 1 ? '' : 's'}`}</h1>
    <p class="pts"><span>${r.pot}</span> chips</p><p class="line">${r.uncontested ? 'Everyone else folded.' : `${esc(top?.hand)}, ${top?.points} pts`}</p></div>`;
}
function resultDetailHTML(st) {
  const r = st.result;
  const shown = r.players.filter((p) => p.hand).sort((a, b) => b.points - a.points);
  return `<div style="padding-top:8px">${shown.map((p) => `<div class="player-res"><h3><span>${esc(p.name)} · ${p.hand}, ${p.points} pts</span><span class="${p.net >= 0 ? 'win' : 'lose'}">${p.net >= 0 ? '+' : ''}${p.net}</span></h3>
    <div class="mini">${p.cards.map((c) => cardHTML(c, {})).join('')}</div>${matchTable(p, p.cards)}</div>`).join('')}
    ${r.players.filter((p) => !p.hand).map((p) => `<p class="note">${esc(p.name)}: ${p.folded ? 'folded' : 'mucked'} (${p.net >= 0 ? '+' : ''}${p.net})</p>`).join('')}</div>`;
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
  const st = S.room; return st?.game?.you?.hand.find((c) => c.id === id) ?? st?.result?.players.flatMap((p) => p.cards).find((c) => c.id === id);
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
    case 'start': return emit('start');
    case 'rebuy': return emit('rebuy');
    case 'fold': case 'check': case 'call': return emit('act', { type: a });
    case 'raise': return emit('act', { type: 'raise', amount: S.raise });
    case 'pat': return emit('draw', { discards: [] });
    case 'mpdraw': return emit('draw', { discards: S.selected });
  }
});
$root.addEventListener('input', (e) => {
  if (e.target.id === 'rr' || e.target.id === 'rn') {
    S.raise = +e.target.value;
    const other = document.getElementById(e.target.id === 'rr' ? 'rn' : 'rr'); if (other) other.value = S.raise;
    const btn = document.querySelector('[data-act="raise"]'); const max = +e.target.max;
    if (btn) btn.textContent = S.raise >= max ? 'All in' : S.room.game.currentBet ? `Raise to ${S.raise}` : `Bet ${S.raise}`;
  }
});
$root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.target.id === 'code' || e.target.id === 'nm')) document.querySelector(`[data-act="${e.target.id === 'code' ? 'join' : 'create'}"]`)?.click(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && (S.modal || S.menu)) { S.modal = null; S.menu = false; render(); } });
// Countdown bars without full re-renders.
setInterval(() => {
  document.querySelectorAll('[data-deadline]').forEach((el) => { el.style.width = `${Math.max(0, Math.min(100, (+el.dataset.deadline - Date.now()) / (S.room?.turnMs ?? 45000) * 100))}%`; });
  document.querySelectorAll('[data-next]').forEach((el) => { el.textContent = `Next hand in ${Math.max(0, Math.ceil((+el.dataset.next - Date.now()) / 1000))}s`; });
}, 1000);
addEventListener('popstate', () => { if (!location.pathname.startsWith('/room/')) { S.view = 'home'; render(); } });

// ---------- Boot ----------
const m = location.pathname.match(/^\/room\/([A-Za-z0-9]{5})/);
const qp = new URLSearchParams(location.search).get('play');
if (m) {
  const code = m[1].toUpperCase();
  connect();
  if (S.name) { S.view = 'room'; render(); socket?.emit('join', { code, name: S.name }, (r) => { if (r?.error) { S.roomError = r.error; S.view = 'lobby'; S.joinCode = code; render(); } else sessionStorage.setItem('fd_room', r.code); }); }
  else goLobby(code);
} else if (qp === 'daily' || qp === 'random') startSolo(qp);
else render();
