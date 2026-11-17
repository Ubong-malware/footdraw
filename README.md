# FootDraw — five-card draw (and poker) with Wikipedia football articles

A football-themed take on the format of [wikdraw.org](https://wikdraw.org): cards are Wikipedia articles
(players, clubs, national teams, tournaments). Cards score points for **traits they share** (nation, club,
position, World Cup played, award, birthplace, decade…). Rarer traits score more; poker-style hand shapes add a bonus.

* **Daily deck** (solo) — the same 15 cards for everyone each day, shuffled per player. Two discard/draw chances.
* **Random deck** (solo) — 15 cards from the whole pool.
* **Play with friends** — online rooms for 2–4 players, real poker with chips: ante, three betting rounds,
  two simultaneous draws, showdown, side pots, rebuys.

## Run it

```bash
npm install
npm start               # http://localhost:8080   (PORT env to change)
```

Open the site, choose *Play with friends*, create a room and send the invite link (`/room/CODE`) or the code.

Tests (server must be running):

```bash
node scripts/sim.mjs http://localhost:8080 4 6   # 4 socket.io bots: joins, 5th rejected, reconnect, chip conservation
node scripts/ui-test.mjs http://localhost:8080   # Playwright: solo game + 2-browser room, writes screenshots/
```

Rebuild the card pool (no keys needed, ~10 minutes):

```bash
npm run build-data      # Wikidata SPARQL + Wikipedia API → refine → TheSportsDB crests
```

## Data sources (all keyless)

| Source | Used for |
|---|---|
| Wikidata SPARQL (`query.wikidata.org`) | Which articles become cards, and their traits (P1532/P27 nation, P54 teams, P413 position, P166 awards, P1344 tournaments, P19 birthplace, P569 birth decade; clubs: P17, P118 league, P159 city, P115 stadium, P571 founded) |
| Wikipedia Action API | Titles, short descriptions, thumbnails, intro extracts (CC BY-SA) |
| TheSportsDB v1 (public test key `123`) | Club/national-team crests at build time; live “current team / position / stadium” in the card info popup at run time, proxied + cached by the server (`/api/sportsdb/...`). Set `SPORTSDB_KEY` for a premium key. |

## Multiplayer rules

1. 2–4 players per room. Everyone starts with **1,000 chips**. The balance is tied to a random token stored in the
   browser (localStorage) and saved server-side in `data/balances.json`, so it survives reloads, rooms and restarts.
2. Each hand everyone **antes 10**. The server builds a fresh deck (16 + 10 × players cards, themed so cards share
   traits), shuffles it with `crypto.randomInt`, and deals 5 private cards each. Other players' cards are never sent to you.
3. **Betting round 1** → **Draw 1** → **Betting round 2** → **Draw 2** → **Betting round 3** → **Showdown**.
   Betting starts left of the dealer button (which rotates each hand). No-limit: check, bet, call, raise
   (minimum raise = previous raise, at least 20), fold, all-in.
4. Draws are simultaneous: discard 0–5 cards and draw replacements from the shared deck, or stand pat.
5. **Showdown:** each remaining hand is scored exactly like solo FootDraw: sum of trait points + hand bonus
   (Flush +150, Four of a Kind +100, Full House +75, Three +30, Two Pair +25, Pair +5). Highest score wins; equal
   scores tie-break on hand shape, then split. Side pots are built from all-in contribution levels.
   If everyone else folds, the last player wins without showing.
6. 45 s per decision: timing out checks (or folds when facing a bet) and stands pat in a draw.
7. Disconnects keep your seat; reopen the link (same browser) to resume. Leaving mid-hand folds you.
   A player below the ante can **Rebuy 1,000** between hands. The next hand auto-deals 15 s after a showdown
   (or press *Deal next hand*).

Trait points: `max(0, round((log2(poolSize / traitCount) − 2) × k² × 1.2))` for `k` cards sharing a trait.
Traits held by more than 1/8 of the pool (Forward, Born in the 1980s, 2014 FIFA World Cup…) don't count toward the hand shape.

## Deploy so friends can join

It is one Node process (Express + Socket.IO, in-memory rooms) — run a **single instance**.

* **Render**: push to GitHub → New → Blueprint (uses `render.yaml`) or Web Service with `npm ci` / `node server.js`.
  Free plan sleeps when idle and loses `data/` on redeploy; add a disk + `DATA_DIR` to keep balances.
* **Fly.io**: `fly launch --copy-config` (uses `Dockerfile` + `fly.toml`), `fly volumes create footdraw_data --size 1`, `fly deploy`.
* **Railway**: New project → Deploy from repo; it detects `npm start`. Add a volume at `/data` and `DATA_DIR=/data`.

WebSockets work out of the box on all three. Share `https://your-app/room/CODE`.

Card texts © Wikipedia contributors, CC BY-SA. Not affiliated with Wikdraw or the Wikimedia Foundation.
