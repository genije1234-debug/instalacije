import http from "http";
import { startScraper } from "./scraper.js";

const PORT = Number(process.env.PORT || 4001);
const TARGET_URL = process.env.TARGET_URL || "https://www.bet365.rs/#/IP/";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);

let latestSnapshot = [];

const HTML = `<!DOCTYPE html>
<html lang="sr">
<head>
<meta charset="UTF-8">
<title>eSoccer skupljac (${PORT})</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f1923; color: #cfd8e3; font-family: 'Segoe UI', sans-serif; font-size: 13px; padding: 12px 24px 12px 12px; }
  h1 { color: #4dd0e1; font-size: 16px; margin-bottom: 4px; }
  #ts { color: #778899; font-size: 11px; margin-bottom: 12px; }
  .match { background: #1a2634; border: 1px solid #2a3038; border-radius: 6px; padding: 8px 10px; margin-bottom: 7px; }
  .match-header { display: flex; align-items: stretch; gap: 6px; }
  .teams-col { flex: 1; min-width: 0; }
  .team { font-weight: 600; font-size: 13px; color: #e0e8f0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.4; }
  .comp { font-size: 11px; color: #778899; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .score-col { width: 42px; flex-shrink: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .score { font-size: 15px; font-weight: 700; color: #ffffff; letter-spacing: 1px; white-space: nowrap; }
  .time { font-size: 11px; color: #4dd0e1; margin-top: 2px; }
  .odds { display: flex; gap: 5px; margin-top: 6px; }
  .odd { background: #0f1419; border: 1px solid #2a3038; border-radius: 4px; padding: 4px 8px; font-size: 13px; }
  .odd span { color: #778899; font-size: 11px; margin-right: 3px; }
  .odd b { color: #4caf50; }
  .susp { color: #e74c3c; font-size: 11px; margin-top: 4px; }
  .empty { color: #778899; padding: 30px; text-align: center; }
</style>
</head>
<body>
<h1>eSoccer skupljac — port ${PORT}</h1>
<div id="ts">Ucitavam...</div>
<div id="root"></div>
<script>
async function upd() {
  const d = await fetch('/state?t='+Date.now(),{cache:'no-store'}).then(r=>r.json()).catch(()=>null);
  if (!d) return;
  document.getElementById('ts').textContent = 'Azurirano: ' + d.ts + ' | Mečeva: ' + d.total;
  const root = document.getElementById('root');
  if (!d.slots || !d.slots.length) {
    root.innerHTML = '<div class="empty">Cekam eSoccer meceve...</div>';
    return;
  }
  root.innerHTML = d.slots.map(s => {
    const odds = s.odds && s.odds.length === 3
      ? '<div class="odds">'
        + '<div class="odd"><span>1</span><b>' + s.odds[0].toFixed(2) + '</b></div>'
        + '<div class="odd"><span>X</span><b>' + s.odds[1].toFixed(2) + '</b></div>'
        + '<div class="odd"><span>2</span><b>' + s.odds[2].toFixed(2) + '</b></div>'
        + '</div>'
      : '';
    const susp = s.suspend ? '<div class="susp">SUSPENDED</div>' : '';
    const t0 = s.teams && s.teams[0] ? s.teams[0] : (s.name || '');
    const t1 = s.teams && s.teams[1] ? s.teams[1] : '';
    return '<div class="match">'
      + '<div class="match-header">'
      +   '<div class="teams-col">'
      +     '<div class="team">' + t0 + '</div>'
      +     '<div class="team">' + t1 + '</div>'
      +     '<div class="comp">' + (s.competition || '') + '</div>'
      +   '</div>'
      +   '<div class="score-col">'
      +     '<div class="score">' + (s.score || '--') + '</div>'
      +     (s.time ? '<div class="time">' + s.time + '</div>' : '')
      +   '</div>'
      + '</div>'
      + odds + susp
      + '</div>';
  }).join('');
}
upd();
setInterval(upd, 1000);
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.url === "/state" || req.url.startsWith("/state?")) {
    const now = Date.now();
    const ACTIVE_MS = 10 * 60 * 1000; // 10 minuta bez updatea = završen meč
    const slots = latestSnapshot
      .filter(s => (s.score || s.time) && (now - (s.lastUpdate || 0)) < ACTIVE_MS)
      .map(s => ({
        id:          s.fixtureId || s.id,
        name:        s.teams ? s.teams.join(" v ") : "",
        teams:       s.teams || [],
        competition: s.competition || "",
        score:       s.score || "--",
        time:        s.time || null,
        odds:        s.odds || [],
        suspend:     s.suspend || false
      }));
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store"
    });
    res.end(JSON.stringify({
      ts:     new Date().toLocaleTimeString("sr"),
      total:  slots.length,
      slots,
      status: slots.length > 0
        ? `${slots.length} eSoccer meceva`
        : "Cekam eSoccer..."
    }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
  res.end(HTML);
});

server.on("error", e => {
  if (e.code === "EADDRINUSE") console.log(`Port ${PORT} zauzet.`);
  else console.error(e.message);
  process.exit(1);
});

startScraper({
  url:          TARGET_URL,
  intervalMs:   POLL_INTERVAL_MS,
  realtimeOnly: true,
  onSnapshot:   (snapshot) => { latestSnapshot = snapshot || []; },
  onChanges:    () => {},
  onLog:        (e) => console.log(`[${new Date().toLocaleTimeString("sr")}] [${e.level}] ${e.message}`),
  onLag:        () => {},
  onRawWs:      null,
  onRawXhr:     null,
  onDomRaw:     null,
  onDomMatches: null,
  onFixtureMap: null,
  onWsTeams:    null,
  onWsUpdates:  null
});

server.listen(PORT, () => {
  console.log(`eSoccer skupljac: http://localhost:${PORT}`);
});
