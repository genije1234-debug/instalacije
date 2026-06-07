/**
 * compare-3202.mjs – uparivač Bwin (3200) + Admiral Football (3201)
 * Port 3202 | Nezavisan fajl, ne dira 3200 ni 3201
 *
 * Prikazuje:
 *  - Uparene mečeve sa score (Bwin + Admiral) i Admiral 1x2 kvotama
 *  - Istorija GK (vreme do suspenda kvota) i GG (vreme dok Admiral ne uhvati score)
 *    → merenje počinje SAMO kad Bwin score skoči više od Admirala
 */

import http from "http";
import { exec } from "child_process";

const PORT      = 3202;
const BWIN_API  = "http://localhost:3200/data";
const ADM_API   = "http://localhost:3201/api";
const POLL_MS   = 150;
const MAX_HIST  = 300;

// ── Telegram ──────────────────────────────────────────────────────────────────
const TG_TOKEN   = "8667978657:AAEwD1EdnzRxtAWcWvJKKJUyLJDdQty490Y";
const TG_CHAT_ID = "-5120503696";
const TG_URL     = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;

async function sendTelegram(text) {
  try {
    await fetch(TG_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "HTML" }),
    });
  } catch (e) {
    console.warn("Telegram greška:", e.message);
  }
}

// ── normalizacija ─────────────────────────────────────────────────────────────
function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .trim();
}

const NOISE = new Set([
  "fc","fk","ac","as","cd","sc","cf","if","ca","ia","bk","sk","nk","ok",
  "the","and","de","la","el","los","las","del","del","von","van",
]);

function tokens(name) {
  return norm(name).split(/\s+/).filter(w => w.length >= 4 && !NOISE.has(w));
}

function tokensOverlap(a, b) {
  return a.some(t => b.includes(t));
}

function splitTeams(matchName) {
  // "Home Team - Away Team"
  const idx = matchName.indexOf(" - ");
  if (idx > 0) return [matchName.slice(0, idx), matchName.slice(idx + 3)];
  return [matchName, ""];
}

function leagueSim(bwinComp, bwinRegion, admLeague) {
  const bTok = tokens(norm(bwinRegion) + " " + norm(bwinComp));
  const aTok = tokens(norm(admLeague));
  return bTok.filter(t => aTok.includes(t)).length;
}

function findBestAdm(bwin, admList) {
  const [bH, bA] = splitTeams(bwin.name);
  const bHTok = tokens(bH), bATok = tokens(bA);

  const candidates = admList.filter(adm => {
    const [aH, aA] = splitTeams(adm.name);
    const aHTok = tokens(aH), aATok = tokens(aA);
    const direct  = tokensOverlap(bHTok, aHTok) && tokensOverlap(bATok, aATok);
    const reverse = tokensOverlap(bHTok, aATok) && tokensOverlap(bATok, aHTok);
    return direct || reverse;
  });

  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];

  // Tiebreaker: liga sličnost
  return candidates.reduce((best, adm) => {
    const s = leagueSim(bwin.competition ?? "", bwin.region ?? "", adm.league ?? "");
    const bs = leagueSim(bwin.competition ?? "", bwin.region ?? "", best.league ?? "");
    return s > bs ? adm : best;
  });
}

// ── score ─────────────────────────────────────────────────────────────────────
function parseScore(s) {
  if (!s) return null;
  const m = String(s).match(/(\d+)\D+(\d+)/);
  if (!m) return null;
  return { home: +m[1], away: +m[2], total: +m[1] + +m[2] };
}

// Admiral suspendovan = BILO KOJI oblik (bet/outcome/event level)
function admSuspended(adm) {
  const s = adm.oddsSupp || {};
  return !!(s.home || s.draw || s.away || adm.suspended);
}

// ── stanje ────────────────────────────────────────────────────────────────────
// pairState: bwinId → { admId, prevBwinScore, prevAdmScore, prevAdmSupp,
//                       bwinGoalTs, bwinGoalScore, gkDone, ggDone, histEntry }
const pairState = new Map();

