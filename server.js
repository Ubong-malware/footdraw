// FootDraw server: serves the static site and runs multiplayer poker rooms over Socket.IO.
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomBytes, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { scoreHand, compareResults, makeDeck, shuffle, BONUS } from './public/shared/game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT ?? 8080);
const START_CHIPS = +(process.env.START_CHIPS ?? 1000);
const ANTE = +(process.env.ANTE ?? 10);
const MAX_PLAYERS = 4;
const TURN_MS = +(process.env.TURN_MS ?? 45000);
const NEXT_HAND_MS = +(process.env.NEXT_HAND_MS ?? 15000);
const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, 'data');
const BALANCES = path.join(DATA_DIR, 'balances.json');

const poolData = JSON.parse(readFileSync(path.join(__dirname, 'public/data/pool.json'), 'utf8'));
const POOL = poolData.cards;
const META = { traits: poolData.traits, size: POOL.length };
const CARD = new Map(POOL.map((c) => [c.id, c]));

// ---------- Persistent balances (per browser token) ----------
mkdirSync(DATA_DIR, { recursive: true });
const balances = existsSync(BALANCES) ? JSON.parse(readFileSync(BALANCES, 'utf8')) : {};
let saveTimer = null;
const saveBalances = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeFileSync(BALANCES, JSON.stringify(balances)), 200);
};
const account = (token, name) => {
  balances[token] ??= { chips: START_CHIPS, name: name ?? 'Player', hands: 0, won: 0 };
  if (name) balances[token].name = name;
  return balances[token];
};

// ---------- App ----------
const app = express();
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/health', (_, res) => res.json({ ok: true, rooms: rooms.size }));
// TheSportsDB (free public test key "123") proxied so the client never needs a key and we can cache.
const SPORTSDB_KEY = process.env.SPORTSDB_KEY ?? '123';
const sdbCache = new Map();
app.get('/api/sportsdb/:kind', async (req, res) => {
  const { kind } = req.params;
  const q = String(req.query.q ?? '').slice(0, 100);
  const ep = { player: `searchplayers.php?p=${encodeURIComponent(q)}`, team: `searchteams.php?t=${encodeURIComponent(q)}` }[kind];
  if (!ep || !q) return res.status(400).json({ error: 'bad request' });
  const key = `${kind}:${q}`;
  if (sdbCache.has(key)) return res.json(sdbCache.get(key));
  try {
    const r = await fetch(`https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/${ep}`);
    const j = r.ok ? await r.json() : {};
    const item = (j.player ?? j.teams ?? []).find((x) => (x.strSport ?? 'Soccer') === 'Soccer') ?? null;
    const out = item && (kind === 'player'
      ? { team: item.strTeam, nationality: item.strNationality, position: item.strPosition, born: item.dateBorn, status: item.strStatus, image: item.strCutout || item.strThumb }
      : { league: item.strLeague, stadium: item.strStadium, formed: item.intFormedYear, location: item.strLocation, badge: item.strBadge, website: item.strWebsite });
    sdbCache.set(key, out);
    res.json(out);
  } catch { res.json(null); }
});
app.get('/room/:code', (_, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

const http = createServer(app);
const io = new Server(http, { cors: { origin: true } });

// ---------- Rooms ----------
const rooms = new Map();
const newCode = () => { let c; do { c = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(32)]).join(''); } while (rooms.has(c)); return c; };
const publicCard = (id) => { const c = CARD.get(id); return { id, title: c.title, description: c.description, thumbnail: c.thumbnail, extract: c.extract, kind: c.kind }; };

function createRoom(hostToken) {
  const room = { code: newCode(), host: hostToken, seats: [], game: null, log: [], handNo: 0, dealer: -1, timer: null, nextAt: null, lastResult: null, created: Date.now() };
  rooms.set(room.code, room);
  return room;
}
const seatOf = (room, token) => room.seats.find((s) => s.token === token);
const say = (room, msg) => { room.log.push({ t: Date.now(), msg }); if (room.log.length > 60) room.log.shift(); };

function broadcast(room) {
  for (const s of room.seats) if (s.socketId) io.to(s.socketId).emit('state', viewFor(room, s.token));
}

