// FootDraw server: serves the static site and runs multiplayer 10-round FootDraw matches over Socket.IO.
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { readFileSync } from 'node:fs';
import { openDb } from './db.js';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { scoreHand, makeDeck, shuffle, BONUS } from './public/shared/game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT ?? 8080);
const MAX_PLAYERS = 4;
const ROUNDS = +(process.env.ROUNDS ?? 10);
const DECK_SIZE = 15;
const ROUND_MS = +(process.env.ROUND_MS ?? 120000);           // per-round timer; unfinished players auto-stand
// Once every required player is ready, a short countdown runs (cancelled if anyone un-readies or joins).
const READY_COUNTDOWN_MS = +(process.env.READY_COUNTDOWN_MS ?? 3000);

const poolData = JSON.parse(readFileSync(path.join(__dirname, 'public/data/pool.json'), 'utf8'));
const POOL = poolData.cards;
const META = { traits: poolData.traits, size: POOL.length };
const CARD = new Map(POOL.map((c) => [c.id, c]));
const crand = () => randomInt(2 ** 32) / 2 ** 32;

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
// Saved results and per-player stats (from SQLite). Your browser token identifies you; it is sent in a header,
// never in a URL, and never returned.
const okToken = (t) => /^[a-f0-9]{16,64}$/.test(t ?? '');
app.get('/api/match/:code/:no', (req, res) => {
  const r = store.matchResults(String(req.params.code).toUpperCase().slice(0, 5), +req.params.no || 0);
  r ? res.json(r) : res.status(404).json({ error: 'Match not found' });
});
app.get('/api/stats', (req, res) => {
  const t = req.get('x-fd-token');
  if (!okToken(t)) return res.status(400).json({ error: 'missing token' });
  res.json(store.playerStats(t, (id) => CARD.get(id)?.title ?? id));
});
for (const route of ['/results/:code/:no', '/stats', '/trophies']) app.get(route, (_, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.get('/room/:code', (_, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

const http = createServer(app);
// Short heartbeats so a dead connection is noticed in ~15s instead of ~45s (Socket.IO defaults 25s + 20s).
const io = new Server(http, { cors: { origin: true }, pingInterval: 8000, pingTimeout: 7000, transports: ['websocket', 'polling'] });

// ---------- Rooms ----------
const rooms = new Map();
const newCode = () => { let c; do { c = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(32)]).join(''); } while (rooms.has(c)); return c; };
const publicCard = (id) => { const c = CARD.get(id); return { id, title: c.title, description: c.description, thumbnail: c.thumbnail, extract: c.extract, kind: c.kind }; };

function createRoom(hostToken) {
  const room = { code: newCode(), host: hostToken, seats: [], match: null, matchNo: 0, log: [], timer: null, roundTimer: null, nextAt: null, created: Date.now() };
  rooms.set(room.code, room);
  return room;
}
const seatOf = (room, token) => room.seats.find((s) => s.token === token);
const say = (room, msg) => { room.log.push({ t: Date.now(), msg }); if (room.log.length > 60) room.log.shift(); };
const clearTimer = (room) => { clearTimeout(room.timer); room.timer = null; };

// ---------- Match model ----------
// match = { phase: 'playing' | 'roundEnd' | 'final', round, participants: [token], usedCards: Set,
//           table: { token: { name, total, rounds: [score], roundsWon, best, finishMs, left } },
//           cur: { deck, startedAt, deadline, players: { token: { order, hand, pos, keeps, stages, done, finishMs, result } } },
//           last: <results of the last finished round> }
const playingNow = (m) => m.participants.filter((t) => !m.table[t].left);

// Table order: total points ↓, rounds won ↓, best single round ↓, total finishing time ↑ (earliest), then seat.
function standings(m) {
  return m.participants.map((t, seat) => ({ t, seat, ...m.table[t] }))
    .sort((a, b) => b.total - a.total || b.roundsWon - a.roundsWon || b.best - a.best || a.finishMs - b.finishMs || a.seat - b.seat)
    .map((r, i) => ({ pos: i + 1, name: r.name, total: r.total, roundScore: r.rounds.at(-1) ?? 0, rounds: r.rounds, roundsWon: r.roundsWon, best: r.best, finishMs: r.finishMs, left: !!r.left }));
}
// Same order as standings(), as tokens (server-side only; tokens are never sent to clients).
const rankedTokens = (m) => m.participants.map((t, seat) => ({ t, seat, ...m.table[t] }))
  .sort((a, b) => b.total - a.total || b.roundsWon - a.roundsWon || b.best - a.best || a.finishMs - b.finishMs || a.seat - b.seat).map((r) => r.t);
// Why the leader is ahead of the runner-up when totals are level.
function tieReason(m) {
  const [a, b] = standings(m);
  if (!a || !b || a.total !== b.total) return null;
  if (a.roundsWon !== b.roundsWon) return `level on points, decided by rounds won (${a.roundsWon} vs ${b.roundsWon})`;
  if (a.best !== b.best) return `level on points, decided by best single round (${a.best} vs ${b.best} pts)`;
  if (a.finishMs !== b.finishMs) return `level on points, decided by faster total finishing time (${(a.finishMs / 1000).toFixed(1)}s vs ${(b.finishMs / 1000).toFixed(1)}s)`;
  return 'level on points, decided by seat order';
}

// ---------- Ready-up ----------
// Who must be ready: everyone seated (min 2) before a match; only match participants still present between rounds.
function required(room) {
  const m = room.match;
  if (m && m.phase === 'roundEnd') return room.seats.filter((s) => !s.leaving && m.participants.includes(s.token));
  return room.seats.filter((s) => !s.leaving);
}
function readyInfo(room) {
  const need = required(room);
  const ready = need.filter((s) => s.ready);
  const m = room.match;
  return {
    ready: ready.length, total: need.length, min: 2,
    waitingFor: need.filter((s) => !s.ready).map((s) => s.name),
    allReady: need.length >= 2 && ready.length === need.length,
    next: m?.phase === 'roundEnd' ? `Round ${m.round + 1} of ${ROUNDS}` : m?.phase === 'final' ? 'New match' : 'Start match',
  };
}
function checkReady(room) {
  if (room.match?.phase === 'playing') return;
  const info = readyInfo(room);
  if (info.allReady) {
    if (!room.nextAt) {
      room.nextAt = Date.now() + READY_COUNTDOWN_MS;
      clearTimer(room);
      room.timer = setTimeout(() => {
        room.timer = null; room.nextAt = null;
        if (!readyInfo(room).allReady) return broadcast(room);
        if (room.match?.phase === 'roundEnd') startRound(room); else startMatch(room);
      }, READY_COUNTDOWN_MS);
      say(room, `Everyone is ready. ${info.next} in ${Math.round(READY_COUNTDOWN_MS / 1000)}s…`);
    }
  } else if (room.nextAt) {
    clearTimer(room); room.nextAt = null;
    say(room, 'Countdown cancelled: waiting for everyone to be ready.');
  }
}

function startMatch(room) {
  const players = room.seats.filter((s) => !s.leaving);
  room.matchNo++;
  room.match = {
    phase: 'roundEnd', round: 0, startedAt: Date.now(), participants: players.map((s) => s.token), usedCards: new Set(), last: null, cur: null,
    table: Object.fromEntries(players.map((s) => [s.token, { name: s.name, total: 0, rounds: [], roundsWon: 0, best: 0, finishMs: 0, left: false }])),
  };
  say(room, `Match ${room.matchNo} begins: ${players.map((s) => s.name).join(', ')} · ${ROUNDS} rounds.`);
  startRound(room);
}

function startRound(room) {
  const m = room.match;
  clearTimer(room); room.nextAt = null;
  m.round++;
  m.phase = 'playing';
  // A fresh 15-card deck every round (no card repeats within a match). Everyone gets the same deck, each in
  // their own independent shuffle (like the Daily deck).
  const fresh = POOL.filter((c) => !m.usedCards.has(c.id));
  const deck = makeDeck(fresh.length >= 60 ? fresh : POOL, META, DECK_SIZE, crand).map((c) => c.id);
  deck.forEach((id) => m.usedCards.add(id));
  const now = Date.now();
  m.cur = { deck, startedAt: now, deadline: now + ROUND_MS, players: {} };
  for (const t of playingNow(m)) {
    const order = shuffle(deck, crand);
    m.cur.players[t] = { order, hand: order.slice(0, 5), pos: 5, keeps: [], stages: [order.slice(0, 5)], done: false, finishMs: null, result: null, lastNew: [] };
  }
  for (const s of room.seats) s.ready = false;
  armRoundTimer(room);
  say(room, `Round ${m.round} of ${ROUNDS}: dealt.`);
  broadcast(room);
}

// Discard: replaces EXACTLY the given positions with the next cards of this player's own deck order. Positions
// not listed are never touched. `expect` (the hand the client was looking at) and `step` guard against stale or
// double-submitted requests, so a repeated click can never swap out cards the player kept.
function discard(room, token, { indices, expect, step } = {}) {
  const m = room.match; const p = m?.phase === 'playing' && m.cur.players[token];
  if (!p) return 'Not playing this round';
  if (p.done) return 'You already finished this round';
  if (p.keeps.length >= 2) return 'No discards left';
  if (step !== undefined && step !== p.keeps.length) return 'Stale request';
  if (expect && expect.join() !== p.hand.join()) return 'Your hand changed; refresh';
  const idx = [...new Set((indices ?? []).map(Number))].filter((i) => Number.isInteger(i) && i >= 0 && i < 5);
  if (!idx.length) return 'Select cards to discard';
  for (const i of idx) p.hand[i] = p.order[p.pos++];
  p.keeps.push([0, 1, 2, 3, 4].filter((i) => !idx.includes(i)));
  p.lastNew = idx;
  p.stages.push(p.hand.slice());
  if (p.keeps.length === 2) return finishPlayer(room, token);
  broadcast(room);
}

function finishPlayer(room, token, why) {
  const m = room.match; const p = m.cur.players[token];
  if (!p || p.done) return;
  p.done = true;
  p.finishMs = Math.min(Date.now() - m.cur.startedAt, ROUND_MS);
  p.result = scoreHand(p.hand.map((id) => CARD.get(id)), META);
  if (why) say(room, `${m.table[token].name} ${why}: auto-stand.`);
  const waiting = Object.keys(m.cur.players).filter((t) => !m.cur.players[t].done && !m.table[t].left);
  if (waiting.length === 0) return endRound(room);
  broadcast(room);
}

function endRound(room) {
  const m = room.match; clearTimeout(room.roundTimer);
  const entries = Object.entries(m.cur.players);
  for (const [t, p] of entries) {
    if (!p.done) { p.done = true; p.finishMs = ROUND_MS; p.result = scoreHand(p.hand.map((id) => CARD.get(id)), META); }
    const row = m.table[t];
    row.rounds.push(p.result.points); row.total += p.result.points; row.best = Math.max(row.best, p.result.points); row.finishMs += p.finishMs;
  }
  // Participants who weren't dealt in (left before the round) score 0 for it.
  for (const t of m.participants) if (!m.cur.players[t]) m.table[t].rounds.push(0);
  // One round winner: highest score, then earliest finisher, then seat.
  const [win] = entries.sort(([a, x], [b, y]) => y.result.points - x.result.points || x.finishMs - y.finishMs || m.participants.indexOf(a) - m.participants.indexOf(b));
  if (win) m.table[win[0]].roundsWon++;
  m.last = {
    round: m.round, deckSize: m.cur.deck.length, winner: win ? m.table[win[0]].name : null,
    results: m.participants.filter((t) => m.cur.players[t]).map((t) => {
      const p = m.cur.players[t];
      return { t, name: m.table[t].name, points: p.result.points, hand: p.result.hand, matches: p.result.matches,
        cards: p.hand.map(publicCard), newIdx: p.lastNew, discards: p.keeps.map((k) => 5 - k.length), finishMs: p.finishMs };
    }).sort((a, b) => b.points - a.points || a.finishMs - b.finishMs),
  };
  // Keep player tokens server-side only: remember the order, then strip them from what's broadcast.
  m.lastTokens = m.last.results.map((r) => r.t);
  for (const r of m.last.results) delete r.t;
  say(room, `Round ${m.round}: ${m.last.winner} wins the round with ${m.last.results[0]?.points ?? 0} pts.`);
  for (const s of room.seats) s.ready = false;
  if (m.round >= ROUNDS || playingNow(m).length < 2) {
    m.phase = 'final';
    const table = standings(m);
    const champ = table.find((r) => !r.left) ?? table[0]; // players who left forfeit the title
    m.championToken = rankedTokens(m).find((t) => !m.table[t].left) ?? rankedTokens(m)[0];
    m.champion = champ?.name; m.championPts = champ?.total; m.championWhy = champ === table[0] ? (tieReason(m) ?? (m.round < ROUNDS ? 'everyone else left' : null)) : 'players above left the match';
    say(room, `🏆 ${m.champion} is the champion with ${m.championPts} pts${m.championWhy ? ` (${m.championWhy})` : ''}! Ready up for a new match.`);
  } else {
    m.phase = 'roundEnd';
    say(room, `Ready up for round ${m.round + 1}.`);
  }
  broadcast(room);
}

function armRoundTimer(room) {
  const m = room.match;
  clearTimeout(room.roundTimer);
  room.roundTimer = setTimeout(() => {
    if (room.match !== m || m.phase !== 'playing') return;
    for (const t of Object.keys(m.cur.players)) if (!m.cur.players[t].done) finishPlayer(room, t, 'timed out');
  }, Math.max(0, m.cur.deadline - Date.now()));
}

// ---------- Views ----------
function broadcast(room) {
  room.lastActive = Date.now();
  save(room); // every state change is written to SQLite before anyone sees it
  for (const s of room.seats) if (s.socketId) io.to(s.socketId).emit('state', viewFor(room, s.token));
}
function viewFor(room, token) {
  const m = room.match;
  const cur = m?.phase === 'playing' ? m.cur : null;
  const mine = cur?.players[token];
  return {
    code: room.code, host: room.host === token, rounds: ROUNDS, roundMs: ROUND_MS, nextAt: room.nextAt,
    readyCheck: m?.phase === 'playing' ? null : readyInfo(room),
    seats: room.seats.map((s) => {
      const p = cur?.players[s.token]; const row = m?.table[s.token];
      return {
        name: s.name, isYou: s.token === token, isHost: s.token === room.host, connected: !!s.socketId,
        readyUp: !!s.ready, inMatch: !!row, total: row?.total ?? null,
        status: cur ? (p ? (p.done ? 'Finished' : `Playing · ${2 - p.keeps.length} discards left`) : 'Spectating') : null,
      };
    }),
    match: m && {
      no: room.matchNo, phase: m.phase, round: m.round, champion: m.champion ?? null, championPts: m.championPts ?? null, championWhy: m.championWhy ?? null,
      deadline: cur?.deadline ?? null, table: standings(m), last: m.last, lastYou: m.lastTokens ? m.lastTokens.indexOf(token) : -1, youPlay: m.participants.includes(token),
      waitingFor: cur ? Object.keys(cur.players).filter((t) => !cur.players[t].done && !m.table[t].left).map((t) => m.table[t].name) : [],
      you: mine && { hand: mine.hand.map(publicCard), step: mine.keeps.length, discardsLeft: 2 - mine.keeps.length, deckLeft: DECK_SIZE - mine.pos, done: mine.done, result: mine.done ? mine.result : null, lastNew: mine.lastNew },
    },
    log: room.log.slice(-25),
  };
}

// ---------- Sockets ----------
io.on('connection', (socket) => {
  const token = String(socket.handshake.auth?.token ?? '').slice(0, 64);
  if (!/^[a-f0-9]{16,64}$/.test(token)) { socket.emit('fatal', 'Bad session token'); return socket.disconnect(); }
  let roomCode = null;
  const room = () => rooms.get(roomCode);
  const ack = (cb, v) => typeof cb === 'function' && cb(v);
  const reply = (cb, err) => ack(cb, typeof err === 'string' ? { error: err } : { ok: true });
  const cleanName = (n) => String(n ?? '').slice(0, 20).trim() || undefined;

  function join(code, name, cb) {
    const r = rooms.get(String(code ?? '').toUpperCase());
    if (!r) return ack(cb, { error: 'Room not found' });
    let s = seatOf(r, token);
    if (!s) {
      if (r.seats.length >= MAX_PLAYERS) return ack(cb, { error: 'Room is full (4 players max)' });
      s = { token, name: name ?? 'Player', socketId: null, ready: false };
      r.seats.push(s);
      say(r, `${s.name} joined${r.match && r.match.phase !== 'final' && !r.match.participants.includes(token) ? ' (spectating until the next match)' : ''}.`);
    } else {
      if (name) s.name = name;
      s.leaving = false;
      if (!s.socketId) say(r, `${s.name} reconnected.`);
    }
    if (r.match?.table[token]?.left) r.match.table[token].left = false; // a participant who comes back rejoins the match
    if (roomCode && roomCode !== r.code) leave();
    s.socketId = socket.id; roomCode = r.code; socket.join(r.code);
    checkReady(r); // a newcomer (not ready) cancels any pending countdown
    ack(cb, { ok: true, code: r.code });
    broadcast(r);
  }
  function leave() {
    const r = room(); if (!r) return;
    const s = seatOf(r, token); roomCode = null; socket.leave(r.code);
    if (!s) return;
    say(r, `${s.name} left.`);
    r.seats = r.seats.filter((x) => x !== s);
    const m = r.match;
    if (m?.table[token]) {
      m.table[token].left = true;
      // A leaver no longer holds up the round.
      if (m.phase === 'playing' && m.cur.players[token] && !m.cur.players[token].done) finishPlayer(r, token, 'left');
      else if (m.phase === 'playing' && Object.keys(m.cur.players).every((t) => m.cur.players[t].done || m.table[t].left)) endRound(r);
      // Fewer than 2 players left mid-round: finish the round now (it ends the match).
      if (m.phase === 'playing' && playingNow(m).length < 2) for (const t of Object.keys(m.cur.players)) if (!m.cur.players[t].done) finishPlayer(r, t, 'is the last player');
    }
    if (!r.seats.some((x) => x.token === r.host) && r.seats[0]) r.host = r.seats[0].token;
    if (r.seats.length === 0) { clearTimer(r); clearTimeout(r.roundTimer); rooms.delete(r.code); forget(r.code); return; }
    if (m && m.phase !== 'playing' && m.phase !== 'final' && playingNow(m).length < 2) {
      m.phase = 'final'; const t = standings(m); const c = t.find((x) => !x.left) ?? t[0]; m.champion = c?.name; m.championPts = c?.total; m.championWhy = 'everyone else left';
      m.championToken = rankedTokens(m).find((x) => !m.table[x].left) ?? rankedTokens(m)[0];
      say(r, `Match ended early: ${m.champion} wins.`);
    }
    checkReady(r);
    broadcast(r);
  }

  socket.on('create', ({ name } = {}, cb) => { const r = createRoom(token); join(r.code, cleanName(name), cb); });
  socket.on('join', ({ code, name } = {}, cb) => join(code, cleanName(name), cb));
  socket.on('leave', (_, cb) => { leave(); ack(cb, { ok: true }); });
  socket.on('ready', ({ ready } = {}, cb) => {
    const r = room(); const s = r && seatOf(r, token);
    if (!s) return ack(cb, { error: 'No room' });
    if (r.match?.phase === 'playing') return ack(cb, { error: 'Round in progress' });
    const want = ready === undefined ? !s.ready : !!ready;
    if (s.ready !== want) { s.ready = want; say(r, `${s.name} is ${want ? 'ready' : 'not ready'}.`); }
    checkReady(r); broadcast(r); ack(cb, { ok: true, ready: s.ready });
  });
  socket.on('discard', (data, cb) => { const r = room(); reply(cb, r ? discard(r, token, data ?? {}) : 'No room'); });
  socket.on('stand', (_, cb) => {
    const r = room(); const p = r?.match?.phase === 'playing' && r.match.cur.players[token];
    if (!p || p.done) return reply(cb, 'Not playing');
    finishPlayer(r, token); reply(cb);
  });
  socket.on('disconnect', () => {
    const r = room(); if (!r) return;
    const s = seatOf(r, token);
    if (s && s.socketId === socket.id) { s.socketId = null; say(r, `${s.name} disconnected.`); broadcast(r); }
  });
});

// Clean up abandoned rooms.
setInterval(() => {
  for (const [code, r] of rooms) if (r.seats.every((s) => !s.socketId) && Date.now() - Math.max(r.created, r.restoredAt ?? 0, r.lastActive ?? 0) > 30 * 60e3) { clearTimer(r); clearTimeout(r.roundTimer); rooms.delete(code); forget(code); }
}, 60e3);

// ---------- Persistence (SQLite) ----------
// The host can stop/restart the machine at any time (Fly trial machines are stopped every 5 minutes; deploys do the
// same). Rooms used to live only in memory, so every restart wiped all matches and kicked everyone out. Now every
// state change is written to SQLite on the Fly volume (/data) — rooms, players, matches, each round's deck and every
// player's hand/draw state, and league totals — and all active matches are rebuilt on boot. Clients reconnect and
// rejoin their seat and current round automatically. Finished matches stay in the DB for stats and the trophy room.
const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, 'data');
const store = openDb(DATA_DIR);
function save(room) { try { store.saveRoom(room); } catch (e) { console.error('save failed', room.code, e.message); } }
function forget(code) { try { store.forgetRoom(code); } catch (e) { console.error('forget failed', e.message); } }
function restore() {
  try {
    const now = Date.now();
    for (const room of store.loadRooms(24 * 3600e3)) {
      Object.assign(room, { timer: null, roundTimer: null, nextAt: null, restoredAt: now });
      rooms.set(room.code, room);
      const m = room.match;
      if (m?.phase === 'playing' && m.cur) {
        say(room, 'Server restarted: your match was restored. Reconnecting players…');
        // Give everyone back the time lost while the server was down (at least 45s left).
        m.cur.deadline = Math.max(m.cur.deadline, now + 45000);
        armRoundTimer(room);
      } else if (m && m.phase !== 'final') say(room, 'Server restarted: your match was restored.');
      checkReady(room);
    }
    console.log(`Restored ${rooms.size} room(s) from SQLite in ${DATA_DIR}`);
  } catch (e) { console.error('restore failed', e); }
}
let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  if (shuttingDown) return; shuttingDown = true;
  for (const r of rooms.values()) save(r);
  // Tell clients right away so they show "reconnecting" instead of hanging until the heartbeat times out.
  io.emit('server-restart');
  setTimeout(() => { try { store.db.close(); } catch {} process.exit(0); }, 300);
});
process.on('uncaughtException', (e) => { console.error('uncaught', e); for (const r of rooms.values()) save(r); });
restore();

http.listen(PORT, () => console.log(`FootDraw on http://localhost:${PORT}  (${POOL.length} cards, ${Object.keys(META.traits).length} traits)`));