// Istorija: [{ ts, matchName, goalScore, gk, gg }, ...]  (najnoviji na vrhu)
const history = [];

function addOrUpdateHist(entry) {
  if (!history.includes(entry)) {
    history.unshift(entry);
    if (history.length > MAX_HIST) history.pop();
  }
}

// latestPairs za /api
let latestPairs = [];

// ── polling loop ──────────────────────────────────────────────────────────────
async function doPoll() {
  let bwinData, admData;
  try {
    [bwinData, admData] = await Promise.all([
      fetch(BWIN_API).then(r => r.json()),
      fetch(ADM_API).then(r => r.json()),
    ]);
  } catch { return; }

  const bwinSlots = bwinData?.slots ?? [];
  const admList   = Array.isArray(admData) ? admData : [];

  const activeBwinIds = new Set();
  const pairs = [];

  for (const bwin of bwinSlots) {
    const adm = findBestAdm(bwin, admList);
    if (!adm) continue;

    const key = bwin.id;
    activeBwinIds.add(key);

    const isNew = !pairState.has(key);
    if (isNew) {
      pairState.set(key, {
        admId:         adm.id,
        lastGoalTs:    bwin.goalTs ?? 0, // zadnji obrađeni Bwin gol (izvorni ms)
        bwinGoalTs:    null,             // T0 merenja = IZVORNI trenutak gola (3200 WS)
        bwinGoalScore: null,
        gkDone:        false,
        ggDone:        false,
        histEntry:     null,
      });
    }

    const st = pairState.get(key);
    st.admId = adm.id;

    {
      const bs = parseScore(bwin.score);
      const as = parseScore(adm.score);
      const gTs = bwin.goalTs ?? 0;

      // ── Novi gol na Bwinu (po IZVORNOM WS timestampu iz 3200) ──────────────
      if (gTs > st.lastGoalTs) {
        st.lastGoalTs = gTs;
        const admTotalNow = as ? as.total : 0;
        if (bs && bs.total > admTotalNow) {
          // Bwin je ispred → start merenja sa IZVORNIM vremenom gola
          st.bwinGoalTs    = gTs;
          st.bwinGoalScore = bwin.score;
          st.ggDone        = false;
          // Ako je Admiral već suspendovan (bilo koji oblik) u momentu gola → GK = 0
          const suppAtGoal = admSuspended(adm) && (!adm.suspTs || adm.suspTs < gTs);
          st.gkDone = suppAtGoal;
          st.histEntry = {
            ts:        new Date().toLocaleTimeString("sr"),
            matchName: bwin.name,
            goalScore: bwin.score,
            gk:        suppAtGoal ? "0" : null,
            gg:        null,
          };
          addOrUpdateHist(st.histEntry);
          console.log(`[GOL] ${bwin.name}  Bwin:${bwin.score}  Adm:${adm.score ?? "-"}${suppAtGoal ? "  (GK=0 vec susp)" : ""}`);
        }
      }

      // ── GK: Admiral suspendovao (bilo koji oblik) POSLE gola ──────────────
      // Koristi IZVORNI suspTs iz 3201 → tačno i otporno na poll (suspTs ostaje zapisan)
      if (st.bwinGoalTs && !st.gkDone && adm.suspTs && adm.suspTs >= st.bwinGoalTs) {
        const gk = ((adm.suspTs - st.bwinGoalTs) / 1000).toFixed(2);
        st.gkDone = true;
        if (st.histEntry) st.histEntry.gk = gk;
        console.log(`[GK] ${bwin.name}  ${gk}s`);
      }

      // ── GG: Admiral uhvatio score ─────────────────────────────────────────
      if (st.bwinGoalTs && !st.ggDone && bs && as && as.total >= bs.total) {
        // Izvorni trenutak promjene score-a na Admiralu (ako je posle gola)
        const ggTs = (adm.scoreTs && adm.scoreTs >= st.bwinGoalTs) ? adm.scoreTs : Date.now();
        const gg = ((ggTs - st.bwinGoalTs) / 1000).toFixed(2);
        st.ggDone = true;
        if (st.histEntry) st.histEntry.gg = gg;
        console.log(`[GG] ${bwin.name}  ${gg}s`);
        const gk = st.histEntry?.gk ?? "?";
        const goalScore = st.histEntry?.goalScore ?? bwin.score;
        // Telegram samo kad je GK >= 2s (ispod toga ne šalji)
        const gkNum = parseFloat(gk);
        if (Number.isFinite(gkNum) && gkNum >= 2) {
          sendTelegram(`⚡ <b>${bwin.name}</b>\n${goalScore}\nGK: ${gk}s | GG: ${gg}s`);
        } else {
          console.log(`[TG skip] ${bwin.name}  GK=${gk}s < 2s → ne šaljem`);
        }
      }
    }

    // Bwin je ispred na score-u?
    const bs = parseScore(bwin.score);
    const as = parseScore(adm.score);
    const bwinAhead = bs && as ? bs.total > as.total : false;

    pairs.push({
      bwinId:     bwin.id,
      admId:      adm.id,
      name:       bwin.name,
      bwinLeague: (bwin.region ? bwin.region + " – " : "") + (bwin.competition ?? ""),
      admLeague:  adm.league ?? "",
      bwinScore:  bwin.score ?? "-",
      admScore:   adm.score  ?? "-",
      bwinAhead,
      odds:     adm.odds     ?? {},
      oddsSupp: adm.oddsSupp ?? {},
      suspended: !!adm.suspended,
    });
  }

  // Počisti stare parove
  for (const k of pairState.keys()) {
    if (!activeBwinIds.has(k)) pairState.delete(k);
  }

  pairs.sort((a, b) => a.name.localeCompare(b.name));
  latestPairs = pairs;
}