function viewFor(room, token) {
  const g = room.game;
  const me = seatOf(room, token);
  return {
    code: room.code, host: room.host === token, handNo: room.handNo, ante: ANTE,
    nextAt: room.nextAt, turnMs: TURN_MS,
    seats: room.seats.map((s, i) => {
      const p = g?.players[s.token];
      return {
        seat: i, name: s.name, chips: s.chips, connected: !!s.socketId, isYou: s.token === token,
        isHost: s.token === room.host, dealer: g ? g.dealerToken === s.token : false,
        inHand: !!p, folded: p?.folded ?? false, allIn: p?.allIn ?? false, bet: p?.bet ?? 0,
        drawn: p ? p.draws.map((d) => d.length) : [], ready: g?.phase.startsWith('draw') ? !!p?.drawDone : null,
        cardsCount: p?.hand.length ?? 0, sittingOut: s.sittingOut,
      };
    }),
    game: g && {
      phase: g.phase, street: g.street, pot: g.pot, currentBet: g.currentBet, minRaise: g.minRaise,
      turnSeat: g.turn ? room.seats.findIndex((s) => s.token === g.turn) : null, yourTurn: g.turn === token, deadline: g.deadline, deckLeft: g.deck.length - g.deckPos,
      you: me && g.players[token] && {
        hand: g.players[token].hand.map(publicCard), folded: g.players[token].folded,
        toCall: Math.max(0, g.currentBet - g.players[token].bet), drawsLeft: 2 - g.players[token].draws.length,
        drawDone: !!g.players[token].drawDone,
      },
    },
    result: room.lastResult,
    log: room.log.slice(-25),
  };
}

function clearTimer(room) { clearTimeout(room.timer); room.timer = null; }

function startHand(room) {
  clearTimer(room); room.nextAt = null;
  const eligible = room.seats.filter((s) => s.chips >= ANTE && !s.sittingOut);
  if (eligible.length < 2) { room.game = null; say(room, 'Need at least 2 players with chips to deal.'); broadcast(room); return; }
  room.handNo++;
  room.lastResult = null;
  // Rotate the dealer button among eligible seats.
  const order = room.seats.filter((s) => eligible.includes(s));
  const prevIdx = order.findIndex((s) => s.token === room.dealerToken);
  const dealer = order[(prevIdx + 1) % order.length];
  room.dealerToken = dealer.token;
  const seq = [...order.slice(order.indexOf(dealer) + 1), ...order.slice(0, order.indexOf(dealer) + 1)];
  const deck = makeDeck(POOL, META, 16 + 10 * seq.length, () => randomInt(2 ** 32) / 2 ** 32).map((c) => c.id);
  const g = { phase: 'bet', street: 1, deck, deckPos: 0, pot: 0, currentBet: 0, minRaise: ANTE * 2, order: seq.map((s) => s.token), dealerToken: dealer.token, players: {}, turn: null, deadline: null };
  room.game = g;
  for (const s of seq) {
    const ante = Math.min(ANTE, s.chips);
    s.chips -= ante; g.pot += ante;
    g.players[s.token] = { hand: deck.slice(g.deckPos, g.deckPos + 5), folded: false, allIn: s.chips === 0, bet: 0, contributed: ante, acted: false, draws: [], drawDone: false, stages: [] };
    g.deckPos += 5;
    g.players[s.token].stages.push(g.players[s.token].hand.slice());
  }
  say(room, `Hand #${room.handNo}: ${dealer.name} deals. Everyone antes ${ANTE}.`);
  startBetting(room);
}

const live = (g) => g.order.filter((t) => !g.players[t].folded);
const canAct = (g) => live(g).filter((t) => !g.players[t].allIn);

function startBetting(room) {
  const g = room.game;
  g.phase = 'bet'; g.currentBet = 0; g.minRaise = ANTE * 2;
  for (const t of g.order) { g.players[t].bet = 0; g.players[t].acted = false; }
  if (canAct(g).length < 2) return advance(room); // nothing to bet on
  g.turn = canAct(g)[0];
  armTurn(room);
  broadcast(room);
}

function armTurn(room) {
  const g = room.game; clearTimer(room);
  g.deadline = Date.now() + TURN_MS;
  room.timer = setTimeout(() => {
    if (g.phase === 'bet') {
      const p = g.players[g.turn];
      act(room, g.turn, p.bet >= g.currentBet ? { type: 'check' } : { type: 'fold' }, true);
    } else if (g.phase === 'draw') {
      for (const t of live(g)) if (!g.players[t].drawDone) doDraw(room, t, [], true);
    }
  }, TURN_MS);
}

