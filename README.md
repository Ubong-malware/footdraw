# FootDraw — five-card draw with Wikipedia football articles

A football-themed take on the format of [wikdraw.org](https://wikdraw.org): cards are Wikipedia articles
(players, clubs, national teams, tournaments). Cards score points for **traits they share** (nation, club,
position, World Cup played, award, birthplace, decade…). Rarer traits score more; hand shapes (Pair … Flush) add a bonus.

* **Daily deck** (solo) — the same 15 cards for everyone each day, shuffled per player. Two discard/draw chances.
* **Random deck** (solo) — 15 cards from the whole pool.
* **Play with friends** — online rooms for 2–4 players: a **10-round match** of normal FootDraw rounds with a
  league table; the top of the table after round 10 is champion.

## Run it

```bash
npm install
npm start               # http://localhost:8080   (PORT env to change)
```

Open the site, choose *Play with friends*, create a room and send the invite link (`/room/CODE`) or the code.

Tests (server must be running):

```bash
# start the server with READY_COUNTDOWN_MS=300 to make the bot tests fast
node scripts/sim.mjs http://localhost:8080 4      # 2–4 bots play a full 10-round match: ready-up, kept cards never
                                                  # change, results = final hands, totals = sum of rounds, table order
node scripts/sim-leave.mjs http://localhost:8080  # leavers never block; match ends if one player remains
node scripts/ui-test.mjs http://localhost:8080    # Playwright: solo game + a full 2-browser match, writes screenshots/
```

Rebuild the card pool (no keys needed, ~10 minutes):

```bash
npm run build-data      # Wikidata SPARQL + Wikipedia API → player audit → refine → TheSportsDB crests
```

## Data sources (all keyless)

| Source | Used for |
|---|---|
| Wikidata SPARQL (`query.wikidata.org`) | Which articles become cards, and their traits (P1532/P27 nation, P54 teams, P413 position, P166 awards, P1344 tournaments, P19 birthplace, P569 birth decade; clubs: P17, P118 league, P159 city, P115 stadium, P571 founded) |
| Wikipedia Action API | Titles, short descriptions, thumbnails, intro extracts (CC BY-SA) |
| TheSportsDB v1 (public test key `123`) | Club/national-team crests at build time; live “current team / position / stadium” in the card info popup at run time, proxied + cached by the server (`/api/sportsdb/...`). Set `SPORTSDB_KEY` for a premium key. |

## Card pool cleanup

`scripts/refine.mjs` removes people whose fame is outside football:

* `scripts/denylist.txt`: manual removals (titles or QIDs, one per line), e.g. Julio Iglesias, Jason Statham, Jo Nesbø.
* Senior career check: `scripts/audit-players.mjs` sums each player's recorded senior club appearances + caps
  (Wikidata P54 with P1350) into `scripts/player-audit.json`. Players with fewer than 20 are dropped.
* Players must have played for at least one club or national team in the pool. Youth and reserve sides don't count.

## Multiplayer: 10-round match

1. 2–4 players per room (room code or `/room/CODE` link). Your seat is tied to a random token in your browser, so
   reloads and reconnects put you back in the same seat with the same hand.
2. **Ready-up:** everyone seated presses **Ready** before the match starts and before every round. Nothing starts
   until all of them (minimum 2) are ready. Then a 3 s countdown runs (`READY_COUNTDOWN_MS`), which is cancelled if anyone
   un-readies or a new player joins. New joiners start not ready (and spectate a match already running). Leavers stop blocking.
3. **Each round is one normal FootDraw game.** The server builds a fresh 15-card deck for the round (no card
   repeats within a match). Every player gets that **same deck**, each in their own shuffle. Players play
   simultaneously: tap the cards to swap out, up to two discards, or **Stand**.
4. Kept cards never change: the server only replaces the exact positions you discarded. Each discard request
   carries the hand you were looking at and the discard step, so stale or double-clicked requests are rejected.
5. A round ends when everyone has finished. The round timer is 2 minutes (`ROUND_MS`), and anyone still playing auto-stands.
   The round result shows every player's exact final 5 cards (cards drawn in the last discard are tagged *New*), their
   trait table and score.
6. **League table** after every round: position, player, this round's score, rounds won, best round, total points,
   sorted by total. The highest score wins the round (ties: whoever finished first).
7. After round 10 (`ROUNDS`) the top of the table is **champion**. If totals are level: most rounds won → best
   single round → fastest total finishing time → seat order. Players who left can't be champion. If only one player
   is left, the match ends early.

Trait points: `max(0, round((log2(poolSize / traitCount) − 2) × k² × 1.2))` for `k` cards sharing a trait.
Traits held by more than 1/8 of the pool (Forward, Born in the 1980s, 2014 FIFA World Cup…) don't count toward the hand shape.

## Deploy so friends can join

It is one Node process (Express + Socket.IO, in-memory rooms) — run a **single instance**.

* **Render**: push to GitHub → New → Blueprint (uses `render.yaml`) or Web Service with `npm ci` / `node server.js`.
  The free plan sleeps when idle, which ends any match in progress.
* **Fly.io**: `fly launch --copy-config` (uses `Dockerfile` + `fly.toml`), then `fly deploy`.
* **Railway**: New project → Deploy from repo; it detects `npm start`.

WebSockets work out of the box on all three. Share `https://your-app/room/CODE`.

Card texts © Wikipedia contributors, CC BY-SA. Not affiliated with Wikdraw or the Wikimedia Foundation.