async function loop() {
  while (true) {
    try { await doPoll(); } catch (e) { console.error("[poll]", e.message); }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

// ── HTML ──────────────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="sr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Compare 3202</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#e6edf3;font-family:'Segoe UI',Arial,sans-serif;font-size:13px;display:flex;flex-direction:column;height:100vh;overflow:hidden}
h2{padding:8px 12px;font-size:14px;color:#58a6ff;border-bottom:1px solid #21262d;flex-shrink:0}
#top{flex:1 1 auto;overflow-y:auto;min-height:0}
#bot{flex:0 0 220px;border-top:2px solid #21262d;overflow-y:auto}
#bot h2{background:#0d1117;position:sticky;top:0;z-index:1}
table{width:100%;border-collapse:collapse}
thead th{background:#161b22;color:#8b949e;font-size:10px;text-transform:uppercase;letter-spacing:.5px;padding:5px 8px;text-align:left;border-bottom:1px solid #21262d;position:sticky;top:0;z-index:1}
tbody tr{border-bottom:1px solid #161b22}
tbody tr:hover{background:#161b22}
td{padding:5px 8px;vertical-align:middle}
.leagues{font-size:10px;color:#484f58}
.name{font-weight:600;font-size:13px}
.score{font-family:monospace;font-size:15px;font-weight:700;text-align:center}
.score.ahead{color:#ff4040}
.score.ok{color:#e6edf3}
.odd{text-align:center;min-width:52px;font-weight:600;font-size:14px;padding:3px 6px;border-radius:3px}
.odd.ok{color:#e6edf3;background:#161b22}
.odd.susp{color:#5a3030;background:#1a0a0a;text-decoration:line-through}
.odd.ev-susp{color:#5a3030;font-style:italic}
.paired{font-size:10px;color:#484f58;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* historija */
#hist-body{padding:4px 0}
.hrow{padding:4px 12px;border-bottom:1px solid #161b22;font-size:12px;color:#c9d1d9;display:flex;gap:12px;align-items:center}
.hrow .ht{color:#484f58;width:70px;flex-shrink:0}
.hrow .hname{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hrow .hscore{color:#8b949e;width:60px;flex-shrink:0;text-align:center}
.gk{color:#f0883e;font-weight:600}
.gg{color:#3fb950;font-weight:600}
.pending{color:#484f58;font-style:italic}
#updated{position:fixed;bottom:4px;right:10px;font-size:10px;color:#484f58}
</style>
</head>
<body>
<div id="top">
  <h2>⚽ Bwin ↔ Admiral – upareni mečevi <span id="cnt" style="font-size:11px;color:#8b949e;font-weight:normal"></span></h2>
  <table>
    <thead>
      <tr>
        <th>Meč</th>
        <th>Score Bwin</th>
        <th>Score Admiral</th>
        <th style="text-align:center">1</th>
        <th style="text-align:center">X</th>
        <th style="text-align:center">2</th>
        <th>Liga (Adm)</th>
      </tr>
    </thead>
    <tbody id="tbody"></tbody>
  </table>
</div>
<div id="bot">
  <h2>📋 Istorija GK / GG</h2>
  <div id="hist-body"></div>
</div>
<div id="updated"></div>
<script>
const tbody = document.getElementById("tbody");
const histBody = document.getElementById("hist-body");
const cntEl = document.getElementById("cnt");
const updEl = document.getElementById("updated");

function fmtOdd(v){ return v && v > 1 ? Number(v).toFixed(2) : "-"; }

function oddCell(val, susp, evSupp){
  if(evSupp || susp) return \`<td class="odd susp">\${fmtOdd(val)}</td>\`;
  return \`<td class="odd ok">\${fmtOdd(val)}</td>\`;
}

function render(data){
  const pairs = data.pairs || [];
  const hist  = data.history || [];
  cntEl.textContent = "(" + pairs.length + " parova)";

  // Tabela
  const existRows = new Map([...tbody.querySelectorAll("tr")].map(r=>[r.dataset.id, r]));
  const seen = new Set();
  pairs.forEach(p => {
    seen.add(p.bwinId);
    const html = \`
      <td>
        <div class="name">\${p.name}</div>
        <div class="paired">\${p.bwinLeague}</div>
      </td>
      <td class="score \${p.bwinAhead ? 'ahead' : 'ok'}">\${p.bwinScore}</td>
      <td class="score ok">\${p.admScore}</td>
      \${oddCell(p.odds.home, p.oddsSupp.home, p.suspended)}
      \${oddCell(p.odds.draw, p.oddsSupp.draw, p.suspended)}
      \${oddCell(p.odds.away, p.oddsSupp.away, p.suspended)}
      <td class="leagues">\${p.admLeague}</td>
    \`;
    let row = existRows.get(p.bwinId);
    if(!row){
      row = document.createElement("tr");
      row.dataset.id = p.bwinId;
      tbody.appendChild(row);
    }
    row.innerHTML = html;
  });
  for(const [id, row] of existRows){
    if(!seen.has(id)) row.remove();
  }

  // Istorija
  histBody.innerHTML = hist.map(h => {
    const gk = h.gk != null ? \`<span class="gk">GK: \${h.gk}s</span>\` : \`<span class="pending">GK: ...</span>\`;
    const gg = h.gg != null ? \`<span class="gg">GG: \${h.gg}s</span>\` : \`<span class="pending">GG: ...</span>\`;
    return \`<div class="hrow">
      <span class="ht">\${h.ts}</span>
      <span class="hname" title="\${h.matchName}">\${h.matchName}</span>
      <span class="hscore">\${h.goalScore}</span>
      \${gk}
      \${gg}
    </div>\`;
  }).join("");

  updEl.textContent = new Date().toLocaleTimeString("sr");
}

async function poll(){
  try{
    const r = await fetch("/api");
    if(r.ok) render(await r.json());
  } catch(e){}
  setTimeout(poll, 300);
}
poll();
</script>
</body>
</html>`;

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === "/api") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ pairs: latestPairs, history }));
  } else {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
  }
});

server.listen(PORT, () => {
  console.log(`Compare 3202 → http://localhost:${PORT}`);
  exec(`start http://localhost:${PORT}`);
  loop();
});