function act(room, token, action, auto = false) {
  const g = room.game;
  if (!g || g.phase !== 'bet' || g.turn !== token) return 'Not your turn';
  const p = g.players[token]; const seat = seatOf(room, token);
  const toCall = g.currentBet - p.bet;
  const put = (n) => { n = Math.min(n, seat.chips); seat.chips -= n; p.bet += n; p.contributed += n; g.pot += n; if (seat.chips === 0) p.allIn = true; return n; };
  switch (action.type) {
    case 'fold': p.folded = true; say(room, `${seat.name} folds${auto ? ' (timed out)' : ''}.`); break;
    case 'check': if (toCall > 0) return 'You must call, raise or fold'; say(room, `${seat.name} checks${auto ? ' (timed out)' : ''}.`); break;
    case 'call': if (toCall <= 0) return 'Nothing to call'; put(toCall); say(room, `${seat.name} calls ${Math.min(toCall, p.bet)}${p.allIn ? ' (all in)' : ''}.`); break;
    case 'raise': {
      // amount = total bet this round the player wants to reach
      const target = Math.floor(Number(action.amount));
      const max = p.bet + seat.chips;
      if (!Number.isFinite(target)) return 'Bad amount';
      const allIn = target >= max;
      if (!allIn && target < g.currentBet + g.minRaise) return `Minimum raise is to ${g.currentBet + g.minRaise}`;
      const reach = Math.min(target, max);
      put(reach - p.bet);
      if (p.bet > g.currentBet) {
        const raiseBy = p.bet - g.currentBet;
        if (raiseBy >= g.minRaise) g.minRaise = raiseBy;
        g.currentBet = p.bet;
        for (const t of g.order) if (t !== token) g.players[t].acted = false;
      }
      say(room, `${seat.name} ${g.currentBet === p.bet && toCall === 0 && p.bet === reach ? 'bets' : 'raises to'} ${p.bet}${p.allIn ? ' (all in)' : ''}.`);
      break;
    }
    default: return 'Unknown action';
  }
  p.acted = true;
  if (live(g).length === 1) return endHand(room);
  const pending = canAct(g).filter((t) => !g.players[t].acted || g.players[t].bet < g.currentBet);
  if (pending.length === 0 || (canAct(g).length <= 1 && canAct(g).every((t) => g.players[t].bet >= g.currentBet))) return advance(room);
  // next player after current in order who still needs to act
  const idx = g.order.indexOf(token);
  for (let i = 1; i <= g.order.length; i++) {
    const t = g.order[(idx + i) % g.order.length];
    if (pending.includes(t)) { g.turn = t; break; }
  }
  armTurn(room); broadcast(room);
}

function advance(room) {
  const g = room.game;
  if (g.phase === 'bet' && g.street < 3) {
    g.phase = 'draw'; g.turn = null;
    for (const t of live(g)) g.players[t].drawDone = false;
    say(room, `Draw ${g.street} of 2: pick cards to discard, or stand pat.`);
    armTurn(room); broadcast(room); return;
  }
  if (g.phase === 'draw') { g.street++; return startBetting(room); }
  return endHand(room);
}

function doDraw(room, token, discards, auto = false) {
  const g = room.game;
  if (!g || g.phase !== 'draw') return 'Not the draw phase';
  const p = g.players[token];
  if (!p || p.folded || p.drawDone) return 'Already done';
  const idx = [...new Set((discards ?? []).map(Number))].filter((i) => Number.isInteger(i) && i >= 0 && i < 5);
  const n = Math.min(idx.length, g.deck.length - g.deckPos);
  const use = idx.slice(0, n);
  for (const i of use) p.hand[i] = g.deck[g.deckPos++];
  p.draws.push(use); p.stages.push(p.hand.slice()); p.drawDone = true;
  const seat = seatOf(room, token);
  say(room, use.length ? `${seat.name} draws ${use.length}.` : `${seat.name} stands pat${auto ? ' (timed out)' : ''}.`);
  if (live(g).every((t) => g.players[t].drawDone)) return advance(room);
  broadcast(room);
}

