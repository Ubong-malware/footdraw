// Fills missing club / national-team images with crests from TheSportsDB (free public test key "123").
import { readFileSync, writeFileSync } from 'node:fs';
const KEY = process.env.SPORTSDB_KEY ?? '123';
const file = 'public/data/pool.json';
const d = JSON.parse(readFileSync(file, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const name = (c) => c.title.replace(/ national (?:association )?football team$/, '').replace(/ \(.*\)$/, '').replace(/^(?:FC|AFC|AC|AS|SS|SSC|RC|SL|CA|CR|SC) /, '').replace(/ (?:F\.C\.|FC|CF|A\.F\.C\.|C\.F\.|S\.C\.|SC)$/, '');
let n = 0;
for (const c of d.cards.filter((c) => (c.kind === 'club' || c.kind === 'nation') && !c.thumbnail)) {
  try {
    let r;
    for (let i = 0; i < 4; i++) { // free tier rate-limits with 429: back off and retry
      r = await fetch(`https://www.thesportsdb.com/api/v1/json/${KEY}/searchteams.php?t=${encodeURIComponent(name(c))}`);
      if (r.status !== 429) break;
      await sleep(15000 * (i + 1));
    }
    const j = r.ok ? await r.json() : {};
    const soccer = (j.teams ?? []).filter((t) => t.strSport === 'Soccer' && (c.kind === 'nation' ? t.strGender !== 'Female' : true));
    const team = soccer.find((t) => t.strTeam.toLowerCase() === name(c).toLowerCase()) ?? (c.kind === 'club' ? soccer[0] : null);
    if (team?.strBadge) { c.thumbnail = team.strBadge; c.badge = true; n++; }
    console.log(c.title, '→', team?.strTeam ?? '-', team?.strBadge ? 'badge' : '');
  } catch (e) { console.warn(c.title, e.message); }
  await sleep(3000); // free tier: ~30 requests/minute
}
writeFileSync(file, JSON.stringify(d));
console.log(`Added ${n} crests from TheSportsDB`);
