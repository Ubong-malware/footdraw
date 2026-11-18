# FootDraw — five-card draw with Wikipedia football articles

A football-themed take on the format of [wikdraw.org](https://wikdraw.org): cards are Wikipedia articles
(players, clubs, national teams, tournaments). Cards score points for **traits they share** (nation, club,
position, World Cup played, award, birthplace, decade…). Rarer traits score more; hand shapes (Pair … Flush) add a bonus.

* **Daily deck** (solo) — the same 15 cards for everyone each day, shuffled per player. Two discard/draw chances.
* **Random deck** (solo) — 15 cards from the whole pool.
* **Play with friends** — online rooms for 2–6 players: a **10-round match** of normal FootDraw rounds with a
  league table; the top of the table after round 10 is champion.

## Look: "Tactics Board"

Minimalist and football-first (mockup in `design/tactics-board-mockup.jpg`): a deep matte pitch-green background with
faint white pitch markings (landscape on wide screens, portrait on phones), white Inter/system type, flat white cards
with a small circular photo, the name and a one-line tag. Your hand sits on the board like a formation (1-2-1-1;
a tidy 3 + 2 grid on phones). During the reveal, thin white lines join the matching cards with a small `+N` label as
each match tallies (drawn from the same scoring/tally data), before the round results and the league table.
The top bar shows `Round X / 10` and the 1:30 clock; the main action is a white pill **Lock in** button.

## Run it

```bash
npm install
npm start               # http://localhost:8080   (PORT env to change)
```

Open the site, choose *Play with friends*, create a room and send the invite link (`/room/CODE`) or the code.

Tests (server must be running):

```bash
# start the server with READY_COUNTDOWN_MS=300 to make the bot tests fast
node scripts/sim.mjs http://localhost:8080 6      # 2–6 bots play a full 10-round match (25-card decks at 5–6): ready-up, kept cards never
                                                  # change, results = final hands, totals = sum of rounds, table order
node scripts/sim-leave.mjs http://localhost:8080  # leavers never block; match ends if one player remains
node scripts/ui-test.mjs http://localhost:8080    # Playwright: solo game + a full 2-browser match (round reveal,
                                                  # stats, trophy room, saved results), writes screenshots/
node scripts/ui-six.mjs http://localhost:8080     # Playwright: 6-seat room on desktop + mobile, lock-in badges, results → table
# every multiplayer test takes MODE=classic|live (default classic), e.g. MODE=live node scripts/ui-test.mjs …
node scripts/sim-restart.mjs                      # own server: SIGINT mid round 2 + SIGKILL mid round 3; the match
                                                  # must resume with identical hands, steps and scores
node scripts/live-test.mjs https://your-app 3 45  # real browsers vs a deployed site: 3 rounds, 45 s idle at results
```

Rebuild the card pool (no keys needed, ~10 minutes):

```bash
npm run build-data      # Wikidata SPARQL + Wikipedia API → player audit → refine → missing images → TheSportsDB crests
node scripts/pool-stats.mjs cards/pool.json 1500 --samples   # pool health: trait sizes, hand rates, type mix, sample decks
```

The pool lives in `cards/pool.json` on the server only (it is not a public file). API responses are cached in
`/tmp/footdraw-build-cache`, so an interrupted build resumes quickly.

## Card pool

**3,627 cards**: 2,945 players, 358 clubs, 101 national teams, 223 tournaments & competitions, with 2,277 shared traits.

* Players: the 900 best-known (by Wikipedia language editions) plus a random sample of the next ~9,000, so the pool
  spans eras (1900s–2000s births), leagues and nations, not just superstars. No country supplies more than ~8% of players.
* Clubs: 140 best-known plus a random sample from the next 900 across many countries.
* Tournaments: every FIFA World Cup and Euro, plus Copa América, Africa Cup of Nations, Asian Cup, Gold Cup,
  Confederations Cup, Champions League/European Cup, Europa League, Copa Libertadores, Club World Cup and Cup Winners'
  Cup editions; the competitions themselves; 45 domestic leagues; 18 national cups.
* Traits link the types: players ↔ clubs (teams), players ↔ leagues (through their clubs), players ↔ tournament
  editions and competitions, clubs/nations ↔ editions they won, leagues ↔ their clubs, plus nation, position, awards,
  birthplace and birth decade.
* Images: Wikipedia thumbnails, then Wikidata images/logos (a competition edition can use its competition's logo),
  then TheSportsDB crests. A few obscure players have no free image and show their initial.

**Decks** are built on the server (`/api/deck` for solo; the match server for rounds) with a crypto RNG (the Daily deck
uses a date seed so everyone gets the same cards). Each deck has a balanced type mix (≈8 players, 3 clubs, 2 national
teams, 2 competitions, nudged at random) and 2–3 hidden themes (traits several cards share) so hands can form pairs
and trips; the rest is random. No card repeats within a match, and each browser's last ~450 dealt cards are kept out
of its next decks and matches. The browser only receives the cards it plays with.

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
  (Wikidata P54 with P1350) into `scripts/player-audit.json`. Players with fewer than 20 are dropped if they are known
  mainly for something else (singer, actor, politician…) or list fewer than 2 teams (this run removed 157, e.g. Sean
  Connery, Niels Bohr, Viktor Orbán, O. J. Simpson).
* Players must have played for at least one club or national team in the pool. Youth and reserve sides don't count.

## Multiplayer: 10-round match

1. 2–6 players per room (room code or `/room/CODE` link). Each round's deck has **15 cards with 2–4 players and 25
   cards with 5–6 players**. Your seat is tied to a random token in your browser, so
   reloads and reconnects put you back in the same seat with the same hand.
2. **Ready-up:** everyone seated presses **Ready** before the match starts and before every round. Nothing starts
   until all of them (minimum 2) are ready. Then a 3 s countdown runs (`READY_COUNTDOWN_MS`), which is cancelled if anyone
   un-readies or a new player joins. New joiners start not ready (and spectate a match already running). Leavers stop blocking.
3. **Each round is one normal FootDraw game.** The server builds a fresh 15-card deck for the round (no card
   repeats within a match). Every player gets that **same deck**, each in their own shuffle. Players play
   simultaneously: tap the cards to swap out, up to two discards, or **Stand**.
4. Kept cards never change: the server only replaces the exact positions you discarded. Each discard request
   carries the hand you were looking at and the discard step, so stale or double-clicked requests are rejected.
5. Standing, using both discards or timing out **locks you in**: your screen says “Locked in, waiting for: …” and every
   seat shows *Locked in ✓* or *Playing…* to everyone. A round ends when everyone is locked in, and then every player's
   reveal starts at the same moment. The round timer is **1:30** (`ROUND_MS`, 90 s, shown as a m:ss clock in the top bar with a thin progress line); anyone still playing is auto-locked in with their current hand.
   First, **your own hand's points tally up** (the same reveal as solo: suits pop in, each shared trait adds its
   points, then the hand bonus, counting up to your score). **Skip to results** jumps straight on. This runs only in
   your browser (no extra network traffic) and plays once per round, not again after a reload or reconnect.
   Then the round result shows every player's exact final 5 cards (cards drawn in the last discard are tagged *New*), their
   trait table and score.
6. **League table** after every round: position, player, this round's score, rounds won, best round, total points,
   sorted by total. The highest score wins the round (ties: whoever finished first).
7. After round 10 (`ROUNDS`) the top of the table is **champion**. If totals are level: most rounds won → best
   single round → fastest total finishing time → seat order. Players who left can't be champion. If only one player
   is left, the match ends early.

### Game modes: Classic and Live Lines

The room creator picks the mode on the *Play with friends* screen; it is stored with the room and with every match in
SQLite (`rooms.mode`, `matches.mode`, migrated in place for older databases, which default to Classic) and survives
restarts. Invite links show the room's mode before joining (`GET /api/room/CODE`) and always join in that mode. The
mode is shown in the room header, on saved results, in the trophy room, and as a column + filter on the multiplayer
stats page (`GET /api/stats?mode=classic|live`).

- **Classic**: what your cards share stays hidden until the end-of-round reveal (match lines only appear there).
- **Live Lines**: while you play, thin lines join your matching cards with small `+N` labels, plus your current hand
  name and running total. They redraw as soon as the new cards arrive after each swap (and on resize). The browser
  scores the hand with the same `scoreHand()` (`public/shared/game.js`) the reveal and the server use, so the live
  total always equals the final score; in this mode the server sends your own hand's traits and their pool counts.
  Cards marked *Swap out* still count until the swap happens (their lines are dimmed). Once you're locked in the lines
  freeze on your final hand with the final total; the reveal then plays as in Classic. Line layers have
  `pointer-events: none`, so they never block taps.

Solo games (Daily / Random) are Classic.

Trait points: `max(0, round((log2(poolSize / traitCount) − 2) × k² × 1.2))` for `k` cards sharing a trait.
Traits held by more than 1/8 of the pool (Forward, Born in the 1980s, 2014 FIFA World Cup…) don't count toward the hand shape.

## Saved matches, stats and trophies (SQLite)

Every state change is written to SQLite (`$DATA_DIR/footdraw.sqlite`, Node's built-in `node:sqlite`, no native
modules) before it is broadcast: rooms, players (browser token + name), matches, each round's deck, every player's
shuffle/hand/discards/score, and league totals. On boot the server rebuilds every room active in the last 24 h, so a
restart, crash or deploy no longer ends a match. Clients show “Reconnecting…”, retry with backoff and rejoin their seat
and current round automatically (anyone mid-round gets at least 45 s back on the clock).

Finished matches stay in the database:

* `/results/CODE/N`: permanent final table with every round's score (linked from the final screen).
* `/stats` (**Multiplayer stats**): matches played, league titles, win %, rounds played and won, average and best round
  (with its hand), highest match total, average finishing position, most-used cards, most-scored traits, hands, and
  recent matches with links to each final table.
* `/trophies` (**Trophy room**): one trophy per league title (date, room, opponents, final points, winning margin)
  plus milestone badges (first title, hat-trick, 5 and 10 titles, perfect match, 200+ round, Flush, Four of a Kind,
  1,500+ match, 10 matches played).

Stats are keyed by your browser token (sent in a header, never shown or put in URLs).

## Deploy so friends can join

It is one Node process (Express + Socket.IO + SQLite): run a **single instance** with a persistent disk at `DATA_DIR`.

* **Render**: push to GitHub → New → Blueprint (uses `render.yaml`) or Web Service with `npm ci` / `node server.js`.
  The free plan sleeps when idle, which ends any match in progress.
* **Fly.io**: `fly launch --copy-config` (uses `Dockerfile` + `fly.toml`, a volume at `/data`, machine always on), then
  `fly deploy`. Note: Fly **trial** accounts stop every machine after 5 minutes. Matches now survive that (the restart
  takes ~10 s and everyone rejoins), but adding a card in the Fly dashboard removes the interruptions.
* **Railway**: New project → Deploy from repo; it detects `npm start`.

WebSockets work out of the box on all three. Share `https://your-app/room/CODE`.

Card texts © Wikipedia contributors, CC BY-SA. Not affiliated with Wikdraw or the Wikimedia Foundation.