const cardsOf = (ids) => ids.map((id) => CARD.get(id));

function endHand(room) {
  const g = room.game; clearTimer(room);
  g.phase = 'showdown'; g.turn = null;
  const contenders = live(g);
  const results = {};
  for (const t of contenders) results[t] = scoreHand(cardsOf(g.players[t].hand), META);
  // Side pots from contribution layers.
  const contrib = g.order.map((t) => ({ t, c: g.players[t].contributed }));
  const levels = [...new Set(contrib.map((x) => x.c))].filter((c) => c > 0).sort((a, b) => a - b);
  const winnings = {}; let prev = 0; const pots = [];
  for (const lvl of levels) {
    const amount = contrib.reduce((s, x) => s + Math.max(0, Math.min(x.c, lvl) - prev), 0);
    const eligible = contenders.filter((t) => g.players[t].contributed >= lvl);
    prev = lvl;
    if (!amount) continue;
    const pool = eligible.length ? eligible : contenders;
    const sorted = [...pool].sort((a, b) => compareResults(results[a], results[b]));
    const top = sorted.filter((t) => compareResults(results[t], results[sorted[0]]) === 0);
    const share = Math.floor(amount / top.length); let rem = amount - share * top.length;
    for (const t of top) { winnings[t] = (winnings[t] ?? 0) + share + (rem-- > 0 ? 1 : 0); }
    pots.push({ amount, winners: top.map((t) => seatOf(room, t)?.name ?? '?') });
  }
  for (const [t, w] of Object.entries(winnings)) { const s = seatOf(room, t); if (s) s.chips += w; }
  const uncontested = contenders.length === 1;
  room.lastResult = {
    handNo: room.handNo, uncontested, pot: g.pot, pots,
    players: g.order.map((t) => {
      const s = seatOf(room, t); const p = g.players[t]; const r = results[t];
      const show = !uncontested && r;
      return {
        name: s?.name ?? 'Left', folded: p.folded, won: winnings[t] ?? 0, net: (winnings[t] ?? 0) - p.contributed,
        hand: show ? r.hand : null, points: show ? r.points : null, bonus: show ? BONUS[r.hand] : null,
        matches: show ? r.matches : [], cards: show ? p.hand.map(publicCard) : [],
        stages: show ? p.stages.map((h) => scoreHand(cardsOf(h), META)) : [],
      };
    }),
  };
  const winners = Object.keys(winnings).map((t) => seatOf(room, t)?.name).filter(Boolean);
  say(room, uncontested ? `${winners[0]} wins ${g.pot} (everyone else folded).` : `${winners.join(' & ')} win${winners.length > 1 ? '' : 's'} the pot of ${g.pot}.`);
  for (const s of room.seats) {
    const a = account(s.token); a.chips = s.chips;
    if (g.players[s.token]) { a.hands++; if (winnings[s.token]) a.won++; }
  }
  saveBalances();
  room.game = null;
  // Drop seats that left mid-hand.
  room.seats = room.seats.filter((s) => !s.leaving);
  if (!room.seats.some((s) => s.token === room.host) && room.seats[0]) room.host = room.seats[0].token;
  room.nextAt = Date.now() + NEXT_HAND_MS;
  room.timer = setTimeout(() => { if (room.seats.filter((s) => s.chips >= ANTE && !s.sittingOut).length >= 2) startHand(room); else { room.nextAt = null; broadcast(room); } }, NEXT_HAND_MS);
  broadcast(room);
}

