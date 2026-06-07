/**
 * eSoccer 1X2 – Superbet.rs
 * Port: 3007
 *
 * Skuplja sve eSoccer live mečeve sa Superbeta (sportId=75)
 * Prikazuje samo konačan ishod (1X2) sa nazivom i formatom takmičenja.
 * Nema Chrome, nema Puppeteer — čisti REST API polling (1s).
 */

import http from "http";

const PORT          = 3007;
const POLL_MS       = 1000;
const SPORT_ID      = 75;
const MARKET_ID_1X2 = 100001;
const LANG          = "sr-Latn-RS";

const API   = `https://production-superbet-offer-rs.freetls.fastly.net/sb-rs/api/v2/${LANG}`;
const HEADERS = { "Accept": "application/json", "User-Agent": "Mozilla/5.0" };

// ── Tournament mapa (id → { name, format }) ───────────────────────────────────

const tournamentMap = new Map(); // id → { name, format }

async function loadTournaments() {
  try {
    const r = await fetch(`${API}/struct`, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    const tours = j.data?.tournaments ?? [];
    for (const t of tours) {
      const name   = t.localNames?.[LANG] ?? t.localNames?.["en"] ?? "";
      const footer = t.footer ?? "";
      // Izvuci format npr. "2x6 minuta" ili "2x4 minuta"
      const fmtM   = footer.match(/(\d+x\d+\s*min\w*)/i);
      tournamentMap.set(String(t.id), {
        name:   name,
        format: fmtM ? fmtM[1].replace(/\s+/g, "") : "",
      });
    }
    log(`Turniri učitani: ${tournamentMap.size}`);
  } catch (e) {
    log(`Greška pri učitavanju turnira: ${e.message}`);
  }
}

// ── State ─────────────────────────────────────────────────────────────────────

let state = {
  ts: "--",
  total: 0,
  slots: [],
  status: "Pokretanje...",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString("sr")}] ${msg}`);
}

function parseName(raw) {
  if (!raw) return { home: "?", away: "?" };
  // Separator je · (U+00B7 middle dot)
  const parts = raw.split("·");
  if (parts.length >= 2) {
    return { home: parts[0].trim(), away: parts.slice(1).join("·").trim() };
  }
  return { home: raw.trim(), away: "?" };
}

function buildScore(meta) {
  if (!meta) return "--";
  const h = meta.homeTeamScore, a = meta.awayTeamScore;
  if (h == null && a == null) return "--";
  return `${h} : ${a}`;
}

function buildMinute(meta) {
  if (!meta) return null;
  const min = meta.minutes;
  if (min == null) return null;
  const extra = meta.stoppageTime || meta.remainingTime;
  return extra ? `${min}+` : String(min);
}

// ── Fetch i parsiranje ────────────────────────────────────────────────────────

async function fetchEvents() {
  const startDate = new Date(Date.now() - 7 * 24 * 3600 * 1000)
    .toISOString().replace("T", " ").slice(0, 19);

  const url = `${API}/events/by-date?currentStatus=active&offerState=live`
    + `&startDate=${encodeURIComponent(startDate)}&sportId=${SPORT_ID}`;

  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json.data ?? [];
}

async function refresh() {
  try {
    const events = await fetchEvents();
    const slots  = [];

    for (const ev of events) {
      if (!ev.odds || ev.odds.length === 0) continue;

      const odds1x2 = ev.odds.filter(
        o => o.marketId === MARKET_ID_1X2 && o.status === "active"
      );
      if (odds1x2.length === 0) continue;

      const o1 = odds1x2.find(o => o.name === "1");
      const oX = odds1x2.find(o => o.name === "X");
      const o2 = odds1x2.find(o => o.name === "2");
      if (!o1 && !oX && !o2) continue;

      const { home, away } = parseName(ev.matchName);
      const meta   = ev.metadata ?? {};
      const tour   = tournamentMap.get(String(ev.tournamentId)) ?? { name: "", format: "" };

      slots.push({
        id:          ev.eventId,
        name:        `${home} v ${away}`,
        home, away,
        competition: tour.name,
        format:      tour.format,
        tournamentId: ev.tournamentId,
        score:       buildScore(meta),
        minute:      buildMinute(meta),
        period:      meta.matchStatusLabel ?? "",
        odds: {
          "1": o1 ? +o1.price.toFixed(2) : null,
          "X": oX ? +oX.price.toFixed(2) : null,
          "2": o2 ? +o2.price.toFixed(2) : null,
        },
      });
    }

    // Sortiraj: po minutu opadajuće (najkasniji minut prvi)
    slots.sort((a, b) => (parseInt(b.minute) || 0) - (parseInt(a.minute) || 0));

    state = {
      ts:     new Date().toLocaleTimeString("sr"),
      total:  slots.length,
      slots,
      status: slots.length > 0
        ? `${slots.length} meceva uzivo - ${new Date().toLocaleTimeString("sr")}`
        : "Nema live eSoccer meceva...",
    };
  } catch (e) {
    log(`Greška: ${e.message}`);
    state.status = "Greška: " + e.message;
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

(async () => {
  log("eSoccer 1X2 — start");
  await loadTournaments();
  await refresh();
  log(`UI: http://localhost:${PORT}`);
  async function loop() {
    await new Promise(r => setTimeout(r, POLL_MS));
    await refresh();
    loop();
  }
  loop();
})();

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.url === "/state" || req.url.startsWith("/state?")) {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(state));
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

