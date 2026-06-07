/**
 * Admiral Live Football – direktan HTTP scraper, port 3201
 * Samo pravi fudbal (bez eSoccer/GT/virtualnog)
 * Kvote: samo 1x2 (bet type 56)
 * Arhitektura: čist Node.js fetch, bez Puppeteera
 */

import http from "http";
import fs from "fs";
import { exec } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3201;

// ── DISCOVERY logging (privremeno, za analizu finish/suspend) ─────────────────
const DBG_LOG = path.join(__dirname, "admiral-debug-log.txt");
const _seenStatuses = new Set();
const _seenEventFlags = new Set();
function dbgLog(line) {
  try { fs.appendFileSync(DBG_LOG, line + "\n"); } catch {}
}
function logStatus(src, status) {
  const key = `${src}:${status}`;
  if (status == null || _seenStatuses.has(key)) return;
  _seenStatuses.add(key);
  const ts = new Date().toISOString().slice(11, 23);
  dbgLog(`[STATUS ${ts}] src=${src} status="${status}"`);
  console.log(`[STATUS] src=${src} status="${status}"`);
}

const FETCH_HEADERS = {
  "Accept": "application/utf8+json, application/json;q=0.9, text/plain;q=0.8, */*;q=0.7",
  "Accept-Encoding": "identity",
  "Accept-Language": "en-GB,en;q=0.9",
  "Cache-Control": "no-cache",
  "Content-Type": "application/json",
  "Language": "sr-Latn",
  "OfficeId": "138",
  "Origin": "https://admiralbet.rs",
  "Pragma": "no-cache",
  "Referer": "https://admiralbet.rs/",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  "sec-ch-ua": '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
};

const LIVETREE_URL  = "https://srboffer.admiralbet.rs/api/offer/livetree/5/null/true/true/false";
const CACHE_URL     = "https://srboffer.admiralbet.rs/api/offer/CacheChangesMinimalByNumberAsStringAndFilterFromLocalCache";
const RESULTS_URL   = "https://srboffer.admiralbet.rs/api/offer/GetLiveResults";
const BETS_URL      = (s, r, l, m) => `https://srboffer.admiralbet.rs/api/offer/betsAndGroups/${s}/${r}/${l}/${m}`;

// Sledeci gol = bet type 30; outcomes: 103=1, 104=X, 105=2
const BET30 = 30;
const O1 = 103, OX = 104, O2 = 105;

// ── state ────────────────────────────────────────────────────────────────────
const matches = new Map(); // eventId(number) → matchObj
let lastDelta  = null;

// ── helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function norm(s) {
  return String(s ?? "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

function isFootball(sportName) {
  const n = norm(sportName);
  if (!n.includes("fudbal")) return false;
  if (/e[\s/]*fudbal/.test(n)) return false; // isključi eSoccer
  return true;
}

async function apiGet(url) {
  const r = await fetch(url, { headers: FETCH_HEADERS });
  if (!r.ok) throw new Error(`GET ${r.status} ${url.slice(40)}`);
  return r.json();
}

async function apiPost(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: FETCH_HEADERS,
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${r.status}`);
  return r.json();
}

function makeMatch(evId, name, league, sportId, regionId, compId, playable) {
  return {
    id: evId,
    name,
    league,
    sportId,
    regionId,
    compId,
    score: null,
    time: null,
    status: null,
    suspended: !playable,
    odds:        { home: null, draw: null, away: null },
    outcomeSusp: { home: false, draw: false, away: false },
    betSusp:     false,
    _goalTs:  0,
    _prevScore: null,
    _refetchOdds: true, // dovuci kvote čim meč uđe (i posle svakog gola)
    _suspTs:   null,    // tačan trenutak kad market PRVI put pređe u suspend (bilo koji tip)
    _scoreTs:  0,       // tačan trenutak kad se score promijeni
    _prevEffSusp: false,
  };
}

// Efektivni suspend = bilo koji oblik (bet-level, bilo koji outcome, ili event-level)
function effSusp(m) {
  return m.betSusp || m.outcomeSusp.home || m.outcomeSusp.draw || m.outcomeSusp.away || m.suspended;
}
function updateSuspTs(m) {
  const eff = effSusp(m);
  if (eff && !m._prevEffSusp) m._suspTs = Date.now(); // prelaz nije-suspendovan → suspendovan
  m._prevEffSusp = eff;
}

function applyBetOutcomes(m, bets) {
  // Uzmi samo aktivnu instancu BET30 — onu sa isPlayable=true,
  // ili ako nema aktivne, prvu po redu (najskoriju po sbv)
  const bet30list = bets.filter(b => b.betTypeId === BET30);
  const activeBet = bet30list.find(b => b.isPlayable !== false && b.isInOffer !== false)
                 ?? bet30list[bet30list.length - 1];
  if (!activeBet) return;

  const betPlayable = (activeBet.isPlayable !== false) && (activeBet.isInOffer !== false);
  for (const o of (activeBet.betOutcomes ?? [])) {
    const oid = o.betTypeOutcomeId;
    const val = o.odd ?? 0;
    const pl = betPlayable && (o.isPlayable !== false) && (o.isInOffer !== false) && val > 1;
    if (oid === O1) { if (val > 1) m.odds.home = val; m.outcomeSusp.home = !pl; }
    else if (oid === OX) { if (val > 1) m.odds.draw = val; m.outcomeSusp.draw = !pl; }
    else if (oid === O2) { if (val > 1) m.odds.away = val; m.outcomeSusp.away = !pl; }
  }
}

function applyScore(m, newScore) {
  if (!newScore) return;
  if (newScore !== m.score) {
    if (m.score !== null) m._goalTs = Date.now(); // gol detekcija
    m._scoreTs = Date.now(); // tačan trenutak promjene score-a (za GG mjerenje)
    m._prevScore = m.score;
    m.score = newScore;
    // NE dovlačimo kvote posle gola — suspend/nove kvote stižu kroz delta u real-time.
    // (Refetch bi pregazio pre-gol suspend koji je važan signal.)
  }
}

// ── defaultUpdate: livetree + bets + results ─────────────────────────────────
async function defaultUpdate() {
  let tree;
  try { tree = await apiGet(LIVETREE_URL); }
  catch (e) { console.error("[default] livetree error:", e.message); return; }
  if (!Array.isArray(tree)) return;

  const freshIds = new Set();
  const toFetchBets = [];

  for (const sport of tree) {
    if (!isFootball(sport.name ?? "")) continue;
    const sportId = sport.id;
    for (const region of (sport.regions ?? [])) {
      const regionId = region.id ?? region.regionId;
      for (const comp of (region.competitions ?? [])) {
        const compId = comp.id ?? comp.competitionId;
        const compName = comp.competitionName ?? "";
        for (const ev of (comp.events ?? [])) {
          if (!ev.id || !ev.name) continue;
          if (!ev.isLive || !ev.isInOffer) continue;
          freshIds.add(ev.id);
          if (!matches.has(ev.id)) {
            matches.set(ev.id, makeMatch(ev.id, ev.name, compName, sportId, regionId, compId, ev.isPlayable));
            toFetchBets.push({ id: ev.id, sportId, regionId, compId });
          }
        }
      }
    }
  }

  // Ukloni završene mečeve
  for (const id of matches.keys()) {
    if (!freshIds.has(id)) matches.delete(id);
  }

  // Bets u paraleli
  await Promise.all(toFetchBets.map(async ({ id, sportId, regionId, compId }) => {
    try {
      const data = await apiGet(BETS_URL(sportId, regionId, compId, id));
      const m = matches.get(id);
      if (m) applyBetOutcomes(m, data.bets ?? []);
    } catch (e) {
      console.error(`[bets] ev=${id}:`, e.message);
    }
  }));

  // Results
  const ids = [...matches.keys()];
  if (!ids.length) return;
  try {
    const results = await apiPost(RESULTS_URL, ids);
    for (const [strId, res] of Object.entries(results ?? {})) {
      const m = matches.get(Number(strId));
      if (!m) continue;
      applyScore(m, res.score ?? null);
      m.time   = res.matchTime ?? res.extMatchTime ?? null;
      m.status = res.status ?? null;
      logStatus("results", res.status);
    }
  } catch (e) { console.error("[results]:", e.message); }

  console.log(`[default] fudbal mečeva: ${matches.size}`);
}

// ── cacheUpdate: real-time delta ─────────────────────────────────────────────
async function cacheUpdate() {
  const ids = [...matches.keys()];
  const payload = {
    lastDeltaCacheNumber: lastDelta,
    pageId: 5,
    ignoreBetTypesFilterOnEventIds: ids,
    competitionIds: [],
    sportIds: [],
    isLiveFilter: true,
  };
  let data;
  try { data = await apiPost(CACHE_URL, payload); }
  catch (e) { console.error("[cache] error:", e.message); lastDelta = null; return null; }

  // "Too young" = pitali smo prebrzo prije nego se cache pomakao → ZADRŽI poziciju, samo sačekaj
  if (!data || data === "DeltaCacheTooYoung") return false;
  // Nema promjena, ali pomakni poziciju ako server javlja novi max (da ostanemo u koraku)
  if (!data.deltaCacheNumbers?.length || !data.maxDeltaCacheNumberAsString) {
    if (data.maxDeltaCacheNumberAsString) lastDelta = data.maxDeltaCacheNumberAsString;
    return false;
  }
  lastDelta = data.maxDeltaCacheNumberAsString;

  // changedEvents
  for (const ev of (data.changedEvents ?? [])) {
    const evId = ev.iD?.[0];
    if (!evId) continue;
    const isLive   = (ev.b?.[0] ?? 0) * (ev.b?.[1] ?? 0);
    const playable = ev.b?.[2] ?? 0;
    // DISCOVERY: loguj finish kandidate (event koji je bio u mapi pa postao !isLive)
    if (!isLive && matches.has(evId)) {
      const ts = new Date().toISOString().slice(11, 23);
      dbgLog(`[FINISH? ${ts}] ev=${evId} name="${matches.get(evId).name}" b=${JSON.stringify(ev.b)} t=${JSON.stringify(ev.t)}`);
      console.log(`[FINISH?] ev=${evId} b=${JSON.stringify(ev.b)}`);
    }
    if (!isLive) { matches.delete(evId); continue; }
    if (matches.has(evId)) {
      const m = matches.get(evId);
      const name   = ev.t?.[3];
      const league = ev.t?.[2];
      if (name)   m.name   = name;
      if (league) m.league = league;
      m.suspended = !playable;
    }
  }

  // changedResults — score + vreme
  for (const res of (data.changedResults ?? [])) {
    const evId = res.iD?.[0];
    if (!evId || !matches.has(evId)) continue;
    const m = matches.get(evId);
    applyScore(m, res.t?.[4] ?? null);
    if (res.t?.[3]) m.time   = res.t[3];
    if (res.t?.[6]) { m.status = res.t[6]; logStatus("delta", res.t[6]); }
  }

  // changedBets — bet-level suspend/unsuspend
  for (const bet of (data.changedBets ?? [])) {
    const evId = bet.iD?.[4];
    if (!evId || !matches.has(evId)) continue;
    if (bet.n?.[0] !== BET30) continue;
    const playable = (bet.b?.[2] ?? 0) * (bet.b?.[3] ?? 0) * (bet.b?.[4] ?? 0);
    const m = matches.get(evId);
    const prev = m.betSusp;
    m.betSusp = !playable;
    // DISCOVERY: loguj svaki BET30 bet-level delta sa sirovim flagovima
    const ts = new Date().toISOString().slice(11, 23);
    dbgLog(`[BET ${ts}] ev=${evId} "${m.name}" b=${JSON.stringify(bet.b)} n=${JSON.stringify(bet.n)} → playable=${playable} betSusp ${prev}→${m.betSusp}`);
  }

  // changedBetOutcomes — outcome-level suspend/unsuspend (nezavisno od betSusp)
  for (const bet of (data.changedBetOutcomes ?? [])) {
    const evId = bet.iD?.[4];
    if (!evId || !matches.has(evId)) continue;
    if (bet.n?.[0] !== BET30) continue;
    const outcomeId = bet.n?.[1];
    const oddVal    = bet.n?.[2] ?? 0;
    const outcomePl = (bet.b?.[0] ?? 0) * (bet.b?.[1] ?? 0) * (bet.b?.[2] ?? 0) * (oddVal > 1 ? 1 : 0);
    const m = matches.get(evId);
    // NAPOMENA: NE diramo m.betSusp ovdje. Bet-level suspend je autoritativan za cijeli
    // "Sledeći gol" market i stiže preko changedBets (b[4]). Ranije smo ga ovdje brisali
    // čim je outcome imao outcomePl=1 → to je MASKIRALO pravi suspend (kvote pred gol).
    if (outcomeId === O1) { if (oddVal > 1) m.odds.home = oddVal; m.outcomeSusp.home = !outcomePl; }
    else if (outcomeId === OX) { if (oddVal > 1) m.odds.draw = oddVal; m.outcomeSusp.draw = !outcomePl; }
    else if (outcomeId === O2) { if (oddVal > 1) m.odds.away = oddVal; m.outcomeSusp.away = !outcomePl; }
  }

  // Zabilježi tačan trenutak prelaza u suspend (za precizan GK u 3202)
  for (const m of matches.values()) updateSuspTs(m);

  return true;
}

// ── jednokratni seed kvota: kad meč uđe, dovuci početno stanje JEDNOM ──────────
// Sve dalje (promjene kvota + suspend) stiže kroz delta u real-time.
async function seedOddsLoop() {
  while (true) {
    await sleep(800);
    const targets = [...matches.values()].filter(m => m._refetchOdds);
    if (!targets.length) continue;
    const batch = targets.slice(0, 25);
    await Promise.all(batch.map(async (m) => {
      m._refetchOdds = false; // jednokratno — i ako ne uspije, ne anketiramo u krug
      try {
        const data = await apiGet(BETS_URL(m.sportId, m.regionId, m.compId, m.id));
        applyBetOutcomes(m, data.bets ?? []);
      } catch {}
    }));
  }
}

// ── main polling loop ─────────────────────────────────────────────────────────
async function mainLoop() {
  console.log("[loop] starting defaultUpdate...");
  await defaultUpdate();
  await cacheUpdate(); // inicijalni delta
  seedOddsLoop();      // paralelno: jednokratni seed početnih kvota po meču
  let failCount = 0;
  let lastDefaultTs = Date.now();
  while (true) {
    let state;
    try {
      state = await cacheUpdate(); // true=promjene, false=mirno, null=greška
    } catch (e) {
      console.error("[loop] exception:", e.message);
      state = null;
    }

    if (state === null) {
      // Hard greška — broji i posle 3 osvježi livetree
      failCount++;
      if (failCount >= 3) {
        console.log("[loop] 3x fail → defaultUpdate");
        await defaultUpdate();
        failCount = 0;
        lastDefaultTs = Date.now();
      }
      await sleep(300);
    } else if (state === false) {
      // Mirno (nema promjena / too young) — kratka pauza da ne mlatimo API
      failCount = 0;
      await sleep(200);
    } else {
      // Ima promjena — ODMAH dalje, bez pauze (max brzina za gol/suspend)
      failCount = 0;
    }

    // Svaki 30s osvezi livetree da uhvati nove mečeve
    if (Date.now() - lastDefaultTs >= 30_000) {
      await defaultUpdate();
      lastDefaultTs = Date.now();
    }
  }
}

// ── HTTP server + HTML ────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="sr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admiral Fudbal Live</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d1117;color:#e6edf3;font-family:'Segoe UI',Arial,sans-serif;font-size:14px}
  h1{padding:12px 16px;font-size:16px;color:#58a6ff;border-bottom:1px solid #21262d;
     display:flex;align-items:center;gap:10px}
  #count{font-size:12px;color:#8b949e;font-weight:normal}
  table{width:100%;border-collapse:collapse}
  thead th{background:#161b22;color:#8b949e;font-size:11px;text-transform:uppercase;
           letter-spacing:.5px;padding:6px 10px;text-align:left;border-bottom:1px solid #21262d;
           position:sticky;top:0;z-index:1}
  tbody tr{border-bottom:1px solid #161b22;transition:background .2s}
  tbody tr:hover{background:#161b22}
  td{padding:7px 10px;vertical-align:middle}
  .league{color:#8b949e;font-size:12px}
  .name{font-weight:600}
  .score{font-size:18px;font-weight:700;letter-spacing:1px;min-width:60px;text-align:center}
  .time{color:#8b949e;font-size:12px;min-width:40px;text-align:center}
  .odd{text-align:center;min-width:56px;font-weight:600;font-size:15px;
       padding:5px 8px;border-radius:4px;background:#161b22}
  .odd.susp{color:#6e4040;background:#1a0e0e;text-decoration:line-through}
  .odd.ok{color:#e6edf3}
  .odd.up{color:#3fb950}
  .odd.down{color:#f85149}
  .score.goal{color:#ff4040;animation:flashScore .4s ease}
  @keyframes flashScore{0%{transform:scale(1.4)}100%{transform:scale(1)}}
  tr.goal-row{animation:flashRow 3s ease forwards}
  @keyframes flashRow{0%,100%{background:transparent}10%{background:#1f2d1f}90%{background:#1f2d1f}}
  .susp-tag{display:inline-block;font-size:10px;padding:1px 5px;border-radius:3px;
            background:#3d1a1a;color:#f85149;margin-left:4px;vertical-align:middle}
  #updated{position:fixed;bottom:8px;right:12px;font-size:11px;color:#484f58}
</style>
</head>
<body>
<h1>⚽ Admiral – Live Fudbal <span id="count"></span></h1>
<table>
  <thead>
    <tr>
      <th>Liga</th>
      <th>Meč</th>
      <th style="text-align:center">Rezultat</th>
      <th style="text-align:center">Min</th>
      <th style="text-align:center">1</th>
      <th style="text-align:center">X</th>
      <th style="text-align:center">2</th>
    </tr>
  </thead>
  <tbody id="tbody"></tbody>
</table>
<div id="updated"></div>
<script>
const tbody = document.getElementById("tbody");
const countEl = document.getElementById("count");
const updEl = document.getElementById("updated");
const prevOdds = {};
const goalTimers = {};

function fmtOdd(v){ return v && v > 1 ? v.toFixed(2) : "-"; }

function render(data){
  countEl.textContent = "(" + data.length + " mečeva)";
  const existing = new Map([...tbody.querySelectorAll("tr")].map(r=>[r.dataset.id,r]));
  const seen = new Set();

  data.forEach(m => {
    seen.add(String(m.id));
    const prev = prevOdds[m.id] || {};
    const now = { h: m.odds.home, d: m.odds.draw, a: m.odds.away };

    function oddClass(key, val, susp){
      if(susp) return "odd susp";
      const p = prev[key];
      if(p && val && p !== val){
        return val > p ? "odd up" : "odd down";
      }
      return "odd ok";
    }

    prevOdds[m.id] = now;

    const isGoal = m.goalFlash;
    const scoreHtml = isGoal
      ? \`<span class="score goal">\${m.score || "0:0"}</span>\`
      : \`<span class="score">\${m.score || "-"}</span>\`;

    const suspTag = m.suspended ? '<span class="susp-tag">SUSP</span>' : '';

    const html = \`
      <td class="league">\${m.league}</td>
      <td class="name">\${m.name}\${suspTag}</td>
      <td style="text-align:center">\${scoreHtml}</td>
      <td class="time">\${m.time || ""}</td>
      <td class="\${oddClass("h", m.odds.home, m.oddsSupp.home)}">\${m.suspended ? "-" : fmtOdd(m.odds.home)}</td>
      <td class="\${oddClass("d", m.odds.draw, m.oddsSupp.draw)}">\${m.suspended ? "-" : fmtOdd(m.odds.draw)}</td>
      <td class="\${oddClass("a", m.odds.away, m.oddsSupp.away)}">\${m.suspended ? "-" : fmtOdd(m.odds.away)}</td>
    \`;

    let row = existing.get(String(m.id));
    if(!row){
      row = document.createElement("tr");
      row.dataset.id = m.id;
      tbody.appendChild(row);
    }
    row.innerHTML = html;
    if(isGoal){
      row.classList.remove("goal-row");
      void row.offsetWidth;
      row.classList.add("goal-row");
      clearTimeout(goalTimers[m.id]);
      goalTimers[m.id] = setTimeout(()=>row.classList.remove("goal-row"), 3000);
    }
  });

  // Ukloni završene
  for(const [id, row] of existing){
    if(!seen.has(id)) row.remove();
  }

  updEl.textContent = "Ažurirano: " + new Date().toLocaleTimeString("sr");
}

async function poll(){
  try{
    const r = await fetch("/api");
    if(r.ok) render(await r.json());
  }catch(e){}
  setTimeout(poll, 300);
}
poll();
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.url === "/api") {
    const now = Date.now();
    const list = [...matches.values()]
      .sort((a, b) => {
        // Sortiraj po ligi pa imenu
        const l = (a.league ?? "").localeCompare(b.league ?? "");
        return l !== 0 ? l : (a.name ?? "").localeCompare(b.name ?? "");
      })
      .map(m => ({
        id:       m.id,
        name:     m.name,
        league:   m.league,
        score:    m.score,
        time:     m.time,
        status:   m.status,
        suspended: m.suspended,
        odds:     m.odds,
        oddsSupp: {
          home: m.betSusp || m.outcomeSusp.home,
          draw: m.betSusp || m.outcomeSusp.draw,
          away: m.betSusp || m.outcomeSusp.away,
        },
        goalFlash: m._goalTs > 0 && (now - m._goalTs) < 3000,
        suspTs:  m._suspTs,   // tačan trenutak zadnjeg prelaza u suspend (ms epoch)
        scoreTs: m._scoreTs,  // tačan trenutak zadnje promjene score-a (ms epoch)
      }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(list));
  } else {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
  }
});

server.listen(PORT, () => {
  console.log(`Admiral Football live → http://localhost:${PORT}`);
  exec(`start http://localhost:${PORT}`);
  mainLoop().catch(e => console.error("[main]", e));
});