// ---------- Sockets ----------
io.on('connection', (socket) => {
  const token = String(socket.handshake.auth?.token ?? '').slice(0, 64);
  if (!/^[a-f0-9]{16,64}$/.test(token)) { socket.emit('fatal', 'Bad session token'); return socket.disconnect(); }
  let roomCode = null;
  const room = () => rooms.get(roomCode);
  const ack = (cb, v) => typeof cb === 'function' && cb(v);
  socket.emit('me', { chips: account(token).chips, name: account(token).name });

  function join(code, name, cb) {
    const r = rooms.get(String(code ?? '').toUpperCase());
    if (!r) return ack(cb, { error: 'Room not found' });
    let s = seatOf(r, token);
    if (!s) {
      if (r.seats.length >= MAX_PLAYERS) return ack(cb, { error: 'Room is full (4 players max)' });
      const a = account(token, name);
      s = { token, name: a.name, chips: a.chips, socketId: null, sittingOut: false };
      r.seats.push(s);
      say(r, `${s.name} joined with ${s.chips} chips.`);
      if (!r.game && !r.nextAt && r.handNo > 0 && r.seats.length >= 2) { r.nextAt = Date.now() + 5000; clearTimer(r); r.timer = setTimeout(() => startHand(r), 5000); }
    } else {
      if (name) s.name = account(token, name).name;
      s.leaving = false;
      if (!s.socketId) say(r, `${s.name} reconnected.`);
    }
    if (roomCode && roomCode !== r.code) leave();
    s.socketId = socket.id; roomCode = r.code; socket.join(r.code);
    ack(cb, { ok: true, code: r.code });
    broadcast(r);
  }
  function leave() {
    const r = room(); if (!r) return;
    const s = seatOf(r, token); roomCode = null; socket.leave(r.code);
    if (!s) return;
    s.socketId = null;
    say(r, `${s.name} left.`);
    if (r.game?.players[token] && !r.game.players[token].folded) {
      s.leaving = true;
      if (r.game.phase === 'bet' && r.game.turn === token) act(r, token, { type: 'fold' });
      else { r.game.players[token].folded = true; if (live(r.game).length === 1) endHand(r); else if (r.game.phase === 'draw' && live(r.game).every((t) => r.game.players[t].drawDone)) advance(r); }
    } else if (r.game?.players[token]) s.leaving = true;
    else r.seats = r.seats.filter((x) => x !== s);
    if (!r.seats.some((x) => x.token === r.host) && r.seats[0]) r.host = r.seats[0].token;
    if (r.seats.length === 0) { clearTimer(r); rooms.delete(r.code); return; }
    broadcast(r);
  }

  socket.on('setName', (name, cb) => { account(token, String(name).slice(0, 20).trim() || 'Player'); ack(cb, { ok: true }); });
  socket.on('create', ({ name } = {}, cb) => { const r = createRoom(token); join(r.code, String(name ?? '').slice(0, 20).trim() || undefined, cb); });
  socket.on('join', ({ code, name } = {}, cb) => join(code, String(name ?? '').slice(0, 20).trim() || undefined, cb));
  socket.on('leave', (_, cb) => { leave(); ack(cb, { ok: true }); });
  socket.on('start', (_, cb) => {
    const r = room(); if (!r) return ack(cb, { error: 'No room' });
    if (r.game) return ack(cb, { error: 'Hand in progress' });
    startHand(r); ack(cb, { ok: true });
  });
  socket.on('act', (action, cb) => { const r = room(); const err = r ? act(r, token, action ?? {}) : 'No room'; ack(cb, typeof err === 'string' ? { error: err } : { ok: true }); });
  socket.on('draw', ({ discards } = {}, cb) => { const r = room(); const err = r ? doDraw(r, token, discards) : 'No room'; ack(cb, typeof err === 'string' ? { error: err } : { ok: true }); });
  socket.on('rebuy', (_, cb) => {
    const r = room(); const s = r && seatOf(r, token);
    if (!s || r.game?.players[token]) return ack(cb, { error: 'Rebuy between hands only' });
    if (s.chips >= ANTE) return ack(cb, { error: 'You still have chips' });
    s.chips = START_CHIPS; account(token).chips = s.chips; saveBalances();
    say(r, `${s.name} rebuys for ${START_CHIPS}.`); broadcast(r); ack(cb, { ok: true });
  });
  socket.on('disconnect', () => {
    const r = room(); if (!r) return;
    const s = seatOf(r, token);
    if (s && s.socketId === socket.id) { s.socketId = null; say(r, `${s.name} disconnected.`); broadcast(r); }
  });
});

// Clean up empty / abandoned rooms.
setInterval(() => {
  for (const [code, r] of rooms) if (r.seats.every((s) => !s.socketId) && Date.now() - r.created > 30 * 60e3 && !r.game) { clearTimer(r); rooms.delete(code); }
}, 60e3);

http.listen(PORT, () => console.log(`FootDraw on http://localhost:${PORT}  (${POOL.length} cards, ${Object.keys(META.traits).length} traits)`));