server.listen(PORT, "127.0.0.1", () => {
  log(`Slušam na http://localhost:${PORT}`);
});

// ── HTML UI ───────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="sr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>eSoccer 1X2 – Live</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#e6edf3;font-family:'Segoe UI',sans-serif;padding:14px}
h1{color:#e86c1e;font-size:1rem;margin-bottom:6px;letter-spacing:1px}
#st{font-size:0.72rem;color:#666;margin-bottom:12px;padding:5px 9px;background:#161b22;border-radius:4px}
.m{background:#161b22;border:1px solid #21262d;border-radius:7px;padding:11px;margin-bottom:8px}
.mh{display:flex;justify-content:space-between;align-items:center;margin-bottom:5px}
.mn{font-weight:600;font-size:0.9rem;color:#e6edf3}
.mi{display:flex;align-items:center;gap:6px}
.sc{font-size:0.95rem;font-weight:700;color:#e86c1e;background:#0d1117;padding:2px 7px;border-radius:4px}
.min{font-size:0.72rem;color:#8b949e}
.per{font-size:0.65rem;color:#555;background:#21262d;padding:1px 5px;border-radius:3px}
.comp{font-size:0.65rem;color:#6a737d;margin-bottom:6px;display:flex;gap:8px;align-items:center}
.fmt{background:#21262d;padding:1px 6px;border-radius:3px;color:#8b949e}
.odds{display:flex;gap:8px;flex-wrap:wrap}
.odd{background:#0d1117;border:1px solid #21262d;border-radius:5px;padding:6px 14px;text-align:center;min-width:64px}
.odd-label{font-size:0.65rem;color:#8b949e;margin-bottom:2px}
.odd-val{font-size:0.92rem;font-weight:700;color:#e86c1e}
.odd-val.na{color:#333;font-size:0.75rem}
.empty{color:#555;font-size:0.85rem;padding:40px;text-align:center}
</style>
</head>
<body>
<h1>eSoccer 1X2 – LIVE</h1>
<div id="st">Učitavanje...</div>
<div id="root"></div>
<script>
async function upd(){
  try{
    const d=await fetch('/state?t='+Date.now(),{cache:'no-store'}).then(r=>r.json());
    document.getElementById('st').textContent='Ažurirano: '+d.ts+' | '+d.status;
    const root=document.getElementById('root');
    if(!d.slots||!d.slots.length){
      root.innerHTML='<div class="empty">Nema live eSoccer mečeva...</div>';return;
    }
    root.innerHTML=d.slots.map(s=>{
      const min=s.minute?'<span class="min">'+s.minute+"'</span>":'';
      const per=s.period?'<span class="per">'+s.period+'</span>':'';
      const comp=s.competition?'<div class="comp"><span>'+s.competition+'</span>'+(s.format?'<span class="fmt">'+s.format+'</span>':'')+'</div>':'';
      const odds=['1','X','2'].map(k=>{
        const v=s.odds[k];
        return '<div class="odd"><div class="odd-label">'+k+'</div>'+
          '<div class="odd-val'+(v?'':' na')+'">'+
          (v?v.toFixed(2):'-')+'</div></div>';
      }).join('');
      return '<div class="m">'+
        '<div class="mh"><span class="mn">'+s.name+'</span>'+
        '<div class="mi">'+min+per+'<span class="sc">'+s.score+'</span></div></div>'+
        comp+
        '<div class="odds">'+odds+'</div>'+
      '</div>';
    }).join('');
  }catch(e){document.getElementById('st').textContent='Greška: '+e.message}
}
upd();setInterval(upd,1000);
</script>
</body>
</html>`;
