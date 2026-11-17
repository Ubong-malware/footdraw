// SQLite persistence for rooms, players, matches, rounds (deck + every player's hand/draw state) and league totals.
// Uses Node's built-in SQLite (node:sqlite), so there is no native module to compile. The file lives on the Fly
// volume (/data) so it survives machine stops, restarts and deploys.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const J = (v) => JSON.stringify(v ?? null);
const P = (s) => (s == null ? null : JSON.parse(s));

export function openDb(dir) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'footdraw.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY, host TEXT, match_no INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL,
      last_active INTEGER NOT NULL, log TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE IF NOT EXISTS players (               -- a seat: browser token + name
      room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE, token TEXT NOT NULL, name TEXT NOT NULL,
      seat INTEGER NOT NULL, ready INTEGER NOT NULL DEFAULT 0, leaving INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (room_code, token));
    CREATE TABLE IF NOT EXISTS matches (
      room_code TEXT NOT NULL, match_no INTEGER NOT NULL, phase TEXT NOT NULL, round INTEGER NOT NULL,
      participants TEXT NOT NULL, used_cards TEXT NOT NULL, last TEXT, last_tokens TEXT,
      champion TEXT, champion_token TEXT, champion_pts INTEGER, champion_why TEXT, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (room_code, match_no));
    CREATE TABLE IF NOT EXISTS rounds (                 -- the shared deck of each round
      room_code TEXT NOT NULL, match_no INTEGER NOT NULL, round INTEGER NOT NULL, deck TEXT NOT NULL,
      started_at INTEGER NOT NULL, deadline INTEGER NOT NULL, PRIMARY KEY (room_code, match_no, round));
    CREATE TABLE IF NOT EXISTS round_players (          -- each player's shuffle, hand, draws and score in a round
      room_code TEXT NOT NULL, match_no INTEGER NOT NULL, round INTEGER NOT NULL, token TEXT NOT NULL,
      deck_order TEXT NOT NULL, hand TEXT NOT NULL, pos INTEGER NOT NULL, keeps TEXT NOT NULL, stages TEXT NOT NULL,
      done INTEGER NOT NULL, finish_ms INTEGER, result TEXT, last_new TEXT NOT NULL, score INTEGER,
      PRIMARY KEY (room_code, match_no, round, token));
    CREATE TABLE IF NOT EXISTS league (                 -- league totals per player per match
      room_code TEXT NOT NULL, match_no INTEGER NOT NULL, token TEXT NOT NULL, seat INTEGER NOT NULL, name TEXT NOT NULL,
      total INTEGER NOT NULL, rounds TEXT NOT NULL, rounds_won INTEGER NOT NULL, best INTEGER NOT NULL,
      finish_ms INTEGER NOT NULL, left_match INTEGER NOT NULL, PRIMARY KEY (room_code, match_no, token));
  `);
  const q = {
    room: db.prepare(`INSERT INTO rooms (code, host, match_no, created, last_active, log) VALUES (?,?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET host=excluded.host, match_no=excluded.match_no, last_active=excluded.last_active, log=excluded.log`),
    delPlayers: db.prepare('DELETE FROM players WHERE room_code = ?'),
    player: db.prepare('INSERT INTO players (room_code, token, name, seat, ready, leaving) VALUES (?,?,?,?,?,?)'),
    match: db.prepare(`INSERT INTO matches (room_code, match_no, phase, round, participants, used_cards, last, last_tokens, champion, champion_token, champion_pts, champion_why, started_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(room_code, match_no) DO UPDATE SET phase=excluded.phase, round=excluded.round,
      participants=excluded.participants, used_cards=excluded.used_cards, last=excluded.last, last_tokens=excluded.last_tokens,
      champion=excluded.champion, champion_token=excluded.champion_token, champion_pts=excluded.champion_pts, champion_why=excluded.champion_why, updated_at=excluded.updated_at`),
    round: db.prepare(`INSERT INTO rounds (room_code, match_no, round, deck, started_at, deadline) VALUES (?,?,?,?,?,?)
      ON CONFLICT(room_code, match_no, round) DO UPDATE SET deadline=excluded.deadline`),
    rp: db.prepare(`INSERT INTO round_players (room_code, match_no, round, token, deck_order, hand, pos, keeps, stages, done, finish_ms, result, last_new, score)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(room_code, match_no, round, token) DO UPDATE SET hand=excluded.hand, pos=excluded.pos,
      keeps=excluded.keeps, stages=excluded.stages, done=excluded.done, finish_ms=excluded.finish_ms, result=excluded.result, last_new=excluded.last_new, score=excluded.score`),
    league: db.prepare(`INSERT INTO league (room_code, match_no, token, seat, name, total, rounds, rounds_won, best, finish_ms, left_match) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(room_code, match_no, token) DO UPDATE SET name=excluded.name, total=excluded.total, rounds=excluded.rounds,
      rounds_won=excluded.rounds_won, best=excluded.best, finish_ms=excluded.finish_ms, left_match=excluded.left_match`),
    delRoom: db.prepare('DELETE FROM rooms WHERE code = ?'),
  };

  // Write one room's full current state in a single transaction (called on every state change).
  function saveRoom(room) {
    const now = Date.now();
    db.exec('BEGIN');
    try {
      q.room.run(room.code, room.host ?? null, room.matchNo, room.created, now, J(room.log));
      q.delPlayers.run(room.code);
      room.seats.forEach((s, i) => q.player.run(room.code, s.token, s.name, i, s.ready ? 1 : 0, s.leaving ? 1 : 0));
      const m = room.match;
      if (m) {
        const no = room.matchNo;
        q.match.run(room.code, no, m.phase, m.round, J(m.participants), J([...m.usedCards]), J(m.last), J(m.lastTokens),
          m.champion ?? null, m.championToken ?? null, m.championPts ?? null, m.championWhy ?? null, m.startedAt ?? now, now);
        m.participants.forEach((t, seat) => { const r = m.table[t];
          q.league.run(room.code, no, t, seat, r.name, r.total, J(r.rounds), r.roundsWon, r.best, r.finishMs, r.left ? 1 : 0); });
        if (m.cur) {
          q.round.run(room.code, no, m.round, J(m.cur.deck), m.cur.startedAt, m.cur.deadline);
          for (const [t, p] of Object.entries(m.cur.players))
            q.rp.run(room.code, no, m.round, t, J(p.order), J(p.hand), p.pos, J(p.keeps), J(p.stages), p.done ? 1 : 0,
              p.finishMs ?? null, J(p.result), J(p.lastNew), p.result?.points ?? null);
        }
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  // Rebuild every recently active room (with its current match and round) from the database.
  function loadRooms(maxAgeMs) {
    const out = [];
    for (const r of db.prepare('SELECT * FROM rooms WHERE last_active > ?').all(Date.now() - maxAgeMs)) {
      const seats = db.prepare('SELECT * FROM players WHERE room_code = ? ORDER BY seat').all(r.code)
        .map((s) => ({ token: s.token, name: s.name, ready: !!s.ready, leaving: !!s.leaving, socketId: null }));
      const room = { code: r.code, host: r.host, matchNo: r.match_no, created: r.created, lastActive: r.last_active, log: P(r.log), seats, match: null };
      const mm = r.match_no && db.prepare('SELECT * FROM matches WHERE room_code = ? AND match_no = ?').get(r.code, r.match_no);
      if (mm) {
        const m = { phase: mm.phase, round: mm.round, participants: P(mm.participants), usedCards: new Set(P(mm.used_cards)),
          last: P(mm.last), lastTokens: P(mm.last_tokens), startedAt: mm.started_at, table: {}, cur: null };
        if (mm.champion != null) Object.assign(m, { champion: mm.champion, championToken: mm.champion_token, championPts: mm.champion_pts, championWhy: mm.champion_why });
        for (const l of db.prepare('SELECT * FROM league WHERE room_code = ? AND match_no = ?').all(r.code, r.match_no))
          m.table[l.token] = { name: l.name, total: l.total, rounds: P(l.rounds), roundsWon: l.rounds_won, best: l.best, finishMs: l.finish_ms, left: !!l.left_match };
        const rd = db.prepare('SELECT * FROM rounds WHERE room_code = ? AND match_no = ? AND round = ?').get(r.code, r.match_no, mm.round);
        if (rd) {
          m.cur = { deck: P(rd.deck), startedAt: rd.started_at, deadline: rd.deadline, players: {} };
          for (const p of db.prepare('SELECT * FROM round_players WHERE room_code = ? AND match_no = ? AND round = ?').all(r.code, r.match_no, mm.round))
            m.cur.players[p.token] = { order: P(p.deck_order), hand: P(p.hand), pos: p.pos, keeps: P(p.keeps), stages: P(p.stages),
              done: !!p.done, finishMs: p.finish_ms, result: P(p.result), lastNew: P(p.last_new) };
        }
        room.match = m;
      }
      out.push(room);
    }
    return out;
  }

  // Finished (or in-progress) match results, kept after the room itself is cleaned up.
  function matchResults(code, no) {
    const mm = db.prepare('SELECT * FROM matches WHERE room_code = ? AND match_no = ?').get(code, no);
    if (!mm) return null;
    const rows = ordered(db.prepare('SELECT * FROM league WHERE room_code = ? AND match_no = ?').all(code, no))
      .map((l, i) => ({ pos: i + 1, seat: l.seat, name: l.name, total: l.total, rounds: P(l.rounds), roundsWon: l.rounds_won, best: l.best, finishMs: l.finish_ms, left: !!l.left_match }));
    return { code, no, phase: mm.phase, round: mm.round, champion: mm.champion, championPts: mm.champion_pts, championWhy: mm.champion_why,
      startedAt: mm.started_at, updatedAt: mm.updated_at, rows };
  }
  // League rows of one match in final-table order (same tie-breaks as the live table).
  const ordered = (rows) => rows.slice().sort((a, b) => b.total - a.total || b.rounds_won - a.rounds_won || b.best - a.best || a.finish_ms - b.finish_ms || a.seat - b.seat);

  // Multiplayer stats + trophy room for one player (browser token). Only finished matches count.
  function playerStats(token, cardTitle = (id) => id) {
    const mine = db.prepare(`SELECT m.*, l.name AS my_name FROM matches m JOIN league l ON l.room_code = m.room_code AND l.match_no = m.match_no
      WHERE l.token = ? AND m.phase = 'final' ORDER BY m.updated_at DESC`).all(token);
    const history = [], trophies = [];
    let titles = 0, posSum = 0, highestTotal = null, roundsPlayed = 0, roundsWon = 0, perfect = 0;
    for (const m of mine) {
      const rows = ordered(db.prepare('SELECT * FROM league WHERE room_code = ? AND match_no = ?').all(m.room_code, m.match_no));
      const pos = rows.findIndex((r) => r.token === token) + 1, me = rows[pos - 1];
      const won = m.champion_token === token;
      const opponents = rows.filter((r) => r.token !== token).map((r) => r.name);
      const runnerUp = rows.find((r) => r.token !== token);
      posSum += pos; roundsWon += me.rounds_won; roundsPlayed += P(me.rounds).length;
      if (!highestTotal || me.total > highestTotal.total) highestTotal = { total: me.total, code: m.room_code, no: m.match_no, at: m.updated_at };
      const isPerfect = won && m.round >= 10 && me.rounds_won === m.round;
      if (isPerfect) perfect++;
      const h = { code: m.room_code, no: m.match_no, at: m.updated_at, rounds: m.round, players: rows.length, pos, total: me.total, won, champion: m.champion, opponents };
      history.push(h);
      if (won) { titles++; trophies.push({ ...h, margin: runnerUp ? me.total - runnerUp.total : me.total, runnerUp: runnerUp?.name ?? null, perfect: isPerfect, why: m.champion_why }); }
    }
    // Round-level stats from every finished round this player played (final hands and scores).
    const rp = db.prepare(`SELECT rp.*, m.phase FROM round_players rp JOIN matches m ON m.room_code = rp.room_code AND m.match_no = rp.match_no
      WHERE rp.token = ? AND rp.done = 1 AND (m.phase = 'final' OR rp.round < m.round OR m.phase = 'roundEnd')`).all(token);
    let scoreSum = 0, best = null; const cards = new Map(), traits = new Map(), hands = new Map();
    for (const r of rp) {
      const res = P(r.result) ?? { points: 0, hand: 'High Card', matches: [] };
      scoreSum += res.points;
      if (!best || res.points > best.points) best = { points: res.points, hand: res.hand, code: r.room_code, no: r.match_no, round: r.round, cards: P(r.hand).map(cardTitle) };
      for (const id of P(r.hand)) cards.set(id, (cards.get(id) ?? 0) + 1);
      for (const t of res.matches) traits.set(t.label, (traits.get(t.label) ?? 0) + 1);
      hands.set(res.hand, (hands.get(res.hand) ?? 0) + 1);
    }
    const top = (map, n, f = (k) => k) => [...map].sort((a, b) => b[1] - a[1] || String(f(a[0])).localeCompare(String(f(b[0])))).slice(0, n).map(([k, c]) => ({ name: f(k), id: k, count: c }));
    const name = mine[0]?.my_name ?? db.prepare('SELECT name FROM players WHERE token = ? LIMIT 1').get(token)?.name ?? null;
    const played = mine.length;
    // Milestone badges.
    const badge = (id, label, desc, earned) => ({ id, label, desc, earned: !!earned });
    const badges = [
      badge('first', 'First title', 'Win your first league title', titles >= 1),
      badge('hat', 'Hat-trick', 'Win 3 league titles', titles >= 3),
      badge('five', 'Five-time champion', 'Win 5 league titles', titles >= 5),
      badge('ten', 'Dynasty', 'Win 10 league titles', titles >= 10),
      badge('perfect', 'Perfect match', 'Win all 10 rounds of a match', perfect >= 1),
      badge('double', 'Double century', 'Score 200+ pts in a single round', best && best.points >= 200),
      badge('flush', 'Flush', 'Make a Flush in a match', hands.get('Flush')),
      badge('quads', 'Four of a Kind', 'Make Four of a Kind in a match', hands.get('Four of a Kind')),
      badge('big', 'Big season', 'Finish a match with 1,500+ pts', highestTotal && highestTotal.total >= 1500),
      badge('regular', 'Regular', 'Play 10 matches', played >= 10),
    ];
    return {
      name, matchesPlayed: played, titles, winPct: played ? Math.round((titles / played) * 100) : 0,
      roundsPlayed: rp.length, roundsWon, avgRound: rp.length ? Math.round((scoreSum / rp.length) * 10) / 10 : 0,
      bestRound: best, highestTotal, avgPos: played ? Math.round((posSum / played) * 100) / 100 : null, perfect,
      topCards: top(cards, 8, cardTitle), topTraits: top(traits, 8), hands: Object.fromEntries(hands),
      history: history.slice(0, 25), trophies, badges,
    };
  }

  const forgetRoom = (code) => q.delRoom.run(code); // matches/rounds/league rows are kept for history
  return { db, saveRoom, loadRooms, matchResults, playerStats, forgetRoom };
}
